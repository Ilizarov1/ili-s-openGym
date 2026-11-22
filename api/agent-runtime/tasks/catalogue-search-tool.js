/* search_catalogue: read-only catalogue lookup tool for exercise-search.v1.
 *
 * Pure JS with zero Node built-ins so Metro can bundle it via index.js without
 * pulling in the 600KB JSON snapshot (hosts inject `entries` or `search`).
 */
import { AgentError } from '../errors.js';
import VOCABULARY from './exercise-search-vocabulary.json' with { type: 'json' };

export const CATALOGUE_SEARCH_TOOL_ID = 'search_catalogue';

const BODY_PART_SLUGS = Object.freeze([...VOCABULARY.bodyParts]);
const EQUIPMENT_SLUGS = Object.freeze([...VOCABULARY.equipment]);

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 15;
const MAX_QUERIES = 4;
const MAX_QUERY_CHARS = 80;

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const GENERIC_TOKENS = new Set([
  'lever', 'leverage', 'sled', 'cable', 'smith', 'machine', 'plate', 'loaded',
  'seated', 'standing', 'lying', 'incline', 'decline', 'flat', 'v', '2', '3', '4',
  'with', 'on', 'the', 'a', 'an', 'of', 'to', 'and', 'pov', 'side', 'back',
]);
const SPECIFIC_REQUEST_TOKENS = new Set([
  'one', 'single', 'alternate', 'alternating', 'unilateral', 'assisted', 'band',
  'banded', 'form', 'check', 'pov', 'reverse', 'kneeling', 'decline', 'incline',
]);
const NOISY_VARIANT_RE = /\b(v\.\s*[2-9]|form check|back pov|side pov|one arm|single arm|single leg|one leg|alternate|alternating|two-one|banded|assisted)\b/i;

const CANONICAL_BONUS_IDS = new Set([
  '0576', '0603', '1454', '1030', '0596', '1299',
  '0585', '0599', '0586',
  '0743', '5516', '0739', '2224', '2267', '1391', '0594', '2335',
  '0025', '0043', '0047', '0289', '0314', '0652', '0198', '0027',
  '0861', '0032', '0292', '0293', '0606', '1162', '0405', '0334',
]);

// Synonym expansions applied at query time for apparatus and joined terms.
const WORD_SYNONYMS = {
  machine: [['lever'], ['sled'], ['smith'], ['machine']],
  lever: [['lever'], ['leverage']],
  leverage: [['lever'], ['leverage']],
  sled: [['sled']],
  cable: [['cable']],
  plateloaded: [['plate', 'loaded'], ['lever'], ['sled']],
  pinloaded: [['lever'], ['stack'], ['machine']],
  selectorized: [['lever'], ['machine']],
  pecdeck: [['pec', 'deck'], ['seated', 'fly'], ['fly']],
  pec: [['pec', 'deck'], ['pectorals']],
  butterfly: [['pec', 'deck'], ['seated', 'fly']],
  tbar: [['t', 'bar']],
  chestpress: [['chest', 'press']],
  shoulderpress: [['shoulder', 'press']],
  ohp: [['shoulder', 'press'], ['overhead', 'press'], ['military', 'press']],
  legpress: [['leg', 'press']],
  legextension: [['leg', 'extension']],
  legcurl: [['leg', 'curl']],
  hacksquat: [['hack', 'squat']],
  latpulldown: [['lat', 'pulldown'], ['pulldown']],
  db: [['dumbbell']],
  bb: [['barbell']],
  kb: [['kettlebell']],
  bw: [['body', 'weight']],
  degrees: [['45']],
  degree: [['45']],
};

const PHRASE_SYNONYMS = [
  { re: /\bplate[\s-]+loaded\b/i, expansions: [['lever'], ['sled'], ['plate', 'loaded']] },
  { re: /\bpin[\s-]+loaded\b/i, expansions: [['lever'], ['stack'], ['machine']] },
  { re: /\bpec[\s-]+deck\b/i, expansions: [['pec', 'deck'], ['seated', 'fly'], ['fly']] },
  { re: /\bt[\s-]+bar\b/i, expansions: [['t', 'bar']] },
  { re: /\bleg\s+curl\b/i, expansions: [['leg', 'curl'], ['hamstring']] },
  { re: /\bhamstring\s+curl\b/i, expansions: [['leg', 'curl']] },
  { re: /\bquad\s+extension\b/i, expansions: [['leg', 'extension']] },
  { re: /\bcalf\s+(?:raise|press)\b/i, expansions: [['calf', 'raise'], ['calf', 'press']] },
];

