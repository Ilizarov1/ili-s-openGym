import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentError,
  bindContext,
  addEvidence,
  resolveEvidence,
  trimContext,
  contextChars,
  createDispatcher,
  createToolRegistry,
  createProposalService,
  createMemoryProposalStore,
  createRunState,
  createMemoryStore,
  selectMemories,
  projectMemories,
  createMemoryProposal,
  createMemoryProposalAdapter,
  runAgent,
  withRunDefaults,
} from '../agent-runtime/index.js';
import { fixtureModel, TARGETS, WORKSPACES, PNG_1X1_DATA_URL } from './agent-fixtures.mjs';

const ids = (() => {
  let n = 0;
  return {
    evidence: () => `ev_test_${++n}`,
    proposal: () => `prop_test_${++n}`,
    run: () => `run_test_${++n}`,
  };
})();

function profile(capabilities = { text: true, image: true, tools: true }) {
  return { profileId: 'profile-1', version: 1, provider: 'fixture', capabilities };
}

function contextFor(over = {}) {
  return bindContext({
    scope: WORKSPACES.serverOwner,
    runId: ids.run(),
    request: { requestId: 'req_12345678', profileId: 'profile-1', taskId: 'stub.v1' },
    execution: 'server',
    profileRef: profile(),
    targetScope: ['target-1', 'target-2'],
    ids,
    ...over,
  });
}

function recordFor(context) {
  return {
    runId: context.runId,
    requestId: 'req_12345678',
    taskId: 'stub.v1',
    profileId: 'profile-1',
    scope: context.scope,
    execution: 'server',
    status: 'accepted',
    createdAt: 1,
  };
}

function targetTool(executed) {
  return {
    id: 'get_stub_fact',
    description: 'Read one stub target.',
    argsSchema: {
      type: 'object',
      properties: { id: { type: 'string', minLength: 1 } },
      required: ['id'],
      additionalProperties: false,
    },
    resultSchema: {
      type: 'object',
      properties: {
        objectId: { type: 'string' },
        version: { type: 'integer' },
        content: { type: 'object' },
      },
      required: ['objectId', 'version', 'content'],
    },
    target: args => args.id,
    async run(args) {
      executed.push(args.id);
      return { objectId: args.id, version: 1, content: { value: TARGETS[args.id]?.value ?? 'x' } };
    },
  };
}

function stubTask(over = {}) {
  return {
    id: 'stub.v1',
    version: 1,
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', minLength: 1 } },
      required: ['prompt'],
      additionalProperties: true,
    },
    outputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, proposal: { type: 'object' } },
      additionalProperties: true,
    },
    requiredCapabilities: ['text'],
    budgets: { rounds: 2, toolCalls: 2, contextChars: 20000, historyItems: 2, memoryItems: 2 },
    steps: [{ id: 'read_facts' }, { id: 'model', tools: ['get_stub_fact'] }],
    targetScope: () => ['target-1', 'target-2'],
    readFacts: () => [{
      source: 'stub',
      objectId: 'target-1',
      version: 1,
      content: { value: TARGETS['target-1'].value },
    }],
    instructions: () => 'test instructions',
    userText: input => input.prompt,
    fixtureCase: input => input.fixtureCase,
    ...over,
  };
}

test('bindContext rejects evidence outside the task scope', () => {
  const context = contextFor();
  assert.throws(
    () => addEvidence(context, { source: 'stub', objectId: 'target-foreign', content: {} }),
    error => error instanceof AgentError && error.code === 'scope_denied',
  );
});

test('trimContext keeps instructions, input and facts, and trims optional history first', () => {
  const input = {
    instructions: 'system',
    user: { text: 'current' },
    facts: [{ evidenceId: 'ev_1', source: 'x', objectId: 'target-1', content: { value: 'fact' } }],
    memories: Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, value: 'memory '.repeat(40) })),
    history: Array.from({ length: 6 }, (_, i) => ({ id: `h${i}`, role: 'user', content: 'history '.repeat(30) })),
    tools: [],
    toolResults: [],
  };
  const trimmed = trimContext(input, { contextChars: 900, historyItems: 6, memoryItems: 4 });
  assert.equal(trimmed.instructions, 'system');
  assert.equal(trimmed.facts.length, 1);
  assert.ok(trimmed.history.length < input.history.length);
  assert.ok(JSON.stringify(trimmed).length <= 900);

  assert.throws(
    () => trimContext({ ...input, facts: [{ evidenceId: 'e', content: 'x'.repeat(5000) }] }, { contextChars: 200 }),
    error => error instanceof AgentError && error.code === 'context_budget_exceeded',
  );
});

