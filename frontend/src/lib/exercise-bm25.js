// Lightweight pure-JS Okapi BM25 zero-hit fallback index for AI exercise matching.
//
// Invoked ONLY when the primary strict-AND search produces no qualifying hit
// (and no exact equipment conflict). Guards against out-of-catalogue hallucinations
// via an unknown-token gate, movement-core evidence requirement, and token
// coverage check. Pure JS with WeakMap caching over the caller's pool array.

import SEARCH_META from './exercise-search-meta.json' with { type: 'json' }

const K1 = 1.2
const B = 0.75
const MIN_COVERAGE = 0.5

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'on', 'in', 'with', 'for', 'and', 'or', 'to', 'at', 'by', 'from',
  'is', 'are', 'this', 'that', 'your', 'you', 'my', 'me', 'it', 'its', 'v',
])

// Legitimate gym/posture/packaging modifiers permitted even when absent from EXDB tokens.
const MODIFIER_WHITELIST = new Set([
  'flat', 'horizontal', 'supine', 'prone', 'seated', 'standing', 'kneeling', 'bent', 'over',
  'hanging', 'suspended', 'plate', 'loaded', 'pin', 'selectorized', 'converging', 'isolateral',
  'iso', 'lateral', 'machine', 'bench', 'press', 'commercial', 'gym', 'angled', 'vertical',
  'dual', 'bilateral', 'unilateral', 'hammer', 'strength', 'pro', 'deluxe', 'heavy', 'smith',
  'lever', 'leverage', 'cable', 'pulley', 'sled', 'pec', 'deck', 'butterfly', 'lat',
  'pulldown', 'pull', 'down', 'stack', 'weight', 'free', 'overhead', 'military', 'incline',
  'decline', 'close', 'wide', 'narrow', 'reverse', 'grip', 'neutral', 'parallel', 'degree',
  'degrees', 'exercise', 'movement', 'lift', 'workout', 'training',
])

// Generic/apparatus/body-region words that do NOT qualify as a standalone movement core.
const NON_CORE_WORDS = new Set([
  'exercise', 'movement', 'lift', 'workout', 'training', 'train', 'body', 'full', 'upper', 'lower',
  'chest', 'back', 'shoulders', 'shoulder', 'legs', 'leg', 'arms', 'arm', 'waist', 'neck', 'cardio',
  'machine', 'lever', 'leverage', 'cable', 'pulley', 'smith', 'sled', 'barbell', 'dumbbell',
  'kettlebell', 'band', 'resistance', 'assisted', 'weighted', 'weight', 'plate', 'loaded', 'pin',
  'selectorized', 'commercial', 'gym', 'flat', 'horizontal', 'converging', 'isolateral', 'iso',
  'vertical', 'dual', 'bilateral', 'unilateral', 'hammer', 'strength', 'pro', 'deluxe', 'heavy',
  'angled', 'degree', 'degrees', 'free', 'stack', 'seated', 'standing', 'lying', 'supine',
  'prone', 'kneeling', 'hanging', 'bent', 'over', 'side', 'incline', 'decline', 'close', 'wide',
  'narrow', 'reverse', 'grip', 'neutral', 'parallel', 'one', 'single', 'alternate', 'alternating',
])

// Optional commercial/apparatus fillers dropped from coverage penalties when absent from catalogue names.
const OPTIONAL_MODIFIERS = new Set([
  'flat', 'horizontal', 'commercial', 'gym', 'isolateral', 'iso', 'converging',
  'hammer', 'strength', 'pro', 'deluxe', 'pin', 'selectorized', 'stack', 'dual',
  'bilateral', 'heavy', 'plate', 'loaded', 'machine',
])

const SHORTHAND_EXPANSIONS = {
  db: ['dumbbell'],
  bb: ['barbell'],
  kb: ['kettlebell'],
  bw: ['body', 'weight'],
  ohp: ['overhead', 'press'],
  rdl: ['romanian', 'deadlift'],
  plateloaded: ['plate', 'loaded'],
  pinloaded: ['pin', 'loaded'],
  latpulldown: ['lat', 'pulldown'],
  chestpress: ['chest', 'press'],
  shoulderpress: ['shoulder', 'press'],
  benchpress: ['bench', 'press'],
  legpress: ['leg', 'press'],
  legextension: ['leg', 'extension'],
  legcurl: ['leg', 'curl'],
  pecdeck: ['pec', 'deck'],
  tbar: ['t', 'bar'],
}

