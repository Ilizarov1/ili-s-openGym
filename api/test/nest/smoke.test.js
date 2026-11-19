/* Smoke test for the parity harness itself (docs/nestjs-migration/EXECUTION.md 0.3).
 *
 * Before the harness was trusted it had to agree with itself: the same fixture started twice
 * from the selected entry must produce the same status, keys, headers and disk result, and
 * stopping both must remove every temporary directory. After the phase 4 switch the default
 * `server.js` is the thin loader for `dist/src/main.js`, so the cross-entry test now proves that
 * both ways of starting the candidate serve the same application.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { API, LEGACY_ENTRY, NEST_ENTRY, startBoth, fixtureSession, normalizeResponse, compareJson, compareDisk } from './parity.mjs';

const hasNest = fs.existsSync(path.join(API, NEST_ENTRY));
const PATHS = ['/api/health', '/api/config'];

async function get(entry, p) {
  return normalizeResponse(await fetch(entry.base + p, { headers: { Accept: 'application/json' } }));
}

async function exercise(h) {
  for (const p of PATHS) {
    const left = await get(h.legacy, p);
    const right = await get(h.nest, p);
    assert.equal(left.status, 200, `${p} status on the left`);
    assert.equal(right.status, 200, `${p} status on the right`);
    assert.deepEqual(compareJson(left, right), [], `${p} responses differ`);
  }
  assert.deepEqual(compareDisk(h.legacy.dataDir, h.nest.dataDir), [], 'disk differs after the same requests');
}

test('parity fixture: the selected entry matches itself, and cleanup removes its temp dirs', async () => {
  const h = await startBoth('default', { second: LEGACY_ENTRY });
  try {
    await exercise(h);
  } finally {
    await h.legacy.stop();
    await h.nest.stop();
  }
  assert.equal(fs.existsSync(h.root), false, `temporary fixture directory was left behind: ${h.root}`);
});

test('the default entry and the compiled entry agree on health, config, sessions and conditional writes', { skip: !hasNest }, async t => {
  const h = await startBoth('default');
  t.after(async () => {
    await h.legacy.stop();
    await h.nest.stop();
  });
  assert.equal(h.legacy.entry, LEGACY_ENTRY);
  assert.equal(h.nest.entry, NEST_ENTRY);
  await exercise(h);

  const nearExpiry = fixtureSession(h.seed.secret);
  const renewed = await fetch(h.legacy.base + '/api/me', { headers: { Authorization: `Bearer ${nearExpiry}` } });
  assert.equal(renewed.status, 200);
  const { token } = await renewed.json();
  assert.ok(token && token !== nearExpiry, 'Bearer token is renewed by the legacy service');
  const cookie = `gymsid=${fixtureSession(h.seed.secret, h.seed.ownerId, 'c')}`;
  const data = structuredClone(h.seed.state);
  data.workouts.push({ id: 'w_parity_new', d: '2026-01-16', name: 'Parity workout', entries: [] });

  async function write(entry) {
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const current = await fetch(entry.base + '/api/data', { headers: { Cookie: cookie } });
    assert.equal(current.status, 200);
    const { rev } = await current.json();
    const put = (state, baseRev) => fetch(entry.base + '/api/data', {
      method: 'PUT', headers: auth, body: JSON.stringify({ state, baseRev }),
    });
    const saved = await normalizeResponse(await put(data, rev));
    assert.equal(saved.status, 200);
    const conflict = await normalizeResponse(await put(h.seed.state, rev));
    assert.equal(conflict.status, 409);
    assert.ok(conflict.body.state.workouts.some(workout => workout.id === 'w_parity_new'));
    return { saved, conflict };
  }

  assert.deepEqual(compareJson(await write(h.legacy), await write(h.nest)), []);
  assert.deepEqual(compareDisk(h.legacy.dataDir, h.nest.dataDir), []);
});
