import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createExerciseSearchTrace,
  isExerciseSearchTraceId,
  logExerciseSearchMedia,
  safeExerciseSearchError,
} from '../agent-runtime/exercise-search-diagnostics.js';
import { ERROR_STATUS } from '../agent-runtime/errors.js';
import { BODY_PART_SLUGS, EQUIPMENT_SLUGS } from '../agent-runtime/tasks/exercise-search.js';

const TRACE = 'req_1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6';
const LEGACY_TRACE = 'req_1732252800000_z1a2b3';
const FAKE_API_KEY = 'sk-live-000000000000fakekey';
const FAKE_PATH = 'C:\\Users\\gym-goer\\private\\gym-photo.png';
const FAKE_DATA_URL = `data:image/png;base64,${'iVBORw0KGgo'.repeat(8)}`;

function capture() {
  const lines = [];
  return { lines, write: line => lines.push(line) };
}

function traceFor(source, over = {}) {
  const sink = capture();
  const emit = createExerciseSearchTrace({ traceId: TRACE, source, enabled: true, write: sink.write, ...over });
  assert.equal(typeof emit, 'function');
  return { emit, sink };
}

function parsed(sink) {
  return sink.lines.map(line => JSON.parse(line));
}

/** Drop the fixed envelope keys so assertions see only the stage fields. */
function fieldsOf(event) {
  const { event: eventName, schemaVersion, traceId, source, ...fields } = event;
  return fields;
}

test('the trace id check accepts uuid and web-legacy request ids only', () => {
  assert.equal(isExerciseSearchTraceId(TRACE), true);
  assert.equal(isExerciseSearchTraceId('req_0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0'), true);
  assert.equal(isExerciseSearchTraceId(LEGACY_TRACE), true);
  assert.equal(isExerciseSearchTraceId('req_1732252800000_a'), true);
  assert.equal(isExerciseSearchTraceId('req_1732252800000_abcdefgh'), true);

  assert.equal(isExerciseSearchTraceId(`${TRACE} `), false);
  assert.equal(isExerciseSearchTraceId('req_1A2B3C4D-5E6F-47A8-B9C0-D1E2F3A4B5C6'), false);
  assert.equal(isExerciseSearchTraceId('REQ_1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6'), false);
  assert.equal(isExerciseSearchTraceId('run_1a2b3c4d-5e6f-47a8-b9c0-d1e2f3a4b5c6'), false);
  assert.equal(isExerciseSearchTraceId('req_1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6'), false);
  assert.equal(isExerciseSearchTraceId('req_173225280000_abcdefgh'), false);
  assert.equal(isExerciseSearchTraceId('req_17322528000000_abcdefgh'), false);
  assert.equal(isExerciseSearchTraceId('req_1732252800000_abcdefghi'), false);
  assert.equal(isExerciseSearchTraceId('req_1732252800000_ABCDEFGH'), false);
  assert.equal(isExerciseSearchTraceId('req_1732252800000_'), false);
  assert.equal(isExerciseSearchTraceId('req_'), false);
  assert.equal(isExerciseSearchTraceId('req_12345678'), false);
  assert.equal(isExerciseSearchTraceId(''), false);
  assert.equal(isExerciseSearchTraceId(null), false);
  assert.equal(isExerciseSearchTraceId(42), false);
  assert.equal(isExerciseSearchTraceId({ traceId: TRACE }), false);
  assert.equal(isExerciseSearchTraceId(), false);
});

test('a disabled switch writes zero lines and returns no trace', () => {
  const sink = capture();
  assert.equal(createExerciseSearchTrace({ traceId: TRACE, source: 'web', enabled: false, write: sink.write }), undefined);
  logExerciseSearchMedia({ mediaAttemptId: 'mat_1', source: 'web', enabled: false, write: sink.write, metrics: { status: 'ready' } });
  assert.deepEqual(sink.lines, []);
});

test('an invalid trace id or source starts no trace', () => {
  const sink = capture();
  assert.equal(createExerciseSearchTrace({ traceId: 'req_nope', source: 'web', enabled: true, write: sink.write }), undefined);
  assert.equal(createExerciseSearchTrace({ traceId: TRACE, source: 'spyware', enabled: true, write: sink.write }), undefined);
  assert.equal(createExerciseSearchTrace({ traceId: TRACE, source: 'web', write: sink.write }), undefined);
  logExerciseSearchMedia({ mediaAttemptId: 'mat_1', source: 'spyware', enabled: true, write: sink.write, metrics: { status: 'ready' } });
  assert.deepEqual(sink.lines, []);
});

