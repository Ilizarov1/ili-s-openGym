import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { boundPort } from '../helpers.mjs';
import { API, NEST_ENTRY, fixtureSession, seedData, ownerState } from './parity.mjs';
import { createOutbox } from '../../integrations/outbox.js';

const built = fs.existsSync(path.join(API, NEST_ENTRY));

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-shutdown-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return seedData(dir);
}

function environment(seed) {
  return {
    DATA_DIR: seed.dir, PORT: '0', ORIGIN: 'http://localhost:8080', RP_ID: 'localhost',
    SHUTDOWN_BUDGET_MS: '1200', MEDIA_UPLOADS: '1', INTEGRATIONS: '',
    COACH_DISABLED: '1', ADMIN_SOCKET_DIR: path.join(seed.dir, 'admin'),
  };
}

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(20);
  }
  assert.fail('condition did not become ready');
}

function startUpload(port, seed) {
  const req = http.request({
    host: '127.0.0.1', port, method: 'PUT', path: '/api/media/' + 'a'.repeat(64),
    headers: {
      Authorization: `Bearer ${fixtureSession(seed.secret)}`,
      'Content-Type': 'image/png',
      'Content-Length': '1000',
    },
  });
  const closed = new Promise(resolve => {
    req.once('error', resolve);
    req.once('response', res => { res.resume(); resolve(res.statusCode); });
  });
  req.write(Buffer.from('89504e470d0a1a0a', 'hex'));
  const tmp = path.join(seed.dir, 'uploads', seed.ownerId, '.tmp');
  return { req, closed, files: () => fs.existsSync(tmp) ? fs.readdirSync(tmp) : [] };
}

