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
  if (raw.schema !== SCHEMA) {
    throw new AgentError('agent_store_corrupt', 'the agent document has an unknown schema', {
      details: { schema: raw.schema, expected: SCHEMA },
    });
  }
  // A structurally wrong document is corruption, not an empty account: this
  // read must never silently drop a run history or the request-dedup index.
  const asRecord = (value: unknown, name: string): Record<string, unknown> => {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AgentError('agent_store_corrupt', `the agent document's ${name} is invalid`);
    }
    return value as Record<string, unknown>;
  };
  const asEntries = (value: unknown, name: string): Record<string, Record<string, unknown>> => {
    const map = asRecord(value, name);
    for (const [id, entry] of Object.entries(map)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new AgentError('agent_store_corrupt', `the agent document's ${name}.${id} is invalid`);
      }
    }
    return map as Record<string, Record<string, unknown>>;
  };
  const requireField = (entry: Record<string, unknown>, name: string, field: string, type: 'string' | 'number') => {
    if (typeof entry[field] !== type) {
      throw new AgentError('agent_store_corrupt', `the agent document's ${name} entry has no valid ${field}`);
    }
  };
  const validateEntries = (
    entries: Record<string, Record<string, unknown>>,
    name: string,
    check: (entry: Record<string, unknown>, id: string) => void,
  ) => {
    for (const [id, entry] of Object.entries(entries)) check(entry, id);
    return entries;
  };

  const profiles = asEntries(raw.profiles, 'profiles');
  validateEntries(profiles, 'profiles', entry => {
    requireField(entry, 'profiles', 'id', 'string');
    requireField(entry, 'profiles', 'provider', 'string');
  });
  const runs = asEntries(raw.runs, 'runs');
  validateEntries(runs, 'runs', entry => {
    requireField(entry, 'runs', 'runId', 'string');
    requireField(entry, 'runs', 'status', 'string');
  });
  const requestIndex = asRecord(raw.requestIndex, 'requestIndex');
  for (const [requestId, runId] of Object.entries(requestIndex)) {
    if (typeof runId !== 'string') {
      throw new AgentError('agent_store_corrupt', `the agent document's requestIndex.${requestId} is invalid`);
    }
  }
  const sessions = asEntries(raw.sessions, 'sessions');
  validateEntries(sessions, 'sessions', entry => {
    requireField(entry, 'sessions', 'id', 'string');
    if (entry.messages !== undefined && !Array.isArray(entry.messages)) {
      throw new AgentError('agent_store_corrupt', "the agent document's session messages are invalid");
    }
  });
  const memories = asEntries(raw.memories, 'memories');
  validateEntries(memories, 'memories', entry => {
    requireField(entry, 'memories', 'id', 'string');
    requireField(entry, 'memories', 'category', 'string');
  });
  const proposals = asEntries(raw.proposals, 'proposals');
  validateEntries(proposals, 'proposals', entry => {
    requireField(entry, 'proposals', 'proposalId', 'string');
    requireField(entry, 'proposals', 'status', 'string');
    if (!Array.isArray(entry.changes)) {
      throw new AgentError('agent_store_corrupt', "the agent document's proposal changes are invalid");
    }
  });

  const stub = raw.stub && typeof raw.stub === 'object' && !Array.isArray(raw.stub)
    ? (raw.stub as Record<string, unknown>)
    : null;
  if (raw.stub !== undefined && !stub) {
    throw new AgentError('agent_store_corrupt', "the agent document's stub is invalid");
  }
  if (stub && (stub.targets === undefined || stub.facts === undefined || !Array.isArray(stub.writes))) {
    throw new AgentError('agent_store_corrupt', "the agent document's stub is incomplete");
  }
  if (stub && ((typeof stub.targets !== 'object' || stub.targets === null || Array.isArray(stub.targets))
    || (typeof stub.facts !== 'object' || stub.facts === null || Array.isArray(stub.facts)))) {
    throw new AgentError('agent_store_corrupt', "the agent document's stub targets or facts are invalid");
  }
  const targets = asEntries(stub?.targets, 'stub.targets');
  validateEntries(targets, 'stub.targets', entry => {
    requireField(entry, 'stub.targets', 'id', 'string');
    requireField(entry, 'stub.targets', 'version', 'number');
  });

  const base = emptyAgentData();
  return {
    schema: SCHEMA,
    profiles: profiles as unknown as AgentAccountData['profiles'],
    runs: runs as unknown as AgentAccountData['runs'],
    requestIndex: requestIndex as AgentAccountData['requestIndex'],
    sessions: sessions as unknown as AgentAccountData['sessions'],
    memories: memories as unknown as AgentAccountData['memories'],
    proposals: proposals as unknown as AgentAccountData['proposals'],
    stub: {
      targets: stub?.targets
        ? { ...base.stub.targets, ...(targets as unknown as AgentAccountData['stub']['targets']) }
        : base.stub.targets,
      facts: stub?.facts
        ? { ...base.stub.facts, ...(stub.facts as Record<string, unknown>) }
        : base.stub.facts,
      writes: stub && Array.isArray(stub.writes) ? (stub.writes as AgentAccountData['stub']['writes']) : [],
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
