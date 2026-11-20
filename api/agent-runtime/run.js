/* The shared run orchestrator.
 *
 * bind scope -> validate config and input -> read required facts -> assemble
 * the model input -> run model/tool rounds -> validate the output/proposal ->
 * save a terminal state. No host platform import lives in this file.
 */
import { AgentError } from './errors.js';
import {
  withRunDefaults,
  validRequestId,
  validTaskId,
} from './contracts.js';
import {
  addEvidence,
  evidenceList,
  resolveEvidence,
  trimContext,
} from './context.js';
import { createDispatcher, createToolRegistry } from './tools.js';
import { assertCapabilities } from './model-gateway.js';
import { projectMemories } from './memory.js';
import { assertValid } from './schema.js';

const DEFAULT_INSTRUCTIONS = [
  'You are running inside the openGym agent runtime.',
  'Use only the facts, memories and tool results supplied in this request.',
  'Cite evidence ids when a result depends on a fact.',
  'Never invent an object id or a tool name.',
  'When a business change is needed, return a proposal instead of changing data yourself.',
].join('\n');

function assertRequest(task, request) {
  if (!request || typeof request !== 'object') throw new AgentError('invalid_request', 'run request is required');
  if (!validTaskId(request.taskId)) throw new AgentError('invalid_request', 'taskId is invalid');
  if (task && request.taskId !== task.id) {
    throw new AgentError('invalid_request', 'taskId does not match the registered task', {
      details: { expected: task.id, received: request.taskId },
    });
  }
  if (!validRequestId(request.requestId)) throw new AgentError('invalid_request', 'requestId is invalid');
  if (!request.profileId || typeof request.profileId !== 'string') {
    throw new AgentError('invalid_request', 'profileId is required');
  }
  if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw new AgentError('invalid_request', 'input must be an object');
  }
}

async function resolveTargets(task, input, context) {
  if (typeof task.targetScope !== 'function') {
    throw new AgentError('invalid_request', `task ${task.id} has no targetScope`);
  }
  const raw = await task.targetScope(input, context);
  if (!Array.isArray(raw)) throw new AgentError('invalid_request', 'targetScope must return an array');
  const ids = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !id) throw new AgentError('invalid_request', 'targetScope must contain ids');
    ids.push(id);
  }
  context.targetScope = new Set(ids);
  return ids;
}

async function readFacts(task, input, context) {
  if (typeof task.readFacts !== 'function') return;
  const result = await task.readFacts(input, context);
  let facts = result;
  if (result && !Array.isArray(result) && Array.isArray(result.facts)) {
    if (Array.isArray(result.missing) && result.missing.length) {
      throw new AgentError('fact_missing', 'a required fact is missing', { details: { missing: result.missing } });
    }
    facts = result.facts;
  }
  if (facts == null) return;
  if (!Array.isArray(facts)) throw new AgentError('invalid_request', 'readFacts must return an array');
  for (const fact of facts) {
    if (!fact || typeof fact !== 'object') throw new AgentError('invalid_request', 'a fact must be an object');
    if (fact.content === undefined || fact.content === null) {
      throw new AgentError('fact_missing', 'a required fact has no content', {
        details: { objectId: fact.objectId, source: fact.source },
      });
    }
    addEvidence(context, fact);
  }
}

function evidenceFacts(context) {
  return [...context.evidence.values()].map(item => ({
    evidenceId: item.evidenceId,
    source: item.source,
    objectId: item.objectId,
    ...(item.version === undefined ? {} : { version: item.version }),
    content: item.content,
  }));
}

function modelStepOf(task) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  return steps.find(step => step && step.id === 'model')
    || steps.find(step => step && Array.isArray(step.tools))
    || steps[0]
    || { id: 'model' };
}

function outputOf(output, task, context) {
  let parsed;
  if (typeof task.parseOutput === 'function') {
    parsed = task.parseOutput(output, context);
  } else if (output.structured !== null && output.structured !== undefined) {
    parsed = output.structured;
  } else if (task.outputSchema && (task.outputSchema.type === 'object' || task.outputSchema.properties)) {
    parsed = { text: output.text || '' };
  } else {
    parsed = output.text || '';
  }
  if (task.outputSchema) assertValid(task.outputSchema, parsed, '$', 'invalid_request');
  return parsed;
}

