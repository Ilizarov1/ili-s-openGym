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
  const nameWords = [...new Set(namesOf(exercise).flatMap(name =>
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
// pointing at a variant, and must not be shown as "high".
function exactNameMatch(exercise, values) {
  const wanted = values.map(normalize).filter(Boolean)
  if (!wanted.length) return false
  return namesOf(exercise).some(candidate => wanted.includes(normalize(candidate)))
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
  if (!MACHINE_HINTS.has(equipment)) return false
  return BODYWEIGHT.has(clean(exercise?.eq))
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

function keywordRejection(hit, exact, queries, candidateEquipment, genericWords) {
  if (!exact) {
    if (hit.score < BASE_FLOOR) return 'below_floor'
    if (!hasNameEvidence(queries, hit.exercise, genericWords)) return 'no_name_evidence'
  }
  if (conflictFor(candidateEquipment, hit.exercise)) return 'equipment_conflict'
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
  if (next.eq === current.eq && next.unsupportedVariants !== current.unsupportedVariants) {
    return next.unsupportedVariants < current.unsupportedVariants
  }
  return false
}

function pickQueryHit(results, queries, names, equipmentHint, candidateEquipment, genericWords, hintText) {
  const limit = Math.min(results.length, QUERY_PICK_LIMIT)
  const [primaryName = '', nameEn = ''] = names
  let picked = null
  let exactConflict = null
  for (let index = 0; index < limit; index++) {
    const entry = results[index]
    if (!entry || !entry.exercise) continue
    const exercise = entry.exercise
    const exact = exactNameMatch(exercise, names)
    const rejection = keywordRejection(entry, exact, queries, candidateEquipment, genericWords)
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
  const rawModelLevel = typeof candidate.level === 'string' ? candidate.level.trim().toLowerCase() : ''
  const modelLevel = LEVEL_RANK[rawModelLevel] ? rawModelLevel : 'low'
  // The English query only runs for a Chinese name that also carries an
  // English one; the diagnostics tag that query as the English recall.
  const useEnglishQuery = isCjkName(name) && !!nameEn
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
      candidate.equipment,
      genericWords,
      hintText,
    )
    if (queryExactConflict && (!exactConflict || queryExactConflict.score > exactConflict.score)) {
      exactConflict = queryExactConflict
    }
    if (!picked) continue
    if (!best || (picked.exact && !best.exact) || (picked.exact === best.exact && picked.score > best.score)) {
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
          : keywordRejection(firstBest, firstExact, queries, candidate.equipment, genericWords) || 'no_hit'
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
    unsupportedVariants,
    candidateIndex,
    queryRank,
    exercise,
  }
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
      return {
        items,
        fallback,
      }
    },
  }
}
