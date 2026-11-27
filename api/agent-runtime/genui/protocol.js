/* Shared Generative-UI protocol core.
 *
 * The same file is bundled by Metro for the phone, imported by the NestJS
 * server and imported by the web client, so it is plain ES module JavaScript
 * with no platform import, no Node built-in and no third-party dependency.
 *
 * Two layers live here:
 *   1. AG-UI compatible SSE framing (formatSseEvent / parseSseChunk).
 *   2. The flat, closed domain catalogue (v2: 5 atomic primitives + 5 core
 *      blocks + fallback_notice) and its validator/sanitizer. The model only
 *      chooses parameters and real catalogue exercise ids; every chart value
 *      is hydrated on the client.
 */

export const GENUI_PROTOCOL_VERSION = 2;

/** One response never carries more than six flat blocks (v1 compatibility). */
export const MAX_GENUI_BLOCKS = 6;

/** Hard ceiling on the flat node list of one answer, prose included (safety cap). */
export const MAX_GENUI_NODES = 12;

/** Default budget for the heavy visual nodes of one answer (v1 back-compat). */
export const DEFAULT_MAX_VISUAL_NODES = 1;

/** Upper bound for a caller-supplied heavy-visual budget. */
export const MAX_VISUAL_NODES_LIMIT = 4;

/** Maximum number of user turns kept in one coach conversation. */
export const MAX_COACH_GENUI_TURNS = 10;

/** Custom AG-UI event names used by the coach stream. */
export const GENUI_CUSTOM_EVENTS = Object.freeze({
  BLOCK_UPSERT: 'genui.block_upsert', // v1 compatibility
  PROSE_DELTA: 'genui.prose_delta',
  NODE_PENDING: 'genui.node_pending',
  NODE_COMMIT: 'genui.node_commit',
  NODE_DROP: 'genui.node_drop',
});

/** AG-UI event names used on the coach stream, frozen so no host can mutate them. */
export const AGUI_EVENT_TYPES = Object.freeze({
  RUN_STARTED: 'RUN_STARTED',
  STEP_STARTED: 'STEP_STARTED',
  STEP_FINISHED: 'STEP_FINISHED',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_RESULT: 'TOOL_CALL_RESULT',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  CUSTOM: 'CUSTOM',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
});

/** The closed block catalogue. Adding a member is a deliberate cross-client change. */
export const GENUI_BLOCK_TYPES = Object.freeze({
  EXERCISE_TREND: 'exercise_trend',
  MUSCLE_LOAD: 'muscle_load',
  EXERCISE_ALTERNATIVES: 'exercise_alternatives',
  QUICK_FORM: 'quick_form',
  PROPOSAL_ACTION: 'proposal_action',
  FALLBACK_NOTICE: 'fallback_notice',
});

/** The closed node catalogue: 5 atomic primitives + 5 core blocks + notice. */
export const GENUI_NODE_TYPES = Object.freeze({
  PROSE: 'prose',
  KPI_STRIP: 'kpi_strip',
  COMPARISON_TABLE: 'comparison_table',
  CHECKLIST: 'checklist',
  CALLOUT: 'callout',
  EXERCISE_TREND: 'exercise_trend',
  MUSCLE_LOAD: 'muscle_load',
  EXERCISE_ALTERNATIVES: 'exercise_alternatives',
  QUICK_FORM: 'quick_form',
  PROPOSAL_ACTION: 'proposal_action',
  FALLBACK_NOTICE: 'fallback_notice',
});

/** Node types that draw a chart and therefore consume the visual budget. */
export const GENUI_HEAVY_VISUAL_TYPES = Object.freeze([
  GENUI_NODE_TYPES.EXERCISE_TREND,
  GENUI_NODE_TYPES.MUSCLE_LOAD,
]);

export const GENUI_FALLBACK_TEXT = 'This insight is unavailable right now.';

const BLOCK_TYPE_VALUES = new Set(Object.values(GENUI_BLOCK_TYPES));
const NODE_TYPE_VALUES = new Set(Object.values(GENUI_NODE_TYPES));
const HEAVY_VISUAL_VALUES = new Set(GENUI_HEAVY_VISUAL_TYPES);
const PROSE_TONES = ['normal', 'lead', 'closing'];
const CALLOUT_VARIANTS = ['info', 'tip', 'warning'];
const KPI_KINDS = ['exercise_stat', 'muscle_sets', 'session_count', 'prescription'];
const PROSE_MAX_CHARS = 280;
const KPI_MAX_ITEMS = 4;
const TABLE_MAX_COLUMNS = 4;
const TABLE_MAX_ROWS = 6;
const CHECKLIST_MAX_ITEMS = 6;
const TREND_METRICS = ['e1rm', 'weight', 'volume'];
const LOAD_WINDOWS = ['72h', '7d', '28d'];
const FIELD_KINDS = ['single_choice', 'multi_choice', 'scale'];

