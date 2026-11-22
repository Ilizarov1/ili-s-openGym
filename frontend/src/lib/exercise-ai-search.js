// Shared AI candidate matcher for the Web client and the RN app.
//
// The model never sees the catalogue and never returns ids. It returns common
// names plus optional English names and slug hints; this module turns those
// names into catalogue exercises using the same search engine the app already
// uses, with a character-level fallback for Chinese names.
//
// The whole module is pure: the caller injects the candidate pool, the
// `searchScored` function and the allowed fallback slugs. Fuse.js stays out of
// this path; it only powers the keyword zero-result suggestions.

import SEARCH_META from './exercise-search-meta.json' with { type: 'json' }

export const BASE_FLOOR = 60
export const EQ_BONUS = 25
export const BP_BONUS = 15
export const CJK_DICE_MIN = 0.6
export const CJK_LCS_MIN = 3
export const CJK_MARGIN = 0.12

export const AI_MATCH_CONSTANTS = Object.freeze({
  BASE_FLOOR,
  EQ_BONUS,
  BP_BONUS,
  CJK_DICE_MIN,
  CJK_LCS_MIN,
  CJK_MARGIN,
})

const LEVEL_RANK = { low: 1, medium: 2, high: 3 }
const QUERY_PICK_LIMIT = 3
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const UNSUPPORTED_VARIANT_GROUPS = [
  { en: /\binner\b/, zh: ['内侧'] },
  { en: /\boutdoor\b/, zh: ['户外'] },
  { en: /\bincline\b/, zh: ['上斜'] },
  { en: /\bdecline\b/, zh: ['下斜'] },
  { en: /\b(?:single arm|one arm)\b/, zh: ['单臂', '单手'] },
  { en: /\b(?:single leg|one leg)\b/, zh: ['单腿', '单脚'] },
  { en: /\breverse\b/, zh: ['反向', '反握'] },
]
const MACHINE_HINTS = new Set([
  'barbell', 'smith machine', 'leverage machine', 'sled machine', 'cable',
  'dumbbell', 'ez barbell', 'olympic barbell', 'trap bar', 'kettlebell',
  'weight plate', 'weighted', 'landmine', 'hammer',
])
const BODYWEIGHT = new Set(['body weight', 'band', 'resistance band'])
const FIXED_MACHINES = new Set(['leverage machine', 'sled machine', 'smith machine'])
const FREE_WEIGHTS = new Set([
  'barbell', 'ez barbell', 'olympic barbell', 'trap bar', 'dumbbell', 'kettlebell', 'weight plate',
])
const POSTURE_SLUGS = new Set(SEARCH_META?.postures || [
  'seated', 'standing', 'supine', 'prone', 'side_lying', 'kneeling', 'bent_over', 'hanging',
])
const COMPATIBLE_BODY_PARTS = {
  chest: new Set(['chest', 'shoulders']),
  shoulders: new Set(['shoulders', 'chest', 'upper arms', 'back']),
  back: new Set(['back', 'shoulders', 'upper arms', 'waist']),
  'upper arms': new Set(['upper arms', 'chest', 'back', 'shoulders', 'lower arms']),
  'lower arms': new Set(['lower arms', 'upper arms']),
  'upper legs': new Set(['upper legs', 'lower legs', 'waist']),
  'lower legs': new Set(['lower legs', 'upper legs']),
  waist: new Set(['waist', 'back', 'upper legs']),
  neck: new Set(['neck', 'shoulders', 'back']),
}
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'on', 'in', 'with', 'for', 'and', 'or', 'to', 'at', 'by', 'from',
  'is', 'are', 'this', 'that', 'your', 'you', 'my', 'me', 'it', 'its',
])
const BROAD_WORDS = new Set([
  'exercise', 'machine', 'weight', 'gym', 'equipment', 'movement', 'lift', 'workout',
  'training', 'train', 'body', 'person', 'people', 'man', 'woman', 'photo', 'picture',
  'image', 'selfie', 'food', 'plate', 'meal', 'landscape', 'sky', 'tree', 'background',
])

const clean = value => String(value == null ? '' : value).trim()
const isCjkName = value => CJK.test(String(value || ''))
const normalize = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim()
const normalizePhrase = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/-/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

export function stripNonSemanticSuffix(name) {
  let cur = clean(name)
  while (cur) {
    const next = cur
      .replace(/\s*\((?:plate[- ]?loaded|pin[- ]?loaded|selectorized|version\s*\d+|v\.?\s*\d+|male|female|挂片式|插销式|男|女)\)\s*$/i, '')
      .replace(/\s+v\.?\s*\d+\s*$/i, '')
      .trim()
    if (next === cur) break
    cur = next
  }
  return cur
}

function builtInAliasesOf(exercise) {
  if (!exercise || exercise.custom || !exercise.id) return []
  const aliases = SEARCH_META?.byId?.[exercise.id]?.a
  return Array.isArray(aliases) ? aliases : []
}

function exercisePostureOf(exercise) {
  if (!exercise) return ''
  if (!exercise.custom && exercise.id) {
    const metaPosture = SEARCH_META?.byId?.[exercise.id]?.p
    if (POSTURE_SLUGS.has(metaPosture)) return metaPosture
  }
  const direct = clean(exercise.posture || exercise.p)
  return POSTURE_SLUGS.has(direct) ? direct : ''
}

