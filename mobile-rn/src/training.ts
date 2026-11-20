import { randomUUID } from 'expo-crypto';
import {
  isWarmupRow,
  modeForSet,
  nextBurstReps,
  nextDropWeight,
} from '../../frontend/src/lib/workout-model';
import {
  applyIntensifierPlan,
  barFloor,
  cleanupSg,
  effortOf as preferenceOf,
  insertWarmupRow,
  MAX_PLANNED_WARMUPS,
  workoutVolume,
} from '../../frontend/src/lib/history';
import { weightIncrement } from '../../frontend/src/lib/progression';
import { ownedWeightsFor } from '../../frontend/src/lib/dumbbells';
import { dropGrid } from '../../frontend/src/lib/plates';
import { cleanBackups } from '../../frontend/src/lib/routine-backups';
import { warmupBlock, warmupSource } from '../../frontend/src/lib/warmup-ramp';
import { catalogueCardio, catalogueHas, catalogueName } from './catalogue';

export type Unit = 'kg' | 'lb';
/** Which effort scale a profile logs sets in. `none` hides the rating entry points. */
export type EffortScale = 'none' | 'rpe' | 'rir';
/** The two saved scales. A set carries one of them, never both. */
export type RatingScale = 'rpe' | 'rir';

/** A planned advanced set shape; mirrors the upstream routine config (`cfg.intensifier`). */
export type RoutineIntensifier =
  | { type: 'dropset'; count: number; pct: number }
  | { type: 'restpause'; totalReps: number; restSec: number };

export type RoutineExercise = {
  id: string;
  sets?: number;
  reps?: number | string;
  weight?: number;
  mode?: string;
  min?: number;
  sec?: number;
  speed?: number;
  side?: boolean;
  dbLoad?: 'each' | 'total';
  noProg?: boolean;
  restSec?: number;
  restOff?: boolean;
  sg?: string;
  sgName?: string;
  sgRest?: number;
  subs?: string[];
  warmup?: 'auto' | 'own' | 'none';
  warmupSets?: number;
  warmupRows?: { wb?: boolean; wp?: number; r: number }[];
  intensifier?: RoutineIntensifier;
};

export type Routine = { id: string; name: string; ex?: RoutineExercise[]; excludeFromProgression?: boolean };
export type CustomExercise = {
  id: string;
  n?: string;
  name?: string;
  bp?: string;
  eq?: string;
  /** Target muscle slug; old records may not have one. */
  tg?: string;
  /** Exercise category, when the record carries one. */
  cat?: string;
  /** Extra searchable names, synchronized with Web. */
  aliases?: string[];
  note?: string;
  desc?: string;
  /** A MediaRef synced from Web/capacitor (lib/media-refs.js): never the bytes themselves. */
  media?: unknown;
  /** One external link, opened only on a tap. */
  url?: string;
};

export type SetDrop = { w?: number; r?: number };
export type SetCluster = { r?: number; restSec?: number };

/** A private media reference shared with Web; the bytes are never in synced state. */
export type MediaRefLike = {
  hash: string;
  kind?: string;
  mime?: string;
  size?: number;
  w?: number;
  h?: number;
  dur?: number;
  [key: string]: unknown;
};

/** One weigh-in inside a day. Older profiles only carry the day-level `w`. */
export type WeighInReading = {
  id: string;
  /** Local time of day, `HH:MM`. */
  at?: string | null;
  /** The weight in the profile's unit. */
  w: number;
  t?: number;
  src?: string;
  sid?: string;
};

/** `Profile.bodyweight[]`; `ins`/`gone` are the multi-reading extension from Web. */
export type WeighInDay = {
  d: string;
  w?: number;
  t?: number;
  src?: string;
  ins?: WeighInReading[];
  gone?: Record<string, number>;
};

export type MeasurementOther = { id: string; name?: string; value?: number | null; unit?: string };

/** Canonical lengths are cm; display conversion belongs to the screen. */
export type MeasurementEntry = {
  d: string;
  t?: number;
  other?: MeasurementOther[];
  [key: string]: unknown;
};

export type DayPhotoEntry = {
  d?: string;
  m?: MediaRefLike;
  /** Later versions win; a tombstone only carries the stamp. */
  _ts?: number;
};

export type ReminderPreference = { on?: boolean; time?: string; nudge?: boolean };

export type LoggedSet = {
  w?: number;
  r?: number;
  sec?: number;
  min?: number;
  speed?: number;
  /** Subjective effort, one scale per row. rir wins when an old row carries both. */
  rpe?: number;
  rir?: number;
  /** Taken to failure. Reads as RIR 0 when nothing was rated by hand. */
  failure?: boolean;
  done?: boolean;
  at?: number;
  phase?: 'warmup' | 'work';
  warmup?: boolean;
  type?: 'straight' | 'dropset' | 'restpause';
  drops?: SetDrop[];
  clusters?: SetCluster[];
  sides?: { L?: LoggedSet; R?: LoggedSet };
};
export type WorkoutEntry = {
  id: string;
  sg?: string;
  /** The routine slot this entry was planned by in a combined session. */
  rid?: string;
  sets: LoggedSet[];
  topW?: number | null;
  target?: RoutineExercise;
  noProg?: boolean;
};

export type Workout = {
  id?: string;
  d: string;
  start: number;
  end: number;
  name: string;
  routineId?: string;
  routineIds?: string[];
  entries: WorkoutEntry[];
  bw?: number | null;
  prs?: string[];
  vol?: number;
  media?: MediaRefLike[];
  _ts?: number;
  excludeFromProgression?: boolean;
};

export type Profile = {
  unit?: Unit;
  restSec?: number;
  restPauseSec?: number;
  volumeWarmups?: boolean;
  /** Saved default for the active workout's layout; unknown values read as cards. */
  workoutView?: WorkoutView;
  /** Settings → "Last time means": the routine's own sessions, or any workout. */
  lastFrom?: 'routine' | 'any';
  /** List and compact layouts fold finished exercises. */
  foldDone?: boolean;
  /** Cards and focus step over units whose every set is finished. */
  skipDone?: boolean;
  /** Explicit choice; wins over the legacy `showRir` boolean, including `none`. */
  effort?: EffortScale;
  /** Pre-`effort` preference. Only read when `effort` says nothing. */
  showRir?: boolean;
  /** Feature switches from the web profile; `effort` must be on for ratings to show. */
  modules?: Record<string, unknown>;
  routines?: Routine[];
  workouts?: Workout[];
  customEx?: CustomExercise[];
  /** Per-exercise text aliases edited in Web, keyed by exercise id. */
  exAliases?: Record<string, unknown>;
  /** Favourite exercise ids (built-in or custom), shared with the Web client. */
  favEx?: string[];
  /** Estimate used by the 1RM card; unknown values fall back to Epley in Web and RN. */
  oneRmFormula?: string;
  /** Which reading of a day becomes its daily value. */
  bwDaily?: 'first' | 'avg' | 'last';
  bodyweight?: WeighInDay[];
  measurements?: MeasurementEntry[];
  customMeasurements?: { id: string; name: string; enabled?: boolean; unit?: string }[];
  measurementEnabled?: string[];
  dayPhotos?: Record<string, DayPhotoEntry>;
  reminder?: ReminderPreference;
  week?: Record<string, string | string[]>;
  dayPlan?: Record<string, string>;
  scheduleMode?: 'week' | 'rotation';
  rotation?: { id: string; sequence: string[]; label: string; at?: number } | null;
  queue?: { ids: string[]; since: number; startsOn: string; label?: string; rotationId?: string } | null;
  deleted?: {
    workouts?: Record<string, number>;
    routines?: Record<string, number>;
    customEx?: Record<string, number>;
    measurements?: Record<string, number>;
    bodyweight?: Record<string, number>;
    dayPhotos?: Record<string, number>;
  };
  resetAt?: number;
  _wid?: string;
  [key: string]: unknown;
};

