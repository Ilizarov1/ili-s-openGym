/* Incremental NDJSON node parser for the AI Coach v2 stream.
 *
 * The model writes one JSON node per line (interleaved narrative: prose nodes
 * and UI nodes in order). Tokens arrive in arbitrary chunks, so this module is
 * a small lexical state machine that:
 *   - joins lines split across chunks and tolerates CRLF,
 *   - keeps a multi-line pretty-printed JSON object open until braces balance,
 *   - announces structured nodes as soon as their `type` is visible,
 *   - streams `prose.text` deltas safely (JSON escapes, UTF-16 pairs),
 *   - recognises a legacy `{ text, blocks }` payload as one object,
 *   - degrades a broken line without killing the rest of the stream.
 *
 * Plain ES module JavaScript with no platform import and no third-party
 * dependency, so the phone, the server and the web client share it.
 */

export const NDJSON_EVENT_KINDS = Object.freeze({
  PROSE_DELTA: 'prose_delta',
  NODE_PENDING: 'node_pending',
  NODE_RAW: 'node_raw',
  LEGACY_PAYLOAD: 'legacy_payload',
  PLAIN_TEXT: 'plain_text',
  MALFORMED_LINE: 'malformed_line',
});

const KNOWN_NODE_TYPES = new Set([
  'prose',
  'kpi_strip',
  'comparison_table',
  'checklist',
  'callout',
  'exercise_trend',
  'muscle_load',
  'exercise_alternatives',
  'quick_form',
  'proposal_action',
  'fallback_notice',
]);

const LEGACY_KEYS = ['text', 'blocks', 'answer', 'message'];
const PROSE_TONES = ['normal', 'lead', 'closing'];
const SIMPLE_ESCAPES = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  r: '\r',
  t: '\t',
  b: '\b',
  f: '\f',
};

const TYPE_RE = /"type"\s*:\s*"([a-z_]+)"/g;
const ID_RE = /"id"\s*:\s*"([^"]+)"/;
const TEXT_RE = /"text"\s*:\s*"/;
const TONE_RE = /"tone"\s*:\s*"(normal|lead|closing)"/;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FRESH_OBJECT_RE = /^\s*\{\s*"type"\s*:\s*"[a-z_]+"/;

const isObj = value => !!value && typeof value === 'object' && !Array.isArray(value);

const tryParse = source => {
  try {
    return JSON.parse(source);
  } catch {
    return undefined;
  }
};

const cleanNodeId = value => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return NODE_ID_RE.test(trimmed) ? trimmed : '';
};

const isHighSurrogate = code => code >= 0xd800 && code <= 0xdbff;

/** Lexical depth at a byte position, used to ignore nested `type` fields. */
function depthAt(text, position) {
  let braces = 0;
  let arrays = 0;
  let inStr = false;
  let esc = false;
  for (let index = 0; index < position; index++) {
    const char = text[index];
    if (inStr) {
      if (esc) esc = false;
      else if (char === '\\') esc = true;
      else if (char === '"') inStr = false;
      continue;
    }
    if (char === '"') inStr = true;
    else if (char === '{') braces += 1;
    else if (char === '}') braces = Math.max(0, braces - 1);
    else if (char === '[') arrays += 1;
    else if (char === ']') arrays = Math.max(0, arrays - 1);
  }
  return { braces, arrays, inStr };
}

/**
 * Create one streaming parser. Feed model chunks in order with `push`, then
 * call `flush` once at the end so a trailing partial line is not lost.
 *
 * @returns {{ push: (chunk: string) => object[], flush: () => object[] }}
 */
