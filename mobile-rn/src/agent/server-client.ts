// Server execution from the phone: the same /api/agent routes Web uses, with
// the paired connection's Bearer token.
import type { Connection } from '../server';
import type {
  AgentMemory, AgentProfileInput, AgentProfilePublic, AgentProfileSummary, AgentProposal, AgentRunRow, AgentSession,
  AgentSessionSummary, AgentStartInput,
} from './types';

const POLL_MS = 2000;

function summaryOf(value: unknown): AgentProfileSummary | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id) return undefined;
  return {
    id: raw.id,
    label: String(raw.label || raw.provider || raw.id),
    provider: String(raw.provider || ''),
    model: String(raw.model || ''),
    version: Number(raw.version || 1),
  };
}

/** The server returns only the stored run; give it the local row shape. */
function runOf(value: unknown): AgentRunRow {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const profile = summaryOf(raw.profile);
  return {
    scope: '',
    runId: String(raw.runId || ''),
    requestId: String(raw.requestId || ''),
    requestHash: String(raw.requestHash || ''),
    taskId: String(raw.taskId || ''),
    profileId: String(raw.profileId || ''),
    status: String(raw.status || 'accepted') as AgentRunRow['status'],
    createdAt: Number(raw.createdAt || Date.now()),
    ...(raw.startedAt == null ? {} : { startedAt: Number(raw.startedAt) }),
    ...(raw.finishedAt == null ? {} : { finishedAt: Number(raw.finishedAt) }),
    ...(raw.durationMs == null ? {} : { durationMs: Number(raw.durationMs) }),
    execution: 'server',
    ...(raw.dataVersion == null ? {} : { dataVersion: raw.dataVersion as string | number }),
    ...(raw.sessionId ? { sessionId: String(raw.sessionId) } : {}),
    ...(profile ? { profile } : {}),
    ...(raw.result === undefined ? {} : { result: raw.result }),
    ...(raw.proposalId ? { proposalId: String(raw.proposalId) } : {}),
    ...(raw.error && typeof raw.error === 'object'
      ? { error: raw.error as { code: string; message: string } }
      : {}),
  };
}

async function request<T>(connection: Connection, path: string, method = 'GET', body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${connection.server}/api/agent${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${connection.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const error = new Error(
        data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
          ? String((data as { error: string }).error)
          : `HTTP ${response.status}`,
      ) as Error & { code?: string; status: number };
      error.status = response.status;
      if (data && typeof data === 'object' && typeof (data as { code?: unknown }).code === 'string') {
        error.code = String((data as { code: string }).code);
      }
      throw error;
    }
    return data as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The server did not answer in time.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createServerAgent(connection: Connection) {
  return {
    async profiles(): Promise<AgentProfilePublic[]> {
      const data = await request<{ profiles: AgentProfilePublic[] }>(connection, '/configs');
      return data.profiles || [];
    },
    createProfile: (input: AgentProfileInput) => request<AgentProfilePublic>(connection, '/configs', 'POST', input),
    updateProfile: (id: string, input: AgentProfileInput) => request<AgentProfilePublic>(connection, `/configs/${encodeURIComponent(id)}`, 'PATCH', input),
    removeProfile: (id: string) => request<{ ok: boolean }>(connection, `/configs/${encodeURIComponent(id)}`, 'DELETE'),

    async startRun(input: AgentStartInput): Promise<AgentRunRow & { profile?: AgentProfileSummary }> {
      const data = await request<Record<string, unknown>>(connection, '/runs', 'POST', {
        ...(input.taskId ? { taskId: input.taskId } : {}),
        requestId: input.requestId,
        profileId: input.profileId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
        input: input.input,
        ...(input.attachmentIds ? { attachmentIds: input.attachmentIds } : {}),
      });
      return {
        ...runOf({ ...data, status: data.status || 'accepted' }),
        ...(summaryOf(data.profile) ? { profile: summaryOf(data.profile) } : {}),
      };
    },
    async getRun(runId: string): Promise<AgentRunRow> {
      // Re-querying by run id is the disconnect path: the server keeps the run
      // for its polling window, so a dropped connection can always resume.
      return runOf(await request<unknown>(connection, `/runs/${encodeURIComponent(runId)}`));
    },
    async cancelRun(runId: string): Promise<AgentRunRow> {
      return runOf(await request<unknown>(connection, `/runs/${encodeURIComponent(runId)}/cancel`, 'POST'));
    },

    sessions: () => request<{ sessions: AgentSessionSummary[] }>(connection, '/sessions').then(data => data.sessions || []),
    session: (id: string) => request<AgentSession>(connection, `/sessions/${encodeURIComponent(id)}`),
    deleteSession: (id: string) => request<{ ok: boolean }>(connection, `/sessions/${encodeURIComponent(id)}`, 'DELETE'),

    memories: () => request<{ memories: AgentMemory[] }>(connection, '/memories').then(data => data.memories || []),
    saveMemory: (input: { category: string; value: unknown; source?: string }) => request<AgentMemory>(connection, '/memories', 'POST', input),
    updateMemory: (id: string, input: { category?: string; value?: unknown; source?: string }) => request<AgentMemory>(connection, `/memories/${encodeURIComponent(id)}`, 'PATCH', input),
    deleteMemory: (id: string) => request<{ ok: boolean }>(connection, `/memories/${encodeURIComponent(id)}`, 'DELETE'),

    confirmProposal: (id: string) => request<{ proposal: AgentProposal; result: unknown; applied: boolean }>(connection, `/proposals/${encodeURIComponent(id)}/confirm`, 'POST'),
    rejectProposal: (id: string) => request<AgentProposal>(connection, `/proposals/${encodeURIComponent(id)}/reject`, 'POST'),

    async status(): Promise<{ enabled: boolean }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      try {
        const response = await fetch(`${connection.server}/api/config`, {
          signal: controller.signal,
          headers: { Accept: 'application/json', Authorization: `Bearer ${connection.token}` },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { agent?: { enabled?: boolean } };
        return { enabled: data.agent?.enabled !== false };
      } finally {
        clearTimeout(timer);
      }
    },

    async pollRun(runId: string, onRun: (run: AgentRunRow) => void, signal?: AbortSignal): Promise<AgentRunRow> {
      let failures = 0;
      for (;;) {
        if (signal?.aborted) throw new Error('cancelled');
        try {
          const run = await this.getRun(runId);
          failures = 0;
          onRun(run);
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return run;
        } catch (error) {
          // A dropped connection is not a dropped run: the server keeps it for
          // the polling window, so re-query the same id before giving up.
          const status = (error as { status?: number }).status;
          if (status === 401 || status === 403) throw error;
          failures += 1;
          if (failures >= 5) throw error;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
          }, POLL_MS);
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('cancelled'));
          };
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
    },
  };
}

export type ServerAgent = ReturnType<typeof createServerAgent>;
