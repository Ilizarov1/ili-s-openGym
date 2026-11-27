/* Coach GenUI streaming endpoint integration tests.
 *
 * Drives the compiled Nest entry (`dist/src/main.js`) over real HTTP and reads the raw
 * `text/event-stream` frames, so the assertions cover the wire order rather than an
 * in-process shortcut: 401/400 boundaries, the fixture event sequence, the form
 * follow-up, the catalogue gate that drops a hallucinated exercise id, the live
 * proposal review, the v2 interleaved NDJSON stream, the heavy-visual budget, the
 * legacy v1 `{ text, blocks }` fallback, and malformed-line isolation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isStretch, libraryHas } from '../../coach/core/library.js';
import { AgentError, MAX_GENUI_NODES } from '../../dist/agent-runtime/index.js';
import { createBoundedFetch } from '../../dist/src/agent/langchain/index.js';
import { boundPort } from '../helpers.mjs';
import { seedData, fixtureSession, OWNER_ID } from './parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '../..');
const STREAM_ROUTE = '/api/agent/coach/stream';
const CATALOGUE_FILE = path.join(API, 'agent-runtime', 'tasks', 'exercise-search-catalogue.json');

const PROTOCOL_VERSION = 2;
const CUSTOM = {
  PROSE_DELTA: 'genui.prose_delta',
  NODE_PENDING: 'genui.node_pending',
  NODE_COMMIT: 'genui.node_commit',
  NODE_DROP: 'genui.node_drop',
};

function coachConfig(over = {}) {
  return {
    enabled: true,
    provider: 'fixture',
    authMode: 'instance',
    auth: {},
    models: {},
    providerOptions: {},
    boundUid: {},
    caps: { perProfileDaily: 100, instanceDaily: 0 },
    community: false,
    ...over,
  };
}

function writeCoach(dir, over = {}) {
  fs.writeFileSync(path.join(dir, 'coach.json'), JSON.stringify(coachConfig(over), null, 2), { mode: 0o600 });
}

function killChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    child.once('exit', resolve);
    try { child.kill('SIGKILL'); } catch { resolve(); }
  });
}

async function spawnServer(dir, extraEnv = {}) {
  const child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dir,
      ORIGIN: 'http://localhost:8080',
      RP_ID: 'localhost',
      COACH_DISABLED: '',
      AGENT_RUNTIME_DISABLED: '',
      NODE_ENV: 'test',
      COACH_CREDENTIAL_DIR: path.join(dir, 'coach-auth'),
      INTEGRATIONS: '',
      DEEPSEEK_API_KEY: '',
      COACH_GENUI_MAX_VISUALS: '',
      ...extraEnv,
    },
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const port = await boundPort(child, () => log);
  return {
    dir,
    child,
    base: `http://127.0.0.1:${port}`,
    log: () => log,
    async stop() {
      await killChild(child);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function startServer(extraEnv = {}, coach = {}, scenario = 'default') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-genui-api-'));
  const seed = seedData(dir, scenario);
  writeCoach(dir, coach);
  const server = await spawnServer(dir, extraEnv);
  return { ...server, seed };
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Origin: 'http://localhost:8080',
  };
}

function parseSse(text) {
  const events = [];
  for (const frame of text.split('\n\n')) {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      events.push(JSON.parse(line.slice('data: '.length)));
    }
  }
  return events;
}

async function streamCall(server, token, body, { timeout = 30000, signedIn = true } = {}) {
  const allHeaders = signedIn
    ? headers(token)
    : { 'Content-Type': 'application/json', Accept: 'text/event-stream', Origin: 'http://localhost:8080' };
  const response = await fetch(server.base + STREAM_ROUTE, {
    method: 'POST',
    headers: allHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await response.text();
  return {
    status: response.status,
    contentType: String(response.headers.get('content-type') || ''),
    headers: response.headers,
    text,
    events: parseSse(text),
  };
}

function typesOf(events) {
  return events.map(event => String(event.type));
}

function assertOrdered(events, expected) {
  let at = 0;
  for (const type of expected) {
    const found = events.findIndex((event, index) => index >= at && event.type === type);
    assert.ok(found >= at, `expected ${type} after index ${at}; received: ${typesOf(events).join(' -> ')}`);
    at = found + 1;
  }
}

function customValues(events, name) {
  return events
    .filter(event => event.type === 'CUSTOM' && event.name === name)
    .map(event => event.value || {});
}

function committedNodes(events) {
  return customValues(events, CUSTOM.NODE_COMMIT).map(value => value.node).filter(Boolean);
}

function droppedReasons(events) {
  return customValues(events, CUSTOM.NODE_DROP).map(value => String(value.reason || ''));
}

/* The compact narrative milestone sequence: consecutive prose deltas collapse into one,
 * so the assertion reads as prose → card → prose rather than as token noise. */
function customMilestones(events) {
  const out = [];
  for (const event of events) {
    if (event.type !== 'CUSTOM') continue;
    const value = event.value || {};
    let label = null;
    if (event.name === CUSTOM.PROSE_DELTA) label = `prose_delta:${value.nodeId}`;
    else if (event.name === CUSTOM.NODE_PENDING) label = `node_pending:${value.nodeType}`;
    else if (event.name === CUSTOM.NODE_COMMIT) label = `node_commit:${value.node?.type}`;
    else if (event.name === CUSTOM.NODE_DROP) label = `node_drop:${value.reason}`;
    if (!label) continue;
    if (out[out.length - 1] !== label) out.push(label);
  }
  return out;
}

function derivedText(nodes) {
  return nodes
    .filter(node => node && node.type === 'prose')
    .map(node => String(node.text || ''))
    .join('\n\n');
}

async function startFakeOpenAIServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const entry = { method: req.method, url: req.url, headers: req.headers, body, index: requests.length };
    requests.push(entry);
    await handler(entry, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/* An OpenAI-compatible non-streaming completion. `content` may already be JSON text
 * (an NDJSON node list) or a plain value that gets stringified. */
function modelAnswer(content) {
  return {
    id: 'genui_mock',
    model: 'genui-mock-model',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) },
    }],
    usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
  };
}

function sseFrame(content, finishReason = null) {
  return `data: ${JSON.stringify({
    id: 'genui_stream',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'genui-mock-model',
    choices: [{
      index: 0,
      delta: content ? { role: 'assistant', content } : {},
      finish_reason: finishReason,
    }],
  })}\n\n`;
}

function streamPieces(content, size = 36) {
  const pieces = [];
  for (let at = 0; at < content.length; at += size) pieces.push(content.slice(at, at + size));
  return pieces;
}

