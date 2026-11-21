import { Injectable, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AgentError,
  assertValid,
  bindContext,
  createIds,
  createRunState,
  runAgent,
  selectMemories,
  validRequestId,
  withRunDefaults,
} from '../../agent-runtime/index.js';
import type { ProposalService, RunContext, RunRecord, TaskDefinition } from '../../agent-runtime/contracts.js';
import { AccountStore } from '../common/persistence/account-store.js';
import type { AgentMemory, AgentProfilePublic, AgentProposal, AgentRunResult, AgentSessionSummary, AgentStoredRun } from './agent.types.js';
import { AgentConfigStore } from './agent-config.store.js';
import { AgentGateway } from './agent-gateway.js';
import { AgentMedia } from './agent-media.js';
import { AgentMemoryStore } from './agent-memory.store.js';
import { AgentProposalAdapter } from './agent-proposal.adapter.js';
import { AgentProposalStore } from './agent-proposal.store.js';
import { AgentRunStore, requestFingerprint } from './agent-run.store.js';
import { AgentSessionStore } from './agent-session.store.js';
import { AgentStore } from './agent.store.js';
import { agentEnabled } from './agent.flags.js';
import { createStubTask, STUB_TASK_ID } from './tasks/stub-task.js';
import { createStubTools } from './tools/stub-tools.js';

interface ActiveRun {
  uid: string;
  controller: AbortController;
  state: ReturnType<typeof createRunState>;
}

const ids = createIds(randomUUID);

function parseStart(body: Record<string, unknown>) {
  const taskId = body.taskId === undefined ? STUB_TASK_ID : String(body.taskId);
  if (taskId !== STUB_TASK_ID) throw new AgentError('invalid_request', 'unknown task');
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
    ...(attachmentIds.length ? { attachmentIds } : {}),
  };
}

@Injectable()
export class AgentService implements OnModuleInit {
  private readonly active = new Map<string, ActiveRun>();
  private readonly task;
  private readonly tools;

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
  ) {
    this.task = createStubTask(this.store);
    this.tools = createStubTools(this.store);
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
    }
  }

  private enabled(): void {
    if (!agentEnabled()) throw new AgentError('agent_disabled');
  }

  async start(uid: string, body: Record<string, unknown>): Promise<{ runId: string; status: string }> {
    this.enabled();
    const request = parseStart(body);
    if (this.task.inputSchema) {
      // Rejected synchronously: a too-long prompt must not burn a request id
      // on a run that is destined to fail.
      assertValid(this.task.inputSchema, request.input, '$.input', 'invalid_request');
    }
    const requestHash = requestFingerprint(request);
    // Idempotency comes before any profile or session work: a retry must
    // still find its original job even if the profile it named was deleted
    // or the session tombstoned between the two submissions.
    const known = this.runs.find(uid, request.requestId, requestHash);
    if (known) return { runId: known.runId, status: known.status };
    const resolved = await this.configs.resolve(uid, request.profileId);
    // Attachment references are validated with the request, not discovered as
    // a failed run after the fact.
    if (request.attachmentIds) await this.media.resolve(uid, request.attachmentIds);
    const session = request.sessionId ? await this.sessions.ensure(uid, request.sessionId) : null;
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
      ...(session ? { sessionId: session.id, sessionVersion: session.version } : {}),
    };
    const begun = await this.runs.begin(uid, run);
    if (!begun.created) {
      return { runId: begun.run.runId, status: begun.run.status };
    }
    const controller = new AbortController();
    const state = createRunState(begun.run as unknown as RunRecord, {
      onChange: record => {
        void this.runs.replace(uid, record as unknown as AgentStoredRun).catch(() => undefined);
      },
    });
    this.active.set(run.runId, { uid, controller, state });
    queueMicrotask(() => {
      void this.execute(uid, request, resolved, state, controller).catch(() => undefined);
    });
    return { runId: run.runId, status: 'accepted' };
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
    state: ReturnType<typeof createRunState>,
    controller: AbortController,
  ): Promise<void> {
    try {
      if (state.isTerminal()) return;
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
      const budgets = withRunDefaults((this.task as TaskDefinition).budgets);
      const taskCategories = (this.task as TaskDefinition).memoryCategories;
      const allMemories = await this.memories.list(uid);
      const memoryProjection = selectMemories(allMemories, {
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
      const context = bindContext({
        scope: uid,
        runId: run.runId,
        request: {
          taskId: request.taskId,
          requestId: request.requestId,
          profileId: request.profileId,
          input: request.input,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(request.attachmentIds ? { attachmentIds: request.attachmentIds } : {}),
        },
        execution: 'server',
        profileRef: resolved.profile as unknown as Record<string, unknown>,
        dataVersion: 1,
        targetScope: [],
        signal: controller.signal,
        memories: memoryProjection,
        history,
        meta: { uid, attachments, ...(session ? { sessionId: session.id } : {}) },
        ids,
      }) as unknown as RunContext;
      const result = await runAgent({
        task: this.task as unknown as TaskDefinition,
        request: {
          taskId: request.taskId,
          requestId: request.requestId,
          profileId: request.profileId,
          input: request.input,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
          ...(request.attachmentIds ? { attachmentIds: request.attachmentIds } : {}),
        },
        context,
        gateway: this.gateway.forAccount(uid),
        tools: this.tools.tools,
        proposals: this.proposalCreator(uid, run.runId) as unknown as ProposalService,
        state,
        signal: controller.signal,
      });
      if (session && state.status() === 'completed') {
        const payload = result && typeof result === 'object' && 'result' in result ? (result as { result?: AgentRunResult }).result : null;
        const assistantText = typeof payload?.text === 'string'
          ? payload.text
          : payload?.structured
            ? JSON.stringify(payload.structured)
            : '';
        try {
          await this.sessions.append(uid, session.id, [
            { id: randomUUID(), role: 'user', content: String(request.input.prompt || ''), createdAt: Date.now(), runId: run.runId },
            { id: randomUUID(), role: 'assistant', content: assistantText, createdAt: Date.now(), runId: run.runId },
          ]);
        } catch (error) {
          // A deleted session must not be recreated by a late run.
          if (!(error instanceof AgentError) || error.code !== 'session_deleted') throw error;
        }
      }
      await this.runs.finish(uid, run.runId, state.record() as unknown as Partial<AgentStoredRun>);
    } catch (error) {
      if (!state.isTerminal()) {
        state.failed({
          code: error instanceof AgentError ? error.code : 'model_unavailable',
          message: error instanceof Error ? error.message : 'run failed',
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
