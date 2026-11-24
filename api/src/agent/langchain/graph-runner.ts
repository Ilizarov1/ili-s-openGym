/* LangGraph StateGraph server-side Agent orchestrator.
 *
 * Replaces runAgent() on the NestJS host while keeping all external contracts,
 * four-layer tool security fences, Proposal-Confirm HITL, session/memory
 * projection, cancellation race handling, and exercise-search.* diagnostics
 * semantically identical to api/agent-runtime/run.js.
 */
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { Annotation, END, GraphRecursionError, START, StateGraph } from '@langchain/langgraph';
import type {
  AttachmentReference,
  ModelInput,
  ModelOutput,
  ProfileReference,
  Proposal,
  ProposalService,
  RunContext,
  RunRequest,
  RunResult,
  RunState,
  TaskDefinition,
  TaskStep,
  ToolDefinition,
} from '../../../agent-runtime/contracts.js';
import {
  isMemoryCategory,
  isSessionMode,
  validRequestId,
  validTaskId,
  withRunDefaults,
} from '../../../agent-runtime/contracts.js';
import { addEvidence, evidenceList } from '../../../agent-runtime/context.js';
import { AgentError } from '../../../agent-runtime/errors.js';
import { projectMemories } from '../../../agent-runtime/memory.js';
import { assertCapabilities, requiredCapabilitiesFor } from '../../../agent-runtime/model-gateway.js';
import { assertValid } from '../../../agent-runtime/schema.js';
import { createDispatcher, createToolRegistry } from '../../../agent-runtime/tools.js';
import { createExerciseSearchDiagnosticTracker } from './diagnostics-callback.js';
import { extractNestedAgentError, mapLangChainError, sanitizeErrorText } from './errors.js';
import { buildInitialMessages, type ExtractedTokenUsage } from './messages.js';

const DEFAULT_INSTRUCTIONS = [
  'You are running inside the openGym agent runtime.',
  'Use only the facts, memories and tool results supplied in this request.',
  'Cite evidence ids when a result depends on a fact.',
  'Never invent an object id or a tool name.',
  'When a business change is needed, return a proposal instead of changing data yourself.',
].join('\n');

export interface LangChainGatewayInvokeOptions {
  messages: BaseMessage[];
  requiredCapabilities: string[];
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  responseFormat?: 'json';
  fixtureInput?: ModelInput;
  signal?: AbortSignal | null;
  callbacks?: BaseCallbackHandler[];
  timeoutMs?: number;
}

export interface LangChainGatewayInvokeResult {
  message: BaseMessage;
  output: ModelOutput;
  usage: ExtractedTokenUsage;
}

export interface LangChainGateway {
  invokeMessages(
    profileRef: ProfileReference,
    options: LangChainGatewayInvokeOptions,
  ): Promise<LangChainGatewayInvokeResult>;
}

export interface ServerRunResult extends RunResult {
  usage?: {
    rounds: number;
    toolCalls: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

export interface RunServerAgentOptions {
  task: TaskDefinition;
  request: RunRequest;
  context: RunContext;
  gateway: LangChainGateway;
  tools?: ToolDefinition[] | ReturnType<typeof createToolRegistry>;
  proposals?: ProposalService;
  state?: RunState;
  store?: { saveResult?: (result: unknown) => unknown };
  signal?: AbortSignal | null;
  postProcess?: (result: unknown, context: RunContext) => unknown | Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
}

const ServerAgentAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(Array.isArray(right) ? right : [right]),
    default: () => [],
  }),
  rounds: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  toolCalls: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  inputTokens: Annotation<number>({
    reducer: (left, right) => left + right,
    default: () => 0,
  }),
  outputTokens: Annotation<number>({
    reducer: (left, right) => left + right,
    default: () => 0,
  }),
  totalTokens: Annotation<number>({
    reducer: (left, right) => left + right,
    default: () => 0,
  }),
  hasTokenUsage: Annotation<boolean>({
    reducer: (left, right) => left || right,
    default: () => false,
  }),
  lastOutput: Annotation<ModelOutput | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  cancelled: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  finalResult: Annotation<Record<string, unknown> | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
});

type GraphState = typeof ServerAgentAnnotation.State;

function assertRequest(task: TaskDefinition, request: RunRequest): void {
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
  if (request.sessionMode !== undefined && !isSessionMode(request.sessionMode)) {
    throw new AgentError('invalid_request', 'sessionMode must be new or continue');
  }
}

