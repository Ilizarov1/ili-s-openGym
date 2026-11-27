/* AG-UI SSE client for the Coach generative-UI stream.
 *
 * One entry point, two transports. Expo SDK 55 ships a streaming `expo/fetch` whose body is a
 * web `ReadableStream`, so the normal path decodes chunks with `TextDecoder({ stream: true })`
 * and feeds them to a pure frame parser. Some Android/Hermes builds hand back a response body
 * without `getReader`; those fall back to `XMLHttpRequest` + `onprogress`, slicing
 * `responseText` by the offset already consumed and feeding the exact same parser, so the
 * renderer sees identical events either way.
 *
 * The wire protocol is the AG-UI event vocabulary emitted by
 * `api/src/agent/coach-genui.controller.ts`:
 *   RUN_STARTED, STEP_STARTED/FINISHED, TOOL_CALL_START/RESULT,
 *   CUSTOM(genui.prose_delta / node_pending / node_commit / node_drop / block_upsert),
 *   RUN_FINISHED, RUN_ERROR
 * Every event is JSON in a `data:` frame.
 */
import { fetch as expoFetch } from 'expo/fetch';

export const COACH_STREAM_PATH = '/api/agent/coach/stream';
export const COACH_CONFIG_PATH = '/api/config';

/** The paired-server credentials the phone already stores. */
export interface CoachStreamConnection {
  server: string;
  token: string;
}

export interface CoachHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A validated GenUI node as it arrives on the wire; discriminant fields stay optional. */
export type CoachGenUINode = { id?: string; type?: string } & Record<string, unknown>;

/**
 * One parsed AG-UI event. The index signature keeps unknown forward-compatible fields
 * available without an `any`, while the named fields below document the protocol.
 */
export interface CoachStreamEvent {
  /** AG-UI event name, e.g. `RUN_STARTED` or `CUSTOM`. */
  type: string;
  [key: string]: unknown;
  /** ISO timestamp added by the service to every event. */
  timestamp?: string;
  runId?: string;
  threadId?: string;
  protocolVersion?: number;
  stepName?: string;
  label?: string;
  toolCallId?: string;
  toolCallName?: string;
  args?: Record<string, unknown>;
  summary?: string;
  messageId?: string;
  role?: string;
  delta?: string;
  /** CUSTOM frame name, e.g. `genui.prose_delta`. */
  name?: string;
  /** CUSTOM frame payload. */
  value?: Record<string, unknown>;
  text?: string;
  nodes?: CoachGenUINode[];
  blocks?: CoachGenUINode[];
  /** RUN_ERROR code. */
  code?: string;
  /** RUN_ERROR message or a human-readable HTTP error. */
  message?: string;
}

export type CoachStreamErrorCode =
  | 'aborted'
  | 'unauthorized'
  | 'turn_limit'
  | 'genui_unavailable'
  | 'network'
  | 'http'
  | 'run_error'
  | 'config_unavailable'
  // Forward-compatible codes such as a server's own `code` field.
  | (string & {});

/** A normalised transport/protocol failure, safe to branch on in the screen layer. */
export interface CoachStreamError extends Error {
  code: CoachStreamErrorCode;
  /** HTTP status when the failure came from a response, never set for network errors. */
  status?: number;
  /** Turn budget when a 429 body carries one. */
  limit?: number;
  /** True when the caller should fall back to the legacy non-GenUI Coach path. */
  fallback?: boolean;
  /** Parsed error body, kept for diagnostics. */
  data?: Record<string, unknown>;
}

/** The fields `coachError` attaches to a fresh `Error`. */
export interface CoachStreamErrorDetails {
  code: CoachStreamErrorCode;
  status?: number;
  limit?: number;
  fallback?: boolean;
  data?: Record<string, unknown>;
}

/** A decoded byte source, matching the subset of `ReadableStreamDefaultReader` we use. */
export interface CoachByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel?(): Promise<void>;
}

/** The subset of a fetch `Response` this client reads. */
export interface CoachFetchResponse {
  status: number;
  ok: boolean;
  body?: { getReader(): CoachByteReader } | null;
  text(): Promise<string>;
}

export interface CoachFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type CoachFetch = (url: string, init: CoachFetchInit) => Promise<CoachFetchResponse>;

/** The subset of `XMLHttpRequest` the fallback transport drives. */
export interface CoachXhr {
  status: number;
  responseText: string;
  onprogress: (() => void) | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: string): void;
  abort(): void;
}

