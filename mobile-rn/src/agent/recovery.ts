// Startup recovery for local agent runs. A foreground process that died with
// an accepted/running run cannot resume it; keep the records and mark them.
// Runs this process is still executing stay untouched.
import { AgentStore } from './store';
import { workspaceScope } from '../storage';
import type { Connection } from '../server';

export function recoverAgentRuns(connection: Connection | null, excludeRunIds?: Set<string>): number {
  return new AgentStore().markInterrupted(workspaceScope(connection), excludeRunIds);
}
