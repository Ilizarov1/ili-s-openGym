/* Portability guard for the shared runtime.
 *
 * The same directory is compiled into the API image and bundled by Metro. A
 * Node built-in import would pass every Node test and break the phone, so this
 * test scans the source before that can happen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIds, createId } from '../agent-runtime/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.join(HERE, '..', 'agent-runtime');

function files(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('the shared core imports no Node built-ins, Buffer or process', () => {
  const sources = files(CORE);
  assert.ok(sources.length >= 15, `expected the shared modules, found ${sources.length}`);
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(CORE, file);
    assert.doesNotMatch(text, /from\s+['"]node:/, `${rel} imports a node: module`);
    assert.doesNotMatch(text, /\brequire\s*\(/, `${rel} calls require()`);
    assert.doesNotMatch(text, /from\s+['"](?:fs|path|crypto|http|https|stream|util)['"]/, `${rel} imports a Node built-in`);
    assert.doesNotMatch(text, /\bBuffer\b/, `${rel} uses Buffer`);
    assert.doesNotMatch(text, /\bprocess\./, `${rel} reads process`);
  }
});

test('the type declaration entry exists next to the JavaScript entry', () => {
  const declaration = path.join(CORE, 'contracts.d.ts');
  assert.equal(fs.existsSync(declaration), true);
  const text = fs.readFileSync(declaration, 'utf8');
  for (const name of ['RunRequest', 'TaskDefinition', 'RunContext', 'ModelInput', 'RunResult', 'ToolDefinition', 'Proposal', 'MemoryRecord', 'RunRecord']) {
    assert.match(text, new RegExp(`interface ${name}\\b`), `${name} is not declared`);
  }
});

test('ids work with an injected randomUUID, as RN will supply', () => {
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  assert.equal(createId('run', uuid), 'run_00000000-0000-4000-8000-000000000001');
  const ids = createIds(uuid);
  assert.match(ids.session(), /^ses_/);
  assert.match(ids.memory(), /^mem_/);
  assert.match(ids.proposal(), /^prop_/);
  assert.match(ids.evidence(), /^ev_/);
  assert.throws(() => createId('Bad Prefix', uuid));
});

test('the shared entry has no top-level work that needs a host', async () => {
  const mod = await import('../agent-runtime/index.js');
  assert.equal(mod.AGENT_SCHEMA_VERSION, 1);
  assert.equal(typeof mod.runAgent, 'function');
  assert.equal(typeof mod.createProvider, 'function');
});
