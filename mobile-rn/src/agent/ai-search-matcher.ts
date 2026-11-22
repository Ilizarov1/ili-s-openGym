// The pure matcher bridge between the shared AI matcher and the library's
// unfiltered pool. Split from ai-search.ts so an offline evaluation can load
// this module without the controller's Expo, SQLite or session dependencies;
// everything else there (the controller, the image session) is untouched.
import { createExerciseAiSearch } from '../../../frontend/src/lib/exercise-ai-search.js';
import type { AiSearchMatch } from './ai-search';
import type { LibraryExercise, LibrarySearch } from '../librarySearch';

/** Diagnostics the shared matcher records while matching; production passes only `emit`. */
export type AiSearchDiagnostics = {
  emit: (event: Record<string, unknown>) => void;
  evaluation?: { expectedIds: string[]; includeQueries: boolean };
};

type SharedMatcher = {
  match: (
    output: unknown,
    hints?: { hintText?: string; diagnostics?: AiSearchDiagnostics },
  ) => AiSearchMatch;
};

const matchers = new WeakMap<object, SharedMatcher>();

export function matcherFor(source: LibrarySearch): SharedMatcher {
  const cached = matchers.get(source);
  if (cached) return cached;
  const factory = createExerciseAiSearch as unknown as (options: {
    searchScored: (list: LibraryExercise[], query: string) => { exercise: LibraryExercise; score: number }[];
    list: LibraryExercise[];
    bodyPartValues: string[];
    equipmentValues: string[];
    isPublicExercise: (exercise: LibraryExercise) => boolean;
  }) => SharedMatcher;
  const matcher = factory({
    searchScored: (list, query) => source.aiSearch.searchScored(query)
      .filter(hit => list.includes(hit.exercise)),
    list: source.aiSearch.pool,
    bodyPartValues: source.aiSearch.bodyPartValues,
    equipmentValues: source.aiSearch.equipmentValues,
    // Trusted public entries are the catalogue pool only: a custom exercise is
    // never reported as a public id, even when its id matches a public range.
    isPublicExercise: exercise => exercise.custom === false,
  });
  matchers.set(source, matcher);
  return matcher;
}

/** Match the task's structured candidates against the same unfiltered pool. */
export function matchAiSearch(
  source: LibrarySearch,
  structured: unknown,
  hintText: string,
  diagnostics?: AiSearchDiagnostics,
): AiSearchMatch {
  return matcherFor(source).match({ structured }, { hintText, diagnostics });
}