export type DraftDrop = { key?: string; w: string; r: string };
export type DraftCluster = { key?: string; r: string; restSec: string };
export type DraftSet = {
  key?: string;
  weight: string;
  reps: string;
  at: number | null;
  warmup?: boolean;
  /**
   * This load was typed by hand, so an earlier set's cascade leaves it alone. Old
   * rows without the mark are read as inherited, the Web-compatible default.
   */
  manual?: boolean;
  /** Scale and value of the saved effort. Both absent means unrated. */
  effortScale?: RatingScale;
  effort?: number;
  type?: 'dropset' | 'restpause';
  drops?: DraftDrop[];
  clusters?: DraftCluster[];
};
export type DraftExercise = {
  target: RoutineExercise;
  sets: DraftSet[];
  /** The routine this exercise's slot came from; absent on old and freestyle drafts. */
  rid?: string;
  /** This exercise does not count toward progression for this session only. */
  noProg?: boolean;
};

/**
 * The running workout's rest. A running rest stores the absolute `endsAt` so a
 * backgrounded app or a restart cannot drift it; a paused one stores the frozen
 * `remainingSec` and nothing else. Reaching `endsAt` reads as ready without
 * rewriting the draft; closing a ready rest clears it.
 */
export type DraftRest = {
  endsAt?: number;
  remainingSec?: number;
  exerciseIndex: number;
  setIndex: number;
};

export type Draft = {
  id: string;
  /** First routine, kept for older readers; `routineIds` is the ordered source. */
  routineId: string;
  routineIds?: string[];
  name: string;
  unit: Unit;
  start: number;
  volumeWarmups?: boolean;
  exercises: DraftExercise[];
  rest?: DraftRest | null;
  backfillDay?: string;
  /** This session's layout, snapshotted from the profile when it started. */
  view?: WorkoutView;
  /** Exercise index the workout screen is parked on, so a restart resumes there. */
  position?: number;
  /** This session's override of the list layouts' fold-finished setting. */
  foldDone?: boolean;
};

export type WorkoutView = 'cards' | 'list' | 'compact' | 'focus';
export const WORKOUT_VIEWS: WorkoutView[] = ['cards', 'list', 'compact', 'focus'];
export const WORKOUT_VIEW_LABELS: Record<WorkoutView, string> = {
  cards: '卡片', list: '列表', compact: '紧凑', focus: '专注',
};

/** Unknown and pre-setting values read as cards, exactly like the Web client. */
export function workoutViewOf(value: unknown): WorkoutView {
  return value === 'list' || value === 'compact' || value === 'focus' ? value : 'cards';
}

/** A draft's source routines in merge order, with the legacy single id as the fallback. */
export function draftRoutineIds(draft: Pick<Draft, 'routineId' | 'routineIds'>) {
  const ids = Array.isArray(draft.routineIds) ? draft.routineIds.filter(id => typeof id === 'string' && id) : [];
  if (ids.length) return ids;
  return draft.routineId ? [draft.routineId] : [];
}

/**
 * The saved exercise position, clamped to the current exercise list. Old drafts
 * without one resume at the first exercise; removing exercises never leaves the
 * pointer past the end.
 */
export function draftPosition(draft: Pick<Draft, 'position' | 'exercises'>) {
  const count = draft.exercises.length;
  if (!count) return 0;
  const index = Math.trunc(Number(draft.position));
  return Number.isFinite(index) ? Math.min(count - 1, Math.max(0, index)) : 0;
}

/** The merged-session name rule: 1–3 names joined, 4+ as "first + second + N more". */
export function deriveSessionName(names: string[]) {
  const clean = names.filter(name => typeof name === 'string' && name.trim() !== '');
  if (!clean.length) return '';
  if (clean.length <= 3) return clean.join(' + ');
  return `${clean[0]} + ${clean[1]} + ${clean.length - 2} more`;
}

export type QueuedWorkout = { workout: Workout & { id: string }; unit: Unit };

/** What the history editor hands back: full entries plus the snapshot they started from. */
export type HistorySave = {
  patch: Partial<Workout>;
  base: WorkoutEntry[];
  entries: WorkoutEntry[];
};

export const REST_PAUSE_MIN = 5;
export const REST_PAUSE_MAX = 300;
export const DEFAULT_REST_PAUSE_SEC = 15;

/** Whole seconds in the upstream 5–300 range; anything unreadable falls back to the default. */
export function clampRestPauseSec(value: unknown) {
  const sec = Math.round(Number(value));
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_REST_PAUSE_SEC;
  return Math.min(REST_PAUSE_MAX, Math.max(REST_PAUSE_MIN, sec));
}

/** The short rest a manually added segment inherits: the plan's own, else the account default. */
export function exerciseRestPauseSec(target: RoutineExercise | undefined, profile: Profile) {
  if (target?.intensifier?.type === 'restpause') return clampRestPauseSec(target.intensifier.restSec);
  return clampRestPauseSec(profile.restPauseSec);
}

/** Sanitise a plan intensifier the way upstream plan-share/history.js do, with RN's 2-drop default. */
export function sanitizeIntensifier(value: RoutineIntensifier | undefined): RoutineIntensifier | undefined {
  if (value?.type === 'dropset') return {
    type: 'dropset',
    count: Math.max(1, Math.round(Number(value.count)) || 2),
    pct: Math.min(90, Math.max(5, Math.round(Number(value.pct)) || 20)),
  };
  if (value?.type === 'restpause') return {
    type: 'restpause',
    totalReps: Math.max(1, Math.round(Number(value.totalReps)) || 12),
    restSec: clampRestPauseSec(value.restSec),
  };
  return undefined;
}

function plannedIntensifier(target: RoutineExercise): RoutineIntensifier | undefined {
  return sanitizeIntensifier(target.intensifier);
}

export function workoutKey(workout: Workout) {
  return workout.id ?? `${workout.d}|${workout.start}`;
}

