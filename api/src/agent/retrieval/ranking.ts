// Pure domain ranking, guardrail, calibration, rejection, and clarification logic for server v2 exercise retrieval.
// Must remain free of Node built-ins so it is portable and strictly typed.

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface RetrievalCandidate {
  name: string;
  nameEn?: string;
  rationale: string;
  level: ConfidenceLevel;
  equipment?: string;
  bodyPart?: string;
}

export interface RetrievalFallback {
  understanding: string;
  bodyParts?: string[];
  equipment?: string[];
}

export interface ClarificationChip {
  label: string;
  prompt: string;
}

export interface RetrievalRecognition {
  candidates?: RetrievalCandidate[];
  fallback: RetrievalFallback;
  clarifications?: ClarificationChip[];
}

export interface RetrievalInput {
  hintText?: string;
  confirmedEquipment?: string;
}

export interface RetrievalRow {
  exercise_id: string;
  name_en: string;
  name_zh: string;
  aliases?: string[];
  rerank_text: string;
  equipment: string;
  body_part: string;
  target: string;
  posture: string;
}

export interface ScoredHit extends RetrievalRow {
  score: number;
  rrf?: number;
  matches?: number;
}

export interface RerankEntry {
  index: number;
  relevanceScore: number;
}

export interface WeightedTerm {
  term: string;
  weight: number;
}

