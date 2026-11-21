import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AgentError,
  BODY_PART_SLUGS,
  EQUIPMENT_SLUGS,
  EXERCISE_SEARCH_MAX_IMAGE_BYTES,
  EXERCISE_SEARCH_PROMPT,
  EXERCISE_SEARCH_TASK_ID,
  bindContext,
  cleanExerciseSearchOutput,
  createExerciseSearchTask,
  createProvider,
  runAgent,
  validateExerciseImages,
  validateExerciseSearchInput,
} from '../agent-runtime/index.js';
import { PNG_1X1_DATA_URL } from './agent-fixtures.mjs';
import { EXDB } from '../../frontend/src/lib/exercises-data.js';

const here = fileURLToPath(new URL('.', import.meta.url));

function pngDataUrl(width, height) {
  const raw = Buffer.from(PNG_1X1_DATA_URL.split(',')[1], 'base64');
  raw.writeUInt32BE(width, 16);
  raw.writeUInt32BE(height, 20);
  return `data:image/png;base64,${raw.toString('base64')}`;
}

function fakeJpegDataUrl(bytes = 32) {
  const raw = Buffer.alloc(bytes, 0x20);
  raw[0] = 0xff;
  raw[1] = 0xd8;
  raw[2] = 0xff;
  return `data:image/jpeg;base64,${raw.toString('base64')}`;
}

function contextFor(task, input, provider = 'fixture', requestId = 'req_exercise_1') {
  return bindContext({
    scope: 'user-1',
    runId: 'run_exercise_1',
    request: { taskId: task.id, requestId, profileId: 'p1', input },
    execution: 'server',
    profileRef: { profileId: 'p1', version: 1, provider, capabilities: { text: true, image: true, tools: false } },
    targetScope: [],
    ids: { evidence: () => 'ev_exercise_1' },
  });
}

function expectCode(fn, code) {
  assert.throws(fn, error => error instanceof AgentError && error.code === code);
}

test('the vocabulary snapshot matches the Web and RN catalogue', () => {
  const webBodyParts = [...new Set(EXDB.map(exercise => exercise.bp).filter(Boolean))].sort();
  const webEquipment = [...new Set(EXDB.map(exercise => exercise.eq).filter(Boolean))].sort();
  assert.deepEqual(webBodyParts, [...BODY_PART_SLUGS].sort());
  assert.deepEqual(webEquipment, [...EQUIPMENT_SLUGS].sort());

  const rn = readFileSync(`${here}../../mobile-rn/src/catalogueData.js`, 'utf8');
  const readArray = name => {
    const start = rn.indexOf(`export const ${name} = [`);
    assert.ok(start >= 0, `${name} missing from mobile-rn/src/catalogueData.js`);
    const end = rn.indexOf('];', start);
    assert.ok(end > start);
    return [...rn.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1]);
  };
  assert.deepEqual(readArray('BODY_PARTS').sort(), [...BODY_PART_SLUGS].sort());
  assert.deepEqual(readArray('EQUIPMENT').sort(), [...EQUIPMENT_SLUGS].sort());
  assert.equal(BODY_PART_SLUGS.length, 11);
  assert.equal(EQUIPMENT_SLUGS.length, 34);
});

test('exercise-search input needs text or an image, at most two images, and 500 chars', () => {
  expectCode(() => validateExerciseSearchInput({}), 'invalid_request');
  expectCode(() => validateExerciseSearchInput({ hintText: '   ' }), 'invalid_request');
  validateExerciseSearchInput({ hintText: 'a' });
  validateExerciseSearchInput({ images: [PNG_1X1_DATA_URL] });
  expectCode(
    () => validateExerciseSearchInput({ images: [PNG_1X1_DATA_URL, PNG_1X1_DATA_URL, PNG_1X1_DATA_URL] }),
    'agent_media_invalid',
  );
  validateExerciseSearchInput({ hintText: 'x'.repeat(500) });
  expectCode(() => validateExerciseSearchInput({ hintText: 'x'.repeat(501) }), 'invalid_request');
});

