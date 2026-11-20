import { exerciseAliases } from '../../frontend/src/lib/exercise-aliases.js';
import { createExerciseSearch, isOneLimbExercise } from '../../frontend/src/lib/exercise-search.js';
import V13_IDS from '../../frontend/src/lib/catalogue-v13-ids.json';
import {
  BODY_PART_NAMES,
  EQUIPMENT_NAMES,
  SEARCH_LIMIT,
  TARGET_MUSCLE_NAMES,
  catalogueEntries,
  catalogueName,
} from './catalogueData';
import type { CustomExercise, Profile } from './training';

type CatalogueRecord = {
  id: string;
  n?: string;
  bp?: string;
  eq?: string;
  tg?: string;
  sm?: string[];
  cat?: string;
  desc?: string;
  aliases?: string[];
  custom?: boolean;
};

/** One built-in or custom exercise, ready for the shared search engine and the list row. */
export type LibraryExercise = {
  id: string;
  /** Localized name shown in the list. */
  name: string;
  /** Saved text aliases (normalized), already merged from the profile. */
  aliases: string[];
  /** Original English catalogue name; absent on custom exercises. */
  n?: string;
  bp?: string;
  eq?: string;
  tg?: string;
  sm?: string[];
  cat?: string;
  desc?: string;
  bodyPart: string;
  equipment: string;
  target: string;
  cardio: boolean;
  custom: boolean;
  customExercise?: CustomExercise;
};

export type LibraryFilters = {
  bodyPart: string | null;
  equipment: string | null;
  targetMuscle: string | null;
  oneLimb: boolean;
  favouritesOnly: boolean;
};

export type LibrarySearchResult = {
  items: LibraryExercise[];
  total: number;
  suggestions: LibraryExercise[];
};

const LABELS: Record<string, string> = {
  ...BODY_PART_NAMES,
  ...EQUIPMENT_NAMES,
  ...TARGET_MUSCLE_NAMES,
};

const translateLabel = (value: string) => LABELS[value] ?? value;

function customName(exercise: CustomExercise): string {
  return exercise.n ?? exercise.name ?? exercise.id;
}

/** A queryable fallback index over the current filter pool. */
export type SuggestionIndex = {
  search: (query: string, limit: number) => LibraryExercise[];
};

/** Builds the fallback index lazily; RN supplies Fuse, tests can supply a stub. */
export type SuggestionIndexFactory = (pool: LibraryExercise[]) => SuggestionIndex;

/** The search engine and suggestion index for one profile snapshot. */
export type LibrarySearch = {
  search: (
    query: string,
    filters: LibraryFilters,
    limit?: number,
  ) => LibrarySearchResult;
};

const MAX_SUGGESTIONS = 3;
const SUGGESTION_MIN_HAN = 4;

/**
 * Build the candidate pool once per profile. The caller should memoize this by
 * `profile`: a sync or custom-exercise edit replaces the profile object and
 * refreshes names, aliases and suggestions together.
 */