test('image payloads use the media budget, not the text context budget', () => {
  const input = {
    instructions: 'system',
    user: {
      text: 'look',
      attachments: [{
        id: 'img_1',
        kind: 'image',
        mime: 'image/png',
        name: 'large.png',
        size: 512 * 1024,
        dataUrl: `data:image/png;base64,${'A'.repeat(700 * 1024)}`,
      }],
    },
    facts: [],
    memories: [],
    history: [],
    tools: [],
    toolResults: [],
  };
  const trimmed = trimContext(input, { contextChars: 900, attachmentBytes: 2 * 1024 * 1024 });
  assert.equal(trimmed.user.attachments.length, 1);
  assert.equal(trimmed.user.attachments[0].dataUrl, input.user.attachments[0].dataUrl);
  assert.ok(contextChars(trimmed) <= 900, `text budget was ${contextChars(trimmed)}`);

  assert.throws(
    () => trimContext(input, { contextChars: 24000, attachmentBytes: 400 * 1024 }),
    error => error instanceof AgentError && error.code === 'context_budget_exceeded',
  );
});

test('a missing fact is a stable error before the model is called', async () => {
  const context = contextFor();
  let modeled = 0;
  await assert.rejects(
    runAgent({
      task: stubTask({ readFacts: () => ({ facts: [], missing: ['target-9'] }) }),
      request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'hi' } },
      context,
      gateway: { async invoke() { modeled++; return { text: 'x', toolCalls: [] }; } },
      tools: [],
      state: createRunState(recordFor(context)),
    }),
    error => error instanceof AgentError && error.code === 'fact_missing',
  );
  assert.equal(modeled, 0);
});

test('the tool fence refuses four classes without executing the tool', async () => {
  const executed = [];
  const registry = createToolRegistry([targetTool(executed)]);
  const context = contextFor();

  const notAllowed = createDispatcher({ registry, context, allowedToolIds: [], maxCalls: 2 });
  await assert.rejects(
    notAllowed.call('get_stub_fact', { id: 'target-1' }),
    error => error.code === 'tool_not_allowed',
  );

  const badArgs = createDispatcher({ registry, context, allowedToolIds: ['get_stub_fact'], maxCalls: 2 });
  await assert.rejects(
    badArgs.call('get_stub_fact', { id: 'target-1', extra: true }),
    error => error.code === 'tool_args_invalid',
  );

  const outOfScope = createDispatcher({ registry, context, allowedToolIds: ['get_stub_fact'], maxCalls: 2 });
  await assert.rejects(
    outOfScope.call('get_stub_fact', { id: 'target-foreign' }),
    error => error.code === 'tool_target_out_of_scope',
  );

  const budget = createDispatcher({ registry, context, allowedToolIds: ['get_stub_fact'], maxCalls: 0 });
  await assert.rejects(
    budget.call('get_stub_fact', { id: 'target-1' }),
    error => error.code === 'tool_budget_exceeded',
  );
  assert.deepEqual(executed, []);
  assert.equal(notAllowed.calls + badArgs.calls + outOfScope.calls + budget.calls, 0);

  // The argument schema is checked before the call budget, per DESIGN §4.
  const budgetWithBadArgs = createDispatcher({ registry, context, allowedToolIds: ['get_stub_fact'], maxCalls: 0 });
  await assert.rejects(
    budgetWithBadArgs.call('get_stub_fact', { id: 'target-1', extra: true }),
    error => error.code === 'tool_args_invalid',
  );
  assert.deepEqual(executed, []);

  const allowed = createDispatcher({ registry, context, allowedToolIds: ['get_stub_fact'], maxCalls: 2 });
  const result = await allowed.call('get_stub_fact', { id: 'target-1' });
  assert.equal(result.result.objectId, 'target-1');
  assert.deepEqual(executed, ['target-1']);
});