const POSTURE_TERMS = {
  seated: ['seated', 'sitting'],
  standing: ['standing', 'upright'],
  supine: ['supine', 'lying'],
  prone: ['prone', 'lying'],
  side_lying: ['side', 'lying'],
  kneeling: ['kneeling'],
  bent_over: ['bent', 'over'],
  hanging: ['hanging', 'suspended'],
}

const TOKEN_SYNONYMS = {
  machine: ['lever', 'leverage', 'sled', 'smith', 'machine'],
  lever: ['lever', 'leverage'],
  leverage: ['lever', 'leverage'],
  selectorized: ['lever', 'machine', 'stack'],
  pin: ['stack', 'lever'],
  supine: ['supine', 'lying'],
  lying: ['lying', 'supine', 'prone'],
  butterfly: ['pec', 'deck', 'fly'],
  lat: ['lat', 'lateral', 'lats'],
  lateral: ['lateral', 'lat'],
}

const indexCache = new WeakMap()

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[-‐-―/().,:&]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function foldBm25Token(token) {
  if (!token) return ''
  if (token === 'flyes' || token === 'flies') return 'fly'
  if (token === 'calves') return 'calf'
  if (token === 'knees') return 'knee'
  if (token === 'biceps' || token === 'triceps' || token === 'lats' || token === 'abs') return token
  if (/^(?:press|push|stretch|crunch|bench|arch|reach|crush|cross)es$/.test(token)) return token.slice(0, -2)
  if (/^(?:rais|curls|squats|rows|dips|exten)/.test(token) && token.endsWith('s')) {
    return token.slice(0, -1)
  }
  if (token.length >= 4 && token.endsWith('es') && !/(?:ss|us|is)es$/.test(token)) {
    return token.slice(0, -1)
  }
  if (token.length >= 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1)
  return token
}

function tokenizeField(value) {
  const clean = normalizeText(value)
  if (!clean) return []
  const raw = clean.match(/[a-z0-9]+/g) || []
  const out = []
  for (const tok of raw) {
    if (tok.length < 2 || STOP_WORDS.has(tok)) continue
    out.push(foldBm25Token(tok))
  }
  return out
}

function tokenizeQueryRaw(query) {
  const clean = normalizeText(query)
  if (!clean) return []
  const raw = clean.match(/[a-z0-9]+/g) || []
  const out = []
  for (const tok of raw) {
    if (tok.length < 2 || STOP_WORDS.has(tok)) continue
    const expanded = SHORTHAND_EXPANSIONS[tok]
    if (expanded) out.push(...expanded)
    else out.push(tok)
  }
  return out
}

function isEditDistanceAtMostOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let diffs = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
      continue
    }
    if (diffs === 0 && i + 1 < a.length && j + 1 < b.length && a[i] === b[j + 1] && a[i + 1] === b[j]) {
      diffs++
      i += 2
      j += 2
      continue
    }
    diffs++
    if (diffs > 1) return false
    if (a.length > b.length) i++
    else if (b.length > a.length) j++
    else {
      i++
      j++
    }
  }
  return diffs + (a.length - i) + (b.length - j) <= 1
}

function buildFieldIndex(docsTokens) {
  const df = new Map()
  const docTFs = new Array(docsTokens.length)
  const docLens = new Array(docsTokens.length)
  const postings = new Map()
  let totalLen = 0
  for (let idx = 0; idx < docsTokens.length; idx++) {
    const tokens = docsTokens[idx]
    docLens[idx] = tokens.length
    totalLen += tokens.length
    const tf = new Map()
    for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1)
    docTFs[idx] = tf
    for (const tok of tf.keys()) {
      df.set(tok, (df.get(tok) || 0) + 1)
      let list = postings.get(tok)
      if (!list) {
        list = []
        postings.set(tok, list)
      }
      list.push(idx)
    }
  }
  return {
    df,
    docTFs,
    docLens,
    postings,
    avgLen: docsTokens.length ? totalLen / docsTokens.length : 1,
  }
}

