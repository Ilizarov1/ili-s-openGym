/* Unit tests for the RN Coach AG-UI stream client.
 *
 * The module under test imports the React Native-only `expo/fetch` specifier, which Node
 * cannot resolve. A synchronous resolve hook swaps in an inert stub; every behaviour test
 * drives the injected `transport` seam instead, so the real fetch path is still exercised
 * through the exact same `streamCoachGenUI` code.
 *
 * Run with: node --test mobile-rn/scripts/coach-stream.test.mjs
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const encoder = new TextEncoder();

const EXPO_FETCH_STUB = 'data:text/javascript,'
  + encodeURIComponent('export const fetch = () => Promise.reject(new Error("expo/fetch is unavailable in node"));');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo/fetch') return { url: EXPO_FETCH_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const {
  createSseFrameParser,
  streamCoachGenUI,
  fetchCoachConfig,
} = await import('../src/agent/coach-stream.ts');

/* ------------------------------- helpers ---------------------------------- */

function frame(event, delimiter = '\n\n') {
  return `data: ${JSON.stringify(event)}${delimiter}`;
}

function parseAll(chunks) {
  const events = [];
  const parser = createSseFrameParser(event => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  parser.flush();
  return events;
}

function byteChunks(text, size) {
  const bytes = encoder.encode(text);
  const chunks = [];
  for (let at = 0; at < bytes.length; at += size) chunks.push(bytes.slice(at, at + size));
  return chunks;
}

function jsonResponse(status, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    body: null,
    text: async () => text,
  };
}

function streamResponse(chunks, { status = 200 } = {}) {
  let at = 0;
  return {
    status,
    ok: status >= 200 && status < 300,
    body: {
      getReader() {
        return {
          read: async () => (at < chunks.length
            ? { done: false, value: chunks[at++] }
            : { done: true, value: undefined }),
          cancel: async () => {
            at = chunks.length;
          },
        };
      },
    },
    text: async () => '',
  };
}

/* A reader that delivers one chunk, then parks until `cancel()` (the abort path). */
function hangingResponse(firstChunk) {
  let pending = null;
  let sent = false;
  return {
    status: 200,
    ok: true,
    body: {
      getReader() {
        return {
          read() {
            if (!sent) {
              sent = true;
              return Promise.resolve({ done: false, value: firstChunk });
            }
            return new Promise(resolve => {
              pending = resolve;
            });
          },
          cancel: async () => {
            const release = pending;
            pending = null;
            release?.({ done: true, value: undefined });
          },
        };
      },
    },
    text: async () => '',
  };
}

/* A small XHR double: `send` pumps chunks through onprogress, then onload. */
function fakeXhr({ status = 200, chunks = [], hangAfter = chunks.length } = {}) {
  const xhr = {
    status: 0,
    responseText: '',
    method: '',
    url: '',
    body: undefined,
    headers: {},
    sent: 0,
    aborted: false,
    progressCalls: 0,
    onprogress: null,
    onload: null,
    onerror: null,
    onabort: null,
    open(method, url) {
      this.method = method;
      this.url = url;
    },
    setRequestHeader(name, value) {
      this.headers[name] = value;
    },
    send(body) {
      this.body = body;
      queueMicrotask(() => this.pump());
    },
    abort() {
      this.aborted = true;
      queueMicrotask(() => this.onabort?.());
    },
    pump() {
      if (this.aborted) return;
      this.status = status;
      if (this.sent >= chunks.length) {
        this.onload?.();
        return;
      }
      this.responseText += chunks[this.sent];
      this.sent += 1;
      this.progressCalls += 1;
      this.onprogress?.();
      if (this.sent >= chunks.length) {
        queueMicrotask(() => this.pump()); // the next pump lands on onload
        return;
      }
      if (this.sent >= hangAfter) return;
      queueMicrotask(() => this.pump());
    },
  };
  return xhr;
}

function collector() {
  const events = [];
  return { events, onEvent: event => events.push(event) };
}

/* --------------------------- SSE frame parser ----------------------------- */

