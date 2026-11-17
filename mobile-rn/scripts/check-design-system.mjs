import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = fileURLToPath(new URL('../..', import.meta.url));

function namesFrom(source) {
  const names = new Set();
  for (const line of source.split(/\r?\n/)) {
    const match = /^  ([A-Za-z][A-Za-z0-9]*):/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

async function read(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

const upstreamIcons = await read(join(repo, 'frontend/src/components/Icon.jsx'));
if (!upstreamIcons) {
  console.error('design:check: cannot read frontend/src/components/Icon.jsx');
  process.exit(1);
}

const rnIcons = await read(join(root, 'src/design/icons/icon-paths.tsx'));
if (!rnIcons) {
  console.error('design:check: missing mobile-rn/src/design/icons/icon-paths.tsx');
  process.exit(1);
}

const upstreamNames = namesFrom(upstreamIcons);
const rnNames = namesFrom(rnIcons);
const missing = [...upstreamNames].filter(name => !rnNames.has(name));
const extra = [...rnNames].filter(name => !upstreamNames.has(name));

if (missing.length) {
  console.error(`design:check: missing icons: ${missing.join(', ')}`);
  process.exit(1);
}
if (extra.length) {
  console.warn(`design:check: icons not in upstream Icon.jsx: ${extra.join(', ')}`);
}

const forbidden = [
  { pattern: /#[0-9a-fA-F]{3,8}\b/g, label: 'hex colour' },
  { pattern: /\bfontSize\s*:/g, label: 'raw fontSize' },
];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const screens = await walk(join(root, 'src/screens'));
const app = join(root, 'App.tsx');
if (await read(app) !== null) screens.push(app);

let rawCount = 0;
for (const file of screens) {
  const source = await read(file);
  if (source == null) continue;
  for (const rule of forbidden) {
    const matches = [...source.matchAll(rule.pattern)];
    if (!matches.length) continue;
    rawCount += matches.length;
    console.error(`design:check: ${relative(root, file)} uses ${rule.label} (${matches.length})`);
  }
}
if (rawCount) {
  console.error('design:check: move raw design values into mobile-rn/src/design');
  process.exit(1);
}

console.log(`design:check OK (${upstreamNames.size} upstream icons, ${rnNames.size} RN icons)`);