test('an adversarial custom requestId never reaches the sink', () => {
  const sink = capture();
  const adversarial = 'req_1740000000000_../../etc/passwd';
  assert.equal(isExerciseSearchTraceId(adversarial), false);
  assert.equal(createExerciseSearchTrace({ traceId: adversarial, source: 'web', enabled: true, write: sink.write }), undefined);
  logExerciseSearchMedia({ mediaAttemptId: adversarial, source: 'web', enabled: true, write: sink.write, metrics: { status: 'ready' } });
  assert.deepEqual(sink.lines, []);

  // A trace opened afterwards is unaffected and never echoes the forged id.
  const good = traceFor('web');
  good.emit({ stage: 'submit', execution: 'server', hasHint: false, imageCount: 1, mediaAttemptId: '../not an id' });
  assert.equal(good.sink.lines.length, 1);
  assert.ok(!good.sink.lines[0].includes(adversarial));
  assert.ok(!good.sink.lines[0].includes('../not an id'));
  assert.equal('mediaAttemptId' in parsed(good.sink)[0], false);
});

test('throwing sinks and hostile events never propagate to the caller', () => {
  const boom = () => {
    throw new Error('sink exploded');
  };
  const exploding = createExerciseSearchTrace({ traceId: TRACE, source: 'api', enabled: true, write: boom });
  assert.equal(typeof exploding, 'function');
  assert.doesNotThrow(() => exploding({ stage: 'submit', execution: 'server', hasHint: true, imageCount: 0 }));
  assert.doesNotThrow(() => logExerciseSearchMedia({
    mediaAttemptId: 'mat_1', source: 'rn', enabled: true, write: boom, metrics: { status: 'ready' },
  }));

  const sink = capture();
  const emit = createExerciseSearchTrace({ traceId: TRACE, source: 'web', enabled: true, write: sink.write });
  const hostile = () => new Proxy({}, { get() { throw new Error('no peeking'); } });
  assert.doesNotThrow(() => emit(hostile()));
  assert.doesNotThrow(() => logExerciseSearchMedia(hostile()));
  assert.doesNotThrow(() => { emit(); emit(null); emit('submit'); emit(['submit']); emit(42); });
  assert.deepEqual(sink.lines, []);
});

test('the default sink is console.info, one JSON line per event', () => {
  const original = console.info;
  const lines = [];
  console.info = line => { lines.push(line); };
  try {
    const emit = createExerciseSearchTrace({ traceId: TRACE, source: 'web', enabled: true });
    emit({ stage: 'submit', execution: 'server', hasHint: true, imageCount: 0 });
    logExerciseSearchMedia({ mediaAttemptId: 'mat_console', source: 'rn', enabled: true, metrics: { status: 'cancelled' } });
  } finally {
    console.info = original;
  }
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(typeof line, 'string');
    assert.ok(!line.includes('\n'));
    const event = JSON.parse(line);
    assert.equal(event.event, 'exercise_search');
    assert.equal(event.schemaVersion, 1);
  }
  assert.equal(JSON.parse(lines[0]).stage, 'submit');
  assert.equal(JSON.parse(lines[1]).stage, 'media');
  assert.equal(JSON.parse(lines[1]).mediaAttemptId, 'mat_console');
  assert.equal(isExerciseSearchTraceId(JSON.parse(lines[1]).traceId), true);
});