test('parser reassembles a multi-byte Chinese delta fed one byte at a time', () => {
  const chinese = '你最近六周的卧推一直停在同一个重量';
  const text = [
    ': ping\r\n\r\n',
    frame({ type: 'CUSTOM', name: 'genui.prose_delta', value: { nodeId: 'p1', delta: chinese } }, '\r\n\r\n'),
    frame({ type: 'RUN_FINISHED', text: chinese }),
  ].join('');

  const events = [];
  const parser = createSseFrameParser(event => events.push(event));
  const decoder = new TextDecoder();
  // One byte per push: every 3-byte Chinese character is split across chunks on purpose.
  for (const byte of encoder.encode(text)) {
    parser.push(decoder.decode(new Uint8Array([byte]), { stream: true }));
  }
  parser.push(decoder.decode());
  parser.flush();

  assert.deepEqual(events.map(event => event.type), ['CUSTOM', 'RUN_FINISHED']);
  assert.equal(events[0].value.delta, chinese);
  assert.equal(events[1].text, chinese);
});

test('parser accepts CRLF and LF, sticky frames, heartbeats and a trailing partial frame', () => {
  const events = [];
  const parser = createSseFrameParser(event => events.push(event));

  parser.push(': ping\r\n\r\n');
  assert.equal(events.length, 0, 'a heartbeat is not an event');

  parser.push(
    frame({ type: 'STEP_STARTED', stepName: 'analyze' }, '\r\n\r\n')
    + frame({ type: 'STEP_FINISHED', stepName: 'analyze' })
    + frame({ type: 'CUSTOM', name: 'genui.node_pending', value: { nodeId: 'n1' } }),
  );
  assert.deepEqual(events.map(event => event.type), ['STEP_STARTED', 'STEP_FINISHED', 'CUSTOM']);

  parser.push('data: {"type":"RUN_ERROR","code":"model_unavailable",');
  assert.equal(events.length, 3, 'an incomplete frame stays buffered');
  parser.push('"message":"boom"}');
  assert.equal(events.length, 3);

  parser.flush();
  assert.equal(events.length, 4);
  assert.deepEqual(
    { type: events[3].type, code: events[3].code, message: events[3].message },
    { type: 'RUN_ERROR', code: 'model_unavailable', message: 'boom' },
  );

  parser.flush();
  assert.equal(events.length, 4, 'flush is idempotent');
});

test('parser forwards every AG-UI event the Coach service emits', () => {
  const sequence = [
    { type: 'RUN_STARTED', runId: 'run_1', threadId: 'thread_1', protocolVersion: 2, timestamp: '2026-11-27T08:00:00.000Z' },
    { type: 'STEP_STARTED', stepName: 'analyze', label: 'Checking exercise history & swaps' },
    { type: 'STEP_FINISHED', stepName: 'analyze' },
    { type: 'TOOL_CALL_START', toolCallId: 'tool_1', toolCallName: 'search_catalogue', args: { queries: ['incline dumbbell press'] } },
    { type: 'TOOL_CALL_RESULT', toolCallId: 'tool_1', toolCallName: 'search_catalogue', summary: '{"items":[]}' },
    { type: 'CUSTOM', name: 'genui.prose_delta', value: { nodeId: 'p1', delta: '你最近' } },
    { type: 'CUSTOM', name: 'genui.node_pending', value: { nodeId: 'n1', nodeType: 'exercise_trend' } },
    { type: 'CUSTOM', name: 'genui.node_commit', value: { node: { id: 'n1', type: 'exercise_trend' } } },
    { type: 'CUSTOM', name: 'genui.node_drop', value: { nodeId: 'n2', reason: 'unknown exercise id' } },
    {
      type: 'RUN_FINISHED',
      runId: 'run_1',
      threadId: 'thread_1',
      protocolVersion: 2,
      text: '你最近六周的卧推一直停在同一个重量',
      nodes: [{ id: 'p1', type: 'prose', text: '你最近六周的卧推一直停在同一个重量' }],
      blocks: [],
    },
    { type: 'RUN_ERROR', code: 'model_unavailable', message: 'the model is unavailable' },
  ];

  const events = parseAll([sequence.map(event => frame(event)).join('')]);

  assert.deepEqual(events, sequence);
  assert.equal(events[3].args.queries[0], 'incline dumbbell press');
  assert.equal(events[7].value.node.type, 'exercise_trend');
});

