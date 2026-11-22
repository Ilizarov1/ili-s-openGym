#!/usr/bin/env node
// Deterministically generates frontend/src/lib/exercise-search-meta.json
// from EXDB, zh translations, and scripts/exercise-search-meta-overrides.json,
// enforcing posture enum validity and alias collision / safety guards.
//
//   node scripts/generate-exercise-search-meta.mjs           write meta JSON
//   node scripts/generate-exercise-search-meta.mjs --check   exit 1 if out of date

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXDB } from '../frontend/src/lib/exercises-data.js';
import zhNames from '../frontend/src/exercise-names/zh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OVERRIDES_PATH = path.join(ROOT, 'scripts', 'exercise-search-meta-overrides.json');
const OUT_PATH = path.join(ROOT, 'frontend', 'src', 'lib', 'exercise-search-meta.json');
const checkOnly = process.argv.includes('--check');

export const POSTURE_SLUGS = Object.freeze([
  'seated',
  'standing',
  'supine',
  'prone',
  'side_lying',
  'kneeling',
  'bent_over',
  'hanging',
]);

const POSTURE_SET = new Set(POSTURE_SLUGS);

export const BANNED_BROAD_ALIASES = new Set([
  '高位下拉',
  '绳索划船',
  '坐姿划船',
  '弯举',
  '练胸的',
  '卧推',
  '深蹲',
  '硬拉',
  '推胸',
  '推肩',
  '划船',
  '飞鸟',
  '夹胸',
  '提踵',
  '臂屈伸',
  '下拉',
  '腿举',
  '腿屈伸',
  '腿弯举',
  'bench press',
  'chest press',
  'shoulder press',
  'lat pulldown',
  'lateral pulldown',
  'squat',
  'deadlift',
  'row',
  'seated row',
  'curl',
  'bicep curl',
  'biceps curl',
  'fly',
  'chest fly',
  'leg press',
  'leg extension',
  'leg curl',
  'calf raise',
  'pull up',
  'pull-up',
  'chin up',
  'chin-up',
  'dip',
  'crunch',
  'plank',
  'shrug',
]);

export const VARIANT_CHECKS = [
  { key: 'incline', aliasRe: /\bincline\b|上斜/, targetRe: /\bincline\b|上斜/ },
  { key: 'decline', aliasRe: /\bdecline\b|下斜/, targetRe: /\bdecline\b|下斜/ },
  { key: 'reverse', aliasRe: /\breverse\b|反向|反握/, targetRe: /\breverse\b|反向|反握/ },
  { key: 'single_arm', aliasRe: /\b(?:single|one)[- ]?arm\b|单臂|单手/, targetRe: /\b(?:single|one)[- ]?arm\b|单臂|单手/ },
  { key: 'single_leg', aliasRe: /\b(?:single|one)[- ]?leg\b|单腿|单脚/, targetRe: /\b(?:single|one)[- ]?leg\b|单腿|单脚/ },
];

