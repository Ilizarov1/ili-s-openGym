from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from sentence_transformers import CrossEncoder, SentenceTransformer

EMBED_MODEL = os.getenv("RETRIEVAL_EMBEDDING_MODEL", "BAAI/bge-m3")
RERANK_MODEL = os.getenv("RETRIEVAL_RERANK_MODEL", "BAAI/bge-reranker-v2-m3")
EMBED_REVISION = os.getenv("RETRIEVAL_EMBEDDING_REVISION", "5617a9f61b028005a4858fdac845db406aefb181")
RERANK_REVISION = os.getenv("RETRIEVAL_RERANK_REVISION", "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e")
DEVICE = "cpu"
if torch.cuda.is_available():
    try:
        torch.empty(1, device="cuda").add_(1)
        torch.cuda.synchronize()
        DEVICE = "cuda"
    except Exception:
        DEVICE = "cpu"
DEVICE_KIND = "rocm" if DEVICE == "cuda" and torch.version.hip else DEVICE
MAX_BATCH = max(1, min(32, int(os.getenv("RETRIEVAL_BATCH_SIZE", "32"))))
LOAD_EMBEDDING = os.getenv("RETRIEVAL_LOAD_EMBEDDING", "1") == "1"
LOAD_RERANK = os.getenv("RETRIEVAL_LOAD_RERANK", "1") == "1"
_DTYPE_MAP: dict[str, torch.dtype] = {
    "fp16": torch.float16,
    "bf16": torch.bfloat16,
    "fp32": torch.float32,
}


def _parse_dtype_name(env_key: str, default: str) -> str:
    raw = os.getenv(env_key, default).strip().lower()
    if raw not in _DTYPE_MAP:
        raise ValueError(f"Invalid {env_key}={raw!r}; expected fp16, bf16, or fp32")
    return raw if DEVICE == "cuda" else "fp32"


EMBEDDING_DTYPE_NAME = _parse_dtype_name("RETRIEVAL_EMBEDDING_DTYPE", "fp32")
RERANK_DTYPE_NAME = _parse_dtype_name("RETRIEVAL_RERANK_DTYPE", "fp16")
RERANK_MAX_LENGTH = max(64, min(512, int(os.getenv("RETRIEVAL_RERANK_MAX_LENGTH", "256"))))
slots = asyncio.Semaphore(1)
state: dict[str, Any] = {
    "embedding": None,
    "reranker": None,
    "embedding_error": None,
    "reranker_error": None,
    "embedding_device": None,
    "reranker_device": None,
    "embedding_dtype": EMBEDDING_DTYPE_NAME,
    "rerank_dtype": RERANK_DTYPE_NAME,
    "embedding_warmup_ok": False,
    "rerank_warmup_ok": False,
    "rerank_fp32_fallbacks": 0,
}


def _effective_dtype(device_type: str, configured_dtype_name: str) -> torch.dtype | None:
    if device_type != "cuda" or configured_dtype_name == "fp32":
        return None
    return _DTYPE_MAP[configured_dtype_name]


def _encode_embeddings(model: Any, inputs: list[str], amp_dtype: torch.dtype | None) -> list[list[float]]:
    output: list[list[float]] = []
    device_type = getattr(getattr(model, "device", None), "type", "cpu")
    for start in range(0, len(inputs), MAX_BATCH):
        chunk = inputs[start:start + MAX_BATCH]
        try:
            if amp_dtype is not None and device_type == "cuda":
                with torch.autocast(device_type="cuda", dtype=amp_dtype):
                    vectors = model.encode(chunk, batch_size=MAX_BATCH, normalize_embeddings=True, convert_to_numpy=True)
            else:
                vectors = model.encode(chunk, batch_size=MAX_BATCH, normalize_embeddings=True, convert_to_numpy=True)
            output.extend([_finite(vector) for vector in vectors])
        except (ValueError, FloatingPointError):
            if amp_dtype is None or device_type != "cuda":
                raise
            vectors = model.encode(chunk, batch_size=MAX_BATCH, normalize_embeddings=True, convert_to_numpy=True)
            output.extend([_finite(vector) for vector in vectors])
    if any(len(vector) != 1024 for vector in output):
        raise ValueError("Embedding model did not return 1024 dimensions")
    return output


def _score_rerank_batch(
    model: Any,
    batch: list[tuple[str, str]],
    amp_dtype: torch.dtype | None,
    max_length: int,
) -> list[float]:
    tokenizer = model.tokenizer
    device = model.model.device
    encoded = tokenizer(
        [pair[0] for pair in batch],
        [pair[1] for pair in batch],
        padding=True,
        truncation=True,
        max_length=max_length,
        pad_to_multiple_of=8,
        return_tensors="pt",
    )
    encoded = {key: value.to(device) for key, value in encoded.items()}

    def run_forward(use_amp: bool) -> list[float]:
        if use_amp and amp_dtype is not None and device.type == "cuda":
            with torch.autocast(device_type="cuda", dtype=amp_dtype):
                logits = model.model(**encoded, return_dict=True).logits
        else:
            logits = model.model(**encoded, return_dict=True).logits
        if not torch.isfinite(logits).all():
            raise FloatingPointError("Model returned non-finite logits")
        scores = model.activation_fn(logits.float()).detach().float().cpu().numpy().reshape(-1)
        return _finite(scores)

    if amp_dtype is not None and device.type == "cuda":
        try:
            return run_forward(True)
        except (ValueError, FloatingPointError):
            state["rerank_fp32_fallbacks"] += 1
            return run_forward(False)
    return run_forward(False)


