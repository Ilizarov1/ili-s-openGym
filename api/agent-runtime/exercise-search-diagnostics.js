/* exercise-search diagnostics: one JSON line per stage event.
 *
 * The stage fields are fixed in docs/ai-exercise-search/
 * EVAL_CLI_EXECUTION.md (D01) and projected one by one: anything the caller
 * passes beyond a stage's declared fields is dropped, and input objects are
 * never spread into a line. Counters, times and scores only accept finite
 * numbers; public ids are shape-checked strings the upstream caller has
 * already validated against its trusted catalogue; equipment and body parts
 * are checked against the task's vocabulary snapshot. Serialization and
 * sink errors are captured here so diagnostics can never break the caller.
 *
 * Plain standard JS with zero platform imports: NestJS, the Web client (via
 * Vite) and Metro all import this file directly.
 */
import { ERROR_STATUS } from './errors.js';
import VOCABULARY from './tasks/exercise-search-vocabulary.json' with { type: 'json' };

/* `req_` + lowercase hex UUID everywhere, plus the Web fallback shape
 * `req_` + 13 epoch-ms digits + `_` + 1-8 lowercase base36 characters. */
const TRACE_ID_UUID = /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TRACE_ID_LEGACY = /^req_[0-9]{13}_[0-9a-z]{1,8}$/;

/** Ids (media attempts, public catalogue entries) get a shape check only. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_MIME = /^image\/[a-z0-9.+-]{1,31}$/;

const SOURCES = new Set(['web', 'rn', 'api', 'rn-local']);
const EXECUTIONS = new Set(['server', 'local']);
const MEDIA_STATUSES = new Set(['ready', 'failed', 'cancelled']);
const MODEL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const END_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const END_PHASES = new Set(['submit', 'attachments', 'model', 'recognition', 'match', 'poll']);
const QUERY_ORIGINS = new Set(['primary', 'english']);
const FILTER_DECISIONS = new Set([
  'invalid_candidate',
  'no_hit',
  'cjk_ambiguous',
  'no_name_evidence',
  'below_floor',
  'equipment_conflict',
  'body_part_conflict',
  'accepted',
  'accepted_cjk_fallback',
  'deduplicated',
]);

/* The same slug snapshot the task validates against, imported directly so
 * this module never pulls the whole task in. */
const BODY_PARTS = new Set(VOCABULARY.bodyParts);
const EQUIPMENT = new Set(VOCABULARY.equipment);

const MAX_IMAGES = 2;
const MAX_RESULT_IDS = 5;
const MAX_RECALL_TOP = 5;

/* Agent error codes plus the two client-side media codes; everything else
 * logs as `unknown`. */
