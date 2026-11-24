/* Safe diagnostic bridge for exercise-search.* tasks.
 *
 * Emits only whitelisted summary fields matching exercise-search-diagnostics.js
 * and never logs API keys, image data URLs, prompts, or raw provider errors.
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import type { Serialized } from '@langchain/core/load/serializable';
import type { AttachmentReference } from '../../../agent-runtime/contracts.js';
import { ERROR_STATUS } from '../../../agent-runtime/errors.js';
import { mapLangChainError } from './errors.js';

const DIAGNOSTIC_MAX_IMAGES = 2;
const DIAGNOSTIC_ERROR_CODES = new Set(Object.keys(ERROR_STATUS));

export type DiagnosticSink = (event: Record<string, unknown>) => void;

export function safeDiagnosticErrorCode(code: unknown): string {
  return typeof code === 'string' && DIAGNOSTIC_ERROR_CODES.has(code) ? code : 'model_unavailable';
}

export interface ExerciseSearchDiagnosticCallbackOptions {
  taskId: string;
  diagnostic?: unknown;
  round: number;
  isCancelled?: () => boolean;
  now?: () => number;
  onModelEmitted?: () => void;
}

class ExerciseSearchModelCallbackHandler extends BaseCallbackHandler {
  name = 'openGymExerciseSearchDiagnostic';
  private readonly startTimes = new Map<string, number>();

  constructor(
    private readonly emit: DiagnosticSink,
    private readonly round: number,
    private readonly isCancelled: () => boolean,
    private readonly now: () => number,
    private readonly onModelEmitted?: () => void,
  ) {
    super();
  }

  private safeEmit(event: Record<string, unknown>): void {
    try {
      this.emit(event);
    } catch {
      /* a throwing sink must never break the run */
    }
  }

  override handleChatModelStart(
    _llm: Serialized,
    _messages: BaseMessage[][],
    runId: string,
  ): void {
    try {
      this.startTimes.set(runId, this.now());
    } catch {
      /* ignore timing errors */
    }
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    try {
      const startedAt = this.startTimes.get(runId) ?? this.now();
      this.startTimes.delete(runId);
      const message = output?.generations?.[0]?.[0] && 'message' in output.generations[0][0]
        ? (output.generations[0][0] as { message?: { tool_calls?: unknown[] } }).message
        : undefined;
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
      const status = this.isCancelled() ? 'cancelled' : 'completed';
      this.onModelEmitted?.();
      this.safeEmit({
        stage: 'model',
        round: this.round,
        status,
        elapsedMs: Math.max(0, this.now() - startedAt),
        toolCalls,
      });
    } catch {
      /* never break the run */
    }
  }

  override handleLLMError(err: unknown, runId: string): void {
    try {
      const startedAt = this.startTimes.get(runId) ?? this.now();
      this.startTimes.delete(runId);
      const mapped = mapLangChainError(err);
      this.onModelEmitted?.();
      this.safeEmit({
        stage: 'model',
        round: this.round,
        status: 'failed',
        elapsedMs: Math.max(0, this.now() - startedAt),
        toolCalls: 0,
        errorCode: safeDiagnosticErrorCode(mapped.code),
      });
    } catch {
      /* never break the run */
    }
  }
}

export function createExerciseSearchDiagnosticCallbacks(
  options: ExerciseSearchDiagnosticCallbackOptions,
): BaseCallbackHandler[] {
  if (typeof options.taskId !== 'string' || !options.taskId.startsWith('exercise-search.')) {
    return [];
  }
  if (typeof options.diagnostic !== 'function') {
    return [];
  }
  const emit = options.diagnostic as DiagnosticSink;
  const now = options.now ?? Date.now;
  const isCancelled = options.isCancelled ?? (() => false);
  return [
    new ExerciseSearchModelCallbackHandler(emit, options.round, isCancelled, now, options.onModelEmitted),
  ];
}

export interface ExerciseSearchDiagnosticTracker {
  readonly enabled: boolean;
  setPhase(phase: string): void;
  phase(): string;
  emitAttachments(attachments: AttachmentReference[]): void;
  createRoundCallbacks(round: number, isCancelled: () => boolean): {
    callbacks: BaseCallbackHandler[];
    wasEmitted: () => boolean;
    emitFallbackFailure: (error: unknown, startedAt: number) => void;
  };
  emitEnd(status: string, errorCode?: unknown): void;
}

export function createExerciseSearchDiagnosticTracker(
  taskId: string,
  diagnostic: unknown,
  now: () => number = Date.now,
): ExerciseSearchDiagnosticTracker {
  const sink = typeof taskId === 'string' && taskId.startsWith('exercise-search.')
    && typeof diagnostic === 'function'
    ? (diagnostic as DiagnosticSink)
    : null;
  const emit: DiagnosticSink = event => {
    if (!sink) return;
    try {
      sink(event);
    } catch {
      /* a throwing sink must never break the run */
    }
  };
  let currentPhase = 'submit';
  let endEmitted = false;
  const startedAt = sink ? now() : 0;

  return {
    enabled: Boolean(sink),
    setPhase(phase: string) {
      currentPhase = phase;
    },
    phase() {
      return currentPhase;
    },
    emitAttachments(attachments: AttachmentReference[]) {
      if (!sink) return;
      emit({
        stage: 'attachments',
        images: attachments.slice(0, DIAGNOSTIC_MAX_IMAGES).map(attachment => ({
          mime: attachment?.mime,
          width: attachment?.width,
          height: attachment?.height,
          bytes: attachment?.size,
        })),
      });
    },
    createRoundCallbacks(round: number, isCancelled: () => boolean) {
      if (!sink) {
        return {
          callbacks: [],
          wasEmitted: () => false,
          emitFallbackFailure: () => undefined,
        };
      }
      let emitted = false;
      const callbacks = createExerciseSearchDiagnosticCallbacks({
        taskId,
        diagnostic: sink,
        round,
        isCancelled,
        now,
        onModelEmitted: () => {
          emitted = true;
        },
      });
      return {
        callbacks,
        wasEmitted: () => emitted,
        emitFallbackFailure: (error: unknown, roundStartedAt: number) => {
          if (emitted) return;
          emitted = true;
          const mapped = mapLangChainError(error);
          emit({
            stage: 'model',
            round,
            status: 'failed',
            elapsedMs: Math.max(0, now() - roundStartedAt),
            toolCalls: 0,
            errorCode: safeDiagnosticErrorCode(mapped.code),
          });
        },
      };
    },
    emitEnd(status: string, errorCode?: unknown) {
      if (!sink || endEmitted) return;
      endEmitted = true;
      emit({
        stage: 'end',
        status,
        phase: currentPhase,
        elapsedMs: Math.max(0, now() - startedAt),
        ...(status === 'failed' ? { errorCode: safeDiagnosticErrorCode(errorCode) } : {}),
      });
    },
  };
}
