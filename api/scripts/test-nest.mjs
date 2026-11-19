/* Runs the node:test suite against the compiled Nest entry.
 *
 * Windows does not expand `test/*.test.js`, so the files are listed here. Any
 * extra arguments are forwarded to node:test.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(api, 'test');

const files = [];
for (const name of fs.readdirSync(testDir).sort()) {
  if (name.endsWith('.test.js')) files.push(path.join('test', name));
}
const nestDir = path.join(testDir, 'nest');
if (fs.existsSync(nestDir)) {
  for (const name of fs.readdirSync(nestDir).sort()) {
    if (name.endsWith('.test.js')) files.push(path.join('test', 'nest', name));
  }
}

if (!fs.existsSync(path.join(api, 'dist', 'src', 'main.js'))) {
  console.error('test:nest: dist/src/main.js is missing — run `npm run build` first');
  process.exit(1);
}

const extra = process.argv.slice(2);
const selection = extra.filter(arg => !arg.startsWith('-') && arg.endsWith('.test.js'));
const options = extra.filter(arg => !selection.includes(arg));
const child = spawn(process.execPath, ['--test', ...options, ...(selection.length ? selection : files)], {
  cwd: api,
  stdio: 'inherit',
  env: { ...process.env, API_ENTRY: 'dist/src/main.js' },
});
child.on('exit', code => process.exit(code ?? 1));
