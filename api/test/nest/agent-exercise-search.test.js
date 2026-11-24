/* AI exercise search over the real Nest routes: inline media, session modes,
 * turn/session guards, TTL cleanup and capability errors. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from '../helpers.mjs';
import { seedData, fixtureSession, OWNER_ID } from './parity.mjs';
import { PNG_1X1_DATA_URL } from '../agent-fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '../..');

function coachConfig(over = {}) {
  return {
    enabled: true,
    provider: 'fixture',
    authMode: 'instance',
    auth: {},
    models: {},
    providerOptions: {},
    boundUid: {},
    caps: { perProfileDaily: 10, instanceDaily: 0 },
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
    async stop({ keep = false } = {}) {
      await killChild(child);
      if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function startServer(extraEnv = {}, coach = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-exercise-api-'));
  const seed = seedData(dir, 'default');
  writeCoach(dir, coach);
  const server = await spawnServer(dir, extraEnv);
  return { ...server, seed };
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Origin: 'http://localhost:8080',
  };
}

async function call(server, token, route, init = {}) {
  const response = await fetch(server.base + route, {
    ...init,
    headers: { ...headers(token), ...(init.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text };
}

async function waitRun(server, token, runId, timeout = 5000) {
  const started = Date.now();
  for (;;) {
    const answer = await call(server, token, `/api/agent/runs/${runId}`);
    assert.equal(answer.status, 200, answer.text);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(answer.body.status)) return answer.body;
    if (Date.now() - started > timeout) throw new Error(`run did not settle: ${JSON.stringify(answer.body)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function startRun(server, token, body) {
  return call(server, token, '/api/agent/runs', { method: 'POST', body: JSON.stringify(body) });
}

function agentFile(dir, uid = OWNER_ID) {
  return path.join(dir, `agent-${uid}.json`);
}

test('DeepSeek is the instance preset and a retired profile needs a new credential', { timeout: 30000 }, async () => {
  const server = await startServer({ DEEPSEEK_API_KEY: 'fake-deepseek-key', DEEPSEEK_MODEL: 'deepseek-v4-pro' });
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const id = 'prf_retired_go';
    const legacy = {
      id, provider: 'opencode', model: 'legacy-model', version: 1, createdAt: 1, updatedAt: 1,
      capabilities: { text: true, image: true, tools: true },
      keyHint: 'test', secret: { v: 1, iv: '', tag: '', data: '' },
    };
    fs.writeFileSync(agentFile(server.dir), JSON.stringify({ schema: 1, profiles: { [id]: legacy } }));

    const listing = await call(server, token, '/api/agent/configs');
    assert.equal(listing.status, 200);
    const [instance, old] = listing.body.profiles;
    assert.equal(instance.provider, 'deepseek');
    assert.equal(instance.model, 'deepseek-v4-pro');
    assert.equal(instance.capabilities.image, false);
    assert.equal(old.provider, 'none');
    assert.equal(old.available, false);
    assert.equal(old.keyHint, undefined);
    const start = await startRun(server, token, {
      taskId: 'exercise-search.v1', requestId: 'req_retired_profile_0001',
      profileId: id, input: { hintText: 'squat' },
    });
    assert.equal(start.status, 404);
    assert.equal(start.body.code, 'profile_not_found');

    const route = '/api/agent/configs/' + id;
    const change = { provider: 'deepseek', model: 'deepseek-flash' };
    const missing = await call(server, token, route, { method: 'PATCH', body: JSON.stringify(change) });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'invalid_request');

    const updated = await call(server, token, route, {
      method: 'PATCH', body: JSON.stringify({ ...change, apiKey: 'replacement-deepseek-test' }),
    });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.body.provider, 'deepseek');
    assert.equal(updated.body.available, true);
    assert.equal(updated.body.capabilities.image, true);
    assert.equal(updated.body.secret, undefined);
  } finally {
    await server.stop();
  }
});

test('exercise-search.v1 runs text and inline images, reports a profile summary and stores metadata only', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const profiles = await call(server, token, '/api/agent/configs');
    assert.equal(profiles.status, 200, profiles.text);
    assert.equal(profiles.body.profiles[0].provider, 'fixture');

    const started = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_text_0001',
      profileId: 'default',
      sessionId: 'ses_ai_text_0001',
      sessionMode: 'new',
      input: { hintText: '坐着往上推的器械', fixtureCase: 'candidates' },
    });
    assert.equal(started.status, 202, started.text);
    assert.equal(started.body.profile.id, 'default');
    assert.equal(started.body.profile.label, 'Fixture (instance)');
    assert.equal(started.body.profile.provider, 'fixture');
    assert.equal(JSON.stringify(started.body).includes('apiKey'), false);

    const run = await waitRun(server, token, started.body.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.result.structured.candidates.length, 2);
    assert.ok(run.result.structured.fallback.understanding);
    assert.equal(run.profile.id, 'default');
    assert.equal(run.profile.label, 'Fixture (instance)');

    const session = await call(server, token, '/api/agent/sessions/ses_ai_text_0001');
    assert.equal(session.status, 200, session.text);
    assert.equal(session.body.taskId, 'exercise-search.v1');
    assert.equal(session.body.messages.length, 2);
    assert.equal(session.body.messages[0].content, '坐着往上推的器械');
    assert.equal(session.body.messages[1].meta.candidates, 2);
    assert.equal(JSON.stringify(session.body).includes('base64'), false);

    const image = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_image_0001',
      profileId: 'default',
      sessionId: 'ses_ai_image_0001',
      sessionMode: 'new',
      input: { images: [PNG_1X1_DATA_URL], fixtureCase: 'fallback-only' },
    });
    assert.equal(image.status, 202, image.text);
    const imageRun = await waitRun(server, token, image.body.runId);
    assert.equal(imageRun.status, 'completed', JSON.stringify(imageRun));
    assert.deepEqual(imageRun.result.structured.candidates, []);
    assert.ok(imageRun.result.structured.fallback.understanding);

    const imageSession = await call(server, token, '/api/agent/sessions/ses_ai_image_0001');
    assert.equal(imageSession.status, 200, imageSession.text);
    assert.equal(imageSession.body.messages[0].content, '[图片]');
    assert.equal(imageSession.body.messages[0].meta.images.length, 1);
    assert.equal(imageSession.body.messages[0].meta.images[0].mime, 'image/png');
    assert.equal(JSON.stringify(imageSession.body).includes('base64'), false);

    const file = fs.readFileSync(agentFile(server.dir), 'utf8');
    assert.equal(file.includes('base64'), false, 'the run store must not keep image payloads');
    assert.equal(file.includes(PNG_1X1_DATA_URL.slice(30, 60)), false);
  } finally {
    await server.stop();
  }
});

test('input, inline media and body limits fail before or during the run with stable codes', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const blank = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_blank_0001',
      profileId: 'default',
      input: { hintText: '   ' },
    });
    assert.equal(blank.status, 400, blank.text);
    assert.equal(blank.body.code, 'invalid_request');

    const tooMany = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_many_0001',
      profileId: 'default',
      input: { images: [PNG_1X1_DATA_URL, PNG_1X1_DATA_URL, PNG_1X1_DATA_URL] },
    });
    assert.equal(tooMany.status, 400, tooMany.text);
    assert.equal(tooMany.body.code, 'agent_media_invalid');

    const wrongUrl = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_url_0001',
      profileId: 'default',
      input: { images: ['not-an-image'] },
    });
    assert.equal(wrongUrl.status, 400, wrongUrl.text);
    assert.equal(wrongUrl.body.code, 'agent_media_invalid');

    const fake = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_fake_0001',
      profileId: 'default',
      input: { images: [`data:image/png;base64,${Buffer.from('not a png').toString('base64')}`] },
    });
    assert.equal(fake.status, 202, fake.text);
    const failed = await waitRun(server, token, fake.body.runId);
    assert.equal(failed.status, 'failed', JSON.stringify(failed));
    assert.equal(failed.error.code, 'agent_media_invalid');

    const oversized = await fetch(server.base + '/api/agent/runs', {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        taskId: 'exercise-search.v1',
        requestId: 'req_ai_body_0001',
        profileId: 'default',
        input: { hintText: 'x'.repeat(5 * 1024 * 1024 + 1024) },
      }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await server.stop();
  }
});

test('continue never creates an empty session, and delete leaves no messages', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const missing = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_continue_0001',
      profileId: 'default',
      sessionId: 'ses_ai_missing_0001',
      sessionMode: 'continue',
      input: { hintText: 'row' },
    });
    assert.equal(missing.status, 409, missing.text);
    assert.equal(missing.body.code, 'session_deleted');
    const after = await call(server, token, '/api/agent/sessions/ses_ai_missing_0001');
    assert.equal(after.status, 409);

    const first = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_delete_0001',
      profileId: 'default',
      sessionId: 'ses_ai_delete_0001',
      sessionMode: 'new',
      input: { hintText: 'row', fixtureCase: 'candidates' },
    });
    assert.equal(first.status, 202, first.text);
    await waitRun(server, token, first.body.runId);
    const removed = await call(server, token, '/api/agent/sessions/ses_ai_delete_0001', { method: 'DELETE' });
    assert.equal(removed.status, 200, removed.text);
    const gone = await call(server, token, '/api/agent/sessions/ses_ai_delete_0001');
    assert.equal(gone.status, 409);
    const data = JSON.parse(fs.readFileSync(agentFile(server.dir), 'utf8'));
    assert.deepEqual(data.sessions.ses_ai_delete_0001.messages, []);
    assert.ok(data.sessions.ses_ai_delete_0001.deletedAt);
  } finally {
    await server.stop();
  }
});

test('a session allows six submitted runs, then turn_limit; cleanup removes stale AI runs and sessions', { timeout: 60000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    let firstRunId = null;
    for (let index = 0; index < 6; index++) {
      const answer = await startRun(server, token, {
        taskId: 'exercise-search.v1',
        requestId: `req_ai_turn_${String(index).padStart(4, '0')}`,
        profileId: 'default',
        sessionId: 'ses_ai_turns_0001',
        sessionMode: index === 0 ? 'new' : 'continue',
        input: { hintText: `turn ${index}`, fixtureCase: 'candidates' },
      });
      assert.equal(answer.status, 202, answer.text);
      if (index === 0) firstRunId = answer.body.runId;
      const run = await waitRun(server, token, answer.body.runId);
      assert.equal(run.status, 'completed', JSON.stringify(run));
    }
    const limited = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_turn_0006',
      profileId: 'default',
      sessionId: 'ses_ai_turns_0001',
      sessionMode: 'continue',
      input: { hintText: 'one too many' },
    });
    assert.equal(limited.status, 429, limited.text);
    assert.equal(limited.body.code, 'turn_limit');

    const dataFile = agentFile(server.dir);
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const stale = Date.now() - 3 * 60 * 60 * 1000;
    data.sessions.ses_ai_turns_0001.updatedAt = stale;
    data.sessions.ses_ai_turns_0001.meta.turns = 1;
    for (const run of Object.values(data.runs)) {
      if (run.taskId === 'exercise-search.v1') run.finishedAt = stale;
    }
    fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

    const trigger = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_ttl_0001',
      profileId: 'default',
      sessionId: 'ses_ai_ttl_0001',
      sessionMode: 'new',
      input: { hintText: 'cleanup' },
    });
    assert.equal(trigger.status, 202, trigger.text);
    await waitRun(server, token, trigger.body.runId);
    const oldRun = await call(server, token, `/api/agent/runs/${firstRunId}`);
    assert.equal(oldRun.status, 404, oldRun.text);
    const oldSession = await call(server, token, '/api/agent/sessions/ses_ai_turns_0001');
    assert.equal(oldSession.status, 409);
  } finally {
    await server.stop();
  }
});

test('an image-incapable profile rejects a photo but still answers text', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const created = await call(server, token, '/api/agent/configs', {
      method: 'POST',
      body: JSON.stringify({ provider: 'fixture', model: 'fixture', capabilities: { image: false } }),
    });
    assert.equal(created.status, 201, created.text);
    const profile = created.body;
    assert.equal(profile.capabilities.image, false);

    const text = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_cap_text_0001',
      profileId: profile.id,
      input: { hintText: 'row', fixtureCase: 'candidates' },
    });
    assert.equal(text.status, 202, text.text);
    assert.equal((await waitRun(server, token, text.body.runId)).status, 'completed');

    const image = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_cap_image_0001',
      profileId: profile.id,
      input: { images: [PNG_1X1_DATA_URL], fixtureCase: 'candidates' },
    });
    assert.equal(image.status, 202, image.text);
    const failed = await waitRun(server, token, image.body.runId);
    assert.equal(failed.status, 'failed', JSON.stringify(failed));
    assert.equal(failed.error.code, 'profile_capability_missing');
  } finally {
    await server.stop();
  }
});

test('AGENT_VISION=0 removes image capability from the server default but keeps text', { timeout: 30000 }, async () => {
  const server = await startServer({ AGENT_VISION: '0' });
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const profiles = await call(server, token, '/api/agent/configs');
    assert.equal(profiles.status, 200, profiles.text);
    assert.equal(profiles.body.profiles[0].capabilities.image, false);

    const text = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_vision_text_0001',
      profileId: 'default',
      input: { hintText: 'row', fixtureCase: 'candidates' },
    });
    assert.equal(text.status, 202, text.text);
    assert.equal((await waitRun(server, token, text.body.runId)).status, 'completed');

    const image = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_vision_image_0001',
      profileId: 'default',
      input: { images: [PNG_1X1_DATA_URL] },
    });
    assert.equal(image.status, 202, image.text);
    const failed = await waitRun(server, token, image.body.runId);
    assert.equal(failed.status, 'failed', JSON.stringify(failed));
    assert.equal(failed.error.code, 'profile_capability_missing');
  } finally {
    await server.stop();
  }
});

test('a second run in the same live session returns session_busy', { timeout: 30000 }, async () => {
  const slow = http.createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              candidates: [{ name: 'barbell bench press', rationale: 'slow fixture', level: 'high' }],
              fallback: { understanding: 'slow fixture' },
            }),
          },
        }],
      }));
    }, 300);
  });
  await new Promise(resolve => slow.listen(0, '127.0.0.1', resolve));
  const port = slow.address().port;
  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'slow-model' },
    providerOptions: { compatible: { baseUrl: `http://127.0.0.1:${port}/v1` } },
  });
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const first = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_busy_0001',
      profileId: 'default',
      sessionId: 'ses_ai_busy_0001',
      sessionMode: 'new',
      input: { hintText: 'bench press' },
    });
    assert.equal(first.status, 202, first.text);
    const second = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_ai_busy_0002',
      profileId: 'default',
      sessionId: 'ses_ai_busy_0001',
      sessionMode: 'continue',
      input: { hintText: 'bench press again' },
    });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.body.code, 'session_busy');
    assert.equal((await waitRun(server, token, first.body.runId)).status, 'completed');
  } finally {
    await server.stop();
    await new Promise(resolve => slow.close(resolve));
  }
});

test('exercise-search.v2 advertises its version, ranks public IDs and projects names for follow-ups', { timeout: 30000 }, async () => {
  const server = await startServer({ EXERCISE_SEARCH_VERSION: 'v2', AGENT_EXERCISE_SEARCH_DIAGNOSTICS: '1' });
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const config = await call(server, token, '/api/config');
    assert.deepEqual(config.body.agent, { enabled: true, exerciseSearchVersion: 'v2' });
    const catalogue = JSON.parse(fs.readFileSync(path.join(API, 'agent-runtime', 'tasks', 'exercise-search-catalogue.json'), 'utf8'));
    const byId = new Map(catalogue.map(entry => [entry.id, entry]));
    const sessionId = 'ses_retrieval_0001';
    const requestId = 'req_7677bd31-bfca-4c48-95fb-702a4a22db1c';
    const text = '坐姿推胸 retrieval-private-marker';
    const request = { taskId: 'exercise-search.v2', profileId: 'default', sessionId, input: { hintText: text } };
    const invalid = await startRun(server, token, {
      ...request, requestId: 'req_retrieval_bad_equipment',
      input: { hintText: text, confirmedEquipment: 'not-in-catalogue' },
    });
    assert.equal(invalid.status, 400, invalid.text);
    assert.equal(invalid.body.code, 'invalid_request');

    const initial = await startRun(server, token, { ...request, requestId });
    assert.equal(initial.status, 202, initial.text);
    const first = await waitRun(server, token, initial.body.runId);
    assert.equal(first.status, 'completed', JSON.stringify(first));
    const { rankedIds, items, fallback, ...extra } = first.result.structured;
    assert.ok(fallback.understanding);
    assert.ok(rankedIds.length > 0 && rankedIds.length <= 10);
    assert.equal(new Set(rankedIds).size, rankedIds.length);
    assert.ok(rankedIds.every(id => byId.has(id)));
    if (items) assert.deepEqual(items.map(item => item.id), rankedIds);
    assert.ok(Object.keys(extra).every(key => key === 'clarifications'));

    const session = await call(server, token, `/api/agent/sessions/${sessionId}`);
    assert.equal(session.status, 200, session.text);
    assert.equal(session.body.taskId, 'exercise-search.v2');
    const answer = JSON.parse(session.body.messages.at(-1).content);
    assert.equal(answer.fallback.understanding, fallback.understanding);
    assert.deepEqual(answer.candidates.map(candidate => candidate.nameEn), rankedIds.map(id => byId.get(id).n));
    assert.deepEqual(answer.candidates.map(candidate => candidate.name), rankedIds.map(id => byId.get(id).zh || byId.get(id).n));

    const events = server.log().split('\n').filter(line => line.startsWith('{"event":"exercise_search"'))
      .map(line => JSON.parse(line)).filter(event => event.traceId === requestId);
    for (const stage of ['retrieval_text', 'retrieval_vector', 'retrieval_fusion', 'rerank']) {
      assert.ok(events.some(event => event.stage === stage), `missing diagnostic stage ${stage}`);
    }
    assert.doesNotMatch(JSON.stringify(events), /retrieval-private-marker/);

    for (let turn = 2; turn <= 6; turn++) {
      const next = await startRun(server, token, {
        ...request, requestId: `req_retrieval_turn_${turn}`, sessionMode: 'continue',
        input: { hintText: '换个坐姿的', fixtureCase: 'fallback-only', confirmedEquipment: 'dumbbell' },
      });
      assert.equal(next.status, 202, next.text);
      const followUp = await waitRun(server, token, next.body.runId);
      assert.equal(followUp.status, 'completed', JSON.stringify(followUp));
      assert.deepEqual(followUp.result.structured.rankedIds, []);
    }
    const extraTurn = await startRun(server, token, {
      ...request, requestId: 'req_retrieval_turn_7', sessionMode: 'continue',
    });
    assert.equal(extraTurn.status, 429, extraTurn.text);
    assert.equal(extraTurn.body.code, 'turn_limit');
  } finally {
    await server.stop();
  }
});

test('v1 remains usable after the server rolls back its exercise-search version', { timeout: 30000 }, async () => {
  const server = await startServer({ EXERCISE_SEARCH_VERSION: 'v1' });
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const config = await call(server, token, '/api/config');
    assert.equal(config.body.agent.exerciseSearchVersion, 'v1');
    const request = { requestId: 'req_retrieval_rollback', profileId: 'default', input: { hintText: '俯卧撑' } };
    const disabled = await startRun(server, token, { ...request, taskId: 'exercise-search.v2' });
    assert.equal(disabled.status, 503, disabled.text);
    assert.equal(disabled.body.code, 'retrieval_unavailable');
    const legacy = await startRun(server, token, { ...request, taskId: 'exercise-search.v1' });
    assert.equal(legacy.status, 202, legacy.text);
    const answer = await waitRun(server, token, legacy.body.runId);
    assert.equal(answer.status, 'completed');
    assert.ok(Array.isArray(answer.result.structured.candidates));
  } finally {
    await server.stop();
  }
});