function requiredCapabilities(task: TaskDefinition, input: Record<string, unknown>): string[] {
  if (typeof task.capabilities === 'function') {
    const value = task.capabilities(input);
    if (!Array.isArray(value)) throw new AgentError('invalid_request', 'task capabilities must return an array');
    return value;
  }
  return Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : [];
}

async function resolveTargets(
  task: TaskDefinition,
  input: Record<string, unknown>,
  context: RunContext,
): Promise<string[]> {
  if (typeof task.targetScope !== 'function') {
    throw new AgentError('invalid_request', `task ${task.id} has no targetScope`);
  }
  const raw = await task.targetScope(input, context);
  if (!Array.isArray(raw)) throw new AgentError('invalid_request', 'targetScope must return an array');
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !id) throw new AgentError('invalid_request', 'targetScope must contain ids');
    ids.push(id);
  }
  context.targetScope = new Set(ids);
  return ids;
}

async function readFacts(
  task: TaskDefinition,
  input: Record<string, unknown>,
  context: RunContext,
): Promise<void> {
  if (typeof task.readFacts !== 'function') return;
  const result = await task.readFacts(input, context) as
    | Array<Record<string, unknown>>
    | { facts?: Array<Record<string, unknown>>; missing?: unknown[] }
    | null
    | undefined;
  let facts: Array<Record<string, unknown>> | null | undefined;
  if (result && !Array.isArray(result) && Array.isArray(result.facts)) {
    if (Array.isArray(result.missing) && result.missing.length) {
      throw new AgentError('fact_missing', 'a required fact is missing', { details: { missing: result.missing } });
    }
    facts = result.facts;
  } else if (Array.isArray(result) || result == null) {
    facts = result;
  } else {
    throw new AgentError('invalid_request', 'readFacts must return an array');
  }
  if (facts == null) return;
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

async function taskAttachments(
  task: TaskDefinition,
  input: Record<string, unknown>,
  context: RunContext,
): Promise<AttachmentReference[]> {
  if (typeof task.attachments !== 'function') {
    return Array.isArray(context.meta.attachments)
      ? (context.meta.attachments as AttachmentReference[])
      : [];
  }
  const raw = await task.attachments(input, context);
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new AgentError('invalid_request', 'task attachments must return an array');
  return raw;
}

function evidenceFacts(context: RunContext) {
  return [...context.evidence.values()].map(item => ({
    evidenceId: item.evidenceId,
    source: item.source,
    objectId: item.objectId,
    ...(item.version === undefined ? {} : { version: item.version }),
    content: item.content,
  }));
}

function modelStepOf(task: TaskDefinition): TaskStep {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  return steps.find(step => step && step.id === 'model')
    || steps.find(step => step && Array.isArray(step.tools))
    || steps[0]
    || { id: 'model' };
}

function outputOf(output: ModelOutput, task: TaskDefinition, context: RunContext): unknown {
  let parsed: unknown;
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

interface ProposalCandidate {
  kind?: unknown;
  changes?: unknown[];
  targetId?: unknown;
  objectId?: unknown;
  targetVersion?: unknown;
}

function proposalCandidate(parsed: unknown): ProposalCandidate | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.proposal && typeof record.proposal === 'object' && !Array.isArray(record.proposal)) {
    return record.proposal as ProposalCandidate;
  }
  if (record.kind === 'proposal' && Array.isArray(record.changes)) {
    return record as ProposalCandidate;
  }
  return null;
}

function budgetViewForMessage(message: BaseMessage): unknown {
  const content = Array.isArray(message.content)
    ? message.content.map(part => {
        if (part && typeof part === 'object' && 'type' in part && part.type === 'image_url') {
          return { type: 'image_url' };
        }
        return part;
      })
    : message.content;
  const ai = message as AIMessage;
  const toolMsg = message as ToolMessage;
  return {
    type: message.getType(),
    content,
    ...(Array.isArray(ai.tool_calls) && ai.tool_calls.length ? { tool_calls: ai.tool_calls } : {}),
    ...(typeof toolMsg.tool_call_id === 'string' ? { tool_call_id: toolMsg.tool_call_id } : {}),
    ...(message.name ? { name: message.name } : {}),
  };
}

function estimateRoundBudgetChars(
  messages: BaseMessage[],
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  attachments: AttachmentReference[],
): number {
  const safeAttachments = attachments.map(({ dataUrl: _dataUrl, ...rest }) => rest);
  return JSON.stringify({
    messages: messages.map(budgetViewForMessage),
    tools,
    ...(safeAttachments.length ? { attachments: safeAttachments } : {}),
  }).length;
}

