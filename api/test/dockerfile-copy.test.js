/* The api image carries only the files named on api/Dockerfile's COPY line (plus coach/). A
   root-level module that server.js imports and that line forgets is invisible to every test run
   from the source tree and shows up only when the published image boots — as
   ERR_MODULE_NOT_FOUND, on every instance that pulled it. So the line is checked here, for
   server.js and recover.js plus their transitive imports from the api root. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(API, f), 'utf8');

// Every `./name.js` a file imports, statically or dynamically — root-level only; coach/ is
// copied as a whole directory.
const rootImports = src => [...src.matchAll(/(?:from\s+|import\s*\(\s*)['"]\.\/([^'"/]+\.js)['"]/g)].map(m => m[1]);

test('the Dockerfile copies both API and recovery entry points and their root-level imports', () => {
  const line = read('Dockerfile').split('\n').find(l => /^COPY\s+server\.js\b/.test(l));
  assert.ok(line, 'the COPY line that carries server.js');
  const copied = new Set(line.trim().split(/\s+/).slice(1, -1));

  const needed = new Set(['server.js', 'recover.js']);
  const queue = [...needed];
  while (queue.length) {
    for (const dep of rootImports(read(queue.shift()))) {
      if (!needed.has(dep)) { needed.add(dep); queue.push(dep); }
    }
  }
  assert.ok(needed.has('media.js'), 'the walk finds the media store');
  assert.ok(needed.has('admin-socket.js'), 'the recovery CLI can load its socket client');
  const missing = [...needed].filter(f => !copied.has(f));
  assert.deepEqual(missing, [], `add ${missing.join(', ')} to the COPY line in api/Dockerfile`);
  for (const f of copied) assert.ok(fs.existsSync(path.join(API, f)), `${f} is copied but does not exist`);
});

test('the integrations directory is copied whole, like coach/', () => {
  const lines = read('Dockerfile').split('\n');
  assert.ok(lines.some(l => /^COPY\s+integrations\s+\.\/integrations\s*$/.test(l)), 'COPY integrations ./integrations in api/Dockerfile');
  assert.match(read('server.js'), /from '\.\/integrations\/index\.js'/);
});
