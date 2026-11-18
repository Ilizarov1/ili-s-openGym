/**
 * PR and per-workout metric selection.
 *
 * The ranking rules follow the upstream exercise-history / Stats projections:
 * mode comes from the most recently logged metric entry, warm-ups and unfinished
 * rows are dropped by `metricRowsForEntry`, assistance machines fold the other way,
 * equal loads prefer more completed reps, and an old record that only carries `topW`
 * still produces a weight-only PR.
 */

import { betterWeight, isAssisted } from '../../../frontend/src/lib/exercises';
import {
  bestWeightForEntry,
  completedRepsOf,
  metricEntriesForExercise,
  modeOf,
} from '../../../frontend/src/lib/history';
import { speedLabel, speedUnitOf, toSpeed } from '../../../frontend/src/lib/speed';
import { isSideSet } from '../../../frontend/src/lib/workout-model';
import {
  exerciseName,
  unitOf,
  type LoggedSet,
  type Profile,
  type Unit,
  type Workout,
  type WorkoutEntry,
} from '../training';
import { normalizeHistory, sourceOf, workoutInMeaning } from './history';
import type {
  ExerciseCandidate,
  ExerciseChoice,
  ExerciseMetricContext as Context,
  ExerciseRecord,
  ExerciseRecordProjection,
  ProgressHistoryItem,
  ProgressWorkout,
  RecordMetric,
  RecordMode,
  SpeedUnit,
} from './types';

type MetricItem = {
  entry: WorkoutEntry;
  mode: unknown;
  rows: LoggedSet[];
};

type EntryExtras = WorkoutEntry & {
  muscleSnapshot?: { n?: unknown } | null;
};

type RoutineExerciseFlag = {
  assisted?: boolean;
};

type CustomExerciseExtras = {
  n?: string;
  name?: string;
  assisted?: boolean;
};

function asSpeedUnit(value: unknown): SpeedUnit {
  return value === 'mph' ? 'mph' : 'kmh';
}

function normalizeMode(value: unknown): RecordMode | null {
  return value === 'reps' || value === 'time' || value === 'cardio' ? value : null;
}