/** Injection seam: tests (and a future local BYOK transport) supply their own primitives. */
export interface CoachStreamTransport {
  fetch?: CoachFetch;
  createXhr?: () => CoachXhr;
}

export interface StreamCoachOptions {
  connection: CoachStreamConnection;
  text?: string;
  formSubmission?: Record<string, unknown>;
  history?: CoachHistoryMessage[];
  plan?: unknown;
  lang?: string;
  today?: string;
  signal?: AbortSignal;
  onEvent: (event: CoachStreamEvent) => void;
  transport?: CoachStreamTransport;
}

/** The terminal RUN_FINISHED payload, mirroring the Web client's return value. */
export interface CoachStreamResult {
  runId?: string;
  threadId?: string;
  text: string;
  nodes: CoachGenUINode[] | null;
  blocks: CoachGenUINode[];
  eventCount: number;
}

/** What `GET /api/config` tells a paired phone before it opens the Coach. */
export interface CoachConfigSnapshot {
  agentEnabled: boolean;
  exerciseSearchVersion: 'v1' | 'v2';
  coachEnabled: boolean;
}

/* ------------------------------- error helpers ------------------------------ */

const ABORTED_MESSAGE = 'aborted';

function coachError(message: string, details: CoachStreamErrorDetails): CoachStreamError {
  const error = new Error(message) as CoachStreamError;
  error.name = details.code === 'aborted' ? 'AbortError' : 'CoachStreamError';
  error.code = details.code;
  if (details.status !== undefined) error.status = details.status;
  if (details.limit !== undefined) error.limit = details.limit;
  if (details.fallback !== undefined) error.fallback = details.fallback;
  if (details.data !== undefined) error.data = details.data;
  return error;
}

function abortError(): CoachStreamError {
  return coachError(ABORTED_MESSAGE, { code: 'aborted' });
}

export function isCoachStreamError(value: unknown): value is CoachStreamError {
  return value instanceof Error && typeof (value as { code?: unknown }).code === 'string';
}

function isAbortLike(value: unknown): boolean {
  if (isCoachStreamError(value) && value.code === 'aborted') return true;
  return value instanceof Error && value.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function networkFailure(error: unknown): CoachStreamError {
  const detail = error instanceof Error && error.message ? error.message : 'network request failed';
  return coachError(detail, { code: 'network' });
}

/** Map an HTTP status plus its JSON body onto the codes the screen branches on. */
function httpFailure(status: number, body: Record<string, unknown> | null): CoachStreamError {
  const serverMessage = typeof body?.error === 'string' && body.error ? body.error : '';
  const serverCode = typeof body?.code === 'string' && body.code ? body.code : '';
  const limit = typeof body?.limit === 'number' && Number.isFinite(body.limit) ? body.limit : undefined;

  if (status === 401) {
    return coachError(serverMessage || 'not signed in', {
      code: 'unauthorized',
      status,
      ...(body ? { data: body } : {}),
    });
  }
  if (status === 404 || status === 503) {
    return coachError(serverMessage || 'the streaming Coach is not available on this server', {
      code: 'genui_unavailable',
      status,
      fallback: true,
      ...(body ? { data: body } : {}),
    });
  }
  if (status === 429) {
    return coachError(serverMessage || 'this conversation has reached its turn limit', {
      code: serverCode || 'turn_limit',
      status,
      ...(limit !== undefined ? { limit } : {}),
      ...(body ? { data: body } : {}),
    });
  }
  return coachError(serverMessage || `HTTP ${status}`, {
    code: serverCode || 'http',
    status,
    ...(body ? { data: body } : {}),
  });
}

async function responseFailure(response: CoachFetchResponse): Promise<CoachStreamError> {
  let raw = '';
  try {
    raw = await response.text();
  } catch {
    raw = '';
  }
  return httpFailure(response.status, parseJsonObject(raw));
}

/* -------------------------------- SSE parser -------------------------------- */

export interface SseFrameParser {
  /** Feed decoded text; complete frames are dispatched immediately. */
  push(chunk: string): void;
  /** Dispatch whatever is left when the stream ends without a trailing blank line. */
  flush(): void;
}

function dispatchFrame(frame: string, onEvent: (event: CoachStreamEvent) => void): void {
  if (!frame) return;
  const dataLines: string[] = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    // Blank separators and `: ...` heartbeats/comments carry no payload.
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue; // event:/id:/retry: are not part of this protocol
    const value = line.slice('data:'.length);
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  if (!dataLines.length) return;
  const payload = dataLines.join('\n');
  if (!payload.trim()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return; // a broken frame must not kill a live stream
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') return;
  onEvent({ ...parsed, type: parsed.type });
}

/**
 * A pure, transport-agnostic SSE frame parser.
 *
 * - CRLF is folded into LF as chunks arrive, so a `\r\n` pair split across two chunks still
 *   becomes one delimiter once the second half lands.
 * - Both `\n\n` and `\r\n\r\n` close a frame; sticky frames in one chunk all dispatch, and a
 *   partial frame stays buffered until the rest arrives.
 * - Heartbeat lines (`: ping`) and non-JSON data are ignored.
 * - Multi-byte UTF-8 splitting is the transport's job: decode bytes with
 *   `TextDecoder({ stream: true })` and only then call `push`.
 */
export function createSseFrameParser(onEvent: (event: CoachStreamEvent) => void): SseFrameParser {
  let buffer = '';
  return {
    push(chunk: string): void {
      if (!chunk) return;
      buffer += chunk;
      // A trailing lone CR is kept: the next chunk may start with LF and form a CRLF pair.
      buffer = buffer.replace(/\r\n/g, '\n');
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        dispatchFrame(frame, onEvent);
      }
    },
    flush(): void {
      const frame = buffer;
      buffer = '';
      dispatchFrame(frame.replace(/\n+$/, ''), onEvent);
    },
  };
}

/* ------------------------------- transports -------------------------------- */

const expoFetchImpl = expoFetch as unknown as CoachFetch;

function baseUrl(server: string): string {
  return String(server || '').replace(/\/+$/, '');
}

function requestHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
}

