/* Contract tests for the shared Generative-UI protocol and coach-genui.v1.
 *
 * These run under plain `node --test` with no project dependency. They cover
 * the wire framing both hosts share, every controlled block, the degradation
 * path for hallucinated ids, and all three deterministic fixture scripts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGUI_EVENT_TYPES,
  GENUI_BLOCK_TYPES,
  GENUI_CUSTOM_EVENTS,
  GENUI_FALLBACK_TEXT,
  GENUI_HEAVY_VISUAL_TYPES,
  GENUI_NODE_TYPES,
  GENUI_PROTOCOL_VERSION,
  DEFAULT_MAX_VISUAL_NODES,
  MAX_COACH_GENUI_TURNS,
  MAX_GENUI_BLOCKS,
  MAX_GENUI_NODES,
  MAX_VISUAL_NODES_LIMIT,
  formatSseEvent,
  parseSseChunk,
  validateGenUIBlock,
  validateGenUINode,
  sanitizeGenUIBlocks,
  sanitizeGenUINodes,
  v1ToGenUINodes,
  createNdjsonNodeParser,
  COACH_GENUI_TASK_ID,
  COACH_GENUI_SYSTEM_PROMPT,
  buildCoachGenUISystemPrompt,
  parseCoachGenUIOutput,
  buildFixtureGenUIResponse,
  createCoachGenUITask,
  isValid,
} from '../agent-runtime/index.js';
import * as genui from '../agent-runtime/genui/index.js';

const EX_IDS = [
  'barbell-bench-press',
  'dumbbell-incline-bench-press',
  'cable-fly',
  'dumbbell-shoulder-press',
  'barbell-squat',
  'dumbbell-lateral-raise',
  'seated-cable-row',
];

const VALID_MUSCLES = ['chest', 'deltoids', 'triceps', 'quadriceps', 'hamstrings', 'calves', 'abs', 'upper-back'];

const PLAN = {
  routines: [
    {
      id: 'r1',
      name: 'Push Day',
      ex: [{ id: 'barbell-bench-press' }, { id: 'dumbbell-shoulder-press' }],
    },
    { id: 'r2', name: 'Leg Day', ex: [{ id: 'barbell-squat' }] },
  ],
};

const trendBlock = (over = {}) => ({
  id: 'blk_trend_1',
  type: 'exercise_trend',
  exId: 'barbell-bench-press',
  metric: 'e1rm',
  weeks: 8,
  title: 'Bench e1RM',
  caption: 'Flat lately',
  highlightStall: true,
  ...over,
});

const muscleBlock = (over = {}) => ({
  id: 'blk_muscle_1',
  type: 'muscle_load',
  window: '72h',
  focusMuscles: ['chest', 'deltoids'],
  ...over,
});

const alternativesBlock = (over = {}) => ({
  id: 'blk_alt_1',
  type: 'exercise_alternatives',
  forExId: 'barbell-bench-press',
  items: [{ exId: 'dumbbell-incline-bench-press', reason: 'Neutral grip', tag: 'Dumbbell' }],
  ...over,
});

const formBlock = (over = {}) => ({
  id: 'blk_form_1',
  type: 'quick_form',
  formId: 'pain_triage',
  title: 'Quick check',
  fields: [
    { name: 'painArea', label: 'Where?', kind: 'single_choice', options: [{ value: 'knee', label: 'Knee' }] },
    { name: 'intensity', label: 'Pain', kind: 'scale', min: 1, max: 10 },
  ],
  ...over,
});

const proposalBlock = (over = {}) => ({
  id: 'blk_prop_1',
  type: 'proposal_action',
  title: 'Swap bench',
  summary: 'Moves bench to an incline dumbbell press.',
  changes: [{
    id: 'gc1',
    type: 'swap-exercise',
    target: { routineId: 'r1', exId: 'barbell-bench-press' },
    before: 'Barbell Bench Press',
    after: { id: 'dumbbell-incline-bench-press', name: 'Dumbbell Incline Bench Press' },
    why: 'Friendlier shoulder angle.',
  }],
  ...over,
});

const validOptions = { validExIds: EX_IDS, validMuscles: VALID_MUSCLES };

/* --------------------------------- protocol -------------------------------- */

