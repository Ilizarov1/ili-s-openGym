// The recognition state shared by the library tab and the workout picker.
// It owns the run/session lifecycle and the session's images; the screen only
// renders candidates and decision rows.
import { randomUUID } from 'expo-crypto';
import { createExerciseAiSearch } from '../../../frontend/src/lib/exercise-ai-search.js';
import { AgentError, createId, EXERCISE_SEARCH_TASK_ID, validateExerciseSearchInput } from './shared';
import { clearAiRunReference, rememberAiRun, settleAiRun } from './recovery';
import type { AgentLaunch } from './config';
import type { LocalAgentRuntime } from './runtime';
import type { ServerAgent } from './server-client';
import type {
  AgentAiImageInput, AgentAiImageRow, AgentExecutionLocation, AgentProfilePublic, AgentProfileSummary, AgentRunRow,
} from './types';
import type { LibraryExercise, LibrarySearch } from '../librarySearch';
import type { Connection } from '../server';

export type AiSearchItem = {
  exerciseId: string;
  name: string;
  rationale: string;
  level: 'high' | 'medium' | 'low';
};

export type AiSearchFallback = {
  understanding: string;
  bodyParts?: string[];
  equipment?: string[];
};

export type AiSearchMatch = {
  items: AiSearchItem[];
  fallback: AiSearchFallback;
};

type SharedMatcher = {
  match: (output: unknown, hints?: { hintText?: string }) => AiSearchMatch;
};

const matchers = new WeakMap<object, SharedMatcher>();

function matcherFor(source: LibrarySearch): SharedMatcher {
  const cached = matchers.get(source);
  if (cached) return cached;
  const factory = createExerciseAiSearch as unknown as (options: {
    searchScored: (list: LibraryExercise[], query: string) => { exercise: LibraryExercise; score: number }[];
    list: LibraryExercise[];
    bodyPartValues: string[];
    equipmentValues: string[];
  }) => SharedMatcher;
  const matcher = factory({
    searchScored: (list, query) => source.aiSearch.searchScored(query)
      .filter(hit => list.includes(hit.exercise)),
    list: source.aiSearch.pool,
    bodyPartValues: source.aiSearch.bodyPartValues,
    equipmentValues: source.aiSearch.equipmentValues,
  });
  matchers.set(source, matcher);
  return matcher;
}

/** Match the task's structured candidates against the same unfiltered pool. */
export function matchAiSearch(
  source: LibrarySearch,
  structured: unknown,
  hintText: string,
): AiSearchMatch {
  return matcherFor(source).match({ structured }, { hintText });
}

export function structuredOf(run: AgentRunRow | null | undefined): unknown {
  if (!run || !run.result || typeof run.result !== 'object') return null;
  return (run.result as { structured?: unknown }).structured ?? null;
}

export function exerciseOf(source: LibrarySearch, item: AiSearchItem): LibraryExercise | null {
  return source.aiSearch.pool.find(exercise => exercise.id === item.exerciseId) ?? null;
}

export type AiSearchLaunch = AgentLaunch;

export type AiStartTurnInput = {
  hintText: string;
  image?: AiSearchImageInput;
  /** Fixture/acceptance only; real providers ignore it. */
  fixtureCase?: 'candidates' | 'fallback-only' | 'error';
};

export type AiSearchImageInput = AgentAiImageInput;

export type AiTurnStart = {
  run: AgentRunRow;
  images: AgentAiImageRow[];
};

export type AiSearchControllerOptions = {
  connection: Connection | null;
  runtime: LocalAgentRuntime;
  server: ServerAgent | null;
  launch: AgentLaunch;
  sessionId?: string;
};

/**
 * One recognition session. Images live in SQLite for both execution
 * locations; the server always receives them inline and never stores them.
 */
export class AiSearchController {
  readonly sessionId: string;
  private launchValue: AgentLaunch;
  private readonly connection: Connection | null;
  private readonly runtime: LocalAgentRuntime;
  private readonly server: ServerAgent | null;
  private readonly scope: string;
  private runs = 0;
  private turn = 0;
  private activeRunId: string | null = null;
  private disposed = false;

  constructor(options: AiSearchControllerOptions) {
    this.connection = options.connection;
    this.runtime = options.runtime;
    this.server = options.server;
    this.launchValue = options.launch;
    this.scope = options.runtime.scope;
    this.sessionId = options.sessionId ?? `ses_${randomUUID()}`;
  }

  get launch(): AgentLaunch {
    return this.launchValue;
  }

  get location(): AgentExecutionLocation {
    return this.launchValue.location;
  }

  get summary(): AgentProfileSummary {
    return this.launchValue.summary;
  }

  get profile(): AgentProfilePublic {
    return this.launchValue.profile;
  }

  /** Re-resolve the model inside the fixed execution location. */
  retarget(launch: AgentLaunch): void {
    if (launch.location !== this.launchValue.location) {
      throw new Error('a follow-up cannot change its execution location');
    }
    this.launchValue = launch;
  }

  get submittedRuns(): number {
    return this.runs;
  }

  get canContinue(): boolean {
    return !this.disposed && this.runs < 6;
  }

  get runId(): string | null {
    return this.activeRunId;
  }

  currentImages(): AgentAiImageRow[] {
    return this.runtime.store.listAiImages(this.scope, this.sessionId);
  }

  latestImage(): AgentAiImageRow | null {
    return this.currentImages()[0] ?? null;
  }

