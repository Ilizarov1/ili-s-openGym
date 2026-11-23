// The pure matcher bridge between the shared AI matcher and the library's
// unfiltered pool. Split from ai-search.ts so an offline evaluation can load
// this module without the controller's Expo, SQLite or session dependencies;
// everything else there (the controller, the image session) is untouched.
import { createExerciseAiSearch } from '../../../frontend/src/lib/exercise-ai-search.js';
import type { AiSearchItem, AiSearchMatch } from './ai-search';
import type { LibraryExercise, LibrarySearch } from '../librarySearch';

export const AI_SEARCH_DISPLAY_LIMIT = 10;

const BODY_PART_LABELS: Record<string, string> = {
  back: '背部',
  cardio: '有氧',
  chest: '胸部',
  'full body': '全身',
  'lower arms': '前臂',
  'lower legs': '小腿',
  neck: '颈部',
  shoulders: '肩部',
  'upper arms': '手臂',
  'upper legs': '大腿',
  waist: '腰腹',
};

const EQUIPMENT_LABELS: Record<string, string> = {
  machine: '器械',
  'leverage machine': '杠杆器械',
  'body weight': '自重',
  barbell: '杠铃',
  dumbbell: '哑铃',
  cable: '绳索',
  band: '弹力带',
  'resistance band': '阻力带',
  kettlebell: '壶铃',
  weighted: '负重',
  'suspension trainer': '悬挂带',
  'smith machine': '史密斯机',
  'stability ball': '瑞士球',
  'medicine ball': '药球',
  'ez barbell': 'EZ 杠铃',
  roller: '泡沫轴',
  'sled machine': '雪橇机',
  'massage ball': '按摩球',
  'weight plate': '杠铃片',
  rope: '战绳',
  assisted: '辅助器械',
  landmine: '地雷架',
  'bosu ball': '波速球',
  sandbag: '沙袋',
  'trap bar': '六角杠铃',
  'olympic barbell': '奥杆',
  'stationary bike': '固定单车',
  'elliptical machine': '椭圆机',
  'wheel roller': '健腹轮',
  macebell: '锤铃',
  tire: '轮胎',
  'upper body ergometer': '上肢功率车',
  'skierg machine': '滑雪机',
  hammer: '锤子',
  'stepmill machine': '台阶机',
  other: '其他',
};

type StructuredCandidate = {
  name?: unknown;
  nameEn?: unknown;
  bodyPart?: unknown;
  equipment?: unknown;
};

function unwrapStructuredCandidates(structured: unknown): StructuredCandidate[] {
  if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return [];
  const obj = structured as { candidates?: unknown; structured?: unknown };
  const inner = obj.structured && typeof obj.structured === 'object' && !Array.isArray(obj.structured)
    ? obj.structured as { candidates?: unknown }
    : obj;
  return Array.isArray(inner.candidates)
    ? inner.candidates.filter((item): item is StructuredCandidate => !!item && typeof item === 'object')
    : [];
}

function formatExpandedRationale(prefix: string, exercise: LibraryExercise): string {
  const bp = exercise.bodyPart ? (BODY_PART_LABELS[exercise.bodyPart] ?? exercise.bodyPart) : '';
  const eq = exercise.equipment ? (EQUIPMENT_LABELS[exercise.equipment] ?? exercise.equipment) : '';
  const tags = [bp, eq].filter(Boolean).join(' · ');
  return tags ? `${prefix} · ${tags}` : prefix;
}

/**
 * Expand a base AI match up to `maxItems` (default 10) while keeping primary
 * hits, order, and confidence untouched. Never forces filler items when both
 * matched items and model candidates are empty (e.g. fallback-only / non-gym).
 */
