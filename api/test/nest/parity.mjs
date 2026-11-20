/* Differential fixture for the NestJS migration (archive/nestjs-migration/EXECUTION.md 0.3).
 *
 * The harness was written to give the legacy entry and the Nest entry the same DATA_DIR
 * contents, drive both over real HTTP and compare what came back and what was left on disk.
 * After the phase 4 switch `server.js` is the thin loader for `dist/src/main.js`, so the two
 * sides now prove that the published entry and the compiled entry are the same application.
 * Everything here is deterministic: ids, dates and the session secret are fixed, so two runs of
 * the same scenario start from byte-identical data. Each entry gets its own copy of the
 * directory because the server is a single writer and boot may create vapid.json, audit.log or
 * a health probe.
 *
 * startBoth() speaks the same readiness protocol as the rest of the suite: PORT=0 and the
 * `gym-api on :<port>` boot line, never a chosen port and never a health poll.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from '../helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '../..');

/** The Nest entry, relative to api/ like API_ENTRY. */
export const NEST_ENTRY = 'dist/src/main.js';
export const LEGACY_ENTRY = 'server.js';

export const OWNER_ID = 'u_parity_owner';
export const ADMIN_ID = 'u_parity_admin';
export const MEMBER_ID = 'u_parity_member';
export const DISABLED_ID = 'u_parity_disabled';
export const INVITE_CODE = 'PARITYINVITE0001';

const FIXED = '2026-01-02T03:04:05.000Z';
const hash = text => crypto.createHash('sha256').update(text).digest();
const hex = text => hash(text).toString('hex');
const b64u = text => hash(text).toString('base64url');

/* Scenario names pick a setup and an environment. A caller that needs something else can pass
 * { name, env, db, state } directly; `db` replaces top-level db.json keys, `state` the owner's
 * state document. */
const SCENARIOS = {
  default: {
    name: 'default',
    env: {}
  },
  quiet: {
    name: 'quiet',
    env: {
      PASSWORD_LOGIN: '0',
      MEDIA_UPLOADS: '0',
      INTEGRATIONS: '',
      COACH_DISABLED: '1',
      AUDIT_LOG: '0'
    }
  }
};

function scenarioSpec(scenario) {
  if (scenario == null) return { ...SCENARIOS.default };
  if (typeof scenario === 'string') {
    const found = SCENARIOS[scenario];
    if (!found) throw new Error(`unknown parity scenario: ${scenario}`);
    return { ...found };
  }
  return { name: 'custom', env: {}, ...scenario };
}

/** A small but valid openGym state: the fields the client and the server both expect. */
export function ownerState() {
  return {
    unit: 'kg',
    lang: 'en',
    effort: 'rpe',
    targetW: 80,
    routines: [{
      id: 'r_parity_1',
      name: 'Full body A',
      emoji: '\u{1F4AA}',
      prog: 'linear',
      ex: [
        { id: '0001', sets: 3, reps: 10, mode: 'reps', weight: 20, prog: 'linear' },
        { id: '0007', sets: 3, sec: 45, mode: 'time' }
      ]
    }],
    week: { 1: 'r_parity_1', 3: 'r_parity_1', 5: 'r_parity_1' },
    dayPlan: {},
    exWeights: { '0001': { w: 20 } },
    bodyweight: [
      { d: '2026-01-01', w: 78 },
      { d: '2026-01-15', w: 78.5 }
    ],
    customEx: [],
    workouts: [{
      id: 'w_parity_1',
      d: '2026-01-15',
      name: 'Full body A',
      start: 1000,
      end: 1000 + 45 * 60000,
      vol: 600,
      prs: [],
      entries: [{
        id: '0001',
        target: { sets: 3, reps: 10, weight: 20 },
        sets: [
          { w: 20, r: 10, done: true, rpe: 9.5 },
          { w: 20, r: 9, done: true, rpe: 10 },
          { w: 20, r: 8, done: true, rpe: 10 }
        ]
      }]
    }]
  };
}