const MAX_WEIGHT = 5000;
export const MAX_WORK_SETS = 50;
const sample = (id: string, sets: number, reps: number) => ({ id, sets, reps });
export const practiceProfile: Profile = {
  unit: 'kg',
  routines: [
    { id: 'practice-a', name: '全身力量 A', ex: [sample('0043', 3, 8), sample('0025', 3, 8), sample('2330', 3, 10)] },
    { id: 'practice-b', name: '全身力量 B', ex: [sample('0085', 3, 8), sample('0047', 3, 10), sample('1323', 3, 10)] },
  ],
  workouts: [],
};

export function exerciseName(profile: Profile, id: string) {
  const custom = profile.customEx?.find(exercise => exercise.id === id);
  return custom?.n ?? custom?.name ?? catalogueName(id);
}

export function unitOf(profile: Profile): Unit {
  return profile.unit === 'lb' ? 'lb' : 'kg';
}

/**
 * Which effort scale new sets ask for. This is the upstream rule: the Effort module
 * must be on, an explicit `effort` wins (including `none`, which has to beat the
 * legacy `showRir` boolean), and `showRir` is only read when the profile has no
 * explicit answer.
 */
export function effortOf(profile: Profile): EffortScale {
  const scale = preferenceOf(profile);
  return scale === 'rpe' || scale === 'rir' ? scale : 'none';
}

export function isRepExercise(item: RoutineExercise, profile: Profile) {
  if (!item?.id) return false;
  if (item.mode) return item.mode === 'reps';
  const custom = profile.customEx?.find(exercise => exercise.id === item.id);
  return item.min == null && item.speed == null &&
    (custom ? custom.bp !== 'cardio' : !catalogueCardio(item.id));
}

export function exerciseMode(item: RoutineExercise, profile: Profile) {
  if (item.mode === 'time' || item.sec != null) return 'time';
  return isRepExercise(item, profile) ? 'reps' : 'cardio';
}

export function addExercise(draft: Draft, target: RoutineExercise, profile: Profile, pending: readonly QueuedWorkout[], replaceIndex?: number) {
  const previous = replaceIndex == null ? undefined : draft.exercises[replaceIndex];
  if (replaceIndex != null && (!previous || previous.sets.some(set => set.at !== null))) return draft;
  const sourceRid = previous?.rid ?? draft.exercises[draft.position ?? 0]?.rid;
  const exercise = startWorkout(
    { id: draft.routineId, name: draft.name, ex: [{ ...target, ...supersetFields(previous?.target) }] },
    inDraftUnit(profile, draft.unit), pending,
  ).exercises[0];
  if (!exercise) return draft;
  return {
    ...draft,
    exercises: replaceIndex == null
      ? [...draft.exercises, ...(sourceRid ? [{ ...exercise, rid: sourceRid }] : [exercise])]
      : draft.exercises.map((entry, index) => index === replaceIndex
        ? { ...exercise, ...(entry.rid ? { rid: entry.rid } : {}) } : entry),
    rest: replaceIndex != null && draft.rest?.exerciseIndex === replaceIndex ? null : draft.rest,
  };
}

function supersetFields(target?: RoutineExercise) {
  return target?.sg ? { sg: target.sg, sgName: target.sgName, sgRest: target.sgRest } : {};
}

function workoutTime(workout: Workout) {
  if (Number.isFinite(workout.start)) return workout.start;
  if (Number.isFinite(workout.end)) return workout.end;
  return Date.parse(workout.d) || 0;
}

function entryRoutineId(workout: Workout, entry: WorkoutEntry) {
  if (entry?.rid) return entry.rid;
  if ((workout.entries ?? []).some(row => row?.rid)) return null;
  return workout.routineIds?.[0] ?? workout.routineId ?? null;
}

/**
 * The last load this exercise was trained at. With a routine id the routine's own
 * sessions win; a routine that never trained it falls back to any workout, and
 * `lastFrom: 'any'` (Settings → "Last time means") skips the routine filter.
 */
function lastWorkingWeight(history: Workout[], target: RoutineExercise, rid?: string, lastFromAny = false) {
  const find = (routineOnly: boolean) => {
    for (const workout of history) {
      for (const entry of workout.entries ?? []) {
        if (entry?.id !== target.id || entry.noProg) continue;
        if (routineOnly && entryRoutineId(workout, entry) !== rid) continue;
        if ((entry.target?.dbLoad ?? 'as') !== (target.dbLoad ?? 'as')) continue;
        const row = (entry.sets ?? []).findLast(set =>
          set?.done === true && !isWarmupRow(set) && modeForSet(set, entry.target) === 'reps' &&
          typeof set.r === 'number' && set.r > 0 && typeof set.w === 'number' && set.w >= 0 && set.w <= MAX_WEIGHT
        );
        if (row) return row.w;
      }
    }
    return undefined;
  };
  if (rid && !lastFromAny) {
    const own = find(true);
    if (own !== undefined) return own;
  }
  return find(false);
}

function draftSetFromRow(row: {
  w?: number; r?: number; type?: string; drops?: SetDrop[]; clusters?: SetCluster[]; phase?: string; warmup?: boolean;
}, index: number): DraftSet {
  const set: DraftSet = {
    key: String(index), weight: String(row.w ?? 0), reps: String(row.r ?? 0), at: null,
    ...(isWarmupRow(row) ? { warmup: true } : {}),
  };
  if (row.type === 'dropset' && Array.isArray(row.drops) && row.drops.length) {
    set.type = 'dropset';
    set.drops = row.drops.map(drop => ({ key: randomUUID(), w: String(drop.w ?? 0), r: String(drop.r ?? 0) }));
  } else if (row.type === 'restpause' && Array.isArray(row.clusters) && row.clusters.length) {
    set.type = 'restpause';
    set.clusters = row.clusters.map(cluster => ({
      key: randomUUID(), r: String(cluster.r ?? 0), restSec: String(cluster.restSec ?? DEFAULT_REST_PAUSE_SEC),
    }));
  }
  return set;
}

