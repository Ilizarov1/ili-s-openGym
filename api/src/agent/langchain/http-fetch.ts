/* Bounded HTTP fetch for OpenAI SDK / ChatOpenAI.
 *
 * Enforces a hard response byte cap (default 1 MiB) and keeps both timeout and
 * caller AbortSignal active through the entire response body read, then returns
 * a clean Response with decoded bytes and stripped content-encoding/length headers.
 */
import { AgentError } from '../../../agent-runtime/errors.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface BoundedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal | null;
  omitAuthHeader?: boolean;
  fetchImpl?: typeof fetch;
}

function mergeUint8Arrays(chunks: Uint8Array[], totalLength: number): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  controller: AbortController,
  didTimeout: () => boolean,
  wasCancelled: () => boolean,
): Promise<Uint8Array<ArrayBuffer>> {
  if (didTimeout()) throw new AgentError('model_timeout', 'provider did not answer in time');
  if (wasCancelled()) throw new AgentError('run_cancelled', 'the run was cancelled');

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    try { await response.body?.cancel(); } catch { /* stream already closed */ }
    throw new AgentError('model_response_too_large', 'provider response exceeded the size limit', {
      details: { limit: maxBytes },
    });
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const onAbort = () => {
      try {
        const cancelled = reader.cancel();
        if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => undefined);
      } catch {
        /* reader already closed */
      }
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        if (didTimeout()) throw new AgentError('model_timeout', 'provider did not answer in time');
        if (wasCancelled()) throw new AgentError('run_cancelled', 'the run was cancelled');
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* reader already closed */ }
          throw new AgentError('model_response_too_large', 'provider response exceeded the size limit', {
            details: { limit: maxBytes },
          });
        }
        chunks.push(value);
      }
      if (didTimeout()) throw new AgentError('model_timeout', 'provider did not answer in time');
      if (wasCancelled()) throw new AgentError('run_cancelled', 'the run was cancelled');
      return mergeUint8Arrays(chunks, total);
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  const buffer = await response.arrayBuffer();
  if (didTimeout()) throw new AgentError('model_timeout', 'provider did not answer in time');
  if (wasCancelled()) throw new AgentError('run_cancelled', 'the run was cancelled');
  if (buffer.byteLength > maxBytes) {
    throw new AgentError('model_response_too_large', 'provider response exceeded the size limit', {
      details: { limit: maxBytes },
    });
  }
  return new Uint8Array(buffer);
}

export function createBoundedFetch(options: BoundedFetchOptions = {}): typeof fetch {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const maxBytes = Math.max(1024, Number(options.maxBytes) || DEFAULT_MAX_BYTES);
  const outerSignal = options.signal ?? null;
  const omitAuthHeader = options.omitAuthHeader === true;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    throw new Error('bounded fetch requires a fetch implementation');
  }

  return async function boundedFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    if (outerSignal?.aborted) {
      throw new AgentError('run_cancelled', 'the run was cancelled');
    }

    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const initSignal = init?.signal ?? null;

    const onOuterAbort = () => {
      cancelled = true;
      controller.abort();
    };
    const onInitAbort = () => {
      if (outerSignal?.aborted) cancelled = true;
      controller.abort();
    };

    if (outerSignal) outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    if (initSignal) {
      if (initSignal.aborted) {
        if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
        if (outerSignal?.aborted) throw new AgentError('run_cancelled', 'the run was cancelled');
        throw new AgentError('model_timeout', 'provider did not answer in time');
      }
      initSignal.addEventListener('abort', onInitAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let headers: Headers | undefined;
      if (omitAuthHeader) {
        headers = new Headers(init?.headers);
        headers.delete('authorization');
      }
      const response = await fetchImpl(input, {
        ...init,
        ...(headers ? { headers } : {}),
        signal: controller.signal,
      });
      const bytes = await readBoundedBytes(
        response,
        maxBytes,
        controller,
        () => timedOut,
        () => cancelled || Boolean(outerSignal?.aborted),
      );
      const cleanHeaders = new Headers(response.headers);
      cleanHeaders.delete('content-encoding');
      cleanHeaders.delete('content-length');
      const bodyInit = bytes.byteLength > 0 ? bytes : null;
      return new Response(bodyInit, {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders,
      });
    } catch (error) {
      if (timedOut) throw new AgentError('model_timeout', 'provider did not answer in time', { cause: error });
      if (cancelled || outerSignal?.aborted) {
        throw new AgentError('run_cancelled', 'the run was cancelled', { cause: error });
      }
      if (error instanceof AgentError) throw error;
      if (initSignal?.aborted && !outerSignal?.aborted) {
        throw new AgentError('model_timeout', 'provider did not answer in time', { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
      if (initSignal) initSignal.removeEventListener('abort', onInitAbort);
    }
  };
}