function buildIndex(pool) {
  const N = pool.length
  const f1 = new Array(N)
  const f2 = new Array(N)
  const f3 = new Array(N)
  const vocab = new Set()
  const typoVocab = new Set()
  const docAllTokens = new Array(N)
  const docNameTokens = new Array(N)

  for (let i = 0; i < N; i++) {
    const ex = pool[i] || {}
    const meta = !ex.custom && ex.id ? SEARCH_META?.byId?.[ex.id] : null
    const rawNameWords = [
      ex.n,
      ex.name,
      ...(Array.isArray(ex.aliases) ? ex.aliases : []),
      ...(Array.isArray(meta?.a) ? meta.a : []),
    ].join(' ')

    for (const raw of (normalizeText(rawNameWords).match(/[a-z0-9]+/g) || [])) {
      if (raw.length < 2 || STOP_WORDS.has(raw)) continue
      const folded = foldBm25Token(raw)
      vocab.add(raw)
      vocab.add(folded)
      if (raw.length >= 5 && raw.length <= 9) {
        typoVocab.add(raw)
        typoVocab.add(folded)
      }
    }

    const tokens1 = tokenizeField(rawNameWords)
    const postureTokens = meta?.p ? (POSTURE_TERMS[meta.p] || []) : []
    const tokens2 = [
      ...tokenizeField(ex.eq || ex.equipment || ''),
      ...postureTokens.map(foldBm25Token),
    ]
    const tokens3 = tokenizeField([
      ex.bp || ex.bodyPart || '',
      ex.tg || ex.target || '',
      ...(Array.isArray(ex.sm) ? ex.sm : []),
    ].join(' '))

    for (const tok of [...tokens2, ...tokens3]) vocab.add(tok)

    f1[i] = tokens1
    f2[i] = tokens2
    f3[i] = tokens3
    docNameTokens[i] = new Set(tokens1)
    docAllTokens[i] = new Set([...tokens1, ...tokens2, ...tokens3])
  }

  for (const mod of MODIFIER_WHITELIST) {
    vocab.add(mod)
    vocab.add(foldBm25Token(mod))
  }

  return {
    pool,
    vocab,
    typoVocab: [...typoVocab],
    docAllTokens,
    docNameTokens,
    fields: [
      { weight: 3.0, data: buildFieldIndex(f1) },
      { weight: 1.5, data: buildFieldIndex(f2) },
      { weight: 1.0, data: buildFieldIndex(f3) },
    ],
  }
}

function getIndex(pool) {
  const list = Array.isArray(pool) ? pool : []
  const cached = indexCache.get(list)
  if (cached && cached.pool === list) return cached
  const created = buildIndex(list)
  indexCache.set(list, created)
  return created
}

/**
 * Unknown non-fitness token hallucination gate.
 * Rejects queries containing unknown words outside the catalogue + fitness
 * modifier vocabulary (allowing 1-char edit tolerance only on 5..9 char core tokens).
 */
export function hasUnknownNonFitnessToken(query, indexOrPool) {
  const rawTokens = tokenizeQueryRaw(query)
  if (!rawTokens.length) return true
  const index = indexOrPool?.vocab ? indexOrPool : getIndex(indexOrPool)
  for (const raw of rawTokens) {
    const folded = foldBm25Token(raw)
    if (index.vocab.has(raw) || index.vocab.has(folded)) continue
    if (raw.length >= 5 && raw.length <= 9) {
      const hasNear = index.typoVocab.some(w => isEditDistanceAtMostOne(raw, w) || isEditDistanceAtMostOne(folded, w))
      if (hasNear) continue
    }
    return true
  }
  return false
}

