import { cleanupSg, pairAdjacent, supersetUnits, unpairSuperset } from '../../frontend/src/lib/history';
import { restSecFor } from '../../frontend/src/lib/supersetFlow';
import type { Draft, RoutineExercise } from './training';

export function exerciseUnits(exercises: Pick<RoutineExercise, 'sg'>[]): number[][] {
  return supersetUnits(exercises);
}

export function changeSuperset(exercises: RoutineExercise[], index: number, grouped: boolean): RoutineExercise[] {
  const next = grouped ? unpairSuperset(exercises, index) : pairAdjacent(exercises, index - 1, index);
  cleanupSg(next);
  return next;
}

type NextSet = { exerciseIndex: number; setIndex: number; round: number | null };

export function nextSupersetSet(draft: Draft, unit: number[]): NextSet | undefined {
  let next: NextSet | undefined;
  for (const exerciseIndex of unit) {
    const sets = draft.exercises[exerciseIndex].sets;
    const warmup = sets.findIndex(set => set.warmup && set.at === null);
    if (warmup !== -1) return { exerciseIndex, setIndex: warmup, round: null };
    let round = 0;
    for (const [setIndex, set] of sets.entries()) {
      if (set.warmup) continue;
      if (set.at === null) {
        if (!next || (next.round !== null && round < next.round)) next = { exerciseIndex, setIndex, round };
        break;
      }
      round++;
    }
  }
  return next;
}

export function supersetRestSeconds(draft: Draft, unit: number[], completedRound: number, fallback: number) {
  if (nextSupersetSet(draft, unit)?.round === completedRound) return 0;
  return restSecFor(draft.exercises, unit, fallback);
}