  async startTurn(input: AiStartTurnInput): Promise<AiTurnStart> {
    if (this.disposed) throw new Error('this search has ended');
    if (!this.canContinue) {
      throw new AgentError('turn_limit', 'this search has reached its follow-up limit');
    }
    this.turn += 1;
    if (input.image) {
      this.runtime.store.addAiImage(this.scope, this.sessionId, this.turn, input.image);
    }
    const images = this.currentImages();
    const payload: Record<string, unknown> = {
      ...(input.hintText.trim() ? { hintText: input.hintText.trim() } : {}),
      ...(images.length ? { images: images.map(image => image.dataUrl) } : {}),
      ...(input.fixtureCase ? { fixtureCase: input.fixtureCase } : {}),
    };
    validateExerciseSearchInput(payload);
    const requestId = createId('req', randomUUID);
    const sessionMode = this.runs === 0 ? 'new' : 'continue';
    let run: AgentRunRow;
    if (this.launch.location === 'server') {
      if (!this.server) throw new Error('the paired server is not available');
      run = await this.server.startRun({
        requestId,
        profileId: this.launch.profile.id,
        input: payload,
        sessionId: this.sessionId,
        sessionMode,
        taskId: EXERCISE_SEARCH_TASK_ID,
      });
    } else {
      run = await this.runtime.start({
        requestId,
        profileId: this.launch.profile.id,
        input: payload,
        sessionId: this.sessionId,
        sessionMode,
        taskId: EXERCISE_SEARCH_TASK_ID,
      });
    }
    this.runs += 1;
    this.activeRunId = run.runId;
    if (run.profile) {
      // The server's desensitised summary is authoritative for the card.
      this.launchValue = { ...this.launchValue, summary: run.profile };
    }
    // The local runtime records its own reference before returning; a server
    // run needs the client to write it because the server cannot touch this
    // device's SQLite.
    if (this.launch.location === 'server') {
      rememberAiRun(this.scope, {
        runId: run.runId,
        sessionId: this.sessionId,
        location: 'server',
        taskId: EXERCISE_SEARCH_TASK_ID,
        status: run.status,
        createdAt: run.createdAt,
      });
    }
    return { run, images };
  }

  async poll(
    runId: string,
    onRun?: (run: AgentRunRow) => void,
    signal?: AbortSignal,
  ): Promise<AgentRunRow> {
    let run: AgentRunRow;
    if (this.launch.location === 'server') {
      if (!this.server) throw new Error('the paired server is not available');
      run = await this.server.pollRun(runId, current => onRun?.(current), signal);
    } else {
      run = await this.runtime.waitForRun(runId, { signal, onRun });
    }
    if (!['accepted', 'running'].includes(run.status)) {
      this.activeRunId = this.activeRunId === runId ? null : this.activeRunId;
      settleAiRun(this.scope, run);
    }
    return run;
  }

  async cancel(runId: string): Promise<void> {
    if (this.activeRunId === runId) this.activeRunId = null;
    try {
      if (this.launch.location === 'server' && this.server) await this.server.cancelRun(runId);
      else this.runtime.cancel(runId);
    } catch {
      // The run may already have finished; leaving the terminal record intact
      // is the correct outcome for a cancel that lost the race.
    }
  }

  cancelQuietly(): void {
    const runId = this.activeRunId;
    this.activeRunId = null;
    if (!runId) return;
    if (this.launch.location === 'server' && this.server) {
      this.server.cancelRun(runId).catch(() => undefined);
    } else {
      try { this.runtime.cancel(runId); } catch { /* terminal already */ }
    }
  }

  /** Cancel, delete the session and its images, and clear the restart reference. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const runId = this.activeRunId;
    this.activeRunId = null;
    if (runId) {
      try {
        if (this.launch.location === 'server' && this.server) await this.server.cancelRun(runId);
        else this.runtime.cancel(runId);
      } catch { /* terminal already */ }
    }
    try { this.runtime.store.deleteAiImages(this.scope, this.sessionId); } catch { /* best effort */ }
    try {
      if (this.launch.location === 'server' && this.server) {
        await this.server.deleteSession(this.sessionId);
      } else {
        this.runtime.deleteSession(this.sessionId);
      }
    } catch { /* a server cleanup failure must not trap the user in AI mode */ }
    clearAiRunReference(this.connection, { sessionId: this.sessionId });
  }
}

/** A readable Chinese message for every stable code the feature exposes. */
export function aiErrorMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case 'agent_media_invalid':
      return '这张图片格式或尺寸不受支持，请换一张再试。';
    case 'agent_media_too_large':
      return '图片超出大小限制，请换一张再试。';
    case 'profile_capability_missing':
      return '当前模型不能读取图片，请换一个支持图片的配置，或在服务端重新发起。';
    case 'turn_limit':
      return '这次检索的追问次数已用完，请退出后重新发起。';
    case 'session_busy':
      return '上一轮还在检索，请稍候或取消后再试。';
    case 'session_conflict':
      return '这次检索会话已失效，请退出后重新发起。';
    case 'session_deleted':
      return '这次检索会话已结束，请重新发起。';
    case 'model_unavailable':
      return '模型暂时没有返回结果，请重试。';
    case 'model_timeout':
      return '模型响应超时，请重试。';
    case 'run_cancelled':
      return '这次检索已取消。';
    case 'run_not_found':
      return '找不到这次检索记录，请重新发起。';
    case undefined:
    default:
      return fallback?.trim() || '检索失败，请重试。';
  }
}