/** The account database the scenarios share: owner, admin, member, disabled member, a
 *  passkey, a push subscription and an unused invite. */
export function parityDb() {
  return {
    users: [
      { id: OWNER_ID, name: 'Owner', created: FIXED, admin: true, owner: true },
      { id: ADMIN_ID, name: 'Admin', created: FIXED, admin: true },
      { id: MEMBER_ID, name: 'Member', created: FIXED },
      { id: DISABLED_ID, name: 'Disabled', created: FIXED, disabled: true }
    ],
    creds: [{
      id: b64u('parity-passkey'),
      userId: OWNER_ID,
      publicKey: b64u('parity-public-key'),
      counter: 0,
      transports: ['internal'],
      created: FIXED
    }],
    subs: [{
      userId: OWNER_ID,
      endpoint: 'https://push.example.com/parity/owner',
      keys: {
        p256dh: b64u('parity-p256dh'),
        auth: b64u('parity-auth')
      },
      created: FIXED
    }],
    invites: [{ code: INVITE_CODE, created: FIXED }],
    deviceLinks: []
  };
}

/* Writes a deterministic DATA_DIR. Returns the descriptor a parity test may need for requests:
 * the secret, ids and the state that was written. */
export function seedData(dir, scenario = 'default') {
  const spec = scenarioSpec(scenario);
  fs.mkdirSync(dir, { recursive: true });

  const secret = hex(`open-gym-parity:${spec.name}:secret`);
  fs.writeFileSync(path.join(dir, 'secret'), secret, { mode: 0o600 });

  const db = { ...parityDb(), ...(spec.db || {}) };
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(db, null, 2), { mode: 0o600 });

  const state = { ...ownerState(), ...(spec.state || {}) };
  fs.writeFileSync(path.join(dir, `state-${OWNER_ID}.json`), JSON.stringify(state), { mode: 0o600 });

  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });

  return { dir, secret, state, db, ownerId: OWNER_ID, adminId: ADMIN_ID, memberId: MEMBER_ID, disabledId: DISABLED_ID };
}

export function fixtureSession(secret, uid = OWNER_ID, kind = 'b') {
  const payload = `${uid}:${Date.now() + 3600_000}:0:${kind}`;
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function envFor(dataDir, spec, extra = {}) {
  return {
    ...process.env,
    PORT: '0',
    DATA_DIR: dataDir,
    ORIGIN: 'http://localhost:8080',
    RP_ID: 'localhost',
    COACH_DISABLED: '1',
    INTEGRATIONS: '',
    ...spec.env,
    ...extra
  };
}

function waitExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 5000);
    child.once('exit', done);
  });
}

async function startEntry(label, entry, dataDir, spec, root, extraEnv) {
  const child = spawn(process.execPath, [entry], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: envFor(dataDir, spec, extraEnv)
  });
  let text = '';
  child.stdout.on('data', d => { text += d; });
  child.stderr.on('data', d => { text += d; });

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) child.kill('SIGKILL');
    await waitExit(child);
    fs.rmSync(dataDir, { recursive: true, force: true });
    // Only succeeds once both copies are gone, so the shared root never outlives the fixture.
    try { fs.rmdirSync(root); } catch { /* the other side is still running */ }
  };

  try {
    const port = await boundPort(child, () => text);
    return { base: `http://127.0.0.1:${port}`, entry, child, dataDir, log: () => text, stop };
  } catch (err) {
    await stop();
    err.message = `${label} (${entry}) did not start:\n${text}\n${err.message}`;
    throw err;
  }
}

/** Starts the legacy entry and a second entry (the Nest build by default) from the same seed.
 *  Each side gets its own DATA_DIR copy and its own port. Stop both with entry.stop(). */