def _score_rerank_pairs(
    model: Any,
    pairs: list[tuple[str, str]],
    amp_dtype: torch.dtype | None,
    max_length: int,
) -> list[float]:
    if not pairs:
        return []
    result: list[float] = []
    with torch.inference_mode():
        for start in range(0, len(pairs), MAX_BATCH):
            result.extend(_score_rerank_batch(model, pairs[start:start + MAX_BATCH], amp_dtype, max_length))
    return result


def _warmup_models() -> None:
    if state["embedding"] is not None:
        try:
            emb_device = getattr(getattr(state["embedding"], "device", None), "type", "cpu")
            _encode_embeddings(state["embedding"], ["warmup exercise"], _effective_dtype(emb_device, state["embedding_dtype"]))
            state["embedding_warmup_ok"] = True
        except Exception:
            state["embedding_warmup_ok"] = False
    if state["reranker"] is not None:
        try:
            rerank_device = state["reranker"].model.device.type
            warmup_pairs = [
                ("English: barbell bench press. Chinese: 杠铃卧推", "English: barbell bench press. Chinese: 杠铃卧推. Attributes: chest, barbell"),
                ("English: barbell squat. Chinese: 杠铃深蹲", "English: barbell squat. Chinese: 杠铃深蹲. Attributes: upper legs, barbell"),
            ]
            _score_rerank_pairs(state["reranker"], warmup_pairs, _effective_dtype(rerank_device, state["rerank_dtype"]), RERANK_MAX_LENGTH)
            state["rerank_warmup_ok"] = True
        except Exception:
            state["rerank_warmup_ok"] = False


def _load_models() -> None:
    if LOAD_EMBEDDING:
        try:
            state["embedding"] = SentenceTransformer(EMBED_MODEL, revision=EMBED_REVISION, device=DEVICE, trust_remote_code=False)
            state["embedding_device"] = DEVICE_KIND
            state["embedding_dtype"] = EMBEDDING_DTYPE_NAME
        except Exception as exc:
            state["embedding_error"] = f"{type(exc).__name__}: {exc}"
            if DEVICE != "cpu":
                state["embedding"] = SentenceTransformer(EMBED_MODEL, revision=EMBED_REVISION, device="cpu", trust_remote_code=False)
                state["embedding_device"] = "cpu"
                state["embedding_dtype"] = "fp32"
                state["embedding_error"] = None
    if LOAD_RERANK:
        try:
            state["reranker"] = CrossEncoder(RERANK_MODEL, revision=RERANK_REVISION, device=DEVICE, max_length=RERANK_MAX_LENGTH, trust_remote_code=False)
            state["reranker_device"] = DEVICE_KIND
            state["rerank_dtype"] = RERANK_DTYPE_NAME
        except Exception as exc:
            state["reranker_error"] = f"{type(exc).__name__}: {exc}"
            if DEVICE != "cpu":
                state["reranker"] = CrossEncoder(RERANK_MODEL, revision=RERANK_REVISION, device="cpu", max_length=RERANK_MAX_LENGTH, trust_remote_code=False)
                state["reranker_device"] = "cpu"
                state["rerank_dtype"] = "fp32"
                state["reranker_error"] = None
    _warmup_models()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await asyncio.to_thread(_load_models)
    yield


app = FastAPI(title="openGym retrieval models", version="0.1.0", lifespan=lifespan)


class EmbeddingRequest(BaseModel):
    model: str | None = None
    input: str | list[str]
    dimensions: int | None = None


class RerankRequest(BaseModel):
    model: str | None = None
    query: str
    documents: list[str]
    top_n: int | None = None
    return_documents: bool = False


def _finite(values: Any) -> list[float]:
    result = np.asarray(values, dtype=np.float32).reshape(-1)
    if not np.isfinite(result).all():
        raise ValueError("Model returned a non-finite score")
    return result.tolist()