test('app.close drains an admitted write and cancels uploads, outbox work and Coach children', { skip: !built, timeout: 15000 }, async t => {
  const seed = fixture(t);
  Object.assign(process.env, environment(seed), { COACH_DISABLED: '0' });
  const { startApi } = await import('../../dist/src/start-api.js');
  const { LifecycleCoordinator } = await import('../../dist/src/lifecycle/lifecycle.coordinator.js');
  const cfg = await import('../../dist/coach/config.js');
  const jobs = await import('../../dist/coach/jobs.js');
  const { adapterFor } = await import('../../dist/coach/adapters/index.js');
  const { run, forcePrivilegeVerdict } = await import('../../dist/coach/adapters/spawn.js');
  cfg.save({ enabled: true, provider: 'fixture' });
  forcePrivilegeVerdict({ ok: true, dropped: false });

  const app = await startApi(0);
  let closing;
  t.after(() => closing ?? app.close());
  const coordinator = app.get(LifecycleCoordinator);
  const port = app.getHttpServer().address().port;
  assert.equal(app.getHttpServer().requestTimeout, 30 * 60000);
  assert.equal(app.getHttpServer().headersTimeout, 60000);

  const manifests = [];
  t.mock.method(adapterFor('fixture'), 'invoke', ({ jobDir, signal }) => {
    const manifest = path.join(jobDir, 'pid');
    manifests.push(manifest);
    return run(process.execPath, [
      '-e', "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
      manifest,
    ], { cwd: jobDir, signal, asCoach: false });
  });

  const uids = [seed.ownerId, seed.adminId, seed.memberId];
  const consented = { ...ownerState(), coach: { consent: { agreedAt: 1 } } };
  const priorProposal = { id: 'prior', kind: 'review', expiresAt: Date.now() + 60000 };
  fs.mkdirSync(path.join(seed.dir, 'coach'), { recursive: true });
  fs.writeFileSync(path.join(seed.dir, 'coach', `${seed.ownerId}.json`), JSON.stringify({ pending: priorProposal }));
  for (const uid of uids) {
    fs.writeFileSync(path.join(seed.dir, `state-${uid}.json`), JSON.stringify(consented));
    jobs.enqueue(uid, { kind: 'ask', note: 'Fixture question' });
  }
  await until(() => manifests.length === 2 && manifests.every(file => fs.existsSync(file) && fs.readFileSync(file, 'utf8')));
  const pids = manifests.map(file => Number(fs.readFileSync(file, 'utf8')));
  assert.equal(jobs.readUser(seed.memberId).current.state, 'queued');

  const deliveries = [];
  const file = path.join(seed.dir, 'outbox-test.json');
  const outbox = createOutbox({
    file, concurrency: 1, signal: coordinator.signal,
    deliver: job => new Promise(resolve => {
      deliveries.push(job.id);
      coordinator.signal.addEventListener('abort', () => resolve({ ok: false, retry: true }), { once: true });
    }),
  });
  coordinator.register({ name: 'test-outbox', stop: () => outbox.stop() });
  outbox.enqueue({ id: 'first', key: 'first' });
  outbox.enqueue({ id: 'second', key: 'second' });
  const delivery = outbox.run();
  assert.deepEqual(deliveries, ['first']);

  const upload = startUpload(port, seed);
  t.after(() => upload.req.destroy());
  await until(() => upload.files().length === 1);

  const body = JSON.stringify({ state: { ...consented, targetW: 81 }, baseRev: 0 });
  const write = http.request({
    host: '127.0.0.1', port, method: 'PUT', path: '/api/data',
    headers: {
      Authorization: `Bearer ${fixtureSession(seed.secret)}`,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
    },
  });
  t.after(() => write.destroy());
  const written = once(write, 'response');
  write.flushHeaders();
  const { RequestHook } = await import('../../dist/src/common/http/request-hook.js');
  await until(() => app.get(RequestHook).inFlight === 2);

  closing = app.close();
  await until(() => coordinator.closing);
  const refused = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).code, 'closing');
  write.end(body);
  const [response] = await written;
  response.resume();
  assert.equal(response.statusCode, 200);

  await closing;
  assert.equal(app.getHttpServer().listening, false);
  await delivery;
  assert.ok((await upload.closed) instanceof Error);
  assert.deepEqual(upload.files(), []);
  assert.equal(JSON.parse(fs.readFileSync(path.join(seed.dir, `state-${seed.ownerId}.json`))).targetW, 81);
  assert.deepEqual(deliveries, ['first']);
  assert.equal(manifests.length, 2, 'the queued Coach job never starts');
  assert.ok(manifests.every(manifest => !fs.existsSync(manifest)), 'Coach work directories were reclaimed');
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

  const retried = [];
  const restarted = createOutbox({ file, deliver: job => {
    retried.push([job.id, job.attempts]);
    return { ok: true };
  } });
  await restarted.run();
  assert.deepEqual(retried, [['first', 0], ['second', 0]]);
  assert.equal(jobs.recoverOnBoot(), 3);
  assert.deepEqual(jobs.readUser(seed.ownerId).pending, priorProposal);
  for (const uid of uids) {
    assert.equal(jobs.readUser(uid).current, null);
    assert.equal(jobs.readUser(uid).history.at(-1).errorClass, 'restart');
  }
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} on the real entry cleans a slow upload before exit`, {
    skip: !built || process.platform === 'win32', timeout: 12000,
  }, async t => {
    const seed = fixture(t);
    const child = spawn(process.execPath, [NEST_ENTRY], {
      cwd: API, env: { ...process.env, ...environment(seed) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exit = once(child, 'exit');
    t.after(() => child.kill('SIGKILL'));
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    const port = await boundPort(child, () => log);
    const upload = startUpload(port, seed);
    t.after(() => upload.req.destroy());
    await until(() => upload.files().length === 1);
    child.kill(signal);
    const [code, exitSignal] = await exit;
    assert.ok(code === 0 || exitSignal === signal, log);
    assert.ok((await upload.closed) instanceof Error);
    assert.deepEqual(upload.files(), []);
    assert.doesNotMatch(log, /shutdown cleanup exceeded/);
  });
}
