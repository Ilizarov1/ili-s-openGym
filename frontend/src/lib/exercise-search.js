// Shared exercise search engine for the Web client and the RN app.
//
// The rules (multi-token matching, synonyms, typos, run-together names, relevance
// ranking and the "similar exercises" fallback) live here once. A client adapts
// its own data: how an exercise's searchable name is built, where saved aliases
// come from, and how body part / equipment / muscle labels are translated.

export const normalizeStr = s => (s || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()

// Exercises done one arm or leg at a time, by their catalogue name: "single leg", "one arm",
// "single-arm", "unilateral". Stretches and rollers are mobility, not sets, and a single-leg
// push-up or plank is a two-arm exercise with a leg lifted. Like `isBodyweightEq`, this only
// seeds a fresh config (`side: true`); the flag lives on the config, so either way can be
// switched.
const ONE_LIMB = /\b(single|one)[\s-]+(arm|leg|hand)\b|\bunilateral\b/i
const NOT_ONE_LIMB = /stretch|\broll(er|ball)?\b|two to one|single leg (push|plank)|leg push up/i

/** Whether an exercise object is one of the catalogue's one-arm / one-leg movements. */
export const isOneLimbExercise = ex => {
  if (!ex || ex.custom || ex.bp === 'cardio') return false
  return ONE_LIMB.test(ex.n || '') && !NOT_ONE_LIMB.test(ex.n || '')
}

// How many single-character edits (insert, delete, substitute, swap two neighbours) apart two
// words are, or `max + 1` as soon as it is clear they are further apart than `max`.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1)
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    prev2 = prev
    prev = cur
  }
  return prev[b.length]
}

// Typos allowed in a query word against a name word: none below four letters ("row" and "curl"
// are too common for a neighbour to mean anything), one up to six, two from seven.
const typosFor = word => (word.length < 4 ? 0 : word.length < 7 ? 1 : 2)

// Allow typos (typosFor) in a query token against one name word, or against its first letters
// once the token is long enough to be a word in progress ("dumbel" for "dumbbell").
//
// Only the exercise's own name words are ever compared this way. Body part, target and
// equipment words are shared by a whole slice of the catalogue, so one accidental neighbour
// ("wrist" ~ "waist", "power" ~ "lower arms", "drucken" ~ "rucken") would list hundreds of
// unrelated exercises ahead of the real hits (QA C26).
function nearWordUncached(a, b) {
  const max = typosFor(a)
  if (!max) return false
  if (editDistance(a, b, max) <= max) return true
  return a.length >= 5 && b.length > a.length && editDistance(a, b.slice(0, a.length), max) <= max
}

// Gym shorthand and spellings people type, each read as the words the catalogue uses. A query
// token matches when it or any of its expansions does; the expansions are phrases (all words).
const SYNONYMS = {
  db: ['dumbbell'], dbs: ['dumbbell'], bb: ['barbell'], kb: ['kettlebell'], kbs: ['kettlebell'],
  ez: ['ez barbell'], sm: ['smith'], bw: ['body weight'], bodyweight: ['body weight'],
  ohp: ['overhead press', 'shoulder press', 'military press'], rdl: ['romanian deadlift'],
  sldl: ['stiff leg deadlift'], dl: ['deadlift'], bp: ['bench press'], skullcrusher: ['lying triceps extension', 'skull crusher'],
  skullcrushers: ['lying triceps extension', 'skull crusher'], pulldown: ['pull down', 'pulldown'],
  pullup: ['pull up', 'pull-up'], chinup: ['chin up', 'chin-up'], pushup: ['push up', 'push-up'],
  pressup: ['push up', 'push-up'], situp: ['sit up', 'sit-up'], flye: ['fly'], flyes: ['fly'], flies: ['fly'],
  machine: ['lever', 'machine', 'sled'], lever: ['lever', 'machine'], abs: ['crunch', 'abs'],
  hammy: ['hamstring'], hammies: ['hamstring'], quad: ['quads', 'quadriceps'], tricep: ['triceps'], bicep: ['biceps'],
  delt: ['delts', 'shoulder'], lat: ['lats', 'latissimus', 'pulldown'], trap: ['traps', 'shrug'],
  glute: ['glutes', 'gluteus'], calf: ['calf', 'calves'], hip: ['hip'], rope: ['rope'], trx: ['suspension'],
  ring: ['ring', 'suspension'], rings: ['ring', 'suspension'], kettle: ['kettlebell'], dumbel: ['dumbbell'],
}

