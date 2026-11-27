#!/usr/bin/env node
// One-click local dev launcher for openGym (NestJS API + Vite Web frontend).
// Usage:
//   npm run dev                 # Start NestJS API + Vite Web (auto-builds API if dist is missing)
//   npm run dev:build           # Force rebuild API before starting
//   npm run dev:demo            # Frontend-only offline Demo mode (VITE_DEMO=1, no API)
//   node scripts/dev.mjs --help

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(REPO_ROOT, 'api');
const FRONTEND_DIR = path.join(REPO_ROOT, 'frontend');
const API_ENTRY = path.join(API_DIR, 'dist', 'src', 'main.js');
const VITE_BIN = path.join(FRONTEND_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

function printHelp() {
  console.log(`openGym local dev launcher

Usage:
  npm run dev [-- [options]]
  node scripts/dev.mjs [options]

Options:
  --demo              Run frontend-only Demo mode (VITE_DEMO=1, skips API)
  --build             Rebuild api/dist before starting the API server
  --port <number>     Preferred API port (default: $PORT or 3000)
  --web-port <number> Preferred Vite port (default: $WEB_PORT or 5173)
  --strict-port       Fail instead of picking the next free port when busy
  --data-dir <path>   Override API DATA_DIR (default: ./data/dev)
  -h, --help          Show this help message

Notes:
  - Automatically loads .env and api/.env (process env vars take precedence).
  - Bridges OPEN_GYM_EVAL_API_KEY / OPEN_GYM_EVAL_MODEL to DEEPSEEK_API_KEY / DEEPSEEK_MODEL when unset.
  - Defaults PASSWORD_LOGIN=1 and FIRST_USER_ADMIN=1 for frictionless local login.
`);
}

function parseArgs(argv) {
  const opts = {
    demo: false,
    build: false,
    strictPort: false,
    port: null,
    webPort: null,
    dataDir: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--demo') opts.demo = true;
    else if (arg === '--build') opts.build = true;
    else if (arg === '--strict-port') opts.strictPort = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length));
    else if (arg === '--web-port') opts.webPort = Number(argv[++i]);
    else if (arg.startsWith('--web-port=')) opts.webPort = Number(arg.slice('--web-port='.length));
    else if (arg === '--data-dir') opts.dataDir = argv[++i];
    else if (arg.startsWith('--data-dir=')) opts.dataDir = arg.slice('--data-dir='.length);
    else {
      throw new Error(`Unknown option: ${arg} (run with --help for usage)`);
    }
  }
  if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) {
    throw new Error('Invalid --port value');
  }
  if (opts.webPort !== null && (!Number.isInteger(opts.webPort) || opts.webPort < 1 || opts.webPort > 65535)) {
    throw new Error('Invalid --web-port value');
  }
  return opts;
}

function readEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function isPortAvailable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

async function resolvePort(preferred, strict, label) {
  if (await isPortAvailable(preferred)) return preferred;
  if (strict) {
    throw new Error(`${label} port ${preferred} is already in use (--strict-port is set).`);
  }
  for (let offset = 1; offset <= 20; offset++) {
    const candidate = preferred + offset;
    if (candidate <= 65535 && (await isPortAvailable(candidate))) {
      console.log(`[dev] ${label} port ${preferred} is busy; using ${candidate} instead.`);
      return candidate;
    }
  }
  throw new Error(`Could not find a free ${label} port in range ${preferred}-${preferred + 20}.`);
}

function pipePrefixed(stream, prefix, target) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const line of lines) {
      target.write(`${prefix} ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buf.length > 0) {
      target.write(`${prefix} ${buf}\n`);
      buf = '';
    }
  });
}

function runCommandSyncLike(cmd, args, cwd, env, prefix) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    pipePrefixed(child.stdout, prefix, process.stdout);
    pipePrefixed(child.stderr, prefix, process.stderr);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${prefix} exited with code ${code ?? 1}`));
    });
  });
}

