/**
 * Estimated 1RM projection.
 *
 * The formulas and every rejection rule live upstream in
 * `frontend/src/lib/onerm.js`: Epley is the default, an unknown or absent
 * `oneRmFormula` falls back to it, a non-weighted estimate refuses more than
 * REP_CAP reps, the weighted ensemble adds recorded RIR and refuses more than
 * WEIGHTED_REP_CAP effective reps, and assistance machines are excluded.
 *
 * This module only supplies RN's normalised history shape: tombstones removed,
 * one record per workout key, weights read in the exercise's current dumbbell
 * meaning, and one best point per workout.
 */

import {
  bestSetOf,
  DEFAULT_FORMULA,
  FORMULA_NAMES,
  formulaOf,
  estimate1RM,
  REP_CAP,
  WEIGHTED_REP_CAP,
} from '../../../frontend/src/lib/onerm';
import { metricRowsForEntry } from '../../../frontend/src/lib/history';
import { isSideSet } from '../../../frontend/src/lib/workout-model';
import type { LoggedSet, Profile, Workout, WorkoutEntry } from '../training';
import { normalizeHistory, sourceFrom, workoutInMeaning } from './history';
import { exerciseAssisted, entryAssisted } from './records';
import type {
  OneRmFormula,
  OneRmPoint,
  OneRmProjection,
  ProgressHistoryItem,
  ProgressWorkout,
} from './types';
import { noonOf } from './dates';

type BestSet = { est: number; w: number; r: number };

type EstimateOneRm = (
  weight: number,
  reps: number,
  formula?: string,
  rir?: number | null,
) => number | null;

// The upstream module is plain JS; pin the optional RIR argument so a row's numeric
// rating is accepted (the default `null` alone would reject it).
const estimateOneRm = estimate1RM as unknown as EstimateOneRm;

const FORMULA_VALUES: OneRmFormula[] = [
  'epley',
  'brzycki',
  'lombardi',
  'oconner',
  'mayhew',
  'wathan',
  'lander',
  'weighted',
];

function asFormula(value: unknown): OneRmFormula {
  return typeof value === 'string' && (FORMULA_VALUES as string[]).includes(value)
    ? (value as OneRmFormula)
    : DEFAULT_FORMULA;
}

/** A narrow shape for upstream `bestSetOf`'s result, which is plain JS. */
function asBestSet(value: unknown): BestSet | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { est?: unknown; w?: unknown; r?: unknown };
  const est = Number(raw.est);
  const w = Number(raw.w);
  const r = Number(raw.r);
  if (!Number.isFinite(est) || !Number.isFinite(w) || !Number.isFinite(r)) return null;
  if (est <= 0 || w <= 0 || r < 1) return null;
  return { est, w, r };
}

function entriesOf(workout: Workout, exerciseId: string): WorkoutEntry[] {
  return (workout.entries ?? []).filter(entry => entry?.id === exerciseId);
}

/** The reps-mode rows that can be a 1RM source, including per-side rows. */
function rowsOf(entry: WorkoutEntry): LoggedSet[] {
  const rows = metricRowsForEntry(entry, 'reps');
  return Array.isArray(rows) ? (rows as LoggedSet[]) : [];
}

/** Find the row that produced `best`, only for the source index in the UI. */
function sourceRowOf(entry: WorkoutEntry, best: BestSet, formula: OneRmFormula): number | null {
  const rows = rowsOf(entry);
  for (let index = 0; index < rows.length; index++) {
    const set = rows[index];
    const parts = isSideSet(set)
      ? [set.sides?.L, set.sides?.R].filter((side): side is LoggedSet => side != null && side.done === true)
      : [set];
    for (const part of parts) {
      if (Number(part.w) !== best.w || Math.round(Number(part.r)) !== best.r) continue;
      const estimate = Number(estimateOneRm(Number(part.w), Number(part.r), formula, part.rir ?? null));
      if (Number.isFinite(estimate) && estimate === best.est) return index;
    }
  }
  return null;
}

function pointTime(item: ProgressWorkout): number {
  if (Number.isFinite(item.at)) return item.at;
  if (item.day) {
    const noon = noonOf(item.day).getTime();
    if (Number.isFinite(noon)) return noon;
  }
  return Number.NaN;
}

function projectionFromWorkouts(
  profile: Profile,
  workouts: readonly ProgressWorkout[],
  exerciseId: string,
): OneRmProjection {
  const formula = asFormula(formulaOf(profile));
  const assisted = exerciseAssisted(profile, workouts, exerciseId);

  const points: OneRmPoint[] = [];
  for (const item of workouts) {
    const workout = workoutInMeaning(profile, item.workout, exerciseId);
    let best: BestSet | null = null;
    let bestEntry: WorkoutEntry | null = null;

    for (const entry of entriesOf(workout, exerciseId)) {
      if (entryAssisted(profile, exerciseId, entry)) continue;
      const candidate = asBestSet(bestSetOf(entry, formula));
      if (!candidate) continue;
      if (!best || candidate.est > best.est) {
        best = candidate;
        bestEntry = entry;
      }
    }

    if (!best) continue;
    const at = pointTime(item);
    points.push({
      value: best.est,
      weight: best.w,
      reps: best.r,
      formula,
      source: sourceFrom(item, at, item.day ?? ''),
      entryIndex: bestEntry ? workout.entries.indexOf(bestEntry) : -1,
      setIndex: bestEntry ? sourceRowOf(bestEntry, best, formula) : null,
    });
  }

  let bestPoint: OneRmPoint | null = null;
  for (const point of points) {
    if (!bestPoint || point.value > bestPoint.value) bestPoint = point;
  }

  return { formula, points, best: bestPoint, assisted };
}

/** The all-time 1RM curve, one point per workout with an estimable completed set. */
export function oneRmProjection(
  profile: Profile,
  history: readonly ProgressHistoryItem[],
  exerciseId: string,
): OneRmProjection {
  return projectionFromWorkouts(profile, normalizeHistory(profile, history), exerciseId);
}

/** Same projection when the caller already normalised the history once. */
export function oneRmProjectionFromWorkouts(
  profile: Profile,
  workouts: readonly ProgressWorkout[],
  exerciseId: string,
): OneRmProjection {
  return projectionFromWorkouts(profile, workouts, exerciseId);
}

/** The formula name shown next to the card. Proper names stay in their own script. */
export function oneRmFormulaLabel(formula: OneRmFormula): string {
  if (formula === 'weighted') return '综合加权';
  const name = FORMULA_NAMES[formula];
  return typeof name === 'string' && name ? name : 'Epley';
}

export { REP_CAP, WEIGHTED_REP_CAP };
