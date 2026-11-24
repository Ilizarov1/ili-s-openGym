import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AgentError,
  assertValid,
  bindContext,
  createIds,
  createRunState,
  isSessionMode,
  runAgent,
  selectMemories,
  validRequestId,
  withRunDefaults,
} from '../../agent-runtime/index.js';
import type { ProposalService, RunContext, RunRecord } from '../../agent-runtime/contracts.js';
import { createExerciseSearchTrace } from '../../agent-runtime/exercise-search-diagnostics.js';
import { AccountStore } from '../common/persistence/account-store.js';
import type {
  AgentMemory, AgentProfilePublic, AgentProfileSummary, AgentProposal, AgentRunResult,
  AgentSessionSummary, AgentStoredRun,
} from './agent.types.js';
import { AgentConfigStore } from './agent-config.store.js';
import { AgentGateway } from './agent-gateway.js';
import { AgentMedia } from './agent-media.js';
import { AgentMemoryStore } from './agent-memory.store.js';
import { AgentProposalAdapter } from './agent-proposal.adapter.js';
import { AgentProposalStore } from './agent-proposal.store.js';
import { AgentRunStore, requestFingerprint } from './agent-run.store.js';
import { AgentSessionStore } from './agent-session.store.js';
import { AgentStore } from './agent.store.js';
import { agentEnabled, agentServerEngine, exerciseSearchVersion, fixtureAllowed } from './agent.flags.js';
import { runServerAgentWithLangChain, sanitizeErrorText } from './langchain/index.js';
import { createTaskRegistry, type RegisteredTask } from './tasks/index.js';
import { EXERCISE_SEARCH_V2_TASK_ID, type ExerciseSearchHistory } from './tasks/exercise-search-v2.js';
import { RetrievalService } from './retrieval/index.js';

interface ActiveRun {
  uid: string;
  controller: AbortController;
  state: ReturnType<typeof createRunState>;
}

const ids = createIds(randomUUID);

const AI_MAX_RUNS_PER_SESSION = 6;

function profileSummary(profile: {
  id: string; label?: string; provider: string; model: string; version: number;
}): AgentProfileSummary {
  return {
    id: profile.id,
    label: profile.label || profile.provider,
    provider: profile.provider,
    model: profile.model,
    version: profile.version,
  };
}

function parseStart(body: Record<string, unknown>) {
  const taskId = body.taskId === undefined ? 'stub.v1' : String(body.taskId);
  const requestId = String(body.requestId || '');
  if (!validRequestId(requestId)) throw new AgentError('invalid_request', 'requestId is invalid');
  const profileId = String(body.profileId || '');
  if (!profileId) throw new AgentError('invalid_request', 'profileId is required');
  if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) {
    throw new AgentError('invalid_request', 'input must be an object');
  }
  const sessionId = body.sessionId === undefined ? undefined : String(body.sessionId);
  if (sessionId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) {
    throw new AgentError('invalid_request', 'sessionId is invalid');
  }
  const sessionMode = (body.sessionMode === undefined
    ? (sessionId ? 'new' : undefined)
    : body.sessionMode) as 'new' | 'continue' | undefined;
  if (sessionMode !== undefined && !isSessionMode(sessionMode)) {
    throw new AgentError('invalid_request', 'sessionMode must be new or continue');
  }
  if (sessionMode === 'continue' && !sessionId) {
    throw new AgentError('invalid_request', 'sessionMode continue needs a sessionId');
  }
  const rawAttachments = body.attachmentIds;
  if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
    throw new AgentError('invalid_request', 'attachmentIds must be an array');
  }
  const attachmentIds = (rawAttachments || []).map(String);
  if (attachmentIds.length > 4) throw new AgentError('invalid_request', 'at most four attachments are allowed');
  return {
    taskId,
    requestId,
    profileId,
    input: body.input as Record<string, unknown>,
    ...(sessionId ? { sessionId } : {}),
    ...(sessionMode ? { sessionMode } : {}),
    ...(attachmentIds.length ? { attachmentIds } : {}),
  };
}

@Injectable()
export class AgentService implements OnModuleInit {
  private readonly active = new Map<string, ActiveRun>();
  private readonly tasks;

