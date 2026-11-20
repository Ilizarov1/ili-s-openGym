import { EXDB, EXALIAS } from '../../frontend/src/lib/exercises-data.js';
import chineseNames from '../../frontend/src/exercise-names/zh.js';
import contentData from './catalogueContent.generated.json';

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
 * catalogue adds later still work in the search, they just fall back to their
 * English name until the map below learns a translation.
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

// Target muscles plus the secondary-muscle vocabulary the catalogue uses, so a
// Chinese label finds an exercise through either field the same way Web does.
export const TARGET_MUSCLE_NAMES = {
  abductors: '髋外展肌',
  abdominals: '腹肌',
  abs: '腹肌',
  adductors: '髋内收肌',
  'ankle stabilizers': '踝关节稳定肌',
  ankles: '脚踝',
  biceps: '肱二头肌',
  brachialis: '肱肌',
  calves: '小腿肌',
  'cardiovascular system': '心血管系统',
  core: '核心',
  deltoids: '三角肌',
  delts: '三角肌',
  feet: '脚',
  forearms: '前臂',
  glutes: '臀肌',
  'grip muscles': '握力肌群',
  groin: '腹股沟',
  hamstrings: '腘绳肌',
  hands: '手',
  'hip flexors': '髋屈肌',
  'inner thighs': '大腿内侧',
  'latissimus dorsi': '背阔肌',
  lats: '背阔肌',
  'levator scapulae': '肩胛提肌',
  'lower abs': '下腹',
  'lower back': '下背部',
  obliques: '腹斜肌',
  pectorals: '胸肌',
  quads: '股四头肌',
  quadriceps: '股四头肌',
  'rear deltoids': '三角肌后束',
  rhomboids: '菱形肌',
  'rotator cuff': '肩袖',
  'serratus anterior': '前锯肌',
  shins: '胫部',
  soleus: '比目鱼肌',
  spine: '脊柱',
  'sternocleidomastoid': '胸锁乳突肌',
  traps: '斜方肌',
  trapezius: '斜方肌',
  triceps: '肱三头肌',
  'upper back': '上背部',
  'upper chest': '上胸',
  'wrist extensors': '腕伸肌',
  'wrist flexors': '腕屈肌',
  wrists: '手腕',
};

const targetCounts = new Map();
for (const exercise of EXDB) {
  if (exercise.tg) targetCounts.set(exercise.tg, (targetCounts.get(exercise.tg) || 0) + 1);
}

/** Target-muscle values in the catalogue, most common first; the ids stay the raw `tg`. */
export const TARGET_MUSCLES = [...targetCounts.keys()].sort(
  (a, b) => (targetCounts.get(b) || 0) - (targetCounts.get(a) || 0) || a.localeCompare(b),
);

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

/** @param {string} value */
export function targetMuscleName(value) {
  return TARGET_MUSCLE_NAMES[value] ?? value;
}

/** Raw catalogue entries, used by the shared search adapter. */
export function catalogueEntries() {
  return EXDB;
}

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

/** @param {string} value */
export function bodyPartName(value) {
  return BODY_PART_NAMES[value] ?? value;
}

/** @param {string} value */
export function equipmentName(value) {
  return EQUIPMENT_NAMES[value] ?? value;
}

export const SEARCH_LIMIT = 100;