test('parser ignores malformed, typeless and comment frames but keeps later events', () => {
  const events = parseAll([
    ': ping\n\n',
    'event: message\n\n',
    'data: not json\n\n',
    'data: {"no":"type"}\n\n',
    'data: {"type":5}\n\n',
    frame({ type: 'RUN_STARTED' }),
  ]);

  assert.deepEqual(events, [{ type: 'RUN_STARTED' }]);
});

test('parser joins multi-line data fields and accepts data: without a space', () => {
  const events = parseAll([
    'data: {"type":"CUSTOM",\n'
    + 'data:"name":"genui.block_upsert",\n'
    + 'data:"value":{"block":{"id":"b1"}}}\n\n',
    'data:{"type":"RUN_FINISHED","text":"ok"}\n\n',
  ]);

  assert.deepEqual(events.map(event => event.type), ['CUSTOM', 'RUN_FINISHED']);
  assert.equal(events[0].name, 'genui.block_upsert');
  assert.equal(events[0].value.block.id, 'b1');
  assert.equal(events[1].text, 'ok');
});

/* ----------------------------- fetch transport ---------------------------- */

test('streamCoachGenUI streams expo/fetch byte chunks and returns the RUN_FINISHED payload', async () => {
  const chinese = '你最近六周的卧推一直停在同一个重量，先把顶组多加一次。';
  const text = [
    ': ping\r\n\r\n',
    frame({ type: 'RUN_STARTED', runId: 'run_9', threadId: 'thread_9', protocolVersion: 2 }, '\r\n\r\n'),
    ': ping\n\n',
    frame({ type: 'RUN_FINISHED', runId: 'run_9', text: chinese, nodes: [{ id: 'p1', type: 'prose', text: chinese }], blocks: [] }),
  ].join('');

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return streamResponse(byteChunks(text, 7));
  };
  const { events, onEvent } = collector();

  const result = await streamCoachGenUI({
    connection: { server: 'https://gym.example.com///', token: 'pair-token' },
    text: '我的卧推停滞了怎么办？',
    history: [{ role: 'user', content: '之前聊过卧推' }, { role: 'assistant', content: '继续练' }],
    formSubmission: { formId: 'shoulder_triage', answers: { painArea: 'front_shoulder' } },
    plan: { routines: [], week: {} },
    lang: 'zh',
    today: '2026-11-27',
    onEvent,
    transport: { fetch: fetchImpl },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gym.example.com/api/agent/coach/stream');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer pair-token');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers.Accept, 'text/event-stream');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.text, '我的卧推停滞了怎么办？');
  assert.equal(body.lang, 'zh');
  assert.equal(body.today, '2026-11-27');
  assert.deepEqual(body.plan, { routines: [], week: {} });
  assert.equal(body.formSubmission.formId, 'shoulder_triage');
  assert.equal(body.history.length, 2);

  assert.deepEqual(events.map(event => event.type), ['RUN_STARTED', 'RUN_FINISHED']);
  assert.equal(result.runId, 'run_9');
  assert.equal(result.text, chinese);
  assert.equal(result.nodes[0].text, chinese);
  assert.deepEqual(result.blocks, []);
  assert.equal(result.eventCount, 2);
});

test('a 429 turn_limit body becomes a typed error with its code, message and limit', async () => {
  const { events, onEvent } = collector();
  await assert.rejects(
    streamCoachGenUI({
      connection: { server: 'https://gym.example.com', token: 't' },
      text: 'an eleventh turn',
      onEvent,
      transport: {
        fetch: async () => jsonResponse(429, {
          error: 'This conversation has reached the 10-turn limit. Start a new conversation to continue.',
          code: 'turn_limit',
          limit: 10,
        }),
      },
    }),
    error => {
      assert.equal(error.name, 'CoachStreamError');
      assert.equal(error.code, 'turn_limit');
      assert.equal(error.status, 429);
      assert.equal(error.limit, 10);
      assert.match(error.message, /10-turn limit/);
      return true;
    },
  );
  assert.deepEqual(events, [], 'no event is emitted for a rejected request');
});