function postureFromText(text, bodyPartHint = '') {
  const raw = clean(text)
  if (!raw) return ''
  const lower = normalizePhrase(raw)
  if (/\bside lying\b|\blateral lying\b/.test(lower) || /侧卧/.test(raw)) return 'side_lying'
  if (/\b(?:half )?kneeling\b|\bon knees\b|\bquadruped\b/.test(lower) || /跪姿|半跪/.test(raw)) return 'kneeling'
  if (/\bhanging\b|\bsuspended\b/.test(lower) || /悬垂/.test(raw)) return 'hanging'
  if (/\b(?:seated|sitting)\b/.test(lower) || /坐姿/.test(raw)) return 'seated'
  if (/\bstanding\b|\bupright\b/.test(lower) || /站姿/.test(raw)) return 'standing'
  if (/\bprone\b|\bface down\b|\bchest supported\b/.test(lower) || /俯卧/.test(raw)) return 'prone'
  if (/\bsupine\b|\breclined\b|\bflat bench\b/.test(lower) || /仰卧|平躺/.test(raw)) return 'supine'
  if (/\bbent over\b|\bromanian\b|\bgood morning\b|\bhip hinge\b/.test(lower) || /俯身/.test(raw)) return 'bent_over'
  if (/\blying\b/.test(lower)) {
    if (
      (bodyPartHint === 'upper legs' && /\b(?:leg curl|curl|hamstring)\b/.test(lower))
      || /\b(?:leg curl|reverse fly|rear delt|back extension|hyperextension|seal row)\b/.test(lower)
    ) {
      return 'prone'
    }
    return 'supine'
  }
  return ''
}

function inferCandidatePosture(candidate, hintText, validBodyPart = '') {
  const explicit = clean(candidate?.posture)
  if (POSTURE_SLUGS.has(explicit)) return explicit
  const fromNames = postureFromText(`${clean(candidate?.name)} ${clean(candidate?.nameEn)}`, validBodyPart)
  if (fromNames) return fromNames
  return postureFromText(hintText, validBodyPart)
}

function bodyPartConflictFor(hintBodyPart, exercise) {
  const bp = clean(hintBodyPart)
  if (!bp) return false
  const compatible = COMPATIBLE_BODY_PARTS[bp]
  if (!compatible) return false
  const exBp = clean(exercise?.bp || exercise?.bodyPart)
  if (!exBp) return false
  return !compatible.has(exBp)
}

function nameOf(exercise) {
  return clean(exercise?.name || exercise?.n || exercise?.id || '')
}

function namesOf(exercise) {
  const out = [exercise?.name, exercise?.n, ...(Array.isArray(exercise?.aliases) ? exercise.aliases : [])]
  return [...new Set(out.map(clean).filter(Boolean))]
}

function wordsOf(value, generic = null) {
  return normalize(value)
    .split(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/)
    .filter(word => word.length > 1 && !STOP_WORDS.has(word) && !BROAD_WORDS.has(word) && !generic?.has(word))
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      current.push(value)
      if (value < rowMin) rowMin = value
    }
    if (rowMin > max) return max + 1
    previous = current
  }
  return previous[b.length]
}

// A candidate must point at the exercise's own name, not just at a shared
// equipment or body-part word. Otherwise a food photo caption ("food on a
// plate") finds "strongman hood stones" through "plate", or "barbell
// exercise" matches half the catalogue. One strong name word is enough; a
// single fuzzy token must be at least five characters, so "bnech" still
// finds "bench press" while "food" does not become "hood stones".
function hasNameEvidence(queries, exercise, genericWords) {
  const nameWords = [...new Set([...namesOf(exercise), ...builtInAliasesOf(exercise)].flatMap(name =>
    normalize(name).split(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/).filter(Boolean)))]
  if (!nameWords.length) return false
  for (const query of queries) {
    const tokens = wordsOf(query, genericWords)
    if (!tokens.length) continue
    let strong = 0
    let weak = 0
    for (const token of tokens) {
      if (nameWords.includes(token) || (token.length >= 3 && nameWords.some(word => word.startsWith(token)))) {
        strong++
        continue
      }
      if (token.length >= 5) {
        const max = token.length < 7 ? 1 : 2
        if (nameWords.some(word => word.length >= 4 && editDistance(token, word, max) <= max)) weak++
      }
    }
    if (strong > 0) return true
    if (weak > 0 && tokens.length === 1) return true
  }
  return false
}

function bigrams(value) {
  const chars = [...String(value || '')].filter(char => !/[\s\-‐-―()/,.&]/.test(char))
  if (chars.length < 2) return chars.length ? [chars[0]] : []
  const out = []
  for (let index = 0; index < chars.length - 1; index++) out.push(chars[index] + chars[index + 1])
  return out
}

export function diceCoefficient(a, b) {
  const left = bigrams(a)
  const right = bigrams(b)
  if (!left.length || !right.length) return 0
  const counts = new Map()
  for (const gram of left) counts.set(gram, (counts.get(gram) || 0) + 1)
  let shared = 0
  for (const gram of right) {
    const have = counts.get(gram) || 0
    if (have > 0) {
      shared++
      counts.set(gram, have - 1)
    }
  }
  return (2 * shared) / (left.length + right.length)
}

export function longestCommonSubstring(a, b) {
  const left = [...String(a || '')]
  const right = [...String(b || '')]
  if (!left.length || !right.length) return 0
  let best = 0
  let previous = new Array(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i++) {
    const current = new Array(right.length + 1).fill(0)
    for (let j = 1; j <= right.length; j++) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1
        if (current[j] > best) best = current[j]
      }
    }
    previous = current
  }
  return best
}

