import { AgentError } from '../../../agent-runtime/errors.js';
import type { RetrievalConfig } from './config.js';

export interface RerankDocument { id: string; text: string }
export interface RerankResult { index: number; relevanceScore: number }

function finiteVector(value: unknown, dimensions: number): number[] {
  if (!Array.isArray(value) || value.length !== dimensions || !value.every(v => typeof v === 'number' && Number.isFinite(v))) {
    throw new AgentError('retrieval_unavailable', 'Embedding provider returned an invalid vector.');
  }
  return value as number[];
}

async function postJson(url: string, key: string | undefined, timeoutMs: number, signal: AbortSignal | undefined, body: unknown) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), timeoutMs);
  const abort = () => controller.abort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Model endpoint returned ${response.status}`);
    return await response.json() as Record<string, any>;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

function embeddingRequest(config: RetrievalConfig, input: string | string[]) {
  const dimensions = config.embeddingRequestDimensions;
  return { model: config.embeddingModel, input, ...(dimensions === undefined ? {} : { dimensions }) };
}

export async function embedText(config: RetrievalConfig, text: string, signal?: AbortSignal): Promise<number[]> {
  const result = await postJson(config.embeddingUrl, config.embeddingApiKey, config.embeddingTimeoutMs, signal,
    embeddingRequest(config, text));
  const data = result.data;
  if (!Array.isArray(data) || data.length !== 1 || data[0]?.index !== 0) throw new AgentError('retrieval_unavailable', 'Embedding provider returned an invalid response.');
  return finiteVector(data[0].embedding, config.embeddingDim);
}

export async function embedTexts(config: RetrievalConfig, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const result = await postJson(config.embeddingUrl, config.embeddingApiKey, config.embeddingTimeoutMs, signal,
    embeddingRequest(config, texts));
  const rows = result.data;
  if (!Array.isArray(rows) || rows.length !== texts.length) throw new AgentError('retrieval_unavailable', 'Embedding provider returned an invalid batch.');
  const ordered = [...rows].sort((a, b) => a.index - b.index);
  return ordered.map((row, i) => {
    if (row.index !== i) throw new AgentError('retrieval_unavailable', 'Embedding provider returned invalid indices.');
    return finiteVector(row.embedding, config.embeddingDim);
  });
}

export async function rerank(config: RetrievalConfig, query: string, documents: RerankDocument[], signal?: AbortSignal): Promise<RerankResult[]> {
  const result = await postJson(config.rerankUrl, config.rerankApiKey, config.rerankTimeoutMs, signal,
    { model: config.rerankModel, query, documents: documents.map(d => d.text), top_n: documents.length });
  if (!Array.isArray(result.results)) throw new AgentError('retrieval_unavailable', 'Reranker returned an invalid response.');
  return result.results.map((item: any) => ({ index: item?.index, relevanceScore: item?.relevance_score }))
    .filter((item: RerankResult) => Number.isInteger(item.index) && item.index >= 0 && item.index < documents.length && Number.isFinite(item.relevanceScore));
}