async function sendSseStream(res, pieces, { delayMs = 0 } = {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(sseFrame(''));
  for (const piece of pieces) {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    res.write(sseFrame(piece));
  }
  res.write(sseFrame('', 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

/* One OpenAI `chat.completion.chunk` frame for a tool-call delta. */
function toolCallChunk(delta, finishReason = null) {
  return `data: ${JSON.stringify({
    id: 'genui_tool_stream',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'genui-mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

/* Stream a tool call the way OpenAI/DeepSeek do: the first delta names the call, later
 * deltas append fragments of the JSON arguments, and a `tool_calls` finish closes it. */
async function sendToolCallStream(res, { id, name, argumentPieces }) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(toolCallChunk({
    role: 'assistant',
    tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }],
  }));
  for (const piece of argumentPieces) {
    res.write(toolCallChunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
  }
  res.write(toolCallChunk({}, 'tool_calls'));
  res.write('data: [DONE]\n\n');
  res.end();
}

/* Answer one model call in whatever shape the request asked for: streaming clients get
 * OpenAI `chat.completion.chunk` SSE frames ending in `[DONE]`, others get plain JSON. */
async function answerModel(entry, res, content, options = {}) {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  if (entry.body?.stream === true) {
    await sendSseStream(res, options.pieces || streamPieces(text), { delayMs: options.delayMs || 0 });
    return;
  }
  sendJson(res, modelAnswer(text));
}

function loadCatalogue() {
  const parsed = JSON.parse(fs.readFileSync(CATALOGUE_FILE, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${CATALOGUE_FILE} must hold an array of exercises`);
  return parsed.filter(entry => entry && typeof entry.id === 'string' && entry.id);
}

function seededPlanSlots(state) {
  const routines = Array.isArray(state?.routines) ? state.routines : [];
  const slots = [];
  const planExIds = new Set();
  for (const routine of routines) {
    const ex = Array.isArray(routine.ex) ? routine.ex : [];
    for (const item of ex) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      planExIds.add(item.id);
      slots.push({ routineId: routine.id, exId: item.id });
    }
  }
  return { slots, planExIds };
}

/* A plan slot plus a `sets` change the plan does not already hold, so `validateReview`
 * keeps the proposal instead of dropping it as a no-op. */
function planSlotWithSets(state) {
  const routines = Array.isArray(state?.routines) ? state.routines : [];
  for (const routine of routines) {
    const ex = Array.isArray(routine.ex) ? routine.ex : [];
    for (const item of ex) {
      if (!item || typeof item.id !== 'string' || !item.id) continue;
      const sets = Number.isInteger(item.sets) ? item.sets : 3;
      const after = sets === 2 ? 3 : 2;
      return { routineId: routine.id, exId: item.id, sets, after };
    }
  }
  return null;
}

/* A real catalogue exercise to swap in: same body part as one of the seeded plan's exercises,
 * not already in the plan, and a clean lift rather than a stretch when one exists. The strict
 * preference is an id the legacy Coach library slice does not hold (!libraryHas) — the row the
 * old validator wrongly refused. If the committed library-data.js already carries the whole
 * catalogue, any other real catalogue id still exercises the same wire path. */
function findSwapTarget(state, catalogue = loadCatalogue()) {
  const { slots, planExIds } = seededPlanSlots(state);
  const byId = new Map(catalogue.map(entry => [entry.id, entry]));
  const candidates = [];
  for (const slot of slots) {
    const source = byId.get(slot.exId);
    for (const entry of catalogue) {
      if (!entry.n || planExIds.has(entry.id)) continue;
      if (source && entry.bp !== source.bp) continue;
      if (isStretch(entry)) continue;
      candidates.push({ slot, entry });
    }
  }
  if (!candidates.length) return null;
  const strict = candidates.find(candidate => !libraryHas(candidate.entry.id)) || null;
  return { ...(strict || candidates[0]), catalogueOnly: Boolean(strict), planExIds };
}

test('coach-genui 1. unauthenticated stream request is rejected with 401', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const answer = await streamCall(server, 'no-session', { text: 'hello' }, { signedIn: false });
    assert.equal(answer.status, 401, answer.text);
    assert.equal(answer.contentType.includes('text/event-stream'), false);
    assert.equal(answer.events.length, 0);
  } finally {
    await server.stop();
  }
});

test('coach-genui 2. an empty, invalid or unbounded-maxVisuals body is rejected with 400 before SSE headers', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const cases = [
      [{}, 'text or a formSubmission is required'],
      [{ text: '   ' }, 'text or a formSubmission is required'],
      [{ text: 'x'.repeat(4001) }, 'text must be at most 4000 characters'],
      [{ text: 7 }, 'text must be a string'],
      [{ formSubmission: {} }, 'text or a formSubmission is required'],
      [{ formSubmission: { formId: 'shoulder_triage' } }, 'text or a formSubmission is required'],
      [{ text: 'hello', maxVisuals: 1.5 }, 'maxVisuals must be an integer'],
      [{ text: 'hello', maxVisuals: '2' }, 'maxVisuals must be an integer'],
      [{ text: 'hello', maxVisuals: null }, 'maxVisuals must be an integer'],
    ];
    for (const [body, expectedMessage] of cases) {
      const answer = await streamCall(server, token, body);
      assert.equal(answer.status, 400, `${JSON.stringify(body)}: ${answer.text}`);
      assert.equal(answer.contentType.includes('text/event-stream'), false, 'must not open an SSE stream');
      const parsed = JSON.parse(answer.text);
      assert.equal(parsed.error, expectedMessage);
    }
  } finally {
    await server.stop();
  }
});

test('coach-genui 3. fixture run streams ordered v2 narrative events and validated nodes', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: 'Why has my bench press stalled for three weeks?' });
    assert.equal(answer.status, 200, answer.text);
    assert.match(answer.contentType, /^text\/event-stream/i);
    assert.equal(answer.headers.get('cache-control'), 'no-cache, no-transform');
    assert.equal(answer.headers.get('x-accel-buffering'), 'no');

    assertOrdered(answer.events, [
      'RUN_STARTED',
      'STEP_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_RESULT',
      'CUSTOM',
      'RUN_FINISHED',
    ]);

    const started = answer.events.find(event => event.type === 'RUN_STARTED');
    assert.equal(typeof started.runId, 'string');
    assert.equal(typeof started.threadId, 'string');
    assert.equal(started.protocolVersion, PROTOCOL_VERSION);

    const steps = answer.events.filter(event => event.type === 'STEP_STARTED').map(event => event.stepName);
    assert.deepEqual(steps, ['prepare', 'analyze', 'compose']);
    const finished = answer.events.filter(event => event.type === 'STEP_FINISHED').map(event => event.stepName);
    assert.deepEqual(finished, ['prepare', 'analyze', 'compose']);

    const proseDeltas = customValues(answer.events, CUSTOM.PROSE_DELTA);
    assert.ok(proseDeltas.length > 0, 'prose must stream as genui.prose_delta frames');
    assert.ok(customValues(answer.events, CUSTOM.NODE_PENDING).length > 0, 'structured nodes must be announced');

    const nodes = committedNodes(answer.events);
    assert.ok(nodes.length > 0, 'at least one validated node must be committed');
    for (const node of nodes) {
      assert.notEqual(node.type, 'fallback_notice', `unexpected degraded node: ${JSON.stringify(node)}`);
      assert.equal(typeof node.id, 'string');
      assert.equal(typeof node.type, 'string');
    }
    assert.ok(nodes.some(node => node.type === 'prose'), 'a fixture answer must contain prose');
    const visuals = nodes.filter(node => node.type === 'exercise_trend' || node.type === 'muscle_load');
    assert.equal(visuals.length, 2, 'with no explicit maxVisuals both fixture heavy visuals commit');

    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.equal(runFinished.protocolVersion, PROTOCOL_VERSION);
    assert.equal(runFinished.runId, started.runId);
    assert.deepEqual(runFinished.nodes, nodes);
    assert.equal(runFinished.text, derivedText(nodes));
    assert.deepEqual(runFinished.blocks, nodes.filter(node => node.type !== 'prose'));
  } finally {
    await server.stop();
  }
});

test('coach-genui 4. a form submission follow-up commits alternatives and a validated proposal', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, {
      text: 'My front shoulder hurts when I bench press.',
      formSubmission: {
        formId: 'shoulder_triage',
        answers: { painArea: 'front_shoulder', intensity: 7 },
      },
    });
    assert.equal(answer.status, 200, answer.text);
    assertOrdered(answer.events, ['RUN_STARTED', 'STEP_STARTED', 'CUSTOM', 'RUN_FINISHED']);

    const nodes = committedNodes(answer.events);
    const types = nodes.map(node => node.type);
    assert.ok(types.includes('exercise_alternatives'), `missing exercise_alternatives in ${types.join(',')}`);
    assert.ok(types.includes('proposal_action'), `missing proposal_action in ${types.join(',')}`);

    const proposal = nodes.find(node => node.type === 'proposal_action');
    assert.ok(Array.isArray(proposal.changes) && proposal.changes.length > 0, 'the proposal must carry validated changes');
    for (const change of proposal.changes) {
      assert.equal(typeof change.type, 'string');
      assert.equal(typeof change.why, 'string');
      assert.ok(change.target && typeof change.target === 'object');
    }

    const alternatives = nodes.find(node => node.type === 'exercise_alternatives');
    assert.ok(Array.isArray(alternatives.items) && alternatives.items.length > 0);
    for (const item of alternatives.items) {
      assert.equal(typeof item.exId, 'string');
    }

    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.deepEqual(runFinished.nodes, nodes);
    assert.deepEqual(runFinished.blocks, nodes.filter(node => node.type !== 'prose'));
  } finally {
    await server.stop();
  }
});