const MAX_TITLE = 80;
const MAX_CAPTION = 200;
const MAX_REASON = 200;
const MAX_NOTICE = 300;
const MAX_LABEL = 80;
const MAX_OPTION_LABEL = 60;

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const BLOCK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const TARGET_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

const isObj = value => !!value && typeof value === 'object' && !Array.isArray(value);

const textOf = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const tokenOf = value => {
  if (typeof value !== 'string') return '';
  const clean = value.trim();
  return TOKEN_RE.test(clean) ? clean : '';
};

const blockIdOf = value => {
  if (typeof value !== 'string') return '';
  const clean = value.trim();
  return BLOCK_ID_RE.test(clean) ? clean : '';
};

const clampInt = (value, low, high, fallback) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(high, Math.max(low, Math.round(value)));
};

const asIdSet = value => {
  if (value instanceof Set) {
    const out = new Set();
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) out.add(item.trim());
    }
    return out;
  }
  if (Array.isArray(value)) {
    const out = new Set();
    for (const item of value) {
      if (typeof item === 'string' && item.trim()) out.add(item.trim());
    }
    return out;
  }
  return null;
};

const fail = reason => ({ ok: false, reason });

/* ------------------------------ SSE framing ------------------------------ */

/** One SSE frame carrying a JSON event, exactly as the wire expects it. */
export function formatSseEvent(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Parse every complete SSE frame in a chunk, keeping the unfinished tail.
 *
 * Accepts LF or CRLF frame separators, heartbeats (`: ping`) and partial lines
 * split across network chunks: feed the returned `rest` back in with the next
 * chunk. Non-JSON data frames are skipped rather than thrown, because a broken
 * frame must not kill a live coach stream.
 *
 * @param {string} buffer
 * @returns {{ events: object[], rest: string }}
 */
export function parseSseChunk(buffer) {
  const source = typeof buffer === 'string' ? buffer : buffer == null ? '' : String(buffer);
  if (!source) return { events: [], rest: '' };
  // A CRLF separator becomes LF; a lone CR at the end is kept so a CRLF pair
  // split across two chunks is still recognised once the second chunk lands.
  const normalized = source.replace(/\r\n/g, '\n');
  const events = [];
  let cursor = 0;
  for (;;) {
    const boundary = normalized.indexOf('\n\n', cursor);
    if (boundary < 0) break;
    const frame = normalized.slice(cursor, boundary);
    cursor = boundary + 2;
    const event = eventFromFrame(frame);
    if (event) events.push(event);
  }
  return { events, rest: normalized.slice(cursor) };
}

function eventFromFrame(frame) {
  if (!frame) return null;
  const dataLines = [];
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue; // heartbeat or comment
    if (!line.startsWith('data:')) continue; // id/event/retry fields are not needed here
    const value = line.slice(5);
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  if (!dataLines.length) return null;
  try {
    const parsed = JSON.parse(dataLines.join('\n'));
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ---------------------------- block validation --------------------------- */

/**
 * Validate and sanitize one candidate block.
 *
 * The output is a fresh object holding only known fields with clamped ranges,
 * so a caller can persist it without re-checking. Chart series are never part
 * of a block; only the parameters the client hydrates from local history.
 *
 * @param {unknown} block
 * @param {{ validExIds?: Set<string> | string[], validMuscles?: Set<string> | string[] }} [options]
 * @returns {{ ok: true, block: object } | { ok: false, reason: string }}
 */
export function validateGenUIBlock(block, options = {}) {
  if (!isObj(block)) return fail('block must be an object');
  const type = typeof block.type === 'string' ? block.type : '';
  if (!BLOCK_TYPE_VALUES.has(type)) return fail('unknown block type');
  const id = blockIdOf(block.id) || `blk_${type}`;
  const validExIds = asIdSet(options?.validExIds);
  const validMuscles = asIdSet(options?.validMuscles);

  switch (type) {
    case GENUI_BLOCK_TYPES.EXERCISE_TREND:
      return validateExerciseTrend(block, id, validExIds);
    case GENUI_BLOCK_TYPES.MUSCLE_LOAD:
      return validateMuscleLoad(block, id, validMuscles);
    case GENUI_BLOCK_TYPES.EXERCISE_ALTERNATIVES:
      return validateAlternatives(block, id, validExIds);
    case GENUI_BLOCK_TYPES.QUICK_FORM:
      return validateQuickForm(block, id);
    case GENUI_BLOCK_TYPES.PROPOSAL_ACTION:
      return validateProposalAction(block, id);
    case GENUI_BLOCK_TYPES.FALLBACK_NOTICE:
      return validateFallbackNotice(block, id);
    default:
      return fail('unknown block type');
  }
}

function attachCopy(block, fields) {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) block[key] = value;
  }
  return block;
}

function validateExerciseTrend(raw, id, validExIds) {
  const exId = tokenOf(raw.exId);
  if (!exId) return fail('exercise_trend needs an exId');
  if (validExIds && !validExIds.has(exId)) return fail(`unknown exercise id ${exId}`);
  const metric = TREND_METRICS.includes(raw.metric) ? raw.metric : 'e1rm';
  const weeks = clampInt(raw.weeks, 4, 24, 8);
  return {
    ok: true,
    block: attachCopy({ id, type: GENUI_BLOCK_TYPES.EXERCISE_TREND, exId, metric, weeks }, {
      title: textOf(raw.title, MAX_TITLE) || undefined,
      caption: textOf(raw.caption, MAX_CAPTION) || undefined,
      highlightStall: typeof raw.highlightStall === 'boolean' ? raw.highlightStall : undefined,
    }),
  };
}

function validateMuscleLoad(raw, id, validMuscles) {
  const window = LOAD_WINDOWS.includes(raw.window) ? raw.window : '72h';
  const requested = Array.isArray(raw.focusMuscles) ? raw.focusMuscles : [];
  const seen = new Set();
  const focusMuscles = [];
  for (const value of requested) {
    const muscle = typeof value === 'string' ? value.trim() : '';
    if (!muscle || seen.has(muscle)) continue;
    if (validMuscles && !validMuscles.has(muscle)) continue;
    seen.add(muscle);
    focusMuscles.push(muscle);
    if (focusMuscles.length >= 6) break;
  }
  return {
    ok: true,
    block: attachCopy({ id, type: GENUI_BLOCK_TYPES.MUSCLE_LOAD, window, focusMuscles }, {
      title: textOf(raw.title, MAX_TITLE) || undefined,
      caption: textOf(raw.caption, MAX_CAPTION) || undefined,
    }),
  };
}

function validateAlternatives(raw, id, validExIds) {
  const requested = Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set();
  const items = [];
  for (const candidate of requested) {
    if (!isObj(candidate)) continue;
    const exId = tokenOf(candidate.exId);
    if (!exId || seen.has(exId)) continue;
    if (validExIds && !validExIds.has(exId)) continue;
    seen.add(exId);
    const item = { exId, reason: textOf(candidate.reason, MAX_REASON) };
    const tag = textOf(candidate.tag, 40);
    if (tag) item.tag = tag;
    const routineId = blockIdOf(candidate.routineId);
    if (routineId) item.routineId = routineId;
    items.push(item);
    if (items.length >= 5) break;
  }
  if (!items.length) return fail('exercise_alternatives needs at least one valid item');

  const block = { id, type: GENUI_BLOCK_TYPES.EXERCISE_ALTERNATIVES, items };
  const forExId = tokenOf(raw.forExId);
  if (forExId && (!validExIds || validExIds.has(forExId))) block.forExId = forExId;
  const routineId = blockIdOf(raw.routineId);
  if (routineId) block.routineId = routineId;
  const title = textOf(raw.title, MAX_TITLE);
  if (title) block.title = title;
  return { ok: true, block };
}

function validateField(raw) {
  if (!isObj(raw)) return null;
  const name = typeof raw.name === 'string' && FIELD_NAME_RE.test(raw.name.trim()) ? raw.name.trim() : '';
  if (!name) return null;
  const label = textOf(raw.label, MAX_LABEL);
  if (!label) return null;
  const kind = FIELD_KINDS.includes(raw.kind) ? raw.kind : '';
  if (!kind) return null;

  const field = { name, label, kind };
  if (kind === 'scale') {
    let min = clampInt(raw.min, 1, 10, 1);
    let max = clampInt(raw.max, 1, 10, 10);
    if (max < min) [min, max] = [max, min];
    field.min = min;
    field.max = max;
    const unit = textOf(raw.unit, 16);
    if (unit) field.unit = unit;
    return field;
  }

  const requested = Array.isArray(raw.options) ? raw.options : [];
  const seen = new Set();
  const options = [];
  for (const candidate of requested) {
    if (!isObj(candidate)) continue;
    const value = textOf(candidate.value, 40);
    const optionLabel = textOf(candidate.label, MAX_OPTION_LABEL);
    if (!value || !optionLabel || seen.has(value)) continue;
    seen.add(value);
    options.push({ value, label: optionLabel });
    if (options.length >= 8) break;
  }
  if (!options.length) return null;
  field.options = options;
  return field;
}

function validateQuickForm(raw, id) {
  const formId = blockIdOf(raw.formId);
  if (!formId) return fail('quick_form needs a formId');
  const title = textOf(raw.title, MAX_TITLE);
  if (!title) return fail('quick_form needs a title');
  const requested = Array.isArray(raw.fields) ? raw.fields : [];
  const fields = [];
  for (const candidate of requested) {
    const field = validateField(candidate);
    if (!field) continue;
    fields.push(field);
    if (fields.length >= 5) break;
  }
  if (!fields.length) return fail('quick_form needs at least one valid field');
  return {
    ok: true,
    block: attachCopy({ id, type: GENUI_BLOCK_TYPES.QUICK_FORM, formId, title, fields }, {
      submitLabel: textOf(raw.submitLabel, 40) || undefined,
    }),
  };
}

function cleanTarget(raw) {
  if (!isObj(raw)) return null;
  const target = {};
  let keys = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!TARGET_KEY_RE.test(key)) continue;
    if (typeof value === 'string') {
      const clean = value.trim().slice(0, 120);
      if (clean) {
        target[key] = clean;
        keys++;
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      target[key] = value;
      keys++;
    } else if (typeof value === 'boolean') {
      target[key] = value;
      keys++;
    }
    if (keys >= 12) break;
  }
  return keys ? target : null;
}

