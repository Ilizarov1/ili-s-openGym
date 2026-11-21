// The local executor: shared run orchestration + SQLite + SecureStore + RN fetch.
// A run captures its workspace scope and workspace snapshot at start; switching
// workspaces later cannot move the result or read another workspace's data.
import * as Crypto from 'expo-crypto';
import { randomUUID } from 'expo-crypto';
import {
  AgentError,
  assertValid,
  bindContext,
  createIds,
  createRunState,
  isMemoryCategory,
  runAgent,
  selectMemories,
  validRequestId,
  withRunDefaults,
} from './shared';
import type {
  AgentAttachment, AgentMemory, AgentProposal, AgentProposalRow, AgentRunRow, AgentSessionSummary, AgentStartInput,
} from './types';
import { readAttachment } from './media';
import type { Connection } from '../server';
import type { LocalState } from '../storage';
import { workspaceScope } from '../storage';
import { AgentConfig } from './config';
import { AgentGateway } from './gateway';
import { AgentStore } from './store';
import { createLocalTask, createLocalTools, LOCAL_PROFILE } from './tasks';

const ids = createIds(randomUUID);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

async function fingerprint(value: unknown): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(canonical(value)));
}

function rowOf(record: Record<string, unknown>, scope: string): AgentRunRow {
  return {
    scope,
    runId: String(record.runId),
    requestId: String(record.requestId),
    requestHash: String(record.requestHash || ''),
    taskId: String(record.taskId || 'stub.local.v1'),
    profileId: String(record.profileId || ''),
    status: String(record.status || 'accepted') as AgentRunRow['status'],
    createdAt: Number(record.createdAt || Date.now()),
    ...(record.startedAt == null ? {} : { startedAt: Number(record.startedAt) }),
    ...(record.finishedAt == null ? {} : { finishedAt: Number(record.finishedAt) }),
    ...(record.durationMs == null ? {} : { durationMs: Number(record.durationMs) }),
    ...(record.execution === 'server' ? { execution: 'server' as const } : record.execution === 'local' ? { execution: 'local' as const } : {}),
    ...(record.dataVersion == null ? {} : { dataVersion: record.dataVersion as string | number }),
    ...(record.sessionId ? { sessionId: String(record.sessionId) } : {}),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.proposalId ? { proposalId: String(record.proposalId) } : {}),
    ...(record.error ? { error: record.error as { code: string; message: string } } : {}),
  };
}

interface ActiveRun {
  scope: string;
  controller: AbortController;
  state: ReturnType<typeof createRunState>;
}

// Runs live at module level, not per runtime instance: the screen recreates
// the runtime whenever the workspace object identity changes (a background
// sync replaces it every few seconds on a paired account), and a recreated
// runtime must still be able to cancel a run its predecessor started.
const activeRuns = new Map<string, ActiveRun>();

/** The runs this process is executing right now; recovery must not touch them. */
export function activeRunIds(): Set<string> {
  return new Set(activeRuns.keys());
}