export const normalizeMetaText = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[-‐-―]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function stripNonSemanticSuffix(name) {
  let cur = String(name || '').trim();
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

export function inferAutoPosture(exercise, zhName = '') {
  const en = String(exercise?.n || '').toLowerCase();
  const z = String(zhName || '');
  const eq = String(exercise?.eq || '');

  // Explicit posture cues in priority order.
  if (/\bside[- ]?lying\b|\blateral lying\b/.test(en) || /侧卧/.test(z)) return 'side_lying';
  if (/\b(?:half[- ]?)?kneeling\b|\bon knees\b|\bquadruped\b/.test(en) || /跪姿|半跪/.test(z)) return 'kneeling';
  if (/\bhanging\b|\bsuspended\b/.test(en) || /悬垂/.test(z)) return 'hanging';
  if (/\b(?:seated|sitting|sitted)\b/.test(en) || /坐姿/.test(z)) return 'seated';
  if (/\bstanding\b/.test(en) || /站姿/.test(z)) return 'standing';
  if (eq !== 'stationary bike' && !/\bbike\b/.test(en) && /\bupright\b/.test(en)) return 'standing';
  if (
    /\bprone\b|\bface[- ]?down\b|\bchest[- ]?supported\b|\bwith chest support\b|\bsuperman\b/.test(en)
    || /俯卧(?!撑)|胸部支撑|腹部支撑/.test(z)
  ) {
    return 'prone';
  }
  if (/\bpush[- ]?up\b/.test(en) && !/\bstanding\b|\bwall\b|\bincline\b/.test(en)) return 'prone';
  if (/俯卧撑/.test(z) && !/站姿|上斜|靠墙/.test(z)) return 'prone';
  if (/\bplank\b/.test(en) && !/\bside\b|\breverse\b/.test(en)) return 'prone';

  if (/\bsupine\b|\breclined\b|\bglute bridge\b|\bhip thrust\b|\bskull crusher\b/.test(en) || /仰卧/.test(z)) {
    return 'supine';
  }
  if (/\blying\b/.test(en)) {
    if (
      /leg curl|hamstring|back extension|hyperextension|reverse fly|rear delt|seal row|row on rack|\b[tywi]\b/.test(en)
      || /腿弯举|俯卧|后束/.test(z)
    ) {
      return 'prone';
    }
    return 'supine';
  }
  if (
    /\bbent[- ]?over\b|\bromanian\b|\bgood morning\b|\bhip hinge\b|\bstiff[- ]?leg(?:ged)? deadlift\b/.test(en)
    || /俯身|罗马尼亚硬拉|直腿硬拉|早安式/.test(z)
  ) {
    return 'bent_over';
  }
  if (
    (/\bpull[- ]?up\b|\bchin[- ]?up\b|\bchest dip\b|\btriceps dip\b/.test(en))
    && !/\bbench\b|\bfloor\b|\bchair\b|\bbox\b|\binverted\b|\bhorizontal\b/.test(en)
    && eq !== 'resistance band'
    && eq !== 'band'
  ) {
    return 'hanging';
  }

  // Conservative gym-family defaults when no contradicting explicit posture exists.
  if (
    (eq === 'leverage machine' || eq === 'cable')
    && /\b(?:chest press|shoulder press|military press|pec deck|pec fly|leg extension|pulldown)\b/.test(en)
    && !/\bfloor\b|\bbench press machine\b/.test(en)
  ) {
    return 'seated';
  }
  if (eq === 'stationary bike' || eq === 'upper body ergometer') return 'seated';
  if (eq === 'sled machine' && /\b(?:45|angled)\b/.test(en) && /\bleg press\b/.test(en)) return 'supine';
  if (['barbell', 'dumbbell', 'smith machine', 'ez barbell'].includes(eq) && /\bbench press\b/.test(en)) return 'supine';
  if (/\bsquat\b/.test(en) && !/\b(?:stretch|frog|jump)\b/.test(en)) return 'standing';
  if (/\bupright row\b/.test(en)) return 'standing';

  return null;
}

export function buildExerciseSearchMeta({ exdb = EXDB, zhMap = zhNames, overrides = {} } = {}) {
  const byExId = new Map(exdb.map(entry => [String(entry.id), entry]));
  const rawNamesByNorm = new Map();
  const addRawNorm = (norm, id) => {
    if (!norm) return;
    let set = rawNamesByNorm.get(norm);
    if (!set) {
      set = new Set();
      rawNamesByNorm.set(norm, set);
    }
    set.add(id);
  };

  for (const entry of exdb) {
    const id = String(entry.id);
    addRawNorm(normalizeMetaText(entry.n), id);
    addRawNorm(normalizeMetaText(zhMap?.[id] || ''), id);
  }

  const overrideById = overrides?.byId && typeof overrides.byId === 'object' ? overrides.byId : {};
  for (const id of Object.keys(overrideById)) {
    if (!byExId.has(id)) {
      throw new Error(`Override references unknown exercise id: ${id}`);
    }
  }

  // Track candidates for stripped auto aliases to detect cross-id collisions upfront.
  const strippedCandidates = [];
  const strippedCounts = new Map();
  for (const entry of exdb) {
    const id = String(entry.id);
    const zhName = String(zhMap?.[id] || '');
    for (const raw of [entry.n, zhName]) {
      if (!raw) continue;
      const stripped = stripNonSemanticSuffix(raw);
      if (!stripped || stripped === raw.trim()) continue;
      const norm = normalizeMetaText(stripped);
      if (!norm) continue;
      strippedCandidates.push({ id, alias: stripped, norm });
      let ids = strippedCounts.get(norm);
      if (!ids) {
        ids = new Set();
        strippedCounts.set(norm, ids);
      }
      ids.add(id);
    }
  }

  const autoAliasesById = new Map();
  for (const item of strippedCandidates) {
    if (BANNED_BROAD_ALIASES.has(item.norm)) continue;
    const rawOwners = rawNamesByNorm.get(item.norm);
    if (rawOwners && ([...rawOwners].some(owner => owner !== item.id))) continue;
    const strippedOwners = strippedCounts.get(item.norm);
    if (strippedOwners && strippedOwners.size > 1) continue;
    const list = autoAliasesById.get(item.id) || [];
    if (!list.some(existing => normalizeMetaText(existing) === item.norm)) {
      list.push(item.alias);
      autoAliasesById.set(item.id, list);
    }
  }

  const aliasOwner = new Map();
  const byId = {};

  for (const entry of exdb) {
    const id = String(entry.id);
    const zhName = String(zhMap?.[id] || '');
    const ov = overrideById[id] || {};
    const posture = ov.p !== undefined ? ov.p : inferAutoPosture(entry, zhName);
    if (posture !== null && posture !== undefined && !POSTURE_SET.has(posture)) {
      throw new Error(`Invalid posture slug "${posture}" on id ${id}`);
    }

    const combined = [...(autoAliasesById.get(id) || []), ...(Array.isArray(ov.a) ? ov.a : [])];
    const deduped = [];
    const localSeen = new Set();
    const targetBlob = normalizeMetaText(`${entry.n || ''} ${zhName}`);

    for (const rawAlias of combined) {
      const cleanAlias = String(rawAlias || '').trim();
      const norm = normalizeMetaText(cleanAlias);
      if (!norm) continue;
      if (BANNED_BROAD_ALIASES.has(norm)) {
        throw new Error(`Broad/ambiguous alias "${cleanAlias}" is forbidden (id ${id})`);
      }
      for (const check of VARIANT_CHECKS) {
        if (check.aliasRe.test(norm) && !check.targetRe.test(targetBlob)) {
          throw new Error(`Variant mismatch for alias "${cleanAlias}" on id ${id} (${entry.n})`);
        }
      }
      const prevOwner = aliasOwner.get(norm);
      if (prevOwner && prevOwner !== id) {
        throw new Error(`Exact alias collision "${cleanAlias}" between ids ${prevOwner} and ${id}`);
      }
      aliasOwner.set(norm, id);
      if (localSeen.has(norm)) continue;
      localSeen.add(norm);
      deduped.push(cleanAlias);
    }

    if (posture || deduped.length) {
      const record = {};
      if (posture) record.p = posture;
      if (deduped.length) record.a = deduped;
      byId[id] = record;
    }
  }

  return {
    version: 1,
    postures: [...POSTURE_SLUGS],
    byId,
  };
}

export function serializeExerciseSearchMeta(meta) {
  const lines = [
    '{',
    `  "version": ${JSON.stringify(meta.version)},`,
    `  "postures": ${JSON.stringify(meta.postures)},`,
    '  "byId": {',
  ];
  const ids = Object.keys(meta.byId).sort();
  ids.forEach((id, idx) => {
    const comma = idx < ids.length - 1 ? ',' : '';
    lines.push(`    ${JSON.stringify(id)}: ${JSON.stringify(meta.byId[id])}${comma}`);
  });
  lines.push('  }', '}', '');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const overrides = fs.existsSync(OVERRIDES_PATH)
    ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'))
    : {};
  const meta = buildExerciseSearchMeta({ overrides });
  const serialized = serializeExerciseSearchMeta(meta);
  const current = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : null;

  const entries = Object.values(meta.byId);
  const withPosture = entries.filter(x => x.p).length;
  const withAliases = entries.filter(x => Array.isArray(x.a) && x.a.length).length;
  const aliasTotal = entries.reduce((sum, x) => sum + (x.a?.length || 0), 0);

  if (checkOnly) {
    if (current !== serialized) {
      console.error(`generate-exercise-search-meta: ${path.relative(ROOT, OUT_PATH)} is out of date`);
      process.exit(1);
    }
    console.log(
      `generate-exercise-search-meta: up to date (entries=${entries.length}, posture=${withPosture}, withAliases=${withAliases}, aliases=${aliasTotal})`,
    );
  } else {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, serialized, 'utf8');
    console.log(
      `generate-exercise-search-meta: wrote ${path.relative(ROOT, OUT_PATH)} (entries=${entries.length}, posture=${withPosture}, withAliases=${withAliases}, aliases=${aliasTotal}, bytes=${Buffer.byteLength(serialized, 'utf8')})`,
    );
  }
}