const queryTokens = query => normalizeStr(query || '').split(/\s+/).filter(Boolean)
const SEPARATOR = /[\s\-‐-―]/
// Letters, numbers and CJK characters; punctuation that separates name words is
// excluded so a word after "(" still starts a joined match. Kept to a plain
// character range because the RN Hermes runtime is stricter than V8 here.
const WORD_CHAR = /[^\s\-‐-―()/,.&]/u
const joinWords = str => str.replace(/[\s\-‐-―]+/g, '')

// Among equally good matches, the one people most likely mean: the familiar core of the
// catalogue (the exercises openGym shipped before v1.4.0), the common equipment, and a lift
// before a stretch. Small on purpose: it orders ties, it never beats a better match.
const EQ_PRIOR = { barbell: 4, dumbbell: 4, cable: 3, 'leverage machine': 3, 'body weight': 3, 'smith machine': 2, kettlebell: 2, 'ez barbell': 2, 'sled machine': 2 }
const CAT_PRIOR = { strength: 3, calisthenics: 3, olympic: 2, plyometrics: 1, isometric: 1, stretching: -3, mobility: -3, rehab: -4, yoga: -2, pilates: -2 }
// The one version every gym has, where the catalogue's name hides it: "leg press" means the 45°
// sled, not the Smith machine or a one-leg variant (Discord, 2026-10-09).
const EVERYDAY = { '0739': 6 }

// The lifts most people mean when they search a muscle ("chest", "back", "Beine"): the staples of
// a commercial gym, so a muscle search opens on the bench press and the pulldown instead of the
// alphabetically first stretches (Discord, 2026-10-27).
const STAPLES = new Set([
  '0025', '0047', '0289', '0314', '0251', '0155', '0308', '0662', '0596', '0576',          // chest
  '0652', '1326', '0198', '0027', '0861', '0032', '0292', '0293', '0606',                 // back
  '0043', '3593', '0739', '0585', '0586', '0599', '0085', '0336', '1060', '0605', '1372', // legs, glutes, calves
  '1162', '0405', '0334', '0178',                                                         // shoulders
  '0031', '0294', '0313', '2249', '0060', '0061',                                         // arms
  '0274', '0463', '0472', '0175',                                                         // core
])
const STRETCHY = new Set(['stretching', 'mobility', 'rehab', 'yoga', 'pilates'])

// The name with its spaces and hyphens left out, and where each of its words starts in that.
function joinedOf(name) {
  let joined = ''
  const starts = new Set()
  for (let i = 0; i < name.length; i++) {
    if (SEPARATOR.test(name[i])) continue
    if (i === 0 || !WORD_CHAR.test(name[i - 1])) starts.add(joined.length)
    joined += name[i]
  }
  return { joined, starts }
}

/**
 * Build a search engine over one candidate shape.
 *
 * @param {object} options
 * @param {(exercise: object) => string} options.nameText Searchable name(s), already joined.
 * @param {(exercise: object) => string[]} [options.aliasesOf] Saved text aliases for the exercise.
 * @param {(value: string) => string} [options.translate] Label translation for bp/eq/tg/sm.
 * @param {() => number} [options.revision] Changes when language or name packs change.
 * @param {() => unknown} [options.aliasRevision] Identity that changes when aliases change.
 * @param {Iterable<string>} [options.classicIds] Catalogue ids from before v1.4.0.
 * @returns {{
 *   matchExercise: (exercise: object, query?: string) => boolean,
 *   searchExercises: <T extends object>(list: T[], query?: string) => T[],
 *   searchScored: <T extends object>(list: T[], query?: string) => { exercise: T, score: number }[],
 *   similarExercises: <T extends object>(list: T[], query?: string, exclude?: T[], limit?: number) => T[],
 * }}
 */