test('coach-genui 5. a hallucinated exId is dropped while a valid sibling node is committed', { timeout: 30000 }, async () => {
  const invented = 'totally-invented-exercise-id';
  const fake = await startFakeOpenAIServer((request, res) => {
    assert.equal(request.method, 'POST');
    assert.ok(Array.isArray(request.body?.messages) && request.body.messages.length >= 2);
    assert.equal(request.body.messages[0].role, 'system');
    assert.equal(request.body.stream, true);
    assert.equal(request.body.response_format, undefined, 'v2 must not force a single json_object');
    return answerModel(request, res, [
      '{"id":"blk_trend_hallucinated","type":"exercise_trend","exId":"totally-invented-exercise-id","metric":"e1rm","weeks":8,"title":"Invented press","caption":"This exercise does not exist"}',
      '{"id":"blk_trend_good","type":"exercise_trend","exId":"0001","metric":"e1rm","weeks":8,"title":"Press trend","caption":"Flat across your last sessions"}',
    ].join('\n') + '\n');
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: 'Is my bench press stalling?' });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(fake.requests.length, 1, 'the run must call the configured model exactly once');

    const nodes = committedNodes(answer.events);
    const byId = new Map(nodes.map(node => [node.id, node]));
    assert.equal(byId.has('blk_trend_good'), true, `valid node missing: ${JSON.stringify(nodes)}`);
    assert.equal(byId.get('blk_trend_good').type, 'exercise_trend');
    assert.equal(byId.get('blk_trend_good').exId, '0001');
    assert.equal(byId.has('blk_trend_hallucinated'), false, 'a hallucinated id must not be committed');

    const reasons = droppedReasons(answer.events);
    assert.equal(reasons.some(reason => reason.includes('unknown exercise id')), true, `missing id drop: ${reasons.join(',')}`);

    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.equal(runFinished.text, '');
    assert.equal(
      JSON.stringify(runFinished.nodes).includes(invented),
      false,
      'a hallucinated id must never be part of a committed node',
    );
    assert.equal(server.log().includes(invented), false);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 6. AGENT_RUNTIME_DISABLED answers 503 without opening a stream', { timeout: 30000 }, async () => {
  const server = await startServer({ AGENT_RUNTIME_DISABLED: '1' });
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: 'hello' });
    assert.equal(answer.status, 503, answer.text);
    assert.equal(answer.contentType.includes('text/event-stream'), false);
    assert.equal(JSON.parse(answer.text).error, 'the agent runtime is disabled');
  } finally {
    await server.stop();
  }
});