function cleanChangeValue(raw) {
  if (typeof raw === 'string') {
    const clean = raw.trim().slice(0, 200);
    return clean || undefined;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) {
    const arr = [];
    for (const item of raw) {
      if (typeof item === 'string') {
        const clean = item.trim().slice(0, 120);
        if (clean) arr.push(clean);
      }
      if (arr.length >= 20) break;
    }
    return arr.length ? arr : undefined;
  }
  if (!isObj(raw)) return undefined;
  const out = {};
  let keys = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (!TARGET_KEY_RE.test(key)) continue;
    if (typeof value === 'string') {
      const clean = value.trim().slice(0, 200);
      if (!clean) continue;
      out[key] = clean;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      continue;
    }
    keys++;
    if (keys >= 12) break;
  }
  return keys ? out : undefined;
}

const intIn = (value, low, high) => (Number.isInteger(value) && value >= low && value <= high ? value : undefined);
const finiteAbove = (value, min) => (typeof value === 'number' && Number.isFinite(value) && value > min ? value : undefined);

const CHANGE_MODES = ['reps', 'time', 'cardio'];

/** A brand-new routine is the one change whose `after` is a whole structure, not a scalar. */
function cleanAddRoutineAfter(raw) {
  if (!isObj(raw)) return undefined;
  const name = textOf(raw.name, 40);
  if (!name) return undefined;
  const after = { name };

  const emoji = textOf(raw.emoji, 16);
  if (emoji) after.emoji = emoji;
  const prog = textOf(raw.prog, 32);
  if (prog) after.prog = prog;

  if (Array.isArray(raw.weekdays)) {
    const seen = new Set();
    const weekdays = [];
    for (const value of raw.weekdays) {
      if (!Number.isInteger(value) || value < 0 || value > 6 || seen.has(value)) continue;
      seen.add(value);
      weekdays.push(value);
      if (weekdays.length >= 7) break;
    }
    if (weekdays.length) after.weekdays = weekdays;
  }

  const requested = Array.isArray(raw.ex) ? raw.ex : [];
  const ex = [];
  for (const item of requested) {
    if (!isObj(item)) continue;
    const id = textOf(item.id, 40) || textOf(item.exId, 40);
    if (!id) continue;
    const clean = { id };
    const exName = textOf(item.name, 80);
    if (exName) clean.name = exName;
    const sets = intIn(item.sets, 1, 10);
    if (sets !== undefined) clean.sets = sets;
    if (CHANGE_MODES.includes(item.mode)) clean.mode = item.mode;
    const reps = intIn(item.reps, 1, 100);
    if (reps !== undefined) clean.reps = reps;
    const repsMin = intIn(item.repsMin, 1, 100);
    if (repsMin !== undefined) clean.repsMin = repsMin;
    const repsMax = intIn(item.repsMax, 1, 100);
    if (repsMax !== undefined) clean.repsMax = repsMax;
    const setsMax = intIn(item.setsMax, 1, 10);
    if (setsMax !== undefined) clean.setsMax = setsMax;
    const sec = intIn(item.sec, 5, 3600);
    if (sec !== undefined) clean.sec = sec;
    const min = intIn(item.min, 1, 600);
    if (min !== undefined) clean.min = min;
    const speed = finiteAbove(item.speed, 0);
    if (speed !== undefined) clean.speed = speed;
    const exProg = textOf(item.prog, 32);
    if (exProg) clean.prog = exProg;
    const inc = finiteAbove(item.inc, 0);
    if (inc !== undefined) clean.inc = inc;
    if (typeof item.bodyweight === 'boolean') clean.bodyweight = item.bodyweight;
    if (typeof item.side === 'boolean') clean.side = item.side;
    ex.push(clean);
    if (ex.length >= 16) break;
  }
  if (!ex.length) return undefined;
  after.ex = ex;
  return after;
}