// The level rule speaks of an exact name or alias, not of a score: a typo
// ("bnech press") and a shorter common name ("bench press") score high while
// pointing at a variant, and must not be shown as "high". Non-semantic wrapper
// suffixes (e.g. "(plate loaded)", "v. 2") and curated standard aliases qualify.
function exactNameMatch(exercise, values) {
  const wanted = values.map(normalize).filter(Boolean)
  if (!wanted.length) return false
  const candidates = [...namesOf(exercise), ...builtInAliasesOf(exercise)]
  for (const candidate of candidates) {
    if (wanted.includes(normalize(candidate))) return true
    const stripped = stripNonSemanticSuffix(candidate)
    if (stripped && stripped !== candidate && wanted.includes(normalize(stripped))) return true
  }
  return false
}

function levelFor(modelLevel, { exact, fallback }) {
  const model = LEVEL_RANK[modelLevel] ? modelLevel : 'low'
  if (fallback) return 'low'
  if (exact && model === 'high') return 'high'
  if (exact) return 'medium'
  return 'medium'
}

function strongerLevel(current, next) {
  return (LEVEL_RANK[next] || 0) > (LEVEL_RANK[current] || 0) ? next : current
}

function conflictFor(hint, exercise) {
  const equipment = clean(hint)
  const exEq = clean(exercise?.eq)
  if (!equipment || !exEq) return false
  if (MACHINE_HINTS.has(equipment) && BODYWEIGHT.has(exEq)) return true
  if (FIXED_MACHINES.has(equipment) && FREE_WEIGHTS.has(exEq)) return true
  if (FREE_WEIGHTS.has(equipment) && FIXED_MACHINES.has(exEq)) return true
  if (BODYWEIGHT.has(equipment) && (FIXED_MACHINES.has(exEq) || FREE_WEIGHTS.has(exEq))) return true
  return false
}

// The character fallback's own verdict: the exercise it would pick, or why it
// will not pick one — no name qualified at all, or the top two are too close
// to call (CJK_MARGIN). The diagnostics need that distinction: only a
// candidate actually dropped by the ambiguity is reported as ambiguous.
function cjkFallback(pool, candidateName) {
  const scored = []
  for (let index = 0; index < pool.length; index++) {
    const exercise = pool[index]
    let best = null
    for (const name of namesOf(exercise)) {
      if (!isCjkName(name)) continue
      const dice = diceCoefficient(candidateName, name)
      const lcs = longestCommonSubstring(candidateName, name)
      if (dice < CJK_DICE_MIN || lcs < CJK_LCS_MIN) continue
      if (!best || dice > best.dice || (dice === best.dice && lcs > best.lcs)) {
        best = { dice, lcs }
      }
    }
    if (best) scored.push({ exercise, index, ...best })
  }
  scored.sort((a, b) => b.dice - a.dice || b.lcs - a.lcs || a.index - b.index)
  if (!scored.length) return { exercise: null, ambiguous: false }
  if (scored.length > 1 && scored[0].dice - scored[1].dice < CJK_MARGIN) {
    return { exercise: null, ambiguous: true }
  }
  return { exercise: scored[0].exercise, ambiguous: false }
}

function filterSlugs(values, allowed) {
  if (!Array.isArray(values)) return undefined
  const set = allowed ? new Set(allowed) : null
  const out = []
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue
    if (set && !set.has(value)) continue
    if (!out.includes(value)) out.push(value)
  }
  return out.length ? out : undefined
}

function cleanFallback(raw, hintText, bodyPartValues, equipmentValues) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  let understanding = clean(source.understanding)
  if (understanding.length > 400) understanding = understanding.slice(0, 400)
  if (!understanding) understanding = clean(hintText).slice(0, 400) || '未能理解这次输入，请补充描述'
  const bodyParts = filterSlugs(source.bodyParts, bodyPartValues)
  const equipment = filterSlugs(source.equipment, equipmentValues)
  return {
    understanding,
    ...(bodyParts ? { bodyParts } : {}),
    ...(equipment ? { equipment } : {}),
  }
}

function genericSet(bodyPartValues, equipmentValues) {
  const words = []
  for (const value of [...(bodyPartValues || []), ...(equipmentValues || [])]) {
    for (const word of normalize(value).split(/[^a-z0-9]+/).filter(Boolean)) {
      if (word.length < 2) continue
      words.push(word)
      if (word.length > 3 && word.endsWith('s')) words.push(word.slice(0, -1))
    }
  }
  return new Set(words)
}

// One diagnostics recorder per match() call. The sink is isolated at this one
// boundary so a logging error can never change a match result. Production
// passes only `emit`; the evaluation CLI also passes expected ids to rank and
// opts into carrying the raw query.
function recorderOf(diagnostics, isPublic) {
  if (!diagnostics || typeof diagnostics.emit !== 'function') return null
  const evaluation = diagnostics.evaluation && Array.isArray(diagnostics.evaluation.expectedIds)
    ? {
      expectedIds: diagnostics.evaluation.expectedIds,
      includeQueries: diagnostics.evaluation.includeQueries === true,
    }
    : null
  return {
    evaluation,
    isPublic,
    emit(event) {
      try { diagnostics.emit(event) } catch { /* a broken sink must not change the match */ }
    },
  }
}

