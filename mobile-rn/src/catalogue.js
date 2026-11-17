import { EXDB, EXALIAS } from '../../frontend/src/lib/exercises-data.js';
import { sortFavouritesFirst } from '../../frontend/src/lib/favourites.js';
import chineseNames from '../../frontend/src/exercise-names/zh.js';
import contentData from './catalogueContent.generated.json';
import { CATALOGUE_CLIPS, CATALOGUE_STILL } from './catalogueMedia.generated';

const exercises = new Map(EXDB.map(exercise => [exercise.id, exercise]));

/** Number of animated catalogue exercises. */
export const CATALOGUE_COUNT = EXDB.length;

/**
 * Body parts in the order the library chips show them: the big lifting groups
 * first, then the smaller ones, cardio and full-body last.
 */
export const BODY_PARTS = [
  'chest',
  'back',
  'upper legs',
  'lower legs',
  'shoulders',
  'upper arms',
  'lower arms',
  'waist',
  'neck',
  'cardio',
  'full body',
];

export const BODY_PART_NAMES = {
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

/**
 * Equipment values that occur in the catalogue, most common first. Values the
 * catalogue adds later still work in `searchCatalogue`, they just fall back to
 * their English name until the map below learns a translation.
 */
export const EQUIPMENT = [
  'body weight',
  'dumbbell',
  'cable',
  'barbell',
  'leverage machine',
  'band',
  'kettlebell',
  'resistance band',
  'weighted',
  'suspension trainer',
  'smith machine',
  'stability ball',
  'medicine ball',
  'ez barbell',
  'roller',
  'sled machine',
  'massage ball',
  'weight plate',
  'rope',
  'assisted',
  'landmine',
  'bosu ball',
  'sandbag',
  'trap bar',
  'olympic barbell',
  'stationary bike',
  'elliptical machine',
  'wheel roller',
  'macebell',
  'tire',
  'upper body ergometer',
  'skierg machine',
  'hammer',
  'stepmill machine',
  'other',
];

export const EQUIPMENT_NAMES = {
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

/**
 * The catalogue entry behind an exercise id, resolving female/male drawing aliases.
 * @param {string} id
 */
export function catalogueExercise(id) {
  return exercises.get(EXALIAS[id] ?? id) ?? null;
}

/** Text and muscle names bundled for the RN detail screen. */
export function catalogueContent(id) {
  return contentData[EXALIAS[id] ?? id] ?? null;
}

/** A bundled 180 px still, or null when this build did not include it. */
export function catalogueStill(id) {
  return CATALOGUE_STILL[EXALIAS[id] ?? id] ?? null;
}

/** A bundled 180 px animation staged under Android assets, or null. */
export function catalogueClip(id) {
  const path = CATALOGUE_CLIPS[EXALIAS[id] ?? id];
  return path ? `asset:///${path}` : null;
}

/** @param {string} value */
export function bodyPartName(value) {
  return BODY_PART_NAMES[value] ?? value;
}

/** @param {string} value */
export function equipmentName(value) {
  return EQUIPMENT_NAMES[value] ?? value;
}

export const SEARCH_LIMIT = 100;

function matches(exercise, term) {
  return !term || exercise.n.toLowerCase().includes(term) || catalogueName(exercise.id).toLowerCase().includes(term);
}

/**
 * Search the animated catalogue by name, optionally narrowed by the exact
 * `bp` body part and `eq` equipment values stored in `EXDB`.
 *
 * Favourites always float to the top of whatever the filters left, before the
 * page is cut at `limit`: a favourite that happens to sit at the end of the
 * catalogue is still on the first page (issue #6). The filtering, ordering and
 * counting therefore all run over the whole match set.
 *
 * @param {string} [query]
 * @param {string} [bodyPart]
 * @param {string} [equipment]
 * @param {number} [limit]
 * @param {{ favourites?: string[], favouritesOnly?: boolean }} [options]
 * @returns {{ id: string, name: string, bodyPart: string, equipment: string, cardio: boolean }[]}
 */
export function searchCatalogue(query, bodyPart, equipment, limit = SEARCH_LIMIT, options = {}) {
  if (limit && typeof limit === 'object') {
    options = limit;
    limit = SEARCH_LIMIT;
  }
  const term = (query ?? '').trim().toLowerCase();
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : SEARCH_LIMIT;
  const favourites = Array.isArray(options.favourites) ? options.favourites : [];
  const favouriteSet = new Set(favourites);
  const results = [];
  for (const exercise of EXDB) {
    if (options.favouritesOnly === true && !favouriteSet.has(exercise.id)) continue;
    if (bodyPart && exercise.bp !== bodyPart) continue;
    if (equipment && exercise.eq !== equipment) continue;
    if (!matches(exercise, term)) continue;
    results.push({
      id: exercise.id,
      name: catalogueName(exercise.id),
      bodyPart: exercise.bp,
      equipment: exercise.eq,
      cardio: exercise.bp === 'cardio',
    });
  }
  const ordered = favourites.length ? sortFavouritesFirst(results, { favEx: favourites }) : results;
  return ordered.slice(0, max);
}

/**
 * Total matches for the same query/filters, without building the result list.
 * Lets the library show an honest count while the list itself stays paged.
 * Uses the same favourite filter as `searchCatalogue`, so the two never
 * disagree.
 *
 * @param {string} [query]
 * @param {string} [bodyPart]
 * @param {string} [equipment]
 * @param {{ favourites?: string[], favouritesOnly?: boolean }} [options]
 */
export function countCatalogue(query, bodyPart, equipment, options = {}) {
  const term = (query ?? '').trim().toLowerCase();
  const favourites = Array.isArray(options.favourites) ? options.favourites : [];
  const favouriteSet = new Set(favourites);
  let count = 0;
  for (const exercise of EXDB) {
    if (options.favouritesOnly === true && !favouriteSet.has(exercise.id)) continue;
    if (bodyPart && exercise.bp !== bodyPart) continue;
    if (equipment && exercise.eq !== equipment) continue;
    if (!matches(exercise, term)) continue;
    count += 1;
  }
  return count;
}
