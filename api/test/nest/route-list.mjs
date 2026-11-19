/* The Nest controller surface, read from the compiled module graph.
 *
 * Both the 91-route contract test and the OpenAPI check need the same list. The
 * controllers are compiled because `npm test` now starts the compiled entry;
 * callers that run from a source-only checkout should run the build first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const METHODS = { 0: 'GET', 1: 'POST', 2: 'PUT', 3: 'DELETE', 4: 'PATCH', 5: 'ALL', 6: 'OPTIONS', 7: 'HEAD' };

export function distDir(api) {
  return path.join(api, 'dist');
}

export function buildReady(api) {
  return fs.existsSync(path.join(distDir(api), 'src', 'main.js'));
}

/** Reflect every @Controller route, normalized to "METHOD /api/path". */
export async function nestRoutes(api, { passwordLogin = true, media = true } = {}) {
  if (!buildReady(api)) throw new Error('dist/src/main.js is missing — run `npm run build` first');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-routes-'));
  const prior = {
    DATA_DIR: process.env.DATA_DIR,
    PORT: process.env.PORT,
    PASSWORD_LOGIN: process.env.PASSWORD_LOGIN,
    MEDIA_UPLOADS: process.env.MEDIA_UPLOADS,
  };
  process.env.DATA_DIR = dir;
  process.env.PORT = '0';
  // The contract covers both optional families, so register them for this check.
  process.env.PASSWORD_LOGIN = passwordLogin ? '1' : '0';
  process.env.MEDIA_UPLOADS = media ? '1' : '0';

  const { NestFactory } = await import('@nestjs/core');
  const { PATH_METADATA, METHOD_METADATA } = await import('@nestjs/common/constants');
  const { AppModule } = await import(pathToFileURL(path.join(distDir(api), 'src', 'app.module.js')).href);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const found = [];
    for (const module of app.container.getModules().values()) {
      for (const wrapper of module.controllers.values()) {
        const meta = wrapper.metatype;
        if (!meta) continue;
        const prefix = Reflect.getMetadata(PATH_METADATA, meta) || '';
        const prefixes = Array.isArray(prefix) ? prefix : [prefix];
        for (const name of Object.getOwnPropertyNames(meta.prototype)) {
          const fn = meta.prototype[name];
          if (typeof fn !== 'function') continue;
          const routePath = Reflect.getMetadata(PATH_METADATA, fn);
          const method = Reflect.getMetadata(METHOD_METADATA, fn);
          if (routePath === undefined || method === undefined) continue;
          const parts = Array.isArray(routePath) ? routePath : [routePath];
          for (const part of parts) {
            for (const base of prefixes) {
              const joined = ('/' + ['api', base, part].filter(p => p !== '' && p != null).join('/'))
                .replace(/\/+/g, '/')
                .replace(/\/$/, '');
              found.push(`${METHODS[method] || method} ${joined}`);
            }
          }
        }
      }
    }
    return found;
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