export interface RankedCandidate {
  row: ScoredHit;
  rawScore: number;
  fusedScore: number;
  logit: number;
  rrfRank: number;
  exactMatch: boolean;
  directExactMatch: boolean;
  equipmentMatch: boolean;
  bodyPartMatch: boolean;
  postureMatch: boolean;
  postureConflict: boolean;
  equipmentConflict: boolean;
  bodyPartConflict: boolean;
  unsupportedVariants: number;
  hasVersionSuffix: boolean;
  outOfRange: boolean;
  level?: ConfidenceLevel;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CANDIDATE_RANK_WEIGHTS = [1.0, 0.90, 0.80, 0.72, 0.65] as const;
const LEVEL_WEIGHTS: Record<ConfidenceLevel, number> = { high: 1.0, medium: 0.93, low: 0.84 };
const EXACT_LEVEL_WEIGHTS: Record<ConfidenceLevel, number> = { high: 1.0, medium: 0.65, low: 0.20 };
const LEVEL_ORDER: Record<ConfidenceLevel, number> = { low: 1, medium: 2, high: 3 };
const HINT_WEIGHT = 0.95;

// Tunable ranking & calibration constants (simple, interpretable, no sample-ID tuning)
export const RANKING_WEIGHTS = {
  logit: 0.50,
  rrf: 0.25,
  exactDirect: 0.22,
  exactStripped: 0.15,
  equipmentMatch: 0.11,
  bodyPartMatch: 0.08,
  postureMatch: 0.08,
  postureConflictPenalty: 0.22,
  requestedVariantBonus: 0.09,
  aliasBonus: 0.02,
  equipmentConflictPenalty: 0.36,
  bodyPartConflictPenalty: 0.30,
  unsupportedVariantPenalty: 0.20,
  versionSuffixPenalty: 0.26,
  scoreFloor: 0.42,
  highScoreFloor: 0.85,
  mediumScoreFloor: 0.50,
  highFusedMargin: 0.05,
  highLogitMargin: 0.35,
} as const;

const UNSUPPORTED_VARIANT_GROUPS: ReadonlyArray<{ en: RegExp; zh: readonly string[] }> = [
  { en: /\binner\b/, zh: ['内侧'] },
  { en: /\boutdoor\b/, zh: ['户外'] },
  { en: /\bincline\b/, zh: ['上斜'] },
  { en: /\bdecline\b/, zh: ['下斜'] },
  { en: /\b(?:single arm|one arm)\b/, zh: ['单臂', '单手'] },
  { en: /\b(?:single leg|one leg)\b/, zh: ['单腿', '单脚'] },
  { en: /\breverse\b/, zh: ['反向', '反握', '掌心朝自己'] },
  { en: /\balternating\b/, zh: ['交替'] },
];

const FIXED_MACHINES = new Set(['leverage machine', 'sled machine', 'smith machine']);
const FREE_WEIGHTS = new Set([
  'barbell', 'ez barbell', 'olympic barbell', 'trap bar', 'dumbbell', 'kettlebell', 'weight plate', 'weighted',
]);
const BODYWEIGHT = new Set(['body weight', 'band', 'resistance band', 'suspension trainer']);
const MACHINE_HINTS = new Set([
  'barbell', 'smith machine', 'leverage machine', 'sled machine', 'cable',
  'dumbbell', 'ez barbell', 'olympic barbell', 'trap bar', 'kettlebell',
  'weight plate', 'weighted', 'landmine', 'hammer', 'assisted',
]);

const COMPATIBLE_BODY_PARTS: Record<string, Set<string>> = {
  chest: new Set(['chest', 'shoulders']),
  shoulders: new Set(['shoulders', 'chest', 'upper arms', 'back']),
  back: new Set(['back', 'shoulders', 'upper arms', 'waist']),
  'upper arms': new Set(['upper arms', 'chest', 'back', 'shoulders', 'lower arms']),
  'lower arms': new Set(['lower arms', 'upper arms']),
  'upper legs': new Set(['upper legs', 'lower legs', 'waist']),
  'lower legs': new Set(['lower legs', 'upper legs']),
  waist: new Set(['waist', 'back', 'upper legs']),
  neck: new Set(['neck', 'shoulders', 'back']),
};

const POSTURE_VARIANTS: ReadonlyArray<{ slug: string; label: string; en: RegExp; zh: RegExp }> = [
  { slug: 'side_lying', label: '侧卧', en: /\b(?:side lying|lateral lying)\b/, zh: /侧卧/ },
  { slug: 'kneeling', label: '跪姿', en: /\b(?:half kneeling|kneeling|on knees|quadruped)\b/, zh: /跪姿|半跪/ },
  { slug: 'hanging', label: '悬垂', en: /\b(?:hanging|suspended)\b/, zh: /悬垂/ },
  { slug: 'seated', label: '坐姿', en: /\b(?:seated|sitting)\b/, zh: /坐姿|坐着/ },
  { slug: 'standing', label: '站姿', en: /\b(?:standing|upright)\b/, zh: /站姿|站着/ },
  { slug: 'prone', label: '俯卧', en: /\b(?:prone|face down|chest supported)\b/, zh: /俯卧|趴在|趴着/ },
  { slug: 'supine', label: '仰卧', en: /\b(?:supine|reclined|flat bench)\b/, zh: /仰卧|平躺/ },
  { slug: 'bent_over', label: '俯身', en: /\b(?:bent over|romanian|good morning|hip hinge)\b/, zh: /俯身/ },
];

const POSTURE_LABELS: Record<string, string> = {
  seated: '坐姿',
  standing: '站姿',
  supine: '仰卧',
  prone: '俯卧',
  incline: '上斜',
  decline: '下斜',
  kneeling: '跪姿',
  side_lying: '侧卧',
  bent_over: '俯身',
  hanging: '悬垂',
};

const MAX_CLARIFICATIONS = 3;
const MAX_CLARIFICATION_LABEL = 16;
const MAX_CLARIFICATION_PROMPT = 60;

const CLARIFICATION_PRESS_FLY: readonly ClarificationChip[] = [
  { label: '往前推（练胸）', prompt: '这是往前推的坐姿推胸器械' },
  { label: '往上推（练肩）', prompt: '这是往上推的坐姿推肩器械' },
  { label: '双臂夹胸（蝴蝶机）', prompt: '这是双臂向中间夹胸的蝴蝶机' },
];

const CLARIFICATION_LEG_EXT_CURL: readonly ClarificationChip[] = [
  { label: '大腿前侧（腿屈伸）', prompt: '这是踢腿练大腿前侧的坐姿腿屈伸' },
  { label: '大腿后侧（腿弯举）', prompt: '这是屈膝练大腿后侧的坐姿腿弯举' },
];

const CLARIFICATION_HACK_LEG_PRESS: readonly ClarificationChip[] = [
  { label: '站姿斜板下蹲（哈克）', prompt: '这是肩垫顶肩下蹲的哈克深蹲器械' },
  { label: '坐姿/斜躺蹬腿（腿举）', prompt: '这是脚踩踏板蹬腿的腿举器械' },
];

const CLARIFICATION_GENERIC_MACHINE: readonly ClarificationChip[] = [
  { label: '固定器械（挂片/插销）', prompt: '这是一台商用固定器械' },
  { label: '绳索/龙门架', prompt: '这是用绳索滑轮的龙门架动作' },
];

const FITNESS_CLUE_PATTERN = /\b(?:machine|cable|pulley|lever|sled|smith|press|row|pull|pulldown|curl|extension|squat|raise|fly|pec|chest|shoulder|back|leg|quad|hamstring|calf|glute|arm|bicep|tricep|gym|workout)\b|器械|机器|绳索|滑轮|龙门架|史密斯|推胸|推肩|卧推|划船|下拉|弯举|屈伸|深蹲|腿举|夹胸|蝴蝶机|飞鸟|胸|肩|背|腿|臂|健身/i;
const NON_FITNESS_NEGATION_PATTERN = /没有看到|未见|并未看到|并不是|不是.*(?:健身|器械|训练|运动)|非健身|与健身无关|与训练无关|no\s+(?:gym|fitness|exercise|workout)\s+equipment/i;
const SPECIFIC_EXERCISE_CLUE_PATTERN = /\b(?:bench|press|squat|row|pull|pulldown|curl|extension|raise|fly|pec|dip|shrug|deadlift|lunge|crunch|pushdown|kickback|calf|hip|adduction|abduction|hack|smith|dumbbell|barbell|kettlebell|cable)\b|推胸|胸推|卧推|推肩|肩推|划船|下拉|弯举|屈伸|深蹲|腿举|倒蹬|哈克|夹胸|蝴蝶机|飞鸟|臂屈伸|耸肩|硬拉|箭步蹲|提踵|髋内收|髋外展|哑铃|杠铃|壶铃|史密斯|龙门架/i;

export function cleanText(value: unknown): string {
  return String(value == null ? '' : value).trim();
}

export function normText(value: string): string {
  return value.toLocaleLowerCase('en').normalize('NFKC').replace(/[\p{P}\p{S}\s]+/gu, ' ').trim();
}

function normalizeExact(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePhrase(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCjk(value: string): boolean {
  return CJK_RE.test(value);
}

export function stripNonSemanticSuffix(name: string): string {
  let cur = cleanText(name);
  while (cur) {
    const next = cur
      .replace(/\s*\((?:plate[- ]?loaded|pin[- ]?loaded|selectorized|version\s*\d+|v\.?\s*\d+|male|female|挂片式|插销式|男|女)\)\s*$/i, '')
      .replace(/\s+v\.?\s*\d+\s*$/i, '')
      .trim();
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

export function hasVersionSuffix(name: string): boolean {
  const raw = cleanText(name);
  return /\bv\.?\s*\d+\b|\(\s*(?:version|v\.?)\s*\d+\s*\)/i.test(raw);
}

export function postureTerms(hint: string, candidates: RetrievalCandidate[]): string[] {
  const text = `${hint} ${candidates.map(c => `${c.name} ${c.nameEn || ''}`).join(' ')}`.toLowerCase();
  return ['seated', 'standing', 'supine', 'prone', 'incline', 'decline', 'kneeling', '坐姿', '站姿', '仰卧', '俯卧', '上斜', '下斜', '跪姿']
    .filter(x => text.includes(x));
}

export function inferHintPostures(hint: string): string[] {
  const raw = cleanText(hint);
  if (!raw) return [];
  const lower = normalizePhrase(raw);
  const slugs: string[] = [];
  for (const item of POSTURE_VARIANTS) {
    if (item.en.test(lower) || item.zh.test(raw)) {
      slugs.push(item.slug);
    }
  }
  return [...new Set(slugs)];
}

export function inferPostureSlugs(hint: string, candidates: RetrievalCandidate[]): string[] {
  const raw = `${hint} ${candidates.map(c => `${c.name} ${c.nameEn || ''}`).join(' ')}`;
  const lower = normalizePhrase(raw);
  const slugs: string[] = [];
  for (const item of POSTURE_VARIANTS) {
    if (item.en.test(lower) || item.zh.test(raw)) {
      slugs.push(item.slug);
    }
  }
  if (!slugs.length && /\blying\b/.test(lower)) {
    const bp = cleanText(candidates[0]?.bodyPart).toLowerCase();
    if ((bp === 'upper legs' && /\b(?:leg curl|curl|hamstring)\b/.test(lower))
      || /\b(?:leg curl|reverse fly|rear delt|back extension|hyperextension|seal row)\b/.test(lower)) {
      slugs.push('prone');
    } else {
      slugs.push('supine');
    }
  }
  return [...new Set(slugs)];
}

export function postureMatches(posture: string, clues: string[]): boolean {
  const variants: Record<string, string[]> = {
    seated: ['seated', '坐姿'],
    standing: ['standing', '站姿'],
    supine: ['supine', '仰卧'],
    prone: ['prone', '俯卧'],
    incline: ['incline', '上斜'],
    decline: ['decline', '下斜'],
    kneeling: ['kneeling', '跪姿'],
    side_lying: ['side_lying', '侧卧'],
    bent_over: ['bent_over', '俯身'],
    hanging: ['hanging', '悬垂'],
  };
  return (variants[posture] || [posture]).some(value => clues.includes(value));
}

export function postureLabel(posture: string): string {
  return POSTURE_LABELS[posture] || posture;
}

export function buildWeightedTerms(candidates: RetrievalCandidate[], hint = ''): WeightedTerm[] {
  const byNorm = new Map<string, WeightedTerm>();
  const add = (raw: string | undefined, weight: number) => {
    const term = cleanText(raw);
    if (!term) return;
    const key = normText(term);
    if (!key) return;
    const existing = byNorm.get(key);
    if (!existing || weight > existing.weight) {
      byNorm.set(key, { term, weight });
    }
  };
  const trimmedHint = cleanText(hint);
  if (trimmedHint) add(trimmedHint, HINT_WEIGHT);
  for (let i = 0; i < Math.min(candidates.length, CANDIDATE_RANK_WEIGHTS.length); i++) {
    const c = candidates[i];
    const rankWeight = CANDIDATE_RANK_WEIGHTS[i];
    const levelWeight = LEVEL_WEIGHTS[c.level] ?? LEVEL_WEIGHTS.low;
    const weight = Number((rankWeight * levelWeight).toFixed(4));
    add(c.name, weight);
    add(c.nameEn, weight);
  }
  return [...byNorm.values()];
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const val of values) {
    const cleaned = cleanText(val);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function clipText(value: string | undefined, maxChars: number): string {
  const text = cleanText(value).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text;
}

export function buildVectorQuery(params: {
  hint?: string;
  recognition: RetrievalRecognition;
  confirmedEquipment?: string;
}): string {
  const candidates = (params.recognition.candidates ?? []).slice(0, 5);
  const c0 = candidates[0];
  const fb = params.recognition.fallback;
  const c0Name = cleanText(c0?.name);
  const c0NameEn = cleanText(c0?.nameEn);
  const englishName = c0NameEn || (!isCjk(c0Name) ? c0Name : '');
  const chineseName = isCjk(c0Name) ? c0Name : '';
  const bodyParts = uniqueDefined([c0?.bodyPart, ...(fb.bodyParts ?? [])]);
  const equipment = uniqueDefined([params.confirmedEquipment, c0?.equipment, ...(fb.equipment ?? [])]);
  const postures = inferPostureSlugs(cleanText(params.hint), candidates);
  const attrs = uniqueDefined([...bodyParts, ...equipment, ...postures]);

  const parts: string[] = [];
  if (englishName) parts.push(`English: ${englishName}`);
  if (chineseName) parts.push(`Chinese: ${chineseName}`);
  if (!englishName && !chineseName && c0Name) parts.push(`Name: ${c0Name}`);
  if (attrs.length) parts.push(`Attributes: ${attrs.join(', ')}`);

  const conciseHint = clipText(params.hint, 120);
  const conciseUnderstanding = clipText(fb.understanding, 120);
  if (conciseHint) parts.push(conciseHint);
  if (conciseUnderstanding && conciseUnderstanding !== conciseHint) {
    parts.push(conciseUnderstanding);
  }
  return parts.join('. ');
}

export function buildRerankQuery(params: {
  hint?: string;
  recognition: RetrievalRecognition;
  confirmedEquipment?: string;
}): string {
  const candidates = (params.recognition.candidates ?? []).slice(0, 5);
  const c0 = candidates[0];
  const c1 = candidates[1];
  const fb = params.recognition.fallback;
  const c0Name = cleanText(c0?.name);
  const c0NameEn = cleanText(c0?.nameEn);
  const englishName = c0NameEn || (!isCjk(c0Name) ? c0Name : '');
  const chineseName = isCjk(c0Name) ? c0Name : '';

  const parts: string[] = [];
  if (englishName) parts.push(`English: ${englishName}`);
  if (chineseName) parts.push(`Chinese: ${chineseName}`);
  if (!englishName && !chineseName && c0Name) parts.push(`Name: ${c0Name}`);

  if (c1 && (c0?.level !== 'high' || c1.level !== 'low')) {
    const altNames = uniqueDefined([c1.nameEn, c1.name]).filter(
      name => normalizeExact(name) !== normalizeExact(englishName) && normalizeExact(name) !== normalizeExact(chineseName),
    );
    if (altNames.length) {
      parts.push(`Alternative: ${altNames.join(' / ')}`);
    }
  }

  const bodyParts = uniqueDefined([c0?.bodyPart, ...(fb.bodyParts ?? [])]);
  const equipment = uniqueDefined([params.confirmedEquipment, c0?.equipment, ...(fb.equipment ?? [])]);
  const postures = inferPostureSlugs(cleanText(params.hint), candidates);
  const attrs = uniqueDefined([...bodyParts, ...equipment, ...postures]);
  if (attrs.length) parts.push(`Attributes: ${attrs.join(', ')}`);

  const conciseHint = clipText(params.hint, 80);
  if (conciseHint) parts.push(conciseHint);

  return parts.join('. ');
}

export function equipmentConflictFor(expectedEquipments: string[], rowEquipment: string): boolean {
  const exEq = cleanText(rowEquipment).toLowerCase();
  const targets = expectedEquipments.map(eq => cleanText(eq).toLowerCase()).filter(Boolean);
  if (!targets.length || !exEq) return false;
  if (targets.includes(exEq)) return false;
  return targets.every(eq => {
    if (MACHINE_HINTS.has(eq) && BODYWEIGHT.has(exEq)) return true;
    if (FIXED_MACHINES.has(eq) && FREE_WEIGHTS.has(exEq)) return true;
    if (FREE_WEIGHTS.has(eq) && FIXED_MACHINES.has(exEq)) return true;
    if (BODYWEIGHT.has(eq) && (FIXED_MACHINES.has(exEq) || FREE_WEIGHTS.has(exEq))) return true;
    return false;
  });
}

export function bodyPartConflictFor(expectedBodyParts: string[], rowBodyPart: string): boolean {
  const exBp = cleanText(rowBodyPart).toLowerCase();
  const targets = expectedBodyParts.map(bp => cleanText(bp).toLowerCase()).filter(Boolean);
  if (!targets.length || !exBp) return false;
  const known = targets.filter(bp => Boolean(COMPATIBLE_BODY_PARTS[bp]));
  if (!known.length) return false;
  return known.every(bp => !COMPATIBLE_BODY_PARTS[bp].has(exBp));
}

export function unsupportedVariantCount(
  row: Pick<RetrievalRow, 'name_en' | 'name_zh'>,
  options: { primaryName?: string; nameEn?: string; hintText?: string; extraSupportedTexts?: string[] },
): number {
  const enPhrase = normalizePhrase(row.name_en);
  const zhRaw = cleanText(row.name_zh);
  if (!enPhrase && !zhRaw) return 0;

  const rawTexts = [
    cleanText(options.primaryName),
    cleanText(options.nameEn),
    cleanText(options.hintText),
    ...(options.extraSupportedTexts ?? []).map(cleanText),
  ].filter(Boolean);
  const phraseTexts = rawTexts.map(normalizePhrase);

  let count = 0;
  for (const group of UNSUPPORTED_VARIANT_GROUPS) {
    const present = (enPhrase && group.en.test(enPhrase))
      || (zhRaw && group.zh.some(term => zhRaw.includes(term)));
    if (!present) continue;
    const supported = phraseTexts.some(p => group.en.test(p))
      || rawTexts.some(r => group.zh.some(term => r.includes(term)));
    if (!supported) count++;
  }
  return count;
}

function rowNames(row: RetrievalRow): string[] {
  return uniqueDefined([row.name_en, row.name_zh, ...(Array.isArray(row.aliases) ? row.aliases : [])]);
}

function matchCandidateNames(
  row: RetrievalRow,
  wantedNames: string[],
): { exact: boolean; directExact: boolean } {
  const wantedRaw = wantedNames.map(normalizeExact).filter(Boolean);
  const wantedStripped = wantedNames.map(stripNonSemanticSuffix).map(normalizeExact).filter(Boolean);
  if (!wantedRaw.length) return { exact: false, directExact: false };

  const names = rowNames(row);
  let strippedHit = false;
  for (const name of names) {
    const normName = normalizeExact(name);
    if (wantedRaw.includes(normName)) {
      return { exact: true, directExact: true };
    }
    const stripped = normalizeExact(stripNonSemanticSuffix(name));
    if (stripped && (wantedRaw.includes(stripped) || wantedStripped.includes(stripped))) {
      strippedHit = true;
    }
  }
  return { exact: strippedHit, directExact: false };
}

function expectedAttributes(
  recognition: RetrievalRecognition,
  confirmedEquipment?: string,
): {
  conflictEquipments: string[];
  primaryEquipment: string[];
  fallbackEquipments: string[];
  conflictBodyParts: string[];
  primaryBodyParts: string[];
  fallbackBodyParts: string[];
} {
  const candidates = (recognition.candidates ?? []).slice(0, 5);
  const c0 = candidates[0];
  const fbEq = recognition.fallback.equipment ?? [];
  const fbBp = recognition.fallback.bodyParts ?? [];
  const nonLowEq = uniqueDefined(candidates.filter(c => c.level !== 'low').map(c => c.equipment));
  const highEq = uniqueDefined(candidates.filter(c => c.level === 'high').map(c => c.equipment));
  const allCandEq = uniqueDefined(candidates.map(c => c.equipment));

  const conflictEquipments = confirmedEquipment
    ? [confirmedEquipment]
    : highEq.length
      ? highEq
      : nonLowEq.length
        ? nonLowEq
        : allCandEq.length
          ? allCandEq
          : uniqueDefined(fbEq);

  const primaryEquipment = confirmedEquipment
    ? [confirmedEquipment]
    : c0?.equipment
      ? [c0.equipment]
      : uniqueDefined(fbEq);

  const nonLowBp = uniqueDefined(candidates.filter(c => c.level !== 'low').map(c => c.bodyPart));
  const highBp = uniqueDefined(candidates.filter(c => c.level === 'high').map(c => c.bodyPart));
  const allCandBp = uniqueDefined(candidates.map(c => c.bodyPart));

  const conflictBodyParts = highBp.length
    ? highBp
    : nonLowBp.length
      ? nonLowBp
      : allCandBp.length
        ? allCandBp
        : uniqueDefined(fbBp);

  const primaryBodyParts = c0?.bodyPart
    ? [c0.bodyPart]
    : uniqueDefined(fbBp);

  return {
    conflictEquipments,
    primaryEquipment,
    fallbackEquipments: uniqueDefined([...allCandEq, ...fbEq]),
    conflictBodyParts,
    primaryBodyParts,
    fallbackBodyParts: uniqueDefined([...allCandBp, ...fbBp]),
  };
}

function rowTokens(row: RetrievalRow): Set<string> {
  const tokens = new Set<string>();
  for (const name of rowNames(row)) {
    for (const tok of normalizePhrase(name).split(/[^a-z0-9\u3400-\u9fff]+/).filter(Boolean)) {
      if (tok.length >= 2) tokens.add(tok);
    }
  }
  return tokens;
}

function hasCandidateNameOverlap(row: RetrievalRow, candidate: RetrievalCandidate): boolean {
  const rowToks = rowTokens(row);
  if (!rowToks.size) return false;
  const candNames = [candidate.name, candidate.nameEn || ''].map(cleanText).filter(Boolean);
  for (const cname of candNames) {
    if (isCjk(cname)) {
      const cleanCand = cname.replace(/\s+/g, '');
      const cleanZh = cleanText(row.name_zh).replace(/\s+/g, '');
      if (cleanCand.length >= 2 && (cleanZh.includes(cleanCand) || cleanCand.includes(cleanZh))) return true;
      for (const alias of row.aliases ?? []) {
        const cleanAlias = cleanText(alias).replace(/\s+/g, '');
        if (cleanAlias.length >= 2 && (cleanAlias.includes(cleanCand) || cleanCand.includes(cleanAlias))) return true;
      }
    }
    const toks = normalizePhrase(cname).split(/[^a-z0-9]+/).filter(t => t.length >= 3);
    if (toks.some(t => rowToks.has(t))) return true;
  }
  return false;
}

function requestedVariantMatches(row: RetrievalRow, hint: string): number {
  const hintRaw = cleanText(hint);
  if (!hintRaw) return 0;
  const hintPhrase = normalizePhrase(hintRaw);
  const rowPhrase = normalizePhrase([row.name_en, ...(row.aliases ?? [])].join(' '));
  const rowZh = [row.name_zh, ...(row.aliases ?? [])].join(' ');
  let matches = 0;
  for (const group of UNSUPPORTED_VARIANT_GROUPS) {
    const requested = group.en.test(hintPhrase) || group.zh.some(term => hintRaw.includes(term));
    if (!requested) continue;
    const present = group.en.test(rowPhrase) || group.zh.some(term => rowZh.includes(term));
    if (present) matches++;
  }
  return matches;
}

export function scoreAndRankCandidates(params: {
  merged: ScoredHit[];
  rerankResults: RerankEntry[];
  recognition: RetrievalRecognition;
  input: RetrievalInput;
}): RankedCandidate[] {
  const { merged, rerankResults, recognition, input } = params;
  const candidates = (recognition.candidates ?? []).slice(0, 5);
  const hint = cleanText(input.hintText);
  const seen = new Set<number>();
  const valid = rerankResults.filter(r =>
    Number.isInteger(r.index)
    && r.index >= 0
    && r.index < merged.length
    && Number.isFinite(r.relevanceScore)
    && !seen.has(r.index)
    && (seen.add(r.index), true));

  if (!valid.length) return [];

  const outOfRange = valid.some(r => r.relevanceScore < 0 || r.relevanceScore > 1);
  if (outOfRange) {
    return [...valid]
      .sort((a, b) =>
        b.relevanceScore - a.relevanceScore
        || (merged[b.index].matches || 0) - (merged[a.index].matches || 0)
        || (merged[b.index].rrf || 0) - (merged[a.index].rrf || 0)
        || merged[a.index].exercise_id.localeCompare(merged[b.index].exercise_id))
      .slice(0, 10)
      .map(r => ({
        row: merged[r.index],
        rawScore: r.relevanceScore,
        fusedScore: r.relevanceScore,
        logit: r.relevanceScore,
        rrfRank: r.index + 1,
        exactMatch: false,
        directExactMatch: false,
        equipmentMatch: false,
        bodyPartMatch: false,
        postureMatch: false,
        postureConflict: false,
        equipmentConflict: false,
        bodyPartConflict: false,
        unsupportedVariants: 0,
        hasVersionSuffix: false,
        outOfRange: true,
      }));
  }

  const attrs = expectedAttributes(recognition, input.confirmedEquipment);
  const explicitHintPostures = inferHintPostures(hint);
  const combinedPostures = inferPostureSlugs(hint, candidates);
  const maxRrf = Math.max(0, ...merged.map(m => m.rrf || 0));
  const c0 = candidates[0];
  const highCandTexts = candidates.filter(c => c.level === 'high').flatMap(c => [c.name, c.nameEn || '']);
  const queryTextAll = [hint, ...candidates.flatMap(c => [c.name, c.nameEn || ''])].join(' ');
  const queryHasVersion = hasVersionSuffix(queryTextAll);

  // Precompute candidate name groups weighted by rank and VLM level
  const candExactGroups = candidates.map((c, idx) => ({
    names: [c.name, c.nameEn || ''].filter(Boolean),
    weight: CANDIDATE_RANK_WEIGHTS[idx] * (EXACT_LEVEL_WEIGHTS[c.level] ?? EXACT_LEVEL_WEIGHTS.low),
  }));
  const hintExactNames = hint && [...hint].length <= 24 ? [hint] : [];

  const prelim = valid.map(r => {
    const row = merged[r.index];
    const p = Math.min(1 - 1e-6, Math.max(1e-6, r.relevanceScore));
    const logit = Math.log(p / (1 - p));
    const normLogit = Math.max(0, Math.min(1, (logit + 6) / 12));
    const normRrf = maxRrf > 0 ? (row.rrf || 0) / maxRrf : 0;

    const rowHasVersion = !queryHasVersion && (hasVersionSuffix(row.name_en) || hasVersionSuffix(row.name_zh));
    let bestExactWeight = 0;
    let exactMatch = false;
    let directExactMatch = false;
    if (!rowHasVersion) {
      for (const group of candExactGroups) {
        const m = matchCandidateNames(row, group.names);
        if (m.exact && group.weight > bestExactWeight) {
          bestExactWeight = group.weight;
          exactMatch = true;
          directExactMatch = directExactMatch || m.directExact;
        }
      }
      if (hintExactNames.length) {
        const m = matchCandidateNames(row, hintExactNames);
        if (m.exact) {
          exactMatch = true;
          directExactMatch = directExactMatch || m.directExact;
          if (HINT_WEIGHT > bestExactWeight) bestExactWeight = HINT_WEIGHT;
        }
      }
    }

    const eq = cleanText(row.equipment).toLowerCase();
    const bp = cleanText(row.body_part).toLowerCase();
    const equipmentMatch = attrs.primaryEquipment.includes(eq)
      ? true
      : !attrs.primaryEquipment.length && attrs.fallbackEquipments.includes(eq);
    const equipmentFallbackMatch = !equipmentMatch && attrs.fallbackEquipments.includes(eq);
    const bodyPartMatch = attrs.primaryBodyParts.includes(bp)
      ? true
      : !attrs.primaryBodyParts.length && attrs.fallbackBodyParts.includes(bp);
    const bodyPartFallbackMatch = !bodyPartMatch && attrs.fallbackBodyParts.includes(bp);
    const postureMatch = Boolean(row.posture && (explicitHintPostures.length ? explicitHintPostures.includes(row.posture) : combinedPostures.includes(row.posture)));
    const postureConflict = Boolean(explicitHintPostures.length && row.posture && !explicitHintPostures.includes(row.posture));

    const equipmentConflict = equipmentConflictFor(attrs.conflictEquipments, eq);
    const bodyPartConflict = bodyPartConflictFor(attrs.conflictBodyParts, bp);
    const unsupportedVariants = unsupportedVariantCount(row, {
      primaryName: c0?.name,
      nameEn: c0?.nameEn,
      hintText: hint,
      extraSupportedTexts: highCandTexts,
    });
    const requestedVariants = requestedVariantMatches(row, hint);

    return {
      row,
      rawScore: r.relevanceScore,
      normLogit,
      normRrf,
      logit,
      rrfRank: r.index + 1,
      exactMatch,
      directExactMatch,
      bestExactWeight,
      equipmentMatch,
      equipmentFallbackMatch,
      bodyPartMatch,
      bodyPartFallbackMatch,
      postureMatch,
      postureConflict,
      equipmentConflict,
      bodyPartConflict,
      unsupportedVariants,
      requestedVariants,
      hasVersionSuffix: rowHasVersion,
      hasAliases: Array.isArray(row.aliases) && row.aliases.length > 0,
    };
  });

  const hasNonEquipmentConflict = prelim.some(item => !item.equipmentConflict);
  const hasNonBodyPartConflict = prelim.some(item => !item.bodyPartConflict);
  const hasNonPostureConflict = prelim.some(item => !item.postureConflict);

  const scored: RankedCandidate[] = prelim.map(item => {
    const exactBonus = item.exactMatch
      ? item.bestExactWeight * (item.directExactMatch ? RANKING_WEIGHTS.exactDirect : RANKING_WEIGHTS.exactStripped)
      : 0;
    const eqBonus = item.equipmentMatch
      ? RANKING_WEIGHTS.equipmentMatch
      : item.equipmentFallbackMatch
        ? RANKING_WEIGHTS.equipmentMatch * 0.45
        : 0;
    const bpBonus = item.bodyPartMatch
      ? RANKING_WEIGHTS.bodyPartMatch
      : item.bodyPartFallbackMatch
        ? RANKING_WEIGHTS.bodyPartMatch * 0.45
        : 0;
    const posBonus = item.postureMatch ? RANKING_WEIGHTS.postureMatch : 0;
    const posPenalty = item.postureConflict && hasNonPostureConflict ? RANKING_WEIGHTS.postureConflictPenalty : 0;
    const reqVarBonus = item.requestedVariants * RANKING_WEIGHTS.requestedVariantBonus;
    const aliasBonus = item.hasAliases ? RANKING_WEIGHTS.aliasBonus : 0;
    const eqPenalty = item.equipmentConflict && hasNonEquipmentConflict ? RANKING_WEIGHTS.equipmentConflictPenalty : 0;
    const bpPenalty = item.bodyPartConflict && hasNonBodyPartConflict ? RANKING_WEIGHTS.bodyPartConflictPenalty : 0;
    const variantPenalty = item.unsupportedVariants * RANKING_WEIGHTS.unsupportedVariantPenalty;
    const versionPenalty = item.hasVersionSuffix ? RANKING_WEIGHTS.versionSuffixPenalty : 0;

    const fusedScore =
      RANKING_WEIGHTS.logit * item.normLogit
      + RANKING_WEIGHTS.rrf * item.normRrf
      + exactBonus
      + eqBonus
      + bpBonus
      + posBonus
      + reqVarBonus
      + aliasBonus
      - eqPenalty
      - bpPenalty
      - posPenalty
      - variantPenalty
      - versionPenalty;

    return {
      row: item.row,
      rawScore: item.rawScore,
      fusedScore,
      logit: item.logit,
      rrfRank: item.rrfRank,
      exactMatch: item.exactMatch,
      directExactMatch: item.directExactMatch,
      equipmentMatch: item.equipmentMatch,
      bodyPartMatch: item.bodyPartMatch,
      postureMatch: item.postureMatch,
      postureConflict: item.postureConflict,
      equipmentConflict: item.equipmentConflict,
      bodyPartConflict: item.bodyPartConflict,
      unsupportedVariants: item.unsupportedVariants,
      hasVersionSuffix: item.hasVersionSuffix,
      outOfRange: false,
    };
  });

  scored.sort((a, b) =>
    b.fusedScore - a.fusedScore
    || b.rawScore - a.rawScore
    || (b.row.rrf || 0) - (a.row.rrf || 0)
    || a.row.exercise_id.localeCompare(b.row.exercise_id));

  return scored.slice(0, 10);
}

function isGenericOrEmptyHint(hint: string): boolean {
  const cleaned = cleanText(hint);
  if (!cleaned) return true;
  if (SPECIFIC_EXERCISE_CLUE_PATTERN.test(cleaned)) return false;
  return true;
}

export function shouldRejectToFallback(
  ranked: RankedCandidate[],
  recognition: RetrievalRecognition,
  hint = '',
): boolean {
  if (!ranked.length) return true;
  if (ranked.some(item => item.outOfRange)) return false;

  const candidates = (recognition.candidates ?? []).slice(0, 5);
  if (candidates.length > 0 && candidates.every(c => c.level === 'low')) {
    const distinctPairs = new Set(
      candidates
        .map(c => `${cleanText(c.equipment).toLowerCase()}::${cleanText(c.bodyPart).toLowerCase()}`)
        .filter(pair => pair !== '::'),
    );
    if (distinctPairs.size >= 3 && isGenericOrEmptyHint(hint)) {
      return true;
    }
  }

  const top1 = ranked[0];
  if (top1.rawScore < RANKING_WEIGHTS.scoreFloor && !top1.exactMatch) {
    return true;
  }

  return false;
}

function vlmCeilingFor(row: RetrievalRow, candidates: RetrievalCandidate[]): ConfidenceLevel {
  if (!candidates.length) return 'low';
  const exactMatches = candidates.filter(c => matchCandidateNames(row, [c.name, c.nameEn || '']).exact);
  if (exactMatches.length) {
    return exactMatches.reduce<ConfidenceLevel>(
      (best, c) => (LEVEL_ORDER[c.level] > LEVEL_ORDER[best] ? c.level : best),
      'low',
    );
  }
  const overlapMatches = candidates.filter(c => hasCandidateNameOverlap(row, c));
  if (overlapMatches.length) {
    return overlapMatches.reduce<ConfidenceLevel>(
      (best, c) => (LEVEL_ORDER[c.level] > LEVEL_ORDER[best] ? c.level : best),
      'low',
    );
  }
  return candidates[0].level ?? 'low';
}

function shareCanonicalIdentityOrAlias(a: RetrievalRow, b: RetrievalRow): boolean {
  const aBase = normalizeExact(stripNonSemanticSuffix(a.name_en));
  const bBase = normalizeExact(stripNonSemanticSuffix(b.name_en));
  if (aBase && bBase && aBase === bBase) return true;
  const aZh = normalizeExact(stripNonSemanticSuffix(a.name_zh));
  const bZh = normalizeExact(stripNonSemanticSuffix(b.name_zh));
  if (aZh && bZh && aZh === bZh) return true;
  const aAliases = new Set((a.aliases ?? []).map(x => normalizeExact(stripNonSemanticSuffix(x))).filter(Boolean));
  if (aAliases.size) {
    for (const alias of b.aliases ?? []) {
      const n = normalizeExact(stripNonSemanticSuffix(alias));
      if (n && aAliases.has(n)) return true;
    }
    if (bBase && aAliases.has(bBase)) return true;
  }
  return false;
}

function hasConfusableCandidates(candidates: RetrievalCandidate[]): boolean {
  if (candidates.length < 2) return false;
  const c0 = candidates[0];
  const c1 = candidates[1];
  if (c1.level === 'low') return false;
  const asRow = (c: RetrievalCandidate): Pick<RetrievalRow, 'name_en' | 'name_zh' | 'aliases' | 'body_part'> => ({
    name_en: c.nameEn || c.name,
    name_zh: c.name,
    aliases: [],
    body_part: c.bodyPart || '',
  });
  if (hasConfusablePair([asRow(c0), asRow(c1)])) return true;
  const blob0 = `${c0.nameEn || ''} ${c0.name}`.toLowerCase();
  const blob1 = `${c1.nameEn || ''} ${c1.name}`.toLowerCase();
  const add0 = /hip adduction|髋内收/.test(blob0);
  const abd0 = /hip abduction|髋外展/.test(blob0);
  const add1 = /hip adduction|髋内收/.test(blob1);
  const abd1 = /hip abduction|髋外展/.test(blob1);
  return (add0 && abd1) || (abd0 && add1);
}

export function calibrateLevels(
  ranked: RankedCandidate[],
  recognition: RetrievalRecognition,
  hint = '',
): RankedCandidate[] {
  if (!ranked.length) return ranked;
  if (ranked.some(item => item.outOfRange)) {
    return ranked.map(item => ({ ...item, level: undefined }));
  }

  const candidates = (recognition.candidates ?? []).slice(0, 5);
  const topRows = ranked.map(item => item.row);
  const confusableTop = hasConfusablePair(topRows)
    || (topRows.length >= 3 && hasConfusablePair([topRows[0], topRows[2]]))
    || hasConfusableCandidates(candidates);

  const hintClean = cleanText(hint);
  const hintExactNames = hintClean && [...hintClean].length <= 24 ? [hintClean] : [];
  const hintConflict = hintExactNames.length > 0 && ranked.length > 1
    && !matchCandidateNames(ranked[0].row, hintExactNames).exact
    && ranked.slice(1, 5).some(other =>
      !shareCanonicalIdentityOrAlias(ranked[0].row, other.row)
      && matchCandidateNames(other.row, hintExactNames).exact);

  return ranked.map((item, idx) => {
    const ceiling = vlmCeilingFor(item.row, candidates);
    const noConflict = !item.equipmentConflict && !item.bodyPartConflict && !item.postureConflict && item.unsupportedVariants === 0 && !item.hasVersionSuffix;
    const strongEvidence = item.exactMatch;

    let marginOk = true;
    if (idx === 0 && ranked.length > 1) {
      const second = ranked[1];
      if (!shareCanonicalIdentityOrAlias(item.row, second.row)) {
        const fusedDiff = item.fusedScore - second.fusedScore;
        const logitDiff = item.logit - second.logit;
        const secondIsPenalizedVariant = second.unsupportedVariants > 0 || second.hasVersionSuffix || second.equipmentConflict || second.bodyPartConflict || second.postureConflict;
        if (fusedDiff < RANKING_WEIGHTS.highFusedMargin) {
          marginOk = false;
        } else if (!secondIsPenalizedVariant && logitDiff < -0.15) {
          marginOk = false;
        }
      }
    }

    let level: ConfidenceLevel;
    if (
      idx === 0
      && ceiling === 'high'
      && item.rawScore >= RANKING_WEIGHTS.highScoreFloor
      && noConflict
      && strongEvidence
      && !confusableTop
      && !hintConflict
      && marginOk
    ) {
      level = 'high';
    } else if (
      item.rawScore >= RANKING_WEIGHTS.mediumScoreFloor
      && !item.equipmentConflict
      && !item.bodyPartConflict
      && !item.postureConflict
    ) {
      level = ceiling === 'low' ? 'low' : 'medium';
    } else {
      level = 'low';
    }

    return { ...item, level };
  });
}

function rowSignalText(row: RetrievalRow): string {
  return [row.name_en, row.name_zh, ...(Array.isArray(row.aliases) ? row.aliases : [])]
    .map(cleanText)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function confusableRoleOf(row: Pick<RetrievalRow, 'name_en' | 'name_zh' | 'aliases' | 'body_part'>): string {
  const text = rowSignalText(row as RetrievalRow);
  const bodyPart = cleanText(row.body_part).toLowerCase();
  if (/leg extension|腿屈伸/.test(text)) return 'leg-ext';
  if (/leg curl|腿弯举/.test(text)) return 'leg-curl';
  if (/hack squat|哈克深蹲|哈克/.test(text)) return 'hack-squat';
  if (/leg press|腿举|蹬腿/.test(text)) return 'leg-press';
  if (/pec deck|pec fly|chest fly|seated fly|蝴蝶|夹胸/.test(text)) return 'pec-deck';
  if ((bodyPart === 'chest' && /\bpress\b|推胸|卧推/.test(text)) || /chest press|推胸/.test(text)) {
    return 'chest-press';
  }
  if ((bodyPart === 'shoulders' && /\bpress\b|推肩|推举/.test(text)) || /shoulder press|推肩/.test(text)) {
    return 'shoulder-press';
  }
  return '';
}

export function hasConfusablePair(rows: ReadonlyArray<Pick<RetrievalRow, 'name_en' | 'name_zh' | 'aliases' | 'body_part'>>): boolean {
  if (!Array.isArray(rows) || rows.length < 2) return false;
  const r0 = confusableRoleOf(rows[0]);
  const r1 = confusableRoleOf(rows[1]);
  if (!r0 || !r1 || r0 === r1) return false;
  const pressFly = new Set(['chest-press', 'shoulder-press', 'pec-deck']);
  if (pressFly.has(r0) && pressFly.has(r1)) return true;
  const legExtCurl = new Set(['leg-ext', 'leg-curl']);
  if (legExtCurl.has(r0) && legExtCurl.has(r1)) return true;
  const hackLegPress = new Set(['hack-squat', 'leg-press']);
  return hackLegPress.has(r0) && hackLegPress.has(r1);
}

function clipClarificationText(value: unknown, max: number): string {
  const text = cleanText(value);
  if (!text) return '';
  return (text.length > max ? text.slice(0, max) : text).trim();
}

function cleanClarificationList(rawList: unknown): ClarificationChip[] {
  if (!Array.isArray(rawList)) return [];
  const out: ClarificationChip[] = [];
  const seen = new Set<string>();
  for (const entry of rawList) {
    if (out.length >= MAX_CLARIFICATIONS) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    const label = clipClarificationText(obj.label, MAX_CLARIFICATION_LABEL);
    const prompt = clipClarificationText(obj.prompt, MAX_CLARIFICATION_PROMPT);
    if (!label || !prompt || seen.has(label)) continue;
    seen.add(label);
    out.push({ label, prompt });
  }
  return out;
}

function fallbackChipsFor(
  rows: ReadonlyArray<RetrievalRow>,
  recognition: RetrievalRecognition,
  hintText: string,
): ClarificationChip[] {
  const fb = recognition.fallback;
  const candidates = recognition.candidates ?? [];
  const bodyParts = new Set([
    ...(Array.isArray(fb.bodyParts) ? fb.bodyParts : []),
    ...rows.map(row => cleanText(row.body_part).toLowerCase()),
    ...candidates.map(c => cleanText(c.bodyPart).toLowerCase()),
  ].filter(Boolean));
  const equipment = new Set([
    ...(Array.isArray(fb.equipment) ? fb.equipment : []),
    ...rows.map(row => cleanText(row.equipment).toLowerCase()),
    ...candidates.map(c => cleanText(c.equipment).toLowerCase()),
  ].filter(Boolean));
  const textBlob = [
    hintText,
    fb.understanding,
    ...rows.map(rowSignalText),
    ...candidates.map(c => [c.name, c.nameEn].map(cleanText).filter(Boolean).join(' ')),
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const roles = new Set(rows.slice(0, 3).map(confusableRoleOf).filter(Boolean));
  if (
    roles.has('hack-squat') || roles.has('leg-press')
    || /hack squat|leg press|哈克|腿举|蹬腿|倒蹬/.test(textBlob)
    || (equipment.has('sled machine') && bodyParts.has('upper legs'))
  ) {
    return CLARIFICATION_HACK_LEG_PRESS.map(chip => ({ ...chip }));
  }
  if (
    roles.has('leg-ext') || roles.has('leg-curl')
    || /leg extension|leg curl|腿屈伸|腿弯举/.test(textBlob)
  ) {
    return CLARIFICATION_LEG_EXT_CURL.map(chip => ({ ...chip }));
  }
  const hasFreeWeightPressOnly = (equipment.has('barbell') || equipment.has('dumbbell'))
    && !equipment.has('leverage machine')
    && !equipment.has('cable')
    && !equipment.has('smith machine')
    && !/\bmachine|lever|器械|蝴蝶机|夹胸/.test(textBlob);
  if (
    roles.has('chest-press') || roles.has('shoulder-press') || roles.has('pec-deck')
    || /chest press|shoulder press|pec deck|pec fly|chest fly|推胸|推肩|蝴蝶机|夹胸/.test(textBlob)
    || (!hasFreeWeightPressOnly
      && equipment.has('leverage machine')
      && (bodyParts.has('chest') || bodyParts.has('shoulders'))
      && !/\b(?:pull|row|pulldown|raise|拉|划船)/.test(textBlob))
  ) {
    return CLARIFICATION_PRESS_FLY.map(chip => ({ ...chip }));
  }

  const hintRaw = cleanText(hintText);
  const understandingRaw = cleanText(fb.understanding);
  const hasFitnessClues = rows.length > 0
    || bodyParts.size > 0
    || equipment.size > 0
    || FITNESS_CLUE_PATTERN.test(hintRaw)
    || (FITNESS_CLUE_PATTERN.test(understandingRaw) && !NON_FITNESS_NEGATION_PATTERN.test(understandingRaw));
  return hasFitnessClues ? CLARIFICATION_GENERIC_MACHINE.map(chip => ({ ...chip })) : [];
}

export function deriveClarificationChips(
  items: ReadonlyArray<{ row: RetrievalRow; level?: ConfidenceLevel }>,
  recognition: RetrievalRecognition,
  hintText = '',
): ClarificationChip[] {
  const rows = items.map(item => item.row);
  if (items.length > 0 && items[0]?.level === 'high' && !hasConfusablePair(rows)) {
    return [];
  }
  const chips = cleanClarificationList(recognition.clarifications);
  if (chips.length >= 2) return chips;
  const fallback = fallbackChipsFor(rows, recognition, hintText);
  if (!fallback.length) return chips;
  const seen = new Set(chips.map(chip => chip.label));
  for (const chip of fallback) {
    if (chips.length >= MAX_CLARIFICATIONS) break;
    if (seen.has(chip.label)) continue;
    seen.add(chip.label);
    chips.push(chip);
  }
  return chips;
}
