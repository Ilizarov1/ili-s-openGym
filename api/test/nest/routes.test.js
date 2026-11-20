/* Route matrix: every Nest controller path/method against api/openapi.yaml.
 *
 * Replaces the old source-literal scan of server.js with reflection over the
 * compiled module graph. Media's `:hash` is normalized to `{hash}`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReady, nestRoutes } from './route-list.mjs';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function openapiRoutes() {
  const text = fs.readFileSync(path.join(api, 'openapi.yaml'), 'utf8');
  const out = [];
  let inside = false;
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^paths:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^[A-Za-z]/.test(line)) break;
    if (!inside) continue;
    const p = /^\s{2,6}(\/api\/[^:]+):\s*$/.exec(line);
    if (p) {
      current = p[1];
      continue;
    }
    const m = /^\s{4,8}(get|post|put|delete|patch):\s*$/.exec(line);
    if (m && current) out.push(`${m[1].toUpperCase()} ${current}`);
  }
  return out;
}

test('nest controllers cover the OpenAPI operations', { skip: !buildReady(api) && 'run npm run build first' }, async () => {
  const norm = list => list.map(r => r.replace(/\/:([A-Za-z0-9_]+)\b/g, '/{$1}')).sort();
  const expected = norm(openapiRoutes());
  const actual = norm(await nestRoutes(api));
  const missing = expected.filter(r => !actual.includes(r));
  const extra = actual.filter(r => !expected.includes(r));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
});