function validateChange(raw) {
  if (!isObj(raw)) return null;
  const id = blockIdOf(raw.id);
  if (!id) return null;
  const type = tokenOf(raw.type);
  if (!type) return null;
  // Creating a routine or a programme has no existing object to target, so an omitted target
  // is legitimate there; every other change must name one.
  const structural = type === 'add-routine' || type === 'programme';
  let target = cleanTarget(raw.target);
  if (!target) {
    if (!structural) return null;
    target = {};
  }
  const why = textOf(raw.why, MAX_NOTICE);
  if (!why) return null;
  const change = { id, type, target, why };
  const before = cleanChangeValue(raw.before);
  if (before !== undefined) change.before = before;
  if (type === 'add-routine') {
    const after = cleanAddRoutineAfter(raw.after);
    if (after === undefined) return null;
    change.after = after;
  } else {
    const after = cleanChangeValue(raw.after);
    if (after !== undefined) change.after = after;
  }
  return change;
}

function validateProposalAction(raw, id) {
  const title = textOf(raw.title, MAX_TITLE);
  if (!title) return fail('proposal_action needs a title');
  const summary = textOf(raw.summary, MAX_NOTICE);
  if (!summary) return fail('proposal_action needs a summary');
  const requested = Array.isArray(raw.changes) ? raw.changes : [];
  const changes = [];
  for (const candidate of requested) {
    const change = validateChange(candidate);
    if (!change) continue;
    changes.push(change);
    if (changes.length >= 6) break;
  }
  if (!changes.length) return fail('proposal_action needs at least one valid change');
  const block = { id, type: GENUI_BLOCK_TYPES.PROPOSAL_ACTION, title, summary, changes };
  const planHash = textOf(raw.planHash, 64);
  if (planHash) block.planHash = planHash;
  const routineId = blockIdOf(raw.routineId);
  if (routineId) block.routineId = routineId;
  return { ok: true, block };
}

