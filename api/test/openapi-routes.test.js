/* openapi.yaml says of itself: "Every route the server registers is documented here; if you add
   a route there, add it here too." Sixteen of them were not — the whole AI Coach surface, user
   and admin. Nothing was checking, so this does: the route table is one `'METHOD /path':` key per
   handler in two files, and the spec is one `get:`/`post:` under one path key, both of which can
   be read without a YAML parser (there is none in this package, by design).

   Plus the trap this test was written after: the doc generator renders the tags it knows and
   drops the rest in silence, so ten documented routes rendered nowhere at all. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReady, nestRoutes } from './nest/route-list.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.join(API, '..');
const read = f => fs.readFileSync(f, 'utf8');
const spec = read(path.join(API, 'openapi.yaml'));

/** Every operation under `paths:`, as "METHOD /path". */
function specOperations(yaml) {
  const out = [];
  let inPaths = false, current = null;
  for (const line of yaml.split('\n')) {
    if (/^paths:/.test(line)) { inPaths = true; continue; }
    if (inPaths && /^[a-zA-Z]/.test(line)) inPaths = false;     // the next top-level key ends it
    if (!inPaths) continue;
    const p = /^ {2}(\/[^:]*):/.exec(line);
    if (p) { current = p[1]; continue; }
    const m = /^ {4}(get|post|put|delete):/.exec(line);
    if (m && current) out.push(`${m[1].toUpperCase()} ${current}`);
  }
  return out;
}

test('every route the Nest app registers is in openapi.yaml, and nothing else is', { skip: !buildReady(API) && 'run npm run build first' }, async () => {
  // The listening surface comes from the compiled controllers, not from any source text: the
  // legacy route table in server.js is gone after the phase 4 switch.
  const routes = new Set((await nestRoutes(API)).map(r => r.replace(/\/:hash\b/, '/{hash}')));
  const ops = new Set(specOperations(spec));
  assert.ok(routes.size > 40, `only found ${routes.size} routes — the controller scan moved`);

  assert.deepEqual([...routes].filter(r => !ops.has(r)).sort(), [], 'undocumented routes — add them to api/openapi.yaml');
  assert.deepEqual([...ops].filter(o => !routes.has(o)).sort(), [], 'documented routes the server does not serve');
  // The Coach surface in particular: this test exists because all sixteen were missing.
  for (const r of ['GET /api/integrations', 'POST /api/integrations/connect', 'GET /api/coach/status', 'POST /api/coach/review', 'GET /api/admin/coach', 'POST /api/admin/coach/connect']) {
    assert.ok(ops.has(r), `${r} is missing from the spec`);
  }
});

test('every tag the spec uses is one the docs generator renders', () => {
  const declared = [...spec.matchAll(/^ {2}- name: (\S+)$/gm)].map(m => m[1]);
  const used = new Set([...spec.matchAll(/^ {6}tags: \[([^\]]+)\]/gm)].flatMap(m => m[1].split(',').map(s => s.trim())));
  for (const tag of used) assert.ok(declared.includes(tag), `tag "${tag}" is used but never declared under tags:`);

  // scripts/build-api-docs.mjs renders one section per entry in its own TAGS map and drops any
  // operation whose first tag is not in it — silently, which is how ten Coach routes went
  // missing from the published page while being perfectly well documented here.
  const docs = read(path.join(ROOT, 'scripts', 'build-api-docs.mjs'));
  const known = [.../const TAGS = \{([\s\S]*?)\n\}/.exec(docs)[1].matchAll(/^\s{2}(\w+):/gm)].map(m => m[1]);
  for (const tag of used) assert.ok(known.includes(tag), `tag "${tag}" renders nowhere — add it to TAGS in scripts/build-api-docs.mjs`);
});

/* The e-mail routes answer with codes a client switches on. /api/register/password answered
   `400 email-invalid` for a while with the spec listing only the password policy under 400.
   The handlers live in the Nest auth controller now; the codes they can answer with come from
   the literal `code:` values plus the EMAIL_ERRORS table and the password policy keys. */