test('protocol constants match the cross-host contract', () => {
  assert.equal(GENUI_PROTOCOL_VERSION, 2);
  assert.equal(MAX_GENUI_BLOCKS, 6);
  assert.equal(MAX_GENUI_NODES, 12);
  assert.equal(MAX_COACH_GENUI_TURNS, 10);
  assert.equal(DEFAULT_MAX_VISUAL_NODES, 1);
  assert.equal(MAX_VISUAL_NODES_LIMIT, 4);
  assert.ok(Object.isFrozen(AGUI_EVENT_TYPES));
  assert.ok(Object.isFrozen(GENUI_BLOCK_TYPES));

  assert.deepEqual(Object.keys(AGUI_EVENT_TYPES).sort(), [
    'CUSTOM',
    'RUN_ERROR',
    'RUN_FINISHED',
    'RUN_STARTED',
    'STEP_FINISHED',
    'STEP_STARTED',
    'TEXT_MESSAGE_CONTENT',
    'TEXT_MESSAGE_END',
    'TEXT_MESSAGE_START',
    'TOOL_CALL_RESULT',
    'TOOL_CALL_START',
  ]);
  for (const [key, value] of Object.entries(AGUI_EVENT_TYPES)) assert.equal(key, value);

  assert.deepEqual(GENUI_BLOCK_TYPES, {
    EXERCISE_TREND: 'exercise_trend',
    MUSCLE_LOAD: 'muscle_load',
    EXERCISE_ALTERNATIVES: 'exercise_alternatives',
    QUICK_FORM: 'quick_form',
    PROPOSAL_ACTION: 'proposal_action',
    FALLBACK_NOTICE: 'fallback_notice',
  });

  assert.deepEqual(GENUI_NODE_TYPES, {
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
  assert.equal(Object.keys(GENUI_NODE_TYPES).length, 11);

  assert.deepEqual([...GENUI_HEAVY_VISUAL_TYPES], ['exercise_trend', 'muscle_load']);
  assert.ok(Object.isFrozen(GENUI_HEAVY_VISUAL_TYPES));

  assert.ok(Object.isFrozen(GENUI_CUSTOM_EVENTS));
  assert.deepEqual(GENUI_CUSTOM_EVENTS, {
    BLOCK_UPSERT: 'genui.block_upsert',
    PROSE_DELTA: 'genui.prose_delta',
    NODE_PENDING: 'genui.node_pending',
    NODE_COMMIT: 'genui.node_commit',
    NODE_DROP: 'genui.node_drop',
  });
});

test('the genui entry re-exports the protocol surface', () => {
  assert.equal(genui.GENUI_PROTOCOL_VERSION, GENUI_PROTOCOL_VERSION);
  assert.equal(genui.formatSseEvent, formatSseEvent);
  assert.equal(genui.parseSseChunk, parseSseChunk);
  assert.equal(genui.validateGenUIBlock, validateGenUIBlock);
  assert.equal(genui.sanitizeGenUIBlocks, sanitizeGenUIBlocks);
  assert.equal(genui.validateGenUINode, validateGenUINode);
  assert.equal(genui.sanitizeGenUINodes, sanitizeGenUINodes);
  assert.equal(genui.v1ToGenUINodes, v1ToGenUINodes);
  assert.equal(genui.createNdjsonNodeParser, createNdjsonNodeParser);
});

/* --------------------------------- SSE wire -------------------------------- */

test('formatSseEvent emits exactly one data frame with a JSON event', () => {
  const event = { type: AGUI_EVENT_TYPES.RUN_STARTED, runId: 'run_1', threadId: 'th_1' };
  const frame = formatSseEvent(event);
  assert.equal(frame, `data: ${JSON.stringify(event)}\n\n`);
  assert.ok(frame.endsWith('\n\n'));
  assert.equal(JSON.parse(frame.slice(6, -2)).runId, 'run_1');
});

test('parseSseChunk returns every complete event and keeps a partial tail', () => {
  const first = { type: AGUI_EVENT_TYPES.RUN_STARTED, runId: 'run_1' };
  const second = { type: AGUI_EVENT_TYPES.STEP_STARTED, stepName: 'analyze' };
  const third = { type: AGUI_EVENT_TYPES.RUN_FINISHED, runId: 'run_1' };
  const chunk = formatSseEvent(first) + formatSseEvent(second) + formatSseEvent(third).slice(0, 12);

  const parsed = parseSseChunk(chunk);
  assert.deepEqual(parsed.events, [first, second]);
  assert.ok(parsed.rest.startsWith('data: '));
  assert.doesNotMatch(parsed.rest, /\n\n$/);
});

test('parseSseChunk accepts CRLF frames, no-space data and ignores heartbeats', () => {
  const event = { type: AGUI_EVENT_TYPES.TEXT_MESSAGE_CONTENT, delta: 'hi' };
  const chunk = `: ping\r\n\r\ndata:${JSON.stringify(event)}\r\n\r\n: ping\n\n`;
  const parsed = parseSseChunk(chunk);
  assert.deepEqual(parsed.events, [event]);
  assert.equal(parsed.rest, '');
});

test('parseSseChunk reassembles an event split mid-line across network chunks', () => {
  const event = { type: AGUI_EVENT_TYPES.TEXT_MESSAGE_CONTENT, messageId: 'm1', delta: 'plateau' };
  const whole = formatSseEvent(event);
  const cut = 17;

  const first = parseSseChunk(whole.slice(0, cut));
  assert.deepEqual(first.events, []);
  assert.equal(first.rest + whole.slice(cut), whole);

  const second = parseSseChunk(first.rest + whole.slice(cut));
  assert.deepEqual(second.events, [event]);
  assert.equal(second.rest, '');
});

test('parseSseChunk ignores broken frames instead of throwing', () => {
  const good = { type: AGUI_EVENT_TYPES.RUN_FINISHED };
  const parsed = parseSseChunk('data: {not json}\n\ndata: [1,2]\n\n' + formatSseEvent(good));
  assert.deepEqual(parsed.events, [good]);
  assert.equal(parseSseChunk('').events.length, 0);
  assert.equal(parseSseChunk(null).rest, '');
});

test('a formatted stream survives a byte-by-byte consumer', () => {
  const events = [
    { type: AGUI_EVENT_TYPES.RUN_STARTED, runId: 'run_2' },
    { type: AGUI_EVENT_TYPES.CUSTOM, name: 'genui.block_upsert', value: { block: trendBlock() } },
    { type: AGUI_EVENT_TYPES.RUN_FINISHED, runId: 'run_2', text: 'done', blocks: [trendBlock()] },
  ];
  const wire = events.map(formatSseEvent).join('') + ': ping\n\n';
  const seen = [];
  let rest = '';
  for (const char of wire) {
    const parsed = parseSseChunk(rest + char);
    seen.push(...parsed.events);
    rest = parsed.rest;
  }
  assert.deepEqual(seen, events);
  assert.equal(rest, '');
});

/* ------------------------------ block validation --------------------------- */

test('all five core block types validate and come back sanitized', () => {
  const cases = [trendBlock(), muscleBlock(), alternativesBlock(), formBlock(), proposalBlock()];
  for (const block of cases) {
    const verdict = validateGenUIBlock(block, validOptions);
    assert.equal(verdict.ok, true, `${block.type} should validate`);
    assert.equal(verdict.block.type, block.type);
    assert.equal(typeof verdict.block.id, 'string');
  }

  const notice = validateGenUIBlock({ id: 'blk_note_1', type: 'fallback_notice', text: 'No visual for this one.' });
  assert.equal(notice.ok, true);
  assert.equal(notice.block.text, 'No visual for this one.');
});

test('exercise_trend clamps weeks, defaults metric and rejects hallucinated ids', () => {
  const short = validateGenUIBlock(trendBlock({ weeks: 2, metric: 'not-a-metric' }), validOptions);
  assert.equal(short.ok, true);
  assert.equal(short.block.weeks, 4);
  assert.equal(short.block.metric, 'e1rm');

  const long = validateGenUIBlock(trendBlock({ weeks: 999 }), validOptions);
  assert.equal(long.ok, true);
  assert.equal(long.block.weeks, 24);

  const rounded = validateGenUIBlock(trendBlock({ weeks: 8.6 }), validOptions);
  assert.equal(rounded.ok, true);
  assert.equal(rounded.block.weeks, 9);

  const missing = validateGenUIBlock({ type: 'exercise_trend', weeks: 8 }, validOptions);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /exId/);

  const ghost = validateGenUIBlock(trendBlock({ exId: 'invented-exercise' }), validOptions);
  assert.equal(ghost.ok, false);
  assert.match(ghost.reason, /unknown exercise id/);

  const withoutCatalogue = validateGenUIBlock(trendBlock({ exId: 'any-id' }));
  assert.equal(withoutCatalogue.ok, true, 'no validExIds means no catalogue check');
});

test('muscle_load defaults the window, filters and caps focus muscles', () => {
  const verdict = validateGenUIBlock(muscleBlock({
    window: 'yesterday',
    focusMuscles: ['chest', 'not-a-muscle', 'deltoids', 'chest', 'triceps', 'quadriceps', 'calves', 'abs', 'upper-back'],
  }), validOptions);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.block.window, '72h');
  assert.deepEqual(verdict.block.focusMuscles, ['chest', 'deltoids', 'triceps', 'quadriceps', 'calves', 'abs']);

  const week = validateGenUIBlock(muscleBlock({ window: '7d', focusMuscles: [] }), validOptions);
  assert.equal(week.ok, true);
  assert.equal(week.block.window, '7d');
  assert.deepEqual(week.block.focusMuscles, []);
});

test('exercise_alternatives drops unknown ids and fails when none survive', () => {
  const mixed = validateGenUIBlock(alternativesBlock({
    items: [
      { exId: 'invented-exercise', reason: 'fake' },
      { exId: 'dumbbell-incline-bench-press', reason: 'Neutral grip', tag: 'Dumbbell' },
      { exId: 'cable-fly', reason: 'Constant tension' },
      { exId: 'dumbbell-incline-bench-press', reason: 'duplicate' },
    ],
  }), validOptions);
  assert.equal(mixed.ok, true);
  assert.deepEqual(mixed.block.items.map(item => item.exId), ['dumbbell-incline-bench-press', 'cable-fly']);
  assert.equal(mixed.block.items[0].tag, 'Dumbbell');

  const capped = validateGenUIBlock(alternativesBlock({
    items: EX_IDS.map(id => ({ exId: id, reason: 'ok' })),
  }), validOptions);
  assert.equal(capped.ok, true);
  assert.equal(capped.block.items.length, 5);

  const empty = validateGenUIBlock(alternativesBlock({ items: [{ exId: 'invented-exercise' }] }), validOptions);
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /at least one/);

  const noItems = validateGenUIBlock(alternativesBlock({ items: [] }), validOptions);
  assert.equal(noItems.ok, false);
});

test('quick_form requires real fields; choices need options and scales clamp', () => {
  const verdict = validateGenUIBlock(formBlock({
    fields: [
      { name: 'painArea', label: 'Where?', kind: 'single_choice', options: [{ value: 'knee', label: 'Knee' }, { value: '', label: 'Bad' }] },
      { name: 'equipment', label: 'Equipment', kind: 'multi_choice', options: [] },
      { name: 'intensity', label: 'Pain', kind: 'scale', min: 0, max: 99 },
      { name: 'missingKind', label: 'Nothing', options: [{ value: 'a', label: 'A' }] },
    ],
  }));
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.block.fields.map(field => field.name), ['painArea', 'intensity']);
  assert.deepEqual(verdict.block.fields[0].options, [{ value: 'knee', label: 'Knee' }]);
  assert.equal(verdict.block.fields[1].min, 1);
  assert.equal(verdict.block.fields[1].max, 10);

  const inverted = validateGenUIBlock(formBlock({
    fields: [{ name: 'mood', label: 'Mood', kind: 'scale', min: 9, max: 2 }],
  }));
  assert.equal(inverted.ok, true);
  assert.equal(inverted.block.fields[0].min, 2);
  assert.equal(inverted.block.fields[0].max, 9);

  const noFormId = validateGenUIBlock(formBlock({ formId: 'not a form id' }));
  assert.equal(noFormId.ok, false);
  assert.match(noFormId.reason, /formId/);

  const noFields = validateGenUIBlock(formBlock({ fields: [] }));
  assert.equal(noFields.ok, false);
  assert.match(noFields.reason, /at least one valid field/);
});