test('coach-genui 8. a provider failure ends with a redacted RUN_ERROR, never a key or a stack', { timeout: 30000 }, async () => {
  const fake = await startFakeOpenAIServer((_request, res) => {
    sendJson(res, {
      error: { message: 'Incorrect API key sk-genui-secret-12345 Bearer tok-genui-99999' },
    }, 401);
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-failing-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: 'Any advice for today?' });
    assert.equal(answer.status, 200, answer.text);
    assertOrdered(answer.events, ['RUN_STARTED', 'STEP_STARTED', 'RUN_ERROR']);

    const failure = answer.events.at(-1);
    assert.equal(failure.type, 'RUN_ERROR');
    assert.equal(typeof failure.code, 'string');
    assert.ok(String(failure.message || '').length > 0);
    assert.equal(answer.text.includes('sk-genui-secret-12345'), false);
    assert.equal(answer.text.includes('tok-genui-99999'), false);
    assert.equal(answer.text.includes('    at '), false, 'a raw stack must not reach the client');
    assert.equal(server.log().includes('sk-genui-secret-12345'), false);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 7. a client disconnect aborts the in-flight model request', { timeout: 30000 }, async () => {
  let upstreamClosed = null;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const fake = await startFakeOpenAIServer((_request, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":'); // hold the body open until the caller goes away
    res.on('close', () => upstreamClosed(true));
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-hang-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const controller = new AbortController();
    const response = await fetch(server.base + STREAM_ROUTE, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ text: 'Is my bench press stalling?' }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.ok(first.value && first.value.length > 0, 'the stream must open before the model answers');

    controller.abort();
    try { await reader.read(); } catch { /* the abort ends the body */ }

    const aborted = await Promise.race([
      closed,
      new Promise(resolve => setTimeout(() => resolve(false), 5000)),
    ]);
    assert.equal(aborted, true, 'the upstream model request must be cancelled by the abort');
    assert.equal(server.child.exitCode, null, 'the API process must survive a disconnect');
    assert.equal(server.log().includes('UnhandledPromiseRejection'), false);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 9. a real catalogue swap target survives validation in object and bare-string form', { timeout: 30000 }, async (t) => {
  let reply = null;
  const fake = await startFakeOpenAIServer((request, res) => {
    assert.equal(request.method, 'POST');
    assert.ok(reply, 'the model reply must be prepared before the stream call');
    return answerModel(request, res, reply);
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const catalogue = loadCatalogue();
    const catalogueIds = new Set(catalogue.map(entry => entry.id));
    const target = findSwapTarget(server.seed.state, catalogue);
    assert.ok(target, 'the seeded plan must offer at least one exercise slot to swap');
    assert.ok(catalogueIds.has(target.entry.id), `${target.entry.id} must be a real catalogue exercise`);
    assert.equal(target.planExIds.has(target.entry.id), false, 'the swap target must not already be in the plan');
    if (target.catalogueOnly) {
      assert.equal(libraryHas(target.entry.id), false, 'a catalogue-only target must sit outside the Coach library slice');
    } else {
      t.diagnostic(`library-data.js already carries the full catalogue, so no catalogue-only id exists; using real catalogue id ${target.entry.id} instead`);
    }

    const { routineId, exId } = target.slot;
    reply = {
      text: 'A real catalogue exercise is a clean substitute for that slot.',
      blocks: [
        {
          id: 'blk_swap_object',
          type: 'proposal_action',
          title: 'Swap in a catalogue exercise',
          summary: `Swap ${exId} for ${target.entry.id}`,
          changes: [{
            id: 'c_swap_object',
            type: 'swap-exercise',
            target: { routineId, exId },
            why: 'Same body part and movement pattern.',
            after: { id: target.entry.id },
          }],
        },
        {
          id: 'blk_swap_string',
          type: 'proposal_action',
          title: 'Swap from a bare id',
          summary: `Swap ${exId} for ${target.entry.id}`,
          changes: [{
            id: 'c_swap_string',
            type: 'swap-exercise',
            target: { routineId, exId },
            why: 'The model answered with a bare id string.',
            after: target.entry.id,
          }],
        },
        {
          id: 'blk_add_string',
          type: 'proposal_action',
          title: 'Add from a bare id',
          summary: `Add ${target.entry.id}`,
          changes: [{
            id: 'c_add_string',
            type: 'add-exercise',
            target: { routineId },
            why: 'The model answered with a bare id string.',
            after: target.entry.id,
          }],
        },
      ],
    };

    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: 'Swap my sit-up for something similar.' });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(fake.requests.length, 1, 'the run must call the configured model exactly once');
    assert.equal(fake.requests[0].body?.stream, true, 'the coach run must ask the provider to stream');
    assertOrdered(answer.events, ['RUN_STARTED', 'STEP_STARTED', 'CUSTOM', 'RUN_FINISHED']);

    const nodes = committedNodes(answer.events);
    const byId = new Map(nodes.map(node => [node.id, node]));
    assert.equal(
      nodes.some(node => node.type === 'fallback_notice'),
      false,
      `a real catalogue id must not be downgraded: ${JSON.stringify(nodes)}`,
    );

    const expected = [
      ['blk_swap_object', 'swap-exercise'],
      ['blk_swap_string', 'swap-exercise'],
      ['blk_add_string', 'add-exercise'],
    ];
    for (const [nodeId, changeType] of expected) {
      const node = byId.get(nodeId);
      assert.ok(node, `${nodeId} missing from ${JSON.stringify(nodes)}`);
      assert.equal(node.type, 'proposal_action');
      assert.ok(Array.isArray(node.changes) && node.changes.length === 1, `${nodeId} must carry exactly one validated change`);
      const change = node.changes[0];
      assert.equal(change.type, changeType);
      assert.equal(change.target.routineId, routineId);
      if (changeType === 'swap-exercise') assert.equal(change.target.exId, exId);
      assert.equal(change.after.id, target.entry.id, `${nodeId} must keep the catalogue id`);
    }

    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.deepEqual(runFinished.nodes, nodes);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 10. a hallucinated swap target is still downgraded to fallback_notice', { timeout: 30000 }, async () => {
  const inventedObject = 'hallucinated-swap-target-9999';
  const inventedString = 'hallucinated-swap-target-8888';
  let reply = null;
  const fake = await startFakeOpenAIServer((request, res) => {
    assert.ok(reply, 'the model reply must be prepared before the stream call');
    return answerModel(request, res, reply);
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const catalogueIds = new Set(loadCatalogue().map(entry => entry.id));
    assert.equal(catalogueIds.has(inventedObject), false, 'the fixture id must not exist in the catalogue');
    assert.equal(catalogueIds.has(inventedString), false, 'the fixture id must not exist in the catalogue');
    const { slots } = seededPlanSlots(server.seed.state);
    assert.ok(slots.length > 0, 'the seeded plan must contain an exercise to target');
    const { routineId, exId } = slots[0];

    const proposal = (blockId, changeId, after) => ({
      id: blockId,
      type: 'proposal_action',
      title: 'Swap in an invented exercise',
      summary: 'This change cannot be applied.',
      changes: [{
        id: changeId,
        type: 'swap-exercise',
        target: { routineId, exId },
        why: 'The model invented an exercise id.',
        after,
      }],
    });
    reply = {
      text: 'Here is a trend and an unverifiable swap.',
      blocks: [
        {
          id: 'blk_trend_real',
          type: 'exercise_trend',
          exId,
          metric: 'e1rm',
          weeks: 8,
          title: 'Real trend',
          caption: 'This exercise exists in the plan',
        },
        proposal('blk_swap_invented_object', 'c_swap_invented_object', { id: inventedObject }),
        proposal('blk_swap_invented_string', 'c_swap_invented_string', inventedString),
      ],
    };

    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: 'Swap my exercise for something you suggest.' });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(fake.requests.length, 1, 'the run must call the configured model exactly once');

    const nodes = committedNodes(answer.events);
    const byId = new Map(nodes.map(node => [node.id, node]));
    assert.equal(byId.has('blk_trend_real'), true, `the valid trend node must survive: ${JSON.stringify(nodes)}`);
    assert.equal(byId.get('blk_trend_real').type, 'exercise_trend');
    assert.equal(nodes.some(node => node.type === 'proposal_action'), false, `an invented id must not reach a proposal: ${JSON.stringify(nodes)}`);

    const degraded = nodes.filter(node => node.type === 'fallback_notice');
    assert.equal(degraded.length, 2, `expected both invented swaps to downgrade, got ${JSON.stringify(nodes)}`);
    for (const node of degraded) {
      assert.equal(String(node.text || '').length > 0, true);
      assert.match(String(node.text), /could not verify that change against your plan/);
    }
    // The fallback replaces the pending card in place, so the ids the client saw stay stable.
    assert.equal(byId.get('blk_swap_invented_object')?.type, 'fallback_notice');
    assert.equal(byId.get('blk_swap_invented_string')?.type, 'fallback_notice');

    assert.equal(answer.text.includes(inventedObject), false, 'a hallucinated id must never reach the client');
    assert.equal(answer.text.includes(inventedString), false, 'a hallucinated id must never reach the client');
    assert.equal(server.log().includes(inventedObject), false);
    assert.equal(server.log().includes(inventedString), false);

    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.deepEqual(runFinished.nodes, nodes);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 11. a zh run grounds the model prompt in Chinese catalogue names and language directives', { timeout: 30000 }, async () => {
  const catalogue = loadCatalogue();
  const byId = new Map(catalogue.map(entry => [entry.id, entry]));
  const reply = {
    text: '先稳住动作节奏，卧推的进步会回来。',
    blocks: [{
      id: 'blk_zh_trend',
      type: 'exercise_trend',
      exId: '0001',
      metric: 'e1rm',
      weeks: 8,
      title: '卧推趋势',
      caption: '最近几周没有进步',
    }],
  };
  const fake = await startFakeOpenAIServer((request, res) => answerModel(request, res, reply));

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const routineIds = new Set();
    for (const routine of server.seed.state.routines || []) {
      for (const item of routine.ex || []) {
        if (item && typeof item.id === 'string' && item.id && byId.get(item.id)?.zh) routineIds.add(item.id);
      }
    }
    assert.ok(routineIds.size > 0, 'the seeded plan must hold catalogue exercises with a zh label');

    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: '为什么我的卧推三周没有进步？能帮我换个替代动作吗？', lang: 'zh' });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(fake.requests.length, 1, 'the run must call the configured model exactly once');
    assert.equal(fake.requests[0].body?.stream, true, 'the coach run must ask the provider to stream');
    assert.equal(fake.requests[0].body?.response_format, undefined, 'v2 must not force a single json_object');

    const messages = fake.requests[0].body?.messages || [];
    const system = messages.find(message => message?.role === 'system');
    assert.ok(system && typeof system.content === 'string', 'the run must send a system prompt to the model');
    const user = messages.find(message => message?.role === 'user');
    assert.ok(user && typeof user.content === 'string', 'the run must send the current user turn');
    assert.equal(user.content, '为什么我的卧推三周没有进步？能帮我换个替代动作吗？');
    const prompt = system.content;

    assert.match(prompt, /## Response language/);
    assert.ok(prompt.includes('"zh"'), `the prompt must name the requested language:\n${prompt}`);
    assert.match(prompt, /Simplified Chinese/);
    assert.match(prompt, /never output a raw English exercise name/);
    assert.match(prompt, /coach-genui\.v2 NDJSON/);

    assert.match(prompt, /## Grounded training context/);
    for (const id of routineIds) {
      assert.ok(prompt.includes(`${id} "${byId.get(id).zh}"`), `missing zh plan label for ${id} in prompt:\n${prompt}`);
      assert.equal(
        prompt.includes(`"${byId.get(id).n}"`),
        false,
        `raw English exercise name ${byId.get(id).n} leaked into the zh prompt`,
      );
    }

    const loggedEntries = [];
    for (const workout of server.seed.state.workouts || []) {
      for (const entry of workout.entries || []) {
        if (entry && typeof entry.id === 'string' && Array.isArray(entry.sets) && entry.sets.length) {
          loggedEntries.push({ id: entry.id, sets: entry.sets.length });
        }
      }
    }
    assert.ok(loggedEntries.length > 0, 'the seed must log at least one exercise');
    assert.ok(
      prompt.includes(`${loggedEntries[0].id} "${byId.get(loggedEntries[0].id).zh}" x${loggedEntries[0].sets}`),
      `logged work must use the zh label:\n${prompt}`,
    );

    // v2.1 removed the pre-injected swap candidates: the model must discover swaps through the
    // search_catalogue tool instead of receiving a fixed list in the grounded context.
    assert.equal(prompt.includes('Grounded swap candidates:'), false, 'no pre-injected swap list may reach the prompt');
    assert.equal(prompt.includes('替代'), false, `no grounded zh swap candidates may be pre-injected:\n${prompt}`);
    assert.match(prompt, /search_catalogue/);
    assert.match(prompt, /Never guess an exercise id/);

    assertOrdered(answer.events, ['RUN_STARTED', 'STEP_STARTED', 'CUSTOM', 'RUN_FINISHED']);
    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.equal(runFinished.text, reply.text);
    assert.equal(runFinished.text, derivedText(runFinished.nodes));
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 12. prose and UI nodes stream in true interleaved wire order', { timeout: 30000 }, async () => {
  const fake = await startFakeOpenAIServer((request, res) => {
    assert.equal(request.body.stream, true);
    // The pieces are split mid-string and mid-object on purpose: the parser has to
    // announce prose before its line closes and the card before its object is complete.
    const pieces = [
      '{"id":"prose_1","type":"prose","text":"你最近六周的卧推一直停在同一个重量',
      '，先把顶组多加一次。"}\n{"id":"kpi_1","type":"kpi_strip",',
      '"items":[{"kind":"session_count","weeks":4}]}\n',
      '{"id":"prose_2","type":"prose","text":"两周后再看趋势，别急着换动作。"}\n',
    ];
    return sendSseStream(res, pieces);
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: '我的卧推停滞了怎么办？' });
    assert.equal(answer.status, 200, answer.text);

    assert.deepEqual(customMilestones(answer.events), [
      'prose_delta:prose_1',
      'node_commit:prose',
      'node_pending:kpi_strip',
      'node_commit:kpi_strip',
      'prose_delta:prose_2',
      'node_commit:prose',
    ]);

    const nodes = committedNodes(answer.events);
    assert.deepEqual(nodes.map(node => node.type), ['prose', 'kpi_strip', 'prose']);
    assert.equal(nodes[0].text, '你最近六周的卧推一直停在同一个重量，先把顶组多加一次。');
    assert.equal(nodes[1].items[0].kind, 'session_count');

    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.deepEqual(runFinished.nodes, nodes);
    assert.equal(runFinished.text, `${nodes[0].text}\n\n${nodes[2].text}`);
    assert.deepEqual(runFinished.blocks, [nodes[1]]);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 13. maxVisuals is an opt-in cap: omitted commits every heavy visual, explicit 1/0 drops extras', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');

    // v2.1 default: no maxVisuals, so the fixture's exercise_trend and muscle_load both commit.
    const unrestricted = await streamCall(server, token, { text: 'Why has my bench press stalled for three weeks?' });
    assert.equal(unrestricted.status, 200, unrestricted.text);
    const unrestrictedVisuals = committedNodes(unrestricted.events)
      .filter(node => node.type === 'exercise_trend' || node.type === 'muscle_load');
    assert.deepEqual(
      unrestrictedVisuals.map(node => node.type),
      ['exercise_trend', 'muscle_load'],
      `omitted maxVisuals must commit both heavy visuals, got ${JSON.stringify(unrestrictedVisuals)}`,
    );
    assert.equal(droppedReasons(unrestricted.events).includes('visual_budget_exceeded'), false);

    // Explicit budget (1): only the first heavy visual may commit.
    const one = await streamCall(server, token, {
      text: 'Why has my bench press stalled for three weeks?',
      maxVisuals: 1,
    });
    assert.equal(one.status, 200, one.text);
    const oneVisuals = committedNodes(one.events)
      .filter(node => node.type === 'exercise_trend' || node.type === 'muscle_load');
    assert.deepEqual(oneVisuals.map(node => node.type), ['exercise_trend']);
    assert.ok(
      droppedReasons(one.events).includes('visual_budget_exceeded'),
      `the second heavy visual must be withdrawn with genui.node_drop: ${droppedReasons(one.events).join(',')}`,
    );
    assert.deepEqual(one.events.at(-1).nodes, committedNodes(one.events));

    // Explicit budget (0): no heavy visual commits at all.
    const none = await streamCall(server, token, {
      text: 'Why has my bench press stalled for three weeks?',
      maxVisuals: 0,
    });
    assert.equal(none.status, 200, none.text);
    const noneVisuals = committedNodes(none.events)
      .filter(node => node.type === 'exercise_trend' || node.type === 'muscle_load');
    assert.deepEqual(noneVisuals, [], 'maxVisuals=0 must drop every heavy visual');
    assert.equal(
      droppedReasons(none.events).filter(reason => reason === 'visual_budget_exceeded').length,
      2,
    );

    // Explicit budget (2) fits both; out-of-range integers are clamped, never rejected.
    const two = await streamCall(server, token, {
      text: 'Why has my bench press stalled for three weeks?',
      maxVisuals: 2,
    });
    assert.equal(two.status, 200, two.text);
    const twoVisuals = committedNodes(two.events)
      .filter(node => node.type === 'exercise_trend' || node.type === 'muscle_load');
    assert.equal(twoVisuals.length, 2, 'maxVisuals=2 must commit both heavy visuals');
    assert.equal(droppedReasons(two.events).includes('visual_budget_exceeded'), false);

    const clamped = await streamCall(server, token, {
      text: 'Why has my bench press stalled for three weeks?',
      maxVisuals: 99,
    });
    assert.equal(clamped.status, 200, clamped.text);
    const clampedVisuals = committedNodes(clamped.events)
      .filter(node => node.type === 'exercise_trend' || node.type === 'muscle_load');
    assert.equal(clampedVisuals.length, 2, 'the current fixture offers only two heavy visuals, so 4/99 both fit');
  } finally {
    await server.stop();
  }
});