export function createLocalRuntime(connection: Connection | null, data: LocalState) {
  const scope = workspaceScope(connection);
  const store = new AgentStore();
  const config = new AgentConfig(store);
  const gateway = new AgentGateway(config, {
    toolName: 'get_workspace_fact',
    arguments: { id: LOCAL_PROFILE },
  });
  const targetVersion = (id: string): number =>
    store.readKv<{ version: number }>(scope, `target:${id}`)?.version ?? 1;
  const task = createLocalTask(data, { targetVersion });
  const tools = createLocalTools(data, { targetVersion });

  function assertMemoryInput(input: { category?: string; value?: unknown }): void {
    if (input.category !== undefined && !isMemoryCategory(input.category)) {
      throw new AgentError('invalid_request', 'unknown memory category');
    }
    if (input.value !== undefined) {
      const size = JSON.stringify(input.value)?.length ?? 0;
      if (size > 4000) throw new AgentError('invalid_request', 'the memory value is too large');
    }
  }

  // Attachments name progress photos this workspace already registered. A
  // bare id is never read as a filesystem path.
  async function resolveAttachments(ids: string[] | undefined): Promise<AgentAttachment[]> {
    if (!ids?.length) return [];
    const uploads = data.photoUploads || [];
    const out: AgentAttachment[] = [];
    for (const id of ids) {
      const upload = uploads.find(item => item.hash === id || item.fileUri === id || item.ref?.hash === id);
      if (!upload) {
        throw new AgentError('invalid_request', 'attachment is not registered in this workspace', {
          details: { id },
        });
      }
      out.push(await readAttachment(id, upload.fileUri));
    }
    return out;
  }

  function proposalCreator(runId: string) {
    return {
      async create(input: Record<string, unknown>): Promise<AgentProposal> {
        const proposal: AgentProposalRow = {
          scope,
          proposalId: ids.proposal(),
          runId,
          kind: String(input.kind),
          changes: Array.isArray(input.changes) ? input.changes : [],
          targetScope: Array.isArray(input.targetScope) ? input.targetScope.map(String) : [],
          ...(input.targetVersion === undefined ? {} : { targetVersion: String(input.targetVersion) }),
          status: 'pending',
          createdAt: Date.now(),
        };
        store.saveProposal(proposal);
        return proposal;
      },
      async discard(proposalId: string) {
        try {
          store.rejectProposal(scope, proposalId);
        } catch {
          // A proposal that was already handled cannot be discarded again;
          // the run's terminal state still wins.
        }
      },
    };
  }

  async function execute(
    run: AgentRunRow,
    profileRef: Record<string, unknown>,
    state: ReturnType<typeof createRunState>,
    controller: AbortController,
    attachments: AgentAttachment[],
  ): Promise<void> {
    try {
      if (state.isTerminal()) return;
      state.start();
      const session = run.sessionId ? store.getSession(scope, run.sessionId) : null;
      if (run.sessionId && !session) {
        state.failed({ code: 'session_deleted', message: 'the conversation was deleted' });
        store.finishRun(rowOf(state.record() as unknown as Record<string, unknown>, scope));
        return;
      }
      const budgets = withRunDefaults(task.budgets);
      const taskCategories = task.memoryCategories;
      const history = (session?.messages || []).slice(-budgets.historyItems).map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      }));
      const memories = selectMemories(store.listMemories(scope), {
        scope,
        ...(Array.isArray(taskCategories) && taskCategories.length ? { kinds: taskCategories } : {}),
        limit: budgets.memoryItems,
        maxChars: 4000,
      });
      const input = (run as AgentRunRow & { input?: Record<string, unknown> }).input || {};
      const prompt = String(input.prompt || '');
      const context = bindContext({
        scope,
        runId: run.runId,
        request: {
          taskId: task.id,
          requestId: run.requestId,
          profileId: run.profileId,
          input,
        },
        execution: 'local',
        profileRef,
        dataVersion: 1,
        targetScope: [],
        signal: controller.signal,
        memories,
        history,
        meta: { connection, prompt, ...(attachments.length ? { attachments } : {}) },
        ids,
      });
      const result = await runAgent({
        task,
        request: {
          taskId: task.id,
          requestId: run.requestId,
          profileId: run.profileId,
          input,
        },
        context,
        gateway: gateway.forScope(scope),
        tools: tools.tools,
        proposals: proposalCreator(run.runId),
        state,
        signal: controller.signal,
      });
      if (session && state.status() === 'completed') {
        const payload = result?.result;
        const assistant = typeof payload?.text === 'string'
          ? payload.text
          : payload?.structured
            ? JSON.stringify(payload.structured)
            : '';
        try {
          store.appendMessages(scope, session.id, [
            { id: randomUUID(), role: 'user', content: prompt, createdAt: Date.now(), runId: run.runId },
            { id: randomUUID(), role: 'assistant', content: assistant, createdAt: Date.now(), runId: run.runId },
          ]);
        } catch (error) {
          if (!(error instanceof AgentError) || error.code !== 'session_deleted') throw error;
        }
      }
      store.finishRun(rowOf(state.record() as unknown as Record<string, unknown>, scope));
    } catch (error) {
      if (!state.isTerminal()) {
        state.failed({
          code: error instanceof AgentError ? error.code : 'model_unavailable',
          message: error instanceof Error ? error.message : 'run failed',
        });
      }
      try { store.finishRun(rowOf(state.record() as unknown as Record<string, unknown>, scope)); } catch { /* already gone */ }
    } finally {
      activeRuns.delete(state.runId);
    }
  }

  const runtime = {
    scope,
    store,
    config,
    gateway,

    async start(input: AgentStartInput): Promise<AgentRunRow> {
      if (!validRequestId(input.requestId)) throw new AgentError('invalid_request', 'requestId is invalid');
      if (!input.profileId) throw new AgentError('invalid_request', 'profileId is required');
      if (!input.input || typeof input.input !== 'object' || Array.isArray(input.input)) {
        throw new AgentError('invalid_request', 'input must be an object');
      }
      if (input.attachmentIds !== undefined && !Array.isArray(input.attachmentIds)) {
        throw new AgentError('invalid_request', 'attachmentIds must be an array');
      }
      if ((input.attachmentIds?.length || 0) > 4) {
        throw new AgentError('invalid_request', 'at most four attachments are allowed');
      }
      if (task.inputSchema) assertValid(task.inputSchema, input.input, '$.input', 'invalid_request');
      const hash = await fingerprint({
        taskId: task.id,
        profileId: input.profileId,
        input: input.input,
        sessionId: input.sessionId,
        attachmentIds: input.attachmentIds,
      });
      // Idempotency comes before profile, session or attachment work: a retry
      // must still find its original run if any of them changed in between.
      const known = store.findRun(scope, input.requestId, hash);
      if (known) return known;
      const resolved = await config.resolve(scope, input.profileId);
      const attachments = await resolveAttachments(input.attachmentIds);
      const session = input.sessionId ? store.ensureSession(scope, input.sessionId) : null;
      const runId = ids.run();
      const run: AgentRunRow & {
        input?: Record<string, unknown>;
        attachments?: AgentAttachment[];
        execution?: 'local';
        dataVersion?: string | number;
      } = {
        scope,
        runId,
        requestId: input.requestId,
        requestHash: hash,
        taskId: task.id,
        profileId: input.profileId,
        status: 'accepted',
        createdAt: Date.now(),
        execution: 'local',
        dataVersion: 1,
        ...(session ? { sessionId: session.id } : {}),
        input: input.input,
        ...(attachments.length ? { attachments } : {}),
      };
      const begun = store.beginRun(run);
      if (!begun.created) return begun.run;
      const controller = new AbortController();
      const state = createRunState(
        { ...rowOf(begun.run as unknown as Record<string, unknown>, scope), execution: 'local' },
        {
          onChange: record => {
            try { store.updateRun(rowOf(record as unknown as Record<string, unknown>, scope)); } catch { /* terminal write wins */ }
          },
        },
      );
      activeRuns.set(runId, { scope, controller, state });
      execute(begun.run, resolved.profile as unknown as Record<string, unknown>, state, controller, attachments)
        .catch(() => undefined);
      return run;
    },

    get(runId: string): AgentRunRow | null {
      return store.getRun(scope, runId);
    },

    cancel(runId: string): AgentRunRow | null {
      const current = store.getRun(scope, runId);
      if (!current) throw new AgentError('run_not_found', undefined, { details: { runId } });
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) return current;
      const running = activeRuns.get(runId);
      const finished = running
        ? (() => {
            running.state.cancel('cancelled by the user');
            running.controller.abort();
            return store.finishRun(rowOf(running.state.record() as unknown as Record<string, unknown>, scope));
          })()
        : store.finishRun({
            ...current,
            status: 'cancelled' as const,
            finishedAt: Date.now(),
            durationMs: Math.max(0, Date.now() - (current.startedAt || current.createdAt || Date.now())),
            error: { code: 'run_cancelled', message: 'cancelled by the user' },
          });
      try { store.expireProposalsForRun(scope, runId); } catch { /* confirm gate remains */ }
      return finished;
    },

    profiles: () => config.list(scope),
    createProfile: (input: Parameters<AgentConfig['create']>[1]) => config.create(scope, input),
    updateProfile: (id: string, input: Parameters<AgentConfig['update']>[2]) => config.update(scope, id, input),
    removeProfile: (id: string) => config.remove(scope, id),

    sessions(): AgentSessionSummary[] {
      return store.listSessions(scope);
    },

    session(id: string) {
      return store.getSession(scope, id);
    },

    deleteSession(id: string): boolean {
      return store.deleteSession(scope, id);
    },

    memories(): AgentMemory[] {
      return store.listMemories(scope);
    },

    saveMemory(input: { category: string; value: unknown; source?: string }): AgentMemory {
      assertMemoryInput(input);
      if (input.value === undefined) throw new AgentError('invalid_request', 'a memory needs a value');
      const now = Date.now();
      const memory: AgentMemory = {
        id: store.newId('mem'),
        scope,
        category: input.category,
        value: input.value,
        ...(input.source ? { source: input.source } : {}),
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      return store.saveMemory(scope, memory);
    },

    updateMemory(id: string, patch: { category?: string; value?: unknown; source?: string }): AgentMemory {
      assertMemoryInput(patch);
      if (patch.category === undefined && patch.value === undefined && patch.source === undefined) {
        throw new AgentError('invalid_request', 'no memory change was supplied');
      }
      return store.updateMemory(scope, id, patch);
    },

    deleteMemory(id: string): boolean {
      return store.deleteMemory(scope, id);
    },

    confirmProposal(proposalId: string) {
      const current = store.getProposal(scope, proposalId);
      if (!current) throw new AgentError('proposal_not_found', undefined, { details: { proposalId } });
      if (current.status === 'pending' && current.runId) {
        const source = store.getRun(scope, current.runId);
        if (!source || source.status !== 'completed') {
          throw new AgentError('proposal_consumed', 'the run that produced this proposal did not complete', {
            details: { proposalId, runId: current.runId, runStatus: source?.status },
          });
        }
      }
      return store.confirmProposal(scope, proposalId, proposal => {
        if (proposal.kind === 'memory.save') {
          const change = proposal.changes[0] as { category?: string; value?: unknown; source?: string } | undefined;
          if (!change || !change.category || change.value === undefined) {
            throw new AgentError('invalid_request', 'the memory proposal is invalid');
          }
          const memory = runtime.saveMemory({ category: change.category, value: change.value, source: change.source });
          return { memoryId: memory.id };
        }
        if (proposal.kind !== 'workspace.write' && proposal.kind !== 'stub.write') {
          throw new AgentError('invalid_request', `unknown proposal kind: ${proposal.kind}`);
        }
        const targetId = proposal.targetScope[0] || LOCAL_PROFILE;
        const current = store.readKv<{ version: number; value: string }>(scope, `target:${targetId}`)
          || { version: 1, value: 'local stub target' };
        if (proposal.targetVersion !== undefined && String(proposal.targetVersion) !== String(current.version)) {
          throw new AgentError('proposal_conflict', 'the target changed after the proposal was made', {
            details: { expected: proposal.targetVersion, current: current.version },
          });
        }
        const changes = proposal.changes as { field?: string; value?: unknown }[];
        const value = changes.find(change => change.field === 'note' || change.field === 'value')?.value;
        const next = { version: current.version + 1, value: String(value ?? current.value) };
        store.writeKv(scope, `target:${targetId}`, next);
        return { targetId, ...next };
      });
    },

    rejectProposal(proposalId: string) {
      return store.rejectProposal(scope, proposalId);
    },

    recover(): number {
      return store.markInterrupted(scope, activeRunIds());
    },
  };

  return runtime;
}

export type LocalAgentRuntime = ReturnType<typeof createLocalRuntime>;