@app.get("/health")
async def health():
    enabled = []
    if LOAD_EMBEDDING:
        enabled.append(state["embedding"] is not None)
    if LOAD_RERANK:
        enabled.append(state["reranker"] is not None)
    devices = []
    if LOAD_EMBEDDING and state["embedding"] is not None:
        devices.append(state["embedding_device"])
    if LOAD_RERANK and state["reranker"] is not None:
        devices.append(state["reranker_device"])
    actual_devices = set(devices)
    device = next(iter(actual_devices)) if len(actual_devices) == 1 else "mixed" if actual_devices else DEVICE_KIND
    return {
        "status": "ready" if enabled and all(enabled) else "unavailable",
        "device": device,
        "models": {
            "embedding": {
                "name": EMBED_MODEL if LOAD_EMBEDDING and state["embedding"] is not None else None,
                "enabled": LOAD_EMBEDDING,
                "ready": LOAD_EMBEDDING and state["embedding"] is not None,
                "device": state["embedding_device"],
                "dtype": state["embedding_dtype"],
                "warmup_ok": state["embedding_warmup_ok"],
            },
            "rerank": {
                "name": RERANK_MODEL if LOAD_RERANK and state["reranker"] is not None else None,
                "enabled": LOAD_RERANK,
                "ready": LOAD_RERANK and state["reranker"] is not None,
                "device": state["reranker_device"],
                "dtype": state["rerank_dtype"],
                "max_length": RERANK_MAX_LENGTH,
                "warmup_ok": state["rerank_warmup_ok"],
                "fp32_fallbacks": state["rerank_fp32_fallbacks"],
            },
        },
    }


async def _wait_for_disconnect(request: Request) -> None:
    while True:
        message = await request.receive()
        if message.get("type") == "http.disconnect":
            return


async def _run_inference(fn, *args, request: Request):
    """Keep the compute slot until inference actually ends, even on disconnect."""
    disconnect_task = asyncio.create_task(_wait_for_disconnect(request))
    acquire_task = asyncio.create_task(slots.acquire())
    inference_task: asyncio.Task | None = None
    try:
        await asyncio.wait((disconnect_task, acquire_task), return_when=asyncio.FIRST_COMPLETED)
        if disconnect_task.done():
            raise HTTPException(499, "client disconnected")
        acquire_task.result()

        inference_task = asyncio.create_task(asyncio.to_thread(fn, *args))
        await asyncio.wait((disconnect_task, inference_task), return_when=asyncio.FIRST_COMPLETED)
        if not inference_task.done():
            raise HTTPException(499, "client disconnected")
        return inference_task.result()
    finally:
        disconnect_task.cancel()
        acquire_task.cancel()
        await asyncio.gather(disconnect_task, acquire_task, return_exceptions=True)
        if not acquire_task.cancelled() and acquire_task.exception() is None:
            if inference_task is not None and not inference_task.done():
                inference_task.add_done_callback(_finish_disconnected_inference)
            else:
                slots.release()


def _finish_disconnected_inference(task: asyncio.Task) -> None:
    slots.release()
    if not task.cancelled():
        task.exception()


@app.post("/v1/embeddings")
async def embeddings(payload: EmbeddingRequest, request: Request):
    model = state["embedding"]
    if model is None:
        raise HTTPException(503, "embedding model is unavailable")
    inputs = [payload.input] if isinstance(payload.input, str) else payload.input
    if not inputs or len(inputs) > 256 or any(not isinstance(item, str) for item in inputs):
        raise HTTPException(400, "input must contain 1 to 256 strings")
    if payload.dimensions not in (None, 1024):
        raise HTTPException(400, "BAAI/bge-m3 returns exactly 1024 dimensions")

    def encode() -> list[list[float]]:
        emb_device = getattr(getattr(model, "device", None), "type", "cpu")
        return _encode_embeddings(model, inputs, _effective_dtype(emb_device, state["embedding_dtype"]))

    try:
        vectors = await _run_inference(encode, request=request)
    except (asyncio.CancelledError, HTTPException):
        raise
    except Exception as exc:
        raise HTTPException(503, "embedding inference failed") from exc
    return {"object": "list", "data": [{"object": "embedding", "index": i, "embedding": vector} for i, vector in enumerate(vectors)], "model": EMBED_MODEL, "usage": {"prompt_tokens": 0, "total_tokens": 0}}


@app.post("/v1/rerank")
async def rerank(payload: RerankRequest, request: Request):
    model: CrossEncoder | None = state["reranker"]
    if model is None:
        raise HTTPException(503, "rerank model is unavailable")
    if len(payload.documents) > 256:
        raise HTTPException(400, "documents may contain at most 256 entries")
    pairs = [(payload.query, document) for document in payload.documents]

    def score() -> list[float]:
        amp_dtype = _effective_dtype(model.model.device.type, state["rerank_dtype"])
        return _score_rerank_pairs(model, pairs, amp_dtype, RERANK_MAX_LENGTH)

    try:
        scores = await _run_inference(score, request=request)
    except (asyncio.CancelledError, HTTPException):
        raise
    except Exception as exc:
        raise HTTPException(503, "rerank inference failed") from exc
    ranked = sorted(({"index": i, "relevance_score": score} for i, score in enumerate(scores)), key=lambda item: (-item["relevance_score"], item["index"]))
    if payload.top_n is not None:
        ranked = ranked[:max(0, payload.top_n)]
    if payload.return_documents:
        for item in ranked:
            item["document"] = payload.documents[item["index"]]
    return {"results": ranked, "model": RERANK_MODEL}