export function createExerciseSearch({
  nameText,
  aliasesOf = () => [],
  translate = value => value,
  revision = () => 0,
  aliasRevision = null,
  classicIds = [],
}) {
  const CLASSIC = new Set(classicIds)
  const priorOf = e => (CLASSIC.has(e?.id) ? 3 : 0) + (EQ_PRIOR[e?.eq] || 0) + (CAT_PRIOR[e?.cat] || 0) + (EVERYDAY[e?.id] || 0)

  // The haystack is built once per exercise and cached: NFD-normalising ~1300 catalogue entries
  // on every keystroke costs ~8ms on a desktop and several times that on a phone. Switching
  // language or aliases changes the revision, so the translated terms are rebuilt.
  //
  // Each entry keeps the full corpus for substring matching and, separately, the words of the
  // name (English and localized) that the typo tolerance below is allowed to compare against.
  const corpusCache = new WeakMap()
  // Every distinct word of every name the search has seen (a few thousand for the whole catalogue).
  const VOCAB = new Set()

  const aliasSnapshot = () => (aliasRevision ? aliasRevision() : null)

  function corpusOf(e) {
    const v = revision()
    const aliases = aliasSnapshot()
    const aliasValues = aliasesOf(e) || []
    // Web hands over the profile map identity; clients whose aliases sit on the
    // exercise itself (RN) get the normalized values compared instead.
    const aliasKey = aliasRevision ? aliases : aliasValues.join('\u0000')
    const hit = corpusCache.get(e)
    if (hit && hit.v === v && hit.aliasKey === aliasKey) return hit
    const sm = Array.isArray(e?.sm) ? e.sm : []
    const name = normalizeStr(nameText(e))
    const s = normalizeStr([
      name, ...aliasValues,
      e?.tg || '', translate(e?.tg || ''),
      e?.eq || '', translate(e?.eq || ''),
      e?.bp || '', translate(e?.bp || ''),
      ...sm, ...sm.map(m => translate(m)),
      e?.desc || '',
    ].join(' '))
    // The name run together, so "benchpress" or "bench-press" finds "bench press" the way "pullup"
    // already found the names that spell it that way (QA 1.3.9). Name only: joined across fields,
    // a body part and an equipment word would start matching as one.
    // The joined form only counts from the start of a name word, or "thigh" would find "sumo
    // deadlift high pull" through "deadlifthighpull".
    const entry = { v, s, name, aliasKey, ...joinedOf(name), nameWords: name.split(/[\s\-‐-―()/,]+/).filter(Boolean) }
    for (const w of entry.nameWords) VOCAB.add(w)
    corpusCache.set(e, entry)
    return entry
  }

  // One search compares the same few query words against the same few thousand distinct name
  // words over and over (5,600 exercises share most of their words). Each pair is worked out once
  // per search: without this a three-word query took over half a second on a desktop.
  let nearCache = new Map()
  const resetNearCache = () => { if (nearCache.size) nearCache = new Map() }
  function cached(kind, a, b, fn) {
    const key = kind + a + '\u0000' + b
    let v = nearCache.get(key)
    if (v === undefined) { v = fn(); nearCache.set(key, v) }
    return v
  }
  const nearWord = (a, b) => cached('n', a, b, () => nearWordUncached(a, b))

  // The forms a token may take: as typed, the shorthand it stands for, and the singular of a plural
  // ("curls" finds "curl", "raises" finds "raise", "presses" finds "press").
  const formsCache = new Map()
  function formsOf(tok) {
    const hit = formsCache.get(tok)
    if (hit) return hit
    const forms = formsOfUncached(tok)
    if (formsCache.size > 500) formsCache.clear()
    formsCache.set(tok, forms)
    return forms
  }
  function formsOfUncached(tok) {
    const out = [tok]
    for (const s of SYNONYMS[tok] || []) out.push(s)
    if (tok.length >= 4 && tok.endsWith('es') && !tok.endsWith('ses')) out.push(tok.slice(0, -2), tok.slice(0, -1))
    else if (tok.length >= 4 && tok.endsWith('ses')) out.push(tok.slice(0, -2))
    // Three letters is enough for "ups" ("pull ups" is "pull-up"); "abs" is a word of its own.
    else if (tok.length >= 3 && tok.endsWith('s') && !tok.endsWith('ss') && tok !== 'abs') out.push(tok.slice(0, -1))
    return [...new Set(out)]
  }

  function joinedHit(entry, tok) {
    const needle = joinWords(tok)
    for (let at = entry.joined.indexOf(needle); at !== -1; at = entry.joined.indexOf(needle, at + 1)) {
      if (entry.starts.has(at)) return true
    }
    return false
  }

  // A token appears in the corpus as typed, or in the name with its spaces and hyphens left out,
  // starting at a word.
  const literalHit = (entry, tok) => entry.s.includes(tok) || (tok.length >= 4 && joinedHit(entry, tok))
  const hits = (entry, tok) => formsOf(tok).some(form => literalHit(entry, form))

  // Every token has to appear in the corpus; a token listed in `fuzzy` may instead be one edit
  // away from a name word.
  const matchTokens = (e, tokens, fuzzy) => {
    const entry = corpusOf(e)
    return tokens.every(tok => hits(entry, tok) || (fuzzy.has(tok) && formsOf(tok).some(f => entry.nameWords.some(word => nearWord(f, word)))))
  }

  // Single-exercise check, used where the list is filtered one option at a time (the exercise
  // progress picker). Every token may fall back to the typo tolerance; lists go through
  // searchExercises below, which knows whether a token needs it at all.
  function matchExercise(e, query) {
    const tokens = queryTokens(query)
    if (!tokens.length) return true
    if (!e || typeof e !== 'object') return false
    return matchTokens(e, tokens, new Set(tokens))
  }

  // Search a list, exact hits first: a token that appears literally in at least one exercise is
  // taken at its word for the whole list, and only a token with no exact hit anywhere ("bnech",
  // "dumbell", "wirst") is allowed the typo tolerance. Otherwise a correctly spelled query such
  // as "squat" or "clean" would also drag in "squad" and "lean", and since the callers keep
  // catalogue order those strays would land ahead of the real matches (QA C26).
  function searchExercises(list, query) {
    const tokens = queryTokens(query)
    if (!tokens.length) return list
    resetNearCache()
    const fuzzy = new Set(tokens.filter(tok => !list.some(e => hits(corpusOf(e), tok))))
    return rankByRelevance(list.filter(e => matchTokens(e, tokens, fuzzy)), tokens).map(x => x.e)
  }

  // The same ordering as searchExercises, with the score each exercise got.
  // AI name matching needs the number, not just the order: it accepts a hit
  // only above BASE_FLOOR and can compare competing candidates.
  function searchScored(list, query) {
    const tokens = queryTokens(query)
    if (!tokens.length) return []
    resetNearCache()
    const fuzzy = new Set(tokens.filter(tok => !list.some(e => hits(corpusOf(e), tok))))
    return rankByRelevance(list.filter(e => matchTokens(e, tokens, fuzzy)), tokens)
      .map(({ e, score }) => ({ exercise: e, score }))
  }

  // Per search, for each form of each query word: the vocabulary words it starts, the ones within
  // the allowed typos, and the ones one typo further (for the similar list). Worked out once over
  // the vocabulary, so scoring an exercise is a handful of set lookups instead of string distance
  // against each of its words: 5,600 exercises took a quarter of a second the other way.
  function queryContext(tokens) {
    const ctx = new Map()
    for (const tok of tokens) {
      for (const form of formsOf(tok)) {
        if (ctx.has(form) || form.includes(' ')) continue
        // One typo more than the exact search allows, but only for words of six letters and up:
        // "pull" is two letters from "curl", and that is a different exercise, not a typo.
        const extraMax = tok.length >= 6 ? typosFor(tok) + 1 : typosFor(tok)
        const prefix = new Set(), near = new Set(), extra = new Set()
        for (const w of VOCAB) {
          if (w.startsWith(form)) prefix.add(w)
          if (nearWordUncached(form, w)) near.add(w)
          else if (tok.length >= 4 && editDistance(form, w, extraMax) <= extraMax) extra.add(w)
        }
        ctx.set(form, { prefix, near, extra })
      }
    }
    return ctx
  }

  // How well one query token sits in an exercise: a whole word of the name beats the start of one,
  // which beats anywhere in the name, the name run together, a typo in the name, and last of all
  // another field (target, equipment, body part, muscles). Zero when it is not there at all.
  function tokenScore(entry, tok, ctx) {
    let best = 0
    for (const form of formsOf(tok)) {
      const c = ctx && ctx.get(form)
      // A singular or a spelling variant counts a little less than what was typed; the meaning of
      // a short abbreviation ("rdl", "ohp", "db") is exactly what was meant and counts in full.
      const exact = form === tok || (tok.length <= 4 && SYNONYMS[tok]?.includes(form)) ? 0 : 5
      const words = form.split(' ')
      if (words.length > 1) {
        if (entry.name.includes(form)) best = Math.max(best, 100 - exact)
        else if (entry.s.includes(form)) best = Math.max(best, 20 - exact)
        continue
      }
      if (entry.nameWords.includes(form)) best = Math.max(best, 100 - exact)
      else if (c ? entry.nameWords.some(w => c.prefix.has(w)) : entry.nameWords.some(w => w.startsWith(form))) best = Math.max(best, 80 - exact)
      else if (entry.name.includes(form)) best = Math.max(best, 60 - exact)
      else if (form.length >= 4 && joinedHit(entry, form)) best = Math.max(best, 55 - exact)
      else if (c ? entry.nameWords.some(w => c.near.has(w)) : entry.nameWords.some(w => nearWord(form, w))) best = Math.max(best, 40 - exact)
      else if (entry.s.includes(form)) best = Math.max(best, 20 - exact)
    }
    return best
  }

  // Body part and target muscle words of an exercise, in English and in the reader's language.
  const bodyWordsOf = e => new Set(normalizeStr([
    e?.bp || '', translate(e?.bp || ''), e?.tg || '', translate(e?.tg || ''),
  ].join(' ')).split(' ').filter(Boolean))

  // A name that is the query itself wins outright: as typed or in the singular 50, with the typos
  // the search allows for its length 40 ("sqat" is the exercise called "squat", not "dumbbell squat").
  function wholeNameScore(plain, typedForms) {
    if (typedForms.includes(plain)) return 50
    return typedForms.some(q => { const max = typosFor(q); return max && editDistance(q, plain, max) <= max }) ? 40 : 0
  }

  // The matches in order of how well they match, shorter names first among equals (the plain
  // "barbell squat" before its six variations), and the list's own order after that: custom
  // exercises, which callers put first, stay first among equal matches.
  function rankByRelevance(found, tokens) {
    const ctx = queryContext(tokens)
    // The query as typed, and with each word in its singular: "pull ups" is the name "pull-up".
    const typedForms = [...new Set([tokens, tokens.map(tok => formsOf(tok).find(f => f !== tok && !f.includes(' ')) || tok)]
      .map(list => list.join(' ').replace(/[-‐-―]/g, ' ')))]
    // A search that is only muscle or body-part words ranks by what the exercise trains and how
    // common it is, not by which names happen to contain the word: otherwise "chest" opens on
    // "above head chest stretch". A stretch only leads when the search asks for one.
    const bodyTok = tok => formsOf(tok).some(f => found.some(e => bodyWordsOf(e).has(f)))
    const bodyMode = tokens.length > 0 && tokens.every(bodyTok)
    const wantsStretch = tokens.some(tok => /^(stretch|mobil|yoga|dehn|étir|estir|allung)/.test(tok))
    const scored = found.map((e, i) => {
      const entry = corpusOf(e)
      if (bodyMode) {
        const bw = bodyWordsOf(e)
        const trains = tokens.every(tok => formsOf(tok).some(f => bw.has(f)))
        const named = Math.min(60, tokens.reduce((sum, tok) => sum + tokenScore(entry, tok, ctx), 0))
        const score = (trains ? 70 : named) + (STAPLES.has(e.id) ? 30 : 0) + priorOf(e)
          + (STRETCHY.has(e.cat) && !wantsStretch ? -25 : 0)
        return { e, i, score, len: entry.nameWords.length }
      }
      // The name exactly as typed wins outright ("burpee" before "dumbbell burpee"), and every
      // word the name has beyond the query costs a little, more than the equipment preference.
      const plain = entry.name.split(' (')[0].replace(/[-‐-―]/g, ' ')
      const whole = wholeNameScore(plain, typedForms)
      const extra = Math.max(0, entry.nameWords.length - tokens.length) * 3
      return { e, i, score: tokens.reduce((sum, tok) => sum + tokenScore(entry, tok, ctx), 0) + priorOf(e) + whole - extra, len: entry.nameWords.length }
    })
    scored.sort((a, b) => b.score - a.score || a.len - b.len || a.i - b.i)
    return scored
  }

  // Exercises that come close to a query without matching all of it: most of the words found, or
  // the words found with more typos than the exact search allows, or the name of something
  // similar. For the "Similar exercises" section under the results, so a search almost never ends
  // on "No match". `exclude` holds what the exact search already listed. Best first, at most `limit`.
  function similarExercises(list, query, exclude = [], limit = 30) {
    const tokens = queryTokens(query)
    if (!tokens.length) return []
    resetNearCache()
    const skip = new Set(exclude)
    // What the exact hits train most: "similar" leans towards the same muscle, so a curl search
    // offers other biceps work rather than anything else that happens to say "dumbbell".
    const tgCount = {}
    for (const e of exclude.slice(0, 8)) if (e?.tg) tgCount[e.tg] = (tgCount[e.tg] || 0) + 1
    const mainTg = Object.keys(tgCount).sort((a, b) => tgCount[b] - tgCount[a])[0]
    for (const e of list) corpusOf(e)   // fills the vocabulary before it is searched
    const ctx = queryContext(tokens)
    const out = []
    for (let i = 0; i < list.length; i++) {
      const e = list[i]
      if (skip.has(e)) continue
      const entry = corpusOf(e)
      let score = 0, found = 0
      for (const tok of tokens) {
        let best = tokenScore(entry, tok, ctx)
        // One more typo than the exact search allows, name words only.
        if (!best && formsOf(tok).some(f => { const c = ctx.get(f); return c && entry.nameWords.some(w => c.extra.has(w)) })) best = 25
        if (best) { found++; score += best }
      }
      // Half the words at least (one of one, one of two, two of three...), and for a one-word query
      // a hit in the name, not just a shared body part.
      if (found * 2 < tokens.length || !found || (tokens.length === 1 && score < 25)) continue
      out.push({ e, i, score: score + found * 30 + priorOf(e) + (mainTg && e.tg === mainTg ? 40 : 0), len: entry.nameWords.length })
    }
    out.sort((a, b) => b.score - a.score || a.len - b.len || a.i - b.i)
    return out.slice(0, limit).map(x => x.e)
  }

  return { matchExercise, searchExercises, searchScored, similarExercises }
}
