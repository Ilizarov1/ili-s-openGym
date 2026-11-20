/* One bounded HTTP exchange for a model provider.
 *
 * The response is read through a byte counter, never res.text() alone: a
 * provider that streams pages, or a gateway that answers with a large error
 * page, must not be able to fill the API's memory.
 */
import { AgentError } from '../errors.js';

const DEFAULT_MAX_BYTES = 1024 * 1024;

async function readLimited(response, maxBytes) {
  const length = Number(response.headers && response.headers.get && response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new AgentError('model_response_too_large', 'provider response exceeded the size limit', {
      details: { limit: maxBytes },
    });
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already gone */ }
        throw new AgentError('model_response_too_large', 'provider response exceeded the size limit', {
          details: { limit: maxBytes },
        });
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder().decode(merged);
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new AgentError('model_response_too_large', 'provider response exceeded the size limit', {
      details: { limit: maxBytes },
    });
  }
  return text;
}

/**
 * @param {{ fetchImpl?: typeof fetch, AbortControllerImpl?: typeof AbortController }} options
 */
export function createHttpClient(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const AbortControllerImpl = options.AbortControllerImpl || globalThis.AbortController;
  if (typeof fetchImpl !== 'function') throw new Error('agent HTTP client needs fetch');
  if (typeof AbortControllerImpl !== 'function') throw new Error('agent HTTP client needs AbortController');

  return async function requestJson(url, init = {}, settings = {}) {
    const timeoutMs = Math.max(1, Number(settings.timeoutMs) || 60000);
    const maxBytes = Math.max(1024, Number(settings.maxBytes) || DEFAULT_MAX_BYTES);
    const outer = settings.signal;
    if (outer && outer.aborted) throw new AgentError('run_cancelled', 'the run was cancelled');
    const controller = new AbortControllerImpl();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (outer) outer.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new AgentError('model_timeout', 'provider did not answer in time', { cause: error });
      if (outer && outer.aborted) throw new AgentError('run_cancelled', 'the run was cancelled', { cause: error });
      throw new AgentError('model_unavailable', 'could not reach the provider', { cause: error });
    } finally {
      clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    }
    let text;
    try {
      text = await readLimited(response, maxBytes);
    } catch (error) {
      if (error instanceof AgentError) throw error;
      if (timedOut) throw new AgentError('model_timeout', 'provider did not answer in time', { cause: error });
      if (outer && outer.aborted) throw new AgentError('run_cancelled', 'the run was cancelled', { cause: error });
      throw new AgentError('model_unavailable', 'provider answer could not be read', { cause: error });
    }
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok) {
          throw new AgentError('model_unavailable', 'provider answered with something other than JSON');
        }
      }
    }
    return { status: response.status, ok: !!response.ok, text, data };
  };
}