test('401, 404 and 503 map onto unauthorized and genui_unavailable', async () => {
  const cases = [
    [401, { error: 'not signed in' }, 'unauthorized', false],
    [404, { error: 'not found' }, 'genui_unavailable', true],
    [503, { error: 'the agent runtime is disabled' }, 'genui_unavailable', true],
  ];
  for (const [status, body, code, fallback] of cases) {
    await assert.rejects(
      streamCoachGenUI({
        connection: { server: 'https://gym.example.com', token: 't' },
        text: 'hello',
        onEvent: () => {},
        transport: { fetch: async () => jsonResponse(status, body) },
      }),
      error => {
        assert.equal(error.code, code, `status ${status}`);
        assert.equal(error.status, status);
        assert.equal(Boolean(error.fallback), fallback, `status ${status} fallback`);
        assert.equal(error.message, body.error);
        return true;
      },
    );
  }
});

test('a RUN_ERROR event rejects after being forwarded to onEvent', async () => {
  const { events, onEvent } = collector();
  const text = frame({ type: 'RUN_STARTED', runId: 'r1' })
    + frame({ type: 'RUN_ERROR', code: 'run_cancelled', message: 'the run was cancelled' });

  await assert.rejects(
    streamCoachGenUI({
      connection: { server: 'https://gym.example.com', token: 't' },
      text: 'hello',
      onEvent,
      transport: { fetch: async () => streamResponse(byteChunks(text, 11)) },
    }),
    error => error.code === 'run_cancelled' && error.message === 'the run was cancelled',
  );
  assert.deepEqual(events.map(event => event.type), ['RUN_STARTED', 'RUN_ERROR']);
});

/* ------------------------------ XHR fallback ------------------------------ */

test('streamCoachGenUI falls back to XHR onprogress when the body has no reader', async () => {
  const chinese = '先把顶组多加一次，两周后再看趋势。';
  const frames = [
    frame({ type: 'RUN_STARTED', runId: 'run_x', threadId: 'thread_x' }, '\r\n\r\n'),
    ': ping\n\n',
    frame({ type: 'STEP_STARTED', stepName: 'compose', label: '正在总结' }),
    frame({ type: 'RUN_FINISHED', runId: 'run_x', text: chinese, nodes: [{ id: 'p2', type: 'prose', text: chinese }], blocks: [] }),
  ].join('');
  // Slice mid-frame and mid-character so the fallback proves incremental parsing.
  const xhr = fakeXhr({ chunks: [frames.slice(0, 37), frames.slice(37, 120), frames.slice(120)] });
  const { events, onEvent } = collector();
  let created = 0;

  const result = await streamCoachGenUI({
    connection: { server: 'https://gym.example.com/' , token: 'pair-token' },
    text: '给点建议',
    onEvent,
    transport: {
      fetch: async () => jsonResponse(200, ''),
      createXhr: () => {
        created += 1;
        return xhr;
      },
    },
  });

  assert.equal(created, 1);
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.url, 'https://gym.example.com/api/agent/coach/stream');
  assert.equal(xhr.headers.Authorization, 'Bearer pair-token');
  assert.equal(xhr.headers.Accept, 'text/event-stream');
  assert.equal(JSON.parse(xhr.body).text, '给点建议');
  assert.ok(xhr.progressCalls >= 2, `expected incremental progress, got ${xhr.progressCalls}`);
  assert.deepEqual(events.map(event => event.type), ['RUN_STARTED', 'STEP_STARTED', 'RUN_FINISHED']);
  assert.equal(result.text, chinese);
  assert.equal(result.nodes[0].text, chinese);
});

test('the XHR fallback surfaces a 429 turn_limit instead of streaming an error page', async () => {
  const xhr = fakeXhr({
    status: 429,
    chunks: [JSON.stringify({ error: 'too many turns', code: 'turn_limit', limit: 10 })],
  });

  await assert.rejects(
    streamCoachGenUI({
      connection: { server: 'https://gym.example.com', token: 't' },
      text: 'hello',
      onEvent: () => {},
      transport: {
        fetch: async () => jsonResponse(200, ''),
        createXhr: () => xhr,
      },
    }),
    error => error.code === 'turn_limit' && error.status === 429 && error.limit === 10,
  );
});