export function expandAiSearchMatch(
  source: LibrarySearch,
  structured: unknown,
  hintText: string,
  base: AiSearchMatch,
  maxItems = AI_SEARCH_DISPLAY_LIMIT,
): AiSearchMatch {
  const candidates = unwrapStructuredCandidates(structured);
  if (maxItems <= base.items.length || (base.items.length === 0 && candidates.length === 0)) {
    return base;
  }

  const items: AiSearchItem[] = [...base.items];
  const seen = new Set(items.map(item => item.exerciseId));

  // (a) Secondary recall pool from model candidate names and user hintText.
  const queries: string[] = [];
  const querySeen = new Set<string>();
  const addQuery = (raw: unknown) => {
    const q = typeof raw === 'string' ? raw.trim() : '';
    if (!q || querySeen.has(q)) return;
    querySeen.add(q);
    queries.push(q);
  };
  for (const candidate of candidates) {
    addQuery(candidate.name);
    addQuery(candidate.nameEn);
  }
  addQuery(hintText);

  const scoredById = new Map<string, { exercise: LibraryExercise; score: number }>();
  for (const query of queries) {
    const hits = source.aiSearch.searchScored(query) || [];
    for (const hit of hits) {
      if (!hit?.exercise || seen.has(hit.exercise.id) || !(hit.score > 0)) continue;
      const existing = scoredById.get(hit.exercise.id);
      if (!existing || hit.score > existing.score) {
        scoredById.set(hit.exercise.id, { exercise: hit.exercise, score: hit.score });
      }
    }
  }

  const secondaryPool = [...scoredById.values()].sort(
    (a, b) => b.score - a.score || a.exercise.name.localeCompare(b.exercise.name),
  );
  for (const entry of secondaryPool) {
    if (items.length >= maxItems) break;
    seen.add(entry.exercise.id);
    items.push({
      exerciseId: entry.exercise.id,
      name: entry.exercise.name,
      rationale: formatExpandedRationale('相近匹配', entry.exercise),
      level: 'low',
    });
  }

  // (b) Dimension fallback pool: (bodyPart + equipment) -> bodyPart -> equipment.
  if (items.length < maxItems) {
    const targetBodyParts = new Set<string>();
    const targetEquipments = new Set<string>();
    for (const bp of base.fallback?.bodyParts ?? []) {
      if (typeof bp === 'string' && bp.trim()) targetBodyParts.add(bp.trim());
    }
    for (const eq of base.fallback?.equipment ?? []) {
      if (typeof eq === 'string' && eq.trim()) targetEquipments.add(eq.trim());
    }
    for (const candidate of candidates) {
      if (typeof candidate.bodyPart === 'string' && candidate.bodyPart.trim()) {
        targetBodyParts.add(candidate.bodyPart.trim());
      }
      if (typeof candidate.equipment === 'string' && candidate.equipment.trim()) {
        targetEquipments.add(candidate.equipment.trim());
      }
    }

    if (targetBodyParts.size > 0 || targetEquipments.size > 0) {
      const bothTier: LibraryExercise[] = [];
      const bpTier: LibraryExercise[] = [];
      const eqTier: LibraryExercise[] = [];
      for (const exercise of source.aiSearch.pool) {
        if (seen.has(exercise.id)) continue;
        const bpMatch = targetBodyParts.has(exercise.bodyPart);
        const eqMatch = targetEquipments.has(exercise.equipment);
        if (bpMatch && eqMatch) bothTier.push(exercise);
        else if (bpMatch) bpTier.push(exercise);
        else if (eqMatch) eqTier.push(exercise);
      }
      const appendTier = (list: LibraryExercise[], prefix: string) => {
        for (const exercise of list) {
          if (items.length >= maxItems) break;
          if (seen.has(exercise.id)) continue;
          seen.add(exercise.id);
          items.push({
            exerciseId: exercise.id,
            name: exercise.name,
            rationale: formatExpandedRationale(prefix, exercise),
            level: 'low',
          });
        }
      };
      appendTier(bothTier, '按部位/器械补充');
      appendTier(bpTier, '按部位补充');
      appendTier(eqTier, '按器械补充');
    }
  }

  return { ...base, items };
}

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
  options?: { maxItems?: number },
): AiSearchMatch {
  const base = matcherFor(source).match({ structured }, { hintText, diagnostics });
  const targetLimit = options?.maxItems ?? 5;
  return expandAiSearchMatch(source, structured, hintText, base, targetLimit);
}