test('image validation checks data URL, magic bytes, MIME, size, dimensions and labels', () => {
  const one = validateExerciseImages({ images: [PNG_1X1_DATA_URL] });
  assert.equal(one.length, 1);
  assert.equal(one[0].mime, 'image/png');
  assert.equal(one[0].width, 1);
  assert.equal(one[0].height, 1);
  assert.equal(one[0].label, '当前图片');

  const two = validateExerciseImages({ images: [PNG_1X1_DATA_URL, PNG_1X1_DATA_URL] });
  assert.equal(two[1].label, '上一轮图片');

  expectCode(() => validateExerciseImages({ images: ['not-a-data-url'] }), 'agent_media_invalid');
  expectCode(() => validateExerciseImages({ images: [`data:image/png;base64,${Buffer.from('not png').toString('base64')}`] }), 'agent_media_invalid');
  expectCode(() => validateExerciseImages({ images: [fakeJpegDataUrl().replace('data:image/jpeg', 'data:image/png')] }), 'agent_media_invalid');
  expectCode(() => validateExerciseImages({ images: [pngDataUrl(5000, 10)] }), 'agent_media_invalid');
  expectCode(() => validateExerciseImages({ images: [pngDataUrl(4096, 1)] }), 'agent_media_invalid');
  validateExerciseImages({ images: [pngDataUrl(1280, 960)] });

  const big = Buffer.alloc(EXERCISE_SEARCH_MAX_IMAGE_BYTES + 1, 0x11);
  big[0] = 0x89; big[1] = 0x50; big[2] = 0x4e; big[3] = 0x47;
  expectCode(
    () => validateExerciseImages({ images: [`data:image/png;base64,${big.toString('base64')}`] }),
    'agent_media_too_large',
  );
});

test('output cleaning truncates, throws out invalid candidates and builds a safe fallback', () => {
  const cleaned = cleanExerciseSearchOutput({
    candidates: [
      { name: 'Bench Press', rationale: 'barbell and bench', level: 'HIGH' },
      { name: '', rationale: 'missing', level: 'high' },
      { name: 'Bad level', rationale: 'x', level: 'certain' },
      { name: 'A'.repeat(200), rationale: 'R'.repeat(500), level: 'low', equipment: 'not-an-equipment', bodyPart: 'chest' },
      { name: 'Five', rationale: 'x', level: 'medium' },
      { name: 'Six', rationale: 'x', level: 'medium' },
      { name: 'Seven', rationale: 'x', level: 'medium' },
      { name: 'Eight', rationale: 'x', level: 'medium' },
    ],
    fallback: { understanding: '  ', bodyParts: ['chest', 'nope', 'chest'], equipment: ['barbell'] },
  }, { hintText: 'wide grip' });
  assert.equal(cleaned.candidates.length, 5);
  assert.equal(cleaned.candidates[0].level, 'high');
  assert.equal(cleaned.candidates[0].name, 'Bench Press');
  assert.equal(cleaned.candidates[1].name.length, 80);
  assert.equal(cleaned.candidates[1].rationale.length, 200);
  assert.equal(cleaned.candidates[1].equipment, undefined);
  assert.equal(cleaned.fallback.understanding, 'wide grip');
  assert.deepEqual(cleaned.fallback.bodyParts, ['chest']);
  assert.deepEqual(cleaned.fallback.equipment, ['barbell']);

  const fallback = cleanExerciseSearchOutput({ candidates: [], fallback: 'nope' }, {});
  assert.equal(fallback.candidates.length, 0);
  assert.match(fallback.fallback.understanding, /未能理解/);
});

test('parseOutput extracts a fenced/extra-text JSON object and refuses unreadable output', () => {
  const task = createExerciseSearchTask();
  const context = contextFor(task, { hintText: 'test' });
  const output = task.parseOutput({
    text: '```json\n{"candidates":[{"name":"bench press","rationale":"bench","level":"high"}],"fallback":{"understanding":"a bench press"}}\n```',
  }, context);
  assert.equal(output.candidates[0].name, 'bench press');
  assert.equal(output.fallback.understanding, 'a bench press');
  assert.throws(
    () => task.parseOutput({ text: 'no json here' }, context),
    error => error instanceof AgentError && error.code === 'model_unavailable',
  );
});

test('the task declares one JSON model round, no tools, no memories and only the catalogue vocabulary', () => {
  const task = createExerciseSearchTask();
  assert.equal(task.id, EXERCISE_SEARCH_TASK_ID);
  assert.equal(task.outputFormat, 'json');
  assert.deepEqual(task.memoryCategories, []);
  assert.equal(task.budgets.rounds, 1);
  assert.equal(task.budgets.attachments, 2);
  assert.equal(task.steps.length, 1);
  assert.equal(task.steps[0].tools, undefined);
  assert.doesNotThrow(() => task.validateInput({ hintText: 'row' }));
  assert.deepEqual(task.capabilities({ hintText: 'row' }), ['text']);
  assert.deepEqual(task.capabilities({ images: [PNG_1X1_DATA_URL] }), ['text', 'image']);
  assert.equal(task.userMessage({}), '[图片]');
  assert.equal(task.userMessage({ hintText: ' row ' }), 'row');
  assert.deepEqual(task.targetScope({}, {}), []);
  const instructions = task.instructions({}, {});
  assert.ok(instructions.includes('Output is JSON and nothing else'));
  assert.ok(instructions.includes('Never invent, guess or reference catalogue'));
  assert.ok(instructions.includes('## Allowed body part slugs'));
  assert.ok(instructions.includes('## Allowed equipment slugs'));
  assert.ok(instructions.includes('leverage machine'));
  assert.ok(EXERCISE_SEARCH_PROMPT.includes('Output is JSON'));
});