function buildDraftExercise(
  target: RoutineExercise,
  routine: Routine,
  profile: Profile,
  history: Workout[],
  unit: Unit,
): DraftExercise {
  const rid = routine.id || undefined;
  const noProg = routine.excludeFromProgression === true || target.noProg === true;
  const count = Math.max(1, Math.min(MAX_WORK_SETS, Math.trunc(Number(target.sets) || 3)));
  const mode = exerciseMode(target, profile);
  const source = { ...(rid ? { rid } : {}), ...(noProg ? { noProg: true } : {}) };
  if (mode !== 'reps') {
    const { intensifier: _intensifier, ...plain } = target;
    return {
      target: { ...plain, mode },
      sets: Array.from({ length: count }, (_, index) => ({
        key: String(index),
        weight: String(mode === 'time' ? target.weight ?? 0 : target.speed ?? 0),
        reps: String(mode === 'time' ? target.sec ?? 45 : target.min ?? 20),
        at: null,
      })),
      ...source,
    };
  }
  const reps = String(target.reps ?? '').match(/^\d+/)?.[0] ?? '8';
  const previous = noProg ? undefined : lastWorkingWeight(history, target, rid, profile.lastFrom === 'any');
  const cfg = { ...target, mode: 'reps' as const };
  const floor = barFloor(profile, target.id);
  const work = Array.from({ length: count }, () => ({ w: previous ?? target.weight ?? 0, r: Number(reps), done: false }));
  const options = { grid: dropGrid(profile, cfg), floor, unit };
  const block = warmupBlock(profile, cfg, work, options);
  let rows = block ? [...block, ...work] : work;
  if (block === null && warmupSource(profile, cfg).kind === 'count') {
    const warmups = Math.min(MAX_PLANNED_WARMUPS, Math.round(target.warmupSets ?? 0));
    const step = ownedWeightsFor(profile, cfg) || weightIncrement(cfg, unit);
    for (let i = 0; i < warmups; i++) rows = insertWarmupRow(rows, 'reps', cfg, step, floor) ?? rows;
  }
  // The routine's intensifier shapes the final prescribed rows, warm-ups included for
  // rest-pause (upstream builds exactly one warm-up and one work row there). RN logs a
  // unilateral weight as one both-sides total, so the plan is applied without `side`:
  // new records stay bilateral even when the exercise is per side.
  const intensifier = plannedIntensifier(target);
  if (intensifier) {
    rows = applyIntensifierPlan(rows, { ...cfg, reps: Number(reps), side: false, intensifier }, dropGrid(profile, cfg));
  }
  const sets = rows.map((row, index) => draftSetFromRow(row, index));
  return { target: intensifier ? { ...target, intensifier } : target, sets, ...source };
}

/**
 * Build one session from an ordered list of routines. Dead ids and duplicates are
 * dropped (first occurrence wins); each routine contributes its exercises in order
 * with its own `rid`, and an empty routine still contributes its name and id.
 */
export function startSession(
  routines: Routine[],
  profile: Profile,
  pending: readonly QueuedWorkout[] = [],
  name?: string,
): Draft {
  const seen = new Set<string>();
  const resolved = (Array.isArray(routines) ? routines : []).filter(routine => {
    if (!routine) return false;
    const id = typeof routine.id === 'string' ? routine.id : '';
    if (id !== '') {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }
    // An unnamed routine is the freestyle slot: kept only when it carries exercises.
    return (routine.ex ?? []).some(item => item?.id);
  });
  const unit = unitOf(profile);
  const saved = (profile.workouts ?? []).filter(Boolean);
  const savedIds = new Set(saved.map(workout => workout.id));
  const history = [
    ...saved,
    ...pending.filter(item => !savedIds.has(item.workout.id)).map(item => inProfileUnit(item, unit)),
  ].filter(workout => !workout.excludeFromProgression).sort((a, b) => workoutTime(b) - workoutTime(a));
  const exercises = resolved.flatMap(routine => (routine.ex ?? [])
    .filter(item => item?.id)
    .map(target => buildDraftExercise(target, routine, profile, history, unit)));
  const routineIds = resolved.map(routine => routine.id).filter(id => typeof id === 'string' && id);
  return {
    id: randomUUID(),
    routineId: routineIds[0] ?? '',
    routineIds,
    name: name ?? (resolved.length ? deriveSessionName(resolved.map(routine => routine.name)) : '自由训练'),
    unit,
    start: Date.now(),
    exercises,
    volumeWarmups: profile.volumeWarmups === true,
    view: workoutViewOf(profile.workoutView),
  };
}

/** The single-routine form every old start path uses; freestyle keeps its own name. */
export function startWorkout(routine: Routine, profile: Profile, pending: readonly QueuedWorkout[] = []): Draft {
  return startSession([routine], profile, pending, routine?.id ? undefined : routine?.name || '自由训练');
}

export function addWorkSet(draft: Draft, exerciseIndex: number): Draft {
  const exercise = draft.exercises[exerciseIndex];
  const work = exercise.sets.filter(set => !set.warmup);
  if (work.length >= MAX_WORK_SETS) return draft;
  const previous = work.at(-1);
  const set = {
    key: randomUUID(),
    weight: previous?.weight ?? String(exercise.target.mode === 'cardio' ? exercise.target.speed ?? 0 : exercise.target.weight ?? 0),
    reps: previous?.reps ?? String(exercise.target.mode === 'time' ? exercise.target.sec ?? 45
      : exercise.target.mode === 'cardio' ? exercise.target.min ?? 20 : String(exercise.target.reps ?? '').match(/^\d+/)?.[0] ?? '8'),
    at: null,
  };
  return {
    ...draft,
    exercises: draft.exercises.map((entry, index) => index === exerciseIndex
      ? { ...entry, sets: [...entry.sets, set] } : entry),
  };
}

export function backupExerciseIds(target: RoutineExercise, profile: Profile): string[] {
  if (!Array.isArray(target.subs) || exerciseMode(target, profile) !== 'reps') return [];
  return cleanBackups(target.subs.filter(id => typeof id === 'string' &&
    (catalogueHas(id) || !!profile.customEx?.some(exercise => exercise.id === id)) &&
    isRepExercise({ id }, profile)), target.id);
}

export function swapExercise(draft: Draft, exerciseIndex: number, id: string, profile: Profile, pending: readonly QueuedWorkout[]): Draft {
  const entry = draft.exercises[exerciseIndex];
  if (!entry || entry.sets.some(set => set.at !== null)) return draft;
  const backups = backupExerciseIds(entry.target, profile);
  if (!backups.includes(id)) return draft;

  const { id: previousId, sets, reps, restSec, restOff, noProg, warmup, warmupRows, warmupSets, intensifier } = entry.target;
  const target = {
    id, sets, reps, restSec, restOff, noProg, warmup, warmupRows, warmupSets, intensifier,
    ...supersetFields(entry.target),
    subs: [previousId, ...backups.filter(backup => backup !== id)],
  };
  const routine = profile.routines?.find(item => item.id === draft.routineId);
  const replacement = startWorkout(
    { id: entry.rid ?? draft.routineId, name: draft.name, ex: [target], excludeFromProgression: routine?.excludeFromProgression },
    inDraftUnit(profile, draft.unit), pending,
  ).exercises[0];
  if (!replacement) return draft;
  return {
    ...draft,
    rest: draft.rest?.exerciseIndex === exerciseIndex ? null : draft.rest,
    exercises: draft.exercises.map((exercise, index) => index === exerciseIndex ? {
      ...replacement,
      ...(entry.rid ? { rid: entry.rid } : {}),
      ...(entry.noProg ? { noProg: true } : {}),
    } : exercise),
  };
}

function inDraftUnit(profile: Profile, unit: Unit): Profile {
  const originalUnit = unitOf(profile);
  if (originalUnit === unit) return profile;
  return {
    ...profile, unit,
    workouts: profile.workouts?.filter(Boolean).map(workout =>
      inProfileUnit({ workout: { ...workout, id: workout.id ?? '' }, unit: originalUnit }, unit)),
  };
}