const SAFE_ERROR_CODES = new Set([...Object.keys(ERROR_STATUS), 'permission_denied', 'asset_missing']);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanOf(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function idOf(value) {
  return typeof value === 'string' && SAFE_ID.test(value) ? value : undefined;
}

function enumOf(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : undefined;
}

/** Whitelist, dedupe and keep order; anything else is dropped. */
function slugsOf(values, allowed) {
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || !allowed.has(value) || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/** Record a validated field; `undefined` means "not recorded". */
function put(out, key, value) {
  if (value !== undefined) out[key] = value;
}

function projectSubmit(event) {
  const out = {};
  put(out, 'execution', enumOf(event.execution, EXECUTIONS));
  put(out, 'hasHint', booleanOf(event.hasHint));
  put(out, 'imageCount', finiteNumber(event.imageCount));
  put(out, 'mediaAttemptId', idOf(event.mediaAttemptId));
  return out;
}

function projectAttachments(event) {
  if (!Array.isArray(event.images)) return {};
  const images = [];
  for (const item of event.images.slice(0, MAX_IMAGES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const projected = {};
    put(projected, 'mime', typeof item.mime === 'string' && IMAGE_MIME.test(item.mime) ? item.mime : undefined);
    put(projected, 'width', finiteNumber(item.width));
    put(projected, 'height', finiteNumber(item.height));
    put(projected, 'bytes', finiteNumber(item.bytes));
    if (Object.keys(projected).length) images.push(projected);
  }
  return images.length ? { images } : {};
}

function projectModel(event) {
  const out = {};
  put(out, 'round', finiteNumber(event.round));
  const status = enumOf(event.status, MODEL_STATUSES);
  put(out, 'status', status);
  put(out, 'elapsedMs', finiteNumber(event.elapsedMs));
  put(out, 'toolCalls', finiteNumber(event.toolCalls));
  if (status === 'failed') put(out, 'errorCode', safeExerciseSearchError(event.errorCode));
  return out;
}

function projectRecognition(event) {
  const out = {};
  put(out, 'rawCandidateCount', finiteNumber(event.rawCandidateCount));
  put(out, 'cleanCandidateCount', finiteNumber(event.cleanCandidateCount));
  if (Array.isArray(event.equipment)) out.equipment = slugsOf(event.equipment, EQUIPMENT);
  if (Array.isArray(event.bodyParts)) out.bodyParts = slugsOf(event.bodyParts, BODY_PARTS);
  return out;
}

/** A ranked slice of the actual first five; gaps are never re-picked. */
function topOf(value) {
  const top = [];
  for (const item of value.slice(0, MAX_RECALL_TOP)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = idOf(item.id);
    if (id === undefined) continue;
    const projected = { id };
    put(projected, 'score', finiteNumber(item.score));
    top.push(projected);
  }
  return top;
}

function projectRecall(event) {
  const out = {};
  put(out, 'candidateIndex', finiteNumber(event.candidateIndex));
  put(out, 'queryOrigin', enumOf(event.queryOrigin, QUERY_ORIGINS));
  put(out, 'queryWordCount', finiteNumber(event.queryWordCount));
  put(out, 'hitCount', finiteNumber(event.hitCount));
  if (Array.isArray(event.top)) out.top = topOf(event.top);
  return out;
}

function projectFilter(event) {
  const out = {};
  put(out, 'candidateIndex', finiteNumber(event.candidateIndex));
  put(out, 'decision', enumOf(event.decision, FILTER_DECISIONS));
  put(out, 'id', idOf(event.id));
  return out;
}

function publicIdsOf(value) {
  const ids = [];
  for (const id of value.slice(0, MAX_RESULT_IDS)) {
    const clean = idOf(id);
    if (clean !== undefined && !ids.includes(clean)) ids.push(clean);
  }
  return ids;
}

function projectDisplay(event) {
  const out = {};
  put(out, 'resultCount', finiteNumber(event.resultCount));
  if (Array.isArray(event.publicIds)) out.publicIds = publicIdsOf(event.publicIds);
  put(out, 'customCount', finiteNumber(event.customCount));
  put(out, 'fallbackOnly', booleanOf(event.fallbackOnly));
  put(out, 'elapsedMs', finiteNumber(event.elapsedMs));
  return out;
}

function projectEnd(event) {
  const out = {};
  const status = enumOf(event.status, END_STATUSES);
  put(out, 'status', status);
  put(out, 'phase', enumOf(event.phase, END_PHASES));
  put(out, 'elapsedMs', finiteNumber(event.elapsedMs));
  if (status === 'failed') put(out, 'errorCode', safeExerciseSearchError(event.errorCode));
  return out;
}

/* Media has its own entry point (logExerciseSearchMedia) and never travels
 * through a run trace. */
const RUN_STAGES = new Map([
  ['submit', projectSubmit],
  ['attachments', projectAttachments],
  ['model', projectModel],
  ['recognition', projectRecognition],
  ['recall', projectRecall],
  ['filter', projectFilter],
  ['display', projectDisplay],
  ['end', projectEnd],
]);

/** Media metrics need a declared status; without one the event is dropped. */
function projectMedia(metrics, mediaAttemptId) {
  const source = metrics && typeof metrics === 'object' && !Array.isArray(metrics) ? metrics : {};
  const status = enumOf(source.status, MEDIA_STATUSES);
  if (status === undefined) return undefined;
  const out = { mediaAttemptId, status };
  put(out, 'inputBytes', finiteNumber(source.inputBytes));
  put(out, 'outputBytes', finiteNumber(source.outputBytes));
  put(out, 'outputWidth', finiteNumber(source.outputWidth));
  put(out, 'outputHeight', finiteNumber(source.outputHeight));
  put(out, 'attempts', finiteNumber(source.attempts));
  put(out, 'rotationApplied', booleanOf(source.rotationApplied));
  put(out, 'elapsedMs', finiteNumber(source.elapsedMs));
  if (status === 'failed') put(out, 'errorCode', safeExerciseSearchError(source.errorCode));
  return out;
}

/** Fresh independent trace id for a media event; `null` when no entropy. */
function freshMediaTraceId() {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === 'function') {
    try {
      const candidate = `req_${String(crypto.randomUUID()).toLowerCase()}`;
      if (TRACE_ID_UUID.test(candidate)) return candidate;
    } catch {
      // fall through to the Web legacy shape
    }
  }
  const legacy = `req_${Date.now()}_${Math.random().toString(36).slice(2, 10) || '0'}`;
  return TRACE_ID_LEGACY.test(legacy) ? legacy : null;
}

/** One JSON line per event; serialization and sink errors never escape. */
function writeLine(sink, envelope) {
  let line;
  try {
    line = JSON.stringify(envelope);
  } catch {
    return;
  }
  if (typeof line !== 'string') return;
  try {
    sink(line);
  } catch {
    // A broken sink must not break the feature it observes.
  }
}

function sinkOf(write) {
  return typeof write === 'function' ? write : console.info;
}

/**
 * A diagnostics trace id is a normalized request id: `req_` plus a
 * lowercase hex UUID in 8-4-4-4-12 groups, or the Web legacy fallback
 * `req_` plus exactly 13 epoch-ms digits, an underscore and 1-8 lowercase
 * base36 characters. An invalid id ignores the log event and never
 * changes request validity.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isExerciseSearchTraceId(value) {
  return typeof value === 'string' && (TRACE_ID_UUID.test(value) || TRACE_ID_LEGACY.test(value));
}

/**
 * Create the per-run diagnostics trace.
 *
 * Returns `undefined` when diagnostics are off or the trace id is not a
 * valid request id, so callers can hand the result around without
 * branching. The returned function takes one event object, projects it to
 * the fields declared for its stage and writes one JSON line. The root
 * fields are fixed: `event`, `schemaVersion`, `traceId`, `source` and
 * `stage`. The default sink is `console.info`.
 *
 * @param {{ traceId?: unknown, source?: unknown, enabled?: unknown, write?: (line: string) => void }} [options]
 * @returns {((event: unknown) => void) | undefined}
 */
export function createExerciseSearchTrace(options) {
  const { traceId, source, enabled, write } = options || {};
  if (!enabled) return undefined;
  if (!isExerciseSearchTraceId(traceId)) return undefined;
  if (typeof source !== 'string' || !SOURCES.has(source)) return undefined;
  const sink = sinkOf(write);
  return event => {
    try {
      if (!event || typeof event !== 'object' || Array.isArray(event)) return;
      const stage = typeof event.stage === 'string' ? event.stage : '';
      const project = RUN_STAGES.get(stage);
      if (!project) return;
      writeLine(sink, {
        event: 'exercise_search',
        schemaVersion: 1,
        traceId,
        source,
        stage,
        ...project(event),
      });
    } catch {
      // Diagnostics must never throw into the feature they observe.
    }
  };
}

/**
 * Reduce a failure to a code that is safe to log: the agent error codes
 * declared in errors.js plus the two client-side media codes. Everything
 * else — a made-up code, a raw message — becomes `unknown`. The input is a
 * code value, never an error object.
 *
 * @param {unknown} code
 * @returns {string}
 */
export function safeExerciseSearchError(code) {
  return typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : 'unknown';
}

/**
 * Emit one `media` stage event for an image pick.
 *
 * Picking happens before any request id exists, so the event carries its
 * own fresh trace id; the later submit event joins the two locally through
 * `mediaAttemptId`. Fields a platform cannot observe are omitted by the
 * caller, and only the declared ones are recorded here.
 *
 * @param {{ mediaAttemptId?: unknown, source?: unknown, enabled?: unknown, write?: (line: string) => void, metrics?: unknown }} [options]
 */
export function logExerciseSearchMedia(options) {
  try {
    const { mediaAttemptId, source, enabled, write, metrics } = options || {};
    if (!enabled) return;
    if (typeof source !== 'string' || !SOURCES.has(source)) return;
    if (typeof mediaAttemptId !== 'string' || !SAFE_ID.test(mediaAttemptId)) return;
    const fields = projectMedia(metrics, mediaAttemptId);
    if (!fields) return;
    const traceId = freshMediaTraceId();
    if (!traceId) return;
    writeLine(sinkOf(write), {
      event: 'exercise_search',
      schemaVersion: 1,
      traceId,
      source,
      stage: 'media',
      ...fields,
    });
  } catch {
    // Diagnostics must never throw into the feature they observe.
  }
}
