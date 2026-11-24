from __future__ import annotations

import asyncio
import importlib
import os
import sys
import unittest
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main  # noqa: E402


class FakeTensor:
    def to(self, _device):
        return self


class FakeTokenizer:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def __call__(self, queries, docs, **kwargs):
        self.calls.append({"queries": queries, "docs": docs, **kwargs})
        return {"input_ids": FakeTensor()}


class FakeDevice:
    def __init__(self, device_type: str = "cuda") -> None:
        self.type = device_type


class FakeCrossEncoderModel:
    def __init__(self, device_type: str = "cuda", fail_non_finite_once: bool = False) -> None:
        self.device = FakeDevice(device_type)
        self.fail_non_finite_once = fail_non_finite_once
        self.forward_autocast_dtypes: list[torch.dtype | None] = []

    def __call__(self, **_encoded):
        current_dtype = torch.get_autocast_dtype("cuda") if torch.is_autocast_enabled("cuda") else None
        self.forward_autocast_dtypes.append(current_dtype)
        if self.fail_non_finite_once and current_dtype is not None:
            logits = torch.tensor([[float("inf")], [2.0]], dtype=torch.float32)
        else:
            logits = torch.tensor([[1.5], [-0.5]], dtype=torch.float32)
        return SimpleNamespace(logits=logits)


class FakeCrossEncoder:
    def __init__(self, device_type: str = "cuda", fail_non_finite_once: bool = False) -> None:
        self.tokenizer = FakeTokenizer()
        self.model = FakeCrossEncoderModel(device_type=device_type, fail_non_finite_once=fail_non_finite_once)
        self.activation_fn = torch.nn.Sigmoid()


class RetrievalModelMainTests(unittest.TestCase):
    def setUp(self) -> None:
        main.state["rerank_fp32_fallbacks"] = 0

    def test_parse_dtype_and_max_length_config(self) -> None:
        with patch.dict(os.environ, {"RETRIEVAL_RERANK_DTYPE": "bf16"}, clear=False):
            with patch.object(main, "DEVICE", "cuda"):
                self.assertEqual(main._parse_dtype_name("RETRIEVAL_RERANK_DTYPE", "fp16"), "bf16")
            with patch.object(main, "DEVICE", "cpu"):
                self.assertEqual(main._parse_dtype_name("RETRIEVAL_RERANK_DTYPE", "fp16"), "fp32")
        with patch.dict(os.environ, {"RETRIEVAL_RERANK_DTYPE": "int8"}, clear=False):
            with self.assertRaises(ValueError):
                main._parse_dtype_name("RETRIEVAL_RERANK_DTYPE", "fp16")
        with patch.dict(os.environ, {"RETRIEVAL_RERANK_MAX_LENGTH": "999"}, clear=False):
            reloaded = importlib.reload(main)
            self.assertEqual(reloaded.RERANK_MAX_LENGTH, 512)
        with patch.dict(os.environ, {"RETRIEVAL_RERANK_MAX_LENGTH": "256"}, clear=False):
            reloaded = importlib.reload(main)
            self.assertEqual(reloaded.RERANK_MAX_LENGTH, 256)

    def test_fp16_bf16_autocast_and_fp32_fallback_on_non_finite(self) -> None:
        for dtype_name, expected_torch_dtype in [("fp16", torch.float16), ("bf16", torch.bfloat16)]:
            fake = FakeCrossEncoder(device_type="cuda", fail_non_finite_once=False)
            entered_dtypes: list[torch.dtype] = []

            def fake_autocast(device_type: str, dtype: torch.dtype):
                self.assertEqual(device_type, "cuda")
                entered_dtypes.append(dtype)
                return nullcontext()

            with patch.object(main.torch, "autocast", side_effect=fake_autocast):
                scores = main._score_rerank_pairs(
                    fake,
                    [("q1", "d1"), ("q2", "d2")],
                    main._effective_dtype("cuda", dtype_name),
                    main.RERANK_MAX_LENGTH,
                )
            self.assertEqual(entered_dtypes, [expected_torch_dtype])
            self.assertEqual(fake.tokenizer.calls[0]["pad_to_multiple_of"], 8)
            self.assertEqual(fake.tokenizer.calls[0]["max_length"], main.RERANK_MAX_LENGTH)
            self.assertEqual(len(scores), 2)
            self.assertEqual(main.state["rerank_fp32_fallbacks"], 0)

        # Verify non-finite logits under half-precision trigger per-batch FP32 fallback & counter increment
        fallback_fake = FakeCrossEncoder(device_type="cuda", fail_non_finite_once=True)
        autocast_calls: list[torch.dtype] = []

        class FakeCudaAutocast:
            def __init__(self, device_type: str, dtype: torch.dtype) -> None:
                autocast_calls.append(dtype)
                self._prev = torch.is_autocast_enabled("cuda")
                self._prev_dtype = torch.get_autocast_dtype("cuda")
                self._dtype = dtype

            def __enter__(self):
                torch.set_autocast_enabled("cuda", True)
                torch.set_autocast_dtype("cuda", self._dtype)

            def __exit__(self, *_exc):
                torch.set_autocast_enabled("cuda", self._prev)
                torch.set_autocast_dtype("cuda", self._prev_dtype)

        with patch.object(main.torch, "autocast", FakeCudaAutocast):
            scores = main._score_rerank_pairs(
                fallback_fake,
                [("q1", "d1"), ("q2", "d2")],
                torch.float16,
                256,
            )
        self.assertEqual(autocast_calls, [torch.float16])
        self.assertEqual(fallback_fake.model.forward_autocast_dtypes, [torch.float16, None])
        self.assertEqual(main.state["rerank_fp32_fallbacks"], 1)
        self.assertAlmostEqual(scores[0], torch.sigmoid(torch.tensor(1.5)).item(), places=5)

    def test_health_exposes_backward_compatible_and_new_fields(self) -> None:
        with patch.dict(
            main.state,
            {
                "embedding": object(),
                "reranker": object(),
                "embedding_device": "rocm",
                "reranker_device": "rocm",
                "embedding_dtype": "fp32",
                "rerank_dtype": "fp16",
                "embedding_warmup_ok": True,
                "rerank_warmup_ok": True,
                "rerank_fp32_fallbacks": 2,
            },
        ):
            payload = asyncio.run(main.health())
        self.assertEqual(payload["status"], "ready")
        self.assertEqual(payload["device"], "rocm")
        self.assertEqual(payload["models"]["embedding"]["dtype"], "fp32")
        self.assertEqual(payload["models"]["rerank"]["dtype"], "fp16")
        self.assertEqual(payload["models"]["rerank"]["max_length"], main.RERANK_MAX_LENGTH)
        self.assertTrue(payload["models"]["rerank"]["warmup_ok"])
        self.assertEqual(payload["models"]["rerank"]["fp32_fallbacks"], 2)

    @unittest.skipUnless(torch.cuda.is_available(), "CUDA/ROCm GPU required for live autocast smoke test")
    def test_rocm_cuda_autocast_fp16_and_bf16_smoke(self) -> None:
        x = torch.randn((4, 16), device="cuda", dtype=torch.float32)
        w = torch.randn((16, 8), device="cuda", dtype=torch.float32)
        for dtype in (torch.float16, torch.bfloat16):
            with torch.inference_mode(), torch.autocast(device_type="cuda", dtype=dtype):
                out = x @ w
            self.assertEqual(out.dtype, dtype)
            self.assertTrue(torch.isfinite(out).all().item())


if __name__ == "__main__":
    unittest.main()
