// The subset of the shared runtime the RN host calls. Kept structural so the
// JS core can evolve without a build step on the phone.

export const AGENT_SCHEMA_VERSION: number;
export const RUN_STATUSES: readonly string[];
export const TERMINAL_STATUSES: readonly string[];
export const MEMORY_CATEGORIES: readonly string[];
export const RUN_DEFAULTS: Record<string, number>;

export type ModelCapabilities = { text?: boolean; image?: boolean; tools?: boolean };
export type ProfileReference = {
  profileId?: string;
  id?: string;
  version?: number;
  provider?: string;
  model?: string;
  capabilities?: ModelCapabilities;
};
export type ModelInput = {
  instructions: string;
  user: { text: string; fixtureCase?: string; attachments?: AgentAttachment[] };
  facts: unknown[];
  memories: unknown[];
  history: unknown[];
  tools: unknown[];
  toolResults: unknown[];
};
export type ModelOutput = { text?: string; structured?: unknown; toolCalls?: AgentToolCall[] };
export type AgentToolCall = { id: string; name: string; arguments: Record<string, unknown> };
export type AgentAttachment = {
  id: string;
  kind: 'image';
  mime: string;
  name: string;
  size: number;
  dataUrl: string;
};
export type AgentEvidence = {
  evidenceId: string;
  objectId: string;
  version?: string | number;
  source: string;
  content?: unknown;
};
export type AgentRunStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type AgentProposal = {
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
};
export type AgentMemory = {
  id: string;
  category: string;
  value: unknown;
  source?: string;
  createdAt: number;
  updatedAt: number;
  version: number;
};

export class AgentError extends Error {
  constructor(code: string, message?: string, options?: { details?: unknown; cause?: unknown; status?: number });
  code: string;
  status: number;
  details?: unknown;
}

export class AgentRunState {
  readonly runId: string;
  status(): AgentRunStatus;
  isTerminal(): boolean;
  record(): AgentRunRecord;
  start(): AgentRunRecord;
  completed(result?: unknown): AgentRunRecord;
  failed(error: { code: string; message: string }): AgentRunRecord;
  cancel(reason?: string): AgentRunRecord;
  interrupted(reason?: string): AgentRunRecord;
  acceptResult(): boolean;
}

export class AgentRunRecord {
  runId: string;
  requestId: string;
  taskId: string;
  profileId: string;
  scope: string;
  execution: 'local' | 'server';
  status: AgentRunStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  dataVersion?: string | number;
  result?: AgentRunResult;
  proposalId?: string;
  error?: { code: string; message: string };
}

export type AgentRunResult = {
  runId: string;
  status: AgentRunStatus;
  text?: string;
  structured?: unknown;
  proposal?: AgentProposal;
  evidence?: { evidenceId: string; objectId: string; version?: string | number }[];
  usage?: { rounds: number; toolCalls: number };
};

export type AgentTask = {
  id: string;
  version: number;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredCapabilities?: ('text' | 'image' | 'tools')[];
  budgets?: Record<string, number>;
  memoryCategories?: string[];
  steps: { id: string; tools?: string[]; maxToolCalls?: number }[];
  targetScope(input: Record<string, unknown>, context: unknown): string[] | Promise<string[]>;
  readFacts?(input: Record<string, unknown>, context: unknown): unknown[] | Promise<unknown[]>;
  instructions?(input: Record<string, unknown>, context: unknown): string;
  userText?(input: Record<string, unknown>, context: unknown): string;
  fixtureCase?(input: Record<string, unknown>): string | undefined;
  parseOutput?(output: ModelOutput, context: unknown): unknown;
};

export type AgentTool = {
  id: string;
  description: string;
  argsSchema: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  target?(args: Record<string, unknown>): string | string[] | null;
  run(args: Record<string, unknown>, options: unknown): unknown | Promise<unknown>;
};

export type RunAgentOptions = {
  task: AgentTask;
  request: Record<string, unknown>;
  context: unknown;
  gateway: { invoke(profileRef: ProfileReference, input: ModelInput, signal?: AbortSignal): Promise<ModelOutput> };
  tools: AgentTool[];
  proposals: {
    create(input: Record<string, unknown>): Promise<AgentProposal>;
  };
  state: AgentRunState;
  signal?: AbortSignal;
};

export function createIds(randomUUID: () => string): {
  run(): string;
  session(): string;
  memory(): string;
  proposal(): string;
  evidence(): string;
  record(prefix: string): string;
};
export function createId(prefix: string, randomUUID: () => string): string;

export function bindContext(options: {
  scope: string;
  runId: string;
  request: Record<string, unknown>;
  execution: 'local' | 'server';
  profileRef: Record<string, unknown>;
  dataVersion?: string | number;
  targetScope?: Iterable<string>;
  signal?: AbortSignal | null;
  memories?: unknown[];
  history?: unknown[];
  meta?: Record<string, unknown>;
  ids?: { evidence?: () => string };
}): unknown;

export function createRunState(
  initial: Record<string, unknown>,
  options?: { now?: () => number; onChange?: (record: AgentRunRecord) => void },
): AgentRunState;

export function runAgent(options: RunAgentOptions): Promise<AgentRunRecord>;

export function selectMemories(
  memories: AgentMemory[],
  options?: { scope?: string; kinds?: string[]; limit?: number; maxChars?: number },
): AgentMemory[];

export function addEvidence(context: unknown, evidence: Omit<AgentEvidence, 'evidenceId'> & { evidenceId?: string }): AgentEvidence;

export function createProvider(provider: string, config?: Record<string, unknown>): {
  id: string;
  capabilities: ModelCapabilities;
  invoke(input: Record<string, unknown>): Promise<ModelOutput>;
};

export function normalizeModelOutput(raw: unknown): ModelOutput;
export function assertCapabilities(profile: { capabilities?: ModelCapabilities }, required: string[]): ModelCapabilities;
export function requiredCapabilitiesFor(input: ModelInput): ('text' | 'image' | 'tools')[];
export function validateBaseUrl(raw: unknown): { ok: boolean; value?: string | null; error?: string };
export function phoneMayCall(url: string): boolean;
export function isMemoryCategory(value: string): boolean;
export function isTerminalStatus(value: string): boolean;
export function validRequestId(value: string): boolean;
export function withRunDefaults(budgets?: Record<string, number>): Required<Record<string, number>>;