export function removeSet(draft: Draft, exerciseIndex: number, setIndex: number): Draft {
  const exercise = draft.exercises[exerciseIndex];
  const set = exercise.sets[setIndex];
  if (!set || set.at !== null) return draft;
  let rest = draft.rest;
  if (rest?.exerciseIndex === exerciseIndex && rest.setIndex >= setIndex) {
    rest = rest.setIndex === setIndex ? null : { ...rest, setIndex: rest.setIndex - 1 };
  }
  const sets = exercise.sets.map((row, index) => row.key == null ? { ...row, key: String(index) } : row);
  sets.splice(setIndex, 1);
  return {
    ...draft, rest,
    exercises: draft.exercises.map((entry, index) => index === exerciseIndex ? { ...entry, sets } : entry),
  };
}

export function validSet(set: DraftSet, mode?: string) {
  const weight = Number(set.weight.replace(',', '.'));
  const reps = Number(set.reps);
  return set.weight.trim() !== '' && Number.isFinite(weight) && weight >= 0 && weight <= MAX_WEIGHT &&
    Number.isFinite(reps) && reps > 0 &&
    (mode === 'cardio' ? reps <= 1440 : Number.isInteger(reps) && reps <= (mode === 'time' ? 86400 : 500));
}

export function updateSet(draft: Draft, exerciseIndex: number, setIndex: number, changes: Partial<DraftSet>): Draft {
  return {
    ...draft,
    exercises: draft.exercises.map((exercise, index) => index === exerciseIndex ? {
      ...exercise,
      sets: exercise.sets.map((set, row) => row === setIndex ? { ...set, ...changes } : set),
    } : exercise),
  };
}

export const REST_MAX_SEC = 15 * 60;

/** Seconds left in a rest, paused or running; 0 for none or an elapsed one. */
export function restRemaining(rest: DraftRest | null | undefined, now = Date.now()) {
  if (!rest) return 0;
  if (typeof rest.remainingSec === 'number' && Number.isFinite(rest.remainingSec)) {
    return Math.max(0, Math.round(rest.remainingSec));
  }
  if (typeof rest.endsAt === 'number' && Number.isFinite(rest.endsAt)) {
    return Math.max(0, Math.ceil((rest.endsAt - now) / 1000));
  }
  return 0;
}

export function restRunning(rest: DraftRest | null | undefined) {
  return typeof rest?.endsAt === 'number' && Number.isFinite(rest.endsAt);
}

/** A running rest whose deadline has passed: the dock says ready until it is closed. */
export function restReady(rest: DraftRest | null | undefined, now = Date.now()) {
  return restRunning(rest) && restRemaining(rest, now) === 0;
}

/** A newly earned rest, always running against an absolute deadline. */
export function startDraftRest(
  exerciseIndex: number,
  setIndex: number,
  seconds: number,
  now = Date.now(),
): DraftRest | null {
  const sec = Math.min(REST_MAX_SEC, Math.max(0, Math.round(seconds)));
  return sec > 0 ? { endsAt: now + sec * 1000, exerciseIndex, setIndex } : null;
}

/** Freeze the seconds left; the deadline keys are dropped so no notification is scheduled. */
export function pauseDraftRest(rest: DraftRest, now = Date.now()): DraftRest {
  return {
    exerciseIndex: rest.exerciseIndex,
    setIndex: rest.setIndex,
    remainingSec: restRemaining(rest, now),
  };
}

/** Continue a paused rest from its frozen seconds, against a fresh deadline. */
export function resumeDraftRest(rest: DraftRest, now = Date.now()): DraftRest {
  const seconds = restRemaining(rest, now);
  if (seconds <= 0) return rest;
  return { exerciseIndex: rest.exerciseIndex, setIndex: rest.setIndex, endsAt: now + seconds * 1000 };
}

/**
 * Commit an absolute remaining duration. 0 closes the rest, exactly like skipping;
 * a paused rest keeps its paused state, a running (or ready) one re-aims its deadline.
 */
export function setDraftRestSeconds(rest: DraftRest, seconds: number, now = Date.now()): DraftRest | null {
  const sec = Math.min(REST_MAX_SEC, Math.max(0, Math.round(seconds)));
  if (sec === 0) return null;
  if (typeof rest.remainingSec === 'number') {
    return { exerciseIndex: rest.exerciseIndex, setIndex: rest.setIndex, remainingSec: sec };
  }
  return { exerciseIndex: rest.exerciseIndex, setIndex: rest.setIndex, endsAt: now + sec * 1000 };
}

/** ±15 s from the current state; a ready rest restarts from 0 before the delta. */
export function nudgeDraftRest(rest: DraftRest, delta: number, now = Date.now()): DraftRest | null {
  return setDraftRestSeconds(rest, restRemaining(rest, now) + delta, now);
}

function rerampDraftWarmups(sets: DraftSet[], cfg: RoutineExercise, profile: Profile, value: number) {
  const firstWork = sets.findIndex(row => !row.warmup);
  if (firstWork <= 0) return sets;
  const grid = dropGrid(profile, cfg) as number | ((weight: number) => number);
  const floor = barFloor(profile, cfg.id);
  const snap = (weight: number) => typeof grid === 'function' ? grid(weight) : Math.floor(weight / grid) * grid;
  const out = sets.slice();
  let from = 0;
  for (let index = 0; index < firstWork; index++) {
    const row = out[index];
    const read = Number(String(row.weight).replace(',', '.'));
    if (row.at !== null || row.manual) {
      from = Number.isFinite(read) ? read : 0;
      continue;
    }
    const next = value > from ? Math.min(value, Math.max(0, floor, snap(from + (value - from) / 2))) : value;
    out[index] = { ...row, weight: String(next) };
    from = next;
  }
  return out;
}

/**
 * Correct one set's load or reps in the running workout. Unlike the old edit paths
 * this never clears `at` and never touches the rest: correcting a finished set
 * leaves it ticked and the countdown on its original deadline.
 *
 * A load typed on a work set is marked manual and cascades to the later work sets
 * that are still open and still inherited. Editing the first work set also re-aims
 * the open, not-hand-edited warm-up rungs at the new load; a warm-up edit, or one
 * of the warm-ups themselves, only changes that row.
 */