const ZH_SYNONYMS = [
  { re: /推胸|卧推机|胸推/, en: ['chest', 'press'] },
  { re: /上斜.*推胸|上斜胸推/, en: ['incline', 'chest', 'press'] },
  { re: /推肩|肩推|肩部推举/, en: ['shoulder', 'press'] },
  { re: /蝴蝶机|夹胸|坐姿飞鸟/, en: ['pec', 'deck', 'fly'] },
  { re: /腿屈伸|伸膝/, en: ['leg', 'extension'] },
  { re: /腿弯举|屈膝|勾腿/, en: ['leg', 'curl'] },
  { re: /腿举|倒蹬|蹬腿/, en: ['leg', 'press'] },
  { re: /哈克/, en: ['hack', 'squat'] },
  { re: /提踵|小腿推/, en: ['calf', 'raise'] },
  { re: /高位下拉|下拉/, en: ['lat', 'pulldown'] },
  { re: /划船/, en: ['row'] },
  { re: /滑车|雪橇/, en: ['sled'] },
  { re: /杠杆|挂片|固定器械/, en: ['lever'] },
];

// Confusable commercial-machine sibling families (appended inside `limit`
// whenever primary recall returns real matches in that family).
const CONFUSABLE_FAMILIES = [
  {
    trigger: /\b(chest\s+press|shoulder\s+press|pec\s+deck|seated\s+fly|pec\s+fly)\b|推胸|肩推|肩部推举|蝴蝶机|夹胸/i,
    ids: ['0576', '0603', '1454', '1030', '1299', '0596'],
  },
  {
    trigger: /\b(leg\s+extension|leg\s+curl|quad\s+extension|hamstring\s+curl)\b|腿屈伸|腿弯举/i,
    ids: ['0585', '0599', '0586'],
  },
  {
    trigger: /\b(hack\s+squat|leg\s+press|calf\s+raise|calf\s+press)\b|哈克|腿举|倒蹬|提踵|小腿推举/i,
    ids: ['0743', '5516', '0739', '2267', '1391', '0594', '2224', '2335'],
  },
];

const FREE_WEIGHT_ONLY_RE = /\b(barbell|dumbbell|kettlebell|band|ez barbell|bodyweight|body weight)\b/i;
const MACHINE_HINT_RE = /\b(lever|leverage|sled|machine|pec|deck|hack|plate|pin|selectorized)\b/i;