// One query's recall, snapshotted from the synchronous ranking before the
// pipeline reads its first entry, so an empty result is still reported.
// `top` is the actual first five results filtered down to trusted-public
// entries (never refilled from further down the list); the evaluation
// additionally gets each expected id's 1-based rank in the full unfiltered
// list, null when absent.
function recallEvent(recorder, candidateIndex, query, queryOrigin, results) {
  const top = []
  for (let index = 0; index < results.length && index < 5; index++) {
    const exercise = results[index]?.exercise
    if (exercise && recorder.isPublic(exercise)) {
      top.push({ id: exercise.id, score: results[index].score })
    }
  }
  const event = {
    stage: 'recall',
    candidateIndex,
    queryOrigin,
    queryWordCount: clean(query).split(/\s+/).filter(Boolean).length,
    hitCount: results.length,
    top,
  }
  if (recorder.evaluation) {
    const expectedRanks = []
    for (const expectedId of recorder.evaluation.expectedIds) {
      let rank = null
      for (let index = 0; index < results.length; index++) {
        if (results[index]?.exercise?.id === expectedId) { rank = index + 1; break }
      }
      expectedRanks.push(rank)
    }
    event.expectedRanks = expectedRanks
    if (recorder.evaluation.includeQueries) event.query = query
  }
  recorder.emit(event)
}

function keywordRejection(hit, exact, queries, candidateEquipment, validBodyPart, genericWords) {
  if (!exact) {
    if (hit.score < BASE_FLOOR) return 'below_floor'
    if (!hasNameEvidence(queries, hit.exercise, genericWords)) return 'no_name_evidence'
  }
  if (conflictFor(candidateEquipment, hit.exercise)) return 'equipment_conflict'
  if (bodyPartConflictFor(validBodyPart, hit.exercise)) return 'body_part_conflict'
  return null
}

function unsupportedVariantCount(exercise, { primaryName = '', nameEn = '', hintText = '' } = {}) {
  const cataloguePhrase = normalizePhrase(clean(exercise?.n) || clean(exercise?.name))
  if (!cataloguePhrase) return 0
  const primaryRaw = clean(primaryName)
  const nameEnRaw = clean(nameEn)
  const hintRaw = clean(hintText)
  const primaryPhrase = normalizePhrase(primaryRaw)
  const nameEnPhrase = normalizePhrase(nameEnRaw)
  const hintPhrase = normalizePhrase(hintRaw)
  let count = 0
  for (const group of UNSUPPORTED_VARIANT_GROUPS) {
    if (!group.en.test(cataloguePhrase)) continue
    const supported = group.en.test(primaryPhrase)
      || group.en.test(nameEnPhrase)
      || group.en.test(hintPhrase)
      || group.zh.some(term => primaryRaw.includes(term) || nameEnRaw.includes(term) || hintRaw.includes(term))
    if (!supported) count++
  }
  return count
}

function isBetterQueryHit(next, current) {
  if (next.exact !== current.exact) return next.exact
  if (next.equipmentMatch !== current.equipmentMatch) return next.equipmentMatch
  if (next.bodyPartMatch !== current.bodyPartMatch) return next.bodyPartMatch
  if (next.eq === current.eq) {
    if (next.postureMatch !== current.postureMatch) return next.postureMatch
    if (next.unsupportedVariants !== current.unsupportedVariants) {
      return next.unsupportedVariants < current.unsupportedVariants
    }
  }
  return false
}

function isBetterCandidateQueryHit(next, current) {
  if (next.exact !== current.exact) return next.exact
  if (next.equipmentMatch !== current.equipmentMatch) return next.equipmentMatch
  if (next.bodyPartMatch !== current.bodyPartMatch) return next.bodyPartMatch
  if (next.postureMatch !== current.postureMatch) return next.postureMatch
  if (next.unsupportedVariants !== current.unsupportedVariants) {
    return next.unsupportedVariants < current.unsupportedVariants
  }
  if (next.score !== current.score) return next.score > current.score
  return false
}

function pickQueryHit(
  results,
  queries,
  names,
  equipmentHint,
  bodyPartHint,
  candidateEquipment,
  genericWords,
  hintText,
  inferredPosture = '',
) {
  const limit = Math.min(results.length, QUERY_PICK_LIMIT)
  const [primaryName = '', nameEn = ''] = names
  let picked = null
  let exactConflict = null
  for (let index = 0; index < limit; index++) {
    const entry = results[index]
    if (!entry || !entry.exercise) continue
    const exercise = entry.exercise
    const exact = exactNameMatch(exercise, names)
    const rejection = keywordRejection(entry, exact, queries, candidateEquipment, bodyPartHint, genericWords)
    if (rejection) {
      if (exact && rejection === 'equipment_conflict' && !exactConflict) {
        exactConflict = { exercise, score: entry.score }
      }
      continue
    }
    const eq = clean(exercise.eq)
    const unsupportedVariants = unsupportedVariantCount(exercise, { primaryName, nameEn, hintText })
    const hit = {
      exercise,
      score: entry.score,
      exact,
      equipmentMatch: !!equipmentHint && eq === equipmentHint,
      bodyPartMatch: !!bodyPartHint && clean(exercise.bp) === bodyPartHint,
      postureMatch: Boolean(inferredPosture && exercisePostureOf(exercise) === inferredPosture),
      eq,
      unsupportedVariants,
      queryRank: index,
    }
    if (!picked || isBetterQueryHit(hit, picked)) picked = hit
  }
  if (exactConflict && (!picked || !picked.exact)) {
    return { hit: null, exactConflict }
  }
  return { hit: picked, exactConflict: null }
}