test('a proposal is immutable until confirmed, applied once, and refused after a version change', async () => {
  const store = createMemoryProposalStore();
  const writes = [];
  let targetVersion = 1;
  const service = createProposalService({
    store,
    ids,
    now: () => 1000,
    adapter: {
      apply({ proposal }) {
        if (proposal.targetVersion !== targetVersion) throw new AgentError('proposal_conflict');
        writes.push(proposal.proposalId);
        return { applied: proposal.proposalId };
      },
    },
  });
  const proposal = await service.create({
    kind: 'stub.write',
    changes: [{ field: 'value', value: 'new' }],
    targetScope: ['target-1'],
    targetVersion: 1,
  });
  assert.equal(writes.length, 0, 'creating does not write');
  assert.throws(() => { proposal.status = 'consumed'; }, TypeError);

  const [first, second] = await Promise.all([service.confirm(proposal.proposalId), service.confirm(proposal.proposalId)]);
  assert.equal(writes.length, 1, 'concurrent confirmation writes once');
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.deepEqual(second.result, first.result);

  targetVersion = 2;
  const stale = await service.create({
    kind: 'stub.write',
    changes: [{ field: 'value', value: 'later' }],
    targetScope: ['target-1'],
    targetVersion: 1,
  });
  await assert.rejects(
    service.confirm(stale.proposalId),
    error => error.code === 'proposal_conflict',
  );
  assert.equal(writes.length, 1);
});

test('run states write a terminal status once and discard a late answer', () => {
  const state = createRunState({
    runId: 'run_test_state',
    requestId: 'req_12345678',
    taskId: 'stub.v1',
    profileId: 'profile-1',
    scope: WORKSPACES.serverOwner,
    execution: 'server',
    status: 'accepted',
    createdAt: 1,
  }, { now: () => 10 });
  state.start();
  state.cancel('user cancelled');
  assert.equal(state.status(), 'cancelled');
  assert.equal(state.acceptResult(), false);
  assert.throws(() => state.completed({}), error => error.code === 'run_terminal');
});

test('a cancelled run ignores a late model answer and creates no proposal', async () => {
  const context = contextFor();
  const controller = new AbortController();
  const store = createMemoryProposalStore();
  let proposals = 0;
  const state = createRunState(recordFor(context));
  const service = createProposalService({ store, ids, adapter: { apply: () => ({}) } });
  const resultPromise = runAgent({
    task: stubTask(),
    request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'late', fixtureCase: 'late' } },
    context,
    gateway: {
      async invoke() {
        await new Promise(resolve => setTimeout(resolve, 40));
        return fixtureModel('proposal');
      },
    },
    tools: [],
    proposals: {
      async create(input) {
        proposals++;
        return service.create(input);
      },
    },
    state,
    signal: controller.signal,
  });
  setTimeout(() => {
    state.cancel('user cancelled');
    controller.abort();
  }, 5);
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(proposals, 0);
  assert.equal(store.all().length, 0);
});

test('a cancellation during proposal save discards the proposal', async () => {
  const context = contextFor();
  const controller = new AbortController();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let discarded = 0;
  const state = createRunState(recordFor(context));
  const resultPromise = runAgent({
    task: stubTask(),
    request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'save', fixtureCase: 'proposal' } },
    context,
    gateway: {
      async invoke() {
        return fixtureModel('proposal');
      },
    },
    tools: [],
    proposals: {
      async create(input) {
        await gate;
        return { proposalId: 'prop_race', ...input, status: 'pending', createdAt: 1 };
      },
      async discard(proposalId) {
        discarded++;
        assert.equal(proposalId, 'prop_race');
      },
    },
    state,
    signal: controller.signal,
  });
  setTimeout(() => {
    state.cancel('user cancelled');
    controller.abort();
  }, 5);
  setTimeout(() => release(), 30);
  const result = await resultPromise;
  assert.equal(result.status, 'cancelled');
  assert.equal(discarded, 1);
});

test('a proposal with no changes is refused before it is stored', async () => {
  const context = contextFor();
  const state = createRunState(recordFor(context));
  let stored = 0;
  await assert.rejects(
    runAgent({
      task: stubTask(),
      request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'empty' } },
      context,
      gateway: {
        async invoke() {
          return { structured: { proposal: { kind: 'stub.write', targetId: 'target-1', targetVersion: 1, changes: [] } } };
        },
      },
      tools: [],
      proposals: {
        async create(input) { stored++; return { proposalId: 'p', ...input, status: 'pending', createdAt: 1 }; },
      },
      state,
    }),
    error => error instanceof AgentError && error.code === 'invalid_request',
  );
  assert.equal(stored, 0);
  assert.equal(state.status(), 'failed');
});