test('every error code the e-mail and password signup routes return is in their spec entry', () => {
  const controller = read(path.join(API, 'src', 'auth', 'auth.controller.ts'));
  const passwords = read(path.join(API, 'src', 'auth', 'password.service.ts'));
  const methodBody = marker => {
    const start = controller.indexOf(`@Post('${marker}')`);
    assert.ok(start >= 0, `the ${marker} handler is gone — this test needs rewriting`);
    const next = controller.slice(start + 1).search(/\n {2}@(Get|Post|Put|Delete)\(/);
    return controller.slice(start, next < 0 ? undefined : start + 1 + next);
  };
  const emailCodes = Object.fromEntries(
    [...passwords.matchAll(/^\s{2}(\w+): \{ error: '[^']*', code: '([^']+)' \}/gm)].map(m => [m[1], m[2]]),
  );
  const policyCodes = [.../POLICY_ERRORS:[\s\S]*?\n\};/.exec(passwords)[0].matchAll(/^\s{2}'([^']+)':/gm)].map(m => m[1]);
  const operation = (p, method) => {
    const from = spec.indexOf(`\n  ${p}:\n`);
    assert.ok(from >= 0, p);
    const rest = spec.slice(from + 1);
    const block = rest.slice(0, rest.slice(1).search(/\n {2}\/|\n[a-zA-Z]/) + 1);
    const op = block.slice(block.indexOf(`\n    ${method}:`));
    const end = op.slice(1).search(/\n {4}\w+:/);
    const text = end < 0 ? op : op.slice(0, end + 1);
    // Follow the shared responses it points at.
    const refs = [...text.matchAll(/#\/components\/responses\/(\w+)/g)].map(m => {
      const at = spec.indexOf(`\n    ${m[1]}:\n`);
      const tail = spec.slice(at + 1);
      return tail.slice(0, tail.slice(1).search(/\n {4}\w+:/) + 1);
    });
    return [text, ...refs].join('\n');
  };
  for (const [marker, p, method] of [
    ['register/password', '/api/register/password', 'post'],
    ['account/email', '/api/account/email', 'post'],
  ]) {
    const src = methodBody(marker);
    assert.ok(src.includes('readBody(req)'), `${marker} reads a body`);
    const codes = new Set([
      ...[...src.matchAll(/code: '([^']+)'/g)].map(m => m[1]),
      ...[...src.matchAll(/EMAIL_ERRORS\.(\w+)/g)].map(m => emailCodes[m[1]]),
      ...(src.includes('policyError') ? policyCodes : []),
    ]);
    assert.ok(codes.size > 1, marker);
    const doc = operation(p, method);
    for (const c of codes) assert.ok(doc.includes(c), `${marker} returns "${c}" but its openapi entry never mentions it`);
  }
});

/* #795: the generator kept its own copy of the website's ?v= and fell behind index.html, so
   --check went red on main. It reads index.html now; this keeps it from growing a copy again. */
test('the docs generator takes the website ?v= from index.html, and every page agrees', () => {
  const docs = read(path.join(ROOT, 'scripts', 'build-api-docs.mjs'));
  assert.doesNotMatch(docs, /\?v=\d/, 'build-api-docs.mjs hard-codes a ?v= number, read it from website/index.html');
  const web = path.join(ROOT, 'website');
  const v = /styles\.css\?v=(\d+)/.exec(read(path.join(web, 'index.html')))[1];
  for (const f of fs.readdirSync(web).filter(f => f.endsWith('.html'))) {
    for (const m of read(path.join(web, f)).matchAll(/(?:styles\.css|site\.js)\?v=(\d+)/g)) {
      assert.equal(m[1], v, `website/${f} links ${m[0]}, index.html is on ?v=${v}`);
    }
  }
});
