import type { AgentProposal, AgentRunStatus, AgentAttachment } from './shared';
import type { Connection } from '../server';

export type { AgentAttachment, AgentMemory, AgentProposal, AgentRunStatus, AgentRunResult } from './shared';

export type AgentConnection = Connection | null;

export type AgentCapabilities = { text: boolean; image: boolean; tools: boolean };

export type AgentProvider = 'fixture' | 'openai' | 'compatible' | 'opencode';

export type AgentExecutionLocation = 'local' | 'server';

export type AgentSessionMode = 'new' | 'continue';

export type AgentProfileRow = {
  scope: string;
  id: string;
  source: 'local' | 'server' | 'default' | 'user';
  provider: AgentProvider;
  model: string;
  capabilities: AgentCapabilities;
  /** Human-readable, desensitised name shown by the client. */
  label?: string;
  keyHint?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type AgentProfilePublic = Omit<AgentProfileRow, 'scope'> & {
  available: boolean;
  reason?: string;
};

/** The credential-free profile summary a run reports back to the client. */
export type AgentProfileSummary = {
  id: string;
  label: string;
  provider: string;
  model: string;
  version: number;
};

export type AgentProfileCapabilityInput = {
  /** Explicit override; when omitted the provider default is used. */
  image?: boolean;
};

export type AgentRunRow = {
  scope: string;
  runId: string;
  requestId: string;
  requestHash: string;
  taskId: string;
  profileId: string;
  status: AgentRunStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  execution?: 'local' | 'server';
  dataVersion?: string | number;
  sessionId?: string;
  /** Desensitised model configuration used by this run. */
  profile?: AgentProfileSummary;
  result?: unknown;
  proposalId?: string;
  error?: { code: string; message: string };
};

export type AgentMessageRow = {
  scope: string;
  sessionId: string;
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  runId?: string;
  meta?: Record<string, unknown>;
};

export type AgentSessionRow = {
  scope: string;
  id: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  taskId?: string;
  executionLocation?: AgentExecutionLocation;
  meta?: Record<string, unknown>;
  deletedAt?: number;
};

export type AgentSessionSummary = Omit<AgentSessionRow, 'scope'> & { messageCount: number };

export type AgentSession = Omit<AgentSessionRow, 'scope'> & { messages: Omit<AgentMessageRow, 'scope'>[] };

export type AgentProposalRow = AgentProposal & { scope: string };

export type AgentRunView = AgentRunRow & { result?: { text?: string; structured?: unknown; proposal?: AgentProposal; evidence?: unknown[]; usage?: unknown; profile?: AgentProfileSummary } };

export type AgentProfileInput = {
  id?: string;
  provider: AgentProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  capabilities?: AgentProfileCapabilityInput;
};

export type AgentStartInput = {
  requestId: string;
  profileId: string;
  input: Record<string, unknown>;
  sessionId?: string;
  sessionMode?: AgentSessionMode;
  taskId?: string;
  attachmentIds?: string[];
};

export type AgentMediaInput = AgentAttachment;

/** A normalized inline image the AI exercise search holds for one session. */
export type AgentAiImageInput = {
  id: string;
  mime: string;
  /** Decoded byte length. */
  size: number;
  width: number;
  height: number;
  /** `data:image/...;base64,...`; never logged. */
  dataUrl: string;
  createdAt: number;
};

export type AgentAiImageRow = AgentAiImageInput & {
  scope: string;
  sessionId: string;
  turn: number;
  /** Same as `size`; kept as its own column for auditability. */
  bytes: number;
};