export async function startBoth(scenario = 'default', { second = NEST_ENTRY, legacyEntry = LEGACY_ENTRY, env = {} } = {}) {
  const spec = scenarioSpec(scenario);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-parity-'));
  const dirs = { legacy: path.join(root, 'legacy'), nest: path.join(root, 'nest') };
  const seed = seedData(dirs.legacy, spec);
  seedData(dirs.nest, spec);

  let legacy;
  let nest;
  try {
    legacy = await startEntry('legacy', legacyEntry, dirs.legacy, spec, root, env);
    nest = await startEntry('nest', second, dirs.nest, spec, root, env);
  } catch (err) {
    if (legacy) await legacy.stop();
    if (nest) await nest.stop();
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return { legacy, nest, root, seed, scenario: spec.name };
}

/* ---------- response normalisation ---------- */

const COOKIE = '<cookie>';
const DATE = '<date>';
const WID = '<wid>';
const TOKEN = '<token>';
const AUDIT_ID = '<audit-id>';

function headerPairs(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    const pairs = [];
    for (const [k, v] of headers) {
      if (k.toLowerCase() === 'set-cookie') continue;
      pairs.push([k.toLowerCase(), String(v)]);
    }
    for (const v of headers.getSetCookie()) pairs.push(['set-cookie', String(v)]);
    return pairs;
  }
  if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    const pairs = [];
    headers.forEach((v, k) => pairs.push([String(k).toLowerCase(), v]));
    return pairs;
  }
  const pairs = [];
  for (const [k, v] of Object.entries(headers)) {
    if (Array.isArray(v)) for (const one of v) pairs.push([k.toLowerCase(), one]);
    else pairs.push([k.toLowerCase(), v]);
  }
  return pairs;
}

function normalizeCookie(value) {
  const parts = String(value).split(';');
  const first = parts.shift() || '';
  const name = first.slice(0, Math.max(0, first.indexOf('=')));
  const attrs = parts.map(part => part.trim())
    .filter(Boolean)
    .map(part => (/^expires=/i.test(part) ? `Expires=${DATE}` : part));
  return [name ? `${name}=${COOKIE}` : COOKIE, ...attrs].join('; ');
}

/** Header map with volatile values replaced but every key kept (except Date, which is only
 *  wall-clock noise). Set-Cookie keeps names and attributes, never the signed value. */
export function normalizeHeaders(headers) {
  const out = {};
  for (const [key, value] of headerPairs(headers)) {
    if (key === 'date') continue;
    if (key === 'set-cookie') {
      out[key] = out[key] || [];
      out[key].push(normalizeCookie(value));
      continue;
    }
    out[key] = String(value);
  }
  if (out['set-cookie']) out['set-cookie'].sort();
  return out;
}

/** Replaces values that every process/run necessarily changes, without removing the key or
 *  changing the JSON type. Everything else — status codes, business error codes, shapes,
 *  unknown fields — is left alone so compareJson can see it. */
export function normalizeValue(value, key = '') {
  if (Array.isArray(value)) {
    if (key === '_wids') return value.map(() => WID);
    return value.map(item => normalizeValue(item));
  }
  if (!value || typeof value !== 'object') {
    if (key === 'token') return typeof value === 'string' ? TOKEN : value;
    if (key === 'now' || key === 'ts' || key === 'lastPull') return typeof value === 'number' ? 0 : '<ts>';
    if (key === '_wid' || key === 'wid') return typeof value === 'string' ? WID : value;
    return value;
  }
  const out = {};
  const isAudit = typeof value.ev === 'string';
  for (const [k, v] of Object.entries(value)) {
    if (k === 'id' && isAudit) out[k] = AUDIT_ID;
    else out[k] = normalizeValue(v, k);
  }
  return out;
}

/** Normalises one fetch() Response (or an equivalent { status, headers, body } record) into
 *  { status, headers, body }. A JSON body stays JSON so its shape is compared, not its text. */