async function waitForApiReady(port, child, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/config`;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API process exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // keep polling until ready
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`API did not respond at ${url} within ${timeoutMs}ms`);
}

function terminateChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!fs.existsSync(VITE_BIN)) {
    throw new Error('Missing frontend/node_modules. Run `npm --prefix frontend install` first.');
  }

  const rootFileEnv = readEnvFile(path.join(REPO_ROOT, '.env'));
  const apiFileEnv = readEnvFile(path.join(API_DIR, '.env'));
  const mergedEnv = { ...rootFileEnv, ...apiFileEnv, ...process.env };

  const preferredWebPort = opts.webPort ?? (Number(mergedEnv.WEB_PORT) || 5173);
  const webPort = await resolvePort(preferredWebPort, opts.strictPort, 'Web');

  const children = [];
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const c of children) terminateChild(c);
    setTimeout(() => process.exit(code), 300).unref();
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  if (opts.demo) {
    const webEnv = { ...process.env, VITE_DEMO: '1' };
    console.log(`[dev] Starting openGym frontend in Demo mode -> http://127.0.0.1:${webPort}/`);
    const web = spawn(
      process.execPath,
      [VITE_BIN, '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
      { cwd: FRONTEND_DIR, env: webEnv, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(web);
    pipePrefixed(web.stdout, '[web]', process.stdout);
    pipePrefixed(web.stderr, '[web]', process.stderr);
    web.once('exit', (code) => {
      if (!shuttingDown) shutdown(code ?? 0);
    });
    return;
  }

  if (!fs.existsSync(path.join(API_DIR, 'node_modules'))) {
    throw new Error('Missing api/node_modules. Run `npm --prefix api install` first.');
  }

  if (opts.build || !fs.existsSync(API_ENTRY)) {
    console.log('[dev] Building NestJS API (api/dist)...');
    await runCommandSyncLike(
      process.execPath,
      [path.join(API_DIR, 'scripts', 'build-api.mjs')],
      API_DIR,
      process.env,
      '[api:build]',
    );
  }

  const preferredApiPort = opts.port ?? (Number(mergedEnv.PORT) || 3000);
  const apiPort = await resolvePort(preferredApiPort, opts.strictPort, 'API');

  const dataDir = path.resolve(opts.dataDir || mergedEnv.DATA_DIR || path.join(REPO_ROOT, 'data', 'dev'));
  fs.mkdirSync(dataDir, { recursive: true });

  const origin = mergedEnv.ORIGIN || 'http://localhost:8080';
  const deepseekKey = mergedEnv.DEEPSEEK_API_KEY || mergedEnv.OPEN_GYM_EVAL_API_KEY || '';
  const deepseekModel = mergedEnv.DEEPSEEK_MODEL || mergedEnv.OPEN_GYM_EVAL_MODEL || 'deepseek-flash';

  const apiEnv = {
    ...mergedEnv,
    PORT: String(apiPort),
    DATA_DIR: dataDir,
    ORIGIN: origin,
    RP_ID: mergedEnv.RP_ID || 'localhost',
    PASSWORD_LOGIN: mergedEnv.PASSWORD_LOGIN ?? '1',
    FIRST_USER_ADMIN: mergedEnv.FIRST_USER_ADMIN ?? '1',
    ...(deepseekKey ? { DEEPSEEK_API_KEY: deepseekKey, DEEPSEEK_MODEL: deepseekModel } : {}),
  };

  console.log(`[dev] Starting NestJS API on http://127.0.0.1:${apiPort} (DATA_DIR=${dataDir})`);
  const api = spawn(process.execPath, [API_ENTRY], {
    cwd: API_DIR,
    env: apiEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(api);
  pipePrefixed(api.stdout, '[api]', process.stdout);
  pipePrefixed(api.stderr, '[api]', process.stderr);
  api.once('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev] API exited unexpectedly (code ${code ?? 1}); stopping frontend.`);
      shutdown(code || 1);
    }
  });

  await waitForApiReady(apiPort, api);

  const webEnv = {
    ...process.env,
    API_TARGET: `http://127.0.0.1:${apiPort}`,
    API_ORIGIN: origin,
  };
  delete webEnv.VITE_DEMO;

  const web = spawn(
    process.execPath,
    [VITE_BIN, '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    { cwd: FRONTEND_DIR, env: webEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(web);
  pipePrefixed(web.stdout, '[web]', process.stdout);
  pipePrefixed(web.stderr, '[web]', process.stderr);
  web.once('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[dev] Web dev server exited (code ${code ?? 1}); stopping API.`);
      shutdown(code || 1);
    }
  });

  console.log('');
  console.log('============================================================');
  console.log(`  openGym Dev Ready`);
  console.log(`  Web UI   : http://127.0.0.1:${webPort}/`);
  console.log(`  AI Coach : http://127.0.0.1:${webPort}/#/coach`);
  console.log(`  API      : http://127.0.0.1:${apiPort}`);
  console.log(`  DATA_DIR : ${dataDir}`);
  console.log(`  DeepSeek : ${deepseekKey ? `configured (model=${deepseekModel})` : 'not configured'}`);
  console.log('  Press Ctrl+C to stop both services.');
  console.log('============================================================');
  console.log('');
}

main().catch((err) => {
  console.error(`[dev] ${err?.message || err}`);
  process.exit(1);
});