function normalizeEn(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/°/g, ' ')
    .replace(/[\-_‐‑–—/,.()[\]{}:;'"!?&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeZh(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\-_‐‑–—/,.()（）【】[\]{}:;'"!?·、，。]+/g, '');
}

function tokenizeEn(norm) {
  return norm ? norm.split(' ').filter(Boolean) : [];
}

function cjkBigrams(text) {
  const chars = [...text].filter(ch => CJK_RE.test(ch));
  const bigrams = [];
  for (let i = 0; i < chars.length - 1; i++) {
    bigrams.push(chars[i] + chars[i + 1]);
  }
  return { chars, bigrams };
}

function toCompactItem(entry) {
  return {
    id: String(entry.id || ''),
    nameEn: String(entry.n ?? entry.nameEn ?? ''),
    nameZh: String(entry.zh ?? entry.nameZh ?? ''),
    equipment: String(entry.eq ?? entry.equipment ?? ''),
    bodyPart: String(entry.bp ?? entry.bodyPart ?? ''),
    target: String(entry.tg ?? entry.target ?? ''),
  };
}

function indexEntry(raw) {
  const item = toCompactItem(raw);
  const normEn = normalizeEn(item.nameEn);
  const tokensEn = tokenizeEn(normEn);
  const joinedEn = tokensEn.join('');
  const normZh = normalizeZh(item.nameZh);
  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases.filter(a => typeof a === 'string' && a.trim())
    : [];
  const normAliasesEn = aliases.map(normalizeEn).filter(Boolean);
  const normAliasesZh = aliases.map(normalizeZh).filter(Boolean);
  return {
    item,
    normEn,
    tokensEn,
    tokenSetEn: new Set(tokensEn),
    joinedEn,
    normZh,
    normAliasesEn,
    normAliasesZh,
    isNoisyVariant: NOISY_VARIANT_RE.test(item.nameEn),
    isCanonical: CANONICAL_BONUS_IDS.has(item.id),
  };
}

function buildSynonymTokens(rawQuery, primaryTokens) {
  const extraTokenGroups = [];
  for (const token of primaryTokens) {
    const expansions = WORD_SYNONYMS[token];
    if (expansions) {
      const modifierOnly = GENERIC_TOKENS.has(token) || token === 'plateloaded' || token === 'pinloaded'
        || token === 'selectorized' || token === 'degrees' || token === 'degree';
      for (const group of expansions) extraTokenGroups.push({ tokens: group, modifierOnly });
    }
  }
  for (const { re, expansions } of PHRASE_SYNONYMS) {
    if (re.test(rawQuery)) {
      const modifierOnly = /\b(plate|pin)[\s-]+loaded\b/i.test(rawQuery);
      for (const group of expansions) extraTokenGroups.push({ tokens: group, modifierOnly });
    }
  }
  for (const { re, en } of ZH_SYNONYMS) {
    if (re.test(rawQuery)) {
      const modifierOnly = re.source === '滑车|雪橇' || re.source === '杠杆|挂片|固定器械';
      extraTokenGroups.push({ tokens: en, modifierOnly });
    }
  }
  return extraTokenGroups;
}

function scoreEntryForQuery(entry, querySpec) {
  const { raw, normEn, tokens, joined, normZh, cjk, extraGroups, specificTokens } = querySpec;
  let score = 0;

  if (normEn && entry.normEn) {
    if (entry.normEn === normEn) {
      score += 140;
    } else if (normEn.length >= 3 && entry.normEn.includes(normEn)) {
      score += 95;
    } else if (joined.length >= 5 && entry.joinedEn.includes(joined)) {
      score += 75;
    }
  }

  const queryHasSpecific = tokens.some(t => !GENERIC_TOKENS.has(t));
  let nonGenericMatched = 0;

  if (tokens.length && entry.tokensEn.length) {
    let matched = 0;
    let tokenScore = 0;
    for (const token of tokens) {
      const isGeneric = GENERIC_TOKENS.has(token);
      const weight = isGeneric ? 10 : 24;
      if (entry.tokenSetEn.has(token)) {
        matched++;
        if (!isGeneric) nonGenericMatched++;
        tokenScore += weight;
      } else if (token.length >= 4 && entry.tokensEn.some(t => t.startsWith(token))) {
        matched += 0.8;
        if (!isGeneric) nonGenericMatched += 0.8;
        tokenScore += Math.round(weight * 0.75);
      }
    }
    const minRatioOk = tokens.length <= 2 ? matched >= 1 : matched / tokens.length >= 0.5;
    if (matched > 0 && (!queryHasSpecific || nonGenericMatched > 0) && minRatioOk) {
      score += tokenScore;
      if (matched >= tokens.length) {
        score += 45;
      } else if (tokens.length >= 2 && matched / tokens.length >= 0.65) {
        score += 18;
      }
    }
  }

  if (extraGroups.length && entry.tokensEn.length) {
    let bestGroupScore = 0;
    for (const group of extraGroups) {
      if (group.modifierOnly && queryHasSpecific && nonGenericMatched === 0) continue;
      let groupHits = 0;
      for (const token of group.tokens) {
        if (entry.tokenSetEn.has(token)) groupHits++;
      }
      if (groupHits === group.tokens.length && groupHits > 0) {
        bestGroupScore = Math.max(bestGroupScore, 22 + groupHits * 8);
      } else if (groupHits > 0) {
        bestGroupScore = Math.max(bestGroupScore, groupHits * 10);
      }
    }
    score += bestGroupScore;
  }

  if (normZh && entry.normZh) {
    if (entry.normZh === normZh) {
      score += 140;
    } else if (normZh.length >= 2 && entry.normZh.includes(normZh)) {
      score += 85 + Math.min(20, normZh.length * 3);
    } else if (cjk.bigrams.length) {
      let bgHits = 0;
      for (const bg of cjk.bigrams) {
        if (entry.normZh.includes(bg)) bgHits++;
      }
      if (bgHits > 0) {
        score += Math.min(65, bgHits * 18);
      }
    } else if (cjk.chars.length >= 2) {
      let chHits = 0;
      for (const ch of cjk.chars) {
        if (entry.normZh.includes(ch)) chHits++;
      }
      if (chHits >= cjk.chars.length) score += 45;
    }
  }

  if (normEn && entry.normAliasesEn.some(a => a === normEn || a.includes(normEn))) {
    score += 90;
  }
  if (normZh && entry.normAliasesZh.some(a => a === normZh || a.includes(normZh))) {
    score += 90;
  }

  if (score <= 0) return 0;

  if (entry.isNoisyVariant && !specificTokens) {
    score -= 12;
  }
  if (entry.isCanonical) {
    score += 10;
  }
  score -= Math.min(6, entry.tokensEn.length * 0.2);
  return score;
}

function buildQuerySpec(raw) {
  const normEn = normalizeEn(raw);
  const tokens = tokenizeEn(normEn);
  const joined = tokens.join('');
  const normZh = normalizeZh(raw);
  const cjk = cjkBigrams(normZh);
  const extraGroups = buildSynonymTokens(raw, tokens);
  const specificTokens = tokens.some(t => SPECIFIC_REQUEST_TOKENS.has(t));
  return { raw, normEn, tokens, joined, normZh, cjk, extraGroups, specificTokens };
}

function expandConfusableIds(queries, topEntries, equipmentFilter) {
  const eqList = Array.isArray(equipmentFilter) ? equipmentFilter : [];
  const onlyFreeWeightFilter = eqList.length > 0
    && !eqList.some(eq => eq === 'leverage machine' || eq === 'sled machine' || eq === 'smith machine' || eq === 'cable');
  const queryText = queries.join(' ');
  const topNames = topEntries.slice(0, 5).map(e => e.item.nameEn).join(' ');
  const topHasMachine = topEntries.slice(0, 5).some(
    e => e.item.equipment === 'leverage machine' || e.item.equipment === 'sled machine',
  );
  const explicitlyFreeWeight = FREE_WEIGHT_ONLY_RE.test(queryText) && !MACHINE_HINT_RE.test(queryText) && !topHasMachine;
  if (onlyFreeWeightFilter || explicitlyFreeWeight) return [];

  const combined = `${queryText} ${topNames}`;
  const out = [];
  for (const family of CONFUSABLE_FAMILIES) {
    if (family.trigger.test(combined)) {
      for (const id of family.ids) {
        if (!out.includes(id)) out.push(id);
      }
    }
  }
  return out;
}

function mergeWithContrast(primaryItems, contrastItems, limit) {
  const seen = new Set();
  const dedupedPrimary = [];
  for (const item of primaryItems) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    dedupedPrimary.push(item);
  }
  const uniqueContrast = [];
  const contrastSeen = new Set();
  for (const item of contrastItems) {
    if (!item || !item.id || contrastSeen.has(item.id)) continue;
    contrastSeen.add(item.id);
    uniqueContrast.push(item);
  }
  if (!uniqueContrast.length) {
    return dedupedPrimary.slice(0, limit);
  }
  // Reserve room within `limit` for confusable siblings not already in the top
  // primary slice, while preserving at least the top 5 primary matches.
  const maxContrastReserve = Math.max(0, limit - Math.min(limit, 5));
  const primaryFloor = Math.max(1, limit - Math.min(uniqueContrast.length, maxContrastReserve));
  const head = dedupedPrimary.slice(0, primaryFloor);
  const merged = [...head];
  const mergedIds = new Set(head.map(item => item.id));
  for (const item of uniqueContrast) {
    if (merged.length >= limit) break;
    if (mergedIds.has(item.id)) continue;
    mergedIds.add(item.id);
    merged.push(item);
  }
  for (const item of dedupedPrimary.slice(primaryFloor)) {
    if (merged.length >= limit) break;
    if (mergedIds.has(item.id)) continue;
    mergedIds.add(item.id);
    merged.push(item);
  }
  return merged.slice(0, limit);
}

