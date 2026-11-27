/* Type declarations for the shared Generative-UI protocol core.
 *
 * Mirrors protocol.js exactly; both hosts import the JavaScript module.
 */

export const GENUI_PROTOCOL_VERSION: 2;
export const MAX_GENUI_BLOCKS: 6;
export const MAX_GENUI_NODES: 12;
export const DEFAULT_MAX_VISUAL_NODES: 1;
export const MAX_VISUAL_NODES_LIMIT: 4;
export const MAX_COACH_GENUI_TURNS: 10;
export const GENUI_FALLBACK_TEXT: string;

export type AgUiEventType =
  | 'RUN_STARTED'
  | 'STEP_STARTED'
  | 'STEP_FINISHED'
  | 'TOOL_CALL_START'
  | 'TOOL_CALL_RESULT'
  | 'TEXT_MESSAGE_START'
  | 'TEXT_MESSAGE_CONTENT'
  | 'TEXT_MESSAGE_END'
  | 'CUSTOM'
  | 'RUN_FINISHED'
  | 'RUN_ERROR';

export const AGUI_EVENT_TYPES: Readonly<Record<AgUiEventType, AgUiEventType>>;

export type GenUICustomEvent =
  | 'genui.block_upsert'
  | 'genui.prose_delta'
  | 'genui.node_pending'
  | 'genui.node_commit'
  | 'genui.node_drop';

export const GENUI_CUSTOM_EVENTS: Readonly<{
  BLOCK_UPSERT: 'genui.block_upsert';
  PROSE_DELTA: 'genui.prose_delta';
  NODE_PENDING: 'genui.node_pending';
  NODE_COMMIT: 'genui.node_commit';
  NODE_DROP: 'genui.node_drop';
}>;

export type GenUIBlockType =
  | 'exercise_trend'
  | 'muscle_load'
  | 'exercise_alternatives'
  | 'quick_form'
  | 'proposal_action'
  | 'fallback_notice';

export const GENUI_BLOCK_TYPES: Readonly<Record<
  | 'EXERCISE_TREND'
  | 'MUSCLE_LOAD'
  | 'EXERCISE_ALTERNATIVES'
  | 'QUICK_FORM'
  | 'PROPOSAL_ACTION'
  | 'FALLBACK_NOTICE',
  GenUIBlockType
>>;

export type GenUIPrimitiveType =
  | 'prose'
  | 'kpi_strip'
  | 'comparison_table'
  | 'checklist'
  | 'callout';

export type GenUINodeType = GenUIPrimitiveType | GenUIBlockType;

export const GENUI_NODE_TYPES: Readonly<Record<
  | 'PROSE'
  | 'KPI_STRIP'
  | 'COMPARISON_TABLE'
  | 'CHECKLIST'
  | 'CALLOUT'
  | 'EXERCISE_TREND'
  | 'MUSCLE_LOAD'
  | 'EXERCISE_ALTERNATIVES'
  | 'QUICK_FORM'
  | 'PROPOSAL_ACTION'
  | 'FALLBACK_NOTICE',
  GenUINodeType
>>;

export const GENUI_HEAVY_VISUAL_TYPES: ReadonlyArray<'exercise_trend' | 'muscle_load'>;

export type TrendMetric = 'e1rm' | 'weight' | 'volume';
export type LoadWindow = '72h' | '7d' | '28d';
export type FormFieldKind = 'single_choice' | 'multi_choice' | 'scale';
export type ProseTone = 'normal' | 'lead' | 'closing';
export type CalloutVariant = 'info' | 'tip' | 'warning';

export interface GenUIBlockBase {
  id: string;
  type: GenUIBlockType;
}

export interface ExerciseTrendBlock extends GenUIBlockBase {
  type: 'exercise_trend';
  exId: string;
  metric: TrendMetric;
  weeks: number;
  title?: string;
  caption?: string;
  highlightStall?: boolean;
}

export interface MuscleLoadBlock extends GenUIBlockBase {
  type: 'muscle_load';
  window: LoadWindow;
  focusMuscles: string[];
  title?: string;
  caption?: string;
}

export interface AlternativeItem {
  exId: string;
  reason: string;
  tag?: string;
  routineId?: string;
}

export interface ExerciseAlternativesBlock extends GenUIBlockBase {
  type: 'exercise_alternatives';
  forExId?: string;
  routineId?: string;
  title?: string;
  items: AlternativeItem[];
}

