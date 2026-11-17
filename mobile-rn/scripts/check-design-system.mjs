import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

console.log(`design:check OK (${upstreamNames.size} upstream icons, ${rnNames.size} RN icons)`);