test('every run stage projects exactly its declared fields onto the fixed envelope', () => {
  const { emit, sink } = traceFor('api');
  emit({ stage: 'submit', execution: 'server', hasHint: true, imageCount: 1, mediaAttemptId: 'mat_join_1' });
  emit({ stage: 'attachments', images: [{ mime: 'image/png', width: 640, height: 480, bytes: 2048 }] });
  emit({ stage: 'model', round: 1, status: 'completed', elapsedMs: 1250, toolCalls: 0 });
  emit({ stage: 'recognition', rawCandidateCount: 4, cleanCandidateCount: 3, equipment: ['leverage machine'], bodyParts: ['chest', 'upper arms'] });
  emit({ stage: 'recall', candidateIndex: 0, queryOrigin: 'english', queryWordCount: 3, hitCount: 2, top: [{ id: '0576', score: 1.5 }, { id: '0577', score: 0.75 }] });
  emit({ stage: 'filter', candidateIndex: 0, decision: 'accepted', id: '0576' });
  emit({ stage: 'filter', candidateIndex: 1, decision: 'deduplicated' });
  emit({ stage: 'display', resultCount: 1, publicIds: ['0576'], customCount: 0, fallbackOnly: false, elapsedMs: 3 });
  emit({ stage: 'end', status: 'completed', phase: 'match', elapsedMs: 1300 });

  assert.equal(sink.lines.length, 9);
  for (const line of sink.lines) assert.ok(!line.includes('\n'));
  const events = parsed(sink);
  for (const event of events) {
    assert.equal(event.event, 'exercise_search');
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.traceId, TRACE);
    assert.equal(event.source, 'api');
  }
  assert.deepEqual(events[0], {
    event: 'exercise_search',
    schemaVersion: 1,
    traceId: TRACE,
    source: 'api',
    stage: 'submit',
    execution: 'server',
    hasHint: true,
    imageCount: 1,
    mediaAttemptId: 'mat_join_1',
  });
  assert.deepEqual(fieldsOf(events[1]), { stage: 'attachments', images: [{ mime: 'image/png', width: 640, height: 480, bytes: 2048 }] });
  assert.deepEqual(fieldsOf(events[2]), { stage: 'model', round: 1, status: 'completed', elapsedMs: 1250, toolCalls: 0 });
  assert.deepEqual(fieldsOf(events[3]), { stage: 'recognition', rawCandidateCount: 4, cleanCandidateCount: 3, equipment: ['leverage machine'], bodyParts: ['chest', 'upper arms'] });
  assert.deepEqual(fieldsOf(events[4]), { stage: 'recall', candidateIndex: 0, queryOrigin: 'english', queryWordCount: 3, hitCount: 2, top: [{ id: '0576', score: 1.5 }, { id: '0577', score: 0.75 }] });
  assert.deepEqual(fieldsOf(events[5]), { stage: 'filter', candidateIndex: 0, decision: 'accepted', id: '0576' });
  assert.deepEqual(fieldsOf(events[6]), { stage: 'filter', candidateIndex: 1, decision: 'deduplicated' });
  assert.deepEqual(fieldsOf(events[7]), { stage: 'display', resultCount: 1, publicIds: ['0576'], customCount: 0, fallbackOnly: false, elapsedMs: 3 });
  assert.deepEqual(fieldsOf(events[8]), { stage: 'end', status: 'completed', phase: 'match', elapsedMs: 1300 });
});

test('undeclared fields and raw error messages never reach a line', () => {
  const { emit, sink } = traceFor('web');
  emit({
    stage: 'model',
    round: 1,
    status: 'failed',
    elapsedMs: 5,
    toolCalls: 0,
    errorCode: 'model_timeout',
    error: 'TypeError: cannot read private data of undefined',
    message: `connect failed using ${FAKE_API_KEY}`,
    rawText: 'the model hallucinated a whole routine',
    stack: 'at model (node:internal)',
  });
  assert.equal(sink.lines.length, 1);
  const event = parsed(sink)[0];
  assert.deepEqual(Object.keys(event).sort(), [
    'elapsedMs', 'errorCode', 'event', 'round', 'schemaVersion', 'source', 'stage', 'status', 'toolCalls', 'traceId',
  ]);
  assert.equal(event.errorCode, 'model_timeout');
  for (const leak of ['TypeError', FAKE_API_KEY, 'hallucinated', 'node:internal']) {
    assert.ok(!sink.lines[0].includes(leak));
  }
});

