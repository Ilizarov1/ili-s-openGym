// The local executor: shared run orchestration + SQLite + SecureStore + RN fetch.
// A run captures its workspace scope and workspace snapshot at start; switching
// workspaces later cannot move the result or read another workspace's data.
import * as Crypto from 'expo-crypto';
import { randomUUID } from 'expo-crypto';
import {
  AgentError,
  bindContext,
  createIds,
  createRunState,
  runAgent,
  selectMemories,
  validRequestId,
} from './shared';
import type { AgentMemory, AgentProposal, AgentProposalRow, AgentRunRow, AgentSessionSummary, AgentStartInput } from './types';
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

export function createLocalRuntime(connection: Connection | null, data: LocalState) {
  const scope = workspaceScope(connection);
  const store = new AgentStore();
  const config = new AgentConfig(store);
  const gateway = new AgentGateway(config);
  const task = createLocalTask(data);
  const tools = createLocalTools(data);
  const active = new Map<string, ActiveRun>();

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
    };
  }

  async function execute(run: AgentRunRow, profileRef: Record<string, unknown>, state: ReturnType<typeof createRunState>, controller: AbortController): Promise<void> {
    try {
      if (state.isTerminal()) return;
      state.start();
      const session = run.sessionId ? store.getSession(scope, run.sessionId) : null;
      if (run.sessionId && !session) {
        state.cancel('the conversation was deleted');
        store.finishRun(rowOf(state.record() as unknown as Record<string, unknown>, scope));
        return;
      }
      const history = (session?.messages || []).slice(-8).map(message => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
      }));
      const memories = selectMemories(store.listMemories(scope), { limit: 8, maxChars: 4000 });
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
        meta: { connection, prompt },
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
      active.delete(state.runId);
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
      if (!input.input || typeof input.input !== 'object') throw new AgentError('invalid_request', 'input must be an object');
      const resolved = await config.resolve(scope, input.profileId);
      const session = input.sessionId ? store.ensureSession(scope, input.sessionId) : null;
      const runId = ids.run();
      const hash = await fingerprint({
        taskId: task.id,
        profileId: input.profileId,
        input: input.input,
        sessionId: input.sessionId,
        attachmentIds: input.attachmentIds,
      });
      const run: AgentRunRow & { input?: Record<string, unknown> } = {
        scope,
        runId,
        requestId: input.requestId,
        requestHash: hash,
        taskId: task.id,
        profileId: input.profileId,
        status: 'accepted',
        createdAt: Date.now(),
        ...(session ? { sessionId: session.id } : {}),
        input: input.input,
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
      active.set(runId, { scope, controller, state });
      execute(begun.run, resolved.profile as unknown as Record<string, unknown>, state, controller)
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
      const running = active.get(runId);
      if (running) {
        running.state.cancel('cancelled by the user');
        running.controller.abort();
        return store.finishRun(rowOf(running.state.record() as unknown as Record<string, unknown>, scope));
      }
      const cancelled = { ...current, status: 'cancelled' as const, finishedAt: Date.now(), error: { code: 'run_cancelled', message: 'cancelled by the user' } };
      return store.finishRun(cancelled);
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
      const now = Date.now();
      const memory: AgentMemory = {
        id: store.newId('mem'),
        category: input.category,
        value: input.value,
        ...(input.source ? { source: input.source } : {}),
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      return store.saveMemory(scope, memory);
    },

    deleteMemory(id: string): boolean {
      return store.deleteMemory(scope, id);
    },

    confirmProposal(proposalId: string) {
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
      return store.markInterrupted(scope);
    },
  };

  return runtime;
}

export type LocalAgentRuntime = ReturnType<typeof createLocalRuntime>;
