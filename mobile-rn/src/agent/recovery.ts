// Startup recovery for local agent runs. A foreground process that died with
// an accepted/running run cannot resume it; keep the records and mark them.
import { AgentStore } from './store';
import { workspaceScope } from '../storage';
import type { Connection } from '../server';

export function recoverAgentRuns(connection: Connection | null): number {
  return new AgentStore().markInterrupted(workspaceScope(connection));
}
