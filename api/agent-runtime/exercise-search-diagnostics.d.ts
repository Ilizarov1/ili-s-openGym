/* TypeScript shape of exercise-search-diagnostics.js, hand-written in the
 * style of contracts.d.ts. The implementation is plain standard JS with no
 * platform imports; NestJS, Vite and Metro bundle it directly.
 */

export type ExerciseSearchSource = 'web' | 'rn' | 'api' | 'rn-local';

export type ExerciseSearchMediaStatus = 'ready' | 'failed' | 'cancelled';
export type ExerciseSearchRunStatus = 'completed' | 'failed' | 'cancelled';
export type ExerciseSearchEndStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ExerciseSearchEndPhase = 'submit' | 'attachments' | 'model' | 'recognition' | 'match' | 'poll';
export type ExerciseSearchExecution = 'server' | 'local';
export type ExerciseSearchQueryOrigin = 'primary' | 'english';

export type ExerciseSearchFilterDecision =
  | 'invalid_candidate'
  | 'no_hit'
  | 'cjk_ambiguous'
  | 'no_name_evidence'
  | 'below_floor'
  | 'equipment_conflict'
  | 'accepted'
  | 'accepted_cjk_fallback'
  | 'deduplicated';

/** The `write` option: receives one JSON line per event. */
export type ExerciseSearchLineWriter = (line: string) => void;

/** The per-run trace returned by createExerciseSearchTrace. */
export type ExerciseSearchTrace = (event: ExerciseSearchEvent) => void;

export interface ExerciseSearchSubmitEvent {
  stage: 'submit';
  execution: ExerciseSearchExecution;
  hasHint: boolean;
  imageCount: number;
  /** Latest successful image pick; joins the `media` stage event locally. */
  mediaAttemptId?: string;
}

export interface ExerciseSearchAttachmentImage {
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

export interface ExerciseSearchAttachmentsEvent {
  stage: 'attachments';
  images: ExerciseSearchAttachmentImage[];
}

export interface ExerciseSearchModelEvent {
  stage: 'model';
  round: number;
  status: ExerciseSearchRunStatus;
  elapsedMs: number;
  toolCalls: number;
  /** Recorded on failure only; undeclared codes become `unknown`. */
  errorCode?: string;
}

export interface ExerciseSearchRecognitionEvent {
  stage: 'recognition';
  rawCandidateCount: number;
  cleanCandidateCount: number;
  /** Slug-whitelisted against the task vocabulary snapshot. */
  equipment?: string[];
  bodyParts?: string[];
}

export interface ExerciseSearchRecallTopItem {
  /** Public catalogue id, validated by the upstream caller. */
  id: string;
  score: number;
}

export interface ExerciseSearchRecallEvent {
  stage: 'recall';
  candidateIndex: number;
  queryOrigin: ExerciseSearchQueryOrigin;
  queryWordCount: number;
  hitCount: number;
  /** Ranked slice of the actual first five, never re-picked to fill. */
  top: ExerciseSearchRecallTopItem[];
}

export interface ExerciseSearchFilterEvent {
  stage: 'filter';
  candidateIndex: number;
  decision: ExerciseSearchFilterDecision;
  /** Present only when a public id was actually accepted or rejected. */
  id?: string;
}

export interface ExerciseSearchDisplayEvent {
  stage: 'display';
  resultCount: number;
  publicIds: string[];
  customCount: number;
  fallbackOnly: boolean;
  elapsedMs: number;
}

export interface ExerciseSearchEndEvent {
  stage: 'end';
  status: ExerciseSearchEndStatus;
  phase: ExerciseSearchEndPhase;
  elapsedMs: number;
  /** Recorded on failure only; undeclared codes become `unknown`. */
  errorCode?: string;
}

/** One stage event; only the fields declared for the stage are recorded. */
export type ExerciseSearchEvent =
  | ExerciseSearchSubmitEvent
  | ExerciseSearchAttachmentsEvent
  | ExerciseSearchModelEvent
  | ExerciseSearchRecognitionEvent
  | ExerciseSearchRecallEvent
  | ExerciseSearchFilterEvent
  | ExerciseSearchDisplayEvent
  | ExerciseSearchEndEvent;

export interface ExerciseSearchMediaMetrics {
  status: ExerciseSearchMediaStatus;
  /** Fields a platform cannot observe are omitted by the caller. */
  inputBytes?: number;
  outputBytes?: number;
  outputWidth?: number;
  outputHeight?: number;
  attempts?: number;
  rotationApplied?: boolean;
  elapsedMs?: number;
  /** Recorded on failure only; undeclared codes become `unknown`. */
  errorCode?: string;
}

export interface ExerciseSearchTraceOptions {
  traceId: string;
  source: ExerciseSearchSource;
  enabled: boolean;
  write?: ExerciseSearchLineWriter;
}

export interface ExerciseSearchMediaOptions {
  mediaAttemptId: string;
  source: ExerciseSearchSource;
  enabled: boolean;
  write?: ExerciseSearchLineWriter;
  metrics: ExerciseSearchMediaMetrics;
}

/** `req_` plus a lowercase hex UUID, or the Web legacy `req_<13 digits>_<base36>`. */
export function isExerciseSearchTraceId(value: unknown): value is string;

/** `undefined` when diagnostics are off or the trace id is invalid. */
export function createExerciseSearchTrace(options: ExerciseSearchTraceOptions): ExerciseSearchTrace | undefined;

/** Only declared agent error codes pass through; everything else is `unknown`. */
export function safeExerciseSearchError(code: unknown): string;

/** Emits one `media` stage event on its own fresh trace id. */
export function logExerciseSearchMedia(options: ExerciseSearchMediaOptions): void;