test('a fixture carrying a fake key, path and Data URL leaks none of them', () => {
  const { emit, sink } = traceFor('rn-local');
  emit({
    stage: 'submit',
    execution: 'local',
    hasHint: true,
    imageCount: 2,
    mediaAttemptId: 'mat_fixture',
    apiKey: FAKE_API_KEY,
    filePath: FAKE_PATH,
    image: FAKE_DATA_URL,
    hintText: `secret hint mentioning ${FAKE_API_KEY}`,
  });
  emit({
    stage: 'attachments',
    images: [
      { mime: 'image/png', width: 640, height: 480, bytes: 2048, dataUrl: FAKE_DATA_URL, name: FAKE_PATH, apiKey: FAKE_API_KEY },
      { mime: `image/png;x=${FAKE_API_KEY}`, width: 1, height: 1, bytes: 1 },
      { mime: 'image/jpeg', width: 480, height: 640, bytes: 1024 },
    ],
    path: FAKE_PATH,
  });
  emit({
    stage: 'recognition',
    rawCandidateCount: 5,
    cleanCandidateCount: 2,
    equipment: ['leverage machine', `custom ${FAKE_API_KEY} rig`, 'made-up-machine'],
    bodyParts: ['chest', `path ${FAKE_PATH} region`],
    understanding: `a photo at ${FAKE_PATH} with ${FAKE_DATA_URL}`,
  });
  emit({
    stage: 'end',
    status: 'failed',
    phase: 'model',
    elapsedMs: 9,
    errorCode: 'model_unavailable',
    message: `provider rejected key ${FAKE_API_KEY} while reading ${FAKE_PATH}`,
    attachment: FAKE_DATA_URL,
  });

  assert.equal(sink.lines.length, 4);
  const blob = sink.lines.join('\n');
  for (const marker of [FAKE_API_KEY, FAKE_PATH, FAKE_DATA_URL, 'made-up-machine']) {
    assert.ok(!blob.includes(marker), `emitted lines must not contain ${marker}`);
  }
  const events = parsed(sink);
  assert.deepEqual(fieldsOf(events[0]), {
    stage: 'submit',
    execution: 'local',
    hasHint: true,
    imageCount: 2,
    mediaAttemptId: 'mat_fixture',
  });
  // The third image is cut by the two-image cap, not used to fill anything.
  assert.deepEqual(fieldsOf(events[1]), {
    stage: 'attachments',
    images: [
      { mime: 'image/png', width: 640, height: 480, bytes: 2048 },
      { width: 1, height: 1, bytes: 1 },
    ],
  });
  assert.deepEqual(fieldsOf(events[2]), {
    stage: 'recognition',
    rawCandidateCount: 5,
    cleanCandidateCount: 2,
    equipment: ['leverage machine'],
    bodyParts: ['chest'],
  });
  assert.deepEqual(fieldsOf(events[3]), {
    stage: 'end',
    status: 'failed',
    phase: 'model',
    elapsedMs: 9,
    errorCode: 'model_unavailable',
  });
});

test('arrays stay inside the business caps without re-picking to fill', () => {
  const { emit, sink } = traceFor('web');
  emit({
    stage: 'recall',
    candidateIndex: 0,
    queryOrigin: 'primary',
    queryWordCount: 2,
    hitCount: 8,
    top: [
      { id: '0001', score: 9 },
      { id: 'not a slug!!', score: 8 },
      { id: '0002', score: 7 },
      { id: '0003', score: 6 },
      { id: '0004', score: 5 },
      { id: '0005', score: 4 },
    ],
  });
  emit({ stage: 'display', resultCount: 7, publicIds: ['0001', '0002', '0003', '0004', '0005', '0006'], customCount: 2, fallbackOnly: false, elapsedMs: 1 });
  const events = parsed(sink);
  assert.deepEqual(events[0].top, [{ id: '0001', score: 9 }, { id: '0002', score: 7 }, { id: '0003', score: 6 }, { id: '0004', score: 5 }]);
  assert.deepEqual(events[1].publicIds, ['0001', '0002', '0003', '0004', '0005']);
});

test('counters, times and scores accept finite numbers only', () => {
  const { emit, sink } = traceFor('web');
  emit({
    stage: 'display',
    resultCount: Number.POSITIVE_INFINITY,
    customCount: 'three',
    fallbackOnly: 1,
    elapsedMs: Number.NaN,
    publicIds: ['0001'],
  });
  emit({ stage: 'end', status: 'completed', phase: 'poll', elapsedMs: 12n });
  const events = parsed(sink);
  assert.deepEqual(fieldsOf(events[0]), { stage: 'display', publicIds: ['0001'] });
  assert.deepEqual(fieldsOf(events[1]), { stage: 'end', status: 'completed', phase: 'poll' });
});

