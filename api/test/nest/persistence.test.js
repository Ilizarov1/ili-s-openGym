/* Provider-level guarantees: durable writes, db.json fallback, strict state
 * reads and cache invalidation after a same-size write with the same mtime. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = path.join(api, 'dist', 'src', 'main.js');
const skip = !fs.existsSync(dist);

async function load() {
  const [{ AccountStore }, { StateStore }, { AtomicWriter }, { Paths }] = await Promise.all([
    import(pathToFileURL(path.join(api, 'dist', 'src', 'common', 'persistence', 'account-store.js')).href),
    import(pathToFileURL(path.join(api, 'dist', 'src', 'common', 'persistence', 'state-store.js')).href),
    import(pathToFileURL(path.join(api, 'dist', 'src', 'common', 'persistence', 'atomic-write.js')).href),
    import(pathToFileURL(path.join(api, 'dist', 'src', 'common', 'persistence', 'paths.js')).href),
  ]);
  return { AccountStore, StateStore, AtomicWriter, Paths };
}

function configFor(dir) {
  return {
    port: 0,
    dataDir: dir,
    rpId: 'localhost',
    rpName: 'openGym',
    origin: 'http://localhost:8080',
    secure: false,
    sessionDays: 90,
    maxBody: 5 * 1024 * 1024,
    adminUids: [],
    inviteOnly: false,
    firstUserAdmin: false,
    allowGuest: true,
    passwordLogin: false,
    defaultLang: '',
    trustProxy: false,
    bodyTimeoutMs: 1000,
    secret: 'a'.repeat(64),
    secretFile: path.join(dir, 'secret'),
  };
}

test('account store falls back to db.json.bak and saves both copies', { skip }, async () => {
  const { AccountStore, AtomicWriter, Paths } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-db-'));
  try {
    const db = { users: [{ id: 'u1', name: 'Owner', owner: true, admin: true }], creds: [], subs: [], invites: [] };
    fs.writeFileSync(path.join(dir, 'db.json.bak'), JSON.stringify(db));
    fs.writeFileSync(path.join(dir, 'db.json'), '{ damaged');

    const cfg = configFor(dir);
    const paths = new Paths(cfg);
    const store = new AccountStore(cfg, paths, new AtomicWriter());

    assert.equal(store.db.users[0].id, 'u1');
    assert.equal(store.isOwner(store.db.users[0]), true);
    assert.ok(fs.readdirSync(dir).some(name => name.startsWith('db.json.unreadable-')));

    store.db.users.push({ id: 'u2', name: 'Second' });
    store.save();
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
    const backup = JSON.parse(fs.readFileSync(path.join(dir, 'db.json.bak'), 'utf8'));
    assert.equal(onDisk.users.length, 2);
    assert.equal(backup.users.length, 2);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(path.join(dir, 'db.json')).mode & 0o777, 0o600);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state store distinguishes missing from unreadable and invalidates the cache', { skip }, async () => {
  const { StateStore, Paths } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-state-'));
  try {
    const store = new StateStore(new Paths(configFor(dir)));
    assert.equal(store.readStrict('u1'), null);

    const file = path.join(dir, 'state-u1.json');
    fs.writeFileSync(file, '{"workouts":[1]}');
    assert.deepEqual(store.readCached('u1'), { workouts: [1] });

    // A same-size rewrite is only guaranteed visible after the writer
    // invalidates: mtime granularity differs per filesystem, so the cache may
    // or may not notice on its own. PUT /api/data always invalidates.
    fs.writeFileSync(file, '{"workouts":[2]}');
    store.invalidate('u1');
    assert.deepEqual(store.readCached('u1'), { workouts: [2] });

    fs.writeFileSync(file, '{ broken');
    const unreadable = store.readStrict('u1');
    assert.equal(typeof unreadable, 'symbol');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
