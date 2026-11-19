/* The api image carries only what the build produced and the thin entry points. A runtime module
   that the build forgets is invisible to every test run from the source tree and shows up only
   when the published image boots — as ERR_MODULE_NOT_FOUND, on every instance that pulled it.
   So the Dockerfile, the build script's required-artifact list and the built tree are checked
   together here. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(API, f), 'utf8');
const dockerfile = read('Dockerfile');

test('the image is built from a compiled tree and runs the thin entry', () => {
  assert.match(dockerfile, /^FROM node:\d+-alpine AS build$/m, 'a build stage compiles the API');
  assert.match(dockerfile, /^RUN npm run build$/m, 'the build stage runs the API build');
  assert.match(dockerfile, /^COPY --from=build \/app\/dist \.\/dist$/m, 'the runtime image copies dist');
  assert.match(dockerfile, /^COPY --from=build \/app\/server\.js \.\/server\.js$/m, 'the thin entry is copied');
  assert.match(dockerfile, /^COPY --from=build \/app\/dist\/recover\.js \.\/recover\.js$/m, 'recover.js keeps its root path');
  assert.match(dockerfile, /^COPY --from=build \/app\/dist\/admin-socket\.js \.\/admin-socket\.js$/m, 'the socket client recover.js imports is there');
  assert.match(dockerfile, /^CMD \["node", "server\.js"\]$/m, 'the container starts npm start\'s entry');
  // Production dependencies only; npm ci from the committed lockfile, not a fresh resolve.
  assert.match(dockerfile, /npm ci --omit=dev --omit=optional/, 'the default runtime installs production dependencies');
});

test('the thin server entry only loads the compiled application', () => {
  const server = read('server.js');
  assert.match(server, /await import\('\.\/dist\/src\/main\.js'\)/);
  assert.doesNotMatch(server, /http\.createServer|readBody\(|route/i, 'business code belongs in api/src');
  assert.doesNotMatch(server, /process\.env\./, 'the compiled entry reads the environment');
});

test('the build script requires the entry, recovery CLI and runtime directories', () => {
  const script = read(path.join('scripts', 'build-api.mjs'));
  const required = [.../const required = \[([\s\S]*?)\];/.exec(script)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const file of ['src/main.js', 'durable.js', 'media.js', 'recover.js', 'admin-socket.js', 'coach/fixture-cli.mjs', 'integrations/index.js']) {
    assert.ok(required.includes(file), `build-api.mjs should verify ${file}`);
  }
  assert.match(script, /copyDir\(path\.join\(api, dir\), path\.join\(dist, dir\)\)/, 'coach/ and integrations/ are copied');
});

test('every required artifact exists after npm run build', { skip: !fs.existsSync(path.join(API, 'dist', 'src', 'main.js')) && 'run npm run build first' }, () => {
  const script = read(path.join('scripts', 'build-api.mjs'));
  const required = [.../const required = \[([\s\S]*?)\];/.exec(script)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const file of required) {
    assert.ok(fs.existsSync(path.join(API, 'dist', file)), `dist/${file} is missing`);
  }
  assert.ok(fs.existsSync(path.join(API, 'dist', 'src', 'app.module.js')), 'the Nest module graph is compiled');
  assert.ok(fs.existsSync(path.join(API, 'dist', 'coach', 'prompts')), 'the Coach prompt files are copied');
});