export function createNdjsonNodeParser() {
  let rawBuffer = '';
  let lineStart = 0;
  let braceDepth = 0;
  let arrayDepth = 0;
  let inString = false;
  let escaped = false;

  let typeDetected = false;
  let pendingEmitted = false;
  let currentNodeId = null;
  let autoIndex = 0;

  let proseActive = false;
  let proseTextStart = -1;
  let proseCursor = 0;
  let proseDone = false;
  let emittedProseChars = 0;

  function nextAutoId() {
    autoIndex += 1;
    return `node_${autoIndex}`;
  }

  function resetLexical() {
    braceDepth = 0;
    arrayDepth = 0;
    inString = false;
    escaped = false;
  }

  function resetNodeState() {
    typeDetected = false;
    pendingEmitted = false;
    currentNodeId = null;
    proseActive = false;
    proseTextStart = -1;
    proseCursor = 0;
    proseDone = false;
    emittedProseChars = 0;
  }

  function recomputeLexical(text) {
    resetLexical();
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') braceDepth += 1;
      else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (char === '[') arrayDepth += 1;
      else if (char === ']') arrayDepth = Math.max(0, arrayDepth - 1);
    }
  }

  function toneOf() {
    const match = TONE_RE.exec(rawBuffer);
    return match && PROSE_TONES.includes(match[1]) ? match[1] : '';
  }

  function decodeFrom(start) {
    const units = [];
    let index = start;
    while (index < rawBuffer.length) {
      const char = rawBuffer[index];
      if (char === '"') return { units, next: index, ended: true };
      if (char === '\\') {
        if (index + 1 >= rawBuffer.length) return { units, next: index, ended: false };
        const kind = rawBuffer[index + 1];
        if (kind === 'u') {
          if (index + 6 > rawBuffer.length) return { units, next: index, ended: false };
          const hex = rawBuffer.slice(index + 2, index + 6);
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) return { units, next: index, ended: false };
          units.push({ text: String.fromCharCode(parseInt(hex, 16)), start: index, end: index + 6 });
          index += 6;
          continue;
        }
        const decoded = SIMPLE_ESCAPES[kind];
        if (decoded === undefined) {
          units.push({ text: kind, start: index, end: index + 2 });
        } else {
          units.push({ text: decoded, start: index, end: index + 2 });
        }
        index += 2;
        continue;
      }
      units.push({ text: char, start: index, end: index + 1 });
      index += 1;
    }
    return { units, next: index, ended: false };
  }

  function scanProse(events) {
    if (!proseActive || proseDone) return;
    if (proseTextStart < 0) {
      const match = TEXT_RE.exec(rawBuffer);
      if (!match) return;
      proseTextStart = match.index + match[0].length;
      proseCursor = proseTextStart;
    }

    const decoded = decodeFrom(proseCursor);
    let safeCount = decoded.units.length;
    if (!decoded.ended && safeCount > 0) {
      const tail = decoded.units[safeCount - 1].text;
      if (tail.length === 1 && isHighSurrogate(tail.charCodeAt(0))) safeCount -= 1;
    }

    if (safeCount > 0) {
      const safeUnits = decoded.units.slice(0, safeCount);
      const delta = safeUnits.map(unit => unit.text).join('');
      emittedProseChars += delta.length;
      const event = { kind: 'prose_delta', nodeId: currentNodeId, delta };
      const tone = toneOf();
      if (tone) event.tone = tone;
      events.push(event);
      proseCursor = safeUnits[safeUnits.length - 1].end;
    } else if (safeCount === decoded.units.length) {
      proseCursor = decoded.next;
    }

    if (decoded.ended) proseDone = true;
  }

  function scanType(events) {
    if (typeDetected) return;
    TYPE_RE.lastIndex = 0;
    let match;
    while ((match = TYPE_RE.exec(rawBuffer))) {
      const depth = depthAt(rawBuffer, match.index);
      // Only a top-level `type` belongs to this node. A nested block inside a
      // legacy `{ text, blocks }` payload must not announce a pending node.
      if (depth.inStr || depth.braces !== 1 || depth.arrays !== 0) continue;
      const nodeType = match[1];
      typeDetected = true;
      const idMatch = ID_RE.exec(rawBuffer);
      currentNodeId = (idMatch && cleanNodeId(idMatch[1])) || nextAutoId();

      if (nodeType === 'prose') {
        proseActive = true;
        return;
      }
      if (KNOWN_NODE_TYPES.has(nodeType)) {
        pendingEmitted = true;
        events.push({ kind: 'node_pending', nodeId: currentNodeId, nodeType });
      }
      return;
    }
  }

  function maybeSplitFreshLine(events) {
    if (lineStart <= 0 || arrayDepth !== 0 || inString) return;
    const segment = rawBuffer.slice(lineStart);
    if (!FRESH_OBJECT_RE.test(segment)) return;

    const broken = rawBuffer.slice(0, lineStart);
    const hadPending = pendingEmitted;
    const brokenNodeId = currentNodeId;
    rawBuffer = segment;
    lineStart = 0;
    recomputeLexical(rawBuffer);
    resetNodeState();

    if (broken.trim()) {
      events.push({
        kind: 'malformed_line',
        nodeId: brokenNodeId || null,
        hadPending,
        rawLine: broken.trim(),
      });
    }

    scanType(events);
    scanProse(events);
  }

  function finalizeParsed(parsed, line) {
    const events = [];
    const hadPending = pendingEmitted;
    const proseChars = emittedProseChars;

    if (isObj(parsed) && typeof parsed.type === 'string' && parsed.type) {
      const nodeId = currentNodeId || nextAutoId();
      events.push({ kind: 'node_raw', nodeId, raw: parsed, hadPending, emittedProseChars: proseChars });
      return events;
    }

    if (isObj(parsed) && LEGACY_KEYS.some(key => key in parsed)) {
      events.push({ kind: 'legacy_payload', raw: parsed });
      return events;
    }

    events.push({ kind: 'plain_text', text: line });
    return events;
  }

  function finishLine() {
    const source = rawBuffer;
    rawBuffer = '';
    lineStart = 0;
    resetLexical();
    const line = source.trim();

    if (!line || line.startsWith('```')) {
      resetNodeState();
      return [];
    }

    const parsed = tryParse(line);
    let events;
    if (parsed === undefined) {
      if (line.startsWith('{')) {
        events = [{
          kind: 'malformed_line',
          nodeId: currentNodeId || null,
          hadPending: pendingEmitted,
          rawLine: line,
        }];
      } else {
        events = [{ kind: 'plain_text', text: line }];
      }
    } else {
      events = finalizeParsed(parsed, line);
    }

    resetNodeState();
    return events;
  }

  /** Scan the accumulated buffer once per line/chunk, not once per character. */
  function scanBuffered(events) {
    scanType(events);
    scanProse(events);
  }

  function push(chunk) {
    const events = [];
    const text = typeof chunk === 'string' ? chunk : chunk == null ? '' : String(chunk);

    for (let index = 0; index < text.length; index++) {
      const char = text[index];

      // Normalize CRLF: the CR is never part of JSON or of a prose line.
      if (char === '\r') continue;

      if (char === '\n' && !inString) {
        if (braceDepth > 0) {
          // Read the whole JSON line before moving lineStart, so prose text on
          // this line is announced as one delta instead of one per character.
          rawBuffer += '\n';
          scanBuffered(events);
          lineStart = rawBuffer.length;
          continue;
        }
        // Batch the completed line's deltas before finishLine() resets state.
        scanBuffered(events);
        events.push(...finishLine());
        continue;
      }

      if (inString) {
        rawBuffer += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
        rawBuffer += char;
      } else {
        // A fresh `{type:...}` object still gets recovered before its closing
        // brace folds it into the previous (malformed) line's depth.
        if (char === '}') maybeSplitFreshLine(events);
        if (char === '{') braceDepth += 1;
        else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
        else if (char === '[') arrayDepth += 1;
        else if (char === ']') arrayDepth = Math.max(0, arrayDepth - 1);
        rawBuffer += char;
      }
    }

    scanBuffered(events);
    maybeSplitFreshLine(events);
    return events;
  }

  function flush() {
    if (!rawBuffer.trim()) {
      rawBuffer = '';
      lineStart = 0;
      resetLexical();
      resetNodeState();
      return [];
    }
    return finishLine();
  }

  return { push, flush };
}
