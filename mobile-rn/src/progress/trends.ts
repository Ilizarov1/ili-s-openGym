/**
 * Workout trends and one exercise's performance points.
 *
 * Range boundaries are local calendar days, not rolling 24-hour slices: a workout
 * at 23:55 belongs to that day and week. Weeks always start on Monday, every week
 * between the first and last bucket is emitted (zero-filled), and two sessions on
 * the same day count as two sessions.
 *
 * Volume comes from upstream `sessionVolume`, so `profile.volumeWarmups` is
 * respected, drop-set drops add their own tonnage, and rest-pause clusters are not
 * counted twice (the row's own reps already include every burst).
 */

import { sessionVolume } from '../../../frontend/src/lib/history';
import type { Profile } from '../training';
import { localDayOf, mondayOf, noonOf, rangeFromDay, shortDay, weekEndOf, weekStartsBetween, inDayRange } from './dates';
import { normalizeHistory, sourceFrom, workoutInMeaning } from './history';
import {
  bestCandidateForWorkout,
  betterCandidate,
  exerciseMetricContext,
  metricUnitLabel,
} from './records';
import type {
  ExercisePerformance,
  ExercisePerformancePoint,
  ProgressHistoryItem,
  ProgressWorkout,
  TrendRange,
  TrendRangeKey,
  TrendWeek,
  WorkoutTrendSummary,
} from './types';

export const TREND_RANGE_OPTIONS: { value: TrendRangeKey; label: string }[] = [
  { value: '30', label: '30 天' },
  { value: '90', label: '90 天' },
  { value: '365', label: '1 年' },
  { value: 'all', label: '全部' },
];

export function trendRangeOf(key: TrendRangeKey): TrendRange {
  return key === '30' ? 30 : key === '90' ? 90 : key === '365' ? 365 : 0;
}

function earliestDay(workouts: readonly ProgressWorkout[], today: string): string | null {
  let earliest: string | null = null;
  for (const item of workouts) {
    if (item.day == null || item.day > today) continue;
    if (earliest == null || item.day < earliest) earliest = item.day;
  }
  return earliest;
}

function emptyWeek(start: string): TrendWeek {
  return {
    start,
    end: weekEndOf(start),
    label: shortDay(start),
    workouts: 0,
    volume: 0,
    pending: 0,
  };
}

/**
 * Weekly session counts and volume for a range. `now` is injectable so boundary
 * tests do not depend on the wall clock.
 */
export function workoutTrends(
  profile: Profile,
  history: readonly ProgressHistoryItem[],
  range: TrendRange,
  now: number = Date.now(),
): WorkoutTrendSummary {
  const workouts = normalizeHistory(profile, history);
  const today = localDayOf(now);
  const fromDay = rangeFromDay(range, today, earliestDay(workouts, today));
  const inRange = workouts.filter(item => inDayRange(item.day, fromDay, today));

  const buckets = new Map<string, TrendWeek>();
  for (const start of weekStartsBetween(fromDay, today)) buckets.set(start, emptyWeek(start));

  let volume = 0;
  let pending = 0;
  for (const item of inRange) {
    if (item.day == null) continue;
    const start = mondayOf(item.day);
    const bucket = buckets.get(start);
    const itemVolume = Math.max(0, Number(sessionVolume(item.workout, profile)) || 0);
    volume += itemVolume;
    if (item.pending) pending += 1;
    if (!bucket) continue;
    bucket.workouts += 1;
    bucket.volume += itemVolume;
    if (item.pending) bucket.pending += 1;
  }

  const thisWeekStart = mondayOf(today);
  const thisWeekEnd = weekEndOf(thisWeekStart);
  let weekWorkouts = 0;
  let weekVolume = 0;
  let weekPending = 0;
  for (const item of workouts) {
    if (item.day == null || item.day < thisWeekStart || item.day > thisWeekEnd) continue;
    weekWorkouts += 1;
    weekVolume += Math.max(0, Number(sessionVolume(item.workout, profile)) || 0);
    if (item.pending) weekPending += 1;
  }

  return {
    range,
    fromDay,
    toDay: today,
    weeks: [...buckets.values()],
    workouts: inRange.length,
    volume,
    pending,
    thisWeek: {
      start: thisWeekStart,
      end: thisWeekEnd,
      workouts: weekWorkouts,
      volume: weekVolume,
      pending: weekPending,
    },
  };
}

function pointAt(item: ProgressWorkout): number {
  if (Number.isFinite(item.at)) return item.at;
  if (item.day) {
    const noon = noonOf(item.day).getTime();
    if (Number.isFinite(noon)) return noon;
  }
  return Number.NaN;
}

/** One best completed-row point per workout, restricted to the selected range. */
export function exercisePerformance(
  profile: Profile,
  history: readonly ProgressHistoryItem[],
  exerciseId: string,
  range: TrendRange,
  now: number = Date.now(),
): ExercisePerformance {
  const workouts = normalizeHistory(profile, history);
  const context = exerciseMetricContext(profile, workouts, exerciseId);
  const today = localDayOf(now);
  const fromDay = rangeFromDay(range, today, earliestDay(workouts, today));

  const points: ExercisePerformancePoint[] = [];
  for (const item of workouts) {
    if (!inDayRange(item.day, fromDay, today)) continue;
    const workout = workoutInMeaning(profile, item.workout, exerciseId);
    const candidate = bestCandidateForWorkout(workout, exerciseId, context);
    // A legacy topW-only record has no completed work row, so it is a PR
    // fallback, not a performance point.
    if (!candidate || candidate.topWOnly) continue;
    points.push({ ...candidate, source: sourceFrom(item, pointAt(item), item.day ?? '') });
  }

  let best: ExercisePerformancePoint | null = null;
  for (const point of points) {
    if (!best || betterCandidate(point, best, context)) best = point;
  }

  return {
    exerciseId,
    mode: context.mode,
    metric: context.metric,
    assisted: context.assisted,
    unitLabel: metricUnitLabel(context.metric, context.unit, context.speedUnit),
    points,
    best,
    total: points.length,
  };
}

/** Chart-friendly projection of weekly volume; zero weeks stay at zero. */
export function volumeSeries(trend: WorkoutTrendSummary): { label: string; value: number }[] {
  return trend.weeks.map(week => ({ label: week.label, value: week.volume }));
}

/** The label a range uses in compact copy. */
export function rangeLabel(range: TrendRange): string {
  return range === 0 ? '全部' : range === 365 ? '1 年' : `${range} 天`;
}