test('undeclared stages and enum values are dropped', () => {
  const { emit, sink } = traceFor('web');
  emit({ stage: 'telemetry', anything: FAKE_API_KEY });
  emit({ stage: 'media', status: 'ready' });
  emit({ stage: 'model', round: 1, status: 'exploded', elapsedMs: 1, toolCalls: 0, errorCode: 'model_timeout' });
  emit({ stage: 'end', status: 'completed', phase: 'swim', elapsedMs: 1, errorCode: 'model_timeout' });
  emit({ stage: 'recall', candidateIndex: 0, queryOrigin: 'translated', queryWordCount: 1, hitCount: 1, top: [] });
  emit({ stage: 'filter', candidateIndex: 0, decision: 'definitely_accepted' });
  emit({ stage: 'submit', execution: 'hybrid', hasHint: true, imageCount: 0 });
  assert.equal(sink.lines.length, 5);
  const events = parsed(sink);
  assert.deepEqual(fieldsOf(events[0]), { stage: 'model', round: 1, elapsedMs: 1, toolCalls: 0 });
  assert.deepEqual(fieldsOf(events[1]), { stage: 'end', status: 'completed', elapsedMs: 1 });
  assert.deepEqual(fieldsOf(events[2]), { stage: 'recall', candidateIndex: 0, queryWordCount: 1, hitCount: 1, top: [] });
  assert.deepEqual(fieldsOf(events[3]), { stage: 'filter', candidateIndex: 0 });
  assert.deepEqual(fieldsOf(events[4]), { stage: 'submit', hasHint: true, imageCount: 0 });
});

test('equipment and body parts are checked against the task vocabulary', () => {
  const { emit, sink } = traceFor('api');
  emit({
    stage: 'recognition',
    rawCandidateCount: 3,
    cleanCandidateCount: 2,
    equipment: [...EQUIPMENT_SLUGS, 'unobtainium rig', 'leverage machine'],
    bodyParts: [...BODY_PART_SLUGS, 'the mind', 'chest'],
  });
  const event = parsed(sink)[0];
  assert.deepEqual(event.equipment, [...EQUIPMENT_SLUGS]);
  assert.deepEqual(event.bodyParts, [...BODY_PART_SLUGS]);
});

test('safeExerciseSearchError passes only declared codes through', () => {
  for (const code of Object.keys(ERROR_STATUS)) assert.equal(safeExerciseSearchError(code), code);
  assert.equal(safeExerciseSearchError('permission_denied'), 'permission_denied');
  assert.equal(safeExerciseSearchError('asset_missing'), 'asset_missing');
  assert.equal(safeExerciseSearchError('totally_made_up'), 'unknown');
  assert.equal(safeExerciseSearchError(`error at ${FAKE_PATH}`), 'unknown');
  assert.equal(safeExerciseSearchError(new Error('with a message')), 'unknown');
  assert.equal(safeExerciseSearchError(undefined), 'unknown');
  assert.equal(safeExerciseSearchError(null), 'unknown');
  assert.equal(safeExerciseSearchError(500), 'unknown');
  assert.equal(safeExerciseSearchError(''), 'unknown');
});

test('media events use a fresh trace id and join through mediaAttemptId', () => {
  const media = capture();
  logExerciseSearchMedia({
    mediaAttemptId: 'mat_join_1',
    source: 'web',
    enabled: true,
    write: media.write,
    metrics: {
      status: 'ready',
      inputBytes: 300000,
      outputBytes: 150000,
      outputWidth: 1024,
      outputHeight: 768,
      attempts: 2,
      rotationApplied: true,
      elapsedMs: 55,
    },
  });
  const run = capture();
  const emit = createExerciseSearchTrace({ traceId: TRACE, source: 'web', enabled: true, write: run.write });
  emit({ stage: 'submit', execution: 'server', hasHint: false, imageCount: 1, mediaAttemptId: 'mat_join_1' });

  assert.equal(media.lines.length, 1);
  assert.equal(run.lines.length, 1);
  const mediaEvent = JSON.parse(media.lines[0]);
  const submitEvent = JSON.parse(run.lines[0]);
  assert.equal(isExerciseSearchTraceId(mediaEvent.traceId), true);
  assert.notEqual(mediaEvent.traceId, TRACE);
  assert.deepEqual(mediaEvent, {
    event: 'exercise_search',
    schemaVersion: 1,
    traceId: mediaEvent.traceId,
    source: 'web',
    stage: 'media',
    mediaAttemptId: 'mat_join_1',
    status: 'ready',
    inputBytes: 300000,
    outputBytes: 150000,
    outputWidth: 1024,
    outputHeight: 768,
    attempts: 2,
    rotationApplied: true,
    elapsedMs: 55,
  });
  assert.equal(submitEvent.mediaAttemptId, 'mat_join_1');
});

