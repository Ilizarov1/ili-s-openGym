/* LangGraph orchestrator for the Coach generative-UI SSE endpoint.
 *
 * One streamed run is a three-node StateGraph:
 *   prepare  → load the account's synced training context and the id allow-list
 *   analyze  → inspect recent training and pick grounded swap candidates
 *   compose  → fixture plan or a real OpenAI-compatible model, streamed as interleaved nodes
 *
 * The v2 wire protocol is a flat, ordered list of narrative nodes: the model writes
 * NDJSON, an incremental parser announces each node while it is still arriving, and
 * every node is validated against the catalogue and the closed change list the moment
 * its line closes. Nothing is buffered and replayed, so prose and UI cards interleave
 * on the wire exactly as the model produced them:
 *   genui.prose_delta   partial prose text
 *   genui.node_pending  a structured node's type was announced
 *   genui.node_commit   the node passed validation and the budgets
 *   genui.node_drop     a pending node was withdrawn (malformed or over budget)
 *
 * A proposal_action node is only committed after `validateReview` accepts its changes
 * against the caller's plan; anything else is downgraded in place to a fallback_notice.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  AGUI_EVENT_TYPES,
  GENUI_BLOCK_TYPES,
  GENUI_CUSTOM_EVENTS,
  GENUI_HEAVY_VISUAL_TYPES,
  GENUI_NODE_TYPES,
  GENUI_PROTOCOL_VERSION,
  MAX_GENUI_NODES,
  MAX_VISUAL_NODES_LIMIT,
  createNdjsonNodeParser,
  v1ToGenUINodes,
  validateGenUINode,
} from '../../agent-runtime/genui/index.js';
import {
  buildCoachGenUISystemPrompt,
  buildFixtureGenUIResponse,
} from '../../agent-runtime/tasks/coach-genui.js';
import { createCatalogueSearchTool } from '../../agent-runtime/tasks/catalogue-search-tool.js';
import type { ParserEvent } from '../../agent-runtime/genui/ndjson-parser.js';
import { AgentError } from '../../agent-runtime/errors.js';
import { validateReview } from '../../coach/core/validate.js';
import { StateStore } from '../common/persistence/state-store.js';
import { AgentConfigStore, type ResolvedAgentProfile } from './agent-config.store.js';
import { fixtureAllowed } from './agent.flags.js';
import { createLangChainChatModel, sanitizeErrorText } from './langchain/index.js';

export type GenUINode = Record<string, unknown>;
export type AguiEvent = Record<string, unknown>;

export const MAX_COACH_TEXT = 4000;
const MAX_TEXT_DELTA = 48;
const DEFAULT_PROFILE_ID = 'default';
const MAX_TOOL_ROUNDS = 3;

export interface CoachHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CoachFormSubmission {
  formId?: string;
  answers: Record<string, unknown>;
}

export interface CoachStreamRequest {
  text: string;
  formSubmission?: CoachFormSubmission;
  /** The caller's plan projection (`routines`/`week`) when it has already synced one. */
  plan?: CoachPlan | null;
  profileId?: string;
  lang?: string;
  /** Earlier turns of this conversation, oldest first (at most 10 user turns). */
  history?: CoachHistoryMessage[];
  threadId?: string;
  runId?: string;
  today?: string;
  /** Per-request heavy-visual budget, already clamped to `0..MAX_VISUAL_NODES_LIMIT`. */
  maxVisuals?: number;
  /** Ask for the deterministic fixture response even when a real profile resolves. */
  fixture?: boolean;
}

export interface CoachStreamOptions {
  signal?: AbortSignal;
  emit: (event: AguiEvent) => void;
  now?: () => number;
}

export interface CoachStreamResult {
  runId: string;
  threadId: string;
  nodes: GenUINode[];
  text: string;
  blocks: GenUINode[];
  warnings: string[];
}

export interface CoachPlan {
  routines: Array<Record<string, unknown>>;
  week: Record<string, unknown>;
  customIds: string[];
  programmes: Array<Record<string, unknown>>;
}

interface CoachSnapshot {
  workouts: Array<Record<string, unknown>>;
  customNames?: Record<string, string>;
}

interface StreamContext {
  signal?: AbortSignal;
  emit: (event: AguiEvent) => void;
}

interface CatalogueEntry {
  id: string;
  n?: string;
  zh?: string;
  eq?: string;
  bp?: string;
  tg?: string;
}

interface ProfileChoice {
  mode: 'fixture' | 'model';
  resolved: ResolvedAgentProfile | null;
}

interface StreamableChatModel {
  stream?: (input: unknown, options?: { signal?: AbortSignal }) => Promise<AsyncIterable<unknown>>;
  invoke: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>;
}

/* ------------------------------- budget ----------------------------------- */

/**
 * Effective heavy-visual budget: request > COACH_GENUI_MAX_VISUALS > unrestricted.
 *
 * `null` means the model is free to choose any number of charts; a number is a hard
 * cap the compose loop and the shared sanitizer enforce.
 */
export function resolveMaxVisuals(requestMaxVisuals?: number): number | null {
  const clamp = (value: number): number =>
    Math.min(MAX_VISUAL_NODES_LIMIT, Math.max(0, Math.round(value)));
  if (typeof requestMaxVisuals === 'number' && Number.isFinite(requestMaxVisuals)) {
    return clamp(requestMaxVisuals);
  }
  const envRaw = process.env.COACH_GENUI_MAX_VISUALS;
  if (typeof envRaw === 'string' && envRaw.trim()) {
    const parsed = Number.parseInt(envRaw.trim(), 10);
    if (Number.isFinite(parsed)) return clamp(parsed);
  }
  return null;
}