export interface FormOption {
  value: string;
  label: string;
}

export interface FormField {
  name: string;
  label: string;
  kind: FormFieldKind;
  options?: FormOption[];
  min?: number;
  max?: number;
  unit?: string;
}

export interface QuickFormBlock extends GenUIBlockBase {
  type: 'quick_form';
  formId: string;
  title: string;
  submitLabel?: string;
  fields: FormField[];
}

export interface ProposalChange {
  id: string;
  type: string;
  target: Record<string, string | number | boolean>;
  why: string;
  before?: string | number | boolean | string[] | Record<string, string | number | boolean>;
  after?: string | number | boolean | string[] | Record<string, string | number | boolean>;
}

export interface ProposalActionBlock extends GenUIBlockBase {
  type: 'proposal_action';
  title: string;
  summary: string;
  planHash?: string;
  routineId?: string;
  changes: ProposalChange[];
}

export interface FallbackNoticeBlock extends GenUIBlockBase {
  type: 'fallback_notice';
  text: string;
}

export type GenUIBlock =
  | ExerciseTrendBlock
  | MuscleLoadBlock
  | ExerciseAlternativesBlock
  | QuickFormBlock
  | ProposalActionBlock
  | FallbackNoticeBlock;

/* ------------------------------- v2 nodes -------------------------------- */

export interface ProseNode {
  id: string;
  type: 'prose';
  text: string;
  tone?: ProseTone;
}

export interface KpiExerciseStatItem {
  kind: 'exercise_stat';
  exId: string;
  metric: TrendMetric;
  weeks: number;
  label?: string;
}

export interface KpiMuscleSetsItem {
  kind: 'muscle_sets';
  muscle: string;
  window: LoadWindow;
  label?: string;
}

export interface KpiSessionCountItem {
  kind: 'session_count';
  weeks: number;
  label?: string;
}

export interface KpiPrescriptionItem {
  kind: 'prescription';
  label: string;
  value: string;
}

export type KpiStripItem =
  | KpiExerciseStatItem
  | KpiMuscleSetsItem
  | KpiSessionCountItem
  | KpiPrescriptionItem;

export interface KpiStripNode {
  id: string;
  type: 'kpi_strip';
  items: KpiStripItem[];
}

export type ComparisonTableCell = string | { exId: string; note?: string };

export interface ComparisonTableNode {
  id: string;
  type: 'comparison_table';
  columns: string[];
  rows: ComparisonTableCell[][];
  title?: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  detail?: string;
}

export interface ChecklistNode {
  id: string;
  type: 'checklist';
  listId: string;
  items: ChecklistItem[];
  title?: string;
}

export interface CalloutNode {
  id: string;
  type: 'callout';
  variant: CalloutVariant;
  text: string;
  title?: string;
}

export type GenUINode = ProseNode | KpiStripNode | ComparisonTableNode | ChecklistNode | CalloutNode | GenUIBlock;

export interface GenUINodeOptions {
  validExIds?: Set<string> | string[];
  validMuscles?: Set<string> | string[];
  maxNodes?: number;
  maxVisuals?: number | null;
}

export interface GenUIBlockOptions {
  validExIds?: Set<string> | string[];
  validMuscles?: Set<string> | string[];
}

export type GenUIBlockVerdict =
  | { ok: true; block: GenUIBlock }
  | { ok: false; reason: string };

export type GenUINodeVerdict =
  | { ok: true; node: GenUINode }
  | { ok: false; reason: string };

export function formatSseEvent(event: Record<string, unknown>): string;

export function parseSseChunk(buffer: string): {
  events: Array<Record<string, unknown>>;
  rest: string;
};

export function validateGenUIBlock(block: unknown, options?: GenUIBlockOptions): GenUIBlockVerdict;

export function sanitizeGenUIBlocks(
  blocks: unknown,
  options?: GenUIBlockOptions,
): { blocks: GenUIBlock[]; warnings: string[] };

export function validateGenUINode(node: unknown, options?: GenUIBlockOptions): GenUINodeVerdict;

export function sanitizeGenUINodes(
  nodes: unknown,
  options?: GenUINodeOptions,
): { nodes: GenUINode[]; warnings: string[] };

export function v1ToGenUINodes(text: unknown, blocks: unknown): GenUINode[];