function validateFallbackNotice(raw, id) {
  const text = textOf(raw.text, MAX_NOTICE);
  if (!text) return fail('fallback_notice needs text');
  return { ok: true, block: { id, type: GENUI_BLOCK_TYPES.FALLBACK_NOTICE, text } };
}

/* ------------------------------- sanitizer ------------------------------- */

const isEmptyBlock = value => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (isObj(value)) return Object.keys(value).length === 0;
  return false;
};

/**
 * Turn whatever a model produced into a safe, flat list of blocks.
 *
 * Never throws. Unknown types, hallucinated exercise ids, malformed fields and
 * over-long lists are capped, dropped or degraded to one concise notice so the
 * rest of the answer still renders.
 *
 * @param {unknown} blocks
 * @param {{ validExIds?: Set<string> | string[], validMuscles?: Set<string> | string[] }} [options]
 * @returns {{ blocks: object[], warnings: string[] }}
 */
export function sanitizeGenUIBlocks(blocks, options = {}) {
  const warnings = [];
  let list;
  if (Array.isArray(blocks)) {
    list = blocks;
  } else if (blocks == null) {
    list = [];
  } else if (isObj(blocks)) {
    list = [blocks];
    warnings.push('blocks was not an array');
  } else {
    list = [];
    warnings.push('blocks was not an array');
  }

  if (list.length > MAX_GENUI_BLOCKS) {
    warnings.push(`blocks capped at ${MAX_GENUI_BLOCKS}`);
    list = list.slice(0, MAX_GENUI_BLOCKS);
  }

  const result = [];
  const usedIds = new Set();
  let fallbackUsed = false;

  const claimId = (candidate, index) => {
    if (!usedIds.has(candidate)) return candidate;
    let next = `blk_${index + 1}`;
    let suffix = 1;
    while (usedIds.has(next)) next = `blk_${index + 1}_${++suffix}`;
    return next;
  };

  list.forEach((raw, index) => {
    let verdict;
    try {
      verdict = validateGenUIBlock(raw, options);
    } catch {
      verdict = { ok: false, reason: 'block could not be validated' };
    }

    if (verdict.ok) {
      const id = claimId(verdict.block.id, index);
      usedIds.add(id);
      result.push(id === verdict.block.id ? verdict.block : { ...verdict.block, id });
      return;
    }

    if (isEmptyBlock(raw)) return;

    const type = isObj(raw) && typeof raw.type === 'string' ? raw.type.trim().slice(0, 40) : 'unknown';
    const detail = `block ${index + 1} (${type}) dropped: ${verdict.reason}`;
    if (fallbackUsed) {
      warnings.push(detail);
      return;
    }
    fallbackUsed = true;
    const id = claimId(`blk_fallback_${index + 1}`, index);
    usedIds.add(id);
    result.push({ id, type: GENUI_BLOCK_TYPES.FALLBACK_NOTICE, text: GENUI_FALLBACK_TEXT });
    warnings.push(detail);
  });

  return { blocks: result, warnings };
}