export function editDraftSet(
  draft: Draft,
  exerciseIndex: number,
  setIndex: number,
  field: 'weight' | 'reps',
  value: string,
  profile: Profile,
): Draft {
  const exercise = draft.exercises[exerciseIndex];
  const set = exercise?.sets[setIndex];
  if (!exercise || !set) return draft;
  if (field === 'reps') {
    return {
      ...draft,
      exercises: draft.exercises.map((entry, index) => index === exerciseIndex ? {
        ...entry,
        sets: entry.sets.map((row, rowIndex) => rowIndex === setIndex ? { ...row, reps: value } : row),
      } : entry),
    };
  }
  const weight = Number(value.replace(',', '.'));
  if (value.trim() === '' || !Number.isFinite(weight) || weight < 0 || weight > MAX_WEIGHT) return draft;
  const sourceIsWarmup = set.warmup === true;
  let sets = exercise.sets.map((row, rowIndex) => {
    if (rowIndex === setIndex) return { ...row, weight: value, manual: true };
    if (sourceIsWarmup || rowIndex < setIndex || row.warmup || row.at !== null || row.manual) return row;
    return { ...row, weight: value };
  });
  const firstWork = sets.findIndex(row => !row.warmup);
  if (!sourceIsWarmup && firstWork === setIndex) {
    sets = rerampDraftWarmups(sets, { ...exercise.target, mode: 'reps' }, inDraftUnit(profile, draft.unit), weight);
  }
  return {
    ...draft,
    exercises: draft.exercises.map((entry, index) => index === exerciseIndex ? { ...entry, sets } : entry),
  };
}


/**
 * Save or clear one set's effort on the draft. Clearing deletes both keys instead of
 * writing null (an unrated set has no key at all), and the value never touches `at`
 * or the rest timer: rating a set is independent of ticking it.
 */
export function setDraftEffort(
  draft: Draft,
  exerciseIndex: number,
  setIndex: number,
  scale: RatingScale | null,
  value: number | null,
): Draft {
  return {
    ...draft,
    exercises: draft.exercises.map((exercise, index) => index === exerciseIndex ? {
      ...exercise,
      sets: exercise.sets.map((set, row) => {
        if (row !== setIndex) return set;
        if (scale == null || value == null) {
          const next = { ...set };
          delete next.effortScale;
          delete next.effort;
          return next;
        }
        return { ...set, effortScale: scale, effort: Math.round(value * 10) / 10 };
      }),
    } : exercise),
  };
}

function draftSetAt(draft: Draft, exerciseIndex: number, setIndex: number): DraftSet | undefined {
  return draft.exercises[exerciseIndex]?.sets[setIndex];
}

function replaceDraftSet(draft: Draft, exerciseIndex: number, setIndex: number, replace: (set: DraftSet) => DraftSet): Draft {
  const current = draftSetAt(draft, exerciseIndex, setIndex);
  if (!current) return draft;
  return updateSet(draft, exerciseIndex, setIndex, replace(current));
}

function numberIn(value: string) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function validDropSegment(drop: { w: string; r: string }) {
  const weight = Number(drop.w.replace(',', '.'));
  const reps = Number(drop.r);
  return drop.w.trim() !== '' && Number.isFinite(weight) && weight >= 0 && weight <= MAX_WEIGHT &&
    Number.isInteger(reps) && reps > 0 && reps <= 500;
}

export function validClusterSegment(cluster: { r: string; restSec: string }) {
  const reps = Number(cluster.r);
  const restSec = Number(cluster.restSec);
  return Number.isInteger(reps) && reps > 0 && reps <= 500 &&
    Number.isInteger(restSec) && restSec >= REST_PAUSE_MIN && restSec <= REST_PAUSE_MAX;
}

/** Segments a draft row could be saved with, before the main weight/reps are considered. */
export function validSetSegments(set: DraftSet) {
  if (set.warmup) return true;
  if (set.type === 'dropset') return !!set.drops?.length && set.drops.every(validDropSegment);
  if (set.type === 'restpause') {
    return !!set.clusters?.length && set.clusters.every(validClusterSegment) &&
      Number(set.reps) === draftClusterTotal(set);
  }
  return true;
}

export function draftClusterTotal(set: DraftSet) {
  return (set.clusters ?? []).reduce((total, cluster) => total + Math.max(0, Math.trunc(numberIn(cluster.r))), 0);
}

/**
 * Keep a rest-pause row's own `r` equal to the sum of its clusters. A typed total is absorbed by
 * the last segment first, then earlier ones, never letting a segment drop below one rep.
 */
function retotalClusters(clusters: DraftCluster[], total: number): DraftCluster[] | null {
  if (!Number.isInteger(total) || total < clusters.length) return null;
  const next = clusters.map(cluster => ({
    ...cluster, r: String(Math.max(1, Math.trunc(numberIn(cluster.r)))),
  }));
  let delta = total - next.reduce((sum, cluster) => sum + numberIn(cluster.r), 0);
  for (let index = next.length - 1; index >= 0 && delta !== 0; index--) {
    const current = numberIn(next[index].r);
    const room = delta < 0 ? current - 1 : Number.POSITIVE_INFINITY;
    const change = delta > 0 ? delta : Math.max(delta, -room);
    if (!change) continue;
    next[index] = { ...next[index], r: String(current + change) };
    delta -= change;
  }
  return delta === 0 ? next : null;
}

/** Change a work row's own reps; for a rest-pause set the total is spread over its segments. */
export function updateSetReps(draft: Draft, exerciseIndex: number, setIndex: number, reps: string): Draft {
  const set = draftSetAt(draft, exerciseIndex, setIndex);
  if (!set) return draft;
  if (set.type !== 'restpause' || !set.clusters?.length) return updateSet(draft, exerciseIndex, setIndex, { reps });
  const clusters = retotalClusters(set.clusters, numberIn(reps));
  if (!clusters) return updateSet(draft, exerciseIndex, setIndex, { reps });
  return updateSet(draft, exerciseIndex, setIndex, { reps: String(numberIn(reps)), clusters });
}

/** Add one weight drop, seeded from the last drop (or the main set) at the plan's percentage. */
export function addDropSegment(draft: Draft, exerciseIndex: number, setIndex: number, profile: Profile): Draft {
  const exercise = draft.exercises[exerciseIndex];
  const set = exercise?.sets[setIndex];
  if (!exercise || !set || set.warmup || exerciseMode(exercise.target, profile) !== 'reps' || set.type === 'restpause') return draft;
  const drops = set.drops ?? [];
  const base = drops.length ? numberIn(drops[drops.length - 1].w) : numberIn(set.weight);
  const pct = exercise.target.intensifier?.type === 'dropset' ? exercise.target.intensifier.pct : 20;
  const weight = nextDropWeight(base, pct, dropGrid({ ...profile, unit: draft.unit }, { ...exercise.target, id: exercise.target.id }));
  const reps = Math.max(1, Math.trunc(numberIn(set.reps))) || 8;
  return replaceDraftSet(draft, exerciseIndex, setIndex, row => ({
    ...row,
    type: 'dropset',
    drops: [...drops, { key: randomUUID(), w: String(weight), r: String(reps) }],
  }));
}

export function setDropSegment(
  draft: Draft, exerciseIndex: number, setIndex: number, dropIndex: number,
  changes: Partial<Pick<DraftDrop, 'w' | 'r'>>,
): Draft {
  return replaceDraftSet(draft, exerciseIndex, setIndex, row => ({
    ...row,
    drops: (row.drops ?? []).map((drop, index) => index === dropIndex ? { ...drop, ...changes } : drop),
  }));
}

