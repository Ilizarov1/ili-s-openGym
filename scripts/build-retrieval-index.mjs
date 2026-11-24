#!/usr/bin/env node
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { retrievalConfig } from '../api/dist/src/agent/retrieval/config.js';
import { buildRetrievalIndex } from '../api/dist/src/agent/retrieval/index-builder.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiRequire = createRequire(path.join(repo, 'api', 'package.json'));
const { Pool } = apiRequire('pg');
const mode = process.argv[2];
if (mode !== '--ensure' && mode !== '--rebuild') {
  console.error('Usage: node scripts/build-retrieval-index.mjs --ensure|--rebuild');
  process.exit(2);
}
const config = retrievalConfig();
const pool = new Pool({ connectionString: config.pgUrl, max: 2, application_name: 'opengym-retrieval-index-builder' });
try {
  const result = await buildRetrievalIndex(pool, config, repo, mode === '--rebuild');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`retrieval index build failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally { await pool.end(); }
