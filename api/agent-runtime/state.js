/* Run state machine.
 *
 * accepted -> running -> completed | failed | cancelled | interrupted.
 * A terminal state is written exactly once. Cancellation commits its state
 * before the host aborts the model call, and acceptResult() is the gate the
 * orchestrator uses to discard a late answer.
 */
import { AgentError } from './errors.js';
import { isTerminalStatus } from './contracts.js';

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

/**
 * @param {import('./contracts.js').RunRecord} initial
 * @param {{ now?: () => number, onChange?: (record: import('./contracts.js').RunRecord) => void }} [options]
 */
export function createRunState(initial, options = {}) {
  const { now = Date.now, onChange } = options;
  if (!initial || typeof initial.runId !== 'string' || !initial.runId) {
    throw new AgentError('invalid_request', 'a run record needs a runId');
  }
  let current = cloneRecord(initial);
  if (!current.status) current.status = 'accepted';

  const commit = patch => {
    current = { ...current, ...patch };
    if (onChange) onChange(cloneRecord(current));
    return cloneRecord(current);
  };

  /**
   * @param {'running'|'completed'|'failed'|'cancelled'|'interrupted'} status
   * @param {Record<string, unknown>} [patch]
   */
  function transition(status, patch = {}) {
    if (isTerminalStatus(current.status)) {
      throw new AgentError('run_terminal', 'run already reached a terminal state', {
        details: { runId: current.runId, status: current.status },
      });
    }
    if (status === 'running' && current.status !== 'accepted') {
      throw new AgentError('invalid_request', `cannot start a run from ${current.status}`);
    }
    if (current.status === 'accepted' && status !== 'running' && !isTerminalStatus(status)) {
      throw new AgentError('invalid_request', `invalid transition ${current.status} -> ${status}`);
    }
    const at = now();
    if (isTerminalStatus(status)) {
      return commit({
        ...patch,
        status,
        finishedAt: at,
        durationMs: Math.max(0, at - (current.startedAt || current.createdAt || at)),
      });
    }
    return commit({ ...patch, status, ...(status === 'running' ? { startedAt: at } : {}) });
  }

  return {
    get runId() {
      return current.runId;
    },
    status: () => current.status,
    isTerminal: () => isTerminalStatus(current.status),
    record: () => cloneRecord(current),
    start() {
      if (current.status === 'running') return cloneRecord(current);
      return transition('running');
    },
    completed(result) {
      if (isTerminalStatus(current.status)) {
        throw new AgentError('run_terminal', 'late result cannot change a terminal run', {
          details: { runId: current.runId, status: current.status },
        });
      }
      return transition('completed', result === undefined ? {} : { result });
    },
    failed(error) {
      if (isTerminalStatus(current.status)) {
        throw new AgentError('run_terminal', 'failure cannot change a terminal run', {
          details: { runId: current.runId, status: current.status },
        });
      }
      return transition('failed', { error: error || { code: 'invalid_request', message: 'run failed' } });
    },
    cancel(reason) {
      if (isTerminalStatus(current.status)) return cloneRecord(current);
      return transition('cancelled', reason ? { error: { code: 'run_cancelled', message: reason } } : {});
    },
    interrupted(reason) {
      if (isTerminalStatus(current.status)) return cloneRecord(current);
      return transition('interrupted', reason ? { error: { code: 'run_terminal', message: reason } } : {});
    },
    acceptResult() {
      return !isTerminalStatus(current.status);
    },
  };
}