test('proposal_action keeps a controlled change list and drops malformed changes', () => {
  const verdict = validateGenUIBlock(proposalBlock(), validOptions);
  assert.equal(verdict.ok, true);
  const [change] = verdict.block.changes;
  assert.equal(change.type, 'swap-exercise');
  assert.deepEqual(change.target, { routineId: 'r1', exId: 'barbell-bench-press' });
  assert.deepEqual(change.after, { id: 'dumbbell-incline-bench-press', name: 'Dumbbell Incline Bench Press' });

  const many = validateGenUIBlock(proposalBlock({
    changes: Array.from({ length: 9 }, (_, index) => ({
      id: `gc${index + 1}`,
      type: 'sets',
      target: { routineId: 'r1', exId: 'barbell-bench-press' },
      why: `reason ${index + 1}`,
      after: index + 2,
    })),
  }), validOptions);
  assert.equal(many.ok, true);
  assert.equal(many.block.changes.length, 6);

  const malformed = validateGenUIBlock(proposalBlock({
    changes: [
      { id: 'gc1', type: 'swap-exercise', target: { routineId: 'r1' } },
      { id: 'gc2', target: { routineId: 'r1' }, why: 'no type' },
      { id: 'gc3', type: 'swap-exercise', target: { routineId: 'r1' }, why: '' },
    ],
  }), validOptions);
  assert.equal(malformed.ok, false);

  const noSummary = validateGenUIBlock(proposalBlock({ summary: '' }), validOptions);
  assert.equal(noSummary.ok, false);
});

test('proposal_action accepts add-routine changes with an empty or omitted target', () => {
  const addChange = over => ({
    id: 'gc1', type: 'add-routine', why: 'The athlete asked for an upper day.',
    after: { name: 'Upper', ex: [{ id: 'barbell-bench-press' }] },
    ...over,
  });
  for (const raw of [addChange({ target: {} }), addChange()]) {
    const verdict = validateGenUIBlock(proposalBlock({ changes: [raw] }), validOptions);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.block.changes[0].target, {});
    assert.equal(verdict.block.changes[0].after.ex[0].id, 'barbell-bench-press');
  }
  // Only the structural types relax the rule; a scalar change still needs something to target.
  const noTarget = validateGenUIBlock(proposalBlock({
    changes: [{ id: 'gc1', type: 'sets', why: 'x', target: {}, after: 4 }],
  }), validOptions);
  assert.equal(noTarget.ok, false);
});

test('add-routine after.ex keeps the prescription fields the client applies', () => {
  const verdict = validateGenUIBlock(proposalBlock({
    changes: [{
      id: 'gc1', type: 'add-routine', target: {}, why: 'Build a base.',
      after: {
        name: 'Upper', emoji: 'figureStrength', prog: 'linear',
        ex: [{
          id: 'barbell-bench-press', name: 'Bench Press', sets: 4, mode: 'reps',
          reps: 8, repsMin: 6, repsMax: 10, setsMax: 5, sec: 45, min: 20, speed: 9.5,
          prog: 'linear', inc: 2.5, bodyweight: true, side: true,
        }],
      },
    }],
  }), validOptions);
  assert.equal(verdict.ok, true);
  const after = verdict.block.changes[0].after;
  assert.equal(after.name, 'Upper');
  assert.equal(after.emoji, 'figureStrength');
  assert.equal(after.prog, 'linear');
  assert.deepEqual(after.ex, [{
    id: 'barbell-bench-press', name: 'Bench Press', sets: 4, mode: 'reps',
    reps: 8, repsMin: 6, repsMax: 10, setsMax: 5, sec: 45, min: 20, speed: 9.5,
    prog: 'linear', inc: 2.5, bodyweight: true, side: true,
  }]);
});

test('add-routine after.ex accepts the exId alias and drops entries with no id', () => {
  const verdict = validateGenUIBlock(proposalBlock({
    changes: [{
      id: 'gc1', type: 'add-routine', target: {}, why: 'x',
      after: {
        name: 'Upper',
        ex: [
          { exId: 'barbell-bench-press', sets: 3, reps: 10 },
          { name: 'No id at all', sets: 3 },
          null,
        ],
      },
    }],
  }), validOptions);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.block.changes[0].after.ex, [
    { id: 'barbell-bench-press', sets: 3, reps: 10 },
  ]);
});

test('add-routine after.weekdays dedupes and keeps only distinct weekdays 0-6', () => {
  const weekdaysOf = weekdays => validateGenUIBlock(proposalBlock({
    changes: [{
      id: 'gc1', type: 'add-routine', target: {}, why: 'x',
      after: { name: 'Upper', weekdays, ex: [{ id: 'barbell-bench-press' }] },
    }],
  }), validOptions).block?.changes[0].after.weekdays;
  assert.deepEqual(weekdaysOf([1, 3, 1, 9, -1, 'x', 6, 6]), [1, 3, 6]);
  assert.equal(weekdaysOf([7, -1, 'x']), undefined, 'nothing valid means the field is omitted');
  assert.equal(weekdaysOf('mon'), undefined, 'a non-array is ignored');
});

test('add-routine without a name or without a valid exercise is rejected', () => {
  const withAfter = after => validateGenUIBlock(proposalBlock({
    changes: [{ id: 'gc1', type: 'add-routine', target: {}, why: 'x', after }],
  }), validOptions);
  assert.equal(withAfter({ ex: [{ id: 'barbell-bench-press' }] }).ok, false);
  assert.equal(withAfter({ name: '   ', ex: [{ id: 'barbell-bench-press' }] }).ok, false);
  assert.equal(withAfter({ name: 'Upper', ex: [] }).ok, false);
  assert.equal(withAfter({ name: 'Upper', ex: [{ sets: 3 }, { name: 'no id' }] }).ok, false, 'entries without ids leave nothing to add');
  assert.equal(withAfter({ name: 'Upper' }).ok, false);
});

test('fallback_notice needs real text', () => {
  assert.equal(validateGenUIBlock({ type: 'fallback_notice' }).ok, false);
  assert.equal(validateGenUIBlock({ type: 'fallback_notice', text: '   ' }).ok, false);
  assert.equal(validateGenUIBlock({ type: 'not_a_block' }).ok, false);
  assert.equal(validateGenUIBlock(null).ok, false);
  assert.equal(validateGenUIBlock('exercise_trend').ok, false);
});

/* -------------------------------- sanitizer -------------------------------- */

test('sanitizeGenUIBlocks caps a long list at MAX_GENUI_BLOCKS', () => {
  const input = Array.from({ length: MAX_GENUI_BLOCKS + 4 }, (_, index) => muscleBlock({ id: `blk_muscle_${index + 1}` }));
  const result = sanitizeGenUIBlocks(input, validOptions);
  assert.equal(result.blocks.length, MAX_GENUI_BLOCKS);
  assert.ok(result.warnings.some(warning => warning.includes('capped')));
  assert.deepEqual(result.blocks.map(block => block.id), input.slice(0, 6).map(block => block.id));
});

test('a hallucinated exId degrades to one concise fallback notice', () => {
  const result = sanitizeGenUIBlocks([
    trendBlock({ id: 'blk_trend_1', exId: 'invented-exercise' }),
    { id: 'blk_alt_1', type: 'exercise_alternatives', items: [{ exId: 'another-ghost', reason: 'fake' }] },
    { id: 'blk_unknown_1', type: 'made_up_widget' },
    trendBlock({ id: 'blk_trend_2' }),
  ], validOptions);

  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].type, 'fallback_notice');
  assert.equal(result.blocks[0].text, GENUI_FALLBACK_TEXT);
  assert.equal(result.blocks[1].type, 'exercise_trend');
  assert.equal(result.blocks[1].id, 'blk_trend_2');
  assert.equal(result.warnings.length, 3, 'each dropped block is still reported');
});

