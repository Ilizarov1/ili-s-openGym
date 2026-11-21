// Startup recovery for local agent runs. A foreground process that died with
// an accepted/running run cannot resume it; keep the records and mark them.
// Runs this process is still executing stay untouched.
import { EXERCISE_SEARCH_TASK_ID } from './shared';
import { AgentStore } from './store';
import { workspaceScope } from '../storage';
import type { Connection } from '../server';
import type { AgentExecutionLocation, AgentRunRow } from './types';

const REF_KEY = 'ai-search:last-run';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export type AiRunReference = {
  runId: string;
  sessionId?: string;
  location: AgentExecutionLocation;
  taskId: string;
  status: string;
  createdAt: number;
  /** Set by startup recovery when the process died mid-run. */
  interrupted?: boolean;
};

export type AiRunRecovery = AiRunReference & {
  /** True while the stored run is not terminal. */
  unfinished: boolean;
  /** True when startup recovery found this reference mid-run. */
  needsAttention: boolean;
  run: AgentRunRow | null;
};

function readReference(scope: string): AiRunReference | null {
  const value = new AgentStore().readKv<AiRunReference | null>(scope, REF_KEY);
  return value && typeof value === 'object' && typeof value.runId === 'string' ? value : null;
}

/** Record the newest AI run before its first await; cleared at terminal. */
export function rememberAiRun(scope: string, reference: AiRunReference): void {
  new AgentStore().writeKv(scope, REF_KEY, reference);
}

/** Update or clear the reference when its run reaches a terminal state. */
export function settleAiRun(scope: string, run: AgentRunRow): void {
  const store = new AgentStore();
  const current = store.readKv<AiRunReference | null>(scope, REF_KEY);
  if (!current || current.runId !== run.runId) return;
  if (TERMINAL.has(run.status)) {
    // A terminal run needs no restart prompt; the reference has served its
    // purpose. Keep the row itself in SQLite for diagnostics.
    store.writeKv(scope, REF_KEY, null);
    return;
  }
  store.writeKv(scope, REF_KEY, {
    ...current,
    status: run.status,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
  });
}

export function recoverAgentRuns(connection: Connection | null, excludeRunIds?: Set<string>): number {
  const scope = workspaceScope(connection);
  const store = new AgentStore();
  const interrupted = store.markInterrupted(scope, excludeRunIds);
  // Temporary AI sessions follow the same two-hour window as the server; the
  // delete removes their messages and images. Orphan images need a second
  // pass because a session row may have been removed outside this host.
  store.expireAiSessions(scope, EXERCISE_SEARCH_TASK_ID, Date.now() - 2 * 60 * 60 * 1000);
  store.cleanupAiImages();
  const reference = readReference(scope);
  if (reference && !TERMINAL.has(reference.status)) {
    store.writeKv(scope, REF_KEY, { ...reference, status: 'interrupted', interrupted: true });
  }
  return interrupted;
}

/**
 * The latest local AI run the recognition view should mention after a restart.
 * `needsAttention` is true for a run recovery interrupted; a terminal run that
 * simply finished does not trigger the prompt.
 */
export function latestAiRunReference(connection: Connection | null): AiRunRecovery | null {
  const scope = workspaceScope(connection);
  const store = new AgentStore();
  const reference = readReference(scope);
  const run = reference
    ? store.getRun(scope, reference.runId)
    : store.latestRun(scope, EXERCISE_SEARCH_TASK_ID);
  if (!reference && !run) return null;
  const status = run?.status || reference?.status || 'interrupted';
  const base: AiRunReference = reference || {
    runId: run?.runId || '',
    ...(run?.sessionId ? { sessionId: run.sessionId } : {}),
    location: 'local',
    taskId: run?.taskId || EXERCISE_SEARCH_TASK_ID,
    status,
    createdAt: run?.createdAt || Date.now(),
  };
  return {
    ...base,
    status,
    ...(run?.sessionId ? { sessionId: run.sessionId } : {}),
    unfinished: !TERMINAL.has(status),
    needsAttention: reference?.interrupted === true || !TERMINAL.has(status),
    run,
  };
}

export function clearAiRunReference(
  connection: Connection | null,
  expected?: { runId?: string; sessionId?: string },
): void {
  const store = new AgentStore();
  const scope = workspaceScope(connection);
  if (expected) {
    const current = store.readKv<AiRunReference | null>(scope, REF_KEY);
    if (!current) return;
    if (expected.runId && current.runId !== expected.runId) return;
    if (expected.sessionId && current.sessionId !== expected.sessionId) return;
  }
  store.writeKv(scope, REF_KEY, null);
}
