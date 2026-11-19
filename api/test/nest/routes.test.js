/* Route matrix: every Nest controller path/method against api/openapi.yaml.
 *
 * Replaces the old source-literal scan of server.js with reflection over the
 * compiled module graph. Media's `:hash` is normalized to `{hash}`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distMain = path.join(api, 'dist', 'src', 'main.js');

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

const METHODS = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH', 5: 'ALL', 6: 'OPTIONS', 7: 'HEAD' };

test('nest controllers cover the OpenAPI operations', { skip: !fs.existsSync(distMain) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-routes-'));
  const prior = process.env.DATA_DIR;
  const priorPassword = process.env.PASSWORD_LOGIN;
  const priorMedia = process.env.MEDIA_UPLOADS;
  process.env.DATA_DIR = dir;
  process.env.PORT = '0';
  // The contract covers both optional families, so register them for this check.
  process.env.PASSWORD_LOGIN = '1';
  process.env.MEDIA_UPLOADS = '1';

  const { NestFactory } = await import('@nestjs/core');
  const { PATH_METADATA, METHOD_METADATA } = await import('@nestjs/common/constants');
  const { AppModule } = await import(pathToFileURL(path.join(api, 'dist', 'src', 'app.module.js')).href);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const modules = app.container.getModules();
    const found = [];
    for (const module of modules.values()) {
      for (const wrapper of module.controllers.values()) {
        const meta = wrapper.metatype;
        if (!meta) continue;
        const prefix = Reflect.getMetadata(PATH_METADATA, meta) || '';
        const prefixParts = Array.isArray(prefix) ? prefix : [prefix];
        for (const name of Object.getOwnPropertyNames(meta.prototype)) {
          const fn = meta.prototype[name];
          if (typeof fn !== 'function') continue;
          const routePath = Reflect.getMetadata(PATH_METADATA, fn);
          const method = Reflect.getMetadata(METHOD_METADATA, fn);
          if (routePath === undefined || method === undefined) continue;
          const parts = Array.isArray(routePath) ? routePath : [routePath];
          for (const part of parts) {
            for (const base of prefixParts) {
              const joined = (
                '/' + ['api', base, part].filter(part => part !== '' && part != null).join('/')
              )
                .replace(/\/+/g, '/')
                .replace(/\/$/, '');
              found.push(`${METHODS[method] || method} ${joined}`);
            }
          }
        }
      }
    }

    const norm = list => list.map(r => r.replace(/\/:hash\b/, '/{hash}')).sort();
    const expected = norm(openapiRoutes());
    const actual = norm(found);
    const missing = expected.filter(r => !actual.includes(r));
    const extra = actual.filter(r => !expected.includes(r));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  } finally {
    await app.close();
    if (prior === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prior;
    if (priorPassword === undefined) delete process.env.PASSWORD_LOGIN;
    else process.env.PASSWORD_LOGIN = priorPassword;
    if (priorMedia === undefined) delete process.env.MEDIA_UPLOADS;
    else process.env.MEDIA_UPLOADS = priorMedia;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
