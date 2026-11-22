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
import { PNG_1X1, PNG_1X1_DATA_URL } from './agent-fixtures.mjs';
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

function contextFor(task, input, provider = 'fixture', requestId = 'req_exercise_1', meta = {}) {
  return bindContext({
    scope: 'user-1',
    runId: 'run_exercise_1',
    request: { taskId: task.id, requestId, profileId: 'p1', input },
    execution: 'server',
    profileRef: { profileId: 'p1', version: 1, provider, capabilities: { text: true, image: true, tools: false } },
    targetScope: [],
    ids: { evidence: () => 'ev_exercise_1' },
    meta,
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

/* The stub task used by api/test/agent-runtime.test.js: same id and shape,
 * so the diagnostic path can prove other tasks emit nothing. */
function stubTask() {
  return {
    id: 'stub.v1',
    version: 1,
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', minLength: 1 } },
      required: ['prompt'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      additionalProperties: true,
    },
    requiredCapabilities: ['text'],
    budgets: { rounds: 1, toolCalls: 0, contextChars: 20000, historyItems: 2, memoryItems: 2 },
    steps: [{ id: 'model' }],
    targetScope: () => [],
    instructions: () => 'test instructions',
    userText: input => input.prompt,
  };
}

test('a successful fixture run emits attachments, model, recognition and end in order', async () => {
  const task = createExerciseSearchTask();
  const input = { hintText: '坐着往上推的器械', images: [PNG_1X1_DATA_URL], fixtureCase: 'candidates' };
  const provider = createProvider('fixture', { fixtureCase: 'candidates' });
  const events = [];
  let clock = 0;
  const result = await runAgent({
    task,
    request: { taskId: task.id, requestId: 'req_diag_success', profileId: 'p1', input },
    context: contextFor(task, input, 'fixture', 'req_diag_success', {
      exerciseSearchDiagnostic: event => events.push(event),
    }),
    gateway: {
      invoke: (profileRef, modelInput, signal) => provider.invoke({ profile: profileRef, modelInput, signal }),
    },
    now: () => (clock += 10),
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events.map(event => event.stage), ['attachments', 'model', 'recognition', 'end']);
  const [attachments, model, recognition, end] = events;
  assert.deepEqual(attachments.images, [{ mime: 'image/png', width: 1, height: 1, bytes: PNG_1X1.length }]);
  assert.deepEqual(model, { stage: 'model', round: 1, status: 'completed', elapsedMs: 10, toolCalls: 0 });
  assert.equal(recognition.rawCandidateCount, 2);
  assert.equal(recognition.cleanCandidateCount, 2);
  assert.deepEqual(recognition.equipment, ['barbell']);
  assert.deepEqual(recognition.bodyParts, ['shoulders']);
  assert.deepEqual(end, { stage: 'end', status: 'completed', phase: 'recognition', elapsedMs: 30 });
});

test('the recognition event counts raw and cleaned candidates and projects cleaned fallback slugs', async () => {
  const task = createExerciseSearchTask();
  const input = { hintText: 'press' };
  const events = [];
  await runAgent({
    task,
    request: { taskId: task.id, requestId: 'req_diag_recognition', profileId: 'p1', input },
    context: contextFor(task, input, 'fixture', 'req_diag_recognition', {
      exerciseSearchDiagnostic: event => events.push(event),
    }),
    gateway: {
      invoke: async () => ({
        structured: {
          candidates: [
            { name: 'bench press', rationale: 'bench and bar', level: 'high', equipment: 'barbell', bodyPart: 'chest' },
            { name: 'bad level', rationale: 'x', level: 'certain' },
            { name: 'bench press', rationale: 'duplicate name', level: 'low' },
          ],
          fallback: {
            understanding: 'a press',
            bodyParts: ['chest', 'not-a-slug', 'chest'],
            equipment: ['barbell', 'smith machine'],
          },
        },
        toolCalls: [],
      }),
    },
  });
  assert.deepEqual(events.find(event => event.stage === 'recognition'), {
    stage: 'recognition',
    rawCandidateCount: 3,
    cleanCandidateCount: 1,
    bodyParts: ['chest'],
    equipment: ['barbell', 'smith machine'],
  });
});

test('a bad image fails at the attachments phase without calling the model', async () => {
  const task = createExerciseSearchTask();
  const input = { images: [`data:image/png;base64,${Buffer.from('not png').toString('base64')}`] };
  const events = [];
  let invokeCalls = 0;
  await assert.rejects(
    runAgent({
      task,
      request: { taskId: task.id, requestId: 'req_diag_bad_image', profileId: 'p1', input },
      context: contextFor(task, input, 'fixture', 'req_diag_bad_image', {
        exerciseSearchDiagnostic: event => events.push(event),
      }),
      gateway: {
        invoke: async () => {
          invokeCalls++;
          return { text: 'never reached' };
        },
      },
      now: () => 5,
    }),
    error => error instanceof AgentError && error.code === 'agent_media_invalid',
  );
  assert.equal(invokeCalls, 0);
  assert.deepEqual(events.map(event => event.stage), ['end']);
  assert.deepEqual(events[0], {
    stage: 'end',
    status: 'failed',
    phase: 'attachments',
    errorCode: 'agent_media_invalid',
    elapsedMs: 0,
  });
});

test('an unparseable model answer ends at the recognition phase with a safe error code', async () => {
  const task = createExerciseSearchTask();
  const input = { hintText: 'seated press' };
  const events = [];
  await assert.rejects(
    runAgent({
      task,
      request: { taskId: task.id, requestId: 'req_diag_unparseable', profileId: 'p1', input },
      context: contextFor(task, input, 'fixture', 'req_diag_unparseable', {
        exerciseSearchDiagnostic: event => events.push(event),
      }),
      gateway: {
        invoke: async () => ({
          text: 'the model rambled about a mystery machine without any JSON',
          structured: null,
          toolCalls: [],
        }),
      },
      now: () => 5,
    }),
    error => error instanceof AgentError && error.code === 'model_unavailable',
  );
  assert.deepEqual(events.map(event => event.stage), ['attachments', 'model', 'end']);
  assert.deepEqual(events[0], { stage: 'attachments', images: [] });
  assert.deepEqual(events[1], { stage: 'model', round: 1, status: 'completed', elapsedMs: 0, toolCalls: 0 });
  assert.deepEqual(events[2], {
    stage: 'end',
    status: 'failed',
    phase: 'recognition',
    errorCode: 'model_unavailable',
    elapsedMs: 0,
  });
  assert.equal(JSON.stringify(events).includes('the model rambled'), false);
});

test('a provider failure emits a failed model event and a safe failed end', async () => {
  const task = createExerciseSearchTask();
  const input = { hintText: 'seated press' };
  for (const [thrown, expectedCode] of [
    [new AgentError('model_timeout', 'secret provider detail timeout'), 'model_timeout'],
    [new Error('secret provider detail'), 'model_unavailable'],
  ]) {
    const events = [];
    await assert.rejects(
      runAgent({
        task,
        request: { taskId: task.id, requestId: 'req_diag_model_fail', profileId: 'p1', input },
        context: contextFor(task, input, 'fixture', 'req_diag_model_fail', {
          exerciseSearchDiagnostic: event => events.push(event),
        }),
        gateway: {
          invoke: async () => {
            throw thrown;
          },
        },
        now: () => 5,
      }),
      error => error === thrown,
    );
    assert.deepEqual(events.map(event => event.stage), ['attachments', 'model', 'end']);
    assert.deepEqual(events[1], {
      stage: 'model',
      round: 1,
      status: 'failed',
      elapsedMs: 0,
      toolCalls: 0,
      errorCode: expectedCode,
    });
    assert.deepEqual(events[2], {
      stage: 'end',
      status: 'failed',
      phase: 'model',
      errorCode: expectedCode,
      elapsedMs: 0,
    });
    assert.equal(JSON.stringify(events).includes('secret provider detail'), false);
  }
});

test('a non-exercise-search task emits no diagnostic events', async () => {
  const task = stubTask();
  const input = { prompt: 'hello' };
  const events = [];
  const result = await runAgent({
    task,
    request: { taskId: task.id, requestId: 'req_diag_stub', profileId: 'p1', input },
    context: contextFor(task, input, 'fixture', 'req_diag_stub', {
      exerciseSearchDiagnostic: event => events.push(event),
    }),
    gateway: {
      invoke: async () => ({ text: 'stub answer', structured: { text: 'stub answer' }, toolCalls: [] }),
    },
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(events, []);
});

test('running with and without the diagnostic callback produces identical results', async () => {
  const task = createExerciseSearchTask();
  const input = { hintText: '坐着往上推的器械', images: [PNG_1X1_DATA_URL], fixtureCase: 'candidates' };
  const provider = createProvider('fixture', { fixtureCase: 'candidates' });
  const runWith = meta => runAgent({
    task,
    request: { taskId: task.id, requestId: 'req_diag_identical', profileId: 'p1', input },
    context: contextFor(task, input, 'fixture', 'req_diag_identical', meta),
    gateway: {
      invoke: (profileRef, modelInput, signal) => provider.invoke({ profile: profileRef, modelInput, signal }),
    },
  });
  const events = [];
  const traced = await runWith({ exerciseSearchDiagnostic: event => events.push(event) });
  const plain = await runWith({});
  assert.equal(plain.status, traced.status);
  assert.deepEqual(plain.structured, traced.structured);
  assert.deepEqual(plain.usage, traced.usage);
  assert.ok(events.some(event => event.stage === 'end' && event.status === 'completed'));
});

test('a throwing diagnostic sink never breaks the run', async () => {
  const task = createExerciseSearchTask();
  const input = { hintText: '坐着往上推的器械', fixtureCase: 'candidates' };
  const provider = createProvider('fixture', { fixtureCase: 'candidates' });
  const result = await runAgent({
    task,
    request: { taskId: task.id, requestId: 'req_diag_throwing', profileId: 'p1', input },
    context: contextFor(task, input, 'fixture', 'req_diag_throwing', {
      exerciseSearchDiagnostic: () => {
        throw new Error('sink exploded');
      },
    }),
    gateway: {
      invoke: (profileRef, modelInput, signal) => provider.invoke({ profile: profileRef, modelInput, signal }),
    },
  });
  assert.equal(result.status, 'completed');
  assert.ok(Array.isArray(result.structured.candidates));
});
