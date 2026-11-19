/* Builds the Nest entry point and the runtime modules it imports.
 *
 * tsc compiles every .ts under src/ and, because allowJs is on, also emits the
 * existing ESM modules those files import (durable.js, media.js, coach/, ...).
 * Anything a migrated module does not import yet is copied here so that dist is
 * a complete runtime tree, matching the documented contract: the image only
 * needs dist/, server.js, package.json and package-lock.json.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(api, 'dist');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

fs.rmSync(dist, { recursive: true, force: true });

execFileSync(
  process.execPath,
  [path.join(api, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(api, 'tsconfig.build.json')],
  { cwd: api, stdio: 'inherit' }
);

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test') continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else copyFile(src, dst);
  }
}

// Root-level runtime modules and resources the app imports by relative path.
const rootFiles = fs.readdirSync(api, { withFileTypes: true })
  .filter(e => e.isFile() && /\.(js|mjs|cjs|json|md|txt)$/.test(e.name))
  .map(e => e.name)
  .filter(name => name !== 'server.js' && !name.endsWith('.test.js'));

for (const name of rootFiles) {
  const to = path.join(dist, name);
  if (!fs.existsSync(to)) copyFile(path.join(api, name), to);
}

for (const dir of ['coach', 'integrations']) {
  copyDir(path.join(api, dir), path.join(dist, dir));
}

const required = [
  'src/main.js',
  'durable.js',
  'media.js',
  'recover.js',
  'admin-socket.js',
  'coach/fixture-cli.mjs',
  'integrations/index.js',
];

const missing = required.filter(f => !fs.existsSync(path.join(dist, f)));
if (missing.length) {
  console.error('build: missing runtime artifacts in dist:', missing.join(', '));
  process.exit(1);
}

console.log('build: dist ready');
