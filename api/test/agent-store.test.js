/* Structural corruption in the per-account agent document.
 *
 * Run after `npm run build`; the store is TypeScript compiled into dist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentStore, emptyAgentData } from '../dist/src/agent/agent.store.js';
import { Paths } from '../dist/src/common/persistence/paths.js';
import { AgentError } from '../dist/agent-runtime/errors.js';

test('the agent file name is derived from the sanitized account id', () => {
  const paths = new Paths({ dataDir: path.join(os.tmpdir(), 'agent-data') });
  assert.equal(paths.agentFile('owner').endsWith(path.join('agent-owner.json')), true);
  assert.equal(paths.agentFile('../bad id').endsWith(path.join('agent-badid.json')), true);
});

function storeFor(dir) {
  const file = path.join(dir, 'agent-test.json');
  const paths = { agentFile: () => file };
  const writer = { write: (target, contents) => fs.writeFileSync(target, contents) };
  return { store: new AgentStore(paths, writer), file };
}

test('a legal JSON document with a corrupt nested run is agent_store_corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-'));
  try {
    const { store, file } = storeFor(dir);
    const data = emptyAgentData();
    data.runs.run_bad = null;
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(
      () => store.read('owner'),
      error => error instanceof AgentError && error.code === 'agent_store_corrupt',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt request index entry is rejected instead of silently dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-'));
  try {
    const { store, file } = storeFor(dir);
    const data = emptyAgentData();
    data.requestIndex.req_bad_0001 = { not: 'a run id' };
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(
      () => store.read('owner'),
      error => error instanceof AgentError && error.code === 'agent_store_corrupt',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a complete document round-trips and updates remain serialized', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-store-'));
  try {
    const { store, file } = storeFor(dir);
    const data = emptyAgentData();
    data.profiles.profile_1 = {
      id: 'profile_1', provider: 'fixture', model: 'fixture', capabilities: { text: true, image: true, tools: true },
      version: 1, createdAt: 1, updatedAt: 1,
    };
    data.runs.run_1 = {
      runId: 'run_1', requestId: 'req_00000001', requestHash: 'h', taskId: 'stub.v1', profileId: 'profile_1',
      executionLocation: 'server', status: 'completed', createdAt: 1,
    };
    data.requestIndex.req_00000001 = 'run_1';
    fs.writeFileSync(file, JSON.stringify(data));
    assert.equal(store.read('owner').runs.run_1.status, 'completed');

    await Promise.all([
      store.update('owner', next => { next.memories.m1 = { id: 'm1', category: 'note', value: 1, createdAt: 1, updatedAt: 1, version: 1 }; }),
      store.update('owner', next => { next.memories.m2 = { id: 'm2', category: 'note', value: 2, createdAt: 1, updatedAt: 1, version: 1 }; }),
    ]);
    const after = store.read('owner');
    assert.equal(Object.keys(after.memories).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