test('coach-genui 14. a legacy v1 { text, blocks } payload still becomes ordered v2 nodes', { timeout: 30000 }, async () => {
  const legacy = {
    text: '你的卧推最近三周确实没有进步，先把训练量稳住。',
    blocks: [{
      id: 'blk_trend_legacy',
      type: 'exercise_trend',
      exId: '0001',
      metric: 'e1rm',
      weeks: 8,
      title: '卧推趋势',
      caption: '最近三周持平',
    }],
  };
  const fake = await startFakeOpenAIServer((request, res) => {
    assert.equal(request.body.stream, true);
    assert.equal(request.body.response_format, undefined);
    return answerModel(request, res, legacy);
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: '为什么卧推没进步？', lang: 'zh' });
    assert.equal(answer.status, 200, answer.text);

    const nodes = committedNodes(answer.events);
    assert.deepEqual(nodes.map(node => node.type), ['prose', 'exercise_trend']);
    assert.equal(nodes[0].text, legacy.text);
    assert.equal(nodes[1].id, 'blk_trend_legacy');
    assert.equal(nodes[1].exId, '0001');

    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.equal(runFinished.text, legacy.text);
    assert.deepEqual(runFinished.blocks, [nodes[1]]);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 15. the streaming bounded fetch passes chunks through and enforces both byte caps', { timeout: 30000 }, async () => {
  const encoder = new TextEncoder();
  const streamOf = (chunks) => new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  // 1. Chunks are passed through unbuffered, with the compressed/length headers stripped.
  const passthrough = createBoundedFetch({
    streaming: true,
    maxBytes: 1024,
    fetchImpl: async () => new Response(streamOf([encoder.encode('ab'), encoder.encode('cd')]), {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': '4' },
    }),
  });
  const response = await passthrough('http://127.0.0.1/stream');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(await response.text(), 'abcd');

  // 2. A declared content-length over the cap fails before a single chunk is handed over.
  const declaredOversize = createBoundedFetch({
    streaming: true,
    maxBytes: 1024,
    fetchImpl: async () => new Response(streamOf([encoder.encode('x')]), {
      status: 200,
      headers: { 'content-length': '2048' },
    }),
  });
  await assert.rejects(
    declaredOversize('http://127.0.0.1/stream'),
    error => error instanceof AgentError && error.code === 'model_response_too_large',
  );

  // 3. The cumulative cap fires mid-stream on the real body bytes.
  const chunk = new Uint8Array(600);
  const chunkedOversize = createBoundedFetch({
    streaming: true,
    maxBytes: 1024,
    fetchImpl: async () => new Response(streamOf([chunk, chunk]), { status: 200 }),
  });
  const oversizeResponse = await chunkedOversize('http://127.0.0.1/stream');
  await assert.rejects(
    oversizeResponse.text(),
    error => error instanceof AgentError && error.code === 'model_response_too_large',
  );
});