/* ----------------------------- node validation ---------------------------- */

const kpiItemOf = (raw, validExIds, validMuscles) => {
  if (!isObj(raw)) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  if (!KPI_KINDS.includes(kind)) return null;

  if (kind === 'exercise_stat') {
    const exId = tokenOf(raw.exId);
    if (!exId) return null;
    if (validExIds && !validExIds.has(exId)) return null;
    // A model-written `value` is never carried through: the client hydrates it.
    const item = {
      kind,
      exId,
      metric: TREND_METRICS.includes(raw.metric) ? raw.metric : 'e1rm',
      weeks: clampInt(raw.weeks, 2, 24, 6),
    };
    const label = textOf(raw.label, 32);
    if (label) item.label = label;
    return item;
  }

  if (kind === 'muscle_sets') {
    const muscle = tokenOf(typeof raw.muscle === 'string' ? raw.muscle.trim().toLowerCase() : '');
    if (!muscle) return null;
    if (validMuscles) {
      let allowed = false;
      for (const candidate of validMuscles) {
        if (typeof candidate === 'string' && candidate.trim().toLowerCase() === muscle) {
          allowed = true;
          break;
        }
      }
      if (!allowed) return null;
    }
    const item = {
      kind,
      muscle,
      window: LOAD_WINDOWS.includes(raw.window) ? raw.window : '72h',
    };
    const label = textOf(raw.label, 32);
    if (label) item.label = label;
    return item;
  }

  if (kind === 'session_count') {
    const item = { kind, weeks: clampInt(raw.weeks, 1, 24, 4) };
    const label = textOf(raw.label, 32);
    if (label) item.label = label;
    return item;
  }

  // prescription is the only kind where a short literal value is legitimate.
  const label = textOf(raw.label, 32);
  let value = '';
  if (typeof raw.value === 'string') value = raw.value.trim().slice(0, 24);
  else if (typeof raw.value === 'number' && Number.isFinite(raw.value)) value = String(raw.value).slice(0, 24);
  if (!label || !value) return null;
  return { kind, label, value };
};

function validateProse(raw) {
  const text = textOf(raw.text, PROSE_MAX_CHARS);
  if (!text) return fail('prose needs text');
  const node = { id: blockIdOf(raw.id) || 'prose_1', type: GENUI_NODE_TYPES.PROSE, text };
  if (PROSE_TONES.includes(raw.tone)) node.tone = raw.tone;
  return { ok: true, node };
}

function validateKpiStrip(raw, validExIds, validMuscles) {
  const requested = Array.isArray(raw.items) ? raw.items : [];
  const items = [];
  for (const candidate of requested) {
    const item = kpiItemOf(candidate, validExIds, validMuscles);
    if (!item) continue;
    items.push(item);
    if (items.length >= KPI_MAX_ITEMS) break;
  }
  if (!items.length) return fail('kpi_strip needs at least one valid item');
  return {
    ok: true,
    node: { id: blockIdOf(raw.id) || 'kpi_strip_1', type: GENUI_NODE_TYPES.KPI_STRIP, items },
  };
}

function validateComparisonTable(raw, validExIds) {
  const requestedColumns = Array.isArray(raw.columns) ? raw.columns : [];
  const columns = [];
  for (const candidate of requestedColumns) {
    const column = typeof candidate === 'string' ? candidate.trim().slice(0, 32) : '';
    if (!column) continue;
    columns.push(column);
    if (columns.length >= TABLE_MAX_COLUMNS) break;
  }
  if (columns.length < 2) return fail('comparison_table needs at least two columns');

  const requestedRows = Array.isArray(raw.rows) ? raw.rows : [];
  const rows = [];
  for (const candidate of requestedRows) {
    if (!Array.isArray(candidate)) continue;
    const cells = [];
    let valid = true;
    for (let index = 0; index < columns.length; index++) {
      const cell = candidate[index];
      if (cell === undefined || cell === null) {
        cells.push('');
        continue;
      }
      if (typeof cell === 'string') {
        cells.push(cell.trim().slice(0, 80));
        continue;
      }
      if (isObj(cell)) {
        const exId = tokenOf(cell.exId);
        if (!exId || (validExIds && !validExIds.has(exId))) {
          valid = false;
          break;
        }
        const out = { exId };
        const note = textOf(cell.note, 40);
        if (note) out.note = note;
        cells.push(out);
        continue;
      }
      valid = false;
      break;
    }
    if (!valid) continue;
    rows.push(cells);
    if (rows.length >= TABLE_MAX_ROWS) break;
  }
  if (!rows.length) return fail('comparison_table needs at least one valid row');

  const node = {
    id: blockIdOf(raw.id) || 'comparison_table_1',
    type: GENUI_NODE_TYPES.COMPARISON_TABLE,
    columns,
    rows,
  };
  const title = textOf(raw.title, MAX_TITLE);
  if (title) node.title = title;
  return { ok: true, node };
}

