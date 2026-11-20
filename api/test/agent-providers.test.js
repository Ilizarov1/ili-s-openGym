import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentError,
  createFixtureProvider,
  createHttpClient,
  createModelGateway,
  createOpenAIProvider,
  buildOpenAIRequest,
  normalizeModelOutput,
  assertCapabilities,
  validateBaseUrl,
  phoneMayCall,
  isPrivateHost,
} from '../agent-runtime/index.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('endpoint rules keep plain http on the home network only', () => {
  assert.equal(validateBaseUrl('https://api.example.com/v1').ok, true);
  assert.equal(validateBaseUrl('http://192.168.1.5:11434/v1').ok, true);
  assert.equal(validateBaseUrl('http://api.example.com/v1').ok, true, 'validation is scheme-only');
  assert.equal(phoneMayCall('https://api.example.com'), true);
  assert.equal(phoneMayCall('http://192.168.1.5:11434'), true);
  assert.equal(phoneMayCall('http://localhost:11434'), true);
  assert.equal(phoneMayCall('http://api.example.com'), false);
  assert.equal(isPrivateHost('10.2.3.4'), true);
  assert.equal(isPrivateHost('172.20.1.1'), true);
  assert.equal(isPrivateHost('8.8.8.8'), false);
  assert.equal(validateBaseUrl('https://x.example/chat/completions').ok, false);
});

test('the fixture provider never touches the network and covers every case', async () => {
  const network = () => { throw new Error('network used'); };
  const provider = createFixtureProvider({ fetchImpl: network });
  const text = await provider.invoke({ modelInput: { user: { text: 'hello' } } });
  assert.equal(text.text, 'fixture:hello');

  const tool = await createFixtureProvider({ case: 'tool' }).invoke({});
  assert.equal(tool.toolCalls[0].name, 'get_stub_fact');

  const proposal = await createFixtureProvider({ case: 'proposal' }).invoke({});
  assert.equal(proposal.structured.proposal.kind, 'stub.write');

  const error = await createFixtureProvider({ case: 'error' }).invoke({});
  assert.equal(error.error.code, 'model_unavailable');

  const late = await createFixtureProvider({ case: 'late', lateDelayMs: 5 }).invoke({});
  assert.match(late.text, /after cancellation/);
});

test('the HTTP client caps a response and reports a timeout', async () => {
  const request = createHttpClient({
    fetchImpl: async () => new Response('x'.repeat(5000), { status: 200 }),
  });
  await assert.rejects(
    request('https://example.test', {}, { maxBytes: 1024 }),
    error => error instanceof AgentError && error.code === 'model_response_too_large',
  );

  const never = createHttpClient({
    fetchImpl: (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }),
  });
  await assert.rejects(
    never('https://example.test', {}, { timeoutMs: 10 }),
    error => error.code === 'model_timeout',
  );
});

test('an already-cancelled run does not send its request', async () => {
  let called = 0;
  const request = createHttpClient({
    fetchImpl: async () => { called++; return jsonResponse({}); },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    request('https://example.test', {}, { signal: controller.signal }),
    error => error.code === 'run_cancelled',
  );
  assert.equal(called, 0);
});

test('the OpenAI request carries text, images and tool definitions', () => {
  const body = buildOpenAIRequest({
    model: 'gpt-test',
    modelInput: {
      instructions: 'be useful',
      user: {
        text: 'what changed?',
        attachments: [{ id: 'a1', dataUrl: 'data:image/png;base64,AAAA' }],
      },
      facts: [{ evidenceId: 'ev_1', content: { value: 1 } }],
      memories: [],
      history: [],
      tools: [{
        name: 'get_stub_fact',
        description: 'read',
        parameters: { type: 'object', properties: {} },
      }],
      toolResults: [],
    },
  });
  assert.equal(body.model, 'gpt-test');
  assert.equal(body.messages[0].role, 'system');
  assert.ok(Array.isArray(body.messages[1].content));
  assert.ok(body.messages[1].content.some(part => part.type === 'image_url'));
  assert.equal(body.tools[0].function.name, 'get_stub_fact');
  assert.equal(body.tool_choice, 'auto');
});

test('the OpenAI provider normalizes text and tool calls', async () => {
  const provider = createOpenAIProvider({
    baseUrl: 'https://api.example.test/v1',
    apiKey: 'sk-test',
    model: 'gpt-test',
    fetchImpl: async (url, init) => {
      assert.match(String(url), /\/chat\/completions$/);
      assert.equal(init.headers.authorization, 'Bearer sk-test');
      return jsonResponse({
        choices: [{
          message: {
            content: 'answer',
            tool_calls: [{ id: 'call_1', function: { name: 'get_stub_fact', arguments: '{"id":"target-1"}' } }],
          },
        }],
      });
    },
  });
  const output = await provider.invoke({
    modelInput: { instructions: '', user: { text: 'hi' }, facts: [], memories: [], history: [], tools: [], toolResults: [] },
  });
  assert.equal(output.text, 'answer');
  const normalized = normalizeModelOutput(output);
  assert.deepEqual(normalized.toolCalls, [{
    id: 'call_1',
    name: 'get_stub_fact',
    arguments: { id: 'target-1' },
  }]);
});

test('a provider refusal is a stable model error, not a crash', async () => {
  const provider = createOpenAIProvider({
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-test',
    fetchImpl: async () => jsonResponse({ error: { message: 'no key' } }, 401),
  });
  await assert.rejects(
    provider.invoke({ modelInput: { instructions: '', user: { text: 'x' }, facts: [], memories: [], history: [], tools: [], toolResults: [] } }),
    error => error.code === 'model_unavailable' && error.status === 503,
  );
});

test('normalizeModelOutput rejects malformed tool arguments', () => {
  assert.throws(
    () => normalizeModelOutput({ toolCalls: [{ name: 'x', arguments: 'not json' }] }),
    error => error.code === 'invalid_request',
  );
});

test('the gateway checks image capability before the provider is called', async () => {
  let called = 0;
  const gateway = createModelGateway({
    async resolveProfile() {
      return {
        profile: { profileId: 'p1', capabilities: { text: true, image: false, tools: false } },
        provider: { async invoke() { called++; return { text: 'x' }; } },
      };
    },
  });
  await assert.rejects(
    gateway.invoke({ profileId: 'p1' }, {
      instructions: '',
      user: { text: 'x', attachments: [{ id: 'a', dataUrl: 'data:image/png;base64,AA' }] },
      facts: [],
      memories: [],
      history: [],
      tools: [],
      toolResults: [],
    }),
    error => error.code === 'profile_capability_missing',
  );
  assert.equal(called, 0);
  assert.throws(
    () => assertCapabilities({ profileId: 'p', capabilities: { text: true, tools: false } }, ['tools']),
    error => error.code === 'profile_capability_missing',
  );
});