test('sanitizeGenUIBlocks never throws and drops empty entries', () => {
  assert.deepEqual(sanitizeGenUIBlocks(null), { blocks: [], warnings: [] });
  assert.deepEqual(sanitizeGenUIBlocks(undefined), { blocks: [], warnings: [] });
  assert.equal(sanitizeGenUIBlocks('not an array').blocks.length, 0);
  assert.equal(sanitizeGenUIBlocks('not an array').warnings.length, 1);

  const empties = sanitizeGenUIBlocks([null, undefined, '', [], {}]);
  assert.deepEqual(empties.blocks, []);
  assert.deepEqual(empties.warnings, []);

  const single = sanitizeGenUIBlocks(trendBlock(), validOptions);
  assert.equal(single.blocks.length, 1);
  assert.equal(single.blocks[0].type, 'exercise_trend');
  assert.ok(single.warnings.some(warning => warning.includes('not an array')));
});

test('sanitizeGenUIBlocks makes duplicate and generated ids unique', () => {
  const result = sanitizeGenUIBlocks([
    trendBlock({ id: 'same' }),
    trendBlock({ id: 'same', exId: 'cable-fly' }),
    muscleBlock({ id: '' }),
    muscleBlock({ id: '' }),
  ], validOptions);
  assert.equal(result.blocks.length, 4);
  assert.equal(new Set(result.blocks.map(block => block.id)).size, 4);
});

/* ------------------------------ output parsing ----------------------------- */