function compareRankedHits(a, b) {
  if (a.fallback !== b.fallback) return a.fallback ? 1 : -1
  const levelDiff = (LEVEL_RANK[b.modelLevel] || 0) - (LEVEL_RANK[a.modelLevel] || 0)
  if (levelDiff !== 0) return levelDiff
  if (a.exact !== b.exact) return a.exact ? -1 : 1
  if (a.equipmentMatch !== b.equipmentMatch) return a.equipmentMatch ? -1 : 1
  if (a.bodyPartMatch !== b.bodyPartMatch) return a.bodyPartMatch ? -1 : 1
  if (a.postureMatch !== b.postureMatch) return a.postureMatch ? -1 : 1
  if (a.unsupportedVariants !== b.unsupportedVariants) {
    return a.unsupportedVariants - b.unsupportedVariants
  }
  if (a.candidateIndex !== b.candidateIndex) return a.candidateIndex - b.candidateIndex
  if (a.queryRank !== b.queryRank) return a.queryRank - b.queryRank
  const nameDiff = a.name.localeCompare(b.name)
  if (nameDiff !== 0) return nameDiff
  return String(a.exerciseId).localeCompare(String(b.exerciseId))
}

function matchOne(
  candidate,
  pool,
  searchScored,
  genericWords,
  recorder,
  candidateIndex,
  equipmentValues,
  bodyPartValues,
  hintText,
) {
  const filterEvent = (decision, exercise) => {
    if (!recorder) return
    const event = { stage: 'filter', candidateIndex, decision }
    if (exercise && recorder.isPublic(exercise)) event.id = exercise.id
    recorder.emit(event)
  }
  if (!candidate || typeof candidate !== 'object') {
    filterEvent('invalid_candidate')
    return null
  }
  const name = clean(candidate.name)
  if (!name) {
    filterEvent('invalid_candidate')
    return null
  }
  const nameEn = clean(candidate.nameEn)
  const names = [name, nameEn]
  const validCandidateEquipment = typeof candidate.equipment === 'string'
    ? filterSlugs([clean(candidate.equipment)], equipmentValues)?.[0] || ''
    : ''
  const validCandidateBodyPart = typeof candidate.bodyPart === 'string'
    ? filterSlugs([clean(candidate.bodyPart)], bodyPartValues)?.[0] || ''
    : ''
  const inferredPosture = inferCandidatePosture(candidate, hintText, validCandidateBodyPart)
  const rawModelLevel = typeof candidate.level === 'string' ? candidate.level.trim().toLowerCase() : ''
  const modelLevel = LEVEL_RANK[rawModelLevel] ? rawModelLevel : 'low'
  // Run the English query whenever nameEn is present and differs from name
  // after normalization; diagnostics tag that query as the English recall.
  const useEnglishQuery = !!nameEn && normalize(nameEn) !== normalize(name)
  const queries = useEnglishQuery ? [nameEn, name] : [name]
  const queryOrigins = useEnglishQuery ? ['english', 'primary'] : ['primary']
  let best = null
  let firstBest = null
  let exactConflict = null
  for (let index = 0; index < queries.length; index++) {
    const query = queries[index]
    const results = searchScored(pool, query) || []
    if (recorder) recallEvent(recorder, candidateIndex, query, queryOrigins[index], results)
    const first = results[0]
    if (first && first.exercise && (!firstBest || first.score > firstBest.score)) {
      firstBest = { exercise: first.exercise, score: first.score }
    }
    const { hit: picked, exactConflict: queryExactConflict } = pickQueryHit(
      results,
      queries,
      names,
      validCandidateEquipment,
      validCandidateBodyPart,
      candidate.equipment,
      genericWords,
      hintText,
      inferredPosture,
    )
    if (queryExactConflict && (!exactConflict || queryExactConflict.score > exactConflict.score)) {
      exactConflict = queryExactConflict
    }
    if (!picked) continue
    if (!best || isBetterCandidateQueryHit(picked, best)) {
      best = picked
    }
  }
  if (exactConflict && (!best || !best.exact)) {
    filterEvent('equipment_conflict', exactConflict.exercise)
    return null
  }

  // An exact name or saved alias is authoritative even when the shared engine
  // scores it below a name word (aliases live in the corpus, not in nameWords).
  const exactName = !!best && best.exact
  let fallback = false
  // Why a null `best` was dropped; only read at the `!best` return, where the
  // candidate is actually rejected.
  let rejection = 'no_hit'
  let rejectedExercise = null
  // The keyword engine splits on spaces, so a Chinese candidate name is one
  // token: an inexact hit can be a substring of a longer name and outrank the
  // exercise the user meant. For a non-exact CJK name the character fallback
  // decides; when it is ambiguous, an evidence-backed keyword hit still
  // stands, otherwise the candidate is dropped — and only that drop, caused
  // by the top two being too close, is reported as the ambiguity rejection.
  if (!exactName && isCjkName(name)) {
    const pick = cjkFallback(pool, name)
    if (pick.exercise) {
      best = { exercise: pick.exercise, score: 0 }
      fallback = true
    } else if (!best || !hasNameEvidence(queries, best.exercise, genericWords)) {
      if (pick.ambiguous) {
        rejection = 'cjk_ambiguous'
        rejectedExercise = null
      } else if (best) {
        rejection = 'no_name_evidence'
        rejectedExercise = best.exercise
      } else if (firstBest) {
        const firstExact = exactNameMatch(firstBest.exercise, names)
        rejection = !firstExact && !hasNameEvidence(queries, firstBest.exercise, genericWords)
          ? 'no_name_evidence'
          : keywordRejection(
            firstBest,
            firstExact,
            queries,
            candidate.equipment,
            validCandidateBodyPart,
            genericWords,
          ) || 'no_hit'
        rejectedExercise = firstBest.exercise
      }
      best = null
    }
  }
  if (!best) {
    if (rejection === 'no_hit' && firstBest) {
      rejection = keywordRejection(
        firstBest,
        exactNameMatch(firstBest.exercise, names),
        queries,
        candidate.equipment,
        validCandidateBodyPart,
        genericWords,
      ) || 'no_hit'
      rejectedExercise = firstBest.exercise
    }
    filterEvent(rejection, rejectedExercise)
    return null
  }
  const finalRejection = keywordRejection(
    best,
    fallback || exactName,
    queries,
    candidate.equipment,
    validCandidateBodyPart,
    genericWords,
  )
  if (finalRejection) {
    filterEvent(finalRejection, best.exercise)
    return null
  }

  const exercise = best.exercise

  let adjusted = fallback ? 0 : best.score
  if (candidate.equipment && clean(candidate.equipment) === clean(exercise.eq)) adjusted += EQ_BONUS
  if (candidate.bodyPart && clean(candidate.bodyPart) === clean(exercise.bp)) adjusted += BP_BONUS
  const exact = !fallback && exactName
  const level = levelFor(modelLevel, { exact, fallback })
  const rationale = clean(candidate.rationale).slice(0, 200) || name
  const equipmentMatch = Boolean(validCandidateEquipment && clean(exercise.eq) === validCandidateEquipment)
  const bodyPartMatch = Boolean(validCandidateBodyPart && clean(exercise.bp) === validCandidateBodyPart)
  const postureMatch = Boolean(inferredPosture && exercisePostureOf(exercise) === inferredPosture)
  const unsupportedVariants = unsupportedVariantCount(exercise, { primaryName: name, nameEn, hintText })
  const queryRank = fallback ? 0 : best.queryRank

  filterEvent(fallback ? 'accepted_cjk_fallback' : 'accepted', exercise)
  return {
    exerciseId: exercise.id,
    name: nameOf(exercise) || name,
    rationale,
    level,
    score: adjusted,
    exact,
    fallback,
    modelLevel,
    equipmentMatch,
    bodyPartMatch,
    postureMatch,
    unsupportedVariants,
    candidateIndex,
    queryRank,
    exercise,
  }
}

