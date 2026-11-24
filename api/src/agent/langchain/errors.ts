/* Error normalization and redaction for the server-side LangChain runtime.
 *
 * OpenAI SDK and LangChain wrap underlying fetch / Abort / Graph errors. This
 * module unwraps `cause` chains so stable AgentError codes (`model_timeout`,
 * `model_response_too_large`, `run_cancelled`, `invalid_request`,
 * `model_unavailable`) survive intact without leaking API keys or image data URLs.
 */
import { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { ModelAbortError } from '@langchain/core/errors';
import { GraphRecursionError } from '@langchain/langgraph';
import { AgentError, ERROR_STATUS } from '../../../agent-runtime/errors.js';

const MAX_CAUSE_DEPTH = 6;
const MAX_PROVIDER_MESSAGE = 300;
const VALID_CODES = new Set(Object.keys(ERROR_STATUS));

export function sanitizeErrorText(text: unknown): string {
  const raw = typeof text === 'string' ? text : String(text ?? '');
  if (!raw) return '';
  return raw
    .replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, '[REDACTED_IMAGE_DATA_URL]')
    .replace(/Bearer\s+[^\s,;'"`]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, '[REDACTED_KEY]');
}

export const sanitizeErrorMessage = sanitizeErrorText;

function walkCauses(error: unknown, visitor: (current: unknown) => boolean): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (visitor(current)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function extractNestedAgentError(error: unknown): AgentError | null {
  let found: AgentError | null = null;
  walkCauses(error, current => {
    if (current instanceof AgentError) {
      found = current;
      return true;
    }
    const candidate = current as { name?: unknown; code?: unknown; message?: unknown; status?: unknown; details?: unknown };
    if (candidate.name === 'AgentError' && typeof candidate.code === 'string' && VALID_CODES.has(candidate.code)) {
      found = new AgentError(
        candidate.code as keyof typeof ERROR_STATUS,
        sanitizeErrorText(candidate.message),
        {
          ...(typeof candidate.status === 'number' ? { status: candidate.status } : {}),
          ...(candidate.details !== undefined ? { details: candidate.details } : {}),
        },
      );
      return true;
    }
    return false;
  });
  return found;
}

function isAbortLike(error: unknown): boolean {
  return walkCauses(error, current => {
    if (current instanceof APIUserAbortError || ModelAbortError.isInstance(current)) return true;
    const item = current as { name?: unknown; lc_error_code?: unknown };
    return item.name === 'AbortError'
      || item.name === 'APIUserAbortError'
      || item.name === 'ModelAbortError'
      || item.lc_error_code === 'MODEL_ABORTED';
  });
}

function isTimeoutLike(error: unknown): boolean {
  return walkCauses(error, current => {
    if (current instanceof APIConnectionTimeoutError) return true;
    const item = current as { name?: unknown; code?: unknown; message?: unknown };
    if (
      item.name === 'TimeoutError'
      || item.name === 'APIConnectionTimeoutError'
      || item.name === 'HeadersTimeoutError'
      || item.name === 'BodyTimeoutError'
    ) {
      return true;
    }
    if (
      item.code === 'UND_ERR_HEADERS_TIMEOUT'
      || item.code === 'UND_ERR_BODY_TIMEOUT'
      || item.code === 'ETIMEDOUT'
    ) {
      return true;
    }
    return typeof item.message === 'string' && /\btimed?\s*out\b/i.test(item.message);
  });
}

function isGraphRecursionLike(error: unknown): boolean {
  return walkCauses(error, current => {
    if (current instanceof GraphRecursionError) return true;
    const item = current as { name?: unknown; lc_error_code?: unknown };
    return item.name === 'GraphRecursionError' || item.lc_error_code === 'GRAPH_RECURSION_LIMIT';
  });
}

function extractHttpStatusError(error: unknown): { status: number; providerMessage?: string } | null {
  let matched: { status: number; providerMessage?: string } | null = null;
  walkCauses(error, current => {
    const candidate = current as {
      status?: unknown;
      message?: unknown;
      error?: { message?: unknown } | unknown;
    };
    const status = current instanceof APIError
      ? current.status
      : (typeof candidate.status === 'number' && Number.isFinite(candidate.status) ? candidate.status : undefined);
    if (status === undefined || status < 400) return false;
    const nestedErr = candidate.error && typeof candidate.error === 'object'
      ? (candidate.error as { message?: unknown }).message
      : undefined;
    const rawMsg = typeof nestedErr === 'string'
      ? nestedErr
      : (typeof candidate.message === 'string' ? candidate.message : '');
    const safeMsg = sanitizeErrorText(rawMsg).trim();
    matched = {
      status,
      ...(safeMsg ? { providerMessage: safeMsg.slice(0, MAX_PROVIDER_MESSAGE) } : {}),
    };
    return true;
  });
  return matched;
}

export function mapLangChainError(error: unknown, signal?: AbortSignal | null): AgentError {
  const nested = extractNestedAgentError(error);
  if (nested) {
    if (signal?.aborted && nested.code === 'model_unavailable') {
      return new AgentError('run_cancelled', 'the run was cancelled', { cause: error });
    }
    return nested;
  }
  if (signal?.aborted || isAbortLike(error)) {
    return new AgentError('run_cancelled', 'the run was cancelled', { cause: error });
  }
  if (isGraphRecursionLike(error)) {
    return new AgentError('invalid_request', 'the model kept calling tools after the round budget', { cause: error });
  }
  if (isTimeoutLike(error)) {
    return new AgentError('model_timeout', 'provider did not answer in time', { cause: error });
  }
  const httpError = extractHttpStatusError(error);
  if (httpError) {
    return new AgentError('model_unavailable', `provider answered HTTP ${httpError.status}`, {
      details: {
        status: httpError.status,
        ...(httpError.providerMessage ? { providerMessage: httpError.providerMessage } : {}),
      },
      cause: error,
    });
  }
  return new AgentError('model_unavailable', 'could not reach the provider', { cause: error });
}

export const mapProviderError = mapLangChainError;
