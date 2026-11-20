import { cleanupSg, supersetUnits } from '../../frontend/src/lib/history';
import type { RoutineExercise } from './training';

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

/**
 * The Web routine editor's slot rule (RoutineEdit.jsx `reorderRoutineUnit`): the source unit is
 * removed first and the target slot is counted among the remaining units, so a superset can never
 * be split. Returns the new order of the original exercise indexes, or null when the drop is the
 * source position.
 */
export function reorderRoutineUnitOrder(
  units: number[][],
  sourcePosition: number,
  targetSlot: number,
) {
  if (!Array.isArray(units) || sourcePosition < 0 || sourcePosition >= units.length) return null;
  const remaining = units.filter((_, position) => position !== sourcePosition);
  const slot = clamp(Number.isFinite(targetSlot) ? Math.trunc(targetSlot) : sourcePosition, 0, remaining.length);
  if (slot === sourcePosition) return null;
  const order = remaining.flatMap(unit => unit);
  const insertAt = remaining.slice(0, slot).reduce((count, unit) => count + unit.length, 0);
  order.splice(insertAt, 0, ...units[sourcePosition]);
  return order;
}

/**
 * Move the whole unit (one exercise, or a contiguous superset) containing `sourceIndex` to
 * `targetSlot`. Like the Web helper it works on a copy and cleans superset ids that lost their
 * adjacent partner.
 */
export function reorderRoutineUnits(
  exercises: RoutineExercise[],
  sourceIndex: number,
  targetSlot: number,
): RoutineExercise[] | null {
  if (!Array.isArray(exercises) || exercises.length === 0) return null;
  const units = supersetUnits(exercises);
  const sourcePosition = units.findIndex(unit => unit.includes(sourceIndex));
  if (sourcePosition < 0) return null;
  const order = reorderRoutineUnitOrder(units, sourcePosition, targetSlot);
  if (!order) return null;
  const next = order.map(index => ({ ...exercises[index] }));
  cleanupSg(next);
  return next;
}
