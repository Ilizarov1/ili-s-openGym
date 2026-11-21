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

test('every RN-visible export of shared.d.ts still exists in the shared core', async () => {
  const core = await import('../agent-runtime/index.js');
  // AgentRunState/AgentRunRecord are structural stand-ins for what
  // createRunState returns; they are shapes, not runtime exports.
  const STANDINS = new Set(['AgentRunState', 'AgentRunRecord']);
  const declarationPath = path.join(HERE, '..', '..', 'mobile-rn', 'src', 'agent', 'shared.d.ts');
  const text = fs.readFileSync(declarationPath, 'utf8');
  const declared = [...text.matchAll(/export\s+(?:function|class|const)\s+([A-Za-z_$][\w$]*)/g)]
    .map(match => match[1]);
  assert.ok(declared.length >= 20, `expected the RN bridge declarations, found ${declared.length}`);
  for (const name of declared) {
    if (STANDINS.has(name)) continue;
    assert.ok(name in core, `shared.d.ts declares ${name} but the shared core does not export it`);
  }

  // The names RN code actually imports from the bridge must exist too.
  const rnSrc = path.join(HERE, '..', '..', 'mobile-rn', 'src');
  const imported = new Set();
  const allFiles = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) allFiles(full, out);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  };
  for (const file of allFiles(rnSrc)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/import\s+(type\s*)?\{([^}]*)\}\s*from\s+['"][^'"]*shared['"]/g)) {
      if (match[1]) continue; // type-only imports are erased at runtime
      for (const name of match[2].split(',')) {
        const clean = name.trim().split(/\s+as\s+/)[0];
        if (clean) imported.add(clean);
      }
    }
  }
  assert.ok(imported.size >= 5, `expected RN bridge imports, found ${imported.size}`);
  for (const name of imported) {
    assert.ok(name in core, `RN imports ${name} from the shared bridge but the shared core does not export it`);
  }
});