/** Remove one drop; clearing the last one turns the row back into a straight set. */
export function removeDropSegment(draft: Draft, exerciseIndex: number, setIndex: number, dropIndex: number): Draft {
  return replaceDraftSet(draft, exerciseIndex, setIndex, row => {
    const drops = (row.drops ?? []).filter((_, index) => index !== dropIndex);
    if (drops.length) return { ...row, drops };
    const { type: _type, drops: _drops, ...plain } = row;
    return plain;
  });
}

/**
 * Add a short-rest burst. A straight set becomes rest-pause with its original reps as the first
 * segment; a rest-pause set grows one roughly-halving segment after the last one.
 */
export function addClusterSegment(draft: Draft, exerciseIndex: number, setIndex: number, profile: Profile): Draft {
  const exercise = draft.exercises[exerciseIndex];
  const set = exercise?.sets[setIndex];
  if (!exercise || !set || set.warmup || exerciseMode(exercise.target, profile) !== 'reps' || set.type === 'dropset') return draft;
  const restSec = String(exerciseRestPauseSec(exercise.target, profile));
  const existing = set.clusters ?? [];
  const base = existing.length ? numberIn(existing[existing.length - 1].r) : numberIn(set.reps);
  if (!(base > 0)) return draft;
  const added = Math.max(1, nextBurstReps(base));
  const clusters = existing.length
    ? [...existing, { key: randomUUID(), r: String(added), restSec }]
    : [
      { key: randomUUID(), r: String(Math.trunc(base)), restSec },
      { key: randomUUID(), r: String(added), restSec },
    ];
  return replaceDraftSet(draft, exerciseIndex, setIndex, row => ({
    ...row,
    type: 'restpause',
    clusters,
    reps: String(clusters.reduce((total, cluster) => total + numberIn(cluster.r), 0)),
  }));
}

export function setClusterSegment(
  draft: Draft, exerciseIndex: number, setIndex: number, clusterIndex: number,
  changes: Partial<Pick<DraftCluster, 'r' | 'restSec'>>,
): Draft {
  return replaceDraftSet(draft, exerciseIndex, setIndex, row => {
    const clusters = (row.clusters ?? []).map((cluster, index) => index === clusterIndex ? { ...cluster, ...changes } : cluster);
    return { ...row, clusters, reps: String(clusters.reduce((total, cluster) => total + Math.max(0, numberIn(cluster.r)), 0)) };
  });
}

/** Remove one burst; when one or none is left the row reads as a plain set again. */
export function removeClusterSegment(draft: Draft, exerciseIndex: number, setIndex: number, clusterIndex: number): Draft {
  return replaceDraftSet(draft, exerciseIndex, setIndex, row => {
    const removed = row.clusters?.[clusterIndex];
    const clusters = (row.clusters ?? []).filter((_, index) => index !== clusterIndex);
    if (clusters.length > 1) {
      return { ...row, clusters, reps: String(clusters.reduce((total, cluster) => total + Math.max(0, numberIn(cluster.r)), 0)) };
    }
    const reps = clusters.length ? numberIn(clusters[0].r) : numberIn(removed?.r ?? row.reps);
    const { type: _type, clusters: _clusters, ...plain } = row;
    return { ...plain, reps: String(Math.max(1, Math.trunc(reps))) };
  });
}

