/**
 * Muscle coverage for the completed work in a range.
 *
 * Uses upstream `muscleBalanceWindow`, `loadOfWorkouts` and `levelsOf` so the
 * weighting is the same as Web: a completed work row is one group-level stimulus,
 * a primary muscle counts 1 and a secondary one 0.4. Drops and rest-pause bursts
 * ride on the row and are never counted as extra rows.
 *
 * Metadata resolution prefers a logged `muscleSnapshot`, then the custom exercise
 * in the current profile, then the built-in catalogue. An exercise with none of
 * these stays out of the load instead of inventing a body part.
 */

import { EXIDX } from '../../../frontend/src/lib/exercises';
import {
  loadOfWorkouts,
  levelsOf,
  MUSCLES,
  muscleBalanceWindow,
  muscleWeightsOf,
  rankOf,
} from '../../../frontend/src/lib/muscles';
import { MONDAY } from '../../../frontend/src/lib/format';
import { isWarmupRow } from '../../../frontend/src/lib/workout-model';
import type { Profile, Workout, WorkoutEntry } from '../training';
import { workoutKey } from '../training';
import { localDayOf, mondayOf, rangeFromDay } from './dates';
import { normalizeHistory } from './history';
import type {
  MuscleBalance,
  MuscleRange,
  MuscleRangeKey,
  MuscleRow,
  ProgressHistoryItem,
  ProgressWorkout,
} from './types';

export const MUSCLE_RANGE_OPTIONS: { value: MuscleRangeKey; label: string }[] = [
  { value: 'week', label: '本周' },
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '1 年' },
  { value: 'all', label: '全部' },
];

export function muscleRangeOf(key: MuscleRangeKey): MuscleRange {
  return key === 'week' ? 7 : key === '30' ? 30 : key === '90' ? 90 : key === '365' ? 365 : 0;
}

const MUSCLE_NAMES: Record<string, string> = {
  trapezius: '斜方肌',
  deltoids: '三角肌',
  chest: '胸部',
  'upper-back': '背阔肌',
  serratus: '前锯肌',
  biceps: '肱二头肌',
  triceps: '肱三头肌',
  forearm: '前臂',
  abs: '腹肌',
  obliques: '腹斜肌',
  'lower-back': '下背',
  gluteal: '臀部',
  quadriceps: '股四头肌',
  hamstring: '腘绳肌',
  adductors: '内收肌',
  'hip-flexors': '髋屈肌',
  calves: '小腿',
  tibialis: '胫骨前肌',
};

export function muscleName(slug: string): string {
  return MUSCLE_NAMES[slug] ?? slug;
}