test('a model memory proposal is stored against the run scope', async () => {
  const context = contextFor();
  const state = createRunState(recordFor(context));
  let stored = null;
  const result = await runAgent({
    task: stubTask(),
    request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'remember' } },
    context,
    gateway: {
      async invoke() {
        return {
          structured: {
            proposal: {
              kind: 'memory.save',
              changes: [{ op: 'save', category: 'preference', value: { likes: 'morning' } }],
            },
          },
        };
      },
    },
    tools: [],
    proposals: {
      async create(input) {
        stored = input;
        return { proposalId: 'prop_memory', ...input, status: 'pending', createdAt: 1 };
      },
    },
    state,
  });
  assert.equal(result.status, 'completed');
  assert.equal(stored.kind, 'memory.save');
  assert.deepEqual(stored.targetScope, [context.scope]);
  assert.equal(stored.targetVersion, undefined);
});

test('memory selection is scoped, ordered and deletion leaves the next context', () => {
  const memories = [
    { id: 'm1', scope: 'scope-a', category: 'preference', value: { like: 'morning' }, updatedAt: 10, version: 1 },
    { id: 'm2', scope: 'scope-b', category: 'preference', value: { like: 'evening' }, updatedAt: 20, version: 1 },
    { id: 'm3', scope: 'scope-a', category: 'goal', value: { goal: 'bench 100' }, updatedAt: 30, version: 1 },
    { id: 'm4', category: 'preference', value: { like: 'unscoped' }, updatedAt: 40, version: 1 },
  ];
  const selected = selectMemories(memories, { scope: 'scope-a', limit: 8 });
  assert.deepEqual(selected.map(item => item.id), ['m3', 'm1']);
  const projected = projectMemories(selected);
  assert.deepEqual(projected.map(item => item.id), ['m3', 'm1']);

  // A record without a scope never passes a scope filter: fail closed.
  assert.equal(selectMemories(memories, { scope: 'scope-a' }).some(item => item.id === 'm4'), false);
  // The task's kind filter and item budget are applied together.
  assert.deepEqual(
    selectMemories(memories, { scope: 'scope-a', kinds: ['goal'], limit: 1 }).map(item => item.id),
    ['m3'],
  );
  // Without a scope filter the host still sees its own pre-filtered list.
  assert.deepEqual(selectMemories([memories[3]]).map(item => item.id), ['m4']);

  const store = createMemoryStore([], () => 1);
  const memory = store.create({ scope: 'scope-a', category: 'preference', value: { token: 'secret', like: 'morning' }, source: 'user' });
  assert.deepEqual(projectMemories([memory])[0].value, { like: 'morning' });
  store.delete(memory.id);
  assert.equal(selectMemories(store.list(), { scope: 'scope-a' }).length, 0);
});

test('a memory proposal goes through the same fence', async () => {
  const memoryStore = createMemoryStore([], () => 5);
  const proposalStore = createMemoryProposalStore();
  const service = createProposalService({
    store: proposalStore,
    ids,
    now: () => 5,
    adapter: createMemoryProposalAdapter(memoryStore),
  });
  const draft = createMemoryProposal({
    ids,
    scope: 'scope-a',
    memory: { category: 'preference', value: { like: 'morning' }, source: 'user' },
    now: () => 5,
  });
  const proposal = await service.create(draft);
  assert.equal(memoryStore.list().length, 0);
  await service.confirm(proposal.proposalId);
  assert.equal(memoryStore.list().length, 1);
  await service.confirm(proposal.proposalId);
  assert.equal(memoryStore.list().length, 1);
});

test('runAgent completes a text task and records evidence', async () => {
  const context = contextFor();
  const state = createRunState(recordFor(context));
  const result = await runAgent({
    task: stubTask(),
    request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'hello' } },
    context,
    gateway: { async invoke() { return { text: 'hello back', toolCalls: [] }; } },
    tools: [],
    state,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.result.text, 'hello back');
  assert.equal(result.result.evidence.length, 1);
  assert.equal(resolveEvidence(context, result.result.evidence[0].evidenceId).objectId, 'target-1');
});

test('runAgent executes an allowed tool and keeps its evidence', async () => {
  const context = contextFor();
  const executed = [];
  const result = await runAgent({
    task: stubTask(),
    request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'tool' } },
    context,
    gateway: {
      async invoke(_profile, modelInput) {
        return modelInput.toolResults.length
          ? { text: 'done', toolCalls: [] }
          : fixtureModel('tool', { arguments: { id: 'target-1' } });
      },
    },
    tools: [targetTool(executed)],
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(executed, ['target-1']);
  assert.equal(result.usage.toolCalls, 1);
});

