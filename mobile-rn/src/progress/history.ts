/**
 * History normalisation for every progress view.
 *
 * A record is read exactly once: tombstones are dropped, the profile unit is applied,
 * duplicates are collapsed by `workoutKey`, and the result is sorted chronologically.
 * Pending (not yet uploaded) records stay in the set; their `pending` flag travels with
 * the source so the UI can badge them.
 */

import { currentDbLoad, dbLoadOf, workoutAs } from '../../../frontend/src/lib/dumbbells';
import { workoutAt, workoutDay } from '../../../frontend/src/lib/history';
import {
  inProfileUnit,
  unitOf,
  workoutKey,
  type Profile,
  type Workout,
} from '../training';
import type { ProgressHistoryItem, ProgressWorkout, WorkoutSource } from './types';

function numberOf(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `_ts` of a stored workout, or 0 when the record predates stamped edits. */
function stampOf(workout: Workout): number {
  const stamp = numberOf(workout._ts);
  return stamp ?? 0;
}

function preferredRecord(next: ProgressWorkout, current: ProgressWorkout): ProgressWorkout {
  const nextStamp = stampOf(next.original);
  const currentStamp = stampOf(current.original);
  if (nextStamp !== currentStamp) return nextStamp > currentStamp ? next : current;
  // Same stamp: the synced copy is the authority; a pending copy only wins when it
  // carries a newer stamp, i.e. a real edit queued after the last download.
  if (next.pending !== current.pending) return next.pending ? current : next;
  return next;
}

/**
 * Coerce the history handed to StatsScreen into one record per workout key.
 *
 * `profile.deleted.workouts` wins even when a stale server copy or a queued upload is
 * still present, so deleting a workout cannot leave it in a chart.
 */
export function normalizeHistory(
  profile: Profile,
  history: readonly ProgressHistoryItem[],
): ProgressWorkout[] {
  const targetUnit = unitOf(profile);
  const deleted = profile.deleted?.workouts ?? {};
  const byKey = new Map<string, ProgressWorkout>();

  for (const item of history) {
    const original = item?.workout;
    if (!original) continue;
    const key = workoutKey(original);
    if (deleted[key]) continue;

    let workout: Workout;
    if (item.unit === targetUnit) {
      workout = original;
    } else {
      // `inProfileUnit` reads a QueuedWorkout and needs a key for its conversions.
      // Inject one only for the conversion and keep the caller's object untouched.
      workout = inProfileUnit(
        { unit: item.unit, workout: { ...original, id: original.id ?? key } },
        targetUnit,
      );
    }

    const at = numberOf(workoutAt(workout));
    const day = workoutDay(workout);
    const candidate: ProgressWorkout = {
      key,
      workout,
      unit: targetUnit,
      original,
      originalUnit: item.unit,
      pending: item.pending === true,
      at: at ?? Number.NaN,
      day: typeof day === 'string' ? day : null,
    };

    const current = byKey.get(key);
    byKey.set(key, current ? preferredRecord(candidate, current) : candidate);
  }

  const timeOf = (item: ProgressWorkout) => (Number.isFinite(item.at) ? item.at : Number.POSITIVE_INFINITY);
  return [...byKey.values()].sort((a, b) => {
    const delta = timeOf(a) - timeOf(b);
    if (delta !== 0) return delta;
    return a.key.localeCompare(b.key);
  });
}

/** The meaning a dumbbell weight is read in for this exercise right now. */
export function currentMeaning(profile: Profile, exerciseId: string): 'as' | 'each' | 'total' {
  const mode = dbLoadOf(currentDbLoad(profile, exerciseId));
  return mode === 'each' || mode === 'total' ? mode : 'as';
}

/**
 * One workout with this exercise's weights read in the exercise's current meaning,
 * so "20 each" and "40 total" land on the same scale. Other entries are untouched.
 */
export function workoutInMeaning(
  profile: Profile,
  workout: Workout,
  exerciseId: string,
): Workout {
  return workoutAs(workout, exerciseId, currentMeaning(profile, exerciseId)) as Workout;
}

/** The stored workout and unit a source tap should open. */
export function sourceOf(item: ProgressWorkout): WorkoutSource {
  return sourceFrom(item, item.at, item.day ?? '');
}

export function sourceFrom(item: ProgressWorkout, at: number, date: string): WorkoutSource {
  return {
    key: item.key,
    workout: item.original,
    unit: item.originalUnit,
    pending: item.pending,
    date,
    at,
  };
}
