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
  /** Explicit choice; wins over the legacy `showRir` boolean, including `none`. */
  effort?: EffortScale;
  /** Pre-`effort` preference. Only read when `effort` says nothing. */
  showRir?: boolean;
  /** Feature switches from the web profile; `effort` must be on for ratings to show. */
  modules?: Record<string, unknown>;
  routines?: Routine[];
  workouts?: Workout[];
  customEx?: CustomExercise[];
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
  /** Scale and value of the saved effort. Both absent means unrated. */
  effortScale?: RatingScale;
  effort?: number;
  type?: 'dropset' | 'restpause';
  drops?: DraftDrop[];
  clusters?: DraftCluster[];
};
type DraftExercise = { target: RoutineExercise; sets: DraftSet[] };

export type Draft = {
  id: string;
  routineId: string;
  name: string;
  unit: Unit;
  start: number;
  volumeWarmups?: boolean;
  exercises: DraftExercise[];
  rest?: { endsAt: number; exerciseIndex: number; setIndex: number } | null;
  backfillDay?: string;
};

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
  const exercise = startWorkout(
    { id: draft.routineId, name: draft.name, ex: [{ ...target, ...supersetFields(previous?.target) }] },
    inDraftUnit(profile, draft.unit), pending,
  ).exercises[0];
  return {
    ...draft,
    exercises: replaceIndex == null ? [...draft.exercises, exercise] : draft.exercises.map((entry, index) => index === replaceIndex ? exercise : entry),
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

function lastWorkingWeight(history: Workout[], target: RoutineExercise) {
  for (const workout of history) {
    for (const entry of workout.entries ?? []) {
      if (entry?.id !== target.id || entry.noProg ||
          (entry.target?.dbLoad ?? 'as') !== (target.dbLoad ?? 'as')) continue;
      const row = (entry.sets ?? []).findLast(set =>
        set?.done === true && !isWarmupRow(set) && modeForSet(set, entry.target) === 'reps' &&
        typeof set.r === 'number' && set.r > 0 && typeof set.w === 'number' && set.w >= 0 && set.w <= MAX_WEIGHT
      );
      if (row) return row.w;
    }
  }
  return undefined;
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

export function startWorkout(routine: Routine, profile: Profile, pending: readonly QueuedWorkout[] = []): Draft {
  const unit = unitOf(profile);
  const saved = (profile.workouts ?? []).filter(Boolean);
  const savedIds = new Set(saved.map(workout => workout.id));
  const history = [
    ...saved,
    ...pending.filter(item => !savedIds.has(item.workout.id)).map(item => inProfileUnit(item, unit)),
  ].filter(workout => !workout.excludeFromProgression).sort((a, b) => workoutTime(b) - workoutTime(a));
  const exercises = (routine.ex ?? [])
    .filter(item => item?.id)
    .map(target => {
      const count = Math.max(1, Math.min(MAX_WORK_SETS, Math.trunc(Number(target.sets) || 3)));
      const mode = exerciseMode(target, profile);
      if (mode !== 'reps') {
        const { intensifier: _intensifier, ...plain } = target;
        return { target: { ...plain, mode }, sets: Array.from({ length: count }, (_, index) => ({
          key: String(index), weight: String(mode === 'time' ? target.weight ?? 0 : target.speed ?? 0),
          reps: String(mode === 'time' ? target.sec ?? 45 : target.min ?? 20), at: null,
        })) };
      }
      const reps = String(target.reps ?? '').match(/^\d+/)?.[0] ?? '8';
      const previous = routine.excludeFromProgression || target.noProg ? undefined : lastWorkingWeight(history, target);
      const cfg = { ...target, mode: 'reps' };
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
      return { target: intensifier ? { ...target, intensifier } : target, sets };
    });
  return { id: randomUUID(), routineId: routine.id, name: routine.name, unit, start: Date.now(), exercises, volumeWarmups: profile.volumeWarmups === true };
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
    { id: draft.routineId, name: draft.name, ex: [target], excludeFromProgression: routine?.excludeFromProgression },
    inDraftUnit(profile, draft.unit), pending,
  ).exercises[0];
  if (!replacement) return draft;
  return {
    ...draft,
    rest: draft.rest?.exerciseIndex === exerciseIndex ? null : draft.rest,
    exercises: draft.exercises.map((exercise, index) => index === exerciseIndex ? replacement : exercise),
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

export function finishWorkout(draft: Draft): QueuedWorkout | null {
  const entries: WorkoutEntry[] = [];
  for (const { target, sets } of draft.exercises) {
    const done = sets.flatMap<LoggedSet>(set => {
      if (set.at === null || !validSegments(set)) return [];
      const restPause = set.type === 'restpause' && !!set.clusters?.length;
      const amount = restPause ? draftClusterTotal(set) : numberIn(set.reps);
      const effective = restPause ? { ...set, reps: String(amount) } : set;
      if (!validSet(effective, target.mode)) return [];
      const weight = numberIn(set.weight);
      const values = target.mode === 'cardio' ? { speed: weight, min: amount }
        : target.mode === 'time' ? { w: weight, sec: amount } : { w: weight, r: amount };
      // One scale only. A row saved before effort existed simply has neither key.
      // A row is the whole set, so drop/cluster groups rate as one unit too.
      const rating = !set.warmup && set.effortScale && set.effort != null && Number.isFinite(set.effort)
        ? { [set.effortScale]: Math.round(Math.min(10, Math.max(0, set.effort)) * 10) / 10 }
        : {};
      return [{
        ...values, ...rating, done: true, at: set.at,
        ...(set.warmup ? { phase: 'warmup' as const, warmup: true } : loggedSegments(set) ?? {}),
      }];
    });
    if (done.length === 0) continue;
    const topW = Math.max(0, ...done.filter(set => !isWarmupRow(set)).map(set => set.w ?? 0)) || null;
    entries.push({ id: target.id, sets: done, topW, target, ...(target.sg ? { sg: target.sg } : {}),
      ...(target.noProg ? { noProg: true } : {}) });
  }
  if (entries.length === 0) return null;

  if (draft.backfillDay && !validWorkoutDay(draft.backfillDay)) return null;
  const savedAt = Date.now();
  const historicStart = draft.backfillDay ? new Date(`${draft.backfillDay}T12:00:00`).getTime() : draft.start;
  const start = Math.min(historicStart, savedAt);
  const end = draft.backfillDay ? Math.min(start + 3600000, savedAt) : savedAt;
  if (draft.backfillDay) {
    for (const entry of entries) for (const set of entry.sets) {
      if (set.at != null) set.at = Math.min(start + Math.max(0, set.at - draft.start), end);
    }
  }
  // Upstream semantics: drop-set drops add volume, rest-pause clusters are already inside the
  // row's own total and never count twice. Warm-ups follow the session's stored switch.
  const vol = workoutVolume({ entries }, { warmups: draft.volumeWarmups === true });
  return {
    unit: draft.unit,
    workout: {
      id: draft.id, name: draft.name, d: localDate(start), start, end,
      ...(draft.routineId ? { routineId: draft.routineId } : {}), routineIds: draft.routineId ? [draft.routineId] : [],
      bw: null, prs: [], entries, vol, _ts: savedAt,
    },
  };
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