/**
 * Create the read-only `search_catalogue` tool backed by injected entries
 * (compact snapshot on server/eval, `createLibrarySearch(...).aiSearch.pool` on RN)
 * or an optional injected `search` function.
 *
 * @param {{
 *   entries?: Array<Record<string, unknown>>,
 *   search?: (query: string, filters?: { equipment?: string[], bodyParts?: string[], limit?: number }) => unknown,
 * }} [options]
 */
export function createCatalogueSearchTool(options = {}) {
  const { entries = [], search } = options || {};
  let indexed = null;
  let byId = null;

  const ensureIndex = () => {
    if (indexed) return { indexed, byId };
    const list = [];
    const map = new Map();
    for (const raw of Array.isArray(entries) ? entries : []) {
      if (!raw || typeof raw !== 'object' || !raw.id) continue;
      const entry = indexEntry(raw);
      list.push(entry);
      if (!map.has(entry.item.id)) map.set(entry.item.id, entry);
    }
    indexed = list;
    byId = map;
    return { indexed, byId };
  };

  return {
    id: CATALOGUE_SEARCH_TOOL_ID,
    description: 'Read-only search across the exercise catalogue by 1-4 exercise queries, with optional soft equipment/bodyPart weighting and confusable sibling expansion (max 15 results).',
    argsSchema: {
      type: 'object',
      properties: {
        queries: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: MAX_QUERY_CHARS, pattern: '\\S' },
          minItems: 1,
          maxItems: MAX_QUERIES,
        },
        equipment: {
          type: 'array',
          items: { type: 'string', enum: EQUIPMENT_SLUGS },
        },
        bodyParts: {
          type: 'array',
          items: { type: 'string', enum: BODY_PART_SLUGS },
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIMIT,
        },
      },
      required: ['queries'],
      additionalProperties: false,
    },
    resultSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          maxItems: MAX_LIMIT,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              nameEn: { type: 'string' },
              nameZh: { type: 'string' },
              equipment: { type: 'string' },
              bodyPart: { type: 'string' },
              target: { type: 'string' },
            },
            required: ['id', 'nameEn', 'nameZh', 'equipment', 'bodyPart', 'target'],
            additionalProperties: false,
          },
        },
        total: { type: 'integer', minimum: 0 },
      },
      required: ['items', 'total'],
      additionalProperties: false,
    },
    async run(args) {
      const rawQueries = Array.isArray(args?.queries) ? args.queries : [];
      const queries = rawQueries
        .map(q => (typeof q === 'string' ? q.trim() : ''))
        .filter(Boolean);
      if (!queries.length || queries.length > MAX_QUERIES) {
        throw new AgentError('tool_args_invalid', 'queries must contain 1 to 4 non-empty strings');
      }
      const equipment = Array.isArray(args?.equipment) ? args.equipment : [];
      const bodyParts = Array.isArray(args?.bodyParts) ? args.bodyParts : [];
      const rawLimit = args?.limit === undefined ? DEFAULT_LIMIT : Number(args.limit);
      const limit = Number.isInteger(rawLimit)
        ? Math.max(1, Math.min(MAX_LIMIT, rawLimit))
        : DEFAULT_LIMIT;

      const store = ensureIndex();

      if (typeof search === 'function') {
        const collected = [];
        for (const query of queries) {
          const out = await search(query, { equipment, bodyParts, limit });
          const rows = Array.isArray(out) ? out : (Array.isArray(out?.items) ? out.items : []);
          for (const row of rows) {
            if (!row || typeof row !== 'object' || !row.id) continue;
            collected.push(toCompactItem(row));
          }
        }
        const wrappedTop = collected.slice(0, 5).map(item => ({ item }));
        const contrastIds = collected.length ? expandConfusableIds(queries, wrappedTop, equipment) : [];
        const contrastItems = contrastIds.map(id => store.byId.get(id)?.item).filter(Boolean);
        const items = mergeWithContrast(collected, contrastItems, limit);
        return { items, total: Math.max(items.length, collected.length) };
      }

      const eqSet = new Set(equipment);
      const bpSet = new Set(bodyParts);
      const specs = queries.map(buildQuerySpec);
      const scored = [];

      for (const entry of store.indexed) {
        let best = 0;
        let queryHits = 0;
        for (const spec of specs) {
          const qScore = scoreEntryForQuery(entry, spec);
          if (qScore > 0) {
            if (qScore >= 35) queryHits++;
            if (qScore > best) best = qScore;
          }
        }
        if (best <= 0) continue;
        let totalScore = best + (queryHits > 1 ? (queryHits - 1) * 10 : 0);
        if (eqSet.size && eqSet.has(entry.item.equipment)) totalScore += 25;
        if (bpSet.size && bpSet.has(entry.item.bodyPart)) totalScore += 20;
        scored.push({ entry, score: totalScore });
      }

      if (!scored.length) {
        return { items: [], total: 0 };
      }

      scored.sort((a, b) => (
        b.score - a.score
        || a.entry.item.nameEn.length - b.entry.item.nameEn.length
        || a.entry.item.id.localeCompare(b.entry.item.id)
      ));

      const topEntries = scored.slice(0, 5).map(s => s.entry);
      const contrastIds = expandConfusableIds(queries, topEntries, equipment);
      const contrastItems = contrastIds.map(id => store.byId.get(id)?.item).filter(Boolean);
      const primaryItems = scored.slice(0, MAX_LIMIT * 2).map(s => s.entry.item);
      const items = mergeWithContrast(primaryItems, contrastItems, limit);
      return {
        items,
        total: Math.max(items.length, scored.length),
      };
    },
  };
}
