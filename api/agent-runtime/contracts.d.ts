export const AGENT_SCHEMA_VERSION: 1;

export type RunStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ExecutionLocation = 'local' | 'server';
export type MemoryCategory = 'preference' | 'goal' | 'constraint' | 'note';

export interface ModelCapabilities {
  text?: boolean;
  image?: boolean;
  tools?: boolean;
}

export interface ProfileReference {
  profileId: string;
  version: number;
  provider: string;
  model?: string;
  capabilities?: ModelCapabilities;
}

export interface AttachmentReference {
  id: string;
  kind?: 'image' | 'file';
  mime?: string;
  name?: string;
  dataUrl?: string;
  ref?: string;
  size?: number;
}

export interface RunRequest {
  taskId: string;
  requestId: string;
  profileId: string;
  input: Record<string, unknown>;
  sessionId?: string;
  attachmentIds?: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelOutput {
  text?: string;
  structured?: unknown;
  toolCalls?: ToolCall[];
}

export interface ModelInput {
  instructions: string;
  user: {
    text: string;
    fixtureCase?: string;
    attachments?: AttachmentReference[];
  };
  facts: Array<{
    evidenceId: string;
    source: string;
    objectId: string;
    version?: string | number;
    content: unknown;
  }>;
  memories: Array<{
    id: string;
    category: MemoryCategory | string;
    value: unknown;
    source?: string;
    updatedAt?: number;
    version?: number;
  }>;
  history: Array<{
    id: string;
    role: string;
    content: string;
    createdAt?: number;
  }>;
  tools: Array<{
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }>;
  toolResults: Array<{
    toolId: string;
    callId?: string;
    result: unknown;
    evidenceId?: string;
  }>;
}

export interface Budgets {
  rounds?: number;
  toolCalls?: number;
  contextChars?: number;
  historyItems?: number;
  memoryItems?: number;
  attachments?: number;
  attachmentBytes?: number;
}

export interface TaskStep {
  id: string;
  tools?: string[];
  maxToolCalls?: number;
}

export interface TaskDefinition {
  id: string;
  version: number;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredCapabilities?: Array<'text' | 'image' | 'tools'>;
  budgets?: Budgets;
  steps: TaskStep[];
  /** Memories the model may see; unfiltered when omitted. */
  memoryCategories?: string[];
  targetScope(input: Record<string, unknown>, context: RunContext): string[] | Promise<string[]>;
  instructions?(input: Record<string, unknown>, context: RunContext): string;
  userText?(input: Record<string, unknown>, context: RunContext): string;
  fixtureCase?(input: Record<string, unknown>): string | undefined;
  readFacts?(input: Record<string, unknown>, context: RunContext): unknown[] | Promise<unknown[]>;
  parseOutput?(output: ModelOutput, context: RunContext): unknown;
}

export interface Evidence {
  evidenceId: string;
  source: string;
  objectId: string;
  version?: string | number;
  content: unknown;
}

export interface RunContext {
  scope: string;
  runId: string;
  request: RunRequest;
  execution: ExecutionLocation;
  profileRef: ProfileReference;
  dataVersion?: string | number;
  targetScope: Set<string>;
  evidence: Map<string, Evidence>;
  memories: unknown[];
  history: unknown[];
  deadline: number | null;
  signal: AbortSignal | null;
  startedAt: number;
  meta: Record<string, unknown>;
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  text?: string;
  structured?: unknown;
  proposal?: Proposal;
  evidence?: Array<{ evidenceId: string; objectId: string; version?: string | number }>;
  usage?: { rounds: number; toolCalls: number };
}

export interface Proposal {
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

export interface MemoryRecord {
  id: string;
  category: MemoryCategory | string;
  value: unknown;
  source?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface RunRecord {
  runId: string;
  requestId: string;
  taskId: string;
  profileId: string;
  scope: string;
  execution: ExecutionLocation;
  status: RunStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  dataVersion?: string | number;
  result?: RunResult;
  proposalId?: string;
  error?: { code: string; message: string };
}

export interface ModelGateway {
  invoke(profileRef: ProfileReference, modelInput: ModelInput, signal?: AbortSignal): Promise<ModelOutput>;
}

export interface ToolDefinition {
  id: string;
  description: string;
  argsSchema: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  target?(args: Record<string, unknown>): string | string[] | null;
  run(args: Record<string, unknown>, options: {
    context: RunContext;
    signal?: AbortSignal;
    callId?: string;
  }): unknown | Promise<unknown>;
}

export interface ToolDispatcher {
  list(): Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  call(toolId: string, args: Record<string, unknown>, options?: { callId?: string }): Promise<{
    toolId: string;
    result: unknown;
    evidence?: Evidence;
    calls: number;
  }>;
  readonly calls: number;
  readonly rejected: number;
}

export interface ProposalService {
  create(input: Omit<Proposal, 'proposalId' | 'status' | 'createdAt'> & { proposalId?: string; createdAt?: number }): Promise<Proposal>;
  get(proposalId: string): Promise<Proposal | null>;
  confirm(proposalId: string): Promise<{ proposal: Proposal; result: unknown; applied: boolean }>;
  reject(proposalId: string): Promise<Proposal>;
  /** Called by the orchestrator when a run is cancelled while a proposal is being saved. */
  discard?(proposalId: string): Promise<unknown>;
}

export interface RunState {
  readonly runId: string;
  status(): RunStatus;
  isTerminal(): boolean;
  record(): RunRecord;
  start(): RunRecord;
  completed(result?: RunResult): RunRecord;
  failed(error: { code: string; message: string }): RunRecord;
  cancel(reason?: string): RunRecord;
  interrupted(reason?: string): RunRecord;
  acceptResult(): boolean;
}

export function isTerminalStatus(status: string): boolean;
export function isRunStatus(status: string): boolean;
export function isMemoryCategory(value: string): boolean;
export function validRequestId(value: string): boolean;
export function validProfileId(value: string): boolean;
export function validTaskId(value: string): boolean;
export const RUN_DEFAULTS: Readonly<Budgets>;
export const RUN_STATUSES: readonly RunStatus[];
export const TERMINAL_STATUSES: readonly RunStatus[];
export const MEMORY_CATEGORIES: readonly MemoryCategory[];
export const EXECUTION_LOCATIONS: readonly ExecutionLocation[];
export function withRunDefaults(budgets?: Budgets): Required<Budgets>;
