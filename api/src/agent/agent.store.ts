/* One agent document per account, serialized per uid.
 *
 * The API is a single writer. Reads parse the file; updates run one at a time
 * behind a per-account promise chain and write atomically with mode 0600.
 */
import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import { AgentError } from '../../agent-runtime/errors.js';
import type { AgentAccountData } from './agent.types.js';
import { AtomicWriter } from '../common/persistence/atomic-write.js';
import { Paths } from '../common/persistence/paths.js';

const SCHEMA = 1;

export function emptyAgentData(): AgentAccountData {
  return {
    schema: SCHEMA,
    profiles: {},
    runs: {},
    requestIndex: {},
    sessions: {},
    memories: {},
    proposals: {},
    stub: {
      targets: {
        'target-1': { id: 'target-1', version: 1, value: 'first version' },
        'target-2': { id: 'target-2', version: 1, value: 'other target' },
      },
      facts: {
        'target-1': { value: 'first version', label: 'Stub target one' },
        'target-2': { value: 'other target', label: 'Stub target two' },
      },
      writes: [],
    },
  };
}

function normalize(data: unknown): AgentAccountData {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AgentError('agent_store_corrupt', 'the agent document is not a JSON object');
  }
  const raw = data as Record<string, unknown>;
  const base = emptyAgentData();
  const asRecord = <T>(value: unknown): Record<string, T> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, T>) : {};
  const stub = raw.stub && typeof raw.stub === 'object' && !Array.isArray(raw.stub)
    ? (raw.stub as Record<string, unknown>)
    : {};
  return {
    schema: SCHEMA,
    profiles: asRecord(raw.profiles),
    runs: asRecord(raw.runs),
    requestIndex: asRecord(raw.requestIndex),
    sessions: asRecord(raw.sessions),
    memories: asRecord(raw.memories),
    proposals: asRecord(raw.proposals),
    stub: {
      targets: stub.targets && typeof stub.targets === 'object' && !Array.isArray(stub.targets)
        ? { ...base.stub.targets, ...(stub.targets as Record<string, never>) }
        : base.stub.targets,
      facts: stub.facts && typeof stub.facts === 'object' && !Array.isArray(stub.facts)
        ? { ...base.stub.facts, ...(stub.facts as Record<string, unknown>) }
        : base.stub.facts,
      writes: Array.isArray(stub.writes) ? (stub.writes as AgentAccountData['stub']['writes']) : [],
    },
  };
}

@Injectable()
export class AgentStore {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly paths: Paths,
    private readonly writer: AtomicWriter,
  ) {}

  file(uid: string): string {
    return this.paths.agentFile(uid);
  }

  read(uid: string): AgentAccountData {
    let raw: string;
    try {
      raw = fs.readFileSync(this.paths.agentFile(uid), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAgentData();
      throw new AgentError('agent_store_corrupt', 'the agent document could not be read', { cause: error });
    }
    try {
      return normalize(JSON.parse(raw));
    } catch (error) {
      if (error instanceof AgentError) throw error;
      throw new AgentError('agent_store_corrupt', 'the agent document is not valid JSON', { cause: error });
    }
  }

  update<T>(uid: string, change: (data: AgentAccountData) => T): Promise<T> {
    const previous = this.chains.get(uid) || Promise.resolve();
    const next = previous.then(() => {
      const data = this.read(uid);
      const result = change(data);
      this.writer.write(this.paths.agentFile(uid), JSON.stringify(data, null, 2), 0o600);
      return result;
    });
    // A rejected update must not poison every later update for this account.
    const tracked = next.catch(() => undefined);
    this.chains.set(uid, tracked);
    return next.finally(() => {
      if (this.chains.get(uid) === tracked) this.chains.delete(uid);
    });
  }
}
