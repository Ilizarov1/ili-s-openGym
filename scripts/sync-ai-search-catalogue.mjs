#!/usr/bin/env node
// Generates the compact, read-only catalogue snapshot for server/eval
// exercise-search tool execution without pulling frontend/src into api/ dist.
//
//   node scripts/sync-ai-search-catalogue.mjs           write the snapshot
//   node scripts/sync-ai-search-catalogue.mjs --check   exit 1 if out of date

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXDB } from '../frontend/src/lib/exercises-data.js';
import zhNames from '../frontend/src/exercise-names/zh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'api', 'agent-runtime', 'tasks', 'exercise-search-catalogue.json');
const checkOnly = process.argv.includes('--check');

export function buildCompactCatalogue(exdb = EXDB, zhMap = zhNames) {
  return exdb.map(entry => ({
    id: String(entry.id || ''),
    n: String(entry.n || ''),
    zh: String(zhMap?.[entry.id] || ''),
    eq: String(entry.eq || ''),
    bp: String(entry.bp || ''),
    tg: String(entry.tg || ''),
  }));
}

export function serializeCompactCatalogue(entries) {
  return `[\n${entries.map(entry => JSON.stringify(entry)).join(',\n')}\n]\n`;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const entries = buildCompactCatalogue();
  const next = serializeCompactCatalogue(entries);
  const current = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : null;

  if (checkOnly) {
    if (current !== next) {
      console.error(`sync-ai-search-catalogue: ${path.relative(ROOT, OUT_PATH)} is out of date`);
      process.exit(1);
    }
    console.log(`sync-ai-search-catalogue: up to date (${entries.length} entries)`);
  } else {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, next, 'utf8');
    console.log(`sync-ai-search-catalogue: wrote ${entries.length} entries to ${path.relative(ROOT, OUT_PATH)}`);
  }
}