test('fixtureCase only applies to a fixture profile', () => {
  const task = createExerciseSearchTask();
  assert.equal(task.fixtureCase({ fixtureCase: 'candidates' }, { profileRef: { provider: 'fixture' } }), 'candidates');
  assert.equal(task.fixtureCase({ fixtureCase: 'fallback-only' }, { profileRef: { provider: 'fixture' } }), 'fallback-only');
  assert.equal(task.fixtureCase({ fixtureCase: 'candidates' }, { profileRef: { provider: 'openai' } }), undefined);
  assert.equal(task.fixtureCase({}, { profileRef: { provider: 'fixture' } }), 'candidates');
  assert.equal(task.fixtureCase({}, { profileRef: { provider: 'opencode' } }), undefined);
});

test('the fixture provider runs text, image and text+image through exercise-search.v1', async () => {
  for (const [fixtureCase, input] of [
    ['candidates', { hintText: '坐着往上推的器械', fixtureCase: 'candidates' }],
    ['candidates', { hintText: 'fixture defaults to candidates for the UI' }],
    ['fallback-only', { images: [PNG_1X1_DATA_URL], fixtureCase: 'fallback-only' }],
    ['candidates', { hintText: 'seated press', images: [PNG_1X1_DATA_URL], fixtureCase: 'candidates' }],
  ]) {
    const task = createExerciseSearchTask();
    const provider = createProvider('fixture', { fixtureCase });
    const requestId = `req_exercise_${fixtureCase}`;
    const result = await runAgent({
      task,
      request: {
        taskId: task.id,
        requestId,
        profileId: 'p1',
        input,
      },
      context: contextFor(task, input, 'fixture', requestId),
      gateway: {
        invoke: (profileRef, modelInput, signal) => provider.invoke({ profile: profileRef, modelInput, signal }),
      },
    });
    assert.equal(result.status, 'completed');
    assert.ok(Array.isArray(result.structured.candidates));
    assert.equal(typeof result.structured.fallback.understanding, 'string');
  }
});

test('an image-only run reaches the provider with a labelled attachment', async () => {
  const task = createExerciseSearchTask();
  const provider = createProvider('fixture', { fixtureCase: 'fallback-only' });
  let seen = null;
  const input = { images: [PNG_1X1_DATA_URL] };
  await runAgent({
    task,
    request: { taskId: task.id, requestId: 'req_exercise_image', profileId: 'p1', input },
    context: contextFor(task, input, 'fixture', 'req_exercise_image'),
    gateway: {
      invoke: (profileRef, modelInput, signal) => {
        seen = modelInput;
        return provider.invoke({ profile: profileRef, modelInput, signal });
      },
    },
  });
  assert.equal(seen.user.text, '[图片]');
  assert.equal(seen.user.attachments.length, 1);
  assert.equal(seen.user.attachments[0].label, '当前图片');
  assert.equal(seen.user.attachments[0].dataUrl, PNG_1X1_DATA_URL);
});

test('assistantMessage keeps only image metadata, never the data URL', () => {
  const task = createExerciseSearchTask();
  const message = task.assistantMessage({
    result: { structured: { candidates: [{ name: 'row' }], fallback: { understanding: 'row' } } },
  }, { images: [PNG_1X1_DATA_URL] });
  assert.equal(message.meta.candidates, 1);
  assert.equal(message.meta.fallback, true);
  assert.equal(message.meta.images.length, 1);
  assert.equal(message.meta.images[0].mime, 'image/png');
  assert.ok(message.meta.images[0].size > 0);
  assert.equal(JSON.stringify(message).includes('base64'), false);
});

test('the five new stable error codes carry their documented HTTP status', async () => {
  const { ERROR_STATUS } = await import('../agent-runtime/errors.js');
  assert.equal(ERROR_STATUS.agent_media_invalid, 400);
  assert.equal(ERROR_STATUS.agent_media_too_large, 413);
  assert.equal(ERROR_STATUS.turn_limit, 429);
  assert.equal(ERROR_STATUS.session_busy, 409);
  assert.equal(ERROR_STATUS.session_conflict, 409);
});
