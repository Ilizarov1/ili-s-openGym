/* Bounded HTTP fetch for OpenAI SDK / ChatOpenAI.
 *
 * Enforces a hard response byte cap (default 1 MiB) and keeps both timeout and
 * caller AbortSignal active through the entire response body read, then returns
 * a clean Response with decoded bytes and stripped content-encoding/length headers.
 *
 * When `streaming: true` and the provider answered 2xx with a real body stream, the
 * bytes are NOT buffered: the response body is handed back as a limited
 * `ReadableStream` that re-checks the same caps on every pull. The timeout timer and
 * abort listeners stay installed until that stream closes, errors or is cancelled.
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
  /** Pass the body through as a bounded stream instead of buffering it. */
  streaming?: boolean;
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

/* Wrap the upstream body in a pass-through stream that enforces the same byte cap,
 * timeout and cancellation contract as readBoundedBytes, but per chunk. The caller
 * owns `cleanup`, so the request timer and abort listeners survive the hand-off and
 * are only removed once this stream closes, errors or is cancelled. */
function createBoundedBodyStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  controller: AbortController,
  didTimeout: () => boolean,
  wasCancelled: () => boolean,
  cleanup: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  let settled = false;
  let tornDown = false;
  let active: ReadableStreamDefaultController<Uint8Array> | null = null;

  const cancelUpstream = () => {
    try {
      const cancelled = reader.cancel();
      if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(() => undefined);
    } catch {
      /* reader already closed */
    }
  };

  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    controller.signal.removeEventListener('abort', onAbort);
    cleanup();
  };

  const fail = (target: ReadableStreamDefaultController<Uint8Array>, error: AgentError): void => {
    if (settled) return;
    settled = true;
    teardown();
    try {
      target.error(error);
    } catch {
      /* the consumer already cancelled */
    }
  };

  const close = (target: ReadableStreamDefaultController<Uint8Array>): void => {
    if (settled) return;
    settled = true;
    teardown();
    try {
      target.close();
    } catch {
      /* the consumer already cancelled */
    }
  };

  // An abort (timeout or caller cancellation) must both stop the upstream socket and
  // fail the consumer with the stable AgentError code instead of a bare DOMException.
  const onAbort = () => {
    cancelUpstream();
    if (!active) return;
    const error = didTimeout()
      ? new AgentError('model_timeout', 'provider did not answer in time')
      : new AgentError('run_cancelled', 'the run was cancelled');
    fail(active, error);
  };

  controller.signal.addEventListener('abort', onAbort, { once: true });

  const wrapError = (error: unknown): AgentError => {
    if (error instanceof AgentError) return error;
    if (didTimeout()) return new AgentError('model_timeout', 'provider did not answer in time', { cause: error });
    if (wasCancelled()) return new AgentError('run_cancelled', 'the run was cancelled', { cause: error });
    return error instanceof Error
      ? new AgentError('model_unavailable', 'the provider stream failed', { cause: error })
      : new AgentError('model_unavailable', 'the provider stream failed');
  };

  return new ReadableStream<Uint8Array>({
    start(target) {
      active = target;
    },
    async pull(target) {
      active = target;
      try {
        if (didTimeout()) throw new AgentError('model_timeout', 'provider did not answer in time');
        if (wasCancelled()) throw new AgentError('run_cancelled', 'the run was cancelled');
        const { done, value } = await reader.read();
        if (done) {
          close(target);
          return;
        }
        if (!value || value.byteLength === 0) return;
        total += value.byteLength;
        if (total > maxBytes) {
          cancelUpstream();
          fail(target, new AgentError('model_response_too_large', 'provider response exceeded the size limit', {
            details: { limit: maxBytes },
          }));
          return;
        }
        if (!settled) target.enqueue(value);
      } catch (error) {
        fail(target, wrapError(error));
      }
    },
    cancel() {
      cancelUpstream();
      if (settled) return;
      settled = true;
      teardown();
    },
  });
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
    let handedOffToStream = false;
    const initSignal = init?.signal ?? null;

    const onOuterAbort = () => {
      cancelled = true;
      controller.abort();
    };
    const onInitAbort = () => {
      if (outerSignal?.aborted) cancelled = true;
      controller.abort();
    };

    const releaseRequestResources = () => {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
      if (initSignal) initSignal.removeEventListener('abort', onInitAbort);
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

      if (options.streaming === true && response.ok && response.body && typeof response.body.getReader === 'function') {
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          try { await response.body.cancel(); } catch { /* stream already closed */ }
          throw new AgentError('model_response_too_large', 'provider response exceeded the size limit', {
            details: { limit: maxBytes },
          });
        }
        const cleanHeaders = new Headers(response.headers);
        cleanHeaders.delete('content-encoding');
        cleanHeaders.delete('content-length');
        const stream = createBoundedBodyStream(
          response.body,
          maxBytes,
          controller,
          () => timedOut,
          () => cancelled || Boolean(outerSignal?.aborted),
          releaseRequestResources,
        );
        const streamedResponse = new Response(stream, {
          status: response.status,
          statusText: response.statusText,
          headers: cleanHeaders,
        });
        handedOffToStream = true;
        return streamedResponse;
      }

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
      // A handed-off body stream owns the timer and listeners now.
      if (!handedOffToStream) releaseRequestResources();
    }
  };
}