export function createLibrarySearch(
  profile: Profile,
  createSuggestionIndex?: SuggestionIndexFactory,
): LibrarySearch {
  const aliasMap =
    profile.exAliases && typeof profile.exAliases === 'object' && !Array.isArray(profile.exAliases)
      ? profile.exAliases as Record<string, unknown>
      : {};

  const aliasesFor = (id: string, own?: unknown): string[] =>
    exerciseAliases({ id, aliases: own }, aliasMap) as string[];

  const customExercises = (profile.customEx ?? []).filter(
    (exercise): exercise is CustomExercise =>
      !!exercise && typeof exercise.id === 'string',
  );

  const candidates: LibraryExercise[] = [
    ...customExercises.map(exercise => {
      const name = customName(exercise);
      return {
        id: exercise.id,
        name,
        aliases: aliasesFor(exercise.id, exercise.aliases),
        n: name,
        bp: exercise.bp,
        eq: exercise.eq,
        tg: exercise.tg,
        cat: exercise.cat,
        desc: exercise.desc,
        bodyPart: exercise.bp ?? '',
        equipment: exercise.eq ?? '',
        target: exercise.tg ?? '',
        cardio: exercise.bp === 'cardio',
        custom: true,
        customExercise: exercise,
      };
    }),
    ...(catalogueEntries() as CatalogueRecord[]).map(record => {
      const name = catalogueName(record.id);
      return {
        id: record.id,
        name,
        aliases: aliasesFor(record.id, record.aliases),
        n: record.n,
        bp: record.bp,
        eq: record.eq,
        tg: record.tg,
        sm: record.sm,
        cat: record.cat,
        desc: record.desc,
        bodyPart: record.bp ?? '',
        equipment: record.eq ?? '',
        target: record.tg ?? '',
        cardio: record.bp === 'cardio',
        custom: false,
      };
    }),
  ];

  const favouriteIds = new Set(
    Array.isArray(profile.favEx) ? profile.favEx.filter((id): id is string => typeof id === 'string') : [],
  );

  const engine = createExerciseSearch({
    nameText: exercise => {
      const item = exercise as LibraryExercise;
      return item.custom ? item.name : `${item.name} ${item.n ?? ''}`;
    },
    aliasesOf: exercise => (exercise as LibraryExercise).aliases,
    translate: translateLabel,
    classicIds: V13_IDS as string[],
  });

  const filterPool = (filters: LibraryFilters): LibraryExercise[] =>
    candidates.filter(exercise => {
      if (filters.favouritesOnly && !favouriteIds.has(exercise.id)) return false;
      if (filters.bodyPart && exercise.bp !== filters.bodyPart) return false;
      if (filters.equipment && exercise.eq !== filters.equipment) return false;
      if (filters.targetMuscle && exercise.tg !== filters.targetMuscle) return false;
      if (filters.oneLimb && !isOneLimbExercise(exercise)) return false;
      return true;
    });

  const filterKey = (filters: LibraryFilters): string =>
    JSON.stringify([
      filters.bodyPart,
      filters.equipment,
      filters.targetMuscle,
      filters.oneLimb,
      filters.favouritesOnly,
      filters.favouritesOnly ? [...favouriteIds].sort() : null,
    ]);

  const suggestionIndexes = new Map<string, SuggestionIndex>();

  const suggestionsFor = (
    query: string,
    pool: LibraryExercise[],
    filters: LibraryFilters,
  ): LibraryExercise[] => {
    const han = query.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
    if (!createSuggestionIndex || han < SUGGESTION_MIN_HAN || pool.length === 0) return [];

    const key = filterKey(filters);
    let index = suggestionIndexes.get(key);
    if (!index) {
      if (suggestionIndexes.size >= 12) suggestionIndexes.clear();
      index = createSuggestionIndex(pool);
      suggestionIndexes.set(key, index);
    }

    const seen = new Set<string>();
    const out: LibraryExercise[] = [];
    for (const exercise of index.search(query, 12)) {
      if (seen.has(exercise.id)) continue;
      seen.add(exercise.id);
      out.push(exercise);
      if (out.length === MAX_SUGGESTIONS) break;
    }
    return out;
  };

  return {
    search(query, filters, limit = SEARCH_LIMIT) {
      const pool = filterPool(filters);
      const effectiveQuery = query.trim();
      let items: LibraryExercise[];

      if (!effectiveQuery) {
        const favourites = pool.filter(exercise => favouriteIds.has(exercise.id));
        items = favouriteIds.size
          ? [...favourites, ...pool.filter(exercise => !favouriteIds.has(exercise.id))]
          : pool;
      } else {
        items = engine.searchExercises(pool, effectiveQuery);
      }

      const total = items.length;
      const page = limit > 0 ? items.slice(0, Math.floor(limit)) : items;
      return {
        items: page,
        total,
        suggestions: total === 0 ? suggestionsFor(effectiveQuery, pool, filters) : [],
      };
    },
  };
}