const MAX_CLARIFICATIONS = 3
const MAX_CLARIFICATION_LABEL = 16
const MAX_CLARIFICATION_PROMPT = 60

const CLARIFICATION_PRESS_FLY = Object.freeze([
  Object.freeze({ label: '往前推（练胸）', prompt: '这是往前推的坐姿推胸器械' }),
  Object.freeze({ label: '往上推（练肩）', prompt: '这是往上推的坐姿推肩器械' }),
  Object.freeze({ label: '双臂夹胸（蝴蝶机）', prompt: '这是双臂向中间夹胸的蝴蝶机' }),
])

const CLARIFICATION_LEG_EXT_CURL = Object.freeze([
  Object.freeze({ label: '大腿前侧（腿屈伸）', prompt: '这是踢腿练大腿前侧的坐姿腿屈伸' }),
  Object.freeze({ label: '大腿后侧（腿弯举）', prompt: '这是屈膝练大腿后侧的坐姿腿弯举' }),
])

const CLARIFICATION_HACK_LEG_PRESS = Object.freeze([
  Object.freeze({ label: '站姿斜板下蹲（哈克）', prompt: '这是肩垫顶肩下蹲的哈克深蹲器械' }),
  Object.freeze({ label: '坐姿/斜躺蹬腿（腿举）', prompt: '这是脚踩踏板蹬腿的腿举器械' }),
])

const CLARIFICATION_GENERIC_MACHINE = Object.freeze([
  Object.freeze({ label: '固定器械（挂片/插销）', prompt: '这是一台商用固定器械' }),
  Object.freeze({ label: '绳索/龙门架', prompt: '这是用绳索滑轮的龙门架动作' }),
])

const FITNESS_CLUE_PATTERN = /\b(?:machine|cable|pulley|lever|sled|smith|press|row|pull|pulldown|curl|extension|squat|raise|fly|pec|chest|shoulder|back|leg|quad|hamstring|calf|glute|arm|bicep|tricep|gym|workout)\b|器械|机器|绳索|滑轮|龙门架|史密斯|推胸|推肩|卧推|划船|下拉|弯举|屈伸|深蹲|腿举|夹胸|蝴蝶机|飞鸟|胸|肩|背|腿|臂|健身/i
const NON_FITNESS_NEGATION_PATTERN = /没有看到|未见|并未看到|并不是|不是.*(?:健身|器械|训练|运动)|非健身|与健身无关|与训练无关|no\s+(?:gym|fitness|exercise|workout)\s+equipment/i