type EntryExtras = WorkoutEntry & {
  muscleSnapshot?: unknown;
  exercise?: unknown;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function weightsRecord(value: unknown): Record<string, number> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const weight = Number(raw);
    if (Number.isFinite(weight) && weight > 0) out[key] = weight;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Resolve the muscle source for one logged entry. A snapshot wins; a snapshot with
 * no usable weights falls back to the current custom exercise (old custom records);
 * built-ins come from the catalogue. Unknown exercises return null.
 */
function metadataForEntry(
  profile: Profile,
  entry: WorkoutEntry,
): Record<string, unknown> | null {
  const extras = entry as EntryExtras;
  const snapshot = extras.muscleSnapshot;
  if (isPlainObject(snapshot) && Object.keys(snapshot).length > 0) {
    // A saved snapshot is authoritative: even an empty weight map must not borrow
    // muscles from the exercise's current profile or catalogue entry.
    const weights = weightsRecord(muscleWeightsOf(snapshot));
    const originalWeights = isPlainObject(snapshot.muscleWeights) ? snapshot.muscleWeights : {};
    return { ...snapshot, muscleWeights: weights ?? originalWeights };
  }
  const embedded = extras.exercise;
  if (isPlainObject(embedded)) {
    const weights = weightsRecord(muscleWeightsOf(embedded));
    if (weights) return { ...embedded, muscleWeights: weights };
    const muscleKeys = [
      'muscleWeights', 'muscleGroups', 'muscles', 'targetMuscles',
      'primaries', 'primaryMuscles', 'primary',
      'secondaries', 'secondaryMuscles', 'secondary',
      'bp', 'tg', 'mg', 'sm',
    ];
    if (muscleKeys.some(key => Object.prototype.hasOwnProperty.call(embedded, key))) {
      const originalWeights = isPlainObject(embedded.muscleWeights) ? embedded.muscleWeights : {};
      return { ...embedded, muscleWeights: originalWeights };
    }
  }

  // A legacy record may carry its own body part / muscle fields instead of a
  // snapshot; those still identify the exercise after its custom entry is gone.
  const inline = entry as unknown as Record<string, unknown>;
  const inlineWeights = weightsRecord(muscleWeightsOf(inline));
  if (inlineWeights) return { ...inline, muscleWeights: inlineWeights };

  const custom = profile.customEx?.find(exercise => exercise.id === entry.id);
  if (custom) {
    const customMeta: Record<string, unknown> = { ...custom };
    const weights = weightsRecord(muscleWeightsOf(customMeta));
    return weights ? { ...customMeta, muscleWeights: weights } : customMeta;
  }

  const index = EXIDX as unknown as Record<string, Record<string, unknown> | undefined>;
  const builtin = index[entry.id];
  return builtin ?? null;
}

function completedRowCount(entry: WorkoutEntry): number {
  const sets = Array.isArray(entry.sets) ? entry.sets : [];
  return sets.filter(set => set?.done === true && !isWarmupRow(set)).length;
}

function preparedEntries(profile: Profile, workouts: readonly ProgressWorkout[]) {
  return workouts.map(workout => {
    const entries: { id: string; sets: WorkoutEntry['sets']; exercise: Record<string, unknown> }[] = [];
    for (const entry of workout.workout.entries ?? []) {
      if (!entry?.id) continue;
      const exercise = metadataForEntry(profile, entry);
      if (!exercise) continue;
      entries.push({ id: entry.id, sets: entry.sets ?? [], exercise });
    }
    return { entries };
  });
}

/** Effective sets, levels and a text-ready row per muscle for the selected range. */
export function muscleBalance(
  profile: Profile,
  history: readonly ProgressHistoryItem[],
  range: MuscleRange,
  now: number = Date.now(),
): MuscleBalance {
  const workouts = normalizeHistory(profile, history);
  const today = localDayOf(now);
  const inWindow = muscleBalanceWindow(
    workouts.map(item => item.workout),
    range,
    now,
    today,
    MONDAY,
  ) as unknown[];
  const windowKeys = new Set(
    inWindow.flatMap(workout =>
      workout && typeof workout === 'object' ? [workoutKey(workout as Workout)] : [],
    ),
  );
  const windowWorkouts = workouts.filter(item => windowKeys.has(item.key));

  const prepared = preparedEntries(profile, windowWorkouts);
  const rawLoad = loadOfWorkouts(prepared, null) as Record<string, unknown> | null | undefined;

  const load: Record<string, number> = {};
  for (const slug of MUSCLES as string[]) {
    const value = Number(rawLoad?.[slug]);
    if (Number.isFinite(value) && value > 0) load[slug] = value;
  }

  const rawLevels = levelsOf(load) as Record<string, unknown>;
  const levels: Record<string, number> = {};
  for (const slug of MUSCLES as string[]) {
    const level = Number(rawLevels?.[slug] ?? 0);
    levels[slug] = Number.isFinite(level) ? Math.max(0, Math.min(4, Math.round(level))) : 0;
  }

  const ranked = rankOf(load) as { worked?: unknown; missed?: unknown };
  const worked = Array.isArray(ranked.worked) ? ranked.worked.filter((slug): slug is string => typeof slug === 'string') : [];
  const missed = Array.isArray(ranked.missed) ? ranked.missed.filter((slug): slug is string => typeof slug === 'string') : [];
  const order = [...worked, ...missed];
  const rows: MuscleRow[] = order.map(slug => {
    const sets = load[slug] ?? 0;
    return {
      slug,
      name: muscleName(slug),
      sets,
      level: levels[slug] ?? 0,
      trained: sets > 0,
    };
  });

  let completedSets = 0;
  for (const item of windowWorkouts) {
    for (const entry of item.workout.entries ?? []) completedSets += completedRowCount(entry);
  }

  const windowStart = range === 7
    ? mondayOf(today)
    : range === 0
      ? null
      : rangeFromDay(range, today, null);

  return {
    range,
    windowStart,
    windowEnd: today,
    workouts: windowWorkouts.length,
    completedSets,
    load,
    levels,
    rows,
    hasData: rows.some(row => row.sets > 0),
  };
}

export function muscleRangeLabel(range: MuscleRange): string {
  return range === 7 ? '本周' : range === 0 ? '全部' : range === 365 ? '1 年' : `${range} 天`;
}