function validateChecklist(raw) {
  const id = blockIdOf(raw.id) || 'checklist_1';
  const listId = tokenOf(raw.listId) || id;
  const requested = Array.isArray(raw.items) ? raw.items : [];
  const seen = new Set();
  const items = [];
  let position = 0;
  for (const candidate of requested) {
    position++;
    if (!isObj(candidate)) continue;
    const label = textOf(candidate.label, 100);
    if (!label) continue;
    let itemId = blockIdOf(candidate.id) || `item_${position}`;
    if (seen.has(itemId)) {
      let suffix = 1;
      let next = `item_${position}_${suffix}`;
      while (seen.has(next)) next = `item_${position}_${++suffix}`;
      itemId = next;
    }
    seen.add(itemId);
    const item = { id: itemId, label };
    const detail = textOf(candidate.detail, 160);
    if (detail) item.detail = detail;
    items.push(item);
    if (items.length >= CHECKLIST_MAX_ITEMS) break;
  }
  if (!items.length) return fail('checklist needs at least one valid item');

  const node = { id, type: GENUI_NODE_TYPES.CHECKLIST, listId, items };
  const title = textOf(raw.title, MAX_TITLE);
  if (title) node.title = title;
  return { ok: true, node };
}

function validateCallout(raw) {
  const text = textOf(raw.text, PROSE_MAX_CHARS);
  if (!text) return fail('callout needs text');
  const node = {
    id: blockIdOf(raw.id) || 'callout_1',
    type: GENUI_NODE_TYPES.CALLOUT,
    variant: CALLOUT_VARIANTS.includes(raw.variant) ? raw.variant : 'info',
    text,
  };
  const title = textOf(raw.title, MAX_TITLE);
  if (title) node.title = title;
  return { ok: true, node };
}

/**
 * Validate and sanitize one v2 node (atomic primitive or legacy block).
 *
 * The returned node is always a fresh object holding only known fields, so a
 * caller can render or persist it without re-checking. Numeric chart data is
 * never accepted from the model; only hydration parameters are.
 *
 * @param {unknown} raw
 * @param {{ validExIds?: Set<string> | string[], validMuscles?: Set<string> | string[] }} [options]
 * @returns {{ ok: true, node: object } | { ok: false, reason: string }}
 */
export function validateGenUINode(raw, options = {}) {
  if (!isObj(raw)) return fail('node must be an object');
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!NODE_TYPE_VALUES.has(type)) return fail('unknown node type');

  const validExIds = asIdSet(options?.validExIds);
  const validMuscles = asIdSet(options?.validMuscles);

  if (BLOCK_TYPE_VALUES.has(type)) {
    const verdict = validateGenUIBlock(raw, options);
    return verdict.ok ? { ok: true, node: verdict.block } : verdict;
  }

  switch (type) {
    case GENUI_NODE_TYPES.PROSE:
      return validateProse(raw);
    case GENUI_NODE_TYPES.KPI_STRIP:
      return validateKpiStrip(raw, validExIds, validMuscles);
    case GENUI_NODE_TYPES.COMPARISON_TABLE:
      return validateComparisonTable(raw, validExIds);
    case GENUI_NODE_TYPES.CHECKLIST:
      return validateChecklist(raw);
    case GENUI_NODE_TYPES.CALLOUT:
      return validateCallout(raw);
    default:
      return fail('unknown node type');
  }
}

/* ------------------------------ node sanitizer ----------------------------- */

/**
 * Turn whatever a model produced into a safe, flat, ordered node list.
 *
 * Invalid nodes are dropped with a warning (never a noisy fallback_notice) so
 * the remaining narrative still renders. The heavy visual budget drops extra
 * charts only when the caller sets one; the total cap bounds the whole answer
 * including prose.
 *
 * @param {unknown} nodes
 * @param {{
 *   validExIds?: Set<string> | string[],
 *   validMuscles?: Set<string> | string[],
 *   maxNodes?: number,
 *   maxVisuals?: number | null,
 * }} [options]
 * @returns {{ nodes: object[], warnings: string[] }}
 */
