import { beatsWeight } from '../../../frontend/src/lib/exercises';
import { bestWeightFor, bestWeightForEntry, sessionVolume, setsDone, workSetsDone } from '../../../frontend/src/lib/history';
import { formulaOf, is1RMRecord } from '../../../frontend/src/lib/onerm';
import { workoutKey, type Profile, type Workout } from '../training';

export type WorkoutSummary = {
  durationMs: number;
  volume: number;
  /** Completed set units, both sides of a per-side row counted separately. */
  sets: number;
  /** Completed work sets, warm-ups left out. */
  workSets: number;
  /** Exercises whose top work weight beat everything saved before this session. */
  weightPrs: string[];
  /** Exercises with a heavier estimated 1RM than anything saved before this session. */
  oneRmPrs: { id: string; est: number }[];
};

/**
 * The numbers the finish summary shows, computed against the history saved before
 * this session. Weight PRs follow the Web's `beatsWeight` (assistance machines
 * count a lower load as better) and estimated 1RMs come from the same formulas the
 * Progress screen reads, so the summary never disagrees with a record card.
 */
export function workoutSummary(
  profile: Profile,
  workout: Workout,
  prior: readonly Workout[],
): WorkoutSummary {
  const before = [...prior].filter(item => item && workoutKey(item) !== workoutKey(workout));
  const history: Profile = { ...profile, workouts: before };
  const seen = new Set<string>();
  const weightPrs: string[] = [];
  const oneRmPrs: { id: string; est: number }[] = [];

  for (const entry of workout.entries ?? []) {
    if (!entry?.id) continue;
    const top = bestWeightForEntry(entry);
    if (top > 0 && beatsWeight(entry.id, top, bestWeightFor(history, entry.id, entry.target?.dbLoad ?? undefined))) {
      weightPrs.push(entry.id);
    }
    const record = is1RMRecord(history, entry.id, entry, formulaOf(profile));
    if (record && !weightPrs.includes(entry.id) && !seen.has(entry.id)) {
      oneRmPrs.push({ id: entry.id, est: Math.round(record.est * 10) / 10 });
      seen.add(entry.id);
    }
  }

  return {
    durationMs: Math.max(0, Number(workout.end) - Number(workout.start) || 0),
    volume: sessionVolume(workout, profile),
    sets: setsDone(workout),
    workSets: workSetsDone(workout),
    weightPrs,
    oneRmPrs,
  };
}