function buildStreamBody(options: StreamCoachOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    text: typeof options.text === 'string' ? options.text : '',
  };
  if (options.formSubmission) body.formSubmission = options.formSubmission;
  if (options.plan !== undefined) body.plan = options.plan;
  if (options.history && options.history.length) body.history = options.history;
  if (options.lang) body.lang = options.lang;
  if (options.today) body.today = options.today;
  return body;
}

function createDefaultXhr(): CoachXhr | null {
  const Ctor = (globalThis as { XMLHttpRequest?: new () => unknown }).XMLHttpRequest;
  if (!Ctor) return null;
  return new Ctor() as CoachXhr;
}

/** Drive the parser from a byte reader, flushing a split multi-byte tail at the end. */
async function consumeBytes(
  reader: CoachByteReader,
  parser: SseFrameParser,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  const onAbort = (): void => {
    // Cancel unties a pending read so the loop can observe `signal.aborted` and throw.
    reader.cancel?.().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.flush();
    if (signal?.aborted) throw abortError();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Android/Hermes fallback: XHR fires `onprogress` as bytes land, so slicing `responseText`
 * from the last consumed offset gives the same incremental stream without a body reader.
 */
function streamWithXhr(
  url: string,
  body: string,
  options: StreamCoachOptions,
  parser: SseFrameParser,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const create = options.transport?.createXhr ?? createDefaultXhr;
    const signal = options.signal;
    let xhr: CoachXhr | null = null;
    try {
      xhr = create();
    } catch {
      xhr = null;
    }
    if (!xhr) {
      reject(coachError('streaming is not available on this device', {
        code: 'genui_unavailable',
        fallback: true,
      }));
      return;
    }

    const transport = xhr;
    let offset = 0;
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: CoachStreamError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const pump = (): void => {
      const text = transport.responseText || '';
      if (text.length <= offset) return;
      const chunk = text.slice(offset);
      offset = text.length;
      parser.push(chunk);
    };
    const onAbort = (): void => {
      try {
        transport.abort();
      } catch {
        /* already closed */
      }
      finish(abortError());
    };

    transport.onprogress = () => {
      if (settled) return;
      if (transport.status >= 200 && transport.status < 300) pump();
    };
    transport.onload = () => {
      if (settled) return;
      if (transport.status < 200 || transport.status >= 300) {
        finish(httpFailure(transport.status, parseJsonObject(transport.responseText || '')));
        return;
      }
      try {
        pump();
        parser.flush();
        finish();
      } catch (error) {
        finish(isCoachStreamError(error) ? error : networkFailure(error));
      }
    };
    transport.onerror = () => finish(networkFailure(null));
    transport.onabort = () => finish(abortError());

    if (signal?.aborted) {
      finish(abortError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      transport.open('POST', url);
      for (const [name, value] of Object.entries(requestHeaders(options.connection.token))) {
        transport.setRequestHeader(name, value);
      }
      transport.send(body);
    } catch (error) {
      finish(networkFailure(error));
    }
  });
}

/* ------------------------------- collection -------------------------------- */

interface EventCollector {
  receive: (event: CoachStreamEvent) => void;
  result: () => CoachStreamResult;
}

function createCollector(onEvent: (event: CoachStreamEvent) => void): EventCollector {
  let count = 0;
  let finished: CoachStreamEvent | null = null;
  let failure: CoachStreamEvent | null = null;
  return {
    receive(event: CoachStreamEvent): void {
      count += 1;
      if (event.type === 'RUN_FINISHED') finished = event;
      else if (event.type === 'RUN_ERROR') failure = event;
      onEvent(event);
    },
    result(): CoachStreamResult {
      if (failure) {
        throw coachError(failure.message || 'the coach run failed', {
          code: failure.code || 'run_error',
        });
      }
      if (count === 0) {
        throw coachError('the server opened a stream but sent no AG-UI events', {
          code: 'genui_unavailable',
          fallback: true,
        });
      }
      const nodes = finished && Array.isArray(finished.nodes) ? finished.nodes : null;
      const blocks = finished && Array.isArray(finished.blocks) ? finished.blocks : [];
      return {
        ...(finished?.runId ? { runId: finished.runId } : {}),
        ...(finished?.threadId ? { threadId: finished.threadId } : {}),
        text: typeof finished?.text === 'string' ? finished.text : '',
        nodes,
        blocks,
        eventCount: count,
      };
    },
  };
}

/**
 * POST one Coach turn and feed every parsed AG-UI event to `onEvent`.
 *
 * Resolves with the RUN_FINISHED payload once the stream closes. Rejects with a
 * `CoachStreamError`: `turn_limit` (429), `genui_unavailable` (404/503 or a body without a
 * reader), `unauthorized` (401), `aborted` or `network`.
 */
export async function streamCoachGenUI(options: StreamCoachOptions): Promise<CoachStreamResult> {
  if (options.signal?.aborted) throw abortError();

  const url = `${baseUrl(options.connection.server)}${COACH_STREAM_PATH}`;
  const body = JSON.stringify(buildStreamBody(options));
  const fetchImpl = options.transport?.fetch ?? expoFetchImpl;
  const collector = createCollector(options.onEvent);
  const parser = createSseFrameParser(collector.receive);

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: requestHeaders(options.connection.token),
      body,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await responseFailure(response);
    const reader = response.body?.getReader?.();
    if (reader) {
      await consumeBytes(reader, parser, options.signal);
    } else {
      // Expo/Hermes handed back a body without a byte reader: re-request over XHR, whose
      // onprogress slicing yields the same frames incrementally.
      await streamWithXhr(url, body, options, parser);
    }
  } catch (error) {
    if (isAbortLike(error) || options.signal?.aborted) throw abortError();
    if (isCoachStreamError(error)) throw error;
    throw networkFailure(error);
  }

  return collector.result();
}

/** Read `GET /api/config` with the paired Bearer token to gate the Coach entry point. */
export async function fetchCoachConfig(
  connection: CoachStreamConnection,
  options: { signal?: AbortSignal; transport?: CoachStreamTransport } = {},
): Promise<CoachConfigSnapshot> {
  if (options.signal?.aborted) throw abortError();
  const fetchImpl = options.transport?.fetch ?? expoFetchImpl;
  try {
    const response = await fetchImpl(`${baseUrl(connection.server)}${COACH_CONFIG_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${connection.token}`,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await responseFailure(response);
    const payload = parseJsonObject(await response.text());
    const agent = isRecord(payload?.agent) ? payload.agent : null;
    const coach = isRecord(payload?.coach) ? payload.coach : null;
    return {
      agentEnabled: agent ? agent.enabled !== false : false,
      exerciseSearchVersion: agent?.exerciseSearchVersion === 'v2' ? 'v2' : 'v1',
      coachEnabled: coach ? coach.enabled !== false : false,
    };
  } catch (error) {
    if (isAbortLike(error) || options.signal?.aborted) throw abortError();
    if (isCoachStreamError(error)) throw error;
    throw coachError('the server config could not be read', {
      code: 'config_unavailable',
      data: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
}