  constructor(
    private readonly accounts: AccountStore,
    private readonly store: AgentStore,
    private readonly configs: AgentConfigStore,
    private readonly runs: AgentRunStore,
    private readonly sessions: AgentSessionStore,
    private readonly memories: AgentMemoryStore,
    private readonly proposals: AgentProposalStore,
    private readonly adapter: AgentProposalAdapter,
    private readonly gateway: AgentGateway,
    private readonly media: AgentMedia,
    private readonly retrieval: RetrievalService,
  ) {
    this.tasks = createTaskRegistry({ store: this.store });
  }

  async onModuleInit(): Promise<void> {
    // A process that died mid-run cannot finish it. Mark only accounts that
    // actually have an open run, so a fresh boot does not create empty files.
    // Awaited: a client polling right after boot must not see a leftover
    // `running` status that this pass is about to interrupt.
    for (const user of this.accounts.db.users) {
      let hasOpen = false;
      try {
        const data = this.store.read(user.id);
        hasOpen = Object.values(data.runs).some(run => run.status === 'accepted' || run.status === 'running');
      } catch {
        continue; // one unreadable account must not block boot
      }
      if (hasOpen) {
        try {
          await this.runs.markInterrupted(user.id);
        } catch {
          /* boot must not fail on one account */
        }
      }
      try {
        await this.sessions.purgeExpired(user.id);
        await this.runs.purgeExpired(user.id);
      } catch {
        /* cleanup must not block boot */
      }
    }
  }

  private enabled(): void {
    if (!agentEnabled()) throw new AgentError('agent_disabled');
  }

  async start(uid: string, body: Record<string, unknown>): Promise<{
    runId: string;
    status: string;
    profile?: AgentProfileSummary;
  }> {
    this.enabled();
    const request = parseStart(body);
    const registered = this.tasks.get(request.taskId);
    if (!registered) {
      throw new AgentError('invalid_request', 'unknown task', { details: { taskId: request.taskId } });
    }
    const { task } = registered;
    if (task.inputSchema) assertValid(task.inputSchema, request.input, '$.input', 'invalid_request');
    if (typeof task.validateInput === 'function') task.validateInput(request.input);
    const requestHash = requestFingerprint(request);
    // Idempotency comes before any profile or session work: a retry must
    // still find its original job even if the profile it named was deleted
    // or the session tombstoned between the two submissions.
    const known = this.runs.find(uid, request.requestId, requestHash);
    if (known) {
      return {
        runId: known.runId,
        status: known.status,
        ...(known.profile ? { profile: known.profile } : {}),
      };
    }
    if (request.taskId === EXERCISE_SEARCH_V2_TASK_ID && exerciseSearchVersion() !== 'v2') {
      throw new AgentError('retrieval_unavailable');
    }
    await this.sessions.purgeExpired(uid);
    await this.runs.purgeExpired(uid);
    const resolved = await this.configs.resolve(uid, request.profileId);
    // Attachment references are validated with the request, not discovered as
    // a failed run after the fact.
    if (request.attachmentIds) await this.media.resolve(uid, request.attachmentIds);
    let session = null;
    if (request.sessionId) {
      if (request.sessionMode === 'continue') {
        session = await this.sessions.get(uid, request.sessionId);
        if (!session) throw new AgentError('session_deleted', undefined, { details: { sessionId: request.sessionId } });
        if (session.taskId && session.taskId !== request.taskId) {
          throw new AgentError('session_conflict', 'this conversation belongs to another task', {
            details: { sessionId: request.sessionId, taskId: session.taskId },
          });
        }
      } else {
        session = await this.sessions.ensure(uid, request.sessionId, {
          taskId: request.taskId,
          executionLocation: 'server',
        });
      }
    }
    const profile = profileSummary(resolved.profile);
    const run: AgentStoredRun = {
      runId: ids.run(),
      requestId: request.requestId,
      requestHash,
      taskId: request.taskId,
      profileId: request.profileId,
      executionLocation: 'server',
      status: 'accepted',
      createdAt: Date.now(),
      dataVersion: 1,
      profile,
      ...(session ? { sessionId: session.id, sessionVersion: session.version } : {}),
    };
    const begun = await this.runs.begin(uid, run, {
      ...(request.taskId.startsWith('exercise-search.') ? { maxTurns: AI_MAX_RUNS_PER_SESSION } : {}),
    });
    if (!begun.created) {
      return {
        runId: begun.run.runId,
        status: begun.run.status,
        ...(begun.run.profile ? { profile: begun.run.profile } : {}),
      };
    }
    const controller = new AbortController();
    const state = createRunState(begun.run as unknown as RunRecord, {
      onChange: record => {
        // A v2 follow-up can start as soon as the completed record is visible.
        // Publish it after execute() has appended the ranked names to the session.
        if (request.taskId === EXERCISE_SEARCH_V2_TASK_ID && record.status === 'completed') return;
        void this.runs.replace(uid, record as unknown as AgentStoredRun).catch(() => undefined);
      },
    });
    this.active.set(run.runId, { uid, controller, state });
    queueMicrotask(() => {
      void this.execute(uid, request, resolved, registered, state, controller).catch(() => undefined);
    });
    return { runId: run.runId, status: 'accepted', profile };
  }

