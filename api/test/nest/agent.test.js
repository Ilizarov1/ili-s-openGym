/* Server execution, idempotency, cancellation and storage isolation.
 *
 * One compiled Nest process per test, a temporary DATA_DIR, the fixture
 * Coach configuration and the parity fixture's account/state seeds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from '../helpers.mjs';
import { seedData, fixtureSession, OWNER_ID, MEMBER_ID } from './parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '../..');

function writeCoach(dir) {
  fs.writeFileSync(path.join(dir, 'coach.json'), JSON.stringify({
    enabled: true,
    provider: 'fixture',
    authMode: 'instance',
    auth: {},
    models: {},
    providerOptions: {},
    boundUid: {},
    caps: { perProfileDaily: 10, instanceDaily: 0 },
    community: false,
  }, null, 2), { mode: 0o600 });
}

function killChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    // Attach before signalling: on Windows the exit event can arrive within
    // the same turn as kill() and a later listener would wait forever.
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

async function startAgentServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-api-'));
  const seed = seedData(dir, 'default');
  writeCoach(dir);
  const server = await spawnServer(dir, extraEnv);
  return { ...server, seed };
}

async function startAgentServerFrom(dir, extraEnv = {}) {
  const secret = fs.readFileSync(path.join(dir, 'secret'), 'utf8').trim();
  const server = await spawnServer(dir, extraEnv);
  return { ...server, seed: { secret } };
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

async function waitRun(server, token, runId) {
  const started = Date.now();
  for (;;) {
    const answer = await call(server, token, `/api/agent/runs/${runId}`);
    assert.equal(answer.status, 200, answer.text);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(answer.body.status)) return answer.body;
    if (Date.now() - started > 5000) throw new Error(`run did not settle: ${JSON.stringify(answer.body)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function startRun(server, token, body) {
  const answer = await call(server, token, '/api/agent/runs', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(answer.status, 202, answer.text);
  return answer.body;
}

test('agent runtime server: profiles, idempotency, proposals, memory, sessions and cancel', { timeout: 30000 }, async () => {
  const server = await startAgentServer();
  try {
    const owner = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const member = fixtureSession(server.seed.secret, MEMBER_ID, 'b');

    const configs = await call(server, owner, '/api/agent/configs');
    assert.equal(configs.status, 200, configs.text);
    assert.equal(configs.body.profiles[0].id, 'default');
    assert.equal(configs.body.profiles[0].available, true);
    assert.equal(configs.body.profiles[0].provider, 'fixture');

    // A1: server default configuration executes the stub task.
    const first = await startRun(server, owner, {
      requestId: 'req_default_0001',
      profileId: 'default',
      input: { prompt: 'hello' },
    });
    const completed = await waitRun(server, owner, first.runId);
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.match(completed.result.text, /fixture:hello/);

    // A6: the same request id and input return the same run; different input conflicts.
    const again = await startRun(server, owner, {
      requestId: 'req_default_0001',
      profileId: 'default',
      input: { prompt: 'hello' },
    });
    assert.equal(again.runId, first.runId);
    const conflict = await call(server, owner, '/api/agent/runs', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'req_default_0001',
        profileId: 'default',
        input: { prompt: 'different' },
      }),
    });
    assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.body.code, 'request_conflict');

    // A1: a server user profile is selectable and its key is never returned.
    const profile = await call(server, owner, '/api/agent/configs', {
      method: 'POST',
      body: JSON.stringify({ provider: 'fixture', model: 'fixture' }),
    });
    assert.equal(profile.status, 201, profile.text);
    assert.ok(profile.body.id);
    assert.equal(profile.body.keyHint, undefined);
    const userRun = await startRun(server, owner, {
      requestId: 'req_user_profile_01',
      profileId: profile.body.id,
      input: { prompt: 'user profile' },
    });
    const userDone = await waitRun(server, owner, userRun.runId);
    assert.equal(userDone.status, 'completed', JSON.stringify(userDone));

    const noEndpoint = await call(server, owner, '/api/agent/configs', {
      method: 'POST',
      body: JSON.stringify({ provider: 'openai', model: 'gpt-test', apiKey: 'sk-test-1234', baseUrl: 'https://evil.example' }),
    });
    assert.equal(noEndpoint.status, 400, noEndpoint.text);

    // A server user key is sealed: only the hint comes back and the file has no plaintext.
    const sealed = await call(server, owner, '/api/agent/configs', {
      method: 'POST',
      body: JSON.stringify({ provider: 'openai', model: 'gpt-test', apiKey: 'sk-secret-1234' }),
    });
    assert.equal(sealed.status, 201, sealed.text);
    assert.equal(sealed.body.keyHint, '1234');
    assert.equal(sealed.body.secret, undefined);
    const agentText = fs.readFileSync(path.join(server.dir, `agent-${OWNER_ID}.json`), 'utf8');
    assert.equal(agentText.includes('sk-secret-1234'), false);
    const afterCreate = await call(server, owner, '/api/agent/configs');
    assert.equal(afterCreate.body.profiles.some(profile => profile.id === sealed.body.id && profile.keyHint === '1234'), true);
    const removedProfile = await call(server, owner, `/api/agent/configs/${sealed.body.id}`, { method: 'DELETE' });
    assert.equal(removedProfile.status, 200, removedProfile.text);

    // A4: two proposals made against version 1; the first consumes it, the second conflicts.
    const p1 = await startRun(server, owner, {
      requestId: 'req_proposal_0001',
      profileId: 'default',
      input: { prompt: 'propose', fixtureCase: 'proposal' },
    });
    const p1run = await waitRun(server, owner, p1.runId);
    assert.equal(p1run.status, 'completed', JSON.stringify(p1run));
    assert.equal(p1run.result.proposal.targetVersion, 1);
    const p2 = await startRun(server, owner, {
      requestId: 'req_proposal_0002',
      profileId: 'default',
      input: { prompt: 'propose again', fixtureCase: 'proposal' },
    });
    const p2run = await waitRun(server, owner, p2.runId);
    assert.equal(p2run.status, 'completed', JSON.stringify(p2run));

    const confirm1 = await call(server, owner, `/api/agent/proposals/${p1run.result.proposal.proposalId}/confirm`, { method: 'POST' });
    assert.equal(confirm1.status, 200, confirm1.text);
    assert.equal(confirm1.body.applied, true);
    assert.equal(confirm1.body.result.version, 2);
    const confirmAgain = await call(server, owner, `/api/agent/proposals/${p1run.result.proposal.proposalId}/confirm`, { method: 'POST' });
    assert.equal(confirmAgain.status, 200, confirmAgain.text);
    assert.equal(confirmAgain.body.applied, false);
    assert.deepEqual(confirmAgain.body.result, confirm1.body.result);
    const stale = await call(server, owner, `/api/agent/proposals/${p2run.result.proposal.proposalId}/confirm`, { method: 'POST' });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.code, 'proposal_conflict');

    // A5: memories are account-scoped and deletion affects the next read.
    const memory = await call(server, owner, '/api/agent/memories', {
      method: 'POST',
      body: JSON.stringify({ category: 'preference', value: { like: 'morning' }, source: 'user' }),
    });
    assert.equal(memory.status, 201, memory.text);
    const ownerMemories = await call(server, owner, '/api/agent/memories');
    assert.equal(ownerMemories.body.memories.length, 1);
    const memberMemories = await call(server, member, '/api/agent/memories');
    assert.equal(memberMemories.body.memories.length, 0);
    const removed = await call(server, owner, `/api/agent/memories/${memory.body.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200, removed.text);
    assert.equal((await call(server, owner, '/api/agent/memories')).body.memories.length, 0);

    // A5: deleting a conversation while its run is open does not let the run recreate it.
    const sessionId = 'ses_delete_0001';
    const late = await startRun(server, owner, {
      requestId: 'req_session_delete',
      profileId: 'default',
      sessionId,
      input: { prompt: 'late', fixtureCase: 'late' },
    });
    const deleted = await call(server, owner, `/api/agent/sessions/${sessionId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200, deleted.text);
    const lateRun = await waitRun(server, owner, late.runId);
    assert.ok(['cancelled', 'completed'].includes(lateRun.status), JSON.stringify(lateRun));
    const gone = await call(server, owner, `/api/agent/sessions/${sessionId}`);
    assert.equal(gone.status, 409, gone.text);

    // A7: cancel commits before the late answer arrives.
    const cancelledStart = await startRun(server, owner, {
      requestId: 'req_cancel_00001',
      profileId: 'default',
      input: { prompt: 'cancel me', fixtureCase: 'late' },
    });
    const cancelled = await call(server, owner, `/api/agent/runs/${cancelledStart.runId}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.body.status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 350));
    const still = await call(server, owner, `/api/agent/runs/${cancelledStart.runId}`);
    assert.equal(still.body.status, 'cancelled');
    assert.equal(still.body.result, undefined);

    // Cross-account reads are 404, not another profile's run.
    const foreign = await call(server, member, `/api/agent/runs/${first.runId}`);
    assert.equal(foreign.status, 404, foreign.text);
  } finally {
    await server.stop();
  }
});

test('AGENT_RUNTIME_DISABLED turns every agent route into agent_disabled', { timeout: 20000 }, async () => {
  const server = await startAgentServer({ AGENT_RUNTIME_DISABLED: '1' });
  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const configs = await call(server, token, '/api/agent/configs');
    assert.equal(configs.status, 503, configs.text);
    assert.equal(configs.body.code, 'agent_disabled');
    const config = await call(server, token, '/api/config');
    assert.equal(config.body.agent.enabled, false);
  } finally {
    await server.stop();
  }
});

test('the rollback switch keeps agent data readable when it is switched back on', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-rollback-'));
  seedData(dir, 'default');
  writeCoach(dir);
  let server = await startAgentServerFrom(dir);
  const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
  try {
    const memory = await call(server, token, '/api/agent/memories', {
      method: 'POST',
      body: JSON.stringify({ category: 'preference', value: { keep: 'me' }, source: 'user' }),
    });
    assert.equal(memory.status, 201, memory.text);
  } finally {
    await server.stop({ keep: true });
  }

  server = await startAgentServerFrom(dir, { AGENT_RUNTIME_DISABLED: '1' });
  try {
    const off = await call(server, token, '/api/agent/memories');
    assert.equal(off.status, 503, off.text);
    assert.equal(off.body.code, 'agent_disabled');
    const config = await call(server, token, '/api/config');
    assert.equal(config.body.agent.enabled, false);
  } finally {
    await server.stop({ keep: true });
  }

  server = await startAgentServerFrom(dir);
  try {
    const back = await call(server, token, '/api/agent/memories');
    assert.equal(back.status, 200, back.text);
    assert.equal(back.body.memories.length, 1);
    assert.deepEqual(back.body.memories[0].value, { keep: 'me' });
  } finally {
    await server.stop();
  }
});

test('an open run is interrupted on the next boot', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-boot-'));
  const seed = seedData(dir, 'default');
  writeCoach(dir);
  fs.writeFileSync(path.join(dir, `agent-${MEMBER_ID}.json`), JSON.stringify({
    schema: 1,
    profiles: {},
    requestIndex: { req_boot_000001: 'run_open' },
    runs: {
      run_open: {
        runId: 'run_open',
        requestId: 'req_boot_000001',
        requestHash: 'hash',
        taskId: 'stub.v1',
        profileId: 'default',
        executionLocation: 'server',
        status: 'running',
        createdAt: 1,
        startedAt: 2,
      },
    },
    sessions: {},
    memories: {},
    proposals: {},
    stub: { targets: {}, facts: {}, writes: [] },
  }), { mode: 0o600 });
  const server = await startAgentServerFrom(dir);
  try {
    const token = fixtureSession(seed.secret, MEMBER_ID, 'b');
    const run = await waitRun(server, token, 'run_open');
    assert.equal(run.status, 'interrupted');
    assert.equal(run.error.code, 'run_terminal');
  } finally {
    await server.stop();
  }
});
