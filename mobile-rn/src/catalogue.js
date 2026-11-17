import { EXDB, EXALIAS } from '../../frontend/src/lib/exercises-data.js';
import chineseNames from '../../frontend/src/exercise-names/zh.js';

const exercises = new Map(EXDB.map(exercise => [exercise.id, exercise]));

/** @param {string} id */
export function catalogueName(id) {
  const canonical = EXALIAS[id] ?? id;
  return chineseNames[canonical] ?? exercises.get(canonical)?.n ?? id;
}

/** @param {string} id */
export function catalogueCardio(id) {
  return exercises.get(EXALIAS[id] ?? id)?.bp === 'cardio';
}

/** @param {string} id */
export function catalogueHas(id) {
  return exercises.has(EXALIAS[id] ?? id);
}

export function searchCatalogue(query) {
  const results = [];
  for (const exercise of EXDB) {
    if (exercise.n.toLowerCase().includes(query) || (chineseNames[exercise.id] ?? '').includes(query)) {
      results.push({ id: exercise.id, name: catalogueName(exercise.id), cardio: exercise.bp === 'cardio' });
      if (results.length === 30) break;
    }
  }
  return results;
}
