// Server execution from the phone: the same /api/agent routes Web uses, with
// the paired connection's Bearer token.
import type { Connection } from '../server';
import type {
  AgentMemory, AgentProfileInput, AgentProfilePublic, AgentProposal, AgentRunRow, AgentSession,
  AgentSessionSummary, AgentStartInput,
} from './types';

const POLL_MS = 2000;

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

    startRun: (input: AgentStartInput) => request<{ runId: string; status: string }>(connection, '/runs', 'POST', { taskId: 'stub.v1', ...input }),
    getRun: (runId: string) => request<AgentRunRow>(connection, `/runs/${encodeURIComponent(runId)}`),
    cancelRun: (runId: string) => request<AgentRunRow>(connection, `/runs/${encodeURIComponent(runId)}/cancel`, 'POST'),

    sessions: () => request<{ sessions: AgentSessionSummary[] }>(connection, '/sessions').then(data => data.sessions || []),
    session: (id: string) => request<AgentSession>(connection, `/sessions/${encodeURIComponent(id)}`),
    deleteSession: (id: string) => request<{ ok: boolean }>(connection, `/sessions/${encodeURIComponent(id)}`, 'DELETE'),

    memories: () => request<{ memories: AgentMemory[] }>(connection, '/memories').then(data => data.memories || []),
    saveMemory: (input: { category: string; value: unknown; source?: string }) => request<AgentMemory>(connection, '/memories', 'POST', input),
    deleteMemory: (id: string) => request<{ ok: boolean }>(connection, `/memories/${encodeURIComponent(id)}`, 'DELETE'),

    confirmProposal: (id: string) => request<{ proposal: AgentProposal; result: unknown; applied: boolean }>(connection, `/proposals/${encodeURIComponent(id)}/confirm`, 'POST'),
    rejectProposal: (id: string) => request<AgentProposal>(connection, `/proposals/${encodeURIComponent(id)}/reject`, 'POST'),

    async pollRun(runId: string, onRun: (run: AgentRunRow) => void, signal?: AbortSignal): Promise<AgentRunRow> {
      for (;;) {
        if (signal?.aborted) throw new Error('cancelled');
        const run = await this.getRun(runId);
        onRun(run);
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return run;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, POLL_MS);
          if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true });
        });
      }
    },
  };
}

export type ServerAgent = ReturnType<typeof createServerAgent>;
