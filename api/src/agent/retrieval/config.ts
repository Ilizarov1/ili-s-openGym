import { AgentError } from '../../../agent-runtime/errors.js';

export type RetrievalBackend = 'local' | 'remote';

export interface RetrievalConfig {
  pgUrl: string;
  embeddingBackend: RetrievalBackend;
  embeddingUrl: string;
  embeddingModel: string;
  embeddingApiKey?: string;
  embeddingDim: number;
  embeddingRequestDimensions?: number;
  rerankBackend: RetrievalBackend;
  rerankUrl: string;
  rerankModel: string;
  rerankApiKey?: string;
  embeddingTimeoutMs: number;
  pgTimeoutMs: number;
  rerankTimeoutMs: number;
  rerankTopK?: number;
  catalogueHash: string;
  indexRetention: number;
}

const intEnv = (env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1, max = Number.POSITIVE_INFINITY) => {
  const raw = env[key]?.trim();
  const value = Number(raw ? raw : fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
};

export function normalizedEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new Error('Retrieval endpoint must be an HTTP URL');
  }
}

function requestEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    return url.toString();
  } catch { throw new Error('Retrieval endpoint must be an HTTP URL'); }
}

export function retrievalIndexKey(catalogueHash: string, config: Pick<RetrievalConfig, 'embeddingBackend'|'embeddingUrl'|'embeddingModel'|'embeddingDim'>): string {
  return JSON.stringify([catalogueHash, config.embeddingBackend, normalizedEndpoint(config.embeddingUrl), config.embeddingModel, config.embeddingDim]);
}

export function retrievalConfig(env: NodeJS.ProcessEnv = process.env): RetrievalConfig {
  const embeddingBackend = (env.EXERCISE_SEARCH_EMBEDDING_BACKEND || 'local') as RetrievalBackend;
  const rerankBackend = (env.EXERCISE_SEARCH_RERANK_BACKEND || 'local') as RetrievalBackend;
  if (!['local', 'remote'].includes(embeddingBackend) || !['local', 'remote'].includes(rerankBackend)) {
    throw new Error('Invalid retrieval backend');
  }
  const local = (env.EXERCISE_SEARCH_LOCAL_MODEL_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  const embeddingUrl = embeddingBackend === 'local'
    ? `${local}/v1/embeddings`
    : env.EXERCISE_SEARCH_REMOTE_EMBEDDING_URL;
  const rerankUrl = rerankBackend === 'local'
    ? `${local}/v1/rerank`
    : env.EXERCISE_SEARCH_REMOTE_RERANK_URL;
  const embeddingModel = embeddingBackend === 'local' ? 'BAAI/bge-m3' : env.EXERCISE_SEARCH_REMOTE_EMBEDDING_MODEL;
  const rerankModel = rerankBackend === 'local' ? 'BAAI/bge-reranker-v2-m3' : env.EXERCISE_SEARCH_REMOTE_RERANK_MODEL;
  if (!embeddingUrl || !rerankUrl || !embeddingModel || !rerankModel) throw new Error('Retrieval model configuration is incomplete');
  const embeddingDim = 1024;
  const embeddingRequestDimensions = embeddingBackend === 'remote' && env.EXERCISE_SEARCH_REMOTE_EMBEDDING_DIM?.trim()
    ? intEnv(env, 'EXERCISE_SEARCH_REMOTE_EMBEDDING_DIM', embeddingDim)
    : undefined;
  if (embeddingRequestDimensions !== undefined && embeddingRequestDimensions !== embeddingDim) {
    throw new Error('Retrieval index requires 1024 dimensions');
  }
  const pgUrl = env.EXERCISE_SEARCH_PG_URL || 'postgres://localhost:55432/opengym_retrieval';
  const parsedPgUrl = new URL(pgUrl);
  if (!['postgres:', 'postgresql:'].includes(parsedPgUrl.protocol)) throw new Error('EXERCISE_SEARCH_PG_URL must be a PostgreSQL URL');
  return {
    pgUrl,
    embeddingBackend, embeddingUrl: requestEndpoint(embeddingUrl), embeddingModel,
    embeddingApiKey: embeddingBackend === 'remote' ? env.EXERCISE_SEARCH_REMOTE_EMBEDDING_API_KEY : undefined,
    embeddingDim,
    embeddingRequestDimensions,
    rerankBackend, rerankUrl: requestEndpoint(rerankUrl), rerankModel,
    rerankApiKey: rerankBackend === 'remote' ? env.EXERCISE_SEARCH_REMOTE_RERANK_API_KEY : undefined,
    embeddingTimeoutMs: intEnv(env, 'EXERCISE_SEARCH_EMBEDDING_TIMEOUT_MS', 5000),
    pgTimeoutMs: intEnv(env, 'EXERCISE_SEARCH_PG_TIMEOUT_MS', 3000),
    rerankTimeoutMs: intEnv(env, 'EXERCISE_SEARCH_RERANK_TIMEOUT_MS', 15000),
    rerankTopK: intEnv(env, 'EXERCISE_SEARCH_RERANK_TOP_K', 30, 10, 30),
    catalogueHash: env.EXERCISE_SEARCH_CATALOGUE_HASH || 'runtime',
    indexRetention: intEnv(env, 'EXERCISE_SEARCH_INDEX_RETENTION', 3),
  };
}

/** Keep optional v2 dependencies from preventing the v1-only API from booting. */
export function safeRetrievalConfig(env: NodeJS.ProcessEnv = process.env): RetrievalConfig {
  try { return retrievalConfig(env); }
  catch { return retrievalConfig({}); }
}

export function retrievalConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const pgUrl = new URL(env.EXERCISE_SEARCH_PG_URL || '');
    if (!['postgres:', 'postgresql:'].includes(pgUrl.protocol)) return false;
    const embedding = env.EXERCISE_SEARCH_EMBEDDING_BACKEND || 'local';
    const rerank = env.EXERCISE_SEARCH_RERANK_BACKEND || 'local';
    if (!['local', 'remote'].includes(embedding) || !['local', 'remote'].includes(rerank)) return false;
    const local = env.EXERCISE_SEARCH_LOCAL_MODEL_URL;
    const embeddingReady = embedding === 'local'
      ? Boolean(local)
      : Boolean(env.EXERCISE_SEARCH_REMOTE_EMBEDDING_URL && env.EXERCISE_SEARCH_REMOTE_EMBEDDING_MODEL && env.EXERCISE_SEARCH_REMOTE_EMBEDDING_API_KEY);
    const rerankReady = rerank === 'local'
      ? Boolean(local)
      : Boolean(env.EXERCISE_SEARCH_REMOTE_RERANK_URL && env.EXERCISE_SEARCH_REMOTE_RERANK_MODEL && env.EXERCISE_SEARCH_REMOTE_RERANK_API_KEY);
    retrievalConfig(env);
    return embeddingReady && rerankReady;
  } catch { return false; }
}

export function asRetrievalError(error: unknown, timeout: boolean, phase: 'retrieval' | 'rerank' = 'retrieval'): AgentError {
  if (error instanceof AgentError) return error;
  return new AgentError(timeout ? 'retrieval_timeout' : 'retrieval_unavailable',
    timeout ? 'Exercise retrieval timed out.' : 'Exercise retrieval is unavailable.',
    { cause: error, details: { phase } });
}
