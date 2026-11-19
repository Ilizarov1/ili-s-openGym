/* Every state, db.json and media write is flushed before its rename and the directory after it
   (durable.js). Without the fsync the 200 went out while the rename sat in the page cache, and a
   host reset brought the previous file back: the device that had been told "saved" then took the
   older copy and deleted the workout locally too. (QA 2026-10-06: strace of a PUT showed no fsync.) */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite } from '../durable.js';

test('atomicWrite: bytes flushed, then the rename, then the directory', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state-u1.json');
  const calls = [];
  const fdPath = new Map();
  const open = fs.openSync, fsync = fs.fsyncSync, rename = fs.renameSync;
  t.mock.method(fs, 'openSync', (p, ...rest) => { const fd = open(p, ...rest); fdPath.set(fd, p); return fd; });
  t.mock.method(fs, 'fsyncSync', fd => { calls.push(['fsync', fdPath.get(fd)]); return fsync(fd); });
  t.mock.method(fs, 'renameSync', (a, b) => { calls.push(['rename', b]); return rename(a, b); });
  atomicWrite(file, '{"_rev":1}', 0o600);
  assert.deepEqual(calls, [['fsync', file + '.tmp'], ['rename', file], ['fsync', dir]]);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"_rev":1}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('the API writes account and state files through durable.js', () => {
  // The legacy entry had its own atomicWrite wrapper; the Nest providers must keep using it
  // instead of writing db.json or state-<uid>.json with fs.writeFileSync.
  const provider = fs.readFileSync(new URL('../src/common/persistence/atomic-write.ts', import.meta.url), 'utf8');
  assert.match(provider, /from '\.\.\/\.\.\/\.\.\/durable\.js'/);
  assert.match(provider, /durableWrite\(file, content, mode\)/);

  const accountStore = fs.readFileSync(new URL('../src/common/persistence/account-store.ts', import.meta.url), 'utf8');
  assert.match(accountStore, /this\.writer\.write\(this\.dbFile, text, 0o600\)/);
  assert.doesNotMatch(accountStore, /writeFileSync/);

  const syncService = fs.readFileSync(new URL('../src/sync/sync.service.ts', import.meta.url), 'utf8');
  assert.match(syncService, /this\.writer\.write\(this\.paths\.stateFile\(uid\), text\)/);
  assert.doesNotMatch(syncService, /writeFileSync/);

  const media = fs.readFileSync(new URL('../media.js', import.meta.url), 'utf8');
  assert.match(media, /syncFile\(tmp\);[\s\S]*fs\.renameSync\(tmp, path\.join\(e\.dir/);
});
