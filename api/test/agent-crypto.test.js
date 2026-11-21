/* Credentials under data/secret: HKDF + AES-256-GCM with account/profile/version AAD.
 *
 * Runs against the compiled dist, so `npm.cmd run build` must come first:
 *   node --test test/agent-crypto.test.js
 * Covers the EXECUTION.md 2.4 acceptance criteria: seal -> restart -> open,
 * a moved or tampered ciphertext fails closed, a missing secret disables.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCrypto } from '../dist/src/agent/agent-crypto.js';
// The same module instance the compiled crypto code throws from.
import { AgentError } from '../dist/agent-runtime/errors.js';

const SECRET = 'instance-secret-0123456789';
const uid = 'u_agent_owner';
const profileId = 'profile_1';

function rejectsCorrupt(promise) {
  return assert.rejects(promise, error => error instanceof AgentError && error.code === 'agent_config_corrupt');
}

test('a sealed credential opens again after a restart with the same secret', () => {
  const first = new AgentCrypto({ secret: SECRET });
  const sealed = first.encrypt(uid, profileId, 1, 'sk-live-key-1234');
  assert.equal(sealed.v, 1);
  assert.equal(typeof sealed.iv, 'string');
  assert.equal(typeof sealed.tag, 'string');
  assert.equal(String(sealed.data).includes('sk-live-key-1234'), false);

  // "Restart": a fresh instance, same instance secret.
  const second = new AgentCrypto({ secret: SECRET });
  assert.equal(second.decrypt(uid, profileId, 1, sealed), 'sk-live-key-1234');
});

test('a credential moved to another account, profile or version fails closed', async () => {
  const agent = new AgentCrypto({ secret: SECRET });
  const sealed = agent.encrypt(uid, profileId, 2, 'sk-live-key-1234');
  await rejectsCorrupt(Promise.resolve().then(() => agent.decrypt('u_agent_other', profileId, 2, sealed)));
  await rejectsCorrupt(Promise.resolve().then(() => agent.decrypt(uid, 'profile_2', 2, sealed)));
  await rejectsCorrupt(Promise.resolve().then(() => agent.decrypt(uid, profileId, 3, sealed)));
});

test('a tampered ciphertext or a rotated secret fails closed as corruption', async () => {
  const agent = new AgentCrypto({ secret: SECRET });
  const sealed = agent.encrypt(uid, profileId, 1, 'sk-live-key-1234');
  const flipped = {
    ...sealed,
    data: sealed.data.slice(0, -4) + (sealed.data.endsWith('AAAA') ? 'BBBB' : 'AAAA'),
  };
  await rejectsCorrupt(Promise.resolve().then(() => agent.decrypt(uid, profileId, 1, flipped)));
  const rotated = new AgentCrypto({ secret: 'rotated-secret-9876543210' });
  await rejectsCorrupt(Promise.resolve().then(() => rotated.decrypt(uid, profileId, 1, sealed)));
  await rejectsCorrupt(Promise.resolve().then(() => agent.decrypt(uid, profileId, 1, { ...sealed, v: 99 })));
});

test('an instance without a usable secret disables server-held credentials', async () => {
  const missing = new AgentCrypto({});
  assert.equal(missing.enabled, false);
  await assert.rejects(
    Promise.resolve().then(() => missing.encrypt(uid, profileId, 1, 'sk-live-key-1234')),
    error => error instanceof AgentError && error.code === 'agent_config_disabled',
  );
  const short = new AgentCrypto({ secret: 'short' });
  assert.equal(short.enabled, false);
});