export function localDate(time: number) {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${month}-${day}`;
}

export function validWorkoutDay(day: string) {
  const noon = new Date(`${day}T12:00:00`).getTime();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(noon) && localDate(noon) === day && day <= localDate(Date.now());
}

function loggedSegments(set: DraftSet): Pick<LoggedSet, 'type' | 'drops' | 'clusters'> | null {
  if (set.type === 'dropset' && set.drops?.length) return {
    type: 'dropset',
    drops: set.drops.map(drop => ({ w: numberIn(drop.w), r: Math.trunc(numberIn(drop.r)) })),
  };
  if (set.type === 'restpause' && set.clusters?.length) return {
    type: 'restpause',
    clusters: set.clusters.map(cluster => ({
      r: Math.trunc(numberIn(cluster.r)),
      restSec: Math.round(numberIn(cluster.restSec)),
    })),
  };
  return null;
}

function validSegments(set: DraftSet) {
  return validSetSegments(set);
}

const FORGOTTEN_GAP_MS = 20 * 60 * 1000;

/** What one ticked row itself took: a cardio row its minutes, a hold its seconds. */
function draftRowLengthMs(set: DraftSet, target: RoutineExercise) {
  const amount = set.type === 'restpause' ? draftClusterTotal(set) : numberIn(set.reps);
  if (target.mode === 'cardio') return amount * 60000;
  if (target.mode === 'time') return amount * 1000;
  return 0;
}

/**
 * The persisted end of the session. A workout left open and finished hours later
 * ends at the last tick of its unbroken run of work: a gap longer than 20 minutes
 * means the session was already over, and later catch-up ticks stay logged without
 * stretching the clock. This mirrors the Web's `sessionEnd`.
 */
export function draftSessionEnd(draft: Draft, now = Date.now()) {
  const ticks = draft.exercises
    .flatMap(exercise => exercise.sets
      .filter(set => set.at !== null)
      .map(set => ({ at: set.at as number, len: draftRowLengthMs(set, exercise.target) })))
    .sort((a, b) => a.at - b.at);
  if (!ticks.length) return now;
  let reach = ticks[0].at + ticks[0].len;
  for (const tick of ticks.slice(1)) {
    if (tick.at - tick.len - reach > FORGOTTEN_GAP_MS) break;
    reach = Math.max(reach, tick.at + tick.len);
  }
  return now - reach > FORGOTTEN_GAP_MS ? reach : now;
}

/**
 * Save the draft as one queued workout. Every entry with at least one ticked set
 * keeps all of its rows in order — unticked ones as `done: false` — and an entry
 * with nothing ticked drops out, mirroring the Web's `buildCompletedWorkout`. A
 * confirmed session with nothing ticked saves `entries: []`; a ticked row that
 * fails validation still refuses the save so the screen can point at it.
 */
export function finishWorkout(draft: Draft): QueuedWorkout | null {
  const entries: WorkoutEntry[] = [];
  let invalid = false;
  for (const { target, sets, rid, noProg } of draft.exercises) {
    if (!sets.some(set => set.at !== null)) continue;
    const rows = sets.flatMap<LoggedSet>(set => {
      const done = set.at !== null;
      const restPause = set.type === 'restpause' && !!set.clusters?.length;
      const amount = restPause ? draftClusterTotal(set) : numberIn(set.reps);
      const effective = restPause ? { ...set, reps: String(amount) } : set;
      if (done && (!validSegments(set) || !validSet(effective, target.mode))) {
        invalid = true;
        return [];
      }
      const weight = numberIn(set.weight);
      const values = target.mode === 'cardio' ? { speed: weight, min: amount }
        : target.mode === 'time' ? { w: weight, sec: amount } : { w: weight, r: amount };
      // One scale only. A row saved before effort existed simply has neither key.
      // A row is the whole set, so drop/cluster groups rate as one unit too.
      const rating = done && !set.warmup && set.effortScale && set.effort != null && Number.isFinite(set.effort)
        ? { [set.effortScale]: Math.round(Math.min(10, Math.max(0, set.effort)) * 10) / 10 }
        : {};
      return [{
        ...values,
        ...rating,
        ...(done ? { done: true, at: set.at as number } : { done: false }),
        ...(set.warmup ? { phase: 'warmup' as const, warmup: true } : {}),
        ...(loggedSegments(set) ?? {}),
      }];
    });
    if (invalid) return null;
    const topW = Math.max(0, ...rows.filter(row => row.done && !isWarmupRow(row)).map(row => row.w ?? 0)) || null;
    entries.push({
      id: target.id,
      sets: rows,
      topW,
      target,
      ...(rid ? { rid } : {}),
      ...(noProg ? { noProg: true } : {}),
      ...(target.sg ? { sg: target.sg } : {}),
    });
  }

  if (!validDayOrLive(draft)) return null;
  if (draft.backfillDay && entries.length === 0) return null;
  // An exercise left without a ticked set drops out above, and its partner is then
  // a superset of one; clear the tag it no longer shares with a neighbour.
  cleanupSg(entries);

  const savedAt = Date.now();
  const historicStart = draft.backfillDay ? new Date(`${draft.backfillDay}T12:00:00`).getTime() : draft.start;
  const start = Math.min(historicStart, savedAt);
  const end = draft.backfillDay ? Math.min(start + 3600000, savedAt) : draftSessionEnd(draft, savedAt);
  if (draft.backfillDay) {
    for (const entry of entries) for (const set of entry.sets) {
      if (set.at != null) set.at = Math.min(start + Math.max(0, set.at - draft.start), end);
    }
  }
  // Upstream semantics: drop-set drops add volume, rest-pause clusters are already inside the
  // row's own total and never count twice. The saved `vol` is the Web default (work sets only)
  // whatever the display switch says; screens recompute with the current setting.
  const vol = workoutVolume({ entries });
  const routineIds = draftRoutineIds(draft);
  const allNoProg = entries.length > 0 && entries.every(entry => entry.noProg === true);
  return {
    unit: draft.unit,
    workout: {
      id: draft.id, name: draft.name, d: localDate(start), start, end,
      ...(routineIds[0] ? { routineId: routineIds[0] } : {}),
      routineIds,
      bw: null, prs: [], entries, vol, _ts: savedAt,
      ...(allNoProg ? { excludeFromProgression: true } : {}),
    },
  };
}

function validDayOrLive(draft: Draft) {
  return !draft.backfillDay || validWorkoutDay(draft.backfillDay);
}

export function inProfileUnit(item: QueuedWorkout, unit: Unit): Workout {
  if (item.unit === unit) return item.workout;
  const factor = unit === 'kg' ? 0.45359237 : 1 / 0.45359237;
  const convert = (value: number) => Math.round(value * factor * 100) / 100;
  const load = (value: number | undefined) => value == null ? value : convert(value);

  // Drops ride on the row and, on a unilateral record, on each side; both must follow the unit
  // or the history would show a main set in pounds with drops still in kilograms.
  const convertSet = (set: LoggedSet): LoggedSet => {
    const out: LoggedSet = { ...set, w: load(set.w) };
    if (Array.isArray(set.drops)) out.drops = set.drops.map(drop => ({ ...drop, w: load(drop.w) }));
    if (set.sides) out.sides = {
      ...(set.sides.L ? { L: convertSet(set.sides.L) } : {}),
      ...(set.sides.R ? { R: convertSet(set.sides.R) } : {}),
    };
    return out;
  };

  const workout = item.workout;
  return {
    ...workout,
    vol: workout.vol == null ? undefined : convert(workout.vol),
    entries: workout.entries.map(entry => ({
      ...entry,
      topW: load(entry.topW ?? undefined) ?? null,
      target: entry.target?.weight == null ? entry.target : { ...entry.target, weight: convert(entry.target.weight) },
      sets: entry.sets.map(convertSet),
    })),
  };
}

function sameData(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => sameData(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => left[key] !== undefined);
  return keys.length === Object.keys(right).filter(key => right[key] !== undefined).length &&
    keys.every(key => sameData(left[key], right[key]));
}

function entryIndexFor(latest: WorkoutEntry[], base: WorkoutEntry, index: number) {
  if (latest[index]?.id === base.id) return index;
  const matches = latest.flatMap((entry, row) => entry.id === base.id ? [row] : []);
  return matches.length === 1 ? matches[0] : -1;
}

function setIndexFor(latest: LoggedSet[], base: LoggedSet, index: number) {
  const direct = latest[index];
  if (direct && (base.at == null || direct.at === base.at)) return index;
  if (base.at == null) return -1;
  const matches = latest.flatMap((set, row) => set.at === base.at ? [row] : []);
  return matches.length === 1 ? matches[0] : -1;
}

function topWeightOf(sets: LoggedSet[]) {
  return Math.max(0, ...sets.filter(set => set.done && !isWarmupRow(set)).map(set => set.w ?? 0)) || null;
}

/**
 * Overlay only the sets the history editor actually changed onto the record as it is now. An
 * untouched set keeps whatever another device wrote meanwhile; a target that moved or vanished
 * cannot be resolved and returns null so the caller can ask for a fresh history load.
 */
export function mergeHistoryEntries(
  latest: WorkoutEntry[],
  base: WorkoutEntry[],
  edited: WorkoutEntry[],
  volumeWarmups: boolean,
  bodyweight = 0,
): { entries: WorkoutEntry[]; vol: number } | null {
  if (base.length !== edited.length || base.length > latest.length) return null;
  const entries = latest.map(entry => ({ ...entry, sets: [...entry.sets] }));
  for (let index = 0; index < base.length; index++) {
    const before = base[index];
    const after = edited[index];
    if (!before || !after || before.id !== after.id) return null;
    if (sameData(before.sets, after.sets)) continue;
    const target = entryIndexFor(entries, before, index);
    if (target < 0) return null;
    const sets = [...entries[target].sets];
    if (before.sets.length !== after.sets.length) return null;
    for (let row = 0; row < before.sets.length; row++) {
      if (sameData(before.sets[row], after.sets[row])) continue;
      const at = setIndexFor(sets, before.sets[row], row);
      if (at < 0) return null;
      sets[at] = after.sets[row];
    }
    entries[target] = { ...entries[target], sets, topW: topWeightOf(sets) };
  }
  const vol = workoutVolume({ entries }, { warmups: volumeWarmups, bodyweight });
  return { entries, vol };
}