test('parseCoachGenUIOutput reads fenced JSON and sanitizes its blocks', () => {
  const answer = {
    text: 'Your bench has been flat for three weeks.',
    blocks: [trendBlock(), { ...muscleBlock(), focusMuscles: ['chest', 'invented-muscle'] }],
  };
  const raw = `Here is the read:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``;
  const parsed = parseCoachGenUIOutput(raw, { validExIds: EX_IDS, validMuscles: VALID_MUSCLES });
  assert.equal(parsed.text, answer.text);
  assert.equal(parsed.blocks.length, 2);
  assert.deepEqual(parsed.blocks[0], validateGenUIBlock(trendBlock(), validOptions).block);
  assert.deepEqual(parsed.blocks[1].focusMuscles, ['chest']);
});

test('plain-text and malformed model replies fall back to text only', () => {
  const prose = 'Keep benching and sleep more.';
  const plain = parseCoachGenUIOutput(prose, { validExIds: EX_IDS });
  assert.equal(plain.text, prose);
  assert.deepEqual(plain.blocks, []);
  assert.ok(plain.warnings.some(warning => warning.includes('plain text')));

  const broken = '{"text": "Bench is flat", "blocks": [';
  const malformed = parseCoachGenUIOutput(broken, { validExIds: EX_IDS });
  assert.equal(malformed.text, broken);
  assert.deepEqual(malformed.blocks, []);
  assert.ok(malformed.warnings.length >= 1);

  const empty = parseCoachGenUIOutput('   ');
  assert.equal(empty.text, '');
  assert.deepEqual(empty.blocks, []);
  assert.ok(empty.warnings.length >= 1);
});

test('parseCoachGenUIOutput accepts objects and ModelOutput structured answers', () => {
  const direct = parseCoachGenUIOutput({ text: 'Try an incline press.', blocks: [alternativesBlock()] }, { validExIds: EX_IDS });
  assert.equal(direct.text, 'Try an incline press.');
  assert.equal(direct.blocks[0].type, 'exercise_alternatives');

  const structured = parseCoachGenUIOutput({
    text: '',
    structured: { text: 'Structured answer.', blocks: [trendBlock()] },
  }, { validExIds: EX_IDS });
  assert.equal(structured.text, 'Structured answer.');
  assert.equal(structured.blocks[0].type, 'exercise_trend');

  const jsonInText = parseCoachGenUIOutput({
    text: '{"text":"JSON in the text field","blocks":[]}',
  });
  assert.equal(jsonInText.text, 'JSON in the text field');

  const unknown = parseCoachGenUIOutput({ foo: 'bar' });
  assert.equal(unknown.text, '{"foo":"bar"}');
  assert.deepEqual(unknown.blocks, []);
  assert.ok(unknown.warnings.some(warning => warning.includes('no text or blocks')));
});

test('parseCoachGenUIOutput degrades degraded blocks without dropping the text', () => {
  const parsed = parseCoachGenUIOutput({
    text: 'Here is what I see.',
    blocks: [trendBlock({ exId: 'invented-exercise' }), muscleBlock()],
  }, { validExIds: EX_IDS });
  assert.equal(parsed.text, 'Here is what I see.');
  assert.equal(parsed.blocks.length, 2);
  assert.equal(parsed.blocks[0].type, 'fallback_notice');
  assert.equal(parsed.blocks[1].type, 'muscle_load');
  assert.ok(parsed.warnings.length >= 1);
});

/* -------------------------------- fixtures -------------------------------- */

function assertBlocksValidate(response, options = validOptions) {
  for (const block of response.blocks) {
    const verdict = validateGenUIBlock(block, options);
    assert.equal(verdict.ok, true, `${block.type} fixture block should validate: ${verdict.reason}`);
  }
}

function idsNotInRoutine(routine, ids) {
  const used = new Set((routine.ex || []).map(exercise => exercise.id));
  for (const id of ids) assert.equal(used.has(id), false, `${id} is already in the routine`);
}

test('bench stall fixture returns trend, load, two real swaps and a safe proposal', () => {
  const response = buildFixtureGenUIResponse({
    question: 'My bench press has stalled for three weeks. Should I swap it out?',
    plan: PLAN,
    validExIds: EX_IDS,
  });

  assert.deepEqual(response.blocks.map(block => block.type), [
    'exercise_trend',
    'muscle_load',
    'exercise_alternatives',
    'proposal_action',
  ]);
  assertBlocksValidate(response);

  const trend = response.blocks[0];
  assert.equal(trend.exId, 'barbell-bench-press');
  assert.equal(trend.weeks, 8);

  const load = response.blocks[1];
  assert.equal(load.window, '72h');

  const alternatives = response.blocks[2];
  assert.equal(alternatives.items.length, 2);
  idsNotInRoutine(PLAN.routines[0], alternatives.items.map(item => item.exId));
  for (const item of alternatives.items) assert.ok(EX_IDS.includes(item.exId), `${item.exId} is a real id`);

  const proposal = response.blocks[3];
  const [change] = proposal.changes;
  assert.equal(change.type, 'swap-exercise');
  assert.deepEqual(change.target, { routineId: 'r1', exId: 'barbell-bench-press' });
  assert.equal(typeof change.before, 'string');
  assert.equal(change.after.id, alternatives.items[0].exId);
  assert.ok(change.why.length > 0);
  assert.match(response.text, /flat|plateau/i);
});

test('a vague pain question asks with quick_form plus 72h load instead of guessing', () => {
  const response = buildFixtureGenUIResponse({
    question: 'My shoulder aches when I press overhead. What should I do?',
    plan: PLAN,
    validExIds: EX_IDS,
  });

  assert.deepEqual(response.blocks.map(block => block.type), ['quick_form', 'muscle_load']);
  assertBlocksValidate(response);

  const form = response.blocks[0];
  assert.equal(form.formId, 'pain_triage');
  assert.deepEqual(form.fields.map(field => field.kind), ['single_choice', 'scale', 'multi_choice']);
  assert.equal(form.fields[0].name, 'painArea');
  assert.equal(form.fields[1].min, 1);
  assert.equal(form.fields[1].max, 10);
  assert.equal(form.fields[2].name, 'availableEquipment');

  assert.equal(response.blocks[1].window, '72h');
  assert.ok(response.blocks.every(block => block.type !== 'proposal_action'));

  const chinese = buildFixtureGenUIResponse({ question: '肩膀有点痛，今天还能练吗？', plan: PLAN, validExIds: EX_IDS });
  assert.equal(chinese.blocks[0].type, 'quick_form');
});

test('bench + shoulder pain is specific context, so it stays on the analysis path', () => {
  const response = buildFixtureGenUIResponse({
    question: 'My shoulder hurts when I bench and my bench is stalled.',
    plan: PLAN,
    validExIds: EX_IDS,
  });
  assert.equal(response.blocks[0].type, 'exercise_trend');
  assert.ok(response.blocks.some(block => block.type === 'proposal_action'));
});

test('a submitted quick form produces a targeted swap proposal', () => {
  const response = buildFixtureGenUIResponse({
    plan: PLAN,
    validExIds: EX_IDS,
    formSubmission: {
      formId: 'pain_triage',
      answers: { painArea: 'front_shoulder', intensity: 6, availableEquipment: ['dumbbells'] },
    },
  });

  assert.deepEqual(response.blocks.map(block => block.type), ['exercise_alternatives', 'proposal_action']);
  assertBlocksValidate(response);
  assert.match(response.text, /front shoulder/i);
  assert.match(response.text, /6\/10/);

  const alternatives = response.blocks[0];
  assert.equal(alternatives.items.length, 2);
  idsNotInRoutine(PLAN.routines[0], alternatives.items.map(item => item.exId));

  const proposal = response.blocks[1];
  const [change] = proposal.changes;
  assert.equal(change.type, 'swap-exercise');
  assert.equal(change.target.routineId, 'r1');
  assert.equal(change.target.exId, 'barbell-bench-press');
  assert.equal(change.after.id, alternatives.items[0].exId);
  assert.ok(change.before && change.why);
});

test('fixture generation is deterministic and safe without a plan', () => {
  const input = { question: 'Is my squat progressing?', plan: PLAN, validExIds: EX_IDS };
  assert.equal(JSON.stringify(buildFixtureGenUIResponse(input)), JSON.stringify(buildFixtureGenUIResponse(input)));

  const noPlan = buildFixtureGenUIResponse({ question: 'How is my bench?', validExIds: EX_IDS });
  assert.equal(noPlan.blocks[0].type, 'exercise_trend');
  assert.equal(noPlan.blocks[0].exId, 'barbell-bench-press');
  assertBlocksValidate(noPlan);

  const nothing = buildFixtureGenUIResponse();
  assert.equal(typeof nothing.text, 'string');
  assert.ok(nothing.text.length > 0);
  for (const block of nothing.blocks) {
    assert.equal(validateGenUIBlock(block).ok, true, `${block.type} should stand alone`);
  }
});

/* ------------------------------- task contract ----------------------------- */

test('createCoachGenUITask returns a contracts-compatible definition', () => {
  const task = createCoachGenUITask();
  assert.equal(task.id, COACH_GENUI_TASK_ID);
  assert.equal(COACH_GENUI_TASK_ID, 'coach-genui.v1');
  assert.equal(task.version, 1);
  assert.equal(task.outputFormat, 'json');
  assert.ok(Array.isArray(task.steps) && task.steps.length >= 1);
  assert.deepEqual(task.steps[0], { id: 'model' });
  assert.deepEqual(task.targetScope({}), []);
  assert.deepEqual(task.capabilities({}), ['text']);
  assert.ok(COACH_GENUI_SYSTEM_PROMPT.includes('Data hydration'));
  assert.ok(COACH_GENUI_SYSTEM_PROMPT.includes('exercise_trend'));
  assert.ok(COACH_GENUI_SYSTEM_PROMPT.includes('NDJSON'));
  assert.ok(COACH_GENUI_SYSTEM_PROMPT.includes('one JSON object per line'));
  assert.ok(COACH_GENUI_SYSTEM_PROMPT.includes('single-column'));
  assert.ok(COACH_GENUI_SYSTEM_PROMPT.toLowerCase().includes('never write a "value"'));
  for (const type of Object.values(GENUI_NODE_TYPES)) {
    if (type === GENUI_NODE_TYPES.CHECKLIST) continue;
    assert.ok(COACH_GENUI_SYSTEM_PROMPT.includes(type), `prompt should teach ${type}`);
  }
  assert.equal(COACH_GENUI_SYSTEM_PROMPT, buildCoachGenUISystemPrompt());
  assert.match(buildCoachGenUISystemPrompt({ maxVisuals: 3 }), /At most 3 heavy visual/);
  assert.match(buildCoachGenUISystemPrompt({ maxVisuals: 99 }), /At most 4 heavy visual/);

  // v2.1 free composition: any mix, or prose alone, with no forced chart/checklist recipe.
  const prompt = buildCoachGenUISystemPrompt();
  assert.match(prompt, /FULL freedom to choose any mix of prose and UI components/);
  assert.match(prompt, /pure\s+prose alone/);
  assert.match(prompt, /Always obey explicit user preferences/);
  assert.match(prompt, /search_catalogue\(\{ queries, equipment\?, bodyParts\?, limit\? \}\) FIRST/);
  assert.match(prompt, /Never guess an exercise id/);
  assert.match(prompt, /## Light scenario recommendations/);
  assert.match(prompt, /soft guidance, NOT hard rules/);
  assert.match(prompt, /NEVER invent an exercise id/);
  assert.match(prompt, /NEVER write a "value" field/);
  // No checklist widget schema, no fixed node count and no single-chart mandate.
  assert.doesNotMatch(prompt, /"type"\s*:\s*"checklist"/);
  assert.doesNotMatch(prompt, /Aim for 3-6 nodes total/);
  assert.doesNotMatch(prompt, /choose the one chart that matters most/i);

  // The visual cap is opt-in: only an explicit maxVisuals adds the budget section.
  assert.doesNotMatch(prompt, /## Visual budget/);
  assert.doesNotMatch(prompt, /At most \d+ heavy visual/);
  assert.match(buildCoachGenUISystemPrompt({ maxVisuals: 2 }), /## Visual budget/);
  assert.match(buildCoachGenUISystemPrompt({ maxVisuals: 2 }), /At most 2 heavy visual/);

  const reorderVerdict = validateGenUINode({
    id: 'prop_reorder',
    type: 'proposal_action',
    title: 'Reorder Push Day',
    summary: 'Put incline press first.',
    changes: [{
      id: 'c1',
      type: 'reorder',
      target: { routineId: 'rt_push' },
      after: ['0047', '0025', '0251'],
      why: 'Prioritize fresh incline pressing.',
    }],
  });
  assert.equal(reorderVerdict.ok, true);
  assert.deepEqual(reorderVerdict.node.changes[0].after, ['0047', '0025', '0251']);
});

test('the task validates input, teaches real ids and parses output safely', () => {
  const task = createCoachGenUITask();
  assert.doesNotThrow(() => task.validateInput({ question: 'How is bench?' }));
  assert.throws(() => task.validateInput({ question: 42 }), /question/);
  assert.throws(() => task.validateInput({ formSubmission: 'nope' }), /formSubmission/);
  assert.throws(() => task.validateInput({ validExIds: 'nope' }), /validExIds/);

  const instructions = task.instructions({ question: 'How is bench?', validExIds: EX_IDS, plan: PLAN, today: '2026-11-25' });
  assert.ok(instructions.startsWith(COACH_GENUI_SYSTEM_PROMPT));
  assert.match(instructions, /barbell-bench-press/);
  assert.match(instructions, /## Current plan/);
  assert.match(instructions, /2026-11-25/);

  const withoutIds = task.instructions({ question: 'hi' });
  assert.match(withoutIds, /use search_catalogue before naming any exercise/);

  assert.equal(task.userText({ question: '  How is bench?  ' }), 'How is bench?');
  assert.match(task.userText({ formSubmission: { answers: { painArea: 'knee' } } }), /quick_form answers/);

  const parsed = task.parseOutput(
    { text: 'Plain answer.' },
    { request: { input: { validExIds: EX_IDS } } },
  );
  assert.equal(parsed.text, 'Plain answer.');
  assert.deepEqual(parsed.blocks, []);
  assert.ok(isValid(task.outputSchema, parsed));

  const degraded = task.parseOutput(
    { text: '', structured: { text: 'Fallback', blocks: [trendBlock({ exId: 'invented-exercise' })] } },
    { request: { input: { validExIds: EX_IDS } } },
  );
  assert.equal(degraded.blocks[0].type, 'fallback_notice');
  assert.ok(isValid(task.outputSchema, degraded));

  const assistant = task.assistantMessage({ structured: { text: 'Hi', blocks: [trendBlock()] } });
  assert.equal(JSON.parse(assistant.content).text, 'Hi');
  assert.equal(assistant.meta.blocks, 1);
});

/* ================================ v2 nodes ================================ */

test('validateGenUINode delegates the six legacy block types', () => {
  for (const block of [trendBlock(), muscleBlock(), alternativesBlock(), formBlock(), proposalBlock()]) {
    const verdict = validateGenUINode(block, validOptions);
    assert.equal(verdict.ok, true, `${block.type} should validate as a node`);
    assert.deepEqual(verdict.node, validateGenUIBlock(block, validOptions).block);
  }
  const notice = validateGenUINode({ id: 'n1', type: 'fallback_notice', text: 'No visual.' });
  assert.equal(notice.ok, true);
  assert.equal(notice.node.type, 'fallback_notice');
  assert.equal(validateGenUINode({ type: 'made_up' }).ok, false);
  assert.equal(validateGenUINode(null).ok, false);
});

test('prose trims, truncates and ignores an invalid tone', () => {
  const verdict = validateGenUINode({ id: 'p1', type: 'prose', text: '  Hello  ', tone: 'lead' });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.node, { id: 'p1', type: 'prose', text: 'Hello', tone: 'lead' });

  const plain = validateGenUINode({ type: 'prose', text: 'No id' });
  assert.equal(plain.node.id, 'prose_1');
  assert.equal('tone' in plain.node, false);

  const badTone = validateGenUINode({ type: 'prose', text: 'x', tone: 'shout' });
  assert.equal(badTone.ok, true);
  assert.equal('tone' in badTone.node, false);

  const long = validateGenUINode({ type: 'prose', text: 'x'.repeat(400) });
  assert.equal(long.node.text.length, 280);

  assert.equal(validateGenUINode({ type: 'prose', text: '   ' }).ok, false);
  assert.equal(validateGenUINode({ type: 'prose' }).ok, false);
});

test('kpi_strip strips model-written values and hydrates only from ids', () => {
  const verdict = validateGenUINode({
    id: 'kpi_1',
    type: 'kpi_strip',
    items: [
      { kind: 'exercise_stat', exId: 'barbell-bench-press', metric: 'volume', weeks: 99, value: 140, label: 'Bench' },
      { kind: 'muscle_sets', muscle: 'CHEST', window: '7d', value: 12 },
      { kind: 'session_count', weeks: 0, value: 99 },
      { kind: 'prescription', label: 'Top set', value: '4x8' },
      { kind: 'prescription', label: 'Backoff', value: 'RIR 2' },
    ],
  }, validOptions);

  assert.equal(verdict.ok, true);
  assert.equal(verdict.node.items.length, 4, 'items are capped at four');
  const [stat, muscle, sessions, prescription] = verdict.node.items;

  assert.equal(stat.metric, 'volume');
  assert.equal(stat.weeks, 24);
  assert.equal(stat.label, 'Bench');
  assert.equal('value' in stat, false, 'exercise_stat must never keep a value');

  assert.equal(muscle.muscle, 'chest');
  assert.equal(muscle.window, '7d');
  assert.equal('value' in muscle, false, 'muscle_sets must never keep a value');

  assert.equal(sessions.weeks, 1);
  assert.equal('value' in sessions, false, 'session_count must never keep a value');

  assert.deepEqual(prescription, { kind: 'prescription', label: 'Top set', value: '4x8' });
});

test('kpi_strip rejects ghost ids, invalid kinds and an empty result', () => {
  const ghost = validateGenUINode({
    type: 'kpi_strip',
    items: [
      { kind: 'exercise_stat', exId: 'invented-exercise' },
      { kind: 'muscle_sets', muscle: 'made-up-muscle' },
    ],
  }, validOptions);
  assert.equal(ghost.ok, false);
  assert.match(ghost.reason, /at least one/);

  const partial = validateGenUINode({
    type: 'kpi_strip',
    items: [
      { kind: 'exercise_stat', exId: 'invented-exercise' },
      { kind: 'session_count', weeks: 4 },
      { kind: 'nonsense', value: 1 },
      null,
    ],
  }, validOptions);
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.node.items.map(item => item.kind), ['session_count']);

  const noValueOnly = validateGenUINode({
    type: 'kpi_strip',
    items: [{ kind: 'prescription', label: 'Top set' }],
  });
  assert.equal(noValueOnly.ok, false, 'prescription needs both label and value');

  assert.equal(validateGenUINode({ type: 'kpi_strip', items: [] }).ok, false);
});

test('comparison_table aligns rows, resolves exIds and drops bad rows', () => {
  const verdict = validateGenUINode({
    id: 'cmp_1',
    type: 'comparison_table',
    title: 'Shoulder stress',
    columns: ['Movement', 'Load', 3, ''],
    rows: [
      ['Bench', { exId: 'cable-fly', note: 'constant tension' }],
      [{ exId: 'invented-exercise' }, 'dropped row'],
      ['Only one cell'],
      'not a row',
      [42, 'dropped cell'],
    ],
  }, validOptions);

  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.node.columns, ['Movement', 'Load']);
  assert.equal(verdict.node.rows.length, 2, 'ghost and malformed rows are dropped');
  assert.deepEqual(verdict.node.rows[0], ['Bench', { exId: 'cable-fly', note: 'constant tension' }]);
  assert.deepEqual(verdict.node.rows[1], ['Only one cell', '']);

  const tooFewColumns = validateGenUINode({ type: 'comparison_table', columns: ['A'], rows: [['x']] });
  assert.equal(tooFewColumns.ok, false);

  const noRows = validateGenUINode({ type: 'comparison_table', columns: ['A', 'B'], rows: [{ exId: 'x' }] });
  assert.equal(noRows.ok, false);
});

test('checklist defaults ids, deduplicates within the list and rejects empties', () => {
  const verdict = validateGenUINode({
    id: 'chk_1',
    type: 'checklist',
    listId: 'shoulder-warmup',
    title: 'Warm-up',
    items: [
      { label: 'Band pull-apart' },
      { id: 'same', label: 'Wall slide' },
      { id: 'same', label: 'Scap push-up' },
      { label: '   ' },
      42,
    ],
  });

  assert.equal(verdict.ok, true);
  assert.equal(verdict.node.listId, 'shoulder-warmup');
  assert.equal(verdict.node.title, 'Warm-up');
  assert.equal(verdict.node.items.length, 3);
  assert.equal(verdict.node.items[0].id, 'item_1');
  assert.equal(new Set(verdict.node.items.map(item => item.id)).size, 3);
  assert.ok(verdict.node.items.every(item => item.id !== ''));

  const defaults = validateGenUINode({ id: 'chk_2', type: 'checklist', items: [{ label: 'One step' }] });
  assert.equal(defaults.node.listId, 'chk_2');
  assert.equal(validateGenUINode({ type: 'checklist', items: [{ label: '  ' }] }).ok, false);
});

test('callout defaults its variant and requires text', () => {
  const verdict = validateGenUINode({ type: 'callout', variant: 'weird', text: '  Keep it light  ', title: 'Note' });
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.node, {
    id: 'callout_1',
    type: 'callout',
    variant: 'info',
    text: 'Keep it light',
    title: 'Note',
  });

  const warning = validateGenUINode({ type: 'callout', variant: 'warning', text: 'Back off' });
  assert.equal(warning.node.variant, 'warning');
  assert.equal(validateGenUINode({ type: 'callout', text: '   ' }).ok, false);
  assert.equal(validateGenUINode({ type: 'callout' }).ok, false);
});

test('sanitizeGenUINodes only caps heavy visuals when a maxVisuals budget is explicit', () => {
  const visuals = [trendBlock({ id: 't1' }), muscleBlock({ id: 'm1' }), trendBlock({ id: 't2' })];
  const heavyDrops = result => result.warnings.filter(warning => warning.includes('heavy visual'));

  // v2.1 default: no explicit budget, so every heavy visual commits (up to the node cap).
  const unrestricted = sanitizeGenUINodes(visuals, validOptions);
  assert.deepEqual(unrestricted.nodes.map(node => node.id), ['t1', 'm1', 't2']);
  assert.equal(heavyDrops(unrestricted).length, 0);

  const nullBudget = sanitizeGenUINodes(visuals, { ...validOptions, maxVisuals: null });
  assert.deepEqual(nullBudget.nodes.map(node => node.id), ['t1', 'm1', 't2'], 'null means unrestricted');
  assert.equal(nullBudget.nodes.some(node => node.type === 'fallback_notice'), false);

  // Explicit budgets cap (and clamp) the heavy visuals without adding fallback notices.
  const none = sanitizeGenUINodes(visuals, { ...validOptions, maxVisuals: 0 });
  assert.deepEqual(none.nodes, []);
  assert.equal(heavyDrops(none).length, 3);
  assert.equal(none.nodes.some(node => node.type === 'fallback_notice'), false);

  const one = sanitizeGenUINodes(visuals, { ...validOptions, maxVisuals: 1 });
  assert.deepEqual(one.nodes.map(node => node.id), ['t1']);
  assert.equal(heavyDrops(one).length, 2);

  const two = sanitizeGenUINodes(visuals, { ...validOptions, maxVisuals: 2 });
  assert.deepEqual(two.nodes.map(node => node.id), ['t1', 'm1']);

  const clamped = sanitizeGenUINodes(visuals, { ...validOptions, maxVisuals: 99 });
  assert.equal(clamped.nodes.length, 3, 'maxVisuals is clamped to four');
  assert.equal(clamped.nodes.some(node => node.type === 'fallback_notice'), false);
});

test('sanitizeGenUINodes caps total nodes and drops invalid ones with warnings', () => {
  const long = Array.from({ length: MAX_GENUI_NODES + 2 }, (_, index) => ({
    id: `p${index + 1}`,
    type: 'prose',
    text: `paragraph ${index + 1}`,
  }));
  const capped = sanitizeGenUINodes(long);
  assert.equal(MAX_GENUI_NODES, 12);
  assert.equal(capped.nodes.length, MAX_GENUI_NODES);
  assert.ok(capped.warnings.some(warning => warning.includes('capped')));

  const explicit = sanitizeGenUINodes(long, { maxNodes: 3 });
  assert.equal(explicit.nodes.length, 3);

  const mixed = sanitizeGenUINodes([
    { type: 'prose', text: 'ok' },
    { type: 'kpi_strip', items: [] },
    { type: 'made_up' },
    null,
  ], validOptions);
  assert.equal(mixed.nodes.length, 1);
  assert.equal(mixed.warnings.length, 2);
  assert.equal(mixed.nodes.some(node => node.type === 'fallback_notice'), false);
});

test('v1ToGenUINodes splits long prose and appends real blocks', () => {
  const longText = 'This is a sentence about training. '.repeat(20);
  const nodes = v1ToGenUINodes(longText, [muscleBlock()]);

  assert.ok(nodes.length >= 2);
  const prose = nodes.filter(node => node.type === 'prose');
  assert.ok(prose.length >= 1);
  assert.ok(prose.every(node => node.text.length > 0 && node.text.length <= 280));
  assert.equal(nodes.at(-1).type, 'muscle_load');
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
  for (const node of nodes) assert.equal(validateGenUINode(node).ok, true);

  const empty = v1ToGenUINodes('   ', [muscleBlock()]);
  assert.deepEqual(empty.map(node => node.type), ['muscle_load']);
});

/* ============================ NDJSON streaming ============================ */

function collect(wire, chunkSize) {
  const parser = createNdjsonNodeParser();
  const events = [];
  if (!chunkSize) {
    events.push(...parser.push(wire));
  } else {
    for (let index = 0; index < wire.length; index += chunkSize) {
      events.push(...parser.push(wire.slice(index, index + chunkSize)));
    }
  }
  events.push(...parser.flush());
  return events;
}

const joinedDeltas = events => events
  .filter(event => event.kind === 'prose_delta')
  .map(event => event.delta)
  .join('');

test('the NDJSON parser handles whole, chunked and one-character input', () => {
  const messages = [
    { type: 'prose', id: 'p1', text: '你最近 6 周停在瓶颈 😀' },
    { type: 'kpi_strip', id: 'k1', items: [{ kind: 'session_count', weeks: 4 }] },
    { type: 'exercise_trend', id: 't1', exId: 'barbell-bench-press', weeks: 8 },
    { type: 'prose', id: 'p2', text: '建议加一次干净次数。' },
  ];
  const wire = messages.map(message => JSON.stringify(message)).join('\n') + '\n';

  for (const chunkSize of [0, 1, 3, 17, 4096]) {
    const events = collect(wire, chunkSize);
    const rawNodes = events.filter(event => event.kind === 'node_raw').map(event => event.raw);
    assert.deepEqual(rawNodes.map(node => node.id), ['p1', 'k1', 't1', 'p2'], `chunk size ${chunkSize}`);
    assert.equal(joinedDeltas(events), messages[0].text + messages[3].text, `chunk size ${chunkSize}`);

    const pending = events.filter(event => event.kind === 'node_pending');
    assert.deepEqual(pending.map(event => event.nodeType), ['kpi_strip', 'exercise_trend']);
    assert.equal(pending.filter(event => event.nodeType === 'exercise_trend').length, 1, 'pending fires once');

    for (const raw of events.filter(event => event.kind === 'node_raw')) {
      if (raw.raw.type === 'prose') {
        assert.equal(raw.emittedProseChars, raw.raw.text.length);
      }
    }
  }
});

test('the NDJSON parser batches a whole prose line into one delta per chunk', () => {
  // The model emits one JSON object per line; `{type:prose,text:...}` is the
  // shorthand for this wire form.
  const wire = JSON.stringify({ type: 'prose', text: 'hello world' }) + '\n';
  const events = collect(wire);

  const deltas = events.filter(event => event.kind === 'prose_delta');
  const deltaIndex = events.findIndex(event => event.kind === 'prose_delta');
  const rawIndex = events.findIndex(event => event.kind === 'node_raw');

  assert.equal(deltas.length, 1, 'one line yields one prose_delta, not one per character');
  assert.equal(deltas[0].delta, 'hello world');
  assert.ok(deltaIndex >= 0 && deltaIndex < rawIndex, 'the delta is announced before node_raw');
});

test('the NDJSON parser decodes JSON escapes and never splits a surrogate pair', () => {
  const text = 'quote " backslash \\ newline \n tab \t 中 😀';
  const wire = JSON.stringify({ type: 'prose', id: 'p', text }) + '\n';

  for (const chunkSize of [0, 1, 2]) {
    const events = collect(wire, chunkSize);
    assert.equal(joinedDeltas(events), text);
    for (const event of events.filter(item => item.kind === 'prose_delta')) {
      for (let index = 0; index < event.delta.length; index++) {
        const code = event.delta.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = event.delta.charCodeAt(index + 1);
          assert.ok(next >= 0xdc00 && next <= 0xdfff, 'a delta must not end on a lone high surrogate');
          index++;
        }
      }
    }
  }

  const escaped = '{"type":"prose","id":"p","text":"\\u4E2D\\uD83D\\uDE00"}\n';
  const splitEvents = collect(escaped, 1);
  assert.equal(joinedDeltas(splitEvents), '中😀', 'a \\u escape may be split across chunks');
});

test('the NDJSON parser ignores fences and blank lines', () => {
  const wire = '\n```json\n' + JSON.stringify({ type: 'prose', text: 'fenced' }) + '\n```\n\n';
  const events = collect(wire, 1);
  const rawNodes = events.filter(event => event.kind === 'node_raw');
  assert.equal(rawNodes.length, 1);
  assert.equal(rawNodes[0].raw.text, 'fenced');
  assert.equal(joinedDeltas(events), 'fenced');
  assert.equal(events.filter(event => event.kind === 'malformed_line').length, 0);
});

test('the NDJSON parser recovers from one broken line and keeps the next node', () => {
  const wire = '{"type":"exercise_trend","exId":"barbell-bench-press"\n'
    + JSON.stringify({ type: 'prose', id: 'p2', text: 'after' }) + '\n';

  for (const chunkSize of [0, 1, 5]) {
    const events = collect(wire, chunkSize);
    const malformed = events.filter(event => event.kind === 'malformed_line');
    assert.equal(malformed.length, 1, `chunk size ${chunkSize}`);
    assert.equal(malformed[0].hadPending, true);
    assert.match(malformed[0].rawLine, /exercise_trend/);

    const prose = events.filter(event => event.kind === 'node_raw' && event.raw.type === 'prose');
    assert.equal(prose.length, 1);
    assert.equal(prose[0].raw.text, 'after');
    assert.equal(joinedDeltas(events), 'after');
  }
});

test('the NDJSON parser accepts multi-line JSON and legacy payloads', () => {
  const prettyNode = JSON.stringify({ type: 'prose', id: 'p', text: 'line one line two' }, null, 2) + '\n';
  const nodeEvents = collect(prettyNode, 1);
  const rawNode = nodeEvents.find(event => event.kind === 'node_raw');
  assert.equal(rawNode.raw.text, 'line one line two');
  assert.equal(joinedDeltas(nodeEvents), 'line one line two');

  const legacyWire = '```json\n'
    + JSON.stringify({ text: 'Legacy answer', blocks: [muscleBlock()] }, null, 2)
    + '\n```\n';
  const legacyEvents = collect(legacyWire, 1);
  const legacy = legacyEvents.filter(event => event.kind === 'legacy_payload');
  assert.equal(legacy.length, 1, 'a v1 object is one legacy payload, not pending nodes');
  assert.equal(legacy[0].raw.text, 'Legacy answer');
  assert.equal(legacy[0].raw.blocks[0].type, 'muscle_load');
  assert.equal(legacyEvents.filter(event => event.kind === 'node_pending').length, 0);
  assert.equal(legacyEvents.filter(event => event.kind === 'malformed_line').length, 0);
});