  private proposalCreator(uid: string, runId: string) {
    return {
      create: async (input: Record<string, unknown>) => {
        const kind = String(input.kind);
        if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(kind)) {
          throw new AgentError('invalid_request', 'the proposal kind is invalid');
        }
        const changes = Array.isArray(input.changes) ? input.changes : [];
        if (!changes.length) {
          throw new AgentError('invalid_request', 'a proposal needs at least one change');
        }
        const proposal: AgentProposal = {
          proposalId: ids.proposal(),
          runId,
          kind,
          changes,
          targetScope: Array.isArray(input.targetScope) ? input.targetScope.map(String) : [],
          ...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion as string | number }),
          status: 'pending',
          createdAt: Date.now(),
        };
        return this.proposals.save(uid, proposal);
      },
      discard: (proposalId: string) => this.proposals.reject(uid, proposalId),
    };
  }

  private async execute(
    uid: string,
    request: ReturnType<typeof parseStart>,
    resolved: Awaited<ReturnType<AgentConfigStore['resolve']>>,
    registered: RegisteredTask,
    state: ReturnType<typeof createRunState>,
    controller: AbortController,
  ): Promise<void> {
    try {
      if (state.isTerminal()) return;
      const { task } = registered;
      const run = state.record();
      if (run.status === 'accepted') state.start();
      const session = request.sessionId ? await this.sessions.get(uid, request.sessionId) : null;
      if (request.sessionId && !session) {
        // The session was deleted between start() ensuring it and execution.
        // That is this run failing, not the user cancelling it.
        state.failed({ code: 'session_deleted', message: 'the conversation was deleted' });
        await this.runs.finish(uid, run.runId, state.record() as unknown as Partial<AgentStoredRun>);
        return;
      }
      const attachments = request.attachmentIds ? await this.media.resolve(uid, request.attachmentIds) : [];
      const budgets = withRunDefaults(task.budgets);
      const taskCategories = task.memoryCategories;
      const noMemories = Array.isArray(taskCategories) && taskCategories.length === 0;
      const allMemories = noMemories ? [] : await this.memories.list(uid);
      const memoryProjection = noMemories ? [] : selectMemories(allMemories, {
        scope: uid,
        ...(Array.isArray(taskCategories) && taskCategories.length ? { kinds: taskCategories } : {}),
        limit: budgets.memoryItems,
        maxChars: 4000,
      });
      const history = (session?.messages || []).slice(-budgets.historyItems).map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      }));
      // Exercise-search diagnostics (EVAL_CLI_EXECUTION.md D03): the switch is
      // read at execution time and only for the matching task. The sink is a
      // run-local function the shared orchestrator consumes from meta; with the
      // switch off the meta below is byte-for-byte what it was before.
      const exerciseSearchSink = process.env.AGENT_EXERCISE_SEARCH_DIAGNOSTICS === '1'
        && task.id.startsWith('exercise-search.')
        ? createExerciseSearchTrace({ traceId: request.requestId, source: 'api', enabled: true })
        : undefined;
      const context = bindContext({
        scope: uid,
        runId: run.runId,
        request: {
          taskId: request.taskId,
          requestId: request.requestId,
          profileId: request.profileId,
          input: request.input,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(request.sessionMode ? { sessionMode: request.sessionMode } : {}),
          ...(request.attachmentIds ? { attachmentIds: request.attachmentIds } : {}),
        },
        execution: 'server',
        profileRef: resolved.profile as unknown as Record<string, unknown>,
        dataVersion: 1,
        targetScope: [],
        signal: controller.signal,
        memories: memoryProjection,
        history,
        meta: {
          uid,
          attachments,
          ...(session ? { sessionId: session.id } : {}),
          ...(exerciseSearchSink ? { exerciseSearchDiagnostic: exerciseSearchSink } : {}),
        },
        ids,
      }) as unknown as RunContext;
      let exerciseHistory: ExerciseSearchHistory | undefined;
      const postProcess = task.id === EXERCISE_SEARCH_V2_TASK_ID ? async (recognition: unknown) => {
        const result = await this.retrieval.retrieve({
          input: request.input,
          recognition: recognition as Parameters<RetrievalService['retrieve']>[0]['recognition'],
          signal: controller.signal,
          diagnostic: exerciseSearchSink,
          fixture: resolved.profile.provider === 'fixture' && fixtureAllowed(),
        });
        registered.validatePostProcessed?.(result.structured);
        exerciseHistory = result.historyMeta;
        return result.structured;
      } : undefined;
      const runRequest = {
        taskId: request.taskId,
        requestId: request.requestId,
        profileId: request.profileId,
        input: request.input,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        ...(request.sessionMode ? { sessionMode: request.sessionMode } : {}),
        ...(request.attachmentIds ? { attachmentIds: request.attachmentIds } : {}),
      };
      const result = agentServerEngine() === 'legacy'
        ? await runAgent({
            task,
            request: runRequest,
            context,
            gateway: this.gateway.forAccount(uid),
            tools: registered.tools as never,
            proposals: this.proposalCreator(uid, run.runId) as unknown as ProposalService,
            state,
            signal: controller.signal,
            postProcess,
          })
        : await runServerAgentWithLangChain({
            task,
            request: runRequest,
            context,
            gateway: this.gateway.forAccountLangChain(uid),
            tools: registered.tools as never,
            proposals: this.proposalCreator(uid, run.runId) as unknown as ProposalService,
            state,
            signal: controller.signal,
            postProcess,
          });
      if (session && state.status() === 'completed') {
        const projection = registered.messageOf(request.input, result, exerciseHistory);
        const images = projection.assistant.meta?.images;
        try {
          await this.sessions.append(uid, session.id, [
            {
              id: randomUUID(),
              role: 'user',
              content: projection.user.content,
              createdAt: Date.now(),
              runId: run.runId,
              ...(Array.isArray(images) && images.length ? { meta: { images } } : {}),
            },
            {
              id: randomUUID(),
              role: 'assistant',
              content: projection.assistant.content,
              createdAt: Date.now(),
              runId: run.runId,
              ...(projection.assistant.meta ? { meta: projection.assistant.meta } : {}),
            },
          ], (run as unknown as AgentStoredRun).sessionVersion);
        } catch (error) {
          // A deleted session must not be recreated by a late run. A version
          // conflict means another writer won; the run itself already ended.
          if (!(error instanceof AgentError)
            || (error.code !== 'session_deleted' && error.code !== 'session_conflict')) throw error;
        }
      }
      const record = state.record();
      const payload = record.result && typeof record.result === 'object'
        ? record.result as AgentRunResult
        : null;
      const resultWithProfile = payload ? { ...payload, profile: profileSummary(resolved.profile) } : payload;
      await this.runs.finish(uid, run.runId, {
        ...(record as unknown as Partial<AgentStoredRun>),
        ...(resultWithProfile ? { result: resultWithProfile } : {}),
      });
    } catch (error) {
      if (!state.isTerminal()) {
        state.failed({
          code: error instanceof AgentError ? error.code : 'model_unavailable',
          message: sanitizeErrorText(error instanceof Error ? error.message : 'run failed') || 'run failed',
        });
      }
      try {
        await this.runs.finish(uid, state.runId, state.record() as unknown as Partial<AgentStoredRun>);
      } catch {
        /* the run may already have been cleaned up */
      }
    } finally {
      this.active.delete(state.runId);
    }
  }

  async get(uid: string, runId: string): Promise<AgentStoredRun> {
    this.enabled();
    const run = this.runs.get(uid, runId);
    if (!run) throw new AgentError('run_not_found', undefined, { details: { runId } });
    return run;
  }

  async cancel(uid: string, runId: string): Promise<AgentStoredRun> {
    this.enabled();
    const current = this.runs.get(uid, runId);
    if (!current) throw new AgentError('run_not_found', undefined, { details: { runId } });
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) return current;
    const active = this.active.get(runId);
    if (active && active.uid === uid) {
      if (active.state.status() === 'completed') return active.state.record() as unknown as AgentStoredRun;
      active.state.cancel('cancelled by the user');
      active.controller.abort();
      const finished = await this.runs.finish(uid, runId, active.state.record() as unknown as Partial<AgentStoredRun>);
      // The run is already terminal; failing to tidy a proposal must not make
      // cancellation look like it failed. Confirm still checks the run status.
      try { await this.proposals.expireForRun(uid, runId); } catch { /* confirm gate remains */ }
      return finished;
    }
    const cancelled = await this.runs.cancel(uid, runId);
    try { await this.proposals.expireForRun(uid, runId); } catch { /* confirm gate remains */ }
    return cancelled;
  }

  async listProfiles(uid: string): Promise<AgentProfilePublic[]> {
    this.enabled();
    return this.configs.list(uid);
  }

  async createProfile(uid: string, body: Record<string, unknown>): Promise<AgentProfilePublic> {
    this.enabled();
    return this.configs.create(uid, body, ids.record('profile'));
  }

  async updateProfile(uid: string, profileId: string, body: Record<string, unknown>): Promise<AgentProfilePublic> {
    this.enabled();
    return this.configs.update(uid, profileId, body);
  }

  async deleteProfile(uid: string, profileId: string): Promise<void> {
    this.enabled();
    const removed = await this.configs.remove(uid, profileId);
    if (!removed) throw new AgentError('profile_not_found', undefined, { details: { profileId } });
  }

  async listSessions(uid: string): Promise<AgentSessionSummary[]> {
    this.enabled();
    return this.sessions.list(uid);
  }

  async getSession(uid: string, sessionId: string) {
    this.enabled();
    const session = await this.sessions.get(uid, sessionId);
    if (!session) throw new AgentError('session_deleted', undefined, { details: { sessionId } });
    return session;
  }

  async deleteSession(uid: string, sessionId: string): Promise<void> {
    this.enabled();
    const removed = await this.sessions.remove(uid, sessionId);
    if (!removed) throw new AgentError('session_deleted', undefined, { details: { sessionId } });
  }

  async listMemories(uid: string): Promise<AgentMemory[]> {
    this.enabled();
    return (await this.memories.list(uid)).map(({ scope: _scope, ...memory }) => memory);
  }

  async createMemory(uid: string, body: Record<string, unknown>): Promise<AgentMemory> {
    this.enabled();
    const { scope: _scope, ...memory } = await this.memories.create(uid, body);
    return memory;
  }

  async updateMemory(uid: string, memoryId: string, body: Record<string, unknown>): Promise<AgentMemory> {
    this.enabled();
    const { scope: _scope, ...memory } = await this.memories.update(uid, memoryId, body);
    return memory;
  }

  async deleteMemory(uid: string, memoryId: string): Promise<void> {
    this.enabled();
    const removed = await this.memories.remove(uid, memoryId);
    if (!removed) throw new AgentError('memory_not_found', undefined, { details: { memoryId } });
  }

  async confirmProposal(uid: string, proposalId: string) {
    this.enabled();
    return this.proposals.confirm(uid, proposalId, (data, proposal) => this.adapter.apply(data, proposal));
  }

  async rejectProposal(uid: string, proposalId: string): Promise<AgentProposal> {
    this.enabled();
    return this.proposals.reject(uid, proposalId);
  }

  async getRunResult(uid: string, runId: string): Promise<AgentRunResult | null> {
    const run = await this.get(uid, runId);
    return run.result || null;
  }
}