function buildQueryTerms(rawTokens) {
  const folded = rawTokens.map(foldBm25Token)
  const phrase = folded.join(' ')
  // termMap: token -> max weight
  const termWeights = new Map()
  const conceptGroups = []

  const addTerm = (tok, weight) => {
    if (!tok) return
    const prev = termWeights.get(tok) || 0
    if (weight > prev) termWeights.set(tok, weight)
  }

  for (const tok of folded) {
    const isOpt = OPTIONAL_MODIFIERS.has(tok)
    const baseWeight = isOpt ? 0.3 : 1.0
    addTerm(tok, baseWeight)
    const syns = TOKEN_SYNONYMS[tok]
    if (syns) {
      for (const s of syns) addTerm(foldBm25Token(s), 0.7)
    }
    if (!isOpt) {
      const alternatives = new Set([tok, ...(syns ? syns.map(foldBm25Token) : [])])
      conceptGroups.push({ tok, isCore: !NON_CORE_WORDS.has(tok), alternatives })
    }
  }

  // Light commercial-machine & posture phrase expansions.
  const hasBenchPress = /\bbench press\b/.test(phrase)
  const hasChestPress = /\bchest press\b/.test(phrase)
  const hasFlatOrHorizontal = /\b(?:flat|horizontal)\b/.test(phrase)
  const hasFreeWeightCue = /\b(?:barbell|dumbbell|ez|smith|kettlebell)\b/.test(phrase)

  if (hasBenchPress) {
    addTerm('chest', 0.9)
    addTerm('press', 0.9)
    for (const g of conceptGroups) {
      if (g.tok === 'bench') g.alternatives.add('chest')
    }
    if (!hasFreeWeightCue) {
      addTerm('supine', 0.55)
      addTerm('lying', 0.55)
    }
  }
  if (hasChestPress && hasFlatOrHorizontal && !/\bleg press\b/.test(phrase)) {
    addTerm('supine', 1.4)
    addTerm('lying', 1.2)
  }
  if (/\boverhead press\b/.test(phrase)) {
    addTerm('shoulder', 0.8)
    addTerm('military', 0.7)
    for (const g of conceptGroups) {
      if (g.tok === 'overhead') {
        g.alternatives.add('shoulder')
        g.alternatives.add('military')
      }
    }
  }
  if (/\b(?:shoulder|military) press\b/.test(phrase)) {
    addTerm('overhead', 0.75)
    addTerm('shoulder', 0.75)
  }
  if (/\blat pulldown\b/.test(phrase)) {
    addTerm('lateral', 0.85)
    for (const g of conceptGroups) {
      if (g.tok === 'lat') g.alternatives.add('lateral')
    }
  }
  if (/\blateral pulldown\b/.test(phrase)) {
    addTerm('lat', 0.85)
    for (const g of conceptGroups) {
      if (g.tok === 'lateral') g.alternatives.add('lat')
    }
  }
  if (/\b(?:pec|butterfly) (?:fly|deck|machine)\b/.test(phrase)) {
    addTerm('pec', 0.85)
    addTerm('deck', 0.85)
    addTerm('fly', 0.85)
    for (const g of conceptGroups) {
      if (g.tok === 'butterfly' || g.tok === 'machine') {
        g.alternatives.add('pec')
        g.alternatives.add('deck')
      }
    }
  }

  return { termWeights, conceptGroups }
}

/**
 * Search the exercise pool using weighted Okapi BM25 with hallucination and
 * coverage gates. Intended solely as a zero-hit fallback for the AI matcher.
 */
export function searchBm25(pool, query, limit = 5) {
  if (!Array.isArray(pool) || !pool.length) return []
  const rawTokens = tokenizeQueryRaw(query)
  if (!rawTokens.length) return []
  const index = getIndex(pool)
  if (hasUnknownNonFitnessToken(query, index)) return []

  const { termWeights, conceptGroups } = buildQueryTerms(rawTokens)
  const coreGroups = conceptGroups.filter(g => g.isCore)
  if (!coreGroups.length) return []

  const N = pool.length
  const scores = new Map()

  for (const [term, qWeight] of termWeights.entries()) {
    for (const field of index.fields) {
      const { df, docTFs, docLens, postings, avgLen } = field.data
      const list = postings.get(term)
      if (!list) continue
      const n = df.get(term) || 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      for (let k = 0; k < list.length; k++) {
        const idx = list[k]
        const tf = docTFs[idx].get(term) || 0
        const dl = docLens[idx] || 1
        const denom = tf + K1 * (1 - B + B * (dl / (avgLen || 1)))
        const contrib = field.weight * qWeight * idf * ((tf * (K1 + 1)) / denom)
        scores.set(idx, (scores.get(idx) || 0) + contrib)
      }
    }
  }

  const ranked = []
  for (const [idx, rawScore] of scores.entries()) {
    const allToks = index.docAllTokens[idx]
    const nameToks = index.docNameTokens[idx]

    let coreMatched = false
    for (const g of coreGroups) {
      for (const alt of g.alternatives) {
        if (nameToks.has(alt)) {
          coreMatched = true
          break
        }
      }
      if (coreMatched) break
    }
    if (!coreMatched) continue

    let matchedConcepts = 0
    for (const g of conceptGroups) {
      let hit = false
      for (const alt of g.alternatives) {
        if (allToks.has(alt)) {
          hit = true
          break
        }
      }
      if (hit) matchedConcepts++
    }
    if (conceptGroups.length > 0 && matchedConcepts / conceptGroups.length < MIN_COVERAGE) {
      continue
    }

    const mappedScore = Math.min(249, Math.round(60 + rawScore * 6))
    ranked.push({ exercise: pool[idx], score: mappedScore, idx, rawScore })
  }

  ranked.sort((a, b) => b.rawScore - a.rawScore || a.idx - b.idx)
  return ranked.slice(0, limit).map(({ exercise, score }) => ({ exercise, score }))
}