test('the NDJSON parser collects plain text lines', () => {
  const events = collect('Just advice.\nSecond line.\n');
  assert.deepEqual(
    events.filter(event => event.kind === 'plain_text').map(event => event.text),
    ['Just advice.', 'Second line.'],
  );
});

/* ============================== v2 parsing =============================== */

test('parseCoachGenUIOutput parses NDJSON with hydration, budgets and warnings', () => {
  const wire = [
    { type: 'prose', text: 'Bench looks flat.' },
    {
      type: 'kpi_strip',
      items: [
        { kind: 'exercise_stat', exId: 'barbell-bench-press', weeks: 8, value: 140 },
        { kind: 'prescription', label: 'Top set', value: '4x8' },
        { kind: 'session_count', weeks: 4, value: 12 },
      ],
    },
    { type: 'exercise_trend', exId: 'barbell-bench-press', weeks: 8 },
    { type: 'muscle_load', window: '72h', focusMuscles: ['chest'] },
    { type: 'prose', text: 'Add one clean rep.' },
  ].map(node => JSON.stringify(node)).join('\n');

  const parsed = parseCoachGenUIOutput(wire, { ...validOptions, maxVisuals: 2 });
  assert.equal(parsed.text, 'Bench looks flat.\n\nAdd one clean rep.');
  assert.deepEqual(parsed.nodes.map(node => node.type), ['prose', 'kpi_strip', 'exercise_trend', 'muscle_load', 'prose']);
  assert.deepEqual(parsed.blocks.map(block => block.type), ['exercise_trend', 'muscle_load']);

  const kpi = parsed.nodes.find(node => node.type === 'kpi_strip');
  const stat = kpi.items.find(item => item.kind === 'exercise_stat');
  const sessions = kpi.items.find(item => item.kind === 'session_count');
  const prescription = kpi.items.find(item => item.kind === 'prescription');
  assert.equal('value' in stat, false);
  assert.equal('value' in sessions, false);
  assert.equal(prescription.value, '4x8');

  const budget = parseCoachGenUIOutput(wire, { ...validOptions, maxVisuals: 1 });
  assert.equal(budget.nodes.some(node => node.type === 'muscle_load'), false);
  assert.ok(budget.warnings.some(warning => warning.includes('heavy visual')));

  const unrestricted = parseCoachGenUIOutput(wire, validOptions);
  assert.deepEqual(
    unrestricted.nodes.filter(node => GENUI_HEAVY_VISUAL_TYPES.includes(node.type)).map(node => node.type),
    ['exercise_trend', 'muscle_load'],
    'no explicit budget leaves both heavy visuals in place',
  );

  const ghost = parseCoachGenUIOutput(JSON.stringify({ type: 'exercise_trend', exId: 'invented-exercise' }) + '\n', validOptions);
  assert.deepEqual(ghost.nodes, []);
  assert.deepEqual(ghost.blocks, []);
  assert.ok(ghost.warnings.some(warning => warning.includes('unknown exercise id')));
});