/* ------------------------------- helpers ---------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isHeavyVisual(nodeType: string): boolean {
  return (GENUI_HEAVY_VISUAL_TYPES as readonly string[]).includes(nodeType);
}

function textOfModelChunk(chunk: unknown): string {
  const record = asRecord(chunk);
  if (!record) return '';
  const content = record.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      const piece = asRecord(part);
      return typeof piece?.text === 'string' ? piece.text : '';
    }).join('');
  }
  const kwargs = asRecord(record.kwargs);
  if (kwargs) return textOfModelChunk(kwargs);
  return '';
}

interface NormalizedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ManualToolCall {
  id: string;
  name: string;
  args: string;
}

function parseToolArgs(source: string): Record<string, unknown> {
  if (!source.trim()) return {};
  try {
    return asRecord(JSON.parse(source)) ?? {};
  } catch {
    return {};
  }
}

/**
 * Normalize the tool calls of one finished round.
 *
 * LangChain usually merges `tool_call_chunks` into `tool_calls` on `concat`, but a
 * mock or a provider without `.concat` only leaves partial chunks. The manually
 * assembled calls (by `index`) are therefore a second source, deduped by id so a
 * merged call is never executed twice. The merged `tool_calls` are read FIRST and the
 * manual accumulation SECOND: iterating the raw `tool_call_chunks` in between could
 * register an id with empty args before the manual entry supplies the assembled args.
 */
function normalizeToolCalls(
  accumulated: unknown,
  manual: Map<number, ManualToolCall>,
): NormalizedToolCall[] {
  const out: NormalizedToolCall[] = [];
  const seen = new Set<string>();
  const signatures = new Set<string>();
  const push = (id: string, name: string, args: unknown): void => {
    if (!name) return;
    const parsedArgs = typeof args === 'string' ? parseToolArgs(args) : asRecord(args) ?? {};
    const signature = `${name}:${JSON.stringify(parsedArgs)}`;
    const key = id || signature;
    if (seen.has(key) || signatures.has(signature)) return;
    seen.add(key);
    signatures.add(signature);
    out.push({ id, name, args: parsedArgs });
  };

  const record = asRecord(accumulated);
  const direct = Array.isArray(record?.tool_calls) ? record.tool_calls : [];
  for (const raw of direct) {
    const call = asRecord(raw);
    if (!call) continue;
    push(
      typeof call.id === 'string' ? call.id : '',
      typeof call.name === 'string' ? call.name : '',
      call.args,
    );
  }

  // The raw `tool_call_chunks` are intentionally not read here: a partial chunk can
  // register an id with empty args before the assembled manual entry lands, and the
  // dedupe by id would then drop the good call. `direct` (merged by LangChain) plus
  // `manual` (assembled by index) cover both the merged and the `.concat`-less path.
  for (const entry of manual.values()) push(entry.id, entry.name, entry.args);
  return out;
}

function isNonEmptyToolPart(item: unknown): boolean {
  const record = asRecord(item);
  if (!record) return false;
  if (typeof record.id === 'string' && record.id.trim()) return true;
  if (typeof record.name === 'string' && record.name.trim()) return true;
  if (typeof record.args === 'string' && record.args.trim()) return true;
  return false;
}

function hasAnyToolCall(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  const chunks = Array.isArray(record.tool_call_chunks) ? record.tool_call_chunks : [];
  if (chunks.some(isNonEmptyToolPart)) return true;
  const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  return calls.some(isNonEmptyToolPart);
}

/** Compact and localize one catalogue search row for the model. */
function compactSearchItem(item: unknown, lang?: string): Record<string, unknown> {
  const record = asRecord(item) ?? {};
  const nameEn = typeof record.nameEn === 'string' ? record.nameEn : '';
  const nameZh = typeof record.nameZh === 'string' ? record.nameZh : '';
  return {
    id: typeof record.id === 'string' ? record.id : '',
    name: isZhLang(lang) ? (nameZh || nameEn) : (nameEn || nameZh),
    equipment: typeof record.equipment === 'string' ? record.equipment : '',
    bodyPart: typeof record.bodyPart === 'string' ? record.bodyPart : '',
    target: typeof record.target === 'string' ? record.target : '',
  };
}

/* The plan projection the client may send is the same shape as the synced state's
 * routines/week, so one normaliser serves both. */
export function normalizeCoachPlan(raw: unknown, customIds: string[] = []): CoachPlan | null {
  const record = asRecord(raw);
  // A synced account with no routine templates is still a plan: `{ routines: [], week: {} }`
  // must survive so the coach can analyse history and propose an `add-routine` instead of
  // being told no plan exists. Only a non-object or a missing routines array means "no plan".
  if (!record || !Array.isArray(record.routines)) return null;
  const routines = (record.routines as unknown[])
    .filter(item => asRecord(item) !== null) as Array<Record<string, unknown>>;
  const week = asRecord(record.week) || {};
  const programmes = Array.isArray(record.programmes)
    ? record.programmes.filter(item => asRecord(item) !== null) as Array<Record<string, unknown>>
    : [];
  return { routines, week, customIds, programmes };
}

let catalogueCache: CatalogueEntry[] | null = null;

function catalogueEntries(): CatalogueEntry[] {
  if (catalogueCache) return catalogueCache;
  try {
    const file = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'agent-runtime', 'tasks', 'exercise-search-catalogue.json',
    );
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    catalogueCache = Array.isArray(parsed)
      ? (parsed as CatalogueEntry[]).filter(entry => entry && typeof entry.id === 'string')
      : [];
  } catch {
    catalogueCache = [];
  }
  return catalogueCache;
}

/* Language + localized-name helpers for grounded context. The catalogue ships a
 * Simplified Chinese `zh` label for every entry; a real model otherwise echoes the
 * English `n` into Chinese prose, card titles and swap reasons. */
function isZhLang(lang?: string): boolean {
  return typeof lang === 'string' && lang.toLowerCase().startsWith('zh');
}

function displayNameFor(entry: CatalogueEntry, lang?: string): string {
  if (isZhLang(lang)) return entry.zh || entry.n || '';
  return entry.n || entry.zh || '';
}