function trimRoundMessagesToBudget(
  messages: BaseMessage[],
  historyCount: number,
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  attachments: AttachmentReference[],
  maxChars: number,
): BaseMessage[] {
  const next = [...messages];
  let historyLeft = historyCount;
  let size = estimateRoundBudgetChars(next, tools, attachments);
  while (size > maxChars) {
    if (historyLeft > 0 && next.length > 2) {
      next.splice(1, 1);
      historyLeft--;
    } else {
      const humanIndex = 1 + historyLeft;
      const toolSection = next.slice(humanIndex + 1);
      const aiIndices: number[] = [];
      for (let i = 0; i < toolSection.length; i++) {
        if (toolSection[i].getType() === 'ai') aiIndices.push(humanIndex + 1 + i);
      }
      if (aiIndices.length > 1) {
        const dropStart = aiIndices[0];
        const dropEnd = aiIndices[1];
        next.splice(dropStart, dropEnd - dropStart);
      } else {
        throw new AgentError('context_budget_exceeded', 'the required context does not fit the model budget', {
          details: { size, limit: maxChars },
        });
      }
    }
    size = estimateRoundBudgetChars(next, tools, attachments);
  }
  return next;
}

export async function runServerAgentWithLangChain(
  options: RunServerAgentOptions,
): Promise<Record<string, unknown>> {
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
    postProcess,
    now = Date.now,
    timeoutMs,
  } = options || {};

  if (!task || typeof task !== 'object') {
    throw new AgentError('invalid_request', 'a registered task is required');
  }
  if (!context) {
    throw new AgentError('invalid_request', 'a bound run context is required');
  }
  if (!gateway || typeof gateway.invokeMessages !== 'function') {
    throw new AgentError('invalid_request', 'a LangChain model gateway is required');
  }

  const budgets = withRunDefaults(task.budgets);
  const executor = tools && 'get' in tools && typeof tools.get === 'function'
    && 'list' in tools && typeof tools.list === 'function'
    ? tools
    : createToolRegistry(tools as ToolDefinition[]);

  const diagnosticTracker = createExerciseSearchDiagnosticTracker(
    task.id,
    context?.meta?.exerciseSearchDiagnostic,
    now,
  );

  const completedOrCancelled = (result: Record<string, unknown>): Record<string, unknown> => {
    if (store && typeof store.saveResult === 'function') {
      try {
        store.saveResult(result);
      } catch {
        /* the host persists the run itself */
      }
    }
    const status = typeof result?.status === 'string' ? result.status : 'completed';
    const errorCode = status === 'failed'
      ? (result?.error as { code?: unknown } | undefined)?.code
      : undefined;
    diagnosticTracker.emitEnd(status, errorCode);
    return result;
  };

  const isRunCancelled = () => Boolean(signal?.aborted || (state && !state.acceptResult()));
  const cancelledResult = () => {
    if (state && !state.isTerminal()) state.cancel('cancelled');
    return completedOrCancelled(
      state ? (state.record() as unknown as Record<string, unknown>) : { runId: context.runId, status: 'cancelled' },
    );
  };

  const step = modelStepOf(task);
  const allowedToolIds = Array.isArray(step.tools) ? step.tools : [];
  let dispatcher: ReturnType<typeof createDispatcher> | null = null;
  let attachments: AttachmentReference[] = [];
  let history: Array<{ id: string; role: string; content: string; createdAt?: number }> = [];
  let memories: unknown[] = [];
  let initialHistoryCount = 0;
  const toolResultsSnapshot: Array<{
    toolId: string;
    callId?: string;
    result: unknown;
    evidenceId?: string;
  }> = [];

  const graph = new StateGraph(ServerAgentAnnotation)
    .addNode('prepare', async () => {
      assertRequest(task, request);
      if (context.request) {
        if (context.request.requestId !== request.requestId || context.request.profileId !== request.profileId) {
          throw new AgentError('invalid_request', 'run context belongs to another request');
        }
      }
      if (state && state.isTerminal()) {
        return {
          cancelled: true,
          finalResult: completedOrCancelled(state.record() as unknown as Record<string, unknown>),
        };
      }
      if (signal?.aborted) {
        if (state) state.cancel('cancelled before the run started');
        return {
          cancelled: true,
          finalResult: completedOrCancelled(
            state ? (state.record() as unknown as Record<string, unknown>) : { runId: context.runId, status: 'cancelled' },
          ),
        };
      }

      if (task.inputSchema) assertValid(task.inputSchema, request.input, '$.input', 'invalid_request');
      if (typeof task.validateInput === 'function') task.validateInput(request.input, context);
      await resolveTargets(task, request.input, context);
      const capabilities = requiredCapabilities(task, request.input);
      if (context.profileRef?.capabilities && capabilities.length) {
        assertCapabilities(
          context.profileRef as unknown as { capabilities?: Record<string, boolean> },
          capabilities,
        );
      }
      if (state) state.start();
      await readFacts(task, request.input, context);

      dispatcher = createDispatcher({
        registry: executor,
        context,
        allowedToolIds,
        maxCalls: step.maxToolCalls ?? budgets.toolCalls,
        signal,
      });

      diagnosticTracker.setPhase('attachments');
      attachments = await taskAttachments(task, request.input, context);
      diagnosticTracker.emitAttachments(attachments);

      history = [...(context.history || [])] as typeof history;
      const noMemories = Array.isArray(task.memoryCategories) && task.memoryCategories.length === 0;
      memories = noMemories ? [] : projectMemories(context.memories || []);

      const fixtureCase = typeof task.fixtureCase === 'function'
        ? task.fixtureCase(request.input, context)
        : undefined;
      const initialModelInput: ModelInput = {
        instructions: typeof task.instructions === 'function'
          ? task.instructions(request.input, context)
          : (task.instructions || DEFAULT_INSTRUCTIONS),
        ...(task.outputFormat === 'json' ? { responseFormat: 'json' } : {}),
        sessionId: request.sessionId || context.runId,
        user: {
          text: typeof task.userText === 'function'
            ? task.userText(request.input, context)
            : String(request.input.prompt || ''),
          ...(fixtureCase ? { fixtureCase } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
        facts: evidenceFacts(context),
        memories: memories as ModelInput['memories'],
        history,
        tools: dispatcher.list(),
        toolResults: [],
      };
      const initialMessages = buildInitialMessages(initialModelInput, budgets);
      initialHistoryCount = Math.max(0, initialMessages.length - 2);
      return { messages: initialMessages };
    })
    .addNode('model', async (graphState: GraphState) => {
      diagnosticTracker.setPhase('model');
      if (isRunCancelled()) {
        return { cancelled: true, finalResult: cancelledResult() };
      }
      if (context.deadline && now() > context.deadline) {
        throw new AgentError('model_timeout', 'the run deadline passed');
      }
      if (!dispatcher) {
        throw new AgentError('invalid_request', 'tool dispatcher was not initialized');
      }

      const nextRound = graphState.rounds + 1;
      const toolsList = dispatcher.list();
      const fixtureCase = typeof task.fixtureCase === 'function'
        ? task.fixtureCase(request.input, context)
        : undefined;
      const roundModelInput: ModelInput = {
        instructions: typeof task.instructions === 'function'
          ? task.instructions(request.input, context)
          : (task.instructions || DEFAULT_INSTRUCTIONS),
        ...(task.outputFormat === 'json' ? { responseFormat: 'json' } : {}),
        sessionId: request.sessionId || context.runId,
        user: {
          text: typeof task.userText === 'function'
            ? task.userText(request.input, context)
            : String(request.input.prompt || ''),
          ...(fixtureCase ? { fixtureCase } : {}),
          ...(attachments.length ? { attachments } : {}),
        },
        facts: evidenceFacts(context),
        memories: memories as ModelInput['memories'],
        history,
        tools: toolsList,
        toolResults: [...toolResultsSnapshot],
      };

      const roundMessages = graphState.rounds === 0
        ? graphState.messages
        : trimRoundMessagesToBudget(
            graphState.messages,
            initialHistoryCount,
            toolsList,
            attachments,
            budgets.contextChars,
          );

      const requiredCaps = requiredCapabilitiesFor(roundModelInput);
      const roundCallbacks = diagnosticTracker.createRoundCallbacks(nextRound, isRunCancelled);
      const roundStartedAt = diagnosticTracker.enabled ? now() : 0;

      let invoked: LangChainGatewayInvokeResult;
      try {
        invoked = await gateway.invokeMessages(context.profileRef, {
          messages: roundMessages,
          requiredCapabilities: requiredCaps,
          tools: toolsList,
          responseFormat: task.outputFormat === 'json' ? 'json' : undefined,
          fixtureInput: roundModelInput,
          signal,
          callbacks: roundCallbacks.callbacks,
          timeoutMs,
        });
      } catch (error) {
        roundCallbacks.emitFallbackFailure(error, roundStartedAt);
        throw error;
      }

      if (isRunCancelled()) {
        return { cancelled: true, finalResult: cancelledResult() };
      }

      const calls = Array.isArray(invoked.output.toolCalls) ? invoked.output.toolCalls : [];
      if (calls.length > 0 && nextRound >= budgets.rounds) {
        throw new AgentError('invalid_request', 'the model kept calling tools after the round budget');
      }

      const hasUsage = invoked.usage.inputTokens !== undefined
        || invoked.usage.outputTokens !== undefined
        || invoked.usage.totalTokens !== undefined;

      return {
        messages: [invoked.message],
        rounds: nextRound,
        lastOutput: invoked.output,
        inputTokens: invoked.usage.inputTokens ?? 0,
        outputTokens: invoked.usage.outputTokens ?? 0,
        totalTokens: invoked.usage.totalTokens ?? 0,
        hasTokenUsage: hasUsage,
      };
    })
    .addNode('tool', async (graphState: GraphState) => {
      if (!dispatcher) {
        throw new AgentError('invalid_request', 'tool dispatcher was not initialized');
      }
      const calls = Array.isArray(graphState.lastOutput?.toolCalls) ? graphState.lastOutput.toolCalls : [];
      const toolMessages: ToolMessage[] = [];
      for (const call of calls) {
        if (isRunCancelled()) {
          return { cancelled: true, finalResult: cancelledResult() };
        }
        // Let any four-fence AgentError propagate directly and abort the run.
        const executed = await dispatcher.call(call.name, call.arguments, { callId: call.id });
        let evidenceId: string | undefined;
        const result = executed.result as Record<string, unknown> | null | undefined;
        if (result && typeof result === 'object' && typeof result.objectId === 'string' && result.content !== undefined) {
          const evidence = addEvidence(context, {
            source: `tool:${call.name}`,
            objectId: result.objectId,
            version: result.version as string | number | undefined,
            content: result.content,
          });
          evidenceId = evidence.evidenceId;
        }
        toolResultsSnapshot.push({
          toolId: call.name,
          callId: call.id,
          result,
          ...(evidenceId ? { evidenceId } : {}),
        });
        const toolPayload = evidenceId && result && typeof result === 'object' && !Array.isArray(result)
          ? { ...result, evidenceId }
          : result;
        toolMessages.push(new ToolMessage({
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(toolPayload ?? null),
        }));
      }
      return {
        messages: toolMessages,
        toolCalls: dispatcher.calls,
      };
    })
    .addNode('finalize', async (graphState: GraphState) => {
      if (isRunCancelled()) {
        return { cancelled: true, finalResult: cancelledResult() };
      }
      if (!graphState.lastOutput) {
        throw new AgentError('model_unavailable', 'the model returned no answer');
      }
      diagnosticTracker.setPhase('recognition');
      const parsed = outputOf(graphState.lastOutput, task, context);
      let processed = parsed;
      if (postProcess) {
        diagnosticTracker.setPhase('retrieval');
        if (isRunCancelled()) {
          return { cancelled: true, finalResult: cancelledResult() };
        }
        processed = await postProcess(parsed, context);
        if (isRunCancelled()) {
          return { cancelled: true, finalResult: cancelledResult() };
        }
      }

      const candidate = proposalCandidate(parsed);
      let proposal: Proposal | undefined;
      if (candidate) {
        if (!proposals || typeof proposals.create !== 'function') {
          throw new AgentError('invalid_request', 'this task produced a proposal but no proposal service is configured');
        }
        const kind = String(candidate.kind || 'stub.write');
        if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(kind)) {
          throw new AgentError('invalid_request', 'the proposal kind is invalid', { details: { kind } });
        }
        if (!Array.isArray(candidate.changes) || !candidate.changes.length) {
          throw new AgentError('invalid_request', 'a proposal needs at least one change');
        }
        if (isRunCancelled()) {
          return { cancelled: true, finalResult: cancelledResult() };
        }

        if (kind === 'memory' || kind === 'memory.save') {
          const change = candidate.changes.length === 1 ? candidate.changes[0] : null;
          const changeRecord = change && typeof change === 'object' && !Array.isArray(change)
            ? (change as Record<string, unknown>)
            : null;
          if (
            !changeRecord
            || changeRecord.op !== 'save'
            || !isMemoryCategory(String(changeRecord.category || ''))
            || changeRecord.value === undefined
          ) {
            throw new AgentError('invalid_request', 'the memory proposal changes are invalid');
          }
          proposal = await proposals.create({
            runId: context.runId,
            kind: 'memory.save',
            changes: candidate.changes,
            targetScope: [context.scope],
          });
        } else {
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
          proposal = await proposals.create({
            runId: context.runId,
            kind,
            changes: candidate.changes,
            targetScope: [targetId],
            targetVersion: candidate.targetVersion as string | number,
          });
        }

        if (isRunCancelled()) {
          if (proposal && typeof proposals.discard === 'function') {
            try {
              await proposals.discard(proposal.proposalId);
            } catch {
              /* terminal state still wins */
            }
          }
          return { cancelled: true, finalResult: cancelledResult() };
        }
      }

      const processedRecord = processed && typeof processed === 'object' && !Array.isArray(processed)
        ? (processed as Record<string, unknown>)
        : null;
      const result: ServerRunResult = {
        runId: context.runId,
        status: 'completed',
        ...(typeof processed === 'string'
          ? { text: processed }
          : {
              ...(typeof processedRecord?.text === 'string' ? { text: processedRecord.text } : {}),
              structured: processed,
            }),
        ...(proposal ? { proposal } : {}),
        evidence: evidenceList(context),
        usage: {
          rounds: graphState.rounds,
          toolCalls: dispatcher ? dispatcher.calls : graphState.toolCalls,
          ...(graphState.hasTokenUsage
            ? {
                inputTokens: graphState.inputTokens,
                outputTokens: graphState.outputTokens,
                totalTokens: graphState.totalTokens || (graphState.inputTokens + graphState.outputTokens),
              }
            : {}),
        },
      };

      if (state) {
        if (!state.acceptResult()) {
          return {
            cancelled: true,
            finalResult: completedOrCancelled(state.record() as unknown as Record<string, unknown>),
          };
        }
        state.completed(result as RunResult);
        return {
          finalResult: completedOrCancelled(state.record() as unknown as Record<string, unknown>),
        };
      }

      return {
        finalResult: completedOrCancelled(result as unknown as Record<string, unknown>),
      };
    })
    .addEdge(START, 'prepare')
    .addConditionalEdges('prepare', (graphState: GraphState) => {
      if (graphState.cancelled) return END;
      if (budgets.rounds <= 0) return 'finalize';
      return 'model';
    }, [END, 'model', 'finalize'])
    .addConditionalEdges('model', (graphState: GraphState) => {
      if (graphState.cancelled) return END;
      const calls = graphState.lastOutput?.toolCalls;
      if (Array.isArray(calls) && calls.length > 0) return 'tool';
      return 'finalize';
    }, [END, 'tool', 'finalize'])
    .addConditionalEdges('tool', (graphState: GraphState) => {
      if (graphState.cancelled) return END;
      return 'model';
    }, [END, 'model'])
    .addEdge('finalize', END)
    .compile();

  try {
    const finalState = await graph.invoke(
      {},
      {
        ...(signal ? { signal } : {}),
        recursionLimit: Math.max(10, budgets.rounds * 2 + 4),
      },
    );
    if (finalState.finalResult) {
      return finalState.finalResult;
    }
    return cancelledResult();
  } catch (error) {
    let mapped: AgentError;
    if (error instanceof AgentError) {
      mapped = error;
    } else if (
      error instanceof GraphRecursionError
      || (error && typeof error === 'object' && ((error as { name?: unknown }).name === 'GraphRecursionError'
        || (error as { lc_error_code?: unknown }).lc_error_code === 'GRAPH_RECURSION_LIMIT'))
    ) {
      mapped = new AgentError('invalid_request', 'the model kept calling tools after the round budget', {
        cause: error,
      });
    } else {
      const nested = extractNestedAgentError(error);
      mapped = nested ?? mapLangChainError(error, signal);
    }

    if (
      diagnosticTracker.phase() === 'retrieval'
      && (mapped.details as Record<string, unknown> | undefined)?.phase === 'rerank'
    ) {
      diagnosticTracker.setPhase('rerank');
    }

    const cancelled = Boolean(signal?.aborted || (state && state.status() === 'cancelled') || mapped.code === 'run_cancelled');
    if (cancelled) {
      return cancelledResult();
    }

    const safeMessage = sanitizeErrorText(mapped.message) || 'run failed';
    if (state && !state.isTerminal()) {
      state.failed({ code: mapped.code, message: safeMessage });
    }
    diagnosticTracker.emitEnd('failed', mapped.code);
    throw mapped;
  }
}