test('parseCoachGenUIOutput normalizes v1 JSON into prose plus blocks', () => {
  const payload = { text: 'Legacy text.', blocks: [trendBlock()] };
  const parsed = parseCoachGenUIOutput(JSON.stringify(payload), validOptions);
  assert.equal(parsed.text, 'Legacy text.');
  assert.deepEqual(parsed.blocks.map(block => block.type), ['exercise_trend']);
  assert.deepEqual(parsed.nodes.map(node => node.type), ['prose', 'exercise_trend']);
  assert.equal(parsed.nodes[0].text, 'Legacy text.');

  const objectWithNodes = parseCoachGenUIOutput({
    text: 'Node answer.',
    nodes: [
      { type: 'prose', text: 'Node answer.' },
      { type: 'callout', variant: 'tip', text: 'Keep it easy' },
    ],
    blocks: [],
  }, validOptions);
  assert.equal(objectWithNodes.text, 'Node answer.');
  assert.deepEqual(objectWithNodes.nodes.map(node => node.type), ['prose', 'callout']);
});

test('fixtures return interleaved v2 nodes that always validate', () => {
  const scenarios = [
    { question: 'My bench press has stalled for three weeks. Should I swap it out?', plan: PLAN, validExIds: EX_IDS },
    { question: 'My shoulder aches when I press overhead. What should I do?', plan: PLAN, validExIds: EX_IDS },
    { plan: PLAN, validExIds: EX_IDS, formSubmission: { answers: { painArea: 'front_shoulder', intensity: 6 } } },
    { question: 'How is my bench?', validExIds: EX_IDS },
    {},
  ];

  for (const input of scenarios) {
    const response = buildFixtureGenUIResponse(input);
    assert.ok(Array.isArray(response.nodes));
    assert.ok(response.nodes.length > 0);
    assert.ok(response.nodes.length <= MAX_GENUI_NODES);
    assert.equal(response.nodes[0].type, 'prose');
    assert.equal(response.nodes.at(-1).type, 'prose');
    assert.ok(response.nodes.some(node => node.type !== 'prose'));
    for (const node of response.nodes) {
      const verdict = validateGenUINode(node, validOptions);
      assert.equal(verdict.ok, true, `${node.type} fixture node should validate: ${verdict.reason}`);
    }
    assert.deepEqual(response.blocks, response.blocks.filter(block => GENUI_BLOCK_TYPES[block.type.toUpperCase()] === block.type));
  }

  const stall = buildFixtureGenUIResponse(scenarios[0]);
  assert.match(stall.text, /flat|plateau/i);
  assert.deepEqual(stall.blocks.map(block => block.type), [
    'exercise_trend',
    'muscle_load',
    'exercise_alternatives',
    'proposal_action',
  ]);
  assert.ok(stall.nodes.some(node => node.type === 'exercise_trend'));
  assert.ok(stall.nodes.some(node => node.type === 'kpi_strip'));
  assert.ok(stall.nodes.some(node => node.type === 'proposal_action'));
});