test('media failures record a safe error code and no raw details', () => {
  const sink = capture();
  logExerciseSearchMedia({
    mediaAttemptId: 'mat_fail',
    source: 'rn',
    enabled: true,
    write: sink.write,
    metrics: {
      status: 'failed',
      errorCode: 'permission_denied',
      elapsedMs: 12,
      filePath: FAKE_PATH,
      rawError: `open("${FAKE_PATH}") EACCES key=${FAKE_API_KEY}`,
    },
  });
  assert.equal(sink.lines.length, 1);
  const event = JSON.parse(sink.lines[0]);
  assert.deepEqual(fieldsOf(event), {
    stage: 'media',
    mediaAttemptId: 'mat_fail',
    status: 'failed',
    elapsedMs: 12,
    errorCode: 'permission_denied',
  });
  for (const marker of [FAKE_API_KEY, FAKE_PATH, 'EACCES']) {
    assert.ok(!sink.lines[0].includes(marker));
  }
});

test('media events need a valid attempt id, a known source and a declared status', () => {
  const sink = capture();
  logExerciseSearchMedia({ source: 'rn', enabled: true, write: sink.write, metrics: { status: 'ready' } });
  logExerciseSearchMedia({ mediaAttemptId: 'mat_2/../escape', source: 'rn', enabled: true, write: sink.write, metrics: { status: 'ready' } });
  logExerciseSearchMedia({ mediaAttemptId: 'mat_2', source: 'stranger', enabled: true, write: sink.write, metrics: { status: 'ready' } });
  logExerciseSearchMedia({ mediaAttemptId: 'mat_2', source: 'rn', enabled: true, write: sink.write, metrics: { status: 'warp-speed' } });
  logExerciseSearchMedia({ mediaAttemptId: 'mat_2', source: 'rn', enabled: true, write: sink.write, metrics: 'ready' });
  logExerciseSearchMedia({ mediaAttemptId: 'mat_2', source: 'rn', enabled: true, write: sink.write });
  logExerciseSearchMedia();
  assert.deepEqual(sink.lines, []);
});

test('the web legacy trace id also carries run events', () => {
  const sink = capture();
  const emit = createExerciseSearchTrace({ traceId: LEGACY_TRACE, source: 'web', enabled: true, write: sink.write });
  assert.equal(typeof emit, 'function');
  emit({ stage: 'end', status: 'completed', phase: 'poll', elapsedMs: 1 });
  assert.equal(parsed(sink)[0].traceId, LEGACY_TRACE);
});

test('filter accepts body_part_conflict while preserving schemaVersion 1', () => {
  const { emit, sink } = traceFor('rn');
  emit({ stage: 'filter', candidateIndex: 0, decision: 'body_part_conflict', id: '1221' });
  assert.equal(sink.lines.length, 1);
  const event = parsed(sink)[0];
  assert.equal(event.schemaVersion, 1);
  assert.deepEqual(fieldsOf(event), {
    stage: 'filter',
    candidateIndex: 0,
    decision: 'body_part_conflict',
    id: '1221',
  });
});

test('recall accepts bm25 queryOrigin while preserving schemaVersion 1', () => {
  const { emit, sink } = traceFor('rn');
  emit({
    stage: 'recall',
    candidateIndex: 0,
    queryOrigin: 'bm25',
    queryWordCount: 4,
    hitCount: 1,
    top: [{ id: '1041', score: 132 }],
  });
  assert.equal(sink.lines.length, 1);
  const event = parsed(sink)[0];
  assert.equal(event.schemaVersion, 1);
  assert.deepEqual(fieldsOf(event), {
    stage: 'recall',
    candidateIndex: 0,
    queryOrigin: 'bm25',
    queryWordCount: 4,
    hitCount: 1,
    top: [{ id: '1041', score: 132 }],
  });
});