test('runAgent turns a structured output into a stored proposal', async () => {
  const context = contextFor();
  const store = createMemoryProposalStore();
  const service = createProposalService({ store, ids, adapter: { apply: () => ({ ok: true }) } });
  const result = await runAgent({
    task: stubTask(),
    request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'propose' } },
    context,
    gateway: { async invoke() { return fixtureModel('proposal'); } },
    tools: [],
    proposals: service,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.proposal.kind, 'stub.write');
  assert.equal(store.all().length, 1);
});

test('withRunDefaults rejects negative budgets and fills the defaults', () => {
  assert.equal(withRunDefaults({ rounds: 1 }).rounds, 1);
  assert.throws(() => withRunDefaults({ rounds: -1 }));
});

test('the fixture carries a real 1x1 PNG', () => {
  assert.match(PNG_1X1_DATA_URL, /^data:image\/png;base64,/);
  assert.ok(PNG_1X1_DATA_URL.length > 40);
});

test('a task attachment hook takes over host attachments, including an empty array', async () => {
  let seen = null;
  const attachment = {
    id: 'task-image',
    kind: 'image',
    mime: 'image/png',
    name: 'task.png',
    size: 10,
    dataUrl: PNG_1X1_DATA_URL,
  };
  const context = contextFor({ meta: { attachments: [{ ...attachment, id: 'host-image' }] } });
  await runAgent({
    task: stubTask({
      attachments: () => [attachment],
      userText: () => 'with image',
    }),
    request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'with image' } },
    context,
    gateway: {
      async invoke(_profile, modelInput) {
        seen = modelInput.user.attachments;
        return { text: 'ok', toolCalls: [] };
      },
    },
    tools: [],
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 'task-image');

  let empty = null;
  const emptyContext = contextFor({ meta: { attachments: [attachment] } });
  await runAgent({
    task: stubTask({ attachments: () => [] }),
    request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'no image' } },
    context: emptyContext,
    gateway: {
      async invoke(_profile, modelInput) {
        empty = modelInput.user.attachments;
        return { text: 'ok', toolCalls: [] };
      },
    },
    tools: [],
  });
  assert.equal(empty, undefined);
});

test('an empty memoryCategories means no memories at all, not every category', async () => {
  let seen = [];
  const context = contextFor({
    memories: [{ id: 'm1', category: 'preference', value: { unit: 'kg' }, scope: WORKSPACES.serverOwner }],
  });
  await runAgent({
    task: stubTask({ memoryCategories: [] }),
    request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'memory' } },
    context,
    gateway: {
      async invoke(_profile, modelInput) {
        seen = modelInput.memories;
        return { text: 'ok', toolCalls: [] };
      },
    },
    tools: [],
  });
  assert.deepEqual(seen, []);
});

test('validateInput and dynamic capabilities reject before the model is called', async () => {
  let modeled = 0;
  const context = contextFor();
  await assert.rejects(
    runAgent({
      task: stubTask({ validateInput: () => { throw new AgentError('invalid_request', 'nope'); } }),
      request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'hi' } },
      context,
      gateway: { async invoke() { modeled++; return { text: 'x' }; } },
      tools: [],
    }),
    error => error.code === 'invalid_request',
  );
  assert.equal(modeled, 0);

  const imageContext = contextFor({ profileRef: profile({ text: true, image: false, tools: false }) });
  await assert.rejects(
    runAgent({
      task: stubTask({ capabilities: () => ['text', 'image'] }),
      request: { taskId: 'stub.v1', requestId: 'req_12345678', profileId: 'profile-1', input: { prompt: 'photo' } },
      context: imageContext,
      gateway: { async invoke() { modeled++; return { text: 'x' }; } },
      tools: [],
    }),
    error => error.code === 'profile_capability_missing',
  );
  assert.equal(modeled, 0);
});

test('an invalid sessionMode is rejected by the shared orchestrator', async () => {
  await assert.rejects(
    runAgent({
      task: stubTask(),
      request: {
        taskId: 'stub.v1',
        requestId: 'req_12345678',
        profileId: 'profile-1',
        input: { prompt: 'x' },
        sessionMode: 'sideways',
      },
      context: contextFor(),
      gateway: { async invoke() { return { text: 'x' }; } },
      tools: [],
    }),
    error => error.code === 'invalid_request',
  );
});
