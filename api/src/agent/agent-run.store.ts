/* Run records, request idempotency and boot interruption. */
import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { AgentError } from '../../agent-runtime/errors.js';
import { isTerminalStatus } from '../../agent-runtime/contracts.js';
import type { AgentStoredRun } from './agent.types.js';
import { AgentStore } from './agent.store.js';

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

  async begin(uid: string, run: AgentStoredRun): Promise<{ run: AgentStoredRun; created: boolean }> {
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

  async markInterrupted(uid: string): Promise<number> {
    return this.store.update(uid, data => {
      let count = 0;
      const at = Date.now();
      for (const run of Object.values(data.runs)) {
        if (run.status !== 'accepted' && run.status !== 'running') continue;
        run.status = 'interrupted';
        run.finishedAt = at;
        run.durationMs = Math.max(0, at - (run.startedAt || run.createdAt || at));
        run.error = { code: 'run_terminal', message: 'the server restarted before the run finished' };
        count++;
      }
      return count;
    });
  }
}
