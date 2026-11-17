import { randomUUID } from 'expo-crypto';
import { isWarmupRow, modeForSet } from '../../frontend/src/lib/workout-model';
import { barFloor, effortOf as preferenceOf, insertWarmupRow, MAX_PLANNED_WARMUPS } from '../../frontend/src/lib/history';
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
};

export type Routine = { id: string; name: string; ex?: RoutineExercise[]; excludeFromProgression?: boolean };
export type CustomExercise = { id: string; n?: string; name?: string; bp?: string; eq?: string; note?: string };

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
};
type WorkoutEntry = {
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
  _ts?: number;
  excludeFromProgression?: boolean;
};

export type Profile = {
  unit?: Unit;
  restSec?: number;
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
  week?: Record<string, string | string[]>;
  dayPlan?: Record<string, string>;
  scheduleMode?: 'week' | 'rotation';
  rotation?: { id: string; sequence: string[]; label: string; at?: number } | null;
  queue?: { ids: string[]; since: number; startsOn: string; label?: string; rotationId?: string } | null;
  deleted?: { workouts?: Record<string, number>; routines?: Record<string, number>; customEx?: Record<string, number> };
  resetAt?: number;
  _wid?: string;
  [key: string]: unknown;
};

type DraftSet = {
  key?: string;
  weight: string;
  reps: string;
  at: number | null;
  warmup?: boolean;
  /** Scale and value of the saved effort. Both absent means unrated. */
  effortScale?: RatingScale;
  effort?: number;
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
        return { target: { ...target, mode }, sets: Array.from({ length: count }, (_, index) => ({
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
      const sets = rows.map((row, index) => ({
        key: String(index), weight: String(row.w), reps: String(row.r), at: null,
        warmup: isWarmupRow(row),
      }));
      return { target, sets };
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

  const { id: previousId, sets, reps, restSec, restOff, noProg, warmup, warmupRows, warmupSets } = entry.target;
  const target = {
    id, sets, reps, restSec, restOff, noProg, warmup, warmupRows, warmupSets,
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

export function finishWorkout(draft: Draft): QueuedWorkout | null {
  const entries: WorkoutEntry[] = [];
  for (const { target, sets } of draft.exercises) {
    const done = sets.flatMap<LoggedSet>(set => {
      if (set.at === null || !validSet(set, target.mode)) return [];
      const weight = Number(set.weight.replace(',', '.'));
      const amount = Number(set.reps);
      const values = target.mode === 'cardio' ? { speed: weight, min: amount }
        : target.mode === 'time' ? { w: weight, sec: amount } : { w: weight, r: amount };
      // One scale only. A row saved before effort existed simply has neither key.
      // A row is the whole set, so future drop/cluster groups rate as one unit too.
      const rating = !set.warmup && set.effortScale && set.effort != null && Number.isFinite(set.effort)
        ? { [set.effortScale]: Math.round(Math.min(10, Math.max(0, set.effort)) * 10) / 10 }
        : {};
      return [{ ...values, ...rating, done: true, at: set.at, ...(set.warmup ? { phase: 'warmup', warmup: true } : {}) }];
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
  const vol = entries.reduce((total, entry) => total + entry.sets.reduce((sum, set) => (
    sum + (!draft.volumeWarmups && isWarmupRow(set) ? 0
      : (set.w ?? 0) * (set.r ?? 0) * (entry.target?.dbLoad === 'each' ? 2 : 1))
  ), 0), 0);
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
  const workout = item.workout;
  return {
    ...workout,
    vol: workout.vol == null ? undefined : convert(workout.vol),
    entries: workout.entries.map(entry => ({
      ...entry,
      topW: entry.topW == null ? entry.topW : convert(entry.topW),
      target: entry.target?.weight == null ? entry.target : { ...entry.target, weight: convert(entry.target.weight) },
      sets: entry.sets.map(set => ({ ...set, w: set.w == null ? undefined : convert(set.w) })),
    })),
  };
}