function numberOf(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `metricEntriesForExercise` with a narrow shape, never an `any` leak. */
function metricItemsOf(workout: Workout, exerciseId: string): MetricItem[] {
  const raw = metricEntriesForExercise(workout, exerciseId);
  if (!Array.isArray(raw)) return [];
  const items: MetricItem[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const item = value as { entry?: unknown; mode?: unknown; rows?: unknown };
    if (!item.entry || typeof item.entry !== 'object' || !Array.isArray(item.rows)) continue;
    items.push({
      entry: item.entry as WorkoutEntry,
      mode: item.mode,
      rows: item.rows as LoggedSet[],
    });
  }
  return items;
}

function targetAssisted(entry: WorkoutEntry): boolean | null {
  const target = entry.target as RoutineExerciseFlag | undefined;
  return typeof target?.assisted === 'boolean' ? target.assisted : null;
}

function defaultAssisted(profile: Profile, exerciseId: string): boolean {
  const custom = profile.customEx?.find(exercise => exercise.id === exerciseId) as
    | CustomExerciseExtras
    | undefined;
  if (custom?.assisted === true) return true;
  return Boolean(isAssisted(exerciseId));
}

/** Resolve the assistance direction: a routine override, then custom profile, then catalogue. */
export function exerciseAssisted(
  profile: Profile,
  workouts: readonly ProgressWorkout[],
  exerciseId: string,
): boolean {
  for (let index = workouts.length - 1; index >= 0; index--) {
    for (const entry of workouts[index].workout.entries ?? []) {
      if (entry?.id !== exerciseId) continue;
      const flag = targetAssisted(entry);
      if (flag != null) return flag;
    }
  }
  return defaultAssisted(profile, exerciseId);
}

/** The assistance direction of one entry, for the 1RM scan which works per set. */
export function entryAssisted(
  profile: Profile,
  exerciseId: string,
  entry: WorkoutEntry,
): boolean {
  const flag = targetAssisted(entry);
  return flag != null ? flag : defaultAssisted(profile, exerciseId);
}

function resolveMode(workouts: readonly ProgressWorkout[], exerciseId: string): RecordMode {
  for (let index = workouts.length - 1; index >= 0; index--) {
    const items = metricItemsOf(workouts[index].workout, exerciseId);
    for (let item = items.length - 1; item >= 0; item--) {
      const mode = normalizeMode(items[item].mode);
      if (mode) return mode;
    }
  }
  return normalizeMode(modeOf({ id: exerciseId })) ?? 'reps';
}

function hasLoadedRepWeight(
  workouts: readonly ProgressWorkout[],
  exerciseId: string,
): boolean {
  for (const item of workouts) {
    for (const metric of metricItemsOf(item.workout, exerciseId)) {
      if (normalizeMode(metric.mode) !== 'reps') continue;
      const weight = Number(bestWeightForEntry(metric.entry));
      if (Number.isFinite(weight) && weight > 0) return true;
    }
  }
  return false;
}

/**
 * Mode, metric, assistance direction and display units for one exercise.
 * A reps exercise with no positive load anywhere plots reps instead of a
 * meaningless 0 kg weight, matching upstream exercise-history.
 */
export function exerciseMetricContext(
  profile: Profile,
  workouts: readonly ProgressWorkout[],
  exerciseId: string,
): Context {
  const mode = resolveMode(workouts, exerciseId);
  const unit = unitOf(profile);
  const speedUnit = asSpeedUnit(speedUnitOf(profile));
  const metric: RecordMetric = mode === 'reps'
    ? (hasLoadedRepWeight(workouts, exerciseId) ? 'weight' : 'reps')
    : mode === 'time'
      ? 'sec'
      : 'speed';
  return {
    exerciseId,
    mode,
    metric,
    assisted: exerciseAssisted(profile, workouts, exerciseId),
    unit,
    speedUnit,
  };
}

export function metricUnitLabel(metric: RecordMetric, unit: Unit, speedUnit: SpeedUnit): string {
  if (metric === 'weight') return unit;
  if (metric === 'reps') return '次';
  if (metric === 'sec') return '秒';
  return speedLabel(speedUnit) as string;
}

function isBetterWeight(next: number, current: number, context: Context): boolean {
  if (!Number.isFinite(next) || next === current) return false;
  const helper = { id: context.exerciseId, assisted: context.assisted };
  return Number(betterWeight(helper, current, next)) === next;
}

function completedParts(set: LoggedSet): LoggedSet[] {
  if (isSideSet(set)) {
    return [set.sides?.L, set.sides?.R].filter(
      (side): side is LoggedSet => side != null && side.done === true,
    );
  }
  return set.done === true ? [set] : [];
}

function candidateOf(
  metric: RecordMetric,
  context: Context,
  entryIndex: number,
  values: {
    value: number;
    weight?: number | null;
    reps?: number | null;
    sec?: number | null;
    speed?: number | null;
    min?: number | null;
    topWOnly?: boolean;
    setIndex?: number | null;
  },
): ExerciseCandidate {
  return {
    metric,
    value: values.value,
    weight: values.weight ?? null,
    weightUnit: context.unit,
    reps: values.reps ?? null,
    sec: values.sec ?? null,
    speed: values.speed ?? null,
    min: values.min ?? null,
    unitLabel: metricUnitLabel(metric, context.unit, context.speedUnit),
    topWOnly: values.topWOnly === true,
    entryIndex,
    setIndex: values.setIndex ?? null,
  };
}

function bestRepWeightCandidate(
  entry: WorkoutEntry,
  rows: LoggedSet[],
  context: Context,
  entryIndex: number,
): ExerciseCandidate | null {
  let bestWeight: number | null = null;
  let bestReps = -1;
  let bestSetIndex: number | null = null;

  rows.forEach((set, setIndex) => {
    for (const part of completedParts(set)) {
      const weight = Number(part.w);
      if (!Number.isFinite(weight)) continue;
      // A zero on an assistance machine is an unentered load, not "no help at all".
      if (context.assisted && !(weight > 0)) continue;
      const reps = Math.max(0, Number(completedRepsOf(set)) || 0);
      const wins = bestWeight == null ||
        isBetterWeight(weight, bestWeight, context) ||
        (weight === bestWeight && reps > bestReps);
      if (wins) {
        bestWeight = weight;
        bestReps = reps;
        bestSetIndex = setIndex;
      }
    }
  });

  if (bestWeight != null) {
    return candidateOf('weight', context, entryIndex, {
      value: bestWeight,
      weight: bestWeight,
      reps: bestReps >= 0 ? bestReps : null,
      setIndex: bestSetIndex,
    });
  }

  // Legacy record: only `topW` survived, no completed row. Keep the weight and
  // its date; the rep count stays empty rather than inventing one.
  const topWeight = Number(bestWeightForEntry(entry));
  if (Number.isFinite(topWeight) && topWeight > 0) {
    return candidateOf('weight', context, entryIndex, {
      value: topWeight,
      weight: topWeight,
      reps: null,
      topWOnly: true,
    });
  }
  return null;
}

function bestRepCountCandidate(
  rows: LoggedSet[],
  context: Context,
  entryIndex: number,
): ExerciseCandidate | null {
  let bestReps = 0;
  let bestWeight: number | null = null;
  let bestSetIndex: number | null = null;

  rows.forEach((set, setIndex) => {
    const reps = Math.max(0, Number(completedRepsOf(set)) || 0);
    if (!(reps > 0)) return;
    const weight = numberOf(set.w);
    const wins = reps > bestReps ||
      (reps === bestReps && weight != null && weight > 0 &&
        (bestWeight == null || isBetterWeight(weight, bestWeight, context)));
    if (wins) {
      bestReps = reps;
      bestWeight = weight;
      bestSetIndex = setIndex;
    }
  });

  if (!(bestReps > 0)) return null;
  return candidateOf('reps', context, entryIndex, {
    value: bestReps,
    weight: bestWeight,
    reps: bestReps,
    setIndex: bestSetIndex,
  });
}

function bestTimeCandidate(
  rows: LoggedSet[],
  context: Context,
  entryIndex: number,
): ExerciseCandidate | null {
  let bestSec = 0;
  let bestWeight: number | null = null;
  let bestSetIndex: number | null = null;

  rows.forEach((set, setIndex) => {
    const sec = Number(set.sec);
    if (!Number.isFinite(sec) || sec <= 0) return;
    const weight = numberOf(set.w);
    const wins = sec > bestSec ||
      (sec === bestSec && weight != null && weight > 0 &&
        (bestWeight == null || isBetterWeight(weight, bestWeight, context)));
    if (wins) {
      bestSec = sec;
      bestWeight = weight;
      bestSetIndex = setIndex;
    }
  });

  if (!(bestSec > 0)) return null;
  return candidateOf('sec', context, entryIndex, {
    value: bestSec,
    weight: bestWeight,
    sec: bestSec,
    setIndex: bestSetIndex,
  });
}

function bestCardioCandidate(
  rows: LoggedSet[],
  context: Context,
  entryIndex: number,
): ExerciseCandidate | null {
  let bestSpeed = 0;
  let bestMin: number | null = null;
  let bestSetIndex: number | null = null;

  rows.forEach((set, setIndex) => {
    const stored = Number(set.speed);
    if (!Number.isFinite(stored) || stored <= 0) return;
    // Speed is stored in km/h; compare and display it in the profile's unit.
    const speed = Number(toSpeed(stored, context.speedUnit));
    if (!Number.isFinite(speed) || speed <= 0) return;
    const min = numberOf(set.min);
    const wins = speed > bestSpeed ||
      (speed === bestSpeed && min != null && (bestMin == null || min > bestMin));
    if (wins) {
      bestSpeed = speed;
      bestMin = min;
      bestSetIndex = setIndex;
    }
  });

  if (!(bestSpeed > 0)) return null;
  return candidateOf('speed', context, entryIndex, {
    value: bestSpeed,
    speed: bestSpeed,
    min: bestMin,
    setIndex: bestSetIndex,
  });
}

/** Is `next` a better pick than `current` under the exercise's metric? */
export function betterCandidate(
  next: ExerciseCandidate,
  current: ExerciseCandidate,
  context: Context,
): boolean {
  if (context.metric === 'weight') {
    const nextWeight = next.weight ?? 0;
    const currentWeight = current.weight ?? 0;
    if (nextWeight !== currentWeight) {
      return isBetterWeight(nextWeight, currentWeight, context);
    }
    return (next.reps ?? -1) > (current.reps ?? -1);
  }
  if (context.metric === 'reps') {
    if (next.value !== current.value) return next.value > current.value;
    const nextWeight = next.weight ?? 0;
    const currentWeight = current.weight ?? 0;
    return nextWeight !== currentWeight && isBetterWeight(nextWeight, currentWeight, context);
  }
  if (context.metric === 'sec') {
    if (next.value !== current.value) return next.value > current.value;
    const nextWeight = next.weight ?? 0;
    const currentWeight = current.weight ?? 0;
    return nextWeight !== currentWeight && isBetterWeight(nextWeight, currentWeight, context);
  }
  if (next.value !== current.value) return next.value > current.value;
  return (next.min ?? -1) > (current.min ?? -1);
}

/** The best completed metric inside one workout, across every occurrence of the exercise. */
export function bestCandidateForWorkout(
  workout: Workout,
  exerciseId: string,
  context: Context,
): ExerciseCandidate | null {
  const entries = workout.entries ?? [];
  let best: ExerciseCandidate | null = null;
  for (const item of metricItemsOf(workout, exerciseId)) {
    if (normalizeMode(item.mode) !== context.mode) continue;
    const entryIndex = entries.indexOf(item.entry);
    if (entryIndex < 0) continue;
    const candidate = context.metric === 'weight'
      ? bestRepWeightCandidate(item.entry, item.rows, context, entryIndex)
      : context.metric === 'reps'
        ? bestRepCountCandidate(item.rows, context, entryIndex)
        : context.metric === 'sec'
          ? bestTimeCandidate(item.rows, context, entryIndex)
          : bestCardioCandidate(item.rows, context, entryIndex);
    if (candidate && (!best || betterCandidate(candidate, best, context))) best = candidate;
  }
  return best;
}

/** The all-time PR for one exercise, derived from the normalised history. */
export function exerciseRecordFromWorkouts(
  profile: Profile,
  workouts: readonly ProgressWorkout[],
  exerciseId: string,
): ExerciseRecordProjection {
  const context = exerciseMetricContext(profile, workouts, exerciseId);
  let record: ExerciseRecord | null = null;
  for (const item of workouts) {
    const workout = workoutInMeaning(profile, item.workout, exerciseId);
    const candidate = bestCandidateForWorkout(workout, exerciseId, context);
    if (!candidate) continue;
    if (!record || betterCandidate(candidate, record, context)) {
      record = { ...candidate, source: sourceOf(item) };
    }
  }
  return {
    mode: context.mode,
    metric: context.metric,
    assisted: context.assisted,
    unitLabel: metricUnitLabel(context.metric, context.unit, context.speedUnit),
    record,
  };
}

/** Convenience wrapper taking the raw StatsScreen history. */
export function exerciseRecord(
  profile: Profile,
  history: readonly ProgressHistoryItem[],
  exerciseId: string,
): ExerciseRecordProjection {
  return exerciseRecordFromWorkouts(profile, normalizeHistory(profile, history), exerciseId);
}

function displayNameOf(
  profile: Profile,
  workouts: readonly ProgressWorkout[],
  exerciseId: string,
): string {
  const custom = profile.customEx?.find(exercise => exercise.id === exerciseId) as
    | CustomExerciseExtras
    | undefined;
  const customName = custom?.n ?? custom?.name;
  if (typeof customName === 'string' && customName.trim()) return customName;
  for (const item of workouts) {
    for (const entry of item.workout.entries ?? []) {
      if (entry?.id !== exerciseId) continue;
      const snapshotName = (entry as EntryExtras).muscleSnapshot?.n;
      if (typeof snapshotName === 'string' && snapshotName.trim()) return snapshotName;
    }
  }
  return exerciseName(profile, exerciseId);
}

/** Exercises with at least one completed metric row, newest first. */
export function exerciseChoices(
  profile: Profile,
  history: readonly ProgressHistoryItem[],
): ExerciseChoice[] {
  const workouts = normalizeHistory(profile, history);
  const latest = new Map<string, { at: number; day: string | null; pending: boolean }>();

  for (const item of workouts) {
    for (const entry of item.workout.entries ?? []) {
      const id = entry?.id;
      if (!id) continue;
      if (!metricItemsOf(item.workout, id).some(metric => metric.rows.length > 0)) continue;
      const at = Number.isFinite(item.at) ? item.at : Number.NEGATIVE_INFINITY;
      const previous = latest.get(id);
      if (!previous || at >= previous.at) {
        latest.set(id, { at, day: item.day, pending: item.pending });
      }
    }
  }

  const choices: ExerciseChoice[] = [];
  for (const [id, last] of latest) {
    const context = exerciseMetricContext(profile, workouts, id);
    choices.push({
      id,
      name: displayNameOf(profile, workouts, id),
      mode: context.mode,
      metric: context.metric,
      unitLabel: metricUnitLabel(context.metric, context.unit, context.speedUnit),
      lastAt: last.at,
      lastDay: last.day,
      pending: last.pending,
    });
  }

  return choices.sort((a, b) => {
    const aAt = Number.isFinite(a.lastAt) ? a.lastAt : Number.NEGATIVE_INFINITY;
    const bAt = Number.isFinite(b.lastAt) ? b.lastAt : Number.NEGATIVE_INFINITY;
    if (aAt !== bAt) return bAt - aAt;
    return a.name.localeCompare(b.name);
  });
}
