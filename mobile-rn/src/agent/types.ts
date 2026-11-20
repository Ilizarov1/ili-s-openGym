import type { AgentProposal, AgentRunStatus, AgentAttachment } from './shared';
import type { Connection } from '../server';

export type { AgentAttachment, AgentMemory, AgentProposal, AgentRunStatus, AgentRunResult } from './shared';

export type AgentConnection = Connection | null;

export type AgentCapabilities = { text: boolean; image: boolean; tools: boolean };

export type AgentProfileRow = {
  scope: string;
  id: string;
  source: 'local' | 'server' | 'default' | 'user';
  provider: 'fixture' | 'openai' | 'compatible';
  model: string;
  capabilities: AgentCapabilities;
  keyHint?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
};

export type AgentProfilePublic = Omit<AgentProfileRow, 'scope'> & {
  available: boolean;
  reason?: string;
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
  dataVersion?: string | number;
  sessionId?: string;
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
};

export type AgentSessionRow = {
  scope: string;
  id: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  deletedAt?: number;
};

export type AgentSessionSummary = Omit<AgentSessionRow, 'scope'> & { messageCount: number };

export type AgentSession = Omit<AgentSessionRow, 'scope'> & { messages: Omit<AgentMessageRow, 'scope'>[] };

export type AgentProposalRow = AgentProposal & { scope: string };

export type AgentRunView = AgentRunRow & { result?: { text?: string; structured?: unknown; proposal?: AgentProposal; evidence?: unknown[]; usage?: unknown } };

export type AgentProfileInput = {
  id?: string;
  provider: AgentProfileRow['provider'];
  model: string;
  apiKey?: string;
  baseUrl?: string;
};

export type AgentStartInput = {
  requestId: string;
  profileId: string;
  input: Record<string, unknown>;
  sessionId?: string;
  attachmentIds?: string[];
};

export type AgentMediaInput = AgentAttachment;