function splitTextDeltas(text: string): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > MAX_TEXT_DELTA) {
    let cut = rest.lastIndexOf(' ', MAX_TEXT_DELTA);
    if (cut < MAX_TEXT_DELTA / 2) cut = MAX_TEXT_DELTA;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/* A model sometimes answers swap-exercise/add-exercise with a bare id string
 * (`"after": "0030"`) instead of the documented `{ "id": "0030" }`. `validateReview` reads
 * `after.id`, so the string shape failed as "after.id must be an exercise id from the
 * library" even when the id was real. Normalising the shape here keeps that rejection for
 * ids that do not exist — nothing is invented, the id still has to survive the allow-list —
 * while a real catalogue exercise is no longer refused over punctuation. */
function normalizeProposalChanges(changes: unknown): unknown {
  if (!Array.isArray(changes)) return changes;
  return changes.map(change => {
    const record = asRecord(change);
    if (!record) return change;
    if (record.type === 'add-routine') return normalizeAddRoutineChange(record);
    if (record.type !== 'swap-exercise' && record.type !== 'add-exercise') return change;
    let next: Record<string, unknown> = record;
    if (typeof next.after === 'string') {
      const id = next.after.trim();
      if (id) next = { ...next, after: { id } };
    }
    // For add-exercise, the exercise being added is not yet in the routine; some models
    // mistakenly echo its id in `target.exId`, which `validateReview` rejects because it
    // expects `target: { routineId }` only. Strip `target.exId` (forwarding it to `after.id`
    // only when `after` has no id yet) — `after.id` still passes the strict allow-list gate.
    if (next.type === 'add-exercise') {
      const target = asRecord(next.target);
      if (target && typeof target.exId === 'string') {
        const { exId, ...cleanTarget } = target;
        const afterRec = asRecord(next.after);
        const trimmed = exId.trim();
        next = {
          ...next,
          target: cleanTarget,
          ...(!afterRec?.id && trimmed ? { after: { ...(afterRec || {}), id: trimmed } } : {}),
        };
      }
    }
    return next;
  });
}

const REPS_RANGE_RE = /^(\d+)\s*[-–~]\s*(\d+)$/;
const WHOLE_NUMBER_RE = /^\d+$/;

/* `add-routine` is the one change whose `after` is a whole routine. Models drift on its
 * shape in three ways that are unambiguous and safe to repair before validation: a missing
 * `target` (it has no existing routine to point at), `ex[].exId` instead of `ex[].id`, and
 * numeric strings for `sets`/`reps` (including `"8-12"` ranges). Every id is still checked
 * against the catalogue allow-list by `validateReview`; nothing is invented here. */
function normalizeAddRoutineChange(record: Record<string, unknown>): Record<string, unknown> {
  // Creating a routine has no existing object to name, so an omitted target becomes `{}`;
  // any routineId/exId copied into it would only confuse `validateReview`.
  const cleanTarget: Record<string, unknown> = { ...(asRecord(record.target) || {}) };
  delete cleanTarget.exId;
  delete cleanTarget.routineId;
  const next: Record<string, unknown> = { ...record, target: cleanTarget };
  const after = asRecord(record.after);
  if (!after || !Array.isArray(after.ex)) return next;
  const ex = (after.ex as unknown[]).map(item => {
    const entry = asRecord(item);
    if (!entry) return item;
    const { exId, ...rest } = entry;
    const normalized: Record<string, unknown> = { ...rest };
    if (
      (typeof normalized.id !== 'string' || !normalized.id.trim())
      && typeof exId === 'string'
      && exId.trim()
    ) {
      normalized.id = exId.trim();
    }
    if (typeof normalized.reps === 'string') {
      const trimmed = normalized.reps.trim();
      const range = trimmed.match(REPS_RANGE_RE);
      if (range) {
        const lo = Number.parseInt(range[1], 10);
        const hi = Number.parseInt(range[2], 10);
        normalized.repsMin = lo;
        normalized.repsMax = hi;
        normalized.reps = Math.round((lo + hi) / 2);
      } else if (WHOLE_NUMBER_RE.test(trimmed)) {
        normalized.reps = Number.parseInt(trimmed, 10);
      }
    }
    if (typeof normalized.sets === 'string' && WHOLE_NUMBER_RE.test(normalized.sets.trim())) {
      normalized.sets = Number.parseInt(normalized.sets.trim(), 10);
    }
    return normalized;
  });
  return { ...next, after: { ...after, ex } };
}

const CoachAnnotation = Annotation.Root({
  request: Annotation<CoachStreamRequest>({
    reducer: (_left, right) => right,
    default: () => ({ text: '' }),
  }),
  plan: Annotation<CoachPlan | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  snapshot: Annotation<CoachSnapshot>({
    reducer: (_left, right) => right,
    default: () => ({ workouts: [] }),
  }),
  validExIds: Annotation<Set<string>>({
    reducer: (_left, right) => right,
    default: () => new Set<string>(),
  }),
  contextSummary: Annotation<string>({
    reducer: (_left, right) => right,
    default: () => '',
  }),
  nodes: Annotation<GenUINode[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  warnings: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
});

type CoachGraphState = typeof CoachAnnotation.State;

@Injectable()
export class CoachGenUIService {
  constructor(
    private readonly states: StateStore,
    private readonly configs: AgentConfigStore,
  ) {}

  /** Runs one streamed Coach turn, emitting AG-UI events as the graph advances. */
  async stream(uid: string, request: CoachStreamRequest, options: CoachStreamOptions): Promise<CoachStreamResult> {
    const runId = request.runId || `run_${randomUUID()}`;
    const threadId = request.threadId || runId;
    const now = options.now ?? Date.now;
    const ctx: StreamContext = {
      ...(options.signal ? { signal: options.signal } : {}),
      emit: event => {
        if (options.signal?.aborted) return;
        try {
          options.emit({ ...event, timestamp: event.timestamp ?? new Date(now()).toISOString() });
        } catch {
          /* a write to a closed socket must not fail the run */
        }
      },
    };

    ctx.emit({
      type: AGUI_EVENT_TYPES.RUN_STARTED,
      runId,
      threadId,
      protocolVersion: GENUI_PROTOCOL_VERSION,
    });

    try {
      const graph = this.buildGraph(uid, ctx);
      const final = await graph.invoke(
        { request },
        {
          ...(options.signal ? { signal: options.signal } : {}),
          recursionLimit: 16,
        },
      ) as CoachGraphState;

      const nodes = Array.isArray(final.nodes) ? final.nodes : [];
      const text = nodes
        .filter(node => node.type === GENUI_NODE_TYPES.PROSE)
        .map(node => (typeof node.text === 'string' ? node.text : ''))
        .filter(Boolean)
        .join('\n\n');
      const blocks = nodes.filter(node => node.type !== GENUI_NODE_TYPES.PROSE);
      const warnings = Array.isArray(final.warnings) ? final.warnings : [];
      ctx.emit({
        type: AGUI_EVENT_TYPES.RUN_FINISHED,
        runId,
        threadId,
        protocolVersion: GENUI_PROTOCOL_VERSION,
        nodes,
        text,
        blocks,
      });
      return { runId, threadId, nodes, text, blocks, warnings };
    } catch (error) {
      if (options.signal?.aborted) {
        // The caller is gone; there is nobody left to read a terminal event.
        return { runId, threadId, nodes: [], text: '', blocks: [], warnings: [] };
      }
      const code = error instanceof AgentError ? error.code : 'model_unavailable';
      const rawMessage = error instanceof Error ? error.message : 'the coach run failed';
      ctx.emit({
        type: AGUI_EVENT_TYPES.RUN_ERROR,
        runId,
        code,
        message: sanitizeErrorText(rawMessage) || 'the coach run failed',
      });
      return { runId, threadId, nodes: [], text: '', blocks: [], warnings: [] };
    }
  }

  private buildGraph(uid: string, ctx: StreamContext) {
    return new StateGraph(CoachAnnotation)
      .addNode('prepare', (state: CoachGraphState) => this.prepareNode(uid, state, ctx))
      .addNode('analyze', (state: CoachGraphState) => this.analyzeNode(state, ctx))
      .addNode('compose', (state: CoachGraphState) => this.composeNode(uid, state, ctx))
      .addEdge(START, 'prepare')
      .addEdge('prepare', 'analyze')
      .addEdge('analyze', 'compose')
      .addEdge('compose', END)
      .compile();
  }

  private startStep(ctx: StreamContext, stepName: string, label: string): void {
    ctx.emit({ type: AGUI_EVENT_TYPES.STEP_STARTED, stepName, label });
  }

  private finishStep(ctx: StreamContext, stepName: string): void {
    ctx.emit({ type: AGUI_EVENT_TYPES.STEP_FINISHED, stepName });
  }

  private abortIfNeeded(ctx: StreamContext): void {
    if (ctx.signal?.aborted) throw new AgentError('run_cancelled', 'the run was cancelled');
  }

  private prepareNode(uid: string, state: CoachGraphState, ctx: StreamContext): Partial<CoachGraphState> {
    this.startStep(ctx, 'prepare', 'Reading your training context');
    const stored = this.states.read(uid) as unknown;
    const storedRecord = asRecord(stored);
    const storedCustomIds = Array.isArray(storedRecord?.customEx)
      ? (storedRecord.customEx as unknown[])
        .map(item => asRecord(item))
        .map(item => (typeof item?.id === 'string' ? item.id : ''))
        .filter(id => id.length > 0)
      : [];

    const requestPlan = normalizeCoachPlan(state.request.plan, storedCustomIds);
    const storedPlan = normalizeCoachPlan(storedRecord, storedCustomIds);
    // A non-empty plan always wins: the caller's client projection may lag behind a sync that
    // already holds routines, so an empty request plan must not hide the stored templates.
    const plan = requestPlan && requestPlan.routines.length > 0
      ? requestPlan
      : storedPlan && storedPlan.routines.length > 0
        ? storedPlan
        : requestPlan || storedPlan;
    const workouts = Array.isArray(storedRecord?.workouts)
      ? (storedRecord.workouts as unknown[]).filter(item => asRecord(item) !== null).slice(-12) as Array<Record<string, unknown>>
      : [];

    const validExIds = new Set<string>();
    for (const entry of catalogueEntries()) validExIds.add(entry.id);
    for (const id of storedCustomIds) validExIds.add(id);
    if (plan) {
      for (const routine of plan.routines) {
        const ex = Array.isArray(routine.ex) ? routine.ex : [];
        for (const item of ex) {
          const record = asRecord(item);
          if (record && typeof record.id === 'string' && record.id) validExIds.add(record.id);
        }
      }
    }

    const customNames: Record<string, string> = {};
    if (Array.isArray(storedRecord?.customEx)) {
      for (const item of storedRecord.customEx as unknown[]) {
        const rec = asRecord(item);
        const id = typeof rec?.id === 'string' ? rec.id.trim() : '';
        const name = typeof rec?.n === 'string'
          ? rec.n.trim()
          : (typeof rec?.name === 'string' ? rec.name.trim() : '');
        if (id && name) customNames[id] = name.slice(0, 60);
      }
    }

    this.finishStep(ctx, 'prepare');
    return {
      plan,
      snapshot: { workouts, customNames },
      validExIds,
    };
  }

  private analyzeNode(state: CoachGraphState, ctx: StreamContext): Partial<CoachGraphState> {
    this.startStep(ctx, 'analyze', 'Checking exercise history & swaps');
    const toolCallId = `tool_${randomUUID()}`;
    const args = {
      question: state.request.text.slice(0, 240),
      hasFormSubmission: Boolean(state.request.formSubmission),
      routines: state.plan ? state.plan.routines.length : 0,
    };
    ctx.emit({
      type: AGUI_EVENT_TYPES.TOOL_CALL_START,
      toolCallId,
      toolCallName: 'inspect_training_context',
      args,
    });

    const summary = this.inspectContext(state);
    ctx.emit({
      type: AGUI_EVENT_TYPES.TOOL_CALL_RESULT,
      toolCallId,
      toolCallName: 'inspect_training_context',
      summary,
    });

    this.finishStep(ctx, 'analyze');
    return { contextSummary: summary };
  }

  /** A compact, grounded description of the caller's plan and recent work. */
  private inspectContext(state: CoachGraphState): string {
    const lines: string[] = [];
    const lang = state.request.lang;
    const byId = new Map(catalogueEntries().map(entry => [entry.id, entry]));
    // Every id the model may mention is shown next to its catalogue name in the caller's
    // language, so a zh reply can reuse the exact localized label instead of the English row.
    const customNames = state.snapshot.customNames || {};
    const labelled = (id: string): string => {
      const entry = byId.get(id);
      const name = entry ? displayNameFor(entry, lang) : (customNames[id] || '');
      return name ? `${id} "${name}"` : id;
    };
    if (state.plan) {
      if (!state.plan.routines.length) {
        // The synced document is real but holds no routine templates yet. Say so explicitly:
        // silence here read as "no plan" and steered the model away from proposing one.
        lines.push('Plan: 0 saved routines yet (the athlete has no routine templates yet — you can analyse their workout history or propose new routines via proposal_action with type add-routine)');
      } else {
        const routines = state.plan.routines.map(routine => {
          const name = typeof routine.name === 'string' ? routine.name : String(routine.id || 'routine');
          const ex = Array.isArray(routine.ex) ? routine.ex : [];
          const ids = ex
            .map(item => (asRecord(item)?.id ?? ''))
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          const scheduled = Object.values(state.plan?.week || {}).includes(routine.id);
          const exercises = ids.map(labelled).join(', ') || '(no exercises)';
          return `${routine.id} "${name}"${scheduled ? ' (scheduled)' : ''}: ${exercises}`;
        });
        lines.push(`Plan: ${routines.join(' | ')}`);
      }
    } else {
      lines.push('Plan: no synced plan is available for this account');
    }

    const workouts = state.snapshot.workouts || [];
    if (workouts.length) {
      const last = workouts[workouts.length - 1] || {};
      const date = typeof last.d === 'string' ? last.d : 'unknown date';
      const name = typeof last.name === 'string' ? last.name : 'session';
      lines.push(`Recent training: ${workouts.length} stored sessions, last "${name}" on ${date}`);
      const logged: string[] = [];
      for (const workout of workouts.slice(-3)) {
        const entries = Array.isArray(workout.entries) ? workout.entries : [];
        for (const entry of entries) {
          const record = asRecord(entry);
          if (!record || typeof record.id !== 'string') continue;
          const sets = Array.isArray(record.sets) ? record.sets.length : 0;
          if (!sets) continue;
          logged.push(`${labelled(record.id)} x${sets}`);
        }
      }
      if (logged.length) lines.push(`Logged work: ${[...new Set(logged)].slice(0, 12).join(', ')}`);

      // The most-trained exercises are the safest anchors for an athlete with no routine
      // templates: a new plan built from ids the model can already see here needs no guesswork.
      const frequency = new Map<string, number>();
      for (const workout of workouts) {
        for (const key of ['entries', 'exercises'] as const) {
          const list = Array.isArray(workout[key]) ? workout[key] as unknown[] : [];
          for (const item of list) {
            const record = asRecord(item);
            if (!record || typeof record.id !== 'string' || !record.id) continue;
            frequency.set(record.id, (frequency.get(record.id) || 0) + 1);
          }
        }
      }
      const topIds = [...frequency.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 12)
        .map(([id]) => id);
      if (topIds.length) lines.push(`Recent workout exercises: ${topIds.map(labelled).join(', ')}`);
    } else {
      lines.push('Recent training: no stored sessions');
    }

    return lines.join('\n');
  }

  private async resolveProfile(uid: string, request: CoachStreamRequest): Promise<ProfileChoice> {
    if (request.fixture === true && fixtureAllowed()) return { mode: 'fixture', resolved: null };
    const profileId = request.profileId || DEFAULT_PROFILE_ID;
    try {
      const resolved = await this.configs.resolve(uid, profileId);
      return { mode: resolved.provider === 'fixture' ? 'fixture' : 'model', resolved };
    } catch (error) {
      // No usable instance/user profile: the deterministic fixture response is the
      // documented degradation on a non-production instance, and nothing else is.
      if (profileId === DEFAULT_PROFILE_ID && fixtureAllowed()) return { mode: 'fixture', resolved: null };
      throw error;
    }
  }

  private async composeNode(uid: string, state: CoachGraphState, ctx: StreamContext): Promise<Partial<CoachGraphState>> {
    this.abortIfNeeded(ctx);
    this.startStep(ctx, 'compose', 'Drafting coaching insights');

    const maxVisuals = resolveMaxVisuals(state.request.maxVisuals);
    const committedNodes: GenUINode[] = [];
    const warnings: string[] = [];
    const usedIds = new Set<string>();
    const pendingIds = new Set<string>();
    const plainLines: string[] = [];
    let committedVisuals = 0;

    /* Commit one validated node the moment its raw JSON exists on the wire. Only the hard
     * node cap, catalogue validation, an explicitly requested visual budget and the
     * proposal review run here, so the model is otherwise free to compose the answer. */
    const commitRawNode = (raw: unknown, preferredNodeId?: string, hadPending = false): void => {
      const recordDrop = (reason: string): void => {
        if (hadPending && preferredNodeId) {
          pendingIds.delete(preferredNodeId);
          ctx.emit({
            type: AGUI_EVENT_TYPES.CUSTOM,
            name: GENUI_CUSTOM_EVENTS.NODE_DROP,
            value: { nodeId: preferredNodeId, reason },
          });
        }
        warnings.push(`node dropped: ${reason}`);
      };

      if (committedNodes.length >= MAX_GENUI_NODES) {
        recordDrop('max_nodes_exceeded');
        return;
      }

      const verdict = validateGenUINode(this.normalizeRawNode(raw), { validExIds: state.validExIds });
      if (!verdict.ok) {
        recordDrop(verdict.reason || 'invalid_node');
        return;
      }
      const node = verdict.node as unknown as GenUINode;
      const nodeType = typeof node.type === 'string' ? node.type : '';

      if (maxVisuals !== null && isHeavyVisual(nodeType) && committedVisuals >= maxVisuals) {
        recordDrop('visual_budget_exceeded');
        return;
      }

      // Keep the id the client already saw in a prose_delta / node_pending frame so it can
      // replace the placeholder in place; otherwise guarantee a unique id.
      let finalId: string;
      if (preferredNodeId && !usedIds.has(preferredNodeId)) {
        finalId = preferredNodeId;
      } else {
        const base = typeof node.id === 'string' && node.id ? node.id : 'node';
        finalId = base;
        let suffix = 1;
        while (usedIds.has(finalId)) finalId = `${base}_${++suffix}`;
      }

      let finalNode: GenUINode = finalId === node.id ? node : { ...node, id: finalId };
      if (nodeType === GENUI_NODE_TYPES.PROPOSAL_ACTION) {
        const verified = this.verifyProposalNode(finalNode, state);
        if (verified.warning) warnings.push(verified.warning);
        if (!verified.node) {
          recordDrop('proposal_nochange');
          return;
        }
        finalNode = verified.node;
      }

      usedIds.add(typeof finalNode.id === 'string' ? finalNode.id : finalId);
      committedNodes.push(finalNode);
      if (isHeavyVisual(nodeType)) committedVisuals += 1;
      if (preferredNodeId) pendingIds.delete(preferredNodeId);
      ctx.emit({
        type: AGUI_EVENT_TYPES.CUSTOM,
        name: GENUI_CUSTOM_EVENTS.NODE_COMMIT,
        value: { node: finalNode },
      });
    };

    /* Emit a complete node (fixture, legacy v1 payload, or the final fallback) with the same
     * interleaved frames a streamed node produces: prose deltas, then an in-place commit;
     * a structured node gets a pending skeleton first. */
    const emitWholeNode = (node: GenUINode): void => {
      const nodeType = typeof node.type === 'string' ? node.type : '';
      const preferred = typeof node.id === 'string' && node.id ? node.id : `node_${committedNodes.length + 1}`;
      if (nodeType === GENUI_NODE_TYPES.PROSE) {
        const text = typeof node.text === 'string' ? node.text : '';
        const tone = typeof node.tone === 'string' ? node.tone : '';
        for (const delta of splitTextDeltas(text)) {
          ctx.emit({
            type: AGUI_EVENT_TYPES.CUSTOM,
            name: GENUI_CUSTOM_EVENTS.PROSE_DELTA,
            value: { nodeId: preferred, delta, ...(tone ? { tone } : {}) },
          });
        }
        commitRawNode(node, preferred, false);
        return;
      }

      if (committedNodes.length < MAX_GENUI_NODES) {
        pendingIds.add(preferred);
        ctx.emit({
          type: AGUI_EVENT_TYPES.CUSTOM,
          name: GENUI_CUSTOM_EVENTS.NODE_PENDING,
          value: { nodeId: preferred, nodeType },
        });
      }
      commitRawNode(node, preferred, pendingIds.has(preferred));
    };

    const choice = await this.resolveProfile(uid, state.request);

    if (choice.mode === 'fixture') {
      const fixture = buildFixtureGenUIResponse({
        question: state.request.text,
        plan: state.plan,
        ...(state.request.formSubmission ? { formSubmission: state.request.formSubmission } : {}),
        validExIds: state.validExIds,
        ...(maxVisuals !== null ? { maxVisuals } : {}),
      }) as unknown as { nodes?: unknown; text?: unknown; blocks?: unknown };
      const nodes = Array.isArray(fixture?.nodes) && fixture.nodes.length
        ? fixture.nodes as GenUINode[]
        : v1ToGenUINodes(fixture?.text, fixture?.blocks) as unknown as GenUINode[];
      for (const node of nodes) emitWholeNode(node);
    } else {
      const resolved = choice.resolved;
      if (resolved) {
        const searchTool = createCatalogueSearchTool({
          entries: catalogueEntries() as unknown as Array<Record<string, unknown>>,
        });
        const toolDefs = [{
          name: searchTool.id,
          description: searchTool.description,
          parameters: searchTool.argsSchema as Record<string, unknown>,
        }];
        const callOptions = ctx.signal ? { signal: ctx.signal } : {};
        const messages: BaseMessage[] = [new SystemMessage(this.buildSystemMessage(state, maxVisuals))];
        for (const turn of state.request.history || []) {
          messages.push(turn.role === 'assistant' ? new AIMessage(turn.content) : new HumanMessage(turn.content));
        }
        messages.push(new HumanMessage(this.buildUserTurn(state)));

        const handleEvent = (event: ParserEvent): void => {
          switch (event.kind) {
            case 'prose_delta': {
              if (committedNodes.length >= MAX_GENUI_NODES) return;
              ctx.emit({
                type: AGUI_EVENT_TYPES.CUSTOM,
                name: GENUI_CUSTOM_EVENTS.PROSE_DELTA,
                value: {
                  nodeId: event.nodeId,
                  delta: event.delta,
                  ...(event.tone ? { tone: event.tone } : {}),
                },
              });
              return;
            }
            case 'node_pending': {
              const heavy = isHeavyVisual(event.nodeType);
              if (
                committedNodes.length < MAX_GENUI_NODES
                && (!heavy || maxVisuals === null || committedVisuals < maxVisuals)
              ) {
                pendingIds.add(event.nodeId);
                ctx.emit({
                  type: AGUI_EVENT_TYPES.CUSTOM,
                  name: GENUI_CUSTOM_EVENTS.NODE_PENDING,
                  value: { nodeId: event.nodeId, nodeType: event.nodeType },
                });
              }
              return;
            }
            case 'node_raw': {
              commitRawNode(event.raw, event.nodeId, event.hadPending && pendingIds.has(event.nodeId));
              return;
            }
            case 'legacy_payload': {
              const legacyNodes = v1ToGenUINodes(event.raw.text, event.raw.blocks) as unknown as GenUINode[];
              for (const node of legacyNodes) emitWholeNode(node);
              return;
            }
            case 'plain_text': {
              const cleaned = event.text.replace(/<[|｜]DSML[|｜][\s\S]*/gi, '').trim();
              if (cleaned) plainLines.push(cleaned);
              return;
            }
            case 'malformed_line': {
              // One broken line never kills the rest of the answer: if its skeleton was
              // already shown, withdraw it and keep parsing subsequent lines.
              if (event.hadPending && event.nodeId && pendingIds.has(event.nodeId)) {
                pendingIds.delete(event.nodeId);
                ctx.emit({
                  type: AGUI_EVENT_TYPES.CUSTOM,
                  name: GENUI_CUSTOM_EVENTS.NODE_DROP,
                  value: { nodeId: event.nodeId, reason: 'malformed_json' },
                });
              }
              warnings.push('malformed line dropped: malformed_json');
              return;
            }
            default:
              return;
          }
        };

        const handleEvents = (events: ParserEvent[]): void => {
          for (const event of events) handleEvent(event);
        };

        const knownNodeTypes = new Set<string>(Object.values(GENUI_NODE_TYPES));
        let forceNoToolsNextRound = false;
        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          this.abortIfNeeded(ctx);
          // On the final round (or after rescuing misused UI-node tool calls) bind no tools,
          // so the model writes plain NDJSON without looping or leaking tool markup.
          const activeModel = (round === MAX_TOOL_ROUNDS || forceNoToolsNextRound
            ? createLangChainChatModel({
                resolved,
                streaming: true,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              })
            : createLangChainChatModel({
                resolved,
                streaming: true,
                tools: toolDefs,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              })) as unknown as StreamableChatModel;

          // A fresh parser per round keeps a tool-call preamble from corrupting NDJSON.
          let parser = createNdjsonNodeParser();
          let accumulated: unknown = null;
          let roundText = '';
          let sawToolCallsInRound = false;
          const manualCalls = new Map<number, ManualToolCall>();

          const processChunk = (chunk: unknown): void => {
            this.abortIfNeeded(ctx);
            const record = asRecord(chunk);
            if (hasAnyToolCall(record)) sawToolCallsInRound = true;

            // Manual fallback aggregation: works even when a chunk lacks `.concat()`.
            const toolChunks = Array.isArray(record?.tool_call_chunks) ? record.tool_call_chunks : [];
            toolChunks.forEach((raw, position) => {
              const part = asRecord(raw);
              if (!part) return;
              const index = typeof part.index === 'number' ? part.index : position;
              const entry = manualCalls.get(index) || { id: '', name: '', args: '' };
              // Providers can repeat an id; only the first non-empty one counts, and the
              // name is appended only when it is a new fragment rather than a repeat.
              if (typeof part.id === 'string' && part.id && !entry.id) entry.id = part.id;
              if (typeof part.name === 'string' && part.name && entry.name !== part.name) entry.name += part.name;
              if (typeof part.args === 'string') entry.args += part.args;
              manualCalls.set(index, entry);
            });

            // LangChain's AIMessageChunk merges text and tool calls on concat.
            const previous = asRecord(accumulated);
            if (previous && typeof previous.concat === 'function') {
              accumulated = (previous.concat as (next: unknown) => unknown)(chunk);
            } else if (!accumulated) {
              accumulated = chunk;
            }

            if (!sawToolCallsInRound) {
              const piece = textOfModelChunk(chunk);
              if (piece) {
                roundText += piece;
                handleEvents(parser.push(piece));
              }
            }
          };

          if (typeof activeModel.stream === 'function') {
            const stream = await activeModel.stream(messages, callOptions);
            for await (const chunk of stream) processChunk(chunk);
          } else {
            // A model without a streaming surface still goes through the same NDJSON /
            // legacy normalisation pipeline, just in one chunk.
            const message = await activeModel.invoke(messages, callOptions);
            processChunk(message);
          }

          const toolCalls = normalizeToolCalls(accumulated, manualCalls);
          // Guarantee a non-empty id on every call BEFORE the assistant message is built, and
          // reuse that exact id for TOOL_CALL_START, TOOL_CALL_RESULT and ToolMessage so the
          // OpenAI/DeepSeek tool_call_id matching can never fail on a nameless provider chunk.
          const resolvedToolCalls = toolCalls.map(call => ({
            ...call,
            id: call.id || `tool_${randomUUID()}`,
          }));
          if (resolvedToolCalls.length > 0 && round < MAX_TOOL_ROUNDS) {
            // Discard any placeholder opened by the tool preamble; the answer continues in
            // the next round with a fresh parser.
            for (const nodeId of [...pendingIds]) {
              pendingIds.delete(nodeId);
              ctx.emit({
                type: AGUI_EVENT_TYPES.CUSTOM,
                name: GENUI_CUSTOM_EVENTS.NODE_DROP,
                value: { nodeId, reason: 'tool_round_reset' },
              });
            }
            messages.push(new AIMessage({ content: roundText, tool_calls: resolvedToolCalls }));
            let calledSearchTool = false;
            for (const call of resolvedToolCalls) {
              const callId = call.id;
              // Some models (e.g. DeepSeek when tools are bound) occasionally invoke a GenUI
              // node type like `proposal_action` or `callout` via tool_calls instead of NDJSON.
              // Rescue and commit it cleanly through the exact same validation gate!
              if (call.name !== searchTool.id && knownNodeTypes.has(call.name)) {
                emitWholeNode({ ...(asRecord(call.args) || {}), type: call.name });
                messages.push(new ToolMessage({
                  tool_call_id: callId,
                  name: call.name,
                  content: JSON.stringify({
                    ok: true,
                    rendered: true,
                    note: 'Component rendered to the user. Emit any remaining prose/nodes as plain NDJSON lines, NOT tool calls.',
                  }),
                }));
                continue;
              }

              calledSearchTool = true;
              ctx.emit({
                type: AGUI_EVENT_TYPES.TOOL_CALL_START,
                toolCallId: callId,
                toolCallName: call.name,
                args: call.args,
              });

              let payload: Record<string, unknown>;
              try {
                if (call.name === searchTool.id) {
                  const result = await searchTool.run(call.args) as { items?: unknown[] };
                  const items = Array.isArray(result?.items) ? result.items : [];
                  payload = { items: items.map(item => compactSearchItem(item, state.request.lang)) };
                } else {
                  payload = { error: `unknown tool: ${call.name}`, items: [] };
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                payload = { error: sanitizeErrorText(message) || 'tool failed', items: [] };
              }

              ctx.emit({
                type: AGUI_EVENT_TYPES.TOOL_CALL_RESULT,
                toolCallId: callId,
                toolCallName: call.name,
                summary: JSON.stringify(payload).slice(0, 2000),
              });
              messages.push(new ToolMessage({
                tool_call_id: callId,
                name: call.name,
                content: JSON.stringify(payload),
              }));
            }
            if (!calledSearchTool) forceNoToolsNextRound = true;
            continue;
          }

          // No tool calls (or the forced final round): flush and stop.
          if (!roundText) {
            const fallbackText = textOfModelChunk(accumulated);
            if (fallbackText) {
              roundText = fallbackText;
              handleEvents(parser.push(fallbackText));
            }
          }
          handleEvents(parser.flush());
          break;
        }

        if (committedNodes.length === 0 && plainLines.length > 0) {
          const proseNodes = v1ToGenUINodes(plainLines.join('\n\n'), []) as unknown as GenUINode[];
          for (const node of proseNodes) emitWholeNode(node);
        }
      }
    }

    this.abortIfNeeded(ctx);

    if (committedNodes.length === 0) {
      emitWholeNode({
        id: `prose_${committedNodes.length + 1}`,
        type: GENUI_NODE_TYPES.PROSE,
        text: isZhLang(state.request.lang)
          ? '我暂时没能把这条回答整理好，请稍后再问我一次。'
          : 'I could not put that answer together. Try asking again in a moment.',
      });
    }

    this.finishStep(ctx, 'compose');
    return { nodes: committedNodes, warnings };
  }

  private buildSystemMessage(state: CoachGraphState, maxVisuals: number | null): string {
    const lang = state.request.lang;
    const parts = [
      buildCoachGenUISystemPrompt(maxVisuals !== null ? { maxVisuals } : {}),
      ...(state.request.today ? [`## Today\n${state.request.today}`] : []),
      ...(lang ? [
        `## Response language\nWrite ALL user-facing text in language "${lang}"`
        + `${isZhLang(lang) ? ' (Simplified Chinese)' : ''}: every prose "text", every node "title" and "caption", `
        + 'every "reason", "why" and "summary", and every form "fields[].label" and "options[].label". '
        + 'Whenever you mention an exercise, use the localized name given for its id in the grounded training context'
        + `${isZhLang(lang) ? '; never output a raw English exercise name' : ''}. `
        + 'Keep exercise ids ("exId", "id"), enum keys and JSON field names exactly as specified.',
      ] : []),
      `## Grounded training context\n${state.contextSummary}`,
      ...(state.plan && state.plan.routines.length > 0 ? [`## Plan (routines and week)\n${JSON.stringify({ routines: state.plan.routines, week: state.plan.week })}`] : []),
      '## Response contract\nReply with coach-genui.v2 NDJSON: exactly one flat JSON node per line '
        + '({ "id": string, "type": string, ... }). Do not wrap the nodes in an array, a code fence or any '
        + `surrounding prose. At most ${MAX_GENUI_NODES} nodes in total, prose included. `
        + 'Compose freely: prose, kpi_strip, comparison_table, callout, exercise_trend, muscle_load, '
        + 'exercise_alternatives, quick_form and proposal_action, in whatever mix the answer needs — pure '
        + 'prose is fine. Do not repeat in prose a number, fact or label that a node already shows. '
        + 'Use search_catalogue whenever you need a real exercise id that is not already in the athlete\'s '
        + 'current plan; never guess an id. Only a `prescription` kpi item may carry a literal value; '
        + 'exercise_stat, muscle_sets and session_count are hydrated by the client, so never write their '
        + 'value (and never invent a chart series, e1RM, weight or volume number). '
        + (maxVisuals !== null
          ? `Use at most ${maxVisuals} heavy visual node(s) (exercise_trend or muscle_load). `
          : '')
        + 'For swap-exercise in proposal_action, use target: { routineId, exId } and after: { id: "<swap_ex_id>" }; '
        + 'for sets/reps/repsMin/repsMax changes, after must be a positive integer (never a string range like "8-10"); '
        + 'for reorder, target is { routineId } and after must be an array of all exercise ids in that routine in the new order. '
        + 'Do not emit checklist todo widgets in chat; use callout or concise prose for reminders and warm-up cues.',
    ];
    return parts.join('\n\n');
  }

  private buildUserTurn(state: CoachGraphState): string {
    const form = state.request.formSubmission;
    const question = state.request.text || '(no free-text question; the user answered a quick form)';
    if (!form) return question;
    return `${question}\n\n## Quick form answers\nformId: ${form.formId || 'unknown'}\n${JSON.stringify(form.answers)}`;
  }

  /* `validateGenUINode` runs the shared protocol cleaner, which keeps only the fields it
   * already knows. A model's add-routine drift (exId aliases, "8-12" rep ranges, numeric
   * sets strings) would be erased there and never reach `validateReview`, so proposal
   * changes are repaired first — every id still has to pass the catalogue allow-list. */
  private normalizeRawNode(raw: unknown): unknown {
    const record = asRecord(raw);
    if (!record || record.type !== GENUI_NODE_TYPES.PROPOSAL_ACTION) return raw;
    return { ...record, changes: normalizeProposalChanges(record.changes) };
  }

  /** The last gate before a node reaches the client: proposals must survive the closed
   *  change list and the caller's plan. A rejected proposal keeps its id and becomes a
   *  localized fallback_notice, so the frontend replaces the pending card in place. */
  private verifyProposalNode(node: GenUINode, state: CoachGraphState): { node: GenUINode | null; warning?: string } {
    if (node.type !== GENUI_BLOCK_TYPES.PROPOSAL_ACTION) return { node };
    const isZh = isZhLang(state.request.lang);
    const fallback = (text: string): GenUINode => ({
      id: node.id,
      type: GENUI_BLOCK_TYPES.FALLBACK_NOTICE,
      text,
    });
    if (!state.plan) {
      return {
        node: fallback(
          isZh
            ? '需要先同步你的训练计划，才能生成可一键应用的调整提案。'
            : 'I need your synced plan before I can propose a change. Sync it and ask me again.',
        ),
        warning: 'proposal_action downgraded: no plan available to verify the change against',
      };
    }
    const review = validateReview(
      { summary: node.summary, changes: normalizeProposalChanges(node.changes) },
      state.plan,
      { customIds: [...state.validExIds] },
    ) as {
      ok?: boolean;
      errors?: unknown;
      nochange?: boolean;
      proposal?: { summary?: string; changes?: unknown[] };
    };

    if (!review || review.ok !== true) {
      const detail = Array.isArray(review?.errors) ? review.errors.map(String).slice(0, 2).join('; ') : '';
      return {
        node: fallback(
          isZh
            ? `该调整提案未能通过计划校验${detail ? `（${detail}）` : ''}，因此暂未生成一键应用按钮。`
            : `I could not verify that change against your plan${detail ? ` (${detail})` : ''}, so I am not offering it as a one-tap action.`,
        ),
        warning: `proposal_action downgraded: ${detail || 'validation failed'}`,
      };
    }
    if (review.nochange === true || !Array.isArray(review.proposal?.changes) || review.proposal.changes.length === 0) {
      return {
        node: null,
        warning: 'proposal_action dropped: validation returned no change',
      };
    }

    return {
      node: {
        ...node,
        changes: review.proposal.changes,
        ...(typeof review.proposal.summary === 'string' && review.proposal.summary ? { summary: review.proposal.summary } : {}),
      },
    };
  }
}