function clipClarificationText(value, max) {
  const text = clean(value)
  if (!text) return ''
  return (text.length > max ? text.slice(0, max) : text).trim()
}

function cleanClarificationList(rawList) {
  if (!Array.isArray(rawList)) return []
  const out = []
  const seen = new Set()
  for (const entry of rawList) {
    if (out.length >= MAX_CLARIFICATIONS) break
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const label = clipClarificationText(entry.label, MAX_CLARIFICATION_LABEL)
    const prompt = clipClarificationText(entry.prompt, MAX_CLARIFICATION_PROMPT)
    if (!label || !prompt || seen.has(label)) continue
    seen.add(label)
    out.push({ label, prompt })
  }
  return out
}

function itemSignalText(item) {
  const ex = item?.exercise
  return [
    item?.name,
    item?.nameEn,
    ex?.name,
    ex?.n,
    ex?.nameEn,
    ...(Array.isArray(ex?.aliases) ? ex.aliases : []),
  ]
    .map(clean)
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function confusableRoleOf(item) {
  const text = itemSignalText(item)
  const bodyPart = clean(item?.exercise?.bodyPart || item?.bodyPart).toLowerCase()
  if (/leg extension|腿屈伸/.test(text)) return 'leg-ext'
  if (/leg curl|腿弯举/.test(text)) return 'leg-curl'
  if (/hack squat|哈克深蹲|哈克/.test(text)) return 'hack-squat'
  if (/leg press|腿举|蹬腿/.test(text)) return 'leg-press'
  if (/pec deck|pec fly|chest fly|seated fly|蝴蝶|夹胸/.test(text)) return 'pec-deck'
  if ((bodyPart === 'chest' && /\bpress\b|推胸|卧推/.test(text)) || /chest press|推胸/.test(text)) {
    return 'chest-press'
  }
  if ((bodyPart === 'shoulders' && /\bpress\b|推肩|推举/.test(text)) || /shoulder press|推肩/.test(text)) {
    return 'shoulder-press'
  }
  return ''
}

function hasConfusablePair(items) {
  if (!Array.isArray(items) || items.length < 2) return false
  const r0 = confusableRoleOf(items[0])
  const r1 = confusableRoleOf(items[1])
  if (!r0 || !r1 || r0 === r1) return false
  const pressFly = new Set(['chest-press', 'shoulder-press', 'pec-deck'])
  if (pressFly.has(r0) && pressFly.has(r1)) return true
  const legExtCurl = new Set(['leg-ext', 'leg-curl'])
  if (legExtCurl.has(r0) && legExtCurl.has(r1)) return true
  const hackLegPress = new Set(['hack-squat', 'leg-press'])
  return hackLegPress.has(r0) && hackLegPress.has(r1)
}

function fallbackChipsFor(items, source, hintText) {
  const list = Array.isArray(items) ? items : []
  const fb = source?.fallback && typeof source.fallback === 'object' ? source.fallback : {}
  const candidates = Array.isArray(source?.candidates) ? source.candidates : []
  const bodyParts = new Set([
    ...(Array.isArray(fb.bodyParts) ? fb.bodyParts : []),
    ...list.map(item => clean(item?.exercise?.bodyPart || item?.bodyPart).toLowerCase()),
    ...candidates.map(c => clean(c?.bodyPart).toLowerCase()),
  ].filter(Boolean))
  const equipment = new Set([
    ...(Array.isArray(fb.equipment) ? fb.equipment : []),
    ...list.map(item => clean(item?.exercise?.equipment || item?.equipment).toLowerCase()),
    ...candidates.map(c => clean(c?.equipment).toLowerCase()),
  ].filter(Boolean))
  const textBlob = [
    hintText,
    fb.understanding,
    ...list.map(itemSignalText),
    ...candidates.map(c => [c?.name, c?.nameEn].map(clean).filter(Boolean).join(' ')),
  ]
    .map(clean)
    .filter(Boolean)
    .join(' ')
    .toLowerCase()

  const roles = new Set(list.slice(0, 3).map(confusableRoleOf).filter(Boolean))
  if (
    roles.has('hack-squat') || roles.has('leg-press')
    || /hack squat|leg press|哈克|腿举|蹬腿|倒蹬/.test(textBlob)
    || (equipment.has('sled machine') && bodyParts.has('upper legs'))
  ) {
    return CLARIFICATION_HACK_LEG_PRESS.map(chip => ({ ...chip }))
  }
  if (
    roles.has('leg-ext') || roles.has('leg-curl')
    || /leg extension|leg curl|腿屈伸|腿弯举/.test(textBlob)
  ) {
    return CLARIFICATION_LEG_EXT_CURL.map(chip => ({ ...chip }))
  }
  const hasFreeWeightPressOnly = (equipment.has('barbell') || equipment.has('dumbbell'))
    && !equipment.has('leverage machine')
    && !equipment.has('cable')
    && !equipment.has('smith machine')
    && !/\bmachine|lever|器械|蝴蝶机|夹胸/.test(textBlob)
  if (
    roles.has('chest-press') || roles.has('shoulder-press') || roles.has('pec-deck')
    || /chest press|shoulder press|pec deck|pec fly|chest fly|推胸|推肩|蝴蝶机|夹胸/.test(textBlob)
    || (!hasFreeWeightPressOnly
      && equipment.has('leverage machine')
      && (bodyParts.has('chest') || bodyParts.has('shoulders'))
      && !/\b(?:pull|row|pulldown|raise|拉|划船)/.test(textBlob))
  ) {
    return CLARIFICATION_PRESS_FLY.map(chip => ({ ...chip }))
  }

  const hintRaw = clean(hintText)
  const understandingRaw = clean(fb.understanding)
  const hasFitnessClues = list.length > 0
    || bodyParts.size > 0
    || equipment.size > 0
    || FITNESS_CLUE_PATTERN.test(hintRaw)
    || (FITNESS_CLUE_PATTERN.test(understandingRaw) && !NON_FITNESS_NEGATION_PATTERN.test(understandingRaw))
  return hasFitnessClues ? CLARIFICATION_GENERIC_MACHINE.map(chip => ({ ...chip })) : []
}

/**
 * Derive up to 3 one-tap Chinese disambiguation chips for ambiguous AI search results.
 * Returns [] when the top match is clear high-confidence without a confusable neighbour,
 * or when an empty result has no gym/fitness clues.
 */
export function deriveClarificationChips(items, source, hintText = '') {
  const list = Array.isArray(items) ? items : []
  if (list.length > 0 && list[0]?.level === 'high' && !hasConfusablePair(list)) {
    return []
  }
  const chips = cleanClarificationList(source?.clarifications)
  if (chips.length >= 2) return chips
  const fallback = fallbackChipsFor(list, source, hintText)
  if (!fallback.length) return chips
  const seen = new Set(chips.map(chip => chip.label))
  for (const chip of fallback) {
    if (chips.length >= MAX_CLARIFICATIONS) break
    if (seen.has(chip.label)) continue
    seen.add(chip.label)
    chips.push(chip)
  }
  return chips
}

/**
 * @param {{
 *   searchScored: (list: object[], query: string) => { exercise: object, score: number }[],
 *   list: object[] | (() => object[]),
 *   translate?: (value: string) => string,
 *   bodyPartValues?: string[],
 *   equipmentValues?: string[],
 *   isPublicExercise?: (exercise: object) => boolean,
 * }} options
 */
export function createExerciseAiSearch(options) {
  const {
    searchScored,
    list,
    bodyPartValues,
    equipmentValues,
    isPublicExercise,
  } = options || {}
  if (typeof searchScored !== 'function') throw new Error('createExerciseAiSearch needs searchScored')
  const genericWords = genericSet(bodyPartValues, equipmentValues)
  // Trusted-public entries decide which ids the diagnostics may ever carry.
  // Without a source of trust nothing is public, so no id is reported.
  const isPublic = typeof isPublicExercise === 'function' ? isPublicExercise : () => false

  const poolOf = () => {
    const value = typeof list === 'function' ? list() : list
    return Array.isArray(value) ? value : []
  }

  return {
    match(output, hints = {}) {
      const recorder = recorderOf(hints.diagnostics, isPublic)
      const startedAt = recorder ? Date.now() : 0
      const source = output?.structured && typeof output.structured === 'object'
        ? output.structured
        : output && typeof output === 'object' ? output : {}
      const candidates = Array.isArray(source.candidates) ? source.candidates : []
      const fallback = cleanFallback(source.fallback, hints.hintText, bodyPartValues, equipmentValues)
      const pool = poolOf()
      const byId = new Map()
      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
        const hit = matchOne(
          candidates[candidateIndex],
          pool,
          searchScored,
          genericWords,
          recorder,
          candidateIndex,
          equipmentValues,
          bodyPartValues,
          hints.hintText,
        )
        if (!hit) continue
        const current = byId.get(hit.exerciseId)
        if (!current) {
          byId.set(hit.exerciseId, { ...hit, rationales: [hit.rationale] })
          continue
        }
        if (recorder) {
          recorder.emit({ stage: 'filter', candidateIndex, decision: 'deduplicated' })
        }
        const rationales = [...current.rationales]
        if (hit.rationale && !rationales.includes(hit.rationale) && rationales.length < 2) {
          rationales.push(hit.rationale)
        }
        const better = compareRankedHits(hit, current) < 0 ? hit : current
        byId.set(hit.exerciseId, {
          ...better,
          level: strongerLevel(current.level, hit.level),
          rationales,
        })
      }
      const items = [...byId.values()]
        .sort(compareRankedHits)
        .slice(0, 5)
        .map(({
          rationales,
          score: _score,
          exact: _exact,
          fallback: _fallback,
          modelLevel: _modelLevel,
          equipmentMatch: _equipmentMatch,
          bodyPartMatch: _bodyPartMatch,
          postureMatch: _postureMatch,
          unsupportedVariants: _unsupportedVariants,
          candidateIndex: _candidateIndex,
          queryRank: _queryRank,
          ...item
        }) => ({
          ...item,
          rationale: rationales.join('；'),
        }))
      if (recorder) {
        const publicIds = []
        let customCount = 0
        for (const item of items) {
          if (isPublic(item.exercise)) publicIds.push(item.exerciseId)
          else customCount += 1
        }
        recorder.emit({
          stage: 'display',
          resultCount: items.length,
          publicIds,
          customCount,
          fallbackOnly: items.length === 0,
          elapsedMs: Date.now() - startedAt,
        })
      }
      const clarifications = deriveClarificationChips(
        items,
        { ...(source && typeof source === 'object' ? source : {}), fallback },
        hints.hintText,
      )
      return {
        items,
        fallback,
        clarifications,
      }
    },
  }
}
