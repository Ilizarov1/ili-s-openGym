import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  AgentError,
  BODY_PART_SLUGS,
  CATALOGUE_SEARCH_TOOL_ID,
  EQUIPMENT_SLUGS,
  EXERCISE_SEARCH_MAX_IMAGE_BYTES,
  EXERCISE_SEARCH_OUTPUT_SCHEMA,
  EXERCISE_SEARCH_PROMPT,
  EXERCISE_SEARCH_TASK_ID,
  bindContext,
  cleanExerciseSearchOutput,
  createCatalogueSearchTool,
  createDispatcher,
  createExerciseSearchTask,
  createProvider,
  createToolRegistry,
  isExerciseSearchOutput,
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

test('parseOutput and schema accept both fallback-first and candidates-first JSON key orders', () => {
  const task = createExerciseSearchTask();
  const context = contextFor(task, { hintText: 'test' });
  const candidatesFirst = task.parseOutput({
    text: '```json\n{"candidates":[{"name":"bench press","rationale":"bench","level":"high"}],"fallback":{"understanding":"a bench press"}}\n```',
  }, context);
  assert.equal(candidatesFirst.candidates[0].name, 'bench press');
  assert.equal(candidatesFirst.fallback.understanding, 'a bench press');

  const fallbackFirst = task.parseOutput({
    text: '{"fallback":{"understanding":"plate-loaded lever chest press"},"candidates":[{"name":"lever chest press","rationale":"lever arms","level":"high"}]}',
  }, context);
  assert.equal(fallbackFirst.candidates[0].name, 'lever chest press');
  assert.equal(fallbackFirst.fallback.understanding, 'plate-loaded lever chest press');

  assert.equal(isExerciseSearchOutput({
    fallback: { understanding: 'lever arms' },
    candidates: [{ name: 'lever chest press', rationale: 'lever arms', level: 'high' }],
  }), true);
  assert.equal(isExerciseSearchOutput({
    candidates: [{ name: 'lever chest press', rationale: 'lever arms', level: 'high' }],
    fallback: { understanding: 'lever arms' },
  }), true);

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
  assert.deepEqual(Object.keys(EXERCISE_SEARCH_OUTPUT_SCHEMA.properties), ['fallback', 'candidates', 'clarifications']);
  assert.deepEqual(EXERCISE_SEARCH_OUTPUT_SCHEMA.required, ['fallback', 'candidates']);
  const instructions = task.instructions({}, {});
  assert.ok(instructions.includes('Output is JSON and nothing else'));
  assert.ok(instructions.includes('Emit `fallback` first and `candidates` second'));
  assert.ok(instructions.includes('written before `candidates`'));
  assert.ok(instructions.includes('drive mechanism'));
  assert.ok(instructions.includes('clarifications'));
  assert.ok(instructions.includes('Never invent, guess or reference catalogue'));
  assert.ok(instructions.includes('## Allowed body part slugs'));
  assert.ok(instructions.includes('## Allowed equipment slugs'));
  assert.ok(instructions.includes('leverage machine'));
  assert.ok(instructions.includes('lever", "sled" or "cable"'));
  assert.ok(instructions.includes('body-contact pads and driving limb'));
  assert.ok(instructions.includes('strictly consistent with'));
  assert.ok(instructions.includes('return `candidates: []`'));
  assert.ok(instructions.includes('Cap `level` at'));
  assert.ok(instructions.includes('never `high`'));
  assert.ok(EXERCISE_SEARCH_PROMPT.includes('Output is JSON'));
});