test('coach-genui 16. a malformed NDJSON line is dropped in isolation and later nodes still commit', { timeout: 30000 }, async () => {
  const fake = await startFakeOpenAIServer((request, res) => {
    const pieces = [
      '{"id":"prose_1","type":"prose","text":"先看最近的训练记录。"}\n',
      '{"id":"kpi_bad","type":"kpi_strip","items":[}\n',
      '{"id":"prose_2","type":"prose","text":"这条建议仍然成立，不需要换动作。"}\n',
    ];
    return sendSseStream(res, pieces);
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: '给点建议' });
    assert.equal(answer.status, 200, answer.text);

    const reasons = droppedReasons(answer.events);
    assert.ok(reasons.includes('malformed_json'), `the broken line must withdraw its pending card: ${reasons.join(',')}`);

    const nodes = committedNodes(answer.events);
    assert.deepEqual(nodes.map(node => node.type), ['prose', 'prose']);
    assert.equal(nodes[1].text, '这条建议仍然成立，不需要换动作。');
    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.equal(runFinished.text, `${nodes[0].text}\n\n${nodes[1].text}`);
    assert.ok(answer.text.includes('"type":"kpi_strip"') === false, 'the malformed card must not be echoed as content');
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 17. free editing phrasing commits proposals and more than 3 UI cards up to MAX_GENUI_NODES', { timeout: 30000 }, async () => {
  let reply = null;
  const fake = await startFakeOpenAIServer((request, res) => {
    assert.ok(reply, 'the model reply must be prepared before the stream call');
    return answerModel(request, res, reply);
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const slot = planSlotWithSets(server.seed.state);
    assert.ok(slot, 'the seeded plan must contain an exercise slot');

    const callouts = Array.from({ length: 6 }, (_, index) => ({
      id: `c${index + 1}`,
      type: 'callout',
      variant: index === 0 ? 'tip' : 'info',
      title: `提示 ${index + 1}`,
      text: `第 ${index + 1} 条自由编排的提示，不再受 3 张卡预算限制。`,
    }));
    reply = [
      JSON.stringify({ id: 'p1', type: 'prose', text: '好，我把卧推的组数下调一点，动作本身不动。' }),
      JSON.stringify({
        id: 'prop_free_1',
        type: 'proposal_action',
        title: '下调卧推组数',
        summary: `把 ${slot.exId} 的组数从 ${slot.sets} 调到 ${slot.after}。`,
        changes: [{
          id: 'c_sets',
          type: 'sets',
          target: { routineId: slot.routineId, exId: slot.exId },
          why: '最近几次训练质量下降，先减一组稳住动作。',
          after: slot.after,
        }],
      }),
      ...callouts.map(node => JSON.stringify(node)),
    ].join('\n') + '\n';

    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    for (const text of ['想把杠铃卧推次数下调', '帮我改就行了']) {
      const answer = await streamCall(server, token, { text, lang: 'zh' });
      assert.equal(answer.status, 200, answer.text);

      const nodes = committedNodes(answer.events);
      assert.equal(
        nodes.some(node => node.type === 'fallback_notice'),
        false,
        `free editing must not be blocked or downgraded: ${JSON.stringify(nodes)}`,
      );

      const proposal = nodes.find(node => node.id === 'prop_free_1');
      assert.ok(proposal, `proposal_action must commit for "${text}": ${JSON.stringify(nodes.map(node => node.id))}`);
      assert.equal(proposal.type, 'proposal_action');
      assert.equal(proposal.changes.length, 1);
      assert.equal(proposal.changes[0].type, 'sets');
      assert.equal(proposal.changes[0].target.routineId, slot.routineId);
      assert.equal(proposal.changes[0].target.exId, slot.exId);
      assert.equal(proposal.changes[0].after, slot.after);

      const uiNodes = nodes.filter(node => node.type !== 'prose');
      assert.equal(uiNodes.length, 7, `1 proposal + 6 callouts must all commit, got ${JSON.stringify(uiNodes.map(node => node.id))}`);
      assert.ok(uiNodes.length > 3, 'more than three UI cards must be allowed');
      assert.ok(nodes.length <= MAX_GENUI_NODES, `the answer must stay within ${MAX_GENUI_NODES} nodes`);
      assert.deepEqual(
        uiNodes.map(node => node.id),
        ['prop_free_1', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'],
      );

      const runFinished = answer.events.at(-1);
      assert.equal(runFinished.type, 'RUN_FINISHED');
      assert.deepEqual(runFinished.nodes, nodes);
    }
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 18. search_catalogue streams a tool loop and round 2 grounds swaps in real returned ids', { timeout: 30000 }, async () => {
  const catalogue = loadCatalogue();
  const byId = new Map(catalogue.map(entry => [entry.id, entry]));
  const toolPayloads = [];
  let plan = null;

  const fake = await startFakeOpenAIServer(async (request, res) => {
    const body = request.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const toolMessages = messages.filter(message => message?.role === 'tool');

    if (!toolMessages.length) {
      // Round 1: the model must be offered the real search_catalogue tool.
      const tools = Array.isArray(body.tools) ? body.tools : [];
      const searchTool = tools.find(tool => tool?.function?.name === 'search_catalogue');
      assert.ok(searchTool, `round 1 must bind search_catalogue, got ${JSON.stringify(tools)}`);
      assert.ok(Array.isArray(searchTool.function.parameters?.required));
      assert.deepEqual(searchTool.function.parameters.required, ['queries']);
      return sendToolCallStream(res, {
        id: 'call_cat_1',
        name: 'search_catalogue',
        argumentPieces: ['{"queries":', '["incline dumbbell', ' press"]}'],
      });
    }

    // Round 2: the conversation now carries the assistant tool_calls message and the tool reply.
    const assistantCall = messages.find(
      message => message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length,
    );
    assert.ok(assistantCall, `round 2 must include the assistant tool_calls message: ${JSON.stringify(messages)}`);
    assert.equal(assistantCall.tool_calls[0].id, 'call_cat_1');
    assert.equal(assistantCall.tool_calls[0].function.name, 'search_catalogue');

    const toolMessage = toolMessages[0];
    assert.equal(toolMessage.tool_call_id, 'call_cat_1');
    const payload = JSON.parse(toolMessage.content);
    toolPayloads.push(payload);
    assert.ok(Array.isArray(payload.items) && payload.items.length > 0, 'the tool reply must carry real catalogue items');
    for (const item of payload.items) assert.ok(byId.has(item.id), `${item.id} must be a real catalogue id`);

    const swapId = payload.items
      .map(item => item.id)
      .find(id => id !== plan.exId && !plan.planExIds.has(id) && byId.has(id));
    assert.ok(swapId, `expected a real catalogue swap target in ${JSON.stringify(payload.items)}`);

    const nodes = [
      {
        id: 'alt_from_tool',
        type: 'exercise_alternatives',
        forExId: plan.exId,
        title: '来自动作库的替代',
        items: [{ exId: swapId, reason: '同样的推举模式，更友好的角度。', tag: 'Swap' }],
      },
      {
        id: 'prop_from_tool',
        type: 'proposal_action',
        title: '换成动作库里的替代动作',
        summary: `把 ${plan.exId} 换成动作库返回的 ${swapId}。`,
        changes: [{
          id: 'c_swap_tool',
          type: 'swap-exercise',
          target: { routineId: plan.routineId, exId: plan.exId },
          why: '这个 id 来自 search_catalogue 的真实返回。',
          after: { id: swapId },
        }],
      },
    ];
    return answerModel(request, res, nodes.map(node => JSON.stringify(node)).join('\n') + '\n');
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const { slots, planExIds } = seededPlanSlots(server.seed.state);
    assert.ok(slots.length > 0, 'the seeded plan must contain an exercise slot');
    plan = { ...slots[0], planExIds };

    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, { text: '帮我从动作库里换个替代动作', lang: 'en' });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(fake.requests.length, 2, 'one tool round then one answer round');

    const starts = answer.events.filter(
      event => event.type === 'TOOL_CALL_START' && event.toolCallName === 'search_catalogue',
    );
    assert.equal(starts.length, 1, `search_catalogue must emit TOOL_CALL_START: ${typesOf(answer.events).join(',')}`);
    assert.equal(starts[0].toolCallId, 'call_cat_1');
    assert.deepEqual(starts[0].args, { queries: ['incline dumbbell press'] });

    const results = answer.events.filter(
      event => event.type === 'TOOL_CALL_RESULT' && event.toolCallName === 'search_catalogue',
    );
    assert.equal(results.length, 1, 'search_catalogue must emit TOOL_CALL_RESULT');
    assert.equal(results[0].toolCallId, 'call_cat_1');
    const summary = JSON.parse(results[0].summary);
    assert.ok(summary.items.length > 0);
    for (const item of summary.items) {
      assert.ok(byId.has(item.id), `${item.id} must be a real catalogue id`);
      assert.equal(item.name, byId.get(item.id).n, 'an en run localizes tool names to English');
    }

    assert.equal(toolPayloads.length, 1);
    const swapId = toolPayloads[0].items
      .map(item => item.id)
      .find(id => id !== plan.exId && !planExIds.has(id));

    const nodes = committedNodes(answer.events);
    const alternatives = nodes.find(node => node.id === 'alt_from_tool');
    const proposal = nodes.find(node => node.id === 'prop_from_tool');
    assert.ok(alternatives, `exercise_alternatives must commit: ${JSON.stringify(nodes)}`);
    assert.equal(alternatives.items[0].exId, swapId);
    assert.ok(proposal, `proposal_action must commit: ${JSON.stringify(nodes)}`);
    assert.equal(proposal.type, 'proposal_action');
    assert.equal(proposal.changes[0].type, 'swap-exercise');
    assert.equal(proposal.changes[0].after.id, swapId);
    assert.ok(
      toolPayloads[0].items.some(item => item.id === proposal.changes[0].after.id),
      'the proposal must reuse an id that the tool actually returned',
    );
    assert.equal(nodes.some(node => node.type === 'fallback_notice'), false, `a searched real id must not be downgraded: ${JSON.stringify(nodes)}`);

    // The same loop in zh: tool result items use the localized Chinese name.
    plan = { ...slots[0], planExIds };
    toolPayloads.length = 0;
    const requested = fake.requests.length;
    const zh = await streamCall(server, token, { text: '帮我从动作库里换个替代动作', lang: 'zh' });
    assert.equal(zh.status, 200, zh.text);
    assert.equal(fake.requests.length - requested, 2, 'the zh run also does one tool round then one answer round');
    assert.equal(toolPayloads.length, 1);
    const zhSummary = JSON.parse(
      zh.events.find(event => event.type === 'TOOL_CALL_RESULT' && event.toolCallName === 'search_catalogue')?.summary,
    );
    assert.ok(zhSummary.items.length > 0);
    for (const item of zhSummary.items) {
      const entry = byId.get(item.id);
      assert.ok(entry, `${item.id} must be real`);
      assert.equal(item.name, entry.zh || entry.n, `zh tool results must use the Chinese label for ${item.id}`);
      assert.match(item.name, /[\u3400-\u9fff]/, `expected a Chinese name, got ${item.name}`);
    }
    const zhNodes = committedNodes(zh.events);
    assert.ok(zhNodes.some(node => node.id === 'alt_from_tool'));
    assert.ok(zhNodes.some(node => node.id === 'prop_from_tool'));
    assert.equal(zhNodes.some(node => node.type === 'fallback_notice'), false);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 19. full multi-turn history is forwarded verbatim, not sliced', { timeout: 30000 }, async () => {
  const history = [];
  for (let turn = 1; turn <= 9; turn++) {
    history.push({ role: 'user', content: `prior-user-turn-${turn}` });
    history.push({ role: 'assistant', content: `prior-assistant-turn-${turn}` });
  }

  const fake = await startFakeOpenAIServer((request, res) => {
    const body = request.body || {};
    assert.equal(body.stream, true);
    return answerModel(request, res, [
      JSON.stringify({ id: 'p_history', type: 'prose', text: '收到，我们继续。' }),
    ].join('\n') + '\n');
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, {
      text: 'current-user-turn',
      lang: 'zh',
      history,
    });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(fake.requests.length, 1);

    const messages = fake.requests[0].body?.messages || [];
    assert.equal(messages[0].role, 'system');
    assert.equal(messages.at(-1).role, 'user');
    assert.equal(messages.at(-1).content, 'current-user-turn');

    const prior = messages.slice(1, -1);
    assert.equal(prior.length, 18, `all 18 history messages must reach the model, got ${prior.length}`);
    assert.deepEqual(
      prior.map(message => message.role),
      history.map(message => message.role),
    );
    assert.deepEqual(
      prior.map(message => message.content),
      history.map(message => message.content),
    );
    for (let turn = 1; turn <= 9; turn++) {
      assert.deepEqual(prior[(turn - 1) * 2], { role: 'user', content: `prior-user-turn-${turn}` });
      assert.deepEqual(prior[(turn - 1) * 2 + 1], { role: 'assistant', content: `prior-assistant-turn-${turn}` });
    }

    assert.deepEqual(committedNodes(answer.events).map(node => node.type), ['prose']);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 20. a 10-user-turn history is rejected with 429 turn_limit before SSE opens', { timeout: 30000 }, async () => {
  const fake = await startFakeOpenAIServer((request, res) => answerModel(request, res, 'unused'));
  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');

    const history = [];
    for (let turn = 1; turn <= 10; turn++) {
      history.push({ role: 'user', content: `prior-user-turn-${turn}` });
      if (turn < 10) history.push({ role: 'assistant', content: `prior-assistant-turn-${turn}` });
    }
    const rejected = await streamCall(server, token, { text: 'an eleventh turn', history });
    assert.equal(rejected.status, 429, rejected.text);
    assert.equal(rejected.contentType.includes('text/event-stream'), false, 'the limit is answered before SSE headers');
    assert.match(rejected.contentType, /application\/json/);
    const body = JSON.parse(rejected.text);
    assert.equal(body.code, 'turn_limit');
    assert.match(String(body.error), /10-turn limit/);
    assert.equal(fake.requests.length, 0, 'the model must not be called past the turn limit');

    const notArray = await streamCall(server, token, { text: 'hello', history: 'nope' });
    assert.equal(notArray.status, 400, notArray.text);
    assert.equal(notArray.contentType.includes('text/event-stream'), false);
    assert.equal(JSON.parse(notArray.text).error, 'history must be an array');

    const badRole = await streamCall(server, token, {
      text: 'hello',
      history: [{ role: 'system', content: 'nope' }],
    });
    assert.equal(badRole.status, 400, badRole.text);
    assert.equal(badRole.contentType.includes('text/event-stream'), false);
    assert.match(JSON.parse(badRole.text).error, /role must be 'user' or 'assistant'/);
  } finally {
    await server.stop();
    await fake.close();
  }
});

/* A synced account that has never created a routine template but does hold real workout
 * history: the case the coach must still be able to analyse and build a new plan from. */
function zeroRoutineScenario() {
  return {
    state: {
      routines: [],
      week: {},
      workouts: [
        {
          id: 'w_zero_1',
          d: '2026-01-08',
          name: 'Push day',
          entries: [
            { id: '0025', sets: [{ w: 60, r: 8 }, { w: 60, r: 8 }, { w: 60, r: 7 }] },
            { id: '0047', sets: [{ w: 40, r: 10 }, { w: 40, r: 10 }] },
          ],
        },
        {
          id: 'w_zero_2',
          d: '2026-01-11',
          name: 'Chest day',
          entries: [
            { id: '0025', sets: [{ w: 62.5, r: 8 }, { w: 62.5, r: 8 }] },
          ],
        },
        {
          id: 'w_zero_3',
          d: '2026-01-15',
          name: 'Upper body',
          entries: [
            { id: '0025', sets: [{ w: 60, r: 8 }] },
            { id: '0047', sets: [{ w: 42.5, r: 9 }] },
          ],
          exercises: [{ id: '0025' }],
        },
      ],
    },
  };
}

function inspectSummary(events) {
  return events.find(
    event => event.type === 'TOOL_CALL_RESULT' && event.toolCallName === 'inspect_training_context',
  )?.summary || '';
}

test('coach-genui 21. a 0-routine account grounds the model in workout history and commits an add-routine proposal', { timeout: 30000 }, async () => {
  const catalogue = loadCatalogue();
  const byId = new Map(catalogue.map(entry => [entry.id, entry]));
  const zh = id => byId.get(id)?.zh || byId.get(id)?.n || '';

  let reply = null;
  const fake = await startFakeOpenAIServer((request, res) => {
    assert.ok(reply, 'the model reply must be prepared before the stream call');
    return answerModel(request, res, reply);
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  }, zeroRoutineScenario());

  try {
    assert.equal(server.seed.state.routines.length, 0, 'the scenario must start without routine templates');
    const expectedExercises = `Recent workout exercises: 0025 "${zh('0025')}", 0047 "${zh('0047')}"`;

    reply = [
      JSON.stringify({ id: 'p_add_routine', type: 'prose', text: '你还没有保存任何计划模板，我先按最近的推力训练为你建一个推日。' }),
      JSON.stringify({
        id: 'prop_add_routine',
        type: 'proposal_action',
        title: '新建推日计划',
        summary: '根据最近的卧推与上斜卧推记录，新建一个每周一、周四执行的推日模板。',
        changes: [{
          id: 'c_add_routine',
          type: 'add-routine',
          target: {},
          why: '最近的训练都以杠铃卧推和上斜卧推为主，可以直接沿用这两个动作。',
          after: {
            name: '推日',
            emoji: '🏋️',
            weekdays: [1, 4],
            ex: [
              { exId: '0025', sets: '4', reps: '8-12' },
              { id: '0047', sets: 3, reps: 10 },
            ],
          },
        }],
      }),
    ].join('\n') + '\n';

    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, {
      text: '帮我新建一个推日计划，安排在周一和周四',
      lang: 'zh',
      plan: { routines: [], week: {} },
    });
    assert.equal(answer.status, 200, answer.text);
    assert.equal(fake.requests.length, 1, 'the run must call the configured model exactly once');

    const summary = inspectSummary(answer.events);
    assert.ok(summary, 'inspect_training_context must emit a TOOL_CALL_RESULT summary');
    assert.match(summary, /Plan: 0 saved routines yet/);
    assert.ok(summary.includes(expectedExercises), `the tool summary must list the frequent exercises:\n${summary}`);
    assert.match(summary, /Recent training: 3 stored sessions/);
    assert.match(summary, /Logged work: /);

    const messages = fake.requests[0].body?.messages || [];
    const prompt = messages.find(message => message?.role === 'system')?.content || '';
    assert.match(prompt, /## Grounded training context/);
    assert.match(prompt, /Plan: 0 saved routines yet/);
    assert.ok(prompt.includes(expectedExercises), `the system prompt must carry the workout exercise anchors:\n${prompt}`);
    assert.equal(
      prompt.includes('## Plan (routines and week)'),
      false,
      'an empty plan must not be serialised into the prompt as a routine list',
    );
    assert.match(prompt, /add-routine/);

    const nodes = committedNodes(answer.events);
    assert.equal(
      nodes.some(node => node.type === 'fallback_notice'),
      false,
      `an add-routine on a 0-routine account must not be downgraded: ${JSON.stringify(nodes)}`,
    );
    const proposal = nodes.find(node => node.id === 'prop_add_routine');
    assert.ok(proposal, `proposal_action must commit: ${JSON.stringify(nodes)}`);
    assert.equal(proposal.type, 'proposal_action');
    assert.equal(proposal.changes.length, 1);

    const change = proposal.changes[0];
    assert.equal(change.type, 'add-routine');
    assert.deepEqual(change.target, {});
    assert.deepEqual(change.after.weekdays, [1, 4]);
    assert.equal(change.after.name, '推日');

    const ex = new Map(change.after.ex.map(item => [item.id, item]));
    assert.deepEqual([...ex.keys()], ['0025', '0047'], 'exIds must normalise to ids in order');
    assert.equal(ex.get('0025').sets, 4);
    assert.equal(ex.get('0025').reps, 10);
    assert.equal(ex.get('0025').repsMin, 8);
    assert.equal(ex.get('0025').repsMax, 12);
    assert.equal(ex.get('0047').sets, 3);
    assert.equal(ex.get('0047').reps, 10);

    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.deepEqual(runFinished.nodes, nodes);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('coach-genui 22. a 0-routine account still downgrades a sets change aimed at a nonexistent routine', { timeout: 30000 }, async () => {
  let reply = null;
  const fake = await startFakeOpenAIServer((request, res) => {
    assert.ok(reply, 'the model reply must be prepared before the stream call');
    return answerModel(request, res, reply);
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'genui-mock-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  }, zeroRoutineScenario());

  try {
    reply = [
      JSON.stringify({ id: 'p_bad_sets', type: 'prose', text: '我先调整一下你现有计划里的组数。' }),
      JSON.stringify({
        id: 'prop_bad_sets',
        type: 'proposal_action',
        title: '调整卧推组数',
        summary: '把卧推的组数下调一组。',
        changes: [{
          id: 'c_bad_sets',
          type: 'sets',
          target: { routineId: 'r_nonexistent', exId: '0025' },
          why: '最近的训练质量下降。',
          after: 2,
        }],
      }),
    ].join('\n') + '\n';

    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const answer = await streamCall(server, token, {
      text: '把我的卧推组数下调一组',
      lang: 'zh',
      plan: { routines: [], week: {} },
    });
    assert.equal(answer.status, 200, answer.text);

    const summary = inspectSummary(answer.events);
    assert.match(summary, /Plan: 0 saved routines yet/);

    const nodes = committedNodes(answer.events);
    assert.equal(
      nodes.some(node => node.type === 'proposal_action'),
      false,
      `a change aimed at a nonexistent routine must not commit: ${JSON.stringify(nodes)}`,
    );
    const degraded = nodes.filter(node => node.type === 'fallback_notice');
    assert.equal(degraded.length, 1, `expected one fallback_notice, got ${JSON.stringify(nodes)}`);
    assert.equal(degraded[0].id, 'prop_bad_sets');
    assert.match(String(degraded[0].text || ''), /未能通过计划校验|not verify that change/);
  } finally {
    await server.stop();
    await fake.close();
  }
});

/* Phase 0 of `rn-coach-genui`: prove the two routes the phone depends on accept the Bearer
 * token a QR pairing stores, with no cookie beside it.
 *
 * `POST /api/pair/redeem` answers `{ token: sessions.makeSession(user) }` (kind 'b'), and
 * `fixtureSession(secret, uid, 'b')` signs the exact same `<uid>:<exp>:<version>:<kind>` payload
 * with the data-volume secret, so it is byte-identical in shape to the phone's stored credential.
 * The forged token below proves the guard validates the HMAC rather than trusting the shape. */
test('coach-genui 23. a paired mobile Bearer token reads /api/config and streams without a cookie', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const forged = fixtureSession('a'.repeat(64), OWNER_ID, 'b');

    // GET /api/config is OptionalSession: a signed-in Bearer must receive the agent/coach
    // blocks, while an unsigned request and a forged token must not.
    const configCall = (bearer) => fetch(server.base + '/api/config', {
      headers: { Accept: 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    });
    const anonymous = await configCall(null);
    assert.equal(anonymous.status, 200, 'an anonymous config read stays public');
    const anonymousBody = await anonymous.json();
    assert.equal('agent' in anonymousBody, false, 'an unsigned request must not receive the agent block');
    assert.equal('coach' in anonymousBody, false, 'an unsigned request must not receive the coach block');

    const forgedConfig = await configCall(forged);
    assert.equal(forgedConfig.status, 200, 'config is optional-session, so a bad Bearer is still public');
    const forgedBody = await forgedConfig.json();
    assert.equal('agent' in forgedBody, false, 'a forged Bearer must not authenticate');

    const signedIn = await configCall(token);
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.headers.get('set-cookie'), null, 'a Bearer request must not set a cookie');
    const config = await signedIn.json();
    assert.equal(config.agent?.enabled, true, `the phone must see the agent enabled: ${JSON.stringify(config)}`);
    assert.ok(
      config.agent?.exerciseSearchVersion === 'v1' || config.agent?.exerciseSearchVersion === 'v2',
      `expected a search version: ${JSON.stringify(config.agent)}`,
    );
    assert.equal(config.coach?.enabled, true, `the fixture Coach must be announced: ${JSON.stringify(config)}`);
    assert.equal(config.coach?.provider, 'fixture');

    // A forged Bearer is refused before any SSE headers are written.
    const refused = await streamCall(server, forged, { text: 'hello' });
    assert.equal(refused.status, 401, refused.text);
    assert.equal(refused.contentType.includes('text/event-stream'), false);

    // The real paired token streams the full ordered AG-UI sequence with no cookie present.
    const answer = await streamCall(server, token, { text: '为什么我的卧推三周没有进步？', lang: 'zh' });
    assert.equal(answer.status, 200, answer.text);
    assert.match(answer.contentType, /^text\/event-stream/i);
    assert.equal(answer.headers.get('set-cookie'), null);
    assertOrdered(answer.events, [
      'RUN_STARTED',
      'STEP_STARTED',
      'TOOL_CALL_START',
      'TOOL_CALL_RESULT',
      'CUSTOM',
      'RUN_FINISHED',
    ]);

    const started = answer.events.find(event => event.type === 'RUN_STARTED');
    assert.equal(typeof started.runId, 'string');
    assert.equal(started.protocolVersion, PROTOCOL_VERSION);

    const nodes = committedNodes(answer.events);
    assert.ok(nodes.length > 0, 'the Bearer stream must commit validated nodes');
    const runFinished = answer.events.at(-1);
    assert.equal(runFinished.type, 'RUN_FINISHED');
    assert.deepEqual(runFinished.nodes, nodes);
    assert.equal(runFinished.text, derivedText(nodes));
  } finally {
    await server.stop();
  }
});
