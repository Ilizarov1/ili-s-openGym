/* Stored shapes for the server-side agent runtime.
 *
 * One JSON document per account. Credentials are never returned in these
 * shapes: only the encrypted blob and the last four characters live here.
 */

export interface AgentCapabilities {
  text: boolean;
  image: boolean;
  tools: boolean;
}

export interface EncryptedSecret {
  v: number;
  iv: string;
  tag: string;
  data: string;
}

export interface AgentStoredProfile {
  id: string;
  // Retired profiles stay readable so their owners can replace them.
  provider: 'fixture' | 'openai' | 'deepseek' | 'opencode';
  model: string;
  capabilities: AgentCapabilities;
  secret?: EncryptedSecret;
  keyHint?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentProfilePublic {
  id: string;
  source: 'default' | 'user';
  provider: string;
  model: string;
  capabilities: AgentCapabilities;
  keyHint?: string;
  version: number;
  label: string;
  available: boolean;
  reason?: string;
}

export interface AgentProfileSummary {
  id: string;
  label: string;
  provider: string;
  model: string;
  version: number;
}

export interface AgentRunResult {
  runId: string;
  status: string;
  text?: string;
  structured?: unknown;
  proposal?: AgentProposal;
  evidence?: Array<{ evidenceId: string; objectId: string; version?: string | number }>;
  usage?: { rounds: number; toolCalls: number };
  profile?: AgentProfileSummary;
}

export interface AgentStoredRun {
  runId: string;
  requestId: string;
  requestHash: string;
  taskId: string;
  profileId: string;
  executionLocation: 'server';
  status: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  dataVersion?: string | number;
  sessionId?: string;
  sessionVersion?: number;
  profile?: AgentProfileSummary;
  result?: AgentRunResult;
  proposalId?: string;
  error?: { code: string; message: string };
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  taskId?: string;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  runId?: string;
  meta?: Record<string, unknown>;
}

export interface AgentStoredSession {
  id: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  taskId?: string;
  executionLocation?: 'local' | 'server';
  meta?: Record<string, unknown>;
  deletedAt?: number;
  messages: AgentMessage[];
  summary?: { text: string; updatedAt: number };
}

export interface AgentMemory {
  id: string;
  /** Present internally so shared selection can fail closed; stripped by the API. */
  scope?: string;
  category: 'preference' | 'goal' | 'constraint' | 'note';
  value: unknown;
  source?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface AgentProposal {
  proposalId: string;
  runId?: string;
  kind: string;
  changes: unknown[];
  targetScope: string[];
  targetVersion?: string | number;
  status: 'pending' | 'consumed' | 'rejected' | 'expired';
  createdAt: number;
  result?: unknown;
  consumedAt?: number;
  rejectedAt?: number;
}

export interface AgentStubTarget {
  id: string;
  version: number;
  value: string;
}

export interface AgentStubState {
  targets: Record<string, AgentStubTarget>;
  facts: Record<string, unknown>;
  writes: Array<{ proposalId: string; targetId: string; value: unknown; at: number }>;
}

export interface AgentAccountData {
  schema: number;
  profiles: Record<string, AgentStoredProfile>;
  runs: Record<string, AgentStoredRun>;
  requestIndex: Record<string, string>;
  sessions: Record<string, AgentStoredSession>;
  memories: Record<string, AgentMemory>;
  proposals: Record<string, AgentProposal>;
  stub: AgentStubState;
}

export interface AgentStartBody {
  taskId: string;
  requestId: string;
  profileId: string;
  input: Record<string, unknown>;
  sessionId?: string;
  sessionMode?: 'new' | 'continue';
  attachmentIds?: string[];
}
