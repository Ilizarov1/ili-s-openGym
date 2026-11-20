// Agent records live in their own SQLite file, scoped by the current workspace.
// A run captures its scope when it starts, so switching workspaces cannot move
// its result into another profile's data.
import { openDatabaseSync, type SQLiteDatabase } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { AgentError } from './shared';
import type {
  AgentMemory, AgentMessageRow, AgentProfileRow, AgentProposal, AgentProposalRow, AgentRunRow,
  AgentSession, AgentSessionRow, AgentSessionSummary,
} from './types';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const MAX_MESSAGE = 8000;

type RunBegin = { run: AgentRunRow; created: boolean };

let db: SQLiteDatabase | undefined;

function database(): SQLiteDatabase {
  if (!db) {
    const opened = openDatabaseSync('opengym-agent.db');
    opened.execSync(`
      CREATE TABLE IF NOT EXISTS agent_profiles (
        scope TEXT NOT NULL, id TEXT NOT NULL, source TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, capabilities TEXT NOT NULL, keyHint TEXT, version INTEGER NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY (scope, id)
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        scope TEXT NOT NULL, runId TEXT NOT NULL, requestId TEXT NOT NULL, requestHash TEXT NOT NULL,
        taskId TEXT NOT NULL, profileId TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL,
        startedAt INTEGER, finishedAt INTEGER, durationMs INTEGER, dataVersion TEXT, sessionId TEXT,
        result TEXT, proposalId TEXT, error TEXT, PRIMARY KEY (scope, runId)
      );
      CREATE TABLE IF NOT EXISTS agent_request_index (
        scope TEXT NOT NULL, requestId TEXT NOT NULL, runId TEXT NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY (scope, requestId)
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        scope TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, version INTEGER NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deletedAt INTEGER,
        PRIMARY KEY (scope, id)
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        scope TEXT NOT NULL, sessionId TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, createdAt INTEGER NOT NULL, runId TEXT,
        PRIMARY KEY (scope, id)
      );
      CREATE TABLE IF NOT EXISTS agent_memories (
        scope TEXT NOT NULL, id TEXT NOT NULL, category TEXT NOT NULL, value TEXT NOT NULL,
        source TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, version INTEGER NOT NULL,
        PRIMARY KEY (scope, id)
      );
      CREATE TABLE IF NOT EXISTS agent_proposals (
        scope TEXT NOT NULL, proposalId TEXT NOT NULL, runId TEXT, kind TEXT NOT NULL, changes TEXT NOT NULL,
        targetScope TEXT NOT NULL, targetVersion TEXT, status TEXT NOT NULL, createdAt INTEGER NOT NULL,
        result TEXT, consumedAt INTEGER, rejectedAt INTEGER, PRIMARY KEY (scope, proposalId)
      );
      CREATE TABLE IF NOT EXISTS agent_kv (
        scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key)
      );
    `);
    db = opened;
  }
  return db;
}

const parse = <T>(raw: string | null): T | undefined => {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
};

