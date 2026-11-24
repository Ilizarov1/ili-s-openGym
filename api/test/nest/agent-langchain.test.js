/* LangChain / LangGraph server runtime integration tests.
 *
 * Exercises compiled NestJS (`dist/src/main.js`) and compiled LangChain engine
 * modules (`dist/src/agent/langchain/index.js`) against real local `node:http`
 * OpenAI-compatible servers covering all 7 migration test groups.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { GraphRecursionError } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { boundPort } from '../helpers.mjs';
import { seedData, fixtureSession, OWNER_ID } from './parity.mjs';
import { PNG_1X1_DATA_URL } from '../agent-fixtures.mjs';
import {
  AgentError,
  bindContext,
  createIds,
  createRunState,
} from '../../dist/agent-runtime/index.js';
import { createTaskRegistry } from '../../dist/src/agent/tasks/index.js';
import { AgentStore } from '../../dist/src/agent/agent.store.js';
import { AgentCrypto } from '../../dist/src/agent/agent-crypto.js';
import { AgentConfigStore } from '../../dist/src/agent/agent-config.store.js';
import { AgentGateway } from '../../dist/src/agent/agent-gateway.js';
import { AtomicWriter } from '../../dist/src/common/persistence/atomic-write.js';
import { Paths } from '../../dist/src/common/persistence/paths.js';
import {
  createBoundedFetch,
  createLangChainChatModel,
  mapLangChainError,
  resolveServerOpenAIBaseUrl,
  runServerAgentWithLangChain,
  sanitizeErrorText,
} from '../../dist/src/agent/langchain/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '../..');

function coachConfig(over = {}) {
  return {
    enabled: true,
    provider: 'fixture',
    authMode: 'instance',
    auth: {},
    models: {},
    providerOptions: {},
    boundUid: {},
    caps: { perProfileDaily: 100, instanceDaily: 0 },
    community: false,
    ...over,
  };
}

function writeCoach(dir, over = {}) {
  fs.writeFileSync(path.join(dir, 'coach.json'), JSON.stringify(coachConfig(over), null, 2), { mode: 0o600 });
}

function killChild(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    child.once('exit', resolve);
    try { child.kill('SIGKILL'); } catch { resolve(); }
  });
}

async function spawnServer(dir, extraEnv = {}) {
  const child = spawn(process.execPath, ['dist/src/main.js'], {
    cwd: API,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: '0',
      DATA_DIR: dir,
      ORIGIN: 'http://localhost:8080',
      RP_ID: 'localhost',
      COACH_DISABLED: '',
      AGENT_RUNTIME_DISABLED: '',
      NODE_ENV: 'test',
      COACH_CREDENTIAL_DIR: path.join(dir, 'coach-auth'),
      INTEGRATIONS: '',
      DEEPSEEK_API_KEY: '',
      ...extraEnv,
    },
  });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const port = await boundPort(child, () => log);
  return {
    dir,
    child,
    base: `http://127.0.0.1:${port}`,
    log: () => log,
    async stop({ keep = false } = {}) {
      await killChild(child);
      if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function startServer(extraEnv = {}, coach = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lc-api-'));
  const seed = seedData(dir, 'default');
  writeCoach(dir, coach);
  const server = await spawnServer(dir, extraEnv);
  return { ...server, seed };
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Origin: 'http://localhost:8080',
  };
}

async function call(server, token, route, init = {}) {
  const response = await fetch(server.base + route, {
    ...init,
    headers: { ...headers(token), ...(init.headers || {}) },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text };
}

async function startRun(server, token, body) {
  const answer = await call(server, token, '/api/agent/runs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  assert.equal(answer.status, 202, answer.text);
  return answer.body;
}

async function waitRun(server, token, runId, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    const answer = await call(server, token, `/api/agent/runs/${runId}`);
    assert.equal(answer.status, 200, answer.text);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(answer.body.status)) {
      return answer.body;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`run did not settle: ${JSON.stringify(answer.body)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function startFakeOpenAIServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    const entry = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
      index: requests.length,
    };
    requests.push(entry);
    await handler(entry, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

test('1. native multi-turn tool calling sends assistant(tool_calls) and tool(tool_call_id) with token usage', { timeout: 30000 }, async () => {
  const fake = await startFakeOpenAIServer((req, res) => {
    if (req.index === 0) {
      assert.equal(req.body.messages[0].role, 'system');
      assert.equal(req.body.messages[1].role, 'user');
      assert.ok(Array.isArray(req.body.tools) && req.body.tools.length === 2);
      assert.equal(req.body.tool_choice, 'auto');
      sendJson(res, {
        id: 'chatcmpl_static_id',
        model: 'lc-test-model',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_stub_1',
              type: 'function',
              function: { name: 'get_stub_fact', arguments: JSON.stringify({ id: 'target-1' }) },
            }],
          },
        }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });
      return;
    }

    const assistantMsg = req.body.messages.find(m => m.role === 'assistant');
    const toolMsg = req.body.messages.find(m => m.role === 'tool');
    assert.ok(assistantMsg, 'round 2 must include role: assistant');
    assert.ok(Array.isArray(assistantMsg.tool_calls) && assistantMsg.tool_calls.length === 1);
    assert.equal(assistantMsg.tool_calls[0].id, 'call_stub_1');
    assert.equal(assistantMsg.tool_calls[0].function.name, 'get_stub_fact');
    assert.ok(toolMsg, 'round 2 must include role: tool');
    assert.equal(toolMsg.tool_call_id, 'call_stub_1');
    assert.equal(toolMsg.name, 'get_stub_fact');
    const parsedTool = JSON.parse(toolMsg.content);
    assert.equal(parsedTool.objectId, 'target-1');
    assert.equal(parsedTool.version, 1);
    assert.ok(parsedTool.evidenceId, 'tool message payload carries evidenceId');
    assert.equal(
      req.body.messages.some(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('## Tool results')),
      false,
      'must not flatten tool results into user JSON',
    );
    sendJson(res, {
      id: 'chatcmpl_static_id',
      model: 'lc-test-model',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'target-1 checked cleanly' },
      }],
      usage: { prompt_tokens: 150, completion_tokens: 10, total_tokens: 160 },
    });
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'lc-test-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const started = await startRun(server, token, {
      taskId: 'stub.v1',
      requestId: 'req_lc_multiturn_01',
      profileId: 'default',
      input: { prompt: 'read target-1' },
    });
    const run = await waitRun(server, token, started.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.result.text, 'target-1 checked cleanly');
    assert.equal(run.result.usage.rounds, 2);
    assert.equal(run.result.usage.toolCalls, 1);
    assert.equal(run.result.usage.inputTokens, 250);
    assert.equal(run.result.usage.outputTokens, 30);
    assert.equal(run.result.usage.totalTokens, 280);
    assert.ok(run.result.evidence.some(ev => ev.objectId === 'target-1' && ev.source === 'tool:get_stub_fact'));
    assert.equal(fake.requests.length, 2);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('2. four tool fences hard-abort without feeding ToolMessage back, plus round budget and GraphRecursionError', { timeout: 30000 }, async () => {
  let scenario = 'not_allowed';
  const fake = await startFakeOpenAIServer((req, res) => {
    const makeToolResponse = calls => sendJson(res, {
      id: `cmpl_${req.index}`,
      model: 'lc-fence-model',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: calls,
        },
      }],
    });

    if (scenario === 'not_allowed') {
      makeToolResponse([{ id: 'c1', type: 'function', function: { name: 'delete_everything', arguments: '{}' } }]);
    } else if (scenario === 'args_invalid') {
      makeToolResponse([{ id: 'c1', type: 'function', function: { name: 'get_stub_fact', arguments: '{"id":"target-1","extra":true}' } }]);
    } else if (scenario === 'out_of_scope') {
      makeToolResponse([{ id: 'c1', type: 'function', function: { name: 'get_stub_fact', arguments: '{"id":"target-foreign"}' } }]);
    } else if (scenario === 'budget_exceeded') {
      const fiveCalls = Array.from({ length: 5 }, (_, idx) => ({
        id: `cb_${idx + 1}`,
        type: 'function',
        function: { name: 'get_stub_fact', arguments: '{"id":"target-1"}' },
      }));
      makeToolResponse(fiveCalls);
    } else if (scenario === 'round_loop') {
      makeToolResponse([{
        id: `cr_${req.index}`,
        type: 'function',
        function: { name: 'get_stub_fact', arguments: '{"id":"target-1"}' },
      }]);
    }
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'lc-fence-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const cases = [
      ['not_allowed', 'tool_not_allowed', 1],
      ['args_invalid', 'tool_args_invalid', 1],
      ['out_of_scope', 'tool_target_out_of_scope', 1],
      ['budget_exceeded', 'tool_budget_exceeded', 1],
      ['round_loop', 'invalid_request', 3],
    ];

    for (const [name, expectedCode, expectedRequests] of cases) {
      scenario = name;
      const beforeCount = fake.requests.length;
      const started = await startRun(server, token, {
        taskId: 'stub.v1',
        requestId: `req_lc_fence_${name}`,
        profileId: 'default',
        input: { prompt: `trigger ${name}` },
      });
      const run = await waitRun(server, token, started.runId);
      assert.equal(run.status, 'failed', JSON.stringify(run));
      assert.equal(run.error.code, expectedCode, `${name}: ${JSON.stringify(run)}`);
      assert.equal(fake.requests.length - beforeCount, expectedRequests, `${name}: must abort immediately without extra model rounds`);
      if (name === 'round_loop') {
        assert.equal(run.error.message, 'the model kept calling tools after the round budget');
      }
    }

    const mappedRecursion = mapLangChainError(new GraphRecursionError('Recursion limit of 10 reached'));
    assert.equal(mappedRecursion.code, 'invalid_request');
    assert.equal(mappedRecursion.message, 'the model kept calling tools after the round budget');
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('3. DeepSeek thinking=disabled and exercise-search multimodal response_format=json_object passthrough', { timeout: 30000 }, async () => {
  const fake = await startFakeOpenAIServer((req, res) => {
    if (req.body.model === 'deepseek-flash') {
      assert.equal(req.headers.authorization, 'Bearer sk-deepseek-wire-test');
      assert.deepEqual(req.body.thinking, { type: 'disabled' });
      assert.deepEqual(req.body.response_format, { type: 'json_object' });
      assert.equal(req.body.tools, undefined);
      assert.equal(req.body.tool_choice, undefined);
      sendJson(res, {
        id: 'ds_1',
        model: 'deepseek-flash',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: JSON.stringify({
              fallback: { understanding: 'deepseek disabled thinking ok', bodyParts: ['chest'], equipment: ['barbell'] },
              candidates: [{ name: 'barbell bench press', nameEn: 'barbell bench press', rationale: 'stated', level: 'high', equipment: 'barbell', bodyPart: 'chest' }],
            }),
          },
        }],
        usage: { prompt_tokens: 40, completion_tokens: 25, total_tokens: 65 },
      });
      return;
    }

    assert.deepEqual(req.body.response_format, { type: 'json_object' });
    assert.equal(req.body.tools, undefined);
    assert.equal(req.body.tool_choice, undefined);
    assert.equal(req.body.messages[0].role, 'system');
    assert.equal(req.body.messages[1].role, 'user');
    assert.ok(Array.isArray(req.body.messages[1].content));
    assert.deepEqual(req.body.messages[1].content.slice(0, 3), [
      { type: 'text', text: '杠铃卧推' },
      { type: 'text', text: '[当前图片]' },
      { type: 'image_url', image_url: { url: PNG_1X1_DATA_URL } },
    ]);
    sendJson(res, {
      id: 'mm_1',
      model: 'vision-model',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            fallback: { understanding: 'flat barbell press', bodyParts: ['chest'], equipment: ['barbell'] },
            candidates: [{ name: '杠铃卧推', nameEn: 'barbell bench press', rationale: 'flat bench and barbell', level: 'high', equipment: 'barbell', bodyPart: 'chest' }],
          }),
        },
      }],
    });
  });

  const server = await startServer({}, {
    provider: 'compatible',
    models: { compatible: 'vision-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    assert.equal(resolveServerOpenAIBaseUrl({ provider: 'deepseek' }), 'https://api.deepseek.com');
    assert.equal(resolveServerOpenAIBaseUrl({ provider: 'openai' }), 'https://api.openai.com/v1');
    assert.equal(resolveServerOpenAIBaseUrl({ provider: 'openai', baseUrl: 'https://api.openai.com' }), 'https://api.openai.com/v1');
    assert.equal(resolveServerOpenAIBaseUrl({ provider: 'compatible', baseUrl: fake.url }), fake.url);

    // Direct DeepSeek wire-level test through createLangChainChatModel
    const dsModel = createLangChainChatModel({
      resolved: {
        profile: {
          id: 'ds_test',
          source: 'user',
          provider: 'deepseek',
          model: 'deepseek-flash',
          capabilities: { text: true, image: true, tools: true },
          version: 1,
          label: 'DeepSeek',
          available: true,
        },
        provider: 'deepseek',
        model: 'deepseek-flash',
        baseUrl: fake.url,
        apiKey: 'sk-deepseek-wire-test',
      },
      tools: [],
      responseFormat: 'json',
    });
    const dsReply = await dsModel.invoke([
      new SystemMessage('return json'),
      new HumanMessage('bench press'),
    ]);
    assert.match(String(dsReply.content), /barbell bench press/);

    // Full NestJS multimodal exercise-search.v1 HTTP round-trip
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');
    const started = await startRun(server, token, {
      taskId: 'exercise-search.v1',
      requestId: 'req_lc_multimodal_01',
      profileId: 'default',
      input: { hintText: '杠铃卧推', images: [PNG_1X1_DATA_URL] },
    });
    const run = await waitRun(server, token, started.runId);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.equal(run.result.structured.candidates[0].nameEn, 'barbell bench press');
    assert.equal(fake.requests.length, 2);
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('4. HTTP boundaries: >1MB body, stalled body timeout, cancellation race, and error redaction', { timeout: 30000 }, async () => {
  let mode = 'oversize';
  let requestArrived = null;
  const fake = await startFakeOpenAIServer((_req, res) => {
    if (mode === 'oversize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      const padding = 'x'.repeat(1200 * 1024);
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: padding } }],
      }));
      return;
    }
    if (mode === 'stall_timeout') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"choices":');
      setTimeout(() => {
        try { res.end('[]}'); } catch { /* already closed */ }
      }, 600);
      return;
    }
    if (mode === 'cancel_late') {
      requestArrived?.();
      setTimeout(() => {
        try {
          sendJson(res, {
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  text: 'late proposal',
                  proposal: {
                    kind: 'stub.write',
                    targetId: 'target-1',
                    targetVersion: 1,
                    changes: [{ field: 'value', value: 'should not persist' }],
                  },
                }),
              },
            }],
          });
        } catch { /* closed */ }
      }, 350);
      return;
    }
    if (mode === 'auth_leak') {
      sendJson(res, {
        error: {
          message: 'Incorrect key sk-super-secret-leak Bearer tok-secret-999 data:image/png;base64,SECRETBASE64DATA',
        },
      }, 401);
    }
  });

  const server = await startServer({ AGENT_MODEL_TIMEOUT_MS: '150' }, {
    provider: 'compatible',
    models: { compatible: 'boundary-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });

  try {
    const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');

    mode = 'oversize';
    const oversizeStart = await startRun(server, token, {
      taskId: 'stub.v1',
      requestId: 'req_lc_oversize_01',
      profileId: 'default',
      input: { prompt: 'oversize' },
    });
    const oversizeRun = await waitRun(server, token, oversizeStart.runId);
    assert.equal(oversizeRun.status, 'failed', JSON.stringify(oversizeRun));
    assert.equal(oversizeRun.error.code, 'model_response_too_large');

    mode = 'stall_timeout';
    const timeoutStart = await startRun(server, token, {
      taskId: 'stub.v1',
      requestId: 'req_lc_timeout_01',
      profileId: 'default',
      input: { prompt: 'stall' },
    });
    const timeoutRun = await waitRun(server, token, timeoutStart.runId);
    assert.equal(timeoutRun.status, 'failed', JSON.stringify(timeoutRun));
    assert.equal(timeoutRun.error.code, 'model_timeout');

    mode = 'cancel_late';
    const arrived = new Promise(resolve => { requestArrived = resolve; });
    const cancelStart = await startRun(server, token, {
      taskId: 'stub.v1',
      requestId: 'req_lc_cancel_01',
      profileId: 'default',
      input: { prompt: 'cancel me' },
    });
    await arrived;
    const cancelled = await call(server, token, `/api/agent/runs/${cancelStart.runId}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200, cancelled.text);
    assert.equal(cancelled.body.status, 'cancelled');
    await new Promise(resolve => setTimeout(resolve, 450));
    const settled = await call(server, token, `/api/agent/runs/${cancelStart.runId}`);
    assert.equal(settled.body.status, 'cancelled');
    assert.equal(settled.body.result, undefined);
    const stored = JSON.parse(fs.readFileSync(path.join(server.dir, `agent-${OWNER_ID}.json`), 'utf8'));
    const confirmable = Object.values(stored.proposals).filter(p => p.runId === cancelStart.runId && p.status === 'pending');
    assert.deepEqual(confirmable, [], 'cancelled run must leave zero confirmable proposals');

    mode = 'auth_leak';
    const leakStart = await startRun(server, token, {
      taskId: 'stub.v1',
      requestId: 'req_lc_leak_01',
      profileId: 'default',
      input: { prompt: '401 leak' },
    });
    const leakRun = await waitRun(server, token, leakStart.runId);
    assert.equal(leakRun.status, 'failed', JSON.stringify(leakRun));
    assert.equal(leakRun.error.code, 'model_unavailable');
    assert.equal(JSON.stringify(leakRun).includes('sk-super-secret-leak'), false);
    assert.equal(JSON.stringify(leakRun).includes('tok-secret-999'), false);
    assert.equal(JSON.stringify(leakRun).includes('SECRETBASE64DATA'), false);
    assert.equal(server.log().includes('sk-super-secret-leak'), false);
    assert.equal(server.log().includes('SECRETBASE64DATA'), false);

    // Also verify createBoundedFetch directly strips content-encoding/length
    const cleanFetch = createBoundedFetch({
      maxBytes: 2048,
      fetchImpl: async () => new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '999' },
      }),
    });
    const cleanRes = await cleanFetch('http://127.0.0.1/test');
    assert.equal(cleanRes.headers.get('content-encoding'), null);
    assert.equal(cleanRes.headers.get('content-length'), null);
    assert.deepEqual(await cleanRes.json(), { ok: true });
    assert.equal(
      sanitizeErrorText('Bearer tok_abc sk-secret123 data:image/png;base64,AAAA'),
      'Bearer [REDACTED] [REDACTED_KEY] [REDACTED_IMAGE_DATA_URL]',
    );
  } finally {
    await server.stop();
    await fake.close();
  }
});

test('5. per-round profile version drift rejects round 2 with profile_not_found before calling provider', { timeout: 30000 }, async () => {
  let releaseRound1 = null;
  let notifyRound1 = null;
  const round1Promise = new Promise(resolve => { notifyRound1 = resolve; });
  const fake = await startFakeOpenAIServer(async (req, res) => {
    notifyRound1?.();
    await new Promise(resolve => { releaseRound1 = resolve; });
    sendJson(res, {
      id: `drift_${req.index}`,
      model: 'gpt-v1',
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_stub_fact', arguments: '{"id":"target-1"}' } }],
        },
      }],
    });
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lc-drift-'));
  const seed = seedData(dir, 'default');
  try {
    const runtimeConfig = { dataDir: dir, secret: seed.secret };
    const paths = new Paths(runtimeConfig);
    const writer = new AtomicWriter();
    const store = new AgentStore(paths, writer);
    const crypto = new AgentCrypto(runtimeConfig);
    const configs = new AgentConfigStore(store, crypto);
    const origResolve = configs.resolve.bind(configs);
    configs.resolve = async (uid, profileId) => ({
      ...(await origResolve(uid, profileId)),
      baseUrl: fake.url,
    });
    const gateway = new AgentGateway(configs);
    const tasks = createTaskRegistry({ store });
    const stub = tasks.get('stub.v1');
    const created = await configs.create(OWNER_ID, {
      provider: 'openai',
      model: 'gpt-v1',
      apiKey: 'sk-drift-key-v1-1234',
    }, 'prf_drift_1');
    const resolvedV1 = await configs.resolve(OWNER_ID, created.id);
    const ids = createIds();
    const runId = ids.run();
    const request = {
      taskId: 'stub.v1',
      requestId: 'req_lc_drift_0001',
      profileId: created.id,
      input: { prompt: 'drift' },
    };
    const context = bindContext({
      scope: OWNER_ID,
      runId,
      request,
      execution: 'server',
      profileRef: resolvedV1.profile,
      ids,
    });
    const state = createRunState({
      runId,
      requestId: request.requestId,
      taskId: request.taskId,
      profileId: created.id,
      scope: OWNER_ID,
      execution: 'server',
      status: 'accepted',
      createdAt: Date.now(),
    });

    const runPromise = runServerAgentWithLangChain({
      task: stub.task,
      request,
      context,
      gateway: gateway.forAccountLangChain(OWNER_ID),
      tools: stub.tools,
      state,
    });

    await round1Promise;
    const updated = await configs.update(OWNER_ID, created.id, { model: 'gpt-v2' });
    assert.equal(updated.version, 2);
    releaseRound1();

    await assert.rejects(
      runPromise,
      error => error instanceof AgentError && error.code === 'profile_not_found',
    );
    assert.equal(state.status(), 'failed');
    assert.equal(fake.requests.length, 1, 'round 2 must fail on version drift before any HTTP call');
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('6. AGENT_SERVER_ENGINE=langchain and AGENT_SERVER_ENGINE=legacy produce parity outputs and storage', { timeout: 45000 }, async () => {
  const results = {};
  for (const engine of ['langchain', 'legacy']) {
    const server = await startServer({
      AGENT_SERVER_ENGINE: engine,
      EXERCISE_SEARCH_VERSION: 'v2',
    });
    try {
      const token = fixtureSession(server.seed.secret, OWNER_ID, 'b');

      const textStart = await startRun(server, token, {
        taskId: 'stub.v1',
        requestId: `req_parity_text_${engine}`,
        profileId: 'default',
        input: { prompt: 'parity hello' },
      });
      const textRun = await waitRun(server, token, textStart.runId);

      const propStart = await startRun(server, token, {
        taskId: 'stub.v1',
        requestId: `req_parity_prop_${engine}`,
        profileId: 'default',
        input: { prompt: 'propose', fixtureCase: 'proposal' },
      });
      const propRun = await waitRun(server, token, propStart.runId);
      const confirmed = await call(server, token, `/api/agent/proposals/${propRun.result.proposal.proposalId}/confirm`, {
        method: 'POST',
      });
      assert.equal(confirmed.status, 200, confirmed.text);

      const v1Start = await startRun(server, token, {
        taskId: 'exercise-search.v1',
        requestId: `req_parity_v1_${engine}`,
        profileId: 'default',
        sessionId: `ses_parity_v1_${engine}`,
        sessionMode: 'new',
        input: { hintText: '坐姿推肩', fixtureCase: 'candidates' },
      });
      const v1Run = await waitRun(server, token, v1Start.runId);
      const v1Session = await call(server, token, `/api/agent/sessions/ses_parity_v1_${engine}`);

      const v2Start = await startRun(server, token, {
        taskId: 'exercise-search.v2',
        requestId: `req_parity_v2_${engine}`,
        profileId: 'default',
        sessionId: `ses_parity_v2_${engine}`,
        sessionMode: 'new',
        input: { hintText: '坐姿推胸' },
      });
      const v2Run = await waitRun(server, token, v2Start.runId);
      const v2Session = await call(server, token, `/api/agent/sessions/ses_parity_v2_${engine}`);

      results[engine] = {
        text: { status: textRun.status, text: textRun.result.text, usage: textRun.result.usage },
        proposal: {
          status: propRun.status,
          kind: propRun.result.proposal.kind,
          changes: propRun.result.proposal.changes,
          targetScope: propRun.result.proposal.targetScope,
          targetVersion: propRun.result.proposal.targetVersion,
          confirmedResult: confirmed.body.result,
        },
        v1: {
          status: v1Run.status,
          structured: v1Run.result.structured,
          messages: v1Session.body.messages.map(m => ({ role: m.role, content: m.content, meta: m.meta })),
        },
        v2: {
          status: v2Run.status,
          structured: v2Run.result.structured,
          messages: v2Session.body.messages.map(m => ({ role: m.role, content: m.content, meta: m.meta })),
        },
      };
    } finally {
      await server.stop();
    }
  }

  assert.deepEqual(results.langchain, results.legacy);
});

test('7. exercise-search diagnostics emit ordered stages with zero key or base64 leakage', { timeout: 30000 }, async () => {
  let failNext = false;
  const fake = await startFakeOpenAIServer((_req, res) => {
    if (failNext) {
      sendJson(res, {
        error: { message: 'sk-diag-secret-9999 Bearer tok-diag-secret data:image/png;base64,DIAGSECRET' },
      }, 401);
      return;
    }
    sendJson(res, {
      id: 'diag_1',
      model: 'diag-model',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            fallback: { understanding: 'seated chest press', bodyParts: ['chest'], equipment: ['leverage machine'] },
            candidates: [{ name: '坐姿推胸', nameEn: 'lever chest press', rationale: 'machine handles', level: 'high', equipment: 'leverage machine', bodyPart: 'chest' }],
          }),
        },
      }],
    });
  });

  const compatibleServer = await startServer({
    AGENT_EXERCISE_SEARCH_DIAGNOSTICS: '1',
  }, {
    provider: 'compatible',
    models: { compatible: 'diag-model' },
    providerOptions: { compatible: { baseUrl: fake.url } },
  });
  const fixtureV2Server = await startServer({
    EXERCISE_SEARCH_VERSION: 'v2',
    AGENT_EXERCISE_SEARCH_DIAGNOSTICS: '1',
  });

  try {
    const parseTrace = (server, traceId) => server.log()
      .split('\n')
      .filter(line => line.startsWith('{"event":"exercise_search"'))
      .map(line => JSON.parse(line))
      .filter(event => event.traceId === traceId);

    const token1 = fixtureSession(compatibleServer.seed.secret, OWNER_ID, 'b');
    const req1 = 'req_8d3d1414-2e15-4c63-9b81-111111111111';
    const v1 = await startRun(compatibleServer, token1, {
      taskId: 'exercise-search.v1',
      requestId: req1,
      profileId: 'default',
      input: { hintText: 'private-diag-hint-marker', images: [PNG_1X1_DATA_URL] },
    });
    assert.equal((await waitRun(compatibleServer, token1, v1.runId)).status, 'completed');

    failNext = true;
    const req3 = 'req_8d3d1414-2e15-4c63-9b81-333333333333';
    const failStart = await startRun(compatibleServer, token1, {
      taskId: 'exercise-search.v1',
      requestId: req3,
      profileId: 'default',
      input: { hintText: 'should fail safely' },
    });
    const failRun = await waitRun(compatibleServer, token1, failStart.runId);
    assert.equal(failRun.status, 'failed');
    assert.equal(failRun.error.code, 'model_unavailable');

    const token2 = fixtureSession(fixtureV2Server.seed.secret, OWNER_ID, 'b');
    const req2 = 'req_8d3d1414-2e15-4c63-9b81-222222222222';
    const v2 = await startRun(fixtureV2Server, token2, {
      taskId: 'exercise-search.v2',
      requestId: req2,
      profileId: 'default',
      input: { hintText: '坐姿推胸' },
    });
    assert.equal((await waitRun(fixtureV2Server, token2, v2.runId)).status, 'completed');

    const events1 = parseTrace(compatibleServer, req1);
    assert.deepEqual(events1.map(e => e.stage), ['attachments', 'model', 'recognition', 'end']);
    assert.equal(events1[1].status, 'completed');
    assert.equal(events1[3].status, 'completed');

    const events2 = parseTrace(fixtureV2Server, req2);
    const stages2 = events2.map(e => e.stage);
    assert.equal(stages2[0], 'attachments');
    assert.equal(stages2[1], 'model');
    assert.equal(stages2[2], 'recognition');
    for (const s of ['retrieval_text', 'retrieval_vector', 'retrieval_fusion', 'rerank']) {
      assert.ok(stages2.includes(s), `missing stage ${s}`);
    }
    assert.equal(stages2.at(-1), 'end');

    const events3 = parseTrace(compatibleServer, req3);
    assert.deepEqual(events3.map(e => e.stage), ['attachments', 'model', 'end']);
    assert.equal(events3[1].status, 'failed');
    assert.equal(events3[1].errorCode, 'model_unavailable');
    assert.equal(events3[2].status, 'failed');
    assert.equal(events3[2].phase, 'model');

    const allLog = compatibleServer.log() + '\n' + fixtureV2Server.log();
    assert.equal(allLog.includes('sk-diag-secret-9999'), false);
    assert.equal(allLog.includes('tok-diag-secret'), false);
    assert.equal(allLog.includes('DIAGSECRET'), false);
    assert.equal(allLog.includes('private-diag-hint-marker'), false);
    assert.equal(allLog.includes('base64'), false);
  } finally {
    await compatibleServer.stop();
    await fixtureV2Server.stop();
    await fake.close();
  }
});
