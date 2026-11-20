/** Public surface of the progress feature (PR, 1RM, trends and muscle balance). */

export { normalizeHistory, currentMeaning, workoutInMeaning, sourceOf, sourceFrom } from './history';
export {
  betterCandidate,
  bestCandidateForWorkout,
  entryAssisted,
  exerciseAssisted,
  exerciseChoices,
  exerciseMetricContext,
  exerciseRecord,
  exerciseRecordFromWorkouts,
  metricUnitLabel,
} from './records';
export {
  oneRmFormulaLabel,
  oneRmProjection,
  oneRmProjectionFromWorkouts,
  REP_CAP,
  WEIGHTED_REP_CAP,
} from './oneRm';
export {
  exercisePerformance,
  rangeLabel,
  TREND_RANGE_OPTIONS,
  trendRangeOf,
  volumeSeries,
  workoutTrends,
} from './trends';
export {
  MUSCLE_RANGE_OPTIONS,
  muscleBalance,
  muscleName,
  muscleRangeLabel,
  muscleRangeOf,
} from './muscle';
export {
  candidateDetail,
  candidateValueText,
  formatCount,
  formatDayLabel,
  formatDurationSeconds,
  formatMonthDay,
  formatNumber,
  formatSets,
  formatVolume,
  metricLabel,
  modeLabel,
  sourceText,
} from './format';
export { ExerciseRecordSection } from './ExerciseRecordSection';
export type { ExerciseRecordSectionProps } from './ExerciseRecordSection';
export { workoutSummary } from './summary';
export type { WorkoutSummary } from './summary';
export type {
  ExerciseCandidate,
  ExerciseChoice,
  ExerciseMetricContext,
  ExercisePerformance,
  ExercisePerformancePoint,
  ExerciseRecord,
  ExerciseRecordProjection,
  MuscleBalance,
  MuscleRange,
  MuscleRangeKey,
  MuscleRow,
  OneRmFormula,
  OneRmPoint,
  OneRmProjection,
  ProgressHistoryItem,
  ProgressWorkout,
  RecordMetric,
  RecordMode,
  SpeedUnit,
  TrendRange,
  TrendRangeKey,
  TrendWeek,
  WorkoutSource,
  WorkoutTrendSummary,
} from './types';