function profileRow(row: Record<string, unknown>): AgentProfileRow {
  return {
    scope: String(row.scope),
    id: String(row.id),
    source: row.source === 'server' ? 'server' : 'local',
    provider: row.provider as AgentProfileRow['provider'],
    model: String(row.model),
    capabilities: parse<AgentProfileRow['capabilities']>(String(row.capabilities)) || { text: true, image: false, tools: false },
    ...(row.keyHint ? { keyHint: String(row.keyHint) } : {}),
    version: Number(row.version),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function runRow(row: Record<string, unknown>): AgentRunRow {
  return {
    scope: String(row.scope),
    runId: String(row.runId),
    requestId: String(row.requestId),
    requestHash: String(row.requestHash),
    taskId: String(row.taskId),
    profileId: String(row.profileId),
    status: String(row.status) as AgentRunRow['status'],
    createdAt: Number(row.createdAt),
    ...(row.startedAt == null ? {} : { startedAt: Number(row.startedAt) }),
    ...(row.finishedAt == null ? {} : { finishedAt: Number(row.finishedAt) }),
    ...(row.durationMs == null ? {} : { durationMs: Number(row.durationMs) }),
    ...(row.dataVersion == null ? {} : { dataVersion: String(row.dataVersion) }),
    ...(row.sessionId ? { sessionId: String(row.sessionId) } : {}),
    ...(row.result ? { result: parse<unknown>(String(row.result)) } : {}),
    ...(row.proposalId ? { proposalId: String(row.proposalId) } : {}),
    ...(row.error ? { error: parse<{ code: string; message: string }>(String(row.error)) } : {}),
  };
}

function sessionRow(row: Record<string, unknown>): AgentSessionRow {
  return {
    scope: String(row.scope),
    id: String(row.id),
    title: String(row.title),
    version: Number(row.version),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    ...(row.deletedAt == null ? {} : { deletedAt: Number(row.deletedAt) }),
  };
}

function memoryRow(row: Record<string, unknown>): AgentMemory {
  return {
    id: String(row.id),
    category: String(row.category),
    value: parse<unknown>(String(row.value)),
    ...(row.source ? { source: String(row.source) } : {}),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    version: Number(row.version),
  };
}

function proposalRow(row: Record<string, unknown>): AgentProposalRow {
  return {
    scope: String(row.scope),
    proposalId: String(row.proposalId),
    ...(row.runId ? { runId: String(row.runId) } : {}),
    kind: String(row.kind),
    changes: parse<unknown[]>(String(row.changes)) || [],
    targetScope: parse<string[]>(String(row.targetScope)) || [],
    ...(row.targetVersion == null ? {} : { targetVersion: String(row.targetVersion) }),
    status: String(row.status) as AgentProposal['status'],
    createdAt: Number(row.createdAt),
    ...(row.result ? { result: parse<unknown>(String(row.result)) } : {}),
    ...(row.consumedAt == null ? {} : { consumedAt: Number(row.consumedAt) }),
    ...(row.rejectedAt == null ? {} : { rejectedAt: Number(row.rejectedAt) }),
  };
}

export class AgentStore {
  private readonly db: SQLiteDatabase;

  constructor() {
    this.db = database();
  }

  /* ------------------------------------------------------------- profiles */
  listProfiles(scope: string): AgentProfileRow[] {
    return this.db.getAllSync<Record<string, unknown>>(
      'SELECT * FROM agent_profiles WHERE scope = ? ORDER BY createdAt ASC, id ASC', scope,
    ).map(profileRow);
  }

  getProfile(scope: string, id: string): AgentProfileRow | null {
    const row = this.db.getFirstSync<Record<string, unknown>>(
      'SELECT * FROM agent_profiles WHERE scope = ? AND id = ?', scope, id,
    );
    return row ? profileRow(row) : null;
  }

  saveProfile(profile: AgentProfileRow): AgentProfileRow {
    const current = this.getProfile(profile.scope, profile.id);
    if (current && current.version > profile.version) return current;
    this.db.runSync(
      `INSERT OR REPLACE INTO agent_profiles
       (scope,id,source,provider,model,capabilities,keyHint,version,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      profile.scope, profile.id, profile.source, profile.provider, profile.model,
      JSON.stringify(profile.capabilities), profile.keyHint ?? null, profile.version,
      profile.createdAt, profile.updatedAt,
    );
    return profile;
  }

  deleteProfile(scope: string, id: string): boolean {
    return this.db.runSync('DELETE FROM agent_profiles WHERE scope = ? AND id = ?', scope, id).changes > 0;
  }

  /* ----------------------------------------------------------------- runs */
  getRun(scope: string, runId: string): AgentRunRow | null {
    const row = this.db.getFirstSync<Record<string, unknown>>(
      'SELECT * FROM agent_runs WHERE scope = ? AND runId = ?', scope, runId,
    );
    return row ? runRow(row) : null;
  }

  beginRun(run: AgentRunRow): RunBegin {
    let answer: RunBegin | null = null;
    this.db.withTransactionSync(() => {
      const known = this.db.getFirstSync<Record<string, unknown>>(
        'SELECT * FROM agent_request_index WHERE scope = ? AND requestId = ?', run.scope, run.requestId,
      );
      if (known) {
        const existing = this.getRun(run.scope, String(known.runId));
        if (!existing) {
          this.db.runSync('DELETE FROM agent_request_index WHERE scope = ? AND requestId = ?', run.scope, run.requestId);
        } else if (existing.requestHash !== run.requestHash) {
          throw new AgentError('request_conflict', 'this request id was already used with different input', {
            details: { requestId: run.requestId, runId: existing.runId },
          });
        } else {
          answer = { run: existing, created: false };
          return;
        }
      }
      this.insertRun(run);
      this.db.runSync(
        'INSERT OR REPLACE INTO agent_request_index (scope,requestId,runId,hash) VALUES (?,?,?,?)',
        run.scope, run.requestId, run.runId, run.requestHash,
      );
      answer = { run, created: true };
    });
    if (!answer) throw new Error('agent run transaction returned nothing');
    return answer;
  }

  private insertRun(run: AgentRunRow): void {
    this.db.runSync(
      `INSERT OR REPLACE INTO agent_runs
       (scope,runId,requestId,requestHash,taskId,profileId,status,createdAt,startedAt,finishedAt,durationMs,
        dataVersion,sessionId,result,proposalId,error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      run.scope, run.runId, run.requestId, run.requestHash, run.taskId, run.profileId, run.status,
      run.createdAt, run.startedAt ?? null, run.finishedAt ?? null, run.durationMs ?? null,
      run.dataVersion == null ? null : String(run.dataVersion), run.sessionId ?? null,
      run.result === undefined ? null : JSON.stringify(run.result), run.proposalId ?? null,
      run.error ? JSON.stringify(run.error) : null,
    );
  }

  updateRun(run: AgentRunRow): AgentRunRow {
    const current = this.getRun(run.scope, run.runId);
    if (!current) throw new AgentError('run_not_found', undefined, { details: { runId: run.runId } });
    if (TERMINAL.has(current.status)) return current;
    this.insertRun(run);
    return run;
  }

  finishRun(run: AgentRunRow): AgentRunRow {
    return this.updateRun(run);
  }

  markInterrupted(scope: string): number {
    const result = this.db.runSync(
      `UPDATE agent_runs SET status = 'interrupted', finishedAt = ?, durationMs = ?,
       error = ? WHERE scope = ? AND (status = 'accepted' OR status = 'running')`,
      Date.now(), Date.now(),
      JSON.stringify({ code: 'run_terminal', message: 'the app restarted before the run finished' }),
      scope,
    );
    return result.changes;
  }

  /* -------------------------------------------------------------- sessions */
  listSessions(scope: string): AgentSessionSummary[] {
    return this.db.getAllSync<Record<string, unknown>>(
      `SELECT s.*, (SELECT COUNT(*) FROM agent_messages m WHERE m.scope = s.scope AND m.sessionId = s.id) AS messageCount
       FROM agent_sessions s WHERE s.scope = ? AND s.deletedAt IS NULL ORDER BY s.updatedAt DESC`, scope,
    ).map(row => ({ ...sessionRow(row), messageCount: Number(row.messageCount) }));
  }

  getSession(scope: string, sessionId: string): AgentSession | null {
    const row = this.db.getFirstSync<Record<string, unknown>>(
      'SELECT * FROM agent_sessions WHERE scope = ? AND id = ?', scope, sessionId,
    );
    if (!row) return null;
    const session = sessionRow(row);
    if (session.deletedAt) return null;
    const messages = this.db.getAllSync<Record<string, unknown>>(
      'SELECT * FROM agent_messages WHERE scope = ? AND sessionId = ? ORDER BY createdAt ASC, id ASC',
      scope, sessionId,
    ).map(message => ({
      sessionId: String(message.sessionId),
      id: String(message.id),
      role: String(message.role) as 'user' | 'assistant',
      content: String(message.content),
      createdAt: Number(message.createdAt),
      ...(message.runId ? { runId: String(message.runId) } : {}),
    }));
    return { id: session.id, title: session.title, version: session.version, createdAt: session.createdAt, updatedAt: session.updatedAt, messages };
  }

  ensureSession(scope: string, sessionId: string, title = 'Agent session'): AgentSessionRow {
    let out: AgentSessionRow | null = null;
    this.db.withTransactionSync(() => {
      const row = this.db.getFirstSync<Record<string, unknown>>(
        'SELECT * FROM agent_sessions WHERE scope = ? AND id = ?', scope, sessionId,
      );
      const current = row ? sessionRow(row) : null;
      if (current?.deletedAt) throw new AgentError('session_deleted', undefined, { details: { sessionId } });
      if (current) { out = current; return; }
      const now = Date.now();
      const session = { scope, id: sessionId, title: title.slice(0, 120), version: 1, createdAt: now, updatedAt: now };
      this.db.runSync(
        'INSERT INTO agent_sessions (scope,id,title,version,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
        scope, sessionId, session.title, 1, now, now,
      );
      out = session;
    });
    if (!out) throw new Error('agent session transaction returned nothing');
    return out;
  }

  appendMessages(scope: string, sessionId: string, messages: Omit<AgentMessageRow, 'scope' | 'sessionId'>[]): AgentSessionRow {
    let out: AgentSessionRow | null = null;
    this.db.withTransactionSync(() => {
      const row = this.db.getFirstSync<Record<string, unknown>>(
        'SELECT * FROM agent_sessions WHERE scope = ? AND id = ?', scope, sessionId,
      );
      if (!row) throw new AgentError('invalid_request', 'session does not exist', { details: { sessionId } });
      const current = sessionRow(row);
      if (current.deletedAt) throw new AgentError('session_deleted', undefined, { details: { sessionId } });
      for (const message of messages) {
        this.db.runSync(
          'INSERT OR REPLACE INTO agent_messages (scope,sessionId,id,role,content,createdAt,runId) VALUES (?,?,?,?,?,?,?)',
          scope, sessionId, message.id, message.role, message.content.slice(0, MAX_MESSAGE), message.createdAt, message.runId ?? null,
        );
      }
      const at = Date.now();
      const next = { ...current, version: current.version + 1, updatedAt: at };
      this.db.runSync('UPDATE agent_sessions SET version = ?, updatedAt = ? WHERE scope = ? AND id = ?', next.version, at, scope, sessionId);
      out = next;
    });
    if (!out) throw new Error('agent session transaction returned nothing');
    return out;
  }

  deleteSession(scope: string, sessionId: string): boolean {
    let found = false;
    this.db.withTransactionSync(() => {
      const row = this.db.getFirstSync<Record<string, unknown>>(
        'SELECT * FROM agent_sessions WHERE scope = ? AND id = ?', scope, sessionId,
      );
      if (!row) return;
      found = true;
      const current = sessionRow(row);
      if (current.deletedAt) return;
      this.db.runSync(
        'UPDATE agent_sessions SET deletedAt = ?, version = ? WHERE scope = ? AND id = ?',
        Date.now(), current.version + 1, scope, sessionId,
      );
      this.db.runSync('DELETE FROM agent_messages WHERE scope = ? AND sessionId = ?', scope, sessionId);
    });
    return found;
  }

  /* -------------------------------------------------------------- memories */
  listMemories(scope: string): AgentMemory[] {
    return this.db.getAllSync<Record<string, unknown>>(
      'SELECT * FROM agent_memories WHERE scope = ? ORDER BY updatedAt DESC, id ASC', scope,
    ).map(memoryRow);
  }

  saveMemory(scope: string, memory: AgentMemory): AgentMemory {
    this.db.runSync(
      `INSERT OR REPLACE INTO agent_memories (scope,id,category,value,source,createdAt,updatedAt,version)
       VALUES (?,?,?,?,?,?,?,?)`,
      scope, memory.id, memory.category, JSON.stringify(memory.value), memory.source ?? null,
      memory.createdAt, memory.updatedAt, memory.version,
    );
    return memory;
  }

  updateMemory(scope: string, id: string, patch: { category?: string; value?: unknown; source?: string }): AgentMemory {
    const current = this.db.getFirstSync<Record<string, unknown>>(
      'SELECT * FROM agent_memories WHERE scope = ? AND id = ?', scope, id,
    );
    if (!current) throw new AgentError('memory_not_found', undefined, { details: { id } });
    const row = memoryRow(current);
    const next: AgentMemory = {
      ...row,
      ...(patch.category === undefined ? {} : { category: patch.category }),
      ...(patch.value === undefined ? {} : { value: patch.value }),
      ...(patch.source === undefined ? {} : { source: patch.source }),
      updatedAt: Date.now(),
      version: row.version + 1,
    };
    return this.saveMemory(scope, next);
  }

  deleteMemory(scope: string, id: string): boolean {
    return this.db.runSync('DELETE FROM agent_memories WHERE scope = ? AND id = ?', scope, id).changes > 0;
  }

  /* ------------------------------------------------------------- proposals */
  saveProposal(proposal: AgentProposalRow): AgentProposalRow {
    this.db.runSync(
      `INSERT OR REPLACE INTO agent_proposals
       (scope,proposalId,runId,kind,changes,targetScope,targetVersion,status,createdAt,result,consumedAt,rejectedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      proposal.scope, proposal.proposalId, proposal.runId ?? null, proposal.kind,
      JSON.stringify(proposal.changes), JSON.stringify(proposal.targetScope),
      proposal.targetVersion == null ? null : String(proposal.targetVersion), proposal.status,
      proposal.createdAt, proposal.result === undefined ? null : JSON.stringify(proposal.result),
      proposal.consumedAt ?? null, proposal.rejectedAt ?? null,
    );
    return proposal;
  }

  getProposal(scope: string, proposalId: string): AgentProposalRow | null {
    const row = this.db.getFirstSync<Record<string, unknown>>(
      'SELECT * FROM agent_proposals WHERE scope = ? AND proposalId = ?', scope, proposalId,
    );
    return row ? proposalRow(row) : null;
  }

  confirmProposal(scope: string, proposalId: string, apply: (proposal: AgentProposalRow) => unknown): { proposal: AgentProposalRow; result: unknown; applied: boolean } {
    let answer: { proposal: AgentProposalRow; result: unknown; applied: boolean } | null = null;
    this.db.withTransactionSync(() => {
      const proposal = this.getProposal(scope, proposalId);
      if (!proposal) throw new AgentError('proposal_not_found', undefined, { details: { proposalId } });
      if (proposal.status === 'consumed') {
        answer = { proposal, result: proposal.result, applied: false };
        return;
      }
      if (proposal.status !== 'pending') {
        throw new AgentError('proposal_consumed', 'this proposal can no longer be applied', {
          details: { proposalId, status: proposal.status },
        });
      }
      const result = apply(proposal);
      const consumed: AgentProposalRow = { ...proposal, status: 'consumed', result, consumedAt: Date.now() };
      this.saveProposal(consumed);
      answer = { proposal: consumed, result, applied: true };
    });
    if (!answer) {
      const current = this.getProposal(scope, proposalId);
      if (!current) throw new AgentError('proposal_not_found', undefined, { details: { proposalId } });
      answer = { proposal: current, result: current.result, applied: false };
    }
    return answer;
  }

  rejectProposal(scope: string, proposalId: string): AgentProposalRow {
    const proposal = this.getProposal(scope, proposalId);
    if (!proposal) throw new AgentError('proposal_not_found', undefined, { details: { proposalId } });
    if (proposal.status === 'rejected') return proposal;
    if (proposal.status === 'consumed') {
      throw new AgentError('proposal_consumed', 'this proposal was already applied', { details: { proposalId } });
    }
    return this.saveProposal({ ...proposal, status: 'rejected', rejectedAt: Date.now() });
  }

  /* ------------------------------------------------------------------- kv */
  readKv<T>(scope: string, key: string): T | undefined {
    const row = this.db.getFirstSync<Record<string, unknown>>(
      'SELECT value FROM agent_kv WHERE scope = ? AND key = ?', scope, key,
    );
    return row ? parse<T>(String(row.value)) : undefined;
  }

  writeKv(scope: string, key: string, value: unknown): void {
    this.db.runSync(
      'INSERT OR REPLACE INTO agent_kv (scope,key,value) VALUES (?,?,?)', scope, key, JSON.stringify(value),
    );
  }

  newId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }
}