export async function normalizeResponse(res) {
  const status = Number(res.status ?? res.statusCode);
  const headers = normalizeHeaders(res.headers);
  let text;
  if (typeof res.text === 'function') text = await res.text();
  else if (typeof res.body === 'string') text = res.body;
  else if (res.body == null) text = '';
  else text = JSON.stringify(res.body);

  const type = String(headers['content-type'] || '').toLowerCase();
  let body = text;
  if (type.includes('application/json') || /^[\s]*[\[{]/.test(text)) {
    try { body = normalizeValue(JSON.parse(text)); } catch { /* not JSON after all */ }
  }
  return { status, headers, body };
}

/* ---------- comparisons ---------- */

/** Structural comparison. Returns a list of human-readable differences; [] means equal.
 *  Object key order is ignored, arrays are compared by index, and types/values must match. */
export function compareJson(a, b, at = '$') {
  if (Object.is(a, b)) return [];
  if (typeof a !== typeof b) return [`${at}: type ${typeof a} != ${typeof b}`];
  if (a === null || b === null || typeof a !== 'object') {
    return [`${at}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`];
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return [`${at}: ${Array.isArray(a) ? 'array' : 'object'} != ${Array.isArray(b) ? 'array' : 'object'}`];
  }
  const diffs = [];
  if (Array.isArray(a)) {
    if (a.length !== b.length) diffs.push(`${at}: length ${a.length} != ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffs.push(...compareJson(a[i], b[i], `${at}[${i}]`));
    return diffs;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(a, key)) diffs.push(`${at}.${key}: missing on left`);
    else if (!Object.prototype.hasOwnProperty.call(b, key)) diffs.push(`${at}.${key}: missing on right`);
    else diffs.push(...compareJson(a[key], b[key], `${at}.${key}`));
  }
  return diffs;
}

function walkFiles(dir, rel = '') {
  const out = [];
  const full = path.join(dir, rel);
  let entries;
  try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const next = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(dir, next));
    else if (entry.isFile()) out.push(next.split(path.sep).join('/'));
  }
  return out;
}

/** The files the migration promises to preserve: db.json, every state-*.json and the media
 *  tree. Runtime noise (secret, vapid.json, audit.log, .bak, health probes, temp uploads) is
 *  not part of the contract. */
function diskFiles(dir) {
  const files = [];
  try { if (fs.statSync(path.join(dir, 'db.json')).isFile()) files.push('db.json'); } catch { /* absent */ }
  let top = [];
  try { top = fs.readdirSync(dir).sort(); } catch { return files; }
  for (const name of top) {
    if (/^state-.+\.json$/.test(name)) files.push(name);
  }
  return [...files, ...walkFiles(dir, 'uploads').map(f => f.startsWith('uploads/') ? f : `uploads/${f}`)];
}

/** Compares db.json, state-*.json and uploads bytes between two DATA_DIRs. JSON is normalised
 *  with the same volatile-field rules as responses; media is compared by content hash. */
export function compareDisk(aDir, bDir) {
  const aFiles = diskFiles(aDir);
  const bFiles = diskFiles(bDir);
  const diffs = [];
  const all = [...new Set([...aFiles, ...bFiles])].sort();
  for (const rel of all) {
    const aHas = aFiles.includes(rel);
    const bHas = bFiles.includes(rel);
    if (!aHas) { diffs.push(`${rel}: missing on left`); continue; }
    if (!bHas) { diffs.push(`${rel}: missing on right`); continue; }
    const aRaw = fs.readFileSync(path.join(aDir, rel));
    const bRaw = fs.readFileSync(path.join(bDir, rel));
    if (/\.json$/.test(rel)) {
      let aJson;
      let bJson;
      try { aJson = normalizeValue(JSON.parse(aRaw.toString('utf8'))); }
      catch (e) { diffs.push(`${rel}: left is not JSON (${e.message})`); continue; }
      try { bJson = normalizeValue(JSON.parse(bRaw.toString('utf8'))); }
      catch (e) { diffs.push(`${rel}: right is not JSON (${e.message})`); continue; }
      diffs.push(...compareJson(aJson, bJson, rel));
    } else {
      const aHash = crypto.createHash('sha256').update(aRaw).digest('hex');
      const bHash = crypto.createHash('sha256').update(bRaw).digest('hex');
      if (aHash !== bHash) diffs.push(`${rel}: content differs`);
    }
  }
  return diffs;
}

export { API };