/* -------------------------------- aborts ---------------------------------- */

test('AbortSignal cancels the expo/fetch reader path with an AbortError', async () => {
  const firstFrame = frame({ type: 'RUN_STARTED', runId: 'run_abort' });
  const controller = new AbortController();
  let firstEvent;
  const seenFirst = new Promise(resolve => {
    firstEvent = resolve;
  });

  const run = streamCoachGenUI({
    connection: { server: 'https://gym.example.com', token: 't' },
    text: 'hello',
    signal: controller.signal,
    onEvent: event => firstEvent(event),
    transport: { fetch: async () => hangingResponse(encoder.encode(firstFrame)) },
  }).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error }),
  );

  await seenFirst;
  controller.abort();
  const outcome = await run;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.name, 'AbortError');
  assert.equal(outcome.error.code, 'aborted');
});

test('AbortSignal aborts the XHR fallback through xhr.abort()', async () => {
  const firstFrame = frame({ type: 'RUN_STARTED', runId: 'run_abort_xhr' });
  // Two chunks, but the fake stops after the first so the stream stays open until abort.
  const xhr = fakeXhr({ chunks: [firstFrame, frame({ type: 'RUN_FINISHED', text: 'never' })], hangAfter: 1 });
  const controller = new AbortController();
  let firstEvent;
  const seenFirst = new Promise(resolve => {
    firstEvent = resolve;
  });

  const run = streamCoachGenUI({
    connection: { server: 'https://gym.example.com', token: 't' },
    text: 'hello',
    signal: controller.signal,
    onEvent: event => firstEvent(event),
    transport: {
      fetch: async () => jsonResponse(200, ''),
      createXhr: () => xhr,
    },
  }).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error }),
  );

  await seenFirst;
  controller.abort();
  const outcome = await run;

  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.code, 'aborted');
  assert.equal(xhr.aborted, true);
});

test('an already-aborted signal rejects before any transport call', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;

  await assert.rejects(
    streamCoachGenUI({
      connection: { server: 'https://gym.example.com', token: 't' },
      text: 'hello',
      signal: controller.signal,
      onEvent: () => {},
      transport: {
        fetch: async () => {
          called = true;
          return jsonResponse(200, '');
        },
      },
    }),
    error => error.code === 'aborted',
  );
  assert.equal(called, false);
});

/* ------------------------------ GET /api/config --------------------------- */

test('fetchCoachConfig reads the agent and coach flags with the Bearer token', async () => {
  const calls = [];
  const result = await fetchCoachConfig(
    { server: 'https://gym.example.com//', token: 'pair-token' },
    {
      transport: {
        fetch: async (url, init) => {
          calls.push({ url, init });
          return jsonResponse(200, {
            invite_only: false,
            agent: { enabled: true, exerciseSearchVersion: 'v2' },
            coach: { enabled: true, provider: 'fixture' },
          });
        },
      },
    },
  );

  assert.equal(calls[0].url, 'https://gym.example.com/api/config');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer pair-token');
  assert.deepEqual(result, { agentEnabled: true, exerciseSearchVersion: 'v2', coachEnabled: true });

  const anonymous = await fetchCoachConfig(
    { server: 'https://gym.example.com', token: 'expired' },
    { transport: { fetch: async () => jsonResponse(200, { invite_only: false }) } },
  );
  assert.deepEqual(anonymous, { agentEnabled: false, exerciseSearchVersion: 'v1', coachEnabled: false });
});

test('fetchCoachConfig maps a 401 to unauthorized', async () => {
  await assert.rejects(
    fetchCoachConfig(
      { server: 'https://gym.example.com', token: 'expired' },
      { transport: { fetch: async () => jsonResponse(401, { error: 'not signed in' }) } },
    ),
    error => error.code === 'unauthorized' && error.status === 401,
  );
});