export function sanitizeGenUINodes(nodes, options = {}) {
  const warnings = [];
  const maxNodes = clampInt(options?.maxNodes, 1, MAX_GENUI_NODES, MAX_GENUI_NODES);
  // A visual cap only applies when the caller explicitly asks for one. Omitting it
  // (or passing null) leaves charts unrestricted: the model, not a hidden default,
  // decides how many visuals the answer needs.
  const maxVisuals = typeof options?.maxVisuals === 'number' && Number.isFinite(options.maxVisuals)
    ? clampInt(options.maxVisuals, 0, MAX_VISUAL_NODES_LIMIT, DEFAULT_MAX_VISUAL_NODES)
    : null;

  let list;
  if (Array.isArray(nodes)) {
    list = nodes;
  } else if (nodes == null) {
    list = [];
  } else if (isObj(nodes)) {
    list = [nodes];
    warnings.push('nodes was not an array');
  } else {
    list = [];
    warnings.push('nodes was not an array');
  }

  const result = [];
  const usedIds = new Set();
  let visuals = 0;
  let capped = false;

  const claimId = (candidate, index) => {
    if (!usedIds.has(candidate)) return candidate;
    let next = `node_${index + 1}`;
    let suffix = 1;
    while (usedIds.has(next)) next = `node_${index + 1}_${++suffix}`;
    return next;
  };

  list.forEach((raw, index) => {
    if (result.length >= maxNodes) {
      if (!capped) {
        warnings.push(`nodes capped at ${maxNodes}`);
        capped = true;
      }
      return;
    }

    let verdict;
    try {
      verdict = validateGenUINode(raw, options);
    } catch {
      verdict = { ok: false, reason: 'node could not be validated' };
    }

    if (!verdict.ok) {
      if (isEmptyBlock(raw)) return;
      const type = isObj(raw) && typeof raw.type === 'string' ? raw.type.trim().slice(0, 40) : 'unknown';
      warnings.push(`node ${index + 1} (${type}) dropped: ${verdict.reason}`);
      return;
    }

    if (HEAVY_VISUAL_VALUES.has(verdict.node.type)) {
      if (maxVisuals !== null && visuals >= maxVisuals) {
        warnings.push(`heavy visual ${verdict.node.type} dropped: maxVisuals=${maxVisuals}`);
        return;
      }
      visuals++;
    }

    const id = claimId(verdict.node.id, index);
    usedIds.add(id);
    result.push(id === verdict.node.id ? verdict.node : { ...verdict.node, id });
  });

  return { nodes: result, warnings };
}

/* ------------------------------ v1 normalization --------------------------- */

const PROSE_BREAKS = ['. ', '! ', '? ', '。', '！', '？', '\n'];

function splitProseText(text) {
  const pieces = [];
  let rest = typeof text === 'string' ? text.trim() : '';
  while (rest) {
    if (rest.length <= PROSE_MAX_CHARS) {
      pieces.push(rest);
      break;
    }
    const window = rest.slice(0, PROSE_MAX_CHARS);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) {
      for (const mark of PROSE_BREAKS) {
        const index = window.lastIndexOf(mark);
        if (index >= 0) cut = Math.max(cut, index + mark.length);
      }
    }
    if (cut <= 0) {
      for (let index = window.length - 1; index > 0; index--) {
        if (/\s/.test(window[index])) {
          cut = index;
          break;
        }
      }
    }
    if (cut <= 0) cut = PROSE_MAX_CHARS;
    // Never slice between the two halves of a UTF-16 surrogate pair.
    if (cut > 1) {
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    const piece = rest.slice(0, cut).trim();
    if (piece) pieces.push(piece);
    rest = rest.slice(cut).trim();
  }
  return pieces;
}

/**
 * Normalize a v1 `{ text, blocks }` payload into a flat v2 node list.
 *
 * Long prose is split on paragraph/sentence boundaries into <=280 character
 * `prose` nodes; valid blocks follow the prose in their original order.
 *
 * @param {unknown} text
 * @param {unknown} blocks
 * @returns {object[]}
 */
export function v1ToGenUINodes(text, blocks) {
  const nodes = [];
  const usedIds = new Set();

  const claimId = (candidate, index) => {
    if (!usedIds.has(candidate)) return candidate;
    let next = `node_${index + 1}`;
    let suffix = 1;
    while (usedIds.has(next)) next = `node_${index + 1}_${++suffix}`;
    return next;
  };

  const pieces = splitProseText(text);
  pieces.forEach((piece, index) => {
    const id = claimId(`prose_${index + 1}`, nodes.length);
    usedIds.add(id);
    nodes.push({ id, type: GENUI_NODE_TYPES.PROSE, text: piece });
  });

  const list = Array.isArray(blocks) ? blocks : [];
  list.forEach(raw => {
    const verdict = validateGenUIBlock(raw);
    if (!verdict.ok) return;
    const id = claimId(verdict.block.id, nodes.length);
    usedIds.add(id);
    nodes.push(id === verdict.block.id ? verdict.block : { ...verdict.block, id });
  });

  return nodes;
}
