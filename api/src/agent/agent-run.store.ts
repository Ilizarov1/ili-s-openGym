/* Run records, request idempotency and boot interruption. */
import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { AgentError } from '../../agent-runtime/errors.js';
import { isTerminalStatus } from '../../agent-runtime/contracts.js';
import type { AgentStoredRun } from './agent.types.js';
import { AgentStore } from './agent.store.js';

export const AI_RUN_TTL_MS = 60 * 60 * 1000;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = canonical((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function requestFingerprint(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

@Injectable()
export class AgentRunStore {
  constructor(private readonly store: AgentStore) {}

  get(uid: string, runId: string): AgentStoredRun | null {
    return this.store.read(uid).runs[runId] || null;
  }

  /** The pre-check a retry hits before any profile or session work happens:
   *  the original job if the fingerprint matches, a conflict if it does not.
   *  begin() below stays authoritative for concurrent first submissions. */
  find(uid: string, requestId: string, requestHash: string): AgentStoredRun | null {
    const data = this.store.read(uid);
    const knownId = data.requestIndex[requestId];
    if (!knownId) return null;
    const existing = data.runs[knownId];
    if (!existing) return null;
    if (existing.requestHash !== requestHash) {
      throw new AgentError('request_conflict', 'this request id was already used with different input', {
        details: { requestId, runId: existing.runId },
      });
    }
    return existing;
  }

  async begin(
    uid: string,
    run: AgentStoredRun,
    options: { maxTurns?: number } = {},
  ): Promise<{ run: AgentStoredRun; created: boolean }> {
    return this.store.update(uid, data => {
      const knownId = data.requestIndex[run.requestId];
      if (knownId) {
        const existing = data.runs[knownId];
        if (!existing) {
          delete data.requestIndex[run.requestId];
        } else if (existing.requestHash !== run.requestHash) {
          throw new AgentError('request_conflict', 'this request id was already used with different input', {
            details: { requestId: run.requestId, runId: existing.runId },
          });
        } else {
          return { run: existing, created: false };
        }
      }
      if (run.sessionId) {
        const active = Object.values(data.runs).find(candidate =>
          candidate.sessionId === run.sessionId
          && candidate.taskId === run.taskId
          && (candidate.status === 'accepted' || candidate.status === 'running'));
        if (active) {
          throw new AgentError('session_busy', 'another run is active in this conversation', {
            details: { sessionId: run.sessionId, runId: active.runId },
          });
        }
        const session = data.sessions[run.sessionId];
        const counted = Number(session?.meta?.turns);
        const turns = Number.isFinite(counted) && counted >= 0
          ? counted
          : Object.values(data.runs).filter(candidate =>
            candidate.sessionId === run.sessionId && candidate.taskId === run.taskId).length;
        if (options.maxTurns !== undefined && turns >= options.maxTurns) {
          throw new AgentError('turn_limit', 'this conversation has used all its follow-up turns', {
            details: { sessionId: run.sessionId, turns, limit: options.maxTurns },
          });
        }
        if (session) session.meta = { ...(session.meta || {}), turns: turns + 1 };
      }
      data.runs[run.runId] = run;
      data.requestIndex[run.requestId] = run.runId;
      return { run, created: true };
    });
  }

  async replace(uid: string, record: AgentStoredRun): Promise<AgentStoredRun> {
    return this.store.update(uid, data => {
      const current = data.runs[record.runId];
      if (!current) throw new AgentError('run_not_found', undefined, { details: { runId: record.runId } });
      if (isTerminalStatus(current.status)) return current;
      data.runs[record.runId] = { ...current, ...record };
      return data.runs[record.runId];
    });
  }

  async finish(uid: string, runId: string, patch: Partial<AgentStoredRun>): Promise<AgentStoredRun> {
    return this.store.update(uid, data => {
      const current = data.runs[runId];
      if (!current) throw new AgentError('run_not_found', undefined, { details: { runId } });
      if (isTerminalStatus(current.status)) return current;
      data.runs[runId] = { ...current, ...patch };
      return data.runs[runId];
    });
  }

  async cancel(uid: string, runId: string, message = 'cancelled by the user'): Promise<AgentStoredRun> {
    return this.store.update(uid, data => {
      const current = data.runs[runId];
      if (!current) throw new AgentError('run_not_found', undefined, { details: { runId } });
      if (isTerminalStatus(current.status)) return current;
      const at = Date.now();
      data.runs[runId] = {
        ...current,
        status: 'cancelled',
        finishedAt: at,
        durationMs: Math.max(0, at - (current.startedAt || current.createdAt || at)),
        error: { code: 'run_cancelled', message },
      };
      return data.runs[runId];
    });
  }

  activeForSession(uid: string, taskId: string, sessionId: string): AgentStoredRun | null {
    const data = this.store.read(uid);
    return Object.values(data.runs).find(run =>
      run.taskId === taskId
      && run.sessionId === sessionId
      && (run.status === 'accepted' || run.status === 'running')) || null;
  }

  /** AI runs are only a short polling/retry window. The request index is
   *  removed with them; stub runs are not touched. */
  async purgeExpired(uid: string, now = Date.now()): Promise<number> {
    return this.store.update(uid, data => {
      let removed = 0;
      for (const [runId, run] of Object.entries(data.runs)) {
        if (!run.taskId.startsWith('exercise-search.')) continue;
        const at = run.finishedAt || run.createdAt || 0;
        if (now - at < AI_RUN_TTL_MS) continue;
        delete data.runs[runId];
        removed++;
      }
      if (removed) {
        for (const [requestId, runId] of Object.entries(data.requestIndex)) {
          if (!data.runs[runId]) delete data.requestIndex[requestId];
        }
      }
      return removed;
    });
  }

  async markInterrupted(uid: string): Promise<number> {
    return this.store.update(uid, data => {
      let count = 0;
      const at = Date.now();
      const interrupted = new Set<string>();
      for (const run of Object.values(data.runs)) {
        if (run.status !== 'accepted' && run.status !== 'running') continue;
        run.status = 'interrupted';
        run.finishedAt = at;
        run.durationMs = Math.max(0, at - (run.startedAt || run.createdAt || at));
        run.error = { code: 'run_interrupted', message: 'the server restarted before the run finished' };
        interrupted.add(run.runId);
        count++;
      }
      // A proposal saved just before the crash cannot outlive its interrupted run.
      for (const proposal of Object.values(data.proposals)) {
        if (!interrupted.has(proposal.runId || '') || proposal.status !== 'pending') continue;
        proposal.status = 'expired';
        proposal.rejectedAt = at;
      }
      return count;
    });
  }
}