function proposalCandidate(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.proposal && typeof parsed.proposal === 'object' && !Array.isArray(parsed.proposal)) return parsed.proposal;
  if (parsed.kind === 'proposal' && Array.isArray(parsed.changes)) return parsed;
  return null;
}

/**
 * @param {{
 *   task: import('./contracts.js').TaskDefinition,
 *   request: import('./contracts.js').RunRequest,
 *   context: import('./contracts.js').RunContext,
 *   gateway: import('./contracts.js').ModelGateway,
 *   tools?: import('./contracts.js').ToolDefinition[] | ReturnType<typeof createToolRegistry>,
 *   proposals?: import('./contracts.js').ProposalService,
 *   state?: import('./contracts.js').RunState,
 *   store?: { saveResult?: (result: unknown) => unknown },
 *   signal?: AbortSignal | null,
 *   now?: () => number,
 * }} options
 */
export async function runAgent(options) {
  const {
    task,
    request,
    context,
    gateway,
    tools = [],
    proposals,
    state,
    store,
    signal = context?.signal || null,
    now = Date.now,
  } = options || {};
  if (!task || typeof task !== 'object') throw new AgentError('invalid_request', 'a registered task is required');
  if (!context) throw new AgentError('invalid_request', 'a bound run context is required');
  if (!gateway || typeof gateway.invoke !== 'function') {
    throw new AgentError('invalid_request', 'a model gateway is required');
  }
  const budgets = withRunDefaults(task.budgets);
  const executor = tools && typeof tools.get === 'function' && typeof tools.list === 'function'
    ? tools
    : createToolRegistry(tools);
  const completedOrCancelled = result => {
    if (store && typeof store.saveResult === 'function') {
      try { store.saveResult(result); } catch { /* the host persists the run itself */ }
    }
    return result;
  };

  try {
    assertRequest(task, request);
    if (context.request) {
      if (context.request.requestId !== request.requestId || context.request.profileId !== request.profileId) {
        throw new AgentError('invalid_request', 'run context belongs to another request');
      }
    }
    if (state && state.isTerminal()) return completedOrCancelled(state.record());
    if (signal?.aborted) {
      if (state) state.cancel('cancelled before the run started');
      return completedOrCancelled(state ? state.record() : { runId: context.runId, status: 'cancelled' });
    }
    if (task.inputSchema) assertValid(task.inputSchema, request.input, '$.input', 'invalid_request');
    await resolveTargets(task, request.input, context);
    if (context.profileRef?.capabilities && task.requiredCapabilities) {
      assertCapabilities(context.profileRef, task.requiredCapabilities);
    }
    if (state) state.start();
    await readFacts(task, request.input, context);

    const step = modelStepOf(task);
    const allowedToolIds = Array.isArray(step.tools) ? step.tools : [];
    const dispatcher = createDispatcher({
      registry: executor,
      context,
      allowedToolIds,
      maxCalls: step.maxToolCalls ?? budgets.toolCalls,
      signal,
    });
    const attachments = Array.isArray(context.meta.attachments) ? context.meta.attachments : [];
    const history = [...(context.history || [])];
    const memories = projectMemories(context.memories || []);
    const toolResults = [];
    let rounds = 0;
    let lastOutput = null;

    for (let round = 0; round < budgets.rounds; round++) {
      if (signal?.aborted) {
        if (state && !state.isTerminal()) state.cancel('cancelled');
        return completedOrCancelled(state ? state.record() : { runId: context.runId, status: 'cancelled' });
      }
      if (context.deadline && now() > context.deadline) {
        throw new AgentError('model_timeout', 'the run deadline passed');
      }
      rounds++;
      const modelInput = trimContext({
        instructions: typeof task.instructions === 'function'
          ? task.instructions(request.input, context)
          : (task.instructions || DEFAULT_INSTRUCTIONS),
        user: {
          text: typeof task.userText === 'function'
            ? task.userText(request.input, context)
            : String(request.input.prompt || ''),
          ...(typeof task.fixtureCase === 'function' && task.fixtureCase(request.input)
            ? { fixtureCase: task.fixtureCase(request.input) }
            : {}),
          ...(attachments.length ? { attachments } : {}),
        },
        facts: evidenceFacts(context),
        memories,
        history,
        tools: dispatcher.list(),
        toolResults: [...toolResults],
      }, budgets);

      lastOutput = await gateway.invoke(context.profileRef, modelInput, signal);
      // Cancellation may land while the provider is answering; the answer is
      // data now, not permission to call a tool or create a proposal.
      if (signal?.aborted || (state && !state.acceptResult())) {
        if (state && !state.isTerminal()) state.cancel('cancelled');
        return completedOrCancelled(state ? state.record() : { runId: context.runId, status: 'cancelled' });
      }
      const calls = Array.isArray(lastOutput.toolCalls) ? lastOutput.toolCalls : [];
      if (!calls.length) break;
      if (round === budgets.rounds - 1) {
        throw new AgentError('invalid_request', 'the model kept calling tools after the round budget');
      }
      for (const call of calls) {
        if (signal?.aborted || (state && !state.acceptResult())) {
          if (state && !state.isTerminal()) state.cancel('cancelled');
          return completedOrCancelled(state ? state.record() : { runId: context.runId, status: 'cancelled' });
        }
        const executed = await dispatcher.call(call.name, call.arguments, { callId: call.id });
        let evidenceId;
        const result = executed.result;
        if (result && typeof result === 'object' && typeof result.objectId === 'string' && result.content !== undefined) {
          const evidence = addEvidence(context, {
            source: `tool:${call.name}`,
            objectId: result.objectId,
            version: result.version,
            content: result.content,
          });
          evidenceId = evidence.evidenceId;
        }
        toolResults.push({
          toolId: call.name,
          callId: call.id,
          result,
          ...(evidenceId ? { evidenceId } : {}),
        });
      }
    }

    if (!lastOutput) throw new AgentError('model_unavailable', 'the model returned no answer');
    const parsed = outputOf(lastOutput, task, context);
    const candidate = proposalCandidate(parsed);
    let proposal;
    if (candidate) {
      if (!proposals || typeof proposals.create !== 'function') {
        throw new AgentError('invalid_request', 'this task produced a proposal but no proposal service is configured');
      }
      const targetId = candidate.targetId || candidate.objectId;
      if (typeof targetId !== 'string' || !context.targetScope.has(targetId)) {
        throw new AgentError('scope_denied', 'the proposal targets an object outside this task', {
          details: { targetId },
        });
      }
      if (candidate.targetVersion === undefined) {
        throw new AgentError('invalid_request', 'a proposal needs the target version it was generated from');
      }
      const known = [...context.evidence.values()].filter(item => item.objectId === targetId);
      if (known.length) {
        const versions = new Set(known.map(item => String(item.version)));
        if (!versions.has(String(candidate.targetVersion))) {
          throw new AgentError('fact_missing', 'the proposal version was not in this run', {
            details: { targetId, targetVersion: candidate.targetVersion },
          });
        }
      }
      if (!Array.isArray(candidate.changes)) {
        throw new AgentError('invalid_request', 'a proposal needs a changes array');
      }
      if (signal?.aborted || (state && !state.acceptResult())) {
        if (state && !state.isTerminal()) state.cancel('cancelled');
        return completedOrCancelled(state ? state.record() : { runId: context.runId, status: 'cancelled' });
      }
      proposal = await proposals.create({
        runId: context.runId,
        kind: String(candidate.kind || 'stub.write'),
        changes: candidate.changes,
        targetScope: [targetId],
        targetVersion: candidate.targetVersion,
      });
    }

    const result = {
      runId: context.runId,
      status: 'completed',
      ...(typeof parsed === 'string'
        ? { text: parsed }
        : {
            ...(typeof parsed?.text === 'string' ? { text: parsed.text } : {}),
            structured: parsed,
          }),
      ...(proposal ? { proposal } : {}),
      evidence: evidenceList(context),
      usage: { rounds, toolCalls: dispatcher.calls },
    };
    if (state) {
      if (!state.acceptResult()) {
        return completedOrCancelled(state.record());
      }
      state.completed(result);
      return completedOrCancelled(state.record());
    }
    return completedOrCancelled(result);
  } catch (error) {
    const cancelled = signal?.aborted || (state && state.status() === 'cancelled');
    if (cancelled) {
      if (state && !state.isTerminal()) state.cancel('cancelled');
      return completedOrCancelled(state ? state.record() : { runId: context.runId, status: 'cancelled' });
    }
    if (state && !state.isTerminal()) {
      const code = error instanceof AgentError ? error.code : 'model_unavailable';
      state.failed({ code, message: error instanceof Error ? error.message : 'run failed' });
    }
    throw error;
  }
}

export { resolveEvidence };
