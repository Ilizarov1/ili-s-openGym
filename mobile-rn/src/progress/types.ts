/**
 * Shared value shapes for the progress projections.
 *
 * The projections are pure functions over the same history array `StatsScreen`
 * already receives: `{ workout, unit, pending }[]`. Nothing here reads App state,
 * storage or the network, so every value can be derived again after an edit,
 * a deletion or a sync.
 */

import type { LoggedSet, Unit, Workout } from '../training';

export type SpeedUnit = 'kmh' | 'mph';

/** The unmodified history item shape handed to StatsScreen by App. */
export type ProgressHistoryItem = {
  workout: Workout;
  unit: Unit;
  pending: boolean;
};

/**
 * One history record after unit conversion and deduplication.
 *
 * `workout` is expressed in the profile's current weight unit so every metric can
 * be compared without branching. `original` keeps the stored record and unit, which
 * is what a source tap must hand back to the editor.
 */
export type ProgressWorkout = {
  key: string;
  workout: Workout;
  unit: Unit;
  original: Workout;
  originalUnit: Unit;
  pending: boolean;
  /** Epoch milliseconds from `workoutAt`; NaN when the record has no usable date. */
  at: number;
  /** Local calendar day from `workoutDay`; null when the record has no usable date. */
  day: string | null;
};

/** A traceable workout reference attached to a record or trend point. */
export type WorkoutSource = {
  key: string;
  workout: Workout;
  unit: Unit;
  pending: boolean;
  date: string;
  at: number;
};

export type RecordMode = 'reps' | 'time' | 'cardio';
export type RecordMetric = 'weight' | 'reps' | 'sec' | 'speed';

/** Resolved comparison rules and display units for one exercise. */
export type ExerciseMetricContext = {
  exerciseId: string;
  mode: RecordMode;
  metric: RecordMetric;
  assisted: boolean;
  unit: Unit;
  speedUnit: SpeedUnit;
};

/**
 * One comparable metric pick inside a workout. Values are already in display
 * units: weight in the profile unit, speed in the profile speed unit, reps and
 * seconds as numbers.
 */
export type ExerciseCandidate = {
  metric: RecordMetric;
  value: number;
  weight: number | null;
  weightUnit: Unit;
  reps: number | null;
  sec: number | null;
  speed: number | null;
  min: number | null;
  unitLabel: string;
  /** A legacy record that only kept `topW`; it has no completed work row. */
  topWOnly: boolean;
  entryIndex: number;
  setIndex: number | null;
};

export type ExerciseRecord = ExerciseCandidate & {
  source: WorkoutSource;
};

export type ExerciseRecordProjection = {
  mode: RecordMode;
  metric: RecordMetric;
  assisted: boolean;
  unitLabel: string;
  record: ExerciseRecord | null;
};

export type OneRmFormula =
  | 'epley'
  | 'brzycki'
  | 'lombardi'
  | 'oconner'
  | 'mayhew'
  | 'wathan'
  | 'lander'
  | 'weighted';

export type OneRmPoint = {
  value: number;
  weight: number;
  reps: number;
  formula: OneRmFormula;
  source: WorkoutSource;
  entryIndex: number;
  setIndex: number | null;
};

export type OneRmProjection = {
  formula: OneRmFormula;
  points: OneRmPoint[];
  best: OneRmPoint | null;
  assisted: boolean;
};

export type TrendRange = 30 | 90 | 365 | 0;
export type TrendRangeKey = '30' | '90' | '365' | 'all';

export type TrendWeek = {
  start: string;
  end: string;
  label: string;
  workouts: number;
  volume: number;
  pending: number;
};

export type WorkoutTrendSummary = {
  range: TrendRange;
  fromDay: string;
  toDay: string;
  weeks: TrendWeek[];
  workouts: number;
  volume: number;
  pending: number;
  thisWeek: {
    start: string;
    end: string;
    workouts: number;
    volume: number;
    pending: number;
  };
};

export type ExercisePerformancePoint = ExerciseCandidate & {
  source: WorkoutSource;
};

export type ExercisePerformance = {
  exerciseId: string;
  mode: RecordMode;
  metric: RecordMetric;
  assisted: boolean;
  unitLabel: string;
  points: ExercisePerformancePoint[];
  best: ExercisePerformancePoint | null;
  total: number;
};

export type ExerciseChoice = {
  id: string;
  name: string;
  mode: RecordMode;
  metric: RecordMetric;
  unitLabel: string;
  lastAt: number;
  lastDay: string | null;
  pending: boolean;
};

export type MuscleRange = 7 | 30 | 90 | 365 | 0;
export type MuscleRangeKey = 'week' | '30' | '90' | '365' | 'all';

export type MuscleRow = {
  slug: string;
  name: string;
  /** Effective sets: a primary muscle counts 1, a secondary one 0.4. */
  sets: number;
  level: number;
  trained: boolean;
};

export type MuscleBalance = {
  range: MuscleRange;
  windowStart: string | null;
  windowEnd: string;
  workouts: number;
  /** Completed work rows in the window, including rows with no muscle metadata. */
  completedSets: number;
  load: Record<string, number>;
  levels: Record<string, number>;
  rows: MuscleRow[];
  hasData: boolean;
};

/** A synthetic history entry passed to upstream `loadOfWorkouts`. */
export type MuscleLoadEntry = {
  id: string;
  sets: LoggedSet[];
  exercise?: Record<string, unknown>;
};