test('fixtureCase only applies to a fixture profile', () => {
  const task = createExerciseSearchTask();
  assert.equal(task.fixtureCase({ fixtureCase: 'candidates' }, { profileRef: { provider: 'fixture' } }), 'candidates');
  assert.equal(task.fixtureCase({ fixtureCase: 'fallback-only' }, { profileRef: { provider: 'fixture' } }), 'fallback-only');
  assert.equal(task.fixtureCase({ fixtureCase: 'candidates' }, { profileRef: { provider: 'openai' } }), undefined);
  assert.equal(task.fixtureCase({}, { profileRef: { provider: 'fixture' } }), 'candidates');
  assert.equal(task.fixtureCase({}, { profileRef: { provider: 'deepseek' } }), undefined);
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

test('the compact catalogue snapshot matches EXDB counts, ids, equipment and body parts', () => {
  const snapshot = JSON.parse(readFileSync(`${here}../agent-runtime/tasks/exercise-search-catalogue.json`, 'utf8'));
  assert.equal(snapshot.length, EXDB.length);
  assert.deepEqual(snapshot.map(row => row.id), EXDB.map(row => row.id));
  assert.deepEqual(snapshot.map(row => row.eq), EXDB.map(row => row.eq));
  assert.deepEqual(snapshot.map(row => row.bp), EXDB.map(row => row.bp));
  const allowedKeys = new Set(['a', 'bp', 'eq', 'id', 'n', 'p', 'tg', 'zh']);
  const allowedPostures = new Set(['seated', 'standing', 'supine', 'prone', 'side_lying', 'kneeling', 'bent_over', 'hanging']);
  for (const row of snapshot) {
    for (const key of ['bp', 'eq', 'id', 'n', 'tg', 'zh']) assert.ok(key in row, `missing ${key}`);
    for (const key of Object.keys(row)) assert.ok(allowedKeys.has(key), `unexpected key ${key}`);
    if ('p' in row) assert.ok(allowedPostures.has(row.p), `unexpected posture ${row.p}`);
    if ('a' in row) assert.ok(Array.isArray(row.a) && row.a.every(v => typeof v === 'string' && v.length > 0));
    assert.ok(row.n && row.zh);
  }
});

test('agent-runtime entry and catalogue-search-tool stay Metro-safe with no Node built-ins or static snapshot import', () => {
  const indexSrc = readFileSync(`${here}../agent-runtime/index.js`, 'utf8');
  const toolSrc = readFileSync(`${here}../agent-runtime/tasks/catalogue-search-tool.js`, 'utf8');
  assert.equal(indexSrc.includes('node:'), false);
  assert.equal(indexSrc.includes('exercise-search-catalogue.json'), false);
  assert.equal(toolSrc.includes('node:'), false);
  assert.equal(toolSrc.includes('exercise-search-catalogue.json'), false);
});

test('search_catalogue recalls confusable machine siblings within limit and enforces read-only tool fence', async () => {
  const snapshot = JSON.parse(readFileSync(`${here}../agent-runtime/tasks/exercise-search-catalogue.json`, 'utf8'));
  const beforeLength = snapshot.length;
  const tool = createCatalogueSearchTool({ entries: snapshot });
  assert.equal(tool.id, CATALOGUE_SEARCH_TOOL_ID);
  const registry = createToolRegistry([tool]);
  const task = createExerciseSearchTask();
  const context = contextFor(task, { hintText: 'chest press' });

  const dispatcher = createDispatcher({
    registry,
    context,
    allowedToolIds: [CATALOGUE_SEARCH_TOOL_ID],
    maxCalls: 5,
  });

  // 1. Chest/shoulder/pec-deck family recall includes contrasting siblings within <= 15
  const press = await dispatcher.call(CATALOGUE_SEARCH_TOOL_ID, {
    queries: ['plate-loaded chest press'],
    equipment: ['leverage machine'],
    bodyParts: ['chest'],
    limit: 12,
  });
  assert.ok(press.result.items.length <= 12);
  assert.ok(press.result.total >= press.result.items.length);
  const pressIds = new Set(press.result.items.map(item => item.id));
  assert.ok(pressIds.has('0576'), 'expected lever chest press (0576)');
  assert.ok(pressIds.has('0603'), 'expected confusable sibling lever shoulder press (0603)');
  assert.ok(pressIds.has('1030'), 'expected confusable sibling lever pec deck fly (1030)');

  // 2. Leg extension / curl family recall includes both 0585 and 0599
  const leg = await dispatcher.call(CATALOGUE_SEARCH_TOOL_ID, {
    queries: ['坐姿腿屈伸'],
    bodyParts: ['upper legs'],
  });
  assert.ok(leg.result.items.length <= 12);
  const legIds = new Set(leg.result.items.map(item => item.id));
  assert.ok(legIds.has('0585'), 'expected lever leg extension (0585)');
  assert.ok(legIds.has('0599'), 'expected confusable sibling lever seated leg curl (0599)');

  // 3. Hack squat / leg press / calf raise family recall includes sled & lever variants
  const hack = await dispatcher.call(CATALOGUE_SEARCH_TOOL_ID, {
    queries: ['hack squat', 'leg press'],
    limit: 15,
  });
  assert.ok(hack.result.items.length <= 15);
  const hackIds = new Set(hack.result.items.map(item => item.id));
  assert.ok(hackIds.has('0743'), 'expected sled hack squat (0743)');
  assert.ok(hackIds.has('5516'), 'expected lever hack squat (5516)');
  assert.ok(hackIds.has('0739'), 'expected sled 45° leg press (0739)');
  assert.ok(hackIds.has('2267'), 'expected lever seated leg press (2267)');

  // 4. Non-existent / out-of-catalogue query returns empty without padding
  const empty = await dispatcher.call(CATALOGUE_SEARCH_TOOL_ID, {
    queries: ['espresso coffee maker'],
  });
  assert.deepEqual(empty.result, { items: [], total: 0 });

  // 5. Fence rejects invalid args before touching budget or tool
  const callsBeforeInvalid = dispatcher.calls;
  for (const badArgs of [
    {},
    { queries: [] },
    { queries: ['   '] },
    { queries: ['a', 'b', 'c', 'd', 'e'] },
    { queries: ['chest press'], equipment: ['bogus-equipment'] },
    { queries: ['chest press'], bodyParts: ['bogus-part'] },
    { queries: ['chest press'], limit: 16 },
    { queries: ['chest press'], limit: 0 },
    { queries: ['chest press'], extra: true },
  ]) {
    await assert.rejects(
      dispatcher.call(CATALOGUE_SEARCH_TOOL_ID, badArgs),
      error => error instanceof AgentError && error.code === 'tool_args_invalid',
    );
  }
  assert.equal(dispatcher.calls, callsBeforeInvalid);

  // 6. Fence rejects calls beyond budget (5th call succeeded; 6th exceeds maxCalls=5)
  await dispatcher.call(CATALOGUE_SEARCH_TOOL_ID, { queries: ['bench press'] });
  assert.equal(dispatcher.calls, 5);
  await assert.rejects(
    dispatcher.call(CATALOGUE_SEARCH_TOOL_ID, { queries: ['bench press'] }),
    error => error instanceof AgentError && error.code === 'tool_budget_exceeded',
  );
  assert.equal(snapshot.length, beforeLength);
});

test('clarifications schema stays optional and cleans invalid, oversized, and duplicate entries', () => {
  const withoutClarifications = {
    fallback: { understanding: '胸推器械' },
    candidates: [],
  };
  assert.equal(isExerciseSearchOutput(withoutClarifications), true);
  assert.equal('clarifications' in cleanExerciseSearchOutput(withoutClarifications), false);

  const validWithClarifications = {
    fallback: { understanding: '可能是推胸或推肩' },
    candidates: [{ name: '坐姿推胸', rationale: '推柄位置', level: 'medium' }],
    clarifications: [
      { label: '往前推（练胸）', prompt: '这是往前推的坐姿推胸器械' },
      { label: '往上推（练肩）', prompt: '这是往上推的坐姿推肩器械' },
    ],
  };
  assert.equal(isExerciseSearchOutput(validWithClarifications), true);

  // Over-limit (>3) or empty label fails raw schema check, while cleaner truncates & caps cleanly
  assert.equal(isExerciseSearchOutput({
    ...validWithClarifications,
    clarifications: [
      { label: '1', prompt: 'p1' },
      { label: '2', prompt: 'p2' },
      { label: '3', prompt: 'p3' },
      { label: '4', prompt: 'p4' },
    ],
  }), false);
  assert.equal(isExerciseSearchOutput({
    ...validWithClarifications,
    clarifications: [{ label: '', prompt: 'p1' }],
  }), false);

  const task = createExerciseSearchTask();
  const dirty = task.parseOutput({
    structured: {
      fallback: { understanding: '模糊机器照片' },
      candidates: [],
      clarifications: [
        null,
        'bad',
        { label: '   ', prompt: '空标签应过滤' },
        { label: '缺少提示', prompt: '   ' },
        { label: '  往前推的动作超出十六个字的超级长标签截断测试  ', prompt: `  ${'这是超长追问句'.repeat(12)}  ` },
        { label: '往前推的动作超出十六个字的超级长标签截断测试重复', prompt: '截断后与前一条同名应去重' },
        { label: '往上推（练肩）', prompt: '这是往上推的坐姿推肩器械' },
        { label: '双臂夹胸', prompt: '这是双臂向中间夹胸的蝴蝶机' },
        { label: '第四条超出上限', prompt: '不应保留第四条' },
      ],
    },
  }, { input: { hintText: '胸肌器械' } });

  assert.equal(dirty.clarifications.length, 3);
  assert.equal(dirty.clarifications[0].label, '往前推的动作超出十六个字的超级长');
  assert.equal(dirty.clarifications[0].label.length, 16);
  assert.equal(dirty.clarifications[0].prompt.length, 60);
  assert.deepEqual(dirty.clarifications[1], { label: '往上推（练肩）', prompt: '这是往上推的坐姿推肩器械' });
  assert.deepEqual(dirty.clarifications[2], { label: '双臂夹胸', prompt: '这是双臂向中间夹胸的蝴蝶机' });
  assert.equal(isExerciseSearchOutput(dirty), true);

  // Empty or all-invalid clarifications omits the field for backwards compatibility
  const allInvalid = cleanExerciseSearchOutput({
    fallback: { understanding: '固定器械' },
    candidates: [],
    clarifications: [null, { label: '', prompt: 'x' }, { label: 'y' }],
  });
  assert.equal('clarifications' in allInvalid, false);
  assert.equal(isExerciseSearchOutput(allInvalid), true);
});
