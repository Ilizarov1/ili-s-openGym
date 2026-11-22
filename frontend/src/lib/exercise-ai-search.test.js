// Shared AI exercise matcher: pipeline behaviour (EXECUTION 3.3) and the
// offline retrieval-effect golden set (EXECUTION 3.4).
//
// The golden runner uses the real catalogue and the same shared module the Web
// and RN clients call. Pools are built here, not in the module, so the test
// also documents what each host injects.
import { describe, expect, it } from 'vitest'
import golden from './exercise-ai-search.golden.json' with { type: 'json' }
import { EXDB } from './exercises-data.js'
import zh from '../exercise-names/zh.js'
import V13_IDS from './catalogue-v13-ids.json' with { type: 'json' }
import { createExerciseSearch } from './exercise-search.js'
import { BODYPARTS, EQUIPMENTS, createWebAiSearch } from './exercises.js'
import { createFixtureProvider } from '../../../api/agent-runtime/providers/fixture.js'
import {
  AI_MATCH_CONSTANTS,
  BASE_FLOOR,
  BP_BONUS,
  CJK_DICE_MIN,
  CJK_LCS_MIN,
  CJK_MARGIN,
  EQ_BONUS,
  createExerciseAiSearch,
  deriveClarificationChips,
  diceCoefficient,
  longestCommonSubstring,
} from './exercise-ai-search.js'

// Labels the RN test uses for the Chinese pool; they only affect body-part /
// equipment words, not the exercise names the matcher reads.
const LABELS = {
  back: '背部',
  cable: '绳索',
  lats: '背阔肌',
  'upper back': '上背部',
  biceps: '肱二头肌',
  rhomboids: '菱形肌',
  core: '核心',
  'body weight': '自重',
}
const label = value => LABELS[value] ?? value

const withAliases = aliases => exercise => ({ ...exercise, aliases: aliases[exercise.id] || [] })
const EN_POOL = EXDB.map(withAliases({}))
const ZH_POOL = EXDB.map(exercise => ({
  ...exercise,
  name: zh[exercise.id] ?? exercise.n,
  aliases: [],
}))
const CUSTOM_ACTIONS = [
  { id: 'custom-1', n: 'sled drag rope', name: 'sled drag rope', aliases: ['Viking row'], custom: true },
  { id: 'custom-2', n: 'sandbag shoulder toss', name: 'sandbag shoulder toss', aliases: [], custom: true },
  { id: 'custom-3', n: 'trap bar carry', name: 'trap bar carry', aliases: [], custom: true },
]
const SAVED_ALIASES = {
  '0025': ['my bench'],
  '0198': ['pulldown king'],
  '1204': ['我的高位下拉'],
  'custom-1': ['Viking row'],
}
const CUSTOM_POOL = [...CUSTOM_ACTIONS, ...EXDB.map(withAliases(SAVED_ALIASES))]
const ZH_CUSTOM_POOL = [
  { id: 'custom-zh-1', n: 'self built row machine', name: '自建划船机', aliases: [], custom: true },
  ...ZH_POOL,
]

const searchOf = (nameText, aliasesOf, translate = value => value) => createExerciseSearch({
  nameText,
  aliasesOf,
  translate,
  classicIds: V13_IDS,
})
const aiOf = (engine, list) => createExerciseAiSearch({
  searchScored: engine.searchScored,
  list,
  bodyPartValues: BODYPARTS,
  equipmentValues: EQUIPMENTS,
})

const EN_SEARCH = searchOf(exercise => exercise.n, exercise => exercise.aliases)
const ZH_SEARCH = searchOf(exercise => `${exercise.name} ${exercise.n}`, exercise => exercise.aliases, label)
const CUSTOM_SEARCH = searchOf(exercise => exercise.n, exercise => exercise.aliases)
const ZH_CUSTOM_SEARCH = searchOf(exercise => `${exercise.name} ${exercise.n}`, exercise => exercise.aliases, label)

const AI = {
  en: aiOf(EN_SEARCH, EN_POOL),
  zh: aiOf(ZH_SEARCH, ZH_POOL),
  custom: aiOf(CUSTOM_SEARCH, CUSTOM_POOL),
  'zh-custom': aiOf(ZH_CUSTOM_SEARCH, ZH_CUSTOM_POOL),
}

const match = (pool, candidate, extra = {}) => AI[pool].match({
  candidates: [candidate],
  fallback: { understanding: extra.understanding || '用户描述了一个训练动作' },
})
const idsOf = result => result.items.map(item => item.exerciseId)

function declaredIds(caseItem) {
  const expect = caseItem.expect || {}
  return [
    ...(expect.top1 ? [expect.top1] : []),
    ...(expect.contains || []),
    ...(expect.order || []),
    ...(expect.allowed || []),
    ...(expect.absent || []),
  ]
}

const KNOWN_IDS = new Set([...EXDB.map(exercise => exercise.id), ...CUSTOM_ACTIONS.map(exercise => exercise.id), 'custom-zh-1'])

function evaluate(caseItem) {
  const result = AI[caseItem.pool].match(caseItem.output)
  const ids = idsOf(result)
  const expect = caseItem.expect || {}
  const errors = []
  const structuralErrors = []
  const fail = (message, structural = true) => {
    errors.push(message)
    if (structural) structuralErrors.push(message)
  }
  const understanding = result.fallback && typeof result.fallback.understanding === 'string'
    ? result.fallback.understanding.trim()
    : ''
  if (!understanding) fail('fallback.understanding is empty')
  for (const item of result.items) {
    if (!item.rationale || !item.rationale.trim()) fail(`empty rationale for ${item.exerciseId}`)
  }

  if (expect.empty) {
    if (result.items.length) fail(`expected empty candidates, got ${ids.join(',')}`)
    if (understanding.length < 4) fail('fallback understanding is not usable')
  }
  if (expect.top1 && ids[0] !== expect.top1) fail(`top1 ${ids[0] || '(none)'} != ${expect.top1}`, false)
  const contains = expect.contains || (expect.top1 ? [expect.top1] : [])
  for (const id of contains) {
    if (!ids.slice(0, 5).includes(id)) fail(`top5 missing ${id}`, false)
  }
  if (expect.order) {
    const head = ids.slice(0, expect.order.length)
    if (JSON.stringify(head) !== JSON.stringify(expect.order)) {
      fail(`order ${head.join(',')} != ${expect.order.join(',')}`)
    }
  }
  if (expect.exactItems != null && result.items.length !== expect.exactItems) {
    fail(`items ${result.items.length} != ${expect.exactItems}`)
  }
  if (expect.minItems != null && result.items.length < expect.minItems) {
    fail(`items ${result.items.length} < ${expect.minItems}`)
  }
  if (expect.maxItems != null && result.items.length > expect.maxItems) {
    fail(`items ${result.items.length} > ${expect.maxItems}`)
  }
  if (expect.allowed) {
    for (const id of ids) {
      if (!expect.allowed.includes(id)) fail(`unexpected exercise ${id}`)
    }
  }
  if (expect.absent) {
    for (const id of expect.absent) {
      if (ids.includes(id)) fail(`stale exercise ${id} is still present`)
    }
  }
  if (expect.maxRationaleParts != null) {
    for (const item of result.items) {
      const parts = item.rationale.split('；').filter(Boolean)
      if (parts.length > expect.maxRationaleParts) {
        fail(`${item.exerciseId} has ${parts.length} rationales`)
      }
    }
  }
  if (expect.levels) {
    for (const [id, level] of Object.entries(expect.levels)) {
      const item = result.items.find(entry => entry.exerciseId === id)
      if (!item) fail(`level target ${id} is missing`)
      else if (item.level !== level) fail(`level ${id} ${item.level} != ${level}`)
    }
  }

  const allowedHigh = new Set([
    ...(expect.top1 ? [expect.top1] : []),
    ...(expect.contains || []),
    ...(expect.order || []),
    ...(expect.allowed || []),
  ])
  const wrongHigh = result.items
    .filter(item => item.level === 'high' && !allowedHigh.has(item.exerciseId))
    .map(item => item.exerciseId)
  if (wrongHigh.length) fail(`wrong high: ${wrongHigh.join(',')}`)

  const top1Hit = expect.empty
    ? result.items.length === 0
    : expect.top1
      ? ids[0] === expect.top1
      : errors.length === 0
  const top5Hit = expect.empty
    ? result.items.length === 0
    : contains.length
      ? contains.every(id => ids.slice(0, 5).includes(id))
      : errors.length === 0
  return { caseItem, result, ids, errors, structuralErrors, wrongHigh, top1Hit, top5Hit, pass: errors.length === 0 }
}

const RESULTS = golden.cases.map(evaluate)
const bySubset = subset => RESULTS.filter(result => result.caseItem.subset === subset)
const rate = (rows, key) => (rows.length ? rows.filter(row => row[key]).length / rows.length : 1)
const percent = value => `${(value * 100).toFixed(1)}%`
const failures = rows => rows.filter(row => !row.pass)
  .map(row => `${row.caseItem.id}: ${row.errors.join('; ')}`)

function report(labelText, rows, top1Key, top5Key) {
  const rowsText = `cases ${rows.length}, top-1 ${rows.filter(row => row[top1Key]).length}/${rows.length} (${percent(rate(rows, top1Key))}), top-5 ${rows.filter(row => row[top5Key]).length}/${rows.length} (${percent(rate(rows, top5Key))})`
  console.log(`[ai-golden] ${labelText}: ${rowsText}`)
  return rowsText
}

describe('AI exercise matching pipeline (3.3)', () => {
  it('pins the calibrated matcher constants', () => {
    expect(BASE_FLOOR).toBe(60)
    expect(EQ_BONUS).toBe(25)
    expect(BP_BONUS).toBe(15)
    expect(CJK_DICE_MIN).toBe(0.6)
    expect(CJK_LCS_MIN).toBe(3)
    expect(CJK_MARGIN).toBe(0.12)
    expect(AI_MATCH_CONSTANTS).toEqual({
      BASE_FLOOR: 60,
      EQ_BONUS: 25,
      BP_BONUS: 15,
      CJK_DICE_MIN: 0.6,
      CJK_LCS_MIN: 3,
      CJK_MARGIN: 0.12,
    })
  })

  it('finds an English exact name and tolerates a spelling slip', () => {
    const exact = match('en', { name: 'barbell bench press', level: 'high', rationale: '杠铃卧推' })
    expect(idsOf(exact)).toEqual(['0025'])
    expect(exact.items[0].level).toBe('high')

    const fuzzy = match('en', { name: 'bnech press', level: 'high', rationale: '卧推，拼写有误' })
    expect(idsOf(fuzzy)).toEqual(['0025'])
    expect(fuzzy.items[0].level).toBe('medium')
  })

  it('resolves the Chinese name “坐姿推举” through the character fallback', () => {
    const result = match('zh', { name: '坐姿推举', level: 'high', rationale: '坐姿上推' })
    expect(idsOf(result)).toEqual(['0546'])
    expect(result.items[0].name).toBe('壶铃坐姿推举')
    expect(result.items[0].level).toBe('low')
    // Calibration evidence: the accepted pair clears CJK_DICE_MIN, CJK_LCS_MIN
    // and CJK_MARGIN; the next name is 0.15 behind.
    expect(diceCoefficient('坐姿推举', '壶铃坐姿推举')).toBeCloseTo(0.75)
    expect(longestCommonSubstring('坐姿推举', '壶铃坐姿推举')).toBe(4)
    expect(diceCoefficient('坐姿推举', '壶铃坐姿推举') - diceCoefficient('坐姿推举', '哑铃凳上坐姿推举')).toBeGreaterThanOrEqual(CJK_MARGIN)
  })

  it('discards an ambiguous Chinese name instead of guessing', () => {
    expect(idsOf(match('zh', { name: '高位下拉', level: 'high', rationale: '高位下拉' }))).toEqual([])
    expect(idsOf(match('zh', { name: '绳索划船', level: 'high', rationale: '绳索划船' }))).toEqual([])
  })

  it('reads saved aliases and custom actions', () => {
    expect(idsOf(match('custom', { name: 'my bench', level: 'high', rationale: '保存的别名' }))).toEqual(['0025'])
    expect(idsOf(match('custom', { name: 'Viking row', level: 'high', rationale: '自建动作的别名' }))).toEqual(['custom-1'])
    expect(idsOf(match('custom', { name: 'sled drag rope', level: 'high', rationale: '自建动作' }))).toEqual(['custom-1'])
  })

  it('uses equipment and body-part hints to order close candidates', () => {
    const candidates = [
      { name: 'dumbbell lateral raise', level: 'high', rationale: '哑铃侧平举' },
      { name: 'cable lateral raise', level: 'high', rationale: '绳索侧平举' },
    ]
    const baseline = AI.en.match({ candidates, fallback: { understanding: 'x' } })
    expect(idsOf(baseline)).toEqual(['0334', '0178'])

    const hinted = AI.en.match({
      candidates: candidates.map(candidate => candidate.name === 'cable lateral raise'
        ? { ...candidate, equipment: 'cable', bodyPart: 'shoulders' }
        : candidate),
      fallback: { understanding: 'x' },
    })
    expect(idsOf(hinted)[0]).toBe('0178')

    const bodyPartOnly = AI.en.match({
      candidates: candidates.map(candidate => candidate.name === 'cable lateral raise'
        ? { ...candidate, bodyPart: 'shoulders' }
        : candidate),
      fallback: { understanding: 'x' },
    })
    expect(idsOf(bodyPartOnly)[0]).toBe('0178')
    expect(EQ_BONUS).toBe(25)
    expect(BP_BONUS).toBe(15)
  })

  it('drops a candidate whose equipment hint contradicts a bodyweight hit', () => {
    const result = match('en', {
      name: 'push-up',
      level: 'high',
      rationale: '地面俯卧撑',
      equipment: 'smith machine',
      bodyPart: 'chest',
    })
    expect(idsOf(result)).toEqual([])
  })

  it('falls back honestly when nothing matches', () => {
    const result = match('en', { name: 'plate of pasta', level: 'high', rationale: 'food' }, { understanding: '照片里是一盘食物' })
    expect(idsOf(result)).toEqual([])
    expect(result.fallback.understanding).toBe('照片里是一盘食物')

    const hinted = AI.en.match({ candidates: [{ name: 'plate of pasta', level: 'high', rationale: 'food' }] }, { hintText: '一盘意面' })
    expect(hinted.fallback.understanding).toBe('一盘意面')

    const empty = AI.en.match({ candidates: [] })
    expect(empty.fallback.understanding.length).toBeGreaterThan(0)
  })

  it('composes the UI level from match strength and the model level', () => {
    const exact = name => match('en', { name, level: 'high', rationale: 'x' })
    expect(exact('barbell bench press').items[0].level).toBe('high')
    expect(match('en', { name: 'barbell bench press', level: 'medium', rationale: 'x' }).items[0].level).toBe('medium')
    expect(match('en', { name: 'barbell bench press', level: 'low', rationale: 'x' }).items[0].level).toBe('medium')
    expect(match('en', { name: 'bnech press', level: 'high', rationale: 'x' }).items[0].level).toBe('medium')
    expect(match('zh', { name: '坐姿推举', level: 'high', rationale: 'x' }).items[0].level).toBe('low')
  })

  it('gives both hosts the same ids for the fixture provider candidates', async () => {
    const fixture = await createFixtureProvider({ case: 'candidates' }).invoke({})
    const web = createWebAiSearch({}).match(fixture)
    const rn = AI.en.match(fixture)
    const webIds = idsOf(web).sort()
    const rnIds = idsOf(rn).sort()
    expect(webIds).toEqual(['0091', '0405'])
    expect(rnIds).toEqual(webIds)
  })
})

describe('AI exercise retrieval goldens (3.4)', () => {
  it('has a complete, honest case set', () => {
    expect(golden.cases.length).toBeGreaterThanOrEqual(85)
    expect(golden.cases.length).toBeLessThanOrEqual(95)
    expect(new Set(golden.cases.map(caseItem => caseItem.id)).size).toBe(golden.cases.length)
    for (const caseItem of golden.cases) {
      expect(['english', 'chinese', 'ambiguous', 'conflict', 'boundary']).toContain(caseItem.subset)
      expect(['en', 'zh', 'custom', 'zh-custom']).toContain(caseItem.pool)
      for (const id of declaredIds(caseItem)) {
        expect(KNOWN_IDS.has(id), `${caseItem.id} references unknown exercise ${id}`).toBe(true)
      }
    }
  })

  it('meets the English and Chinese retrieval thresholds', () => {
    const english = bySubset('english')
    const chinese = bySubset('chinese')
    report('english', english, 'top1Hit', 'top5Hit')
    report('chinese', chinese, 'top1Hit', 'top5Hit')
    console.log(`[ai-golden] total: cases ${RESULTS.length}, pass ${RESULTS.filter(row => row.pass).length}/${RESULTS.length}`)
    const structural = [...english, ...chinese]
      .filter(row => row.structuralErrors.length)
      .map(row => `${row.caseItem.id}: ${row.structuralErrors.join('; ')}`)
    expect(structural, `english/chinese structural failures: ${structural.join(' | ')}`).toEqual([])
    expect(rate(english, 'top1Hit'), `english top-1 misses: ${failures(english).join(' | ')}`).toBeGreaterThanOrEqual(0.90)
    expect(rate(english, 'top5Hit'), `english top-5 misses: ${failures(english).join(' | ')}`).toBeGreaterThanOrEqual(0.97)
    expect(rate(chinese, 'top1Hit'), `chinese top-1 misses: ${failures(chinese).join(' | ')}`).toBeGreaterThanOrEqual(0.75)
    expect(rate(chinese, 'top5Hit'), `chinese top-5 misses: ${failures(chinese).join(' | ')}`).toBeGreaterThanOrEqual(0.90)
  })

  it('keeps ambiguity, conflict and boundary cases at 100%', () => {
    for (const subset of ['ambiguous', 'conflict', 'boundary']) {
      const rows = bySubset(subset)
      console.log(`[ai-golden] ${subset}: cases ${rows.length}, pass ${rows.filter(row => row.pass).length}/${rows.length} (${percent(rate(rows, 'pass'))})`)
      expect(failures(rows), `${subset} failures: ${failures(rows).join(' | ')}`).toEqual([])
    }
  })

  it('never labels a wrong exercise as high confidence', () => {
    const wrong = RESULTS.flatMap(result => result.wrongHigh.map(id => `${result.caseItem.id} -> ${id}`))
    console.log(`[ai-golden] wrong-high: ${wrong.length}`)
    expect(wrong).toEqual([])
  })
})

describe('AI exercise matcher diagnostics (D04)', () => {
  // Pools with a source of trust for public ids, mirroring the RN rule
  // (catalogue entries only); the Web one is object identity in exercises.js.
  const aiPublicOf = (engine, list) => createExerciseAiSearch({
    searchScored: engine.searchScored,
    list,
    bodyPartValues: BODYPARTS,
    equipmentValues: EQUIPMENTS,
    isPublicExercise: exercise => exercise.custom !== true,
  })
  const PUBLIC_AI = {
    en: aiPublicOf(EN_SEARCH, EN_POOL),
    zh: aiPublicOf(ZH_SEARCH, ZH_POOL),
    custom: aiPublicOf(CUSTOM_SEARCH, CUSTOM_POOL),
  }
  const collect = (matcher, output, evaluation) => {
    const events = []
    const result = matcher.match(output, {
      // Production callers pass only `{ emit }`; the evaluation adds itself.
      diagnostics: {
        emit: event => events.push(event),
        ...(evaluation ? { evaluation } : {}),
      },
    })
    return { events, result }
  }
  const recalls = events => events.filter(event => event.stage === 'recall')
  const filters = events => events.filter(event => event.stage === 'filter')
  const display = events => events.find(event => event.stage === 'display')

  it('keeps the production event shapes fixed', () => {
    const { events } = collect(PUBLIC_AI.custom, {
      candidates: [{ name: 'my bench', level: 'high', rationale: '保存的别名' }],
      fallback: { understanding: 'x' },
    })
    expect(events.map(event => Object.keys(event))).toEqual([
      ['stage', 'candidateIndex', 'queryOrigin', 'queryWordCount', 'hitCount', 'top'],
      ['stage', 'candidateIndex', 'decision', 'id'],
      ['stage', 'resultCount', 'publicIds', 'customCount', 'fallbackOnly', 'elapsedMs'],
    ])
  })

  it('records an empty recall and a no_hit when the query finds nothing', () => {
    const injected = createExerciseAiSearch({
      searchScored: () => [],
      list: EN_POOL,
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
      isPublicExercise: exercise => exercise.custom !== true,
    })
    const { events, result } = collect(injected, {
      candidates: [{ name: 'orbital prism contraption', level: 'high', rationale: 'x' }],
      fallback: { understanding: '不存在的器械' },
    })
    expect(idsOf(result)).toEqual([])
    expect(recalls(events)).toEqual([{
      stage: 'recall',
      candidateIndex: 0,
      queryOrigin: 'primary',
      queryWordCount: 3,
      hitCount: 0,
      top: [],
    }])
    expect(filters(events)).toEqual([{ stage: 'filter', candidateIndex: 0, decision: 'no_hit' }])
    expect(display(events)).toMatchObject({
      stage: 'display', resultCount: 0, publicIds: [], customCount: 0, fallbackOnly: true,
    })
  })

  it('still records a rank-4 expected id that top-3 selection never surfaces', () => {
    // The repeatable evaluation case (A2): the top-3 keyword hits all lack
    // name evidence, the expected exercise sits behind them at rank 4, and the
    // output stays empty because within-query selection only inspects the top 3.
    const conflictor1 = EXDB.find(exercise => exercise.id === '0027') // barbell bent over row
    const conflictor2 = EXDB.find(exercise => exercise.id === '0031') // barbell curl
    const conflictor3 = EXDB.find(exercise => exercise.id === '0463') // front plank
    const expected = EXDB.find(exercise => exercise.id === '0576') // lever chest press
    const injected = createExerciseAiSearch({
      searchScored: () => [
        { exercise: conflictor1, score: 65 },
        { exercise: conflictor2, score: 64 },
        { exercise: conflictor3, score: 63 },
        { exercise: expected, score: 62 },
      ],
      list: [conflictor1, conflictor2, conflictor3, expected],
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
      isPublicExercise: exercise => exercise.custom !== true,
    })
    const output = {
      candidates: [{ name: 'lever chest press', level: 'high', rationale: '器械推胸' }],
      fallback: { understanding: '用户在找器械推胸' },
    }
    const { events, result } = collect(injected, output, { expectedIds: ['0576'], includeQueries: false })
    expect(idsOf(result)).toEqual([])
    expect(recalls(events)).toEqual([{
      stage: 'recall',
      candidateIndex: 0,
      queryOrigin: 'primary',
      queryWordCount: 3,
      hitCount: 4,
      top: [
        { id: '0027', score: 65 },
        { id: '0031', score: 64 },
        { id: '0463', score: 63 },
        { id: '0576', score: 62 },
      ],
      expectedRanks: [4],
    }])
    expect(filters(events)).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'no_name_evidence', id: '0027' },
    ])
    expect(display(events)).toMatchObject({ resultCount: 0, fallbackOnly: true })
    expect(injected.match(output)).toEqual(result)

    // Only the evaluation's includeQueries flag ever adds the raw query.
    const withQuery = collect(injected, output, { expectedIds: ['0576'], includeQueries: true })
    expect(recalls(withQuery.events)[0].query).toBe('lever chest press')
    expect(withQuery.result).toEqual(result)
  })

  it('runs the English query when nameEn is present and differs from name', () => {
    const output = {
      candidates: [{ name: '坐姿推举', nameEn: 'seated press', level: 'high', rationale: '坐姿上推' }],
      fallback: { understanding: 'x' },
    }
    const { events, result } = collect(PUBLIC_AI.zh, output, { expectedIds: ['0546'], includeQueries: true })
    expect(idsOf(result)).toEqual(['0546'])
    expect(recalls(events).map(event => event.queryOrigin)).toEqual(['english', 'primary'])
    expect(recalls(events).map(event => event.query)).toEqual(['seated press', '坐姿推举'])
    expect(recalls(events).map(event => event.queryWordCount)).toEqual([2, 1])
    expect(filters(events)).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'accepted_cjk_fallback', id: '0546' },
    ])

    const plain = collect(PUBLIC_AI.zh, {
      candidates: [{ name: 'barbell bench press', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(recalls(plain.events).map(event => event.queryOrigin)).toEqual(['primary'])
  })

  it('projects public ids only for trusted entries across decision kinds', () => {
    // A custom action is accepted but never reported as a public id.
    const custom = collect(PUBLIC_AI.custom, {
      candidates: [{ name: 'Viking row', level: 'high', rationale: '自建动作的别名' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(custom.result)).toEqual(['custom-1'])
    expect(recalls(custom.events)[0].top).toEqual([])
    expect(filters(custom.events)).toEqual([{ stage: 'filter', candidateIndex: 0, decision: 'accepted' }])
    expect(display(custom.events)).toMatchObject({ resultCount: 1, publicIds: [], customCount: 1, fallbackOnly: false })

    // A saved alias on a catalogue exercise is accepted with its public id.
    const alias = collect(PUBLIC_AI.custom, {
      candidates: [{ name: 'my bench', level: 'high', rationale: '保存的别名' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(alias.result)).toEqual(['0025'])
    expect(recalls(alias.events)[0].top[0].id).toBe('0025')
    expect(filters(alias.events)).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'accepted', id: '0025' },
    ])
    expect(display(alias.events)).toMatchObject({ resultCount: 1, publicIds: ['0025'], customCount: 0 })

    // A Chinese name the character fallback cannot decide between is the
    // ambiguity rejection and carries no id.
    const ambiguous = collect(PUBLIC_AI.zh, {
      candidates: [{ name: '高位下拉', level: 'high', rationale: '高位下拉' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(ambiguous.result)).toEqual([])
    expect(filters(ambiguous.events)).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'cjk_ambiguous' },
    ])

    // A Chinese name with no qualifying fallback items is an evidence
    // rejection of the keyword hit, and that exercise's id is validated.
    const noFallback = collect(PUBLIC_AI.zh, {
      candidates: [{ name: '绳索划船', level: 'high', rationale: '绳索划船' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(noFallback.result)).toEqual([])
    expect(filters(noFallback.events)[0].decision).toBe('no_name_evidence')
    expect(filters(noFallback.events)[0].id).toBe(recalls(noFallback.events)[0].top[0].id)

    // An equipment contradiction is a validated rejection with an id.
    const conflict = collect(PUBLIC_AI.en, {
      candidates: [{
        name: 'push-up', level: 'high', rationale: '地面俯卧撑',
        equipment: 'smith machine', bodyPart: 'chest',
      }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(conflict.result)).toEqual([])
    expect(filters(conflict.events)).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'equipment_conflict', id: '0662' },
    ])

    // A keyword hit below the floor is rejected with its id.
    const low = createExerciseAiSearch({
      searchScored: () => [{ exercise: EXDB.find(exercise => exercise.id === '0025'), score: 12 }],
      list: EN_POOL,
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
      isPublicExercise: exercise => exercise.custom !== true,
    })
    const floored = collect(low, {
      candidates: [{ name: 'lever chest press', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(floored.result)).toEqual([])
    expect(filters(floored.events)).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'below_floor', id: '0025' },
    ])
  })

  it('reports deduplicated and invalid candidates without inventing ids', () => {
    const { events, result } = collect(PUBLIC_AI.custom, {
      candidates: [
        null,
        {},
        { name: 'barbell bench press', level: 'high', rationale: '一' },
        { name: 'barbell bench press', level: 'low', rationale: '二' },
      ],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(result)).toEqual(['0025'])
    expect(filters(events)).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'invalid_candidate' },
      { stage: 'filter', candidateIndex: 1, decision: 'invalid_candidate' },
      { stage: 'filter', candidateIndex: 2, decision: 'accepted', id: '0025' },
      { stage: 'filter', candidateIndex: 3, decision: 'accepted', id: '0025' },
      { stage: 'filter', candidateIndex: 3, decision: 'deduplicated' },
    ])
    expect(display(events)).toMatchObject({ resultCount: 1, publicIds: ['0025'], customCount: 0 })
  })

  it('returns deeply identical results with and without diagnostics', () => {
    const outputs = [
      { candidates: [{ name: 'barbell bench press', level: 'high', rationale: 'x' }], fallback: { understanding: 'x' } },
      { candidates: [{ name: '坐姿推举', level: 'high', rationale: 'x' }], fallback: { understanding: 'x' } },
      { candidates: [{ name: 'Viking row', level: 'high', rationale: 'x' }], fallback: { understanding: 'x' } },
      { candidates: [{ name: '高位下拉', level: 'high', rationale: 'x' }], fallback: { understanding: 'x' } },
      { candidates: [
        { name: 'dumbbell lateral raise', level: 'high', rationale: 'x' },
        { name: 'cable lateral raise', level: 'high', rationale: 'y', equipment: 'cable', bodyPart: 'shoulders' },
      ], fallback: { understanding: 'x' } },
    ]
    for (const pool of ['en', 'zh', 'custom', 'zh-custom']) {
      for (const output of outputs) {
        const plain = AI[pool].match(output, { hintText: '提示' })
        expect(AI[pool].match(output, { hintText: '提示', diagnostics: { emit: () => {} } })).toEqual(plain)
        expect(AI[pool].match(output, {
          hintText: '提示',
          diagnostics: { emit: () => {}, evaluation: { expectedIds: ['0025', '0576'], includeQueries: true } },
        })).toEqual(plain)
      }
    }
  })

  it('isolates a broken diagnostics sink from the match result', () => {
    const output = {
      candidates: [{ name: 'barbell bench press', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }
    const plain = AI.en.match(output)
    const broken = AI.en.match(output, { diagnostics: { emit: () => { throw new Error('sink down') } } })
    expect(broken).toEqual(plain)
  })
})

describe('AI exercise within-query top-3 selection (Group B)', () => {
  const synth = (id, n, eq, extra = {}) => ({
    id,
    n,
    name: extra.name || n,
    eq,
    bp: extra.bp || 'chest',
    aliases: extra.aliases || [],
    custom: extra.custom === true,
  })
  const makeInjected = (resultsByQuery, pool) => createExerciseAiSearch({
    searchScored: (_list, query) => resultsByQuery[query] || [],
    list: pool,
    bodyPartValues: BODYPARTS,
    equipmentValues: EQUIPMENTS,
    isPublicExercise: exercise => exercise.custom !== true,
  })
  const collectEvents = (matcher, output) => {
    const events = []
    const result = matcher.match(output, { diagnostics: { emit: event => events.push(event) } })
    return { events, result }
  }

  it('picks a rank-2 hit whose equipment matches the hint even when rank 1 passes', () => {
    const cable = synth('s-cable', 'cable seated chest press', 'cable')
    const lever = synth('s-lever', 'lever seated chest press', 'leverage machine')
    const matcher = makeInjected({
      'seated chest press': [
        { exercise: cable, score: 303 },
        { exercise: lever, score: 297 },
      ],
    }, [cable, lever])
    const result = matcher.match({
      candidates: [{ name: 'seated chest press', equipment: 'leverage machine', level: 'high', rationale: '坐姿推胸' }],
      fallback: { understanding: '推胸机' },
    })
    expect(idsOf(result)).toEqual(['s-lever'])

    const oppositeFallback = matcher.match({
      candidates: [{ name: 'seated chest press', equipment: 'leverage machine', level: 'high', rationale: '坐姿推胸' }],
      fallback: { understanding: '推胸机', equipment: ['cable'] },
    })
    expect(idsOf(oppositeFallback)).toEqual(['s-lever'])

    const invalidCandidateEq = matcher.match({
      candidates: [{ name: 'seated chest press', equipment: 'not-a-valid-slug', level: 'high', rationale: '坐姿推胸' }],
      fallback: { understanding: '推胸机', equipment: ['leverage machine'] },
    })
    expect(idsOf(invalidCandidateEq)).toEqual(['s-cable'])
  })

  it('reviews ranks 2 and 3 when earlier items are rejected, and ignores rank 4', () => {
    const unrelated = synth('s-bad', 'barbell bent over row', 'barbell', { bp: 'back' })
    const lowScore = synth('s-low', 'cable chest press', 'cable')
    const rank3 = synth('s-r3', 'lever chest press', 'leverage machine')
    const rank4 = synth('s-r4', 'smith chest press', 'smith machine')

    const m3 = makeInjected({
      'chest press': [
        { exercise: unrelated, score: 90 },
        { exercise: lowScore, score: BASE_FLOOR - 1 },
        { exercise: rank3, score: 75 },
        { exercise: rank4, score: 74 },
      ],
    }, [unrelated, lowScore, rank3, rank4])
    expect(idsOf(m3.match({
      candidates: [{ name: 'chest press', equipment: 'smith machine', level: 'high', rationale: '推胸' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-r3'])

    const m4Only = makeInjected({
      'chest press': [
        { exercise: unrelated, score: 90 },
        { exercise: lowScore, score: BASE_FLOOR - 1 },
        { exercise: synth('s-bw', 'chest press push-up', 'body weight'), score: 80 },
        { exercise: rank4, score: 79 },
      ],
    }, [unrelated, lowScore, rank4])
    const { events, result } = collectEvents(m4Only, {
      candidates: [{ name: 'chest press', equipment: 'smith machine', level: 'high', rationale: '推胸' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(result)).toEqual([])
    expect(events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'no_name_evidence', id: 's-bad' },
    ])
  })

  it('keeps original rank order without an equipment hint or with multi-value fallback equipment', () => {
    const cable = synth('s-cable', 'cable seated chest press', 'cable')
    const lever = synth('s-lever', 'lever seated chest press', 'leverage machine')
    const matcher = makeInjected({
      'seated chest press': [
        { exercise: cable, score: 303 },
        { exercise: lever, score: 297 },
      ],
    }, [cable, lever])

    expect(idsOf(matcher.match({
      candidates: [{ name: 'seated chest press', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-cable'])

    expect(idsOf(matcher.match({
      candidates: [{ name: 'seated chest press', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x', equipment: ['leverage machine', 'cable'] },
    }))).toEqual(['s-cable'])
  })

  it('does not use single-value fallback equipment for within-query ordering', () => {
    const sled = synth('1583', 'sled reverse hack squat', 'sled machine', { bp: 'upper legs' })
    const lever = synth('5784', 'lever reverse vertical hack squat', 'leverage machine', { bp: 'upper legs' })
    const matcher = makeInjected({
      'reverse hack squat': [
        { exercise: sled, score: 299 },
        { exercise: lever, score: 297 },
      ],
    }, [sled, lever])

    const withoutFallback = matcher.match({
      candidates: [{ name: 'reverse hack squat', level: 'low', rationale: '反向哈克深蹲' }],
      fallback: { understanding: '腿部器械' },
    })
    const withFallback = matcher.match({
      candidates: [{ name: 'reverse hack squat', level: 'low', rationale: '反向哈克深蹲' }],
      fallback: { understanding: '腿部器械', equipment: ['leverage machine'] },
    })

    expect(withFallback.items).toEqual(withoutFallback.items)
    expect(idsOf(withFallback)).toEqual(['1583'])
    expect(withFallback.fallback.equipment).toEqual(['leverage machine'])
  })

  it('prefers a rank-2 exact name or saved alias over a rank-1 non-exact hit, and still rejects conflicting exact hits', () => {
    const nonExact = synth('s-r1', 'lever seated chest press', 'leverage machine')
    const exactName = synth('s-r2', 'chest press', 'cable')
    const exactAlias = synth('s-alias', 'machine press', 'cable', { aliases: ['my press'] })
    const bwExact = synth('s-bw', 'chest press', 'body weight')

    const mExact = makeInjected({
      'chest press': [
        { exercise: nonExact, score: 300 },
        { exercise: exactName, score: 50 },
      ],
    }, [nonExact, exactName])
    expect(idsOf(mExact.match({
      candidates: [{ name: 'chest press', equipment: 'leverage machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-r2'])

    const mAlias = makeInjected({
      'my press': [
        { exercise: nonExact, score: 300 },
        { exercise: exactAlias, score: 40 },
      ],
    }, [nonExact, exactAlias])
    expect(idsOf(mAlias.match({
      candidates: [{ name: 'my press', equipment: 'leverage machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-alias'])

    const mConflict = makeInjected({
      'chest press': [
        { exercise: bwExact, score: 350 },
      ],
    }, [bwExact])
    const { events, result } = collectEvents(mConflict, {
      candidates: [{ name: 'chest press', equipment: 'leverage machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(result)).toEqual([])
    expect(events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'equipment_conflict', id: 's-bw' },
    ])
  })

  it('rejects a candidate when all exact matches in top 3 hit equipment conflict, without falling back to non-exact variants, bilingual queries, or CJK fallback', () => {
    const bwPushUp = synth('0662', 'push-up', 'body weight', { name: '俯卧撑' })
    const bosuPushUp = synth('0653', 'push-up (bosu ball)', 'bosu ball', { name: '波速球俯卧撑' })
    const compatExact = synth('s-smith-pushup', 'push-up', 'smith machine', { name: '俯卧撑' })
    const nonExactBw = synth('s-bw-var', 'decline push-up', 'body weight')

    // All exact hits in top 3 conflict -> do not substitute non-exact rank-3 variant.
    const mSingle = makeInjected({
      'push-up': [
        { exercise: bwPushUp, score: 113 },
        { exercise: nonExactBw, score: 110 },
        { exercise: bosuPushUp, score: 104 },
      ],
    }, [bwPushUp, nonExactBw, bosuPushUp])
    const single = collectEvents(mSingle, {
      candidates: [{ name: 'push-up', equipment: 'smith machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(single.result)).toEqual([])
    expect(single.events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'equipment_conflict', id: '0662' },
    ])

    // Another compatible exact match in top 3 is still allowed.
    const mCompatExact = makeInjected({
      'push-up': [
        { exercise: bwPushUp, score: 113 },
        { exercise: bosuPushUp, score: 108 },
        { exercise: compatExact, score: 104 },
      ],
    }, [bwPushUp, bosuPushUp, compatExact])
    expect(idsOf(mCompatExact.match({
      candidates: [{ name: 'push-up', equipment: 'smith machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-smith-pushup'])

    // Bilingual query + CJK fallback must not bypass an exact-match conflict from English query.
    const mBilingual = makeInjected({
      'push-up': [
        { exercise: bwPushUp, score: 113 },
        { exercise: bosuPushUp, score: 104 },
      ],
      '标准俯卧撑': [
        { exercise: bosuPushUp, score: 120 },
      ],
    }, [bwPushUp, bosuPushUp])
    const bilingual = collectEvents(mBilingual, {
      candidates: [{ name: '标准俯卧撑', nameEn: 'push-up', equipment: 'smith machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(bilingual.result)).toEqual([])
    expect(bilingual.events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'equipment_conflict', id: '0662' },
    ])

    // Bilingual query where primary query is empty and CJK fallback would pick a non-exact exercise.
    const enOnlyBw = synth('0662', 'push-up', 'body weight', { name: 'push-up' })
    const zhOnlyBosu = synth('0653', 'push-up (bosu ball)', 'bosu ball', { name: '波速球标准俯卧撑' })
    const mCjkBypass = makeInjected({
      'push-up': [{ exercise: enOnlyBw, score: 113 }],
      '标准俯卧撑': [],
    }, [enOnlyBw, zhOnlyBosu])
    const cjkBypass = collectEvents(mCjkBypass, {
      candidates: [{ name: '标准俯卧撑', nameEn: 'push-up', equipment: 'smith machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(cjkBypass.result)).toEqual([])
    expect(cjkBypass.events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'equipment_conflict', id: '0662' },
    ])

    // Single Chinese query exact conflict must not bypass via CJK character fallback.
    const zhPushUp = synth('s-zh-bw', 'floor push-up', 'body weight', { name: '标准俯卧撑' })
    const zhBosu = synth('s-zh-bosu', 'bosu push-up', 'bosu ball', { name: '波速球标准俯卧撑' })
    const mZhOnly = makeInjected({
      '标准俯卧撑': [
        { exercise: zhPushUp, score: 113 },
        { exercise: zhBosu, score: 104 },
      ],
    }, [zhPushUp, zhBosu])
    const zhOnly = collectEvents(mZhOnly, {
      candidates: [{ name: '标准俯卧撑', equipment: 'smith machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(zhOnly.result)).toEqual([])
    expect(zhOnly.events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'equipment_conflict', id: 's-zh-bw' },
    ])

    // Non-exact rank-1 equipment conflict still allows rank-2 non-exact hit.
    const mNonExactConflict = makeInjected({
      'press push-up': [
        { exercise: nonExactBw, score: 110 },
        { exercise: bosuPushUp, score: 104 },
      ],
    }, [nonExactBw, bosuPushUp])
    expect(idsOf(mNonExactConflict.match({
      candidates: [{ name: 'press push-up', equipment: 'smith machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['0653'])
  })

  it('chooses the higher raw score across English and primary queries, keeping query order on ties', () => {
    const enHit = synth('s-en', 'lever chest press', 'leverage machine', { name: '推胸甲' })
    const zhHit = synth('s-zh', 'seated machine chest press', 'leverage machine', { name: '推胸乙' })

    const zhHigher = makeInjected({
      'chest press': [{ exercise: enHit, score: 150 }],
      '器械推胸': [{ exercise: zhHit, score: 180 }],
    }, [enHit, zhHit])
    expect(idsOf(zhHigher.match({
      candidates: [{ name: '器械推胸', nameEn: 'chest press', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-zh'])

    const tied = makeInjected({
      'chest press': [{ exercise: enHit, score: 180 }],
      '器械推胸': [{ exercise: zhHit, score: 180 }],
    }, [enHit, zhHit])
    expect(idsOf(tied.match({
      candidates: [{ name: '器械推胸', nameEn: 'chest press', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-en'])
  })

  it('preserves CJK exact match, character fallback, and ambiguity paths', () => {
    const exact = synth('s-exact', 'lever chest press', 'leverage machine', { name: '坐姿推胸机' })
    const near1 = synth('s-near1', 'kettlebell seated press', 'kettlebell', { name: '壶铃坐姿推举' })
    const near2 = synth('s-near2', 'barbell seated press', 'barbell', { name: '杠铃坐姿推举' })

    const mExact = makeInjected({
      '坐姿推胸机': [{ exercise: exact, score: 80 }],
    }, [exact, near1])
    const resExact = mExact.match({
      candidates: [{ name: '坐姿推胸机', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(resExact)).toEqual(['s-exact'])
    expect(resExact.items[0].level).toBe('high')

    const mFallback = makeInjected({
      '坐姿推举': [],
    }, [near1])
    const resFallback = mFallback.match({
      candidates: [{ name: '坐姿推举', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(resFallback)).toEqual(['s-near1'])
    expect(resFallback.items[0].level).toBe('low')

    const mAmbig = makeInjected({
      '坐姿推举': [],
    }, [near1, near2])
    const { events, result } = collectEvents(mAmbig, {
      candidates: [{ name: '坐姿推举', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(result)).toEqual([])
    expect(events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'cjk_ambiguous' },
    ])
  })
})

describe('AI exercise chest-press variant rule (Group C)', () => {
  const synth = (id, n, eq, extra = {}) => ({
    id,
    n,
    name: extra.name || n,
    eq,
    bp: extra.bp || 'chest',
    aliases: extra.aliases || [],
    custom: extra.custom === true,
  })
  const makeInjected = (resultsByQuery, pool) => createExerciseAiSearch({
    searchScored: (_list, query) => resultsByQuery[query] || [],
    list: pool,
    bodyPartValues: BODYPARTS,
    equipmentValues: EQUIPMENTS,
    isPublicExercise: exercise => exercise.custom !== true,
  })

  it('prefers generic lever chest press (0576) over unsupported inner variant (1301) with same equipment', () => {
    const inner = synth('1301', 'lever chest press (inner)', 'leverage machine')
    const generic = synth('0576', 'lever chest press', 'leverage machine')
    const matcher = makeInjected({
      'seated chest press': [
        { exercise: inner, score: 250 },
        { exercise: generic, score: 245 },
      ],
    }, [inner, generic])
    const result = matcher.match({
      candidates: [{ name: 'seated chest press', equipment: 'leverage machine', level: 'high', rationale: '坐姿推胸' }],
      fallback: { understanding: '推胸机' },
    })
    expect(idsOf(result)).toEqual(['0576'])
  })

  it('does not penalize incline when explicitly requested in English or Chinese, and treats single-arm and one-arm as equivalent', () => {
    const incline = synth('1299', 'lever incline chest press', 'leverage machine')
    const generic = synth('0576', 'lever chest press', 'leverage machine')
    const oneArm = synth('s-one-arm', 'lever one-arm chest press', 'leverage machine')

    const mEn = makeInjected({
      'incline chest press': [
        { exercise: incline, score: 260 },
        { exercise: generic, score: 250 },
      ],
    }, [incline, generic])
    expect(idsOf(mEn.match({
      candidates: [{ name: 'incline chest press', equipment: 'leverage machine', level: 'high', rationale: '上斜推胸' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['1299'])

    const mZh = makeInjected({
      'seated chest press': [
        { exercise: incline, score: 260 },
        { exercise: generic, score: 250 },
      ],
      '上斜推胸': [],
    }, [incline, generic])
    expect(idsOf(mZh.match({
      candidates: [{ name: '上斜推胸', nameEn: 'seated chest press', equipment: 'leverage machine', level: 'high', rationale: '上斜推胸' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['1299'])

    const mOneArm = makeInjected({
      'single-arm chest press': [
        { exercise: oneArm, score: 260 },
        { exercise: generic, score: 250 },
      ],
    }, [oneArm, generic])
    expect(idsOf(mOneArm.match({
      candidates: [{ name: 'single-arm chest press', equipment: 'leverage machine', level: 'high', rationale: '单臂推胸' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-one-arm'])
  })

  it('keeps Group B ordering across different equipment without an equipment hint', () => {
    const cableInner = synth('s-c-inner', 'cable inner chest press', 'cable')
    const leverPlain = synth('0576', 'lever chest press', 'leverage machine')

    const mDiffEq = makeInjected({
      'seated chest press': [
        { exercise: cableInner, score: 260 },
        { exercise: leverPlain, score: 255 },
      ],
    }, [cableInner, leverPlain])
    expect(idsOf(mDiffEq.match({
      candidates: [{ name: 'seated chest press', level: 'high', rationale: '坐姿推胸' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-c-inner'])
  })

  it('ranks high-confidence generic lever chest press ahead of low-confidence incline press despite raw score', () => {
    const incline = synth('1299', 'lever incline chest press', 'leverage machine')
    const inner = synth('1301', 'lever chest press (inner)', 'leverage machine')
    const flat = synth('0576', 'lever chest press', 'leverage machine')
    const matcher = makeInjected({
      'incline chest press': [{ exercise: incline, score: 303 }],
      'seated chest press': [
        { exercise: inner, score: 250 },
        { exercise: flat, score: 245 },
      ],
    }, [incline, inner, flat])
    const result = matcher.match({
      candidates: [
        { name: 'incline chest press', equipment: 'leverage machine', level: 'low', rationale: '上斜' },
        { name: 'seated chest press', equipment: 'leverage machine', level: 'high', rationale: '平推' },
      ],
      fallback: { understanding: '推胸机' },
    })
    expect(idsOf(result)).toEqual(['0576', '1299'])
  })
})

describe('AI exercise cross-query ranking & unsupported variants (P0-A)', () => {
  const synth = (id, n, eq, extra = {}) => ({
    id,
    n,
    name: extra.name || n,
    eq,
    bp: extra.bp || 'chest',
    aliases: extra.aliases || [],
    custom: extra.custom === true,
  })
  const makeInjected = (resultsByQuery, pool) => createExerciseAiSearch({
    searchScored: (_list, query) => resultsByQuery[query] || [],
    list: pool,
    bodyPartValues: BODYPARTS,
    equipmentValues: EQUIPMENTS,
    isPublicExercise: exercise => exercise.custom !== true,
  })

  it('places high-confidence 3-word generic movement ahead of low-confidence 4-word variant', () => {
    const incline = synth('1299', 'lever incline chest press', 'leverage machine')
    const generic = synth('0576', 'lever chest press', 'leverage machine')
    const matcher = makeInjected({
      'lever incline chest press': [{ exercise: incline, score: 400 }],
      'lever chest press': [{ exercise: generic, score: 250 }],
    }, [incline, generic])

    const result = matcher.match({
      candidates: [
        { name: 'lever incline chest press', equipment: 'leverage machine', bodyPart: 'chest', level: 'low', rationale: '可能是上斜' },
        { name: 'lever chest press', equipment: 'leverage machine', bodyPart: 'chest', level: 'high', rationale: '杠杆推胸' },
      ],
      fallback: { understanding: '推胸机' },
    })
    expect(idsOf(result)).toEqual(['0576', '1299'])
  })

  it('prevents a low-confidence exact variant from outranking a high-confidence evidence-backed hit', () => {
    const exactLow = synth('s-low-exact', 'lever decline chest press', 'leverage machine')
    const evidenceHigh = synth('0576', 'lever chest press', 'leverage machine')
    const matcher = makeInjected({
      'lever decline chest press': [{ exercise: exactLow, score: 420 }],
      'chest press': [{ exercise: evidenceHigh, score: 180 }],
    }, [exactLow, evidenceHigh])

    const result = matcher.match({
      candidates: [
        { name: 'lever decline chest press', equipment: 'leverage machine', level: 'low', rationale: '猜测下斜' },
        { name: 'chest press', equipment: 'leverage machine', level: 'high', rationale: '高置信平推' },
      ],
      fallback: { understanding: '推胸' },
    })
    expect(idsOf(result)).toEqual(['0576', 's-low-exact'])
  })

  it('orders same-level candidates by exact, then equipmentMatch, then bodyPartMatch', () => {
    const base = synth('s-base', 'cable seated row', 'cable', { bp: 'back' })
    const bpOnly = synth('s-bp', 'cable wide row', 'cable', { bp: 'back' })
    const eqOnly = synth('s-eq', 'cable close row', 'cable', { bp: 'upper arms' })
    const exactHit = synth('s-exact', 'cable row', 'barbell', { bp: 'upper arms' })
    const matcher = makeInjected({
      'row base': [{ exercise: base, score: 300 }],
      'row bp': [{ exercise: bpOnly, score: 250 }],
      'row eq': [{ exercise: eqOnly, score: 200 }],
      'cable row': [{ exercise: exactHit, score: 150 }],
    }, [base, bpOnly, eqOnly, exactHit])

    const result = matcher.match({
      candidates: [
        { name: 'row base', level: 'high', rationale: '基础' },
        { name: 'row bp', bodyPart: 'back', level: 'high', rationale: '仅部位一致' },
        { name: 'row eq', equipment: 'cable', level: 'high', rationale: '仅器械一致' },
        { name: 'cable row', level: 'high', rationale: '精确名' },
      ],
      fallback: { understanding: '划船' },
    })
    expect(idsOf(result)).toEqual(['s-exact', 's-eq', 's-bp', 's-base'])
  })

  it('applies generic unsupported variant penalty to non-chest-press families and respects hintText', () => {
    const hackInner = synth('s-hack1', 'sled inner hack squat', 'sled machine', { bp: 'upper legs' })
    const hackPlain = synth('s-hack2', 'sled hack squat', 'sled machine', { bp: 'upper legs' })
    const shoulderSingle = synth('s-sh1', 'lever single arm shoulder press', 'leverage machine', { bp: 'shoulders' })
    const shoulderPlain = synth('s-sh2', 'lever shoulder press', 'leverage machine', { bp: 'shoulders' })
    const rowReverse = synth('s-row1', 'cable reverse grip row', 'cable', { bp: 'back' })
    const rowPlain = synth('s-row2', 'cable seated row', 'cable', { bp: 'back' })

    const matcher = makeInjected({
      'hack squat': [
        { exercise: hackInner, score: 240 },
        { exercise: hackPlain, score: 235 },
      ],
      'shoulder press': [
        { exercise: shoulderSingle, score: 240 },
        { exercise: shoulderPlain, score: 235 },
      ],
      'cable row': [
        { exercise: rowReverse, score: 240 },
        { exercise: rowPlain, score: 235 },
      ],
    }, [hackInner, hackPlain, shoulderSingle, shoulderPlain, rowReverse, rowPlain])

    // Without hint or candidate mention, generic movements win.
    expect(idsOf(matcher.match({
      candidates: [{ name: 'hack squat', equipment: 'sled machine', level: 'high', rationale: '哈克深蹲' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-hack2'])

    expect(idsOf(matcher.match({
      candidates: [{ name: 'shoulder press', equipment: 'leverage machine', level: 'high', rationale: '肩推' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-sh2'])

    expect(idsOf(matcher.match({
      candidates: [{ name: 'cable row', equipment: 'cable', level: 'high', rationale: '划船' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-row2'])

    // When hintText explicitly asks for the variant in Chinese or English, it is not penalized.
    expect(idsOf(matcher.match({
      candidates: [{ name: 'shoulder press', equipment: 'leverage machine', level: 'high', rationale: '肩推' }],
      fallback: { understanding: 'x' },
    }, { hintText: '单手推举' }))).toEqual(['s-sh1'])

    expect(idsOf(matcher.match({
      candidates: [{ name: 'cable row', equipment: 'cable', level: 'high', rationale: '划船' }],
      fallback: { understanding: 'x' },
    }, { hintText: '反握划船' }))).toEqual(['s-row1'])

    expect(idsOf(matcher.match({
      candidates: [{ name: 'hack squat', equipment: 'sled machine', level: 'high', rationale: '哈克深蹲' }],
      fallback: { understanding: 'x' },
    }, { hintText: 'inner stance hack squat' }))).toEqual(['s-hack1'])
  })

  it('deduplicates hits using compareRankedHits while merging rationales and stronger level', () => {
    const press = synth('0576', 'lever chest press', 'leverage machine', { bp: 'chest' })
    const matcher = makeInjected({
      'seated press': [{ exercise: press, score: 300 }],
      'lever chest press': [{ exercise: press, score: 150 }],
    }, [press])

    const result = matcher.match({
      candidates: [
        { name: 'seated press', equipment: 'leverage machine', level: 'low', rationale: '坐姿推举' },
        { name: 'lever chest press', equipment: 'leverage machine', bodyPart: 'chest', level: 'high', rationale: '杠杆推胸' },
      ],
      fallback: { understanding: '推胸机' },
    })
    expect(result.items).toHaveLength(1)
    expect(result.items[0].exerciseId).toBe('0576')
    expect(result.items[0].level).toBe('high')
    expect(result.items[0].rationale).toBe('坐姿推举；杠杆推胸')
  })

  it('strips internal ranking metadata from returned items', () => {
    const press = synth('0576', 'lever chest press', 'leverage machine', { bp: 'chest' })
    const matcher = makeInjected({
      'lever chest press': [{ exercise: press, score: 200 }],
    }, [press])

    const result = matcher.match({
      candidates: [
        { name: 'lever chest press', equipment: 'leverage machine', bodyPart: 'chest', level: 'high', rationale: '杠杆推胸' },
      ],
      fallback: { understanding: '推胸机' },
    })
    expect(Object.keys(result.items[0]).sort()).toEqual([
      'exercise',
      'exerciseId',
      'level',
      'name',
      'rationale',
    ])
  })
})

describe('AI exercise local recall (P1-A)', () => {
  const synth = (id, n, eq, extra = {}) => ({
    id,
    n,
    name: extra.name || n,
    eq,
    bp: extra.bp || 'chest',
    aliases: extra.aliases || [],
    custom: extra.custom === true,
  })
  const makeInjected = (resultsByQuery, pool) => createExerciseAiSearch({
    searchScored: (_list, query) => resultsByQuery[query] || [],
    list: pool,
    bodyPartValues: BODYPARTS,
    equipmentValues: EQUIPMENTS,
    isPublicExercise: exercise => exercise.custom !== true,
  })
  const collectWith = (matcher, output) => {
    const events = []
    const result = matcher.match(output, {
      diagnostics: { emit: event => events.push(event), evaluation: { expectedIds: [], includeQueries: true } },
    })
    return { events, result }
  }
  const zhPublicMatcher = createExerciseAiSearch({
    searchScored: ZH_SEARCH.searchScored,
    list: ZH_POOL,
    bodyPartValues: BODYPARTS,
    equipmentValues: EQUIPMENTS,
    isPublicExercise: exercise => exercise.custom !== true,
  })

  it('uses nameEn for non-CJK names such as French chest press to recall 0576', () => {
    const { events, result } = collectWith(zhPublicMatcher, {
      candidates: [{
        name: 'presse à pectoraux assise',
        nameEn: 'lever chest press',
        equipment: 'leverage machine',
        bodyPart: 'chest',
        level: 'medium',
        rationale: '坐姿推胸',
      }],
      fallback: { understanding: '推胸机' },
    })
    expect(idsOf(result)).toEqual(['0576'])
    expect(events.filter(e => e.stage === 'recall').map(e => e.queryOrigin)).toEqual(['english', 'primary'])
  })

  it('uses canonical nameEn for colloquial English names such as plate-loaded shoulder press to recall 0603', () => {
    const { events, result } = collectWith(zhPublicMatcher, {
      candidates: [{
        name: 'plate-loaded shoulder press',
        nameEn: 'lever shoulder press',
        equipment: 'leverage machine',
        bodyPart: 'shoulders',
        level: 'high',
        rationale: '挂片式肩推',
      }],
      fallback: { understanding: '肩推器械' },
    })
    expect(idsOf(result)).toEqual(['0603'])
    expect(events.filter(e => e.stage === 'recall').map(e => e.queryOrigin)).toEqual(['english', 'primary'])
  })

  it('skips duplicate English query when nameEn equals name after normalization', () => {
    const { events, result } = collectWith(zhPublicMatcher, {
      candidates: [{
        name: 'Lever Chest Press',
        nameEn: '  lever   chest press  ',
        equipment: 'leverage machine',
        bodyPart: 'chest',
        level: 'high',
        rationale: '推胸机',
      }],
      fallback: { understanding: '推胸机' },
    })
    expect(idsOf(result)).toEqual(['0576'])
    expect(events.filter(e => e.stage === 'recall').map(e => e.queryOrigin)).toEqual(['primary'])
  })

  it('prefers an equipment-consistent and variant-clean nameEn hit over a higher-scoring primary hit', () => {
    const leverClean = synth('0576', 'lever chest press', 'leverage machine', { bp: 'chest' })
    const cableWrongEq = synth('2144', 'cable seated chest press', 'cable', { bp: 'chest' })
    const eqMatcher = makeInjected({
      'lever chest press': [{ exercise: leverClean, score: 210 }],
      'seated chest press': [{ exercise: cableWrongEq, score: 310 }],
    }, [leverClean, cableWrongEq])

    expect(idsOf(eqMatcher.match({
      candidates: [{
        name: 'seated chest press',
        nameEn: 'lever chest press',
        equipment: 'leverage machine',
        bodyPart: 'chest',
        level: 'high',
        rationale: '坐姿推胸',
      }],
      fallback: { understanding: '推胸机' },
    }))).toEqual(['0576'])

    const leverIncline = synth('1299', 'lever incline chest press', 'leverage machine', { bp: 'chest' })
    const variantMatcher = makeInjected({
      'lever chest press': [{ exercise: leverClean, score: 210 }],
      'seated chest press': [{ exercise: leverIncline, score: 310 }],
    }, [leverClean, leverIncline])

    expect(idsOf(variantMatcher.match({
      candidates: [{
        name: 'seated chest press',
        nameEn: 'lever chest press',
        equipment: 'leverage machine',
        bodyPart: 'chest',
        level: 'high',
        rationale: '坐姿推胸',
      }],
      fallback: { understanding: '推胸机' },
    }))).toEqual(['0576'])
  })
})

describe('AI exercise equipment conflict matrix (P1-C)', () => {
  const synth = (id, n, eq, extra = {}) => ({
    id,
    n,
    name: extra.name || n,
    eq,
    bp: extra.bp || 'upper legs',
    aliases: extra.aliases || [],
    custom: extra.custom === true,
  })
  const zhPublicMatcher = createExerciseAiSearch({
    searchScored: ZH_SEARCH.searchScored,
    list: ZH_POOL,
    bodyPartValues: BODYPARTS,
    equipmentValues: EQUIPMENTS,
    isPublicExercise: exercise => exercise.custom !== true,
  })
  const collectWith = (matcher, output) => {
    const events = []
    const result = matcher.match(output, {
      diagnostics: { emit: event => events.push(event) },
    })
    return { events, result }
  }

  it('rejects free-weight hack squat (0046) when candidate specifies sled machine and picks 0743', () => {
    const { result } = collectWith(zhPublicMatcher, {
      candidates: [{
        name: 'hack squat',
        equipment: 'sled machine',
        bodyPart: 'upper legs',
        level: 'high',
        rationale: '哈克深蹲',
      }],
      fallback: { understanding: '哈克深蹲器械' },
    })
    expect(idsOf(result)).toEqual(['0743'])

    // Verify 0046 alone is explicitly rejected as equipment_conflict
    const barbellOnly = synth('0046', 'barbell hack squat', 'barbell')
    const conflictOnly = createExerciseAiSearch({
      searchScored: () => [{ exercise: barbellOnly, score: 300 }],
      list: [barbellOnly],
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
      isPublicExercise: () => true,
    })
    const blocked = collectWith(conflictOnly, {
      candidates: [{ name: 'hack squat', equipment: 'sled machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(blocked.result)).toEqual([])
    expect(blocked.events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'equipment_conflict', id: '0046' },
    ])
  })

  it('rejects fixed machines when candidate specifies free weights, and rejects machines/free weights when candidate specifies bodyweight', () => {
    const leverPress = synth('0576', 'lever chest press', 'leverage machine', { bp: 'chest' })
    const mFreeVsFixed = createExerciseAiSearch({
      searchScored: () => [{ exercise: leverPress, score: 300 }],
      list: [leverPress],
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
      isPublicExercise: () => true,
    })
    const blockedFixed = collectWith(mFreeVsFixed, {
      candidates: [{ name: 'chest press', equipment: 'barbell', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(blockedFixed.result)).toEqual([])
    expect(blockedFixed.events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'equipment_conflict', id: '0576' },
    ])

    const barbellBench = synth('0025', 'barbell bench press', 'barbell', { bp: 'chest' })
    const mBwVsFree = createExerciseAiSearch({
      searchScored: () => [{ exercise: barbellBench, score: 300 }],
      list: [barbellBench],
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
      isPublicExercise: () => true,
    })
    const blockedFree = collectWith(mBwVsFree, {
      candidates: [{ name: 'bench press', equipment: 'body weight', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    })
    expect(idsOf(blockedFree.result)).toEqual([])
    expect(blockedFree.events.filter(e => e.stage === 'filter')).toEqual([
      { stage: 'filter', candidateIndex: 0, decision: 'equipment_conflict', id: '0025' },
    ])
  })

  it('keeps leverage machine <-> sled machine, cable <-> fixed machines, and barbell family compatible', () => {
    const sledLegPress = synth('0739', 'sled 45° leg press', 'sled machine')
    const leverHackSquat = synth('5516', 'lever hack squat', 'leverage machine')
    const cableChestPress = synth('2144', 'cable seated chest press', 'cable', { bp: 'chest' })
    const olympicSquat = synth('s-oly', 'olympic barbell squat', 'olympic barbell')

    const mCompat = createExerciseAiSearch({
      searchScored: (_list, query) => {
        if (query === 'leg press') return [{ exercise: sledLegPress, score: 250 }]
        if (query === 'hack squat') return [{ exercise: leverHackSquat, score: 250 }]
        if (query === 'chest press') return [{ exercise: cableChestPress, score: 250 }]
        if (query === 'barbell squat') return [{ exercise: olympicSquat, score: 250 }]
        return []
      },
      list: [sledLegPress, leverHackSquat, cableChestPress, olympicSquat],
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
    })

    expect(idsOf(mCompat.match({
      candidates: [{ name: 'leg press', equipment: 'leverage machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['0739'])

    expect(idsOf(mCompat.match({
      candidates: [{ name: 'hack squat', equipment: 'sled machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['5516'])

    expect(idsOf(mCompat.match({
      candidates: [{ name: 'chest press', equipment: 'leverage machine', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['2144'])

    expect(idsOf(mCompat.match({
      candidates: [{ name: 'barbell squat', equipment: 'barbell', level: 'high', rationale: 'x' }],
      fallback: { understanding: 'x' },
    }))).toEqual(['s-oly'])
  })

  it('derives up to 3 disambiguation chips for ambiguous or confusable results and hides on clear high confidence', () => {
    const chestPress = { id: '2144', name: 'lever chest press', equipment: 'leverage machine', bodyPart: 'chest' }
    const shoulderPress = { id: '0586', name: 'lever shoulder press', equipment: 'leverage machine', bodyPart: 'shoulders' }
    const legExt = { id: '0585', name: 'lever leg extension', equipment: 'leverage machine', bodyPart: 'upper legs' }
    const legCurl = { id: '0599', name: 'lever seated leg curl', equipment: 'leverage machine', bodyPart: 'upper legs' }
    const hackSquat = { id: '0743', name: 'sled hack squat', equipment: 'sled machine', bodyPart: 'upper legs' }
    const legPress = { id: '0739', name: 'sled 45° leg press', equipment: 'sled machine', bodyPart: 'upper legs' }
    const barbellBench = { id: '0025', name: 'barbell bench press', equipment: 'barbell', bodyPart: 'chest' }

    // Clear high-confidence match with non-confusable neighbour returns [] even if model returned clarifications
    expect(deriveClarificationChips(
      [
        { exerciseId: '0025', name: barbellBench.name, level: 'high', exercise: barbellBench },
        { exerciseId: '0585', name: legExt.name, level: 'low', exercise: legExt },
      ],
      {
        clarifications: [{ label: '不应该出现', prompt: '高置信清晰结果应隐藏' }],
        fallback: { understanding: '杠铃卧推', bodyParts: ['chest'], equipment: ['barbell'] },
      },
      '杠铃卧推',
    )).toEqual([])

    // Confusable high-confidence pair (chest press vs shoulder press) keeps chips and prioritizes model-supplied ones
    expect(deriveClarificationChips(
      [
        { exerciseId: '2144', name: chestPress.name, level: 'high', exercise: chestPress },
        { exerciseId: '0586', name: shoulderPress.name, level: 'medium', exercise: shoulderPress },
      ],
      {
        clarifications: [
          { label: '自定义1', prompt: '补充角度为斜上推' },
          { label: '自定义1', prompt: '重复标签会被去重' },
          { label: '自定义2', prompt: '补充手柄是独立双臂' },
          { label: '自定义3', prompt: '补充手柄为固定横杠' },
          { label: '超出第4条', prompt: '超过3条会被截断' },
        ],
        fallback: { understanding: '推举固定器械' },
      },
    )).toEqual([
      { label: '自定义1', prompt: '补充角度为斜上推' },
      { label: '自定义2', prompt: '补充手柄是独立双臂' },
      { label: '自定义3', prompt: '补充手柄为固定横杠' },
    ])

    // Deterministic fallbacks across the 4 Chinese confusable/generic families
    const pressChips = deriveClarificationChips(
      [{ exerciseId: '2144', name: chestPress.name, level: 'medium', exercise: chestPress }],
      { fallback: { understanding: '不确定推胸还是推肩', bodyParts: ['chest'], equipment: ['leverage machine'] } },
    )
    expect(pressChips.map(c => c.label)).toEqual(['往前推（练胸）', '往上推（练肩）', '双臂夹胸（蝴蝶机）'])

    const legExtCurlChips = deriveClarificationChips(
      [
        { exerciseId: '0585', name: legExt.name, level: 'high', exercise: legExt },
        { exerciseId: '0599', name: legCurl.name, level: 'medium', exercise: legCurl },
      ],
      { fallback: { understanding: '腿部固定器械', bodyParts: ['upper legs'], equipment: ['leverage machine'] } },
    )
    expect(legExtCurlChips.map(c => c.label)).toEqual(['大腿前侧（腿屈伸）', '大腿后侧（腿弯举）'])

    const hackChips = deriveClarificationChips(
      [
        { exerciseId: '0743', name: hackSquat.name, level: 'medium', exercise: hackSquat },
        { exerciseId: '0739', name: legPress.name, level: 'medium', exercise: legPress },
      ],
      { fallback: { understanding: '斜板腿部器械', bodyParts: ['upper legs'], equipment: ['sled machine'] } },
    )
    expect(hackChips.map(c => c.label)).toEqual(['站姿斜板下蹲（哈克）', '坐姿/斜躺蹬腿（腿举）'])

    const genericChips = deriveClarificationChips(
      [],
      { fallback: { understanding: '一台健身房器械', equipment: ['leverage machine'] } },
    )
    expect(genericChips.map(c => c.label)).toEqual(['固定器械（挂片/插销）', '绳索/龙门架'])

    // Unrelated non-fitness empty result produces no chips
    expect(deriveClarificationChips(
      [],
      { fallback: { understanding: '这是一碗拉面，没有看到健身器械' } },
      '',
    )).toEqual([])

    // match() integration: attaches clarifications cleanly on ambiguous match and [] on clear high match
    const matcher = createExerciseAiSearch({
      searchScored: (_list, query) => {
        if (query === 'lever chest press') return [{ exercise: chestPress, score: 250 }]
        if (query === 'barbell bench press') return [{ exercise: barbellBench, score: 250 }]
        return []
      },
      list: [chestPress, barbellBench],
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
    })

    const clearRes = matcher.match({
      candidates: [{ name: 'barbell bench press', equipment: 'barbell', bodyPart: 'chest', level: 'high', rationale: '杠铃' }],
      fallback: { understanding: '杠铃卧推', bodyParts: ['chest'], equipment: ['barbell'] },
    })
    expect(clearRes.clarifications).toEqual([])

    const ambigRes = matcher.match({
      candidates: [{ name: 'lever chest press', equipment: 'leverage machine', bodyPart: 'chest', level: 'medium', rationale: '机械' }],
      fallback: { understanding: '可能是坐姿推胸或推肩', bodyParts: ['chest'], equipment: ['leverage machine'] },
    })
    expect(ambigRes.clarifications).toHaveLength(3)
    expect(ambigRes.clarifications[0].label).toBe('往前推（练胸）')
  })

  it('P3-A: promotes non-semantic parenthetical matches to high while preserving semantic variants', () => {
    const lyingPress = AI.zh.match({
      candidates: [{
        name: '杠杆仰卧推胸',
        nameEn: 'lever lying chest press',
        equipment: 'leverage machine',
        bodyPart: 'chest',
        level: 'high',
        rationale: '平躺挂片式推胸机',
      }],
      fallback: { understanding: '杠杆仰卧推胸机' },
    })
    expect(lyingPress.items[0].exerciseId).toBe('1041')
    expect(lyingPress.items[0].level).toBe('high')
    expect('postureMatch' in lyingPress.items[0]).toBe(false)

    // Semantic variant suffixes such as (inner) must never be stripped to claim exact high confidence.
    const innerEx = {
      id: 'synthetic-inner',
      n: 'lever chest press (inner)',
      name: '杠杆内侧推胸(内侧)',
      eq: 'leverage machine',
      bp: 'chest',
      aliases: [],
      custom: true,
    }
    const localSearch = searchOf(exercise => `${exercise.name} ${exercise.n}`, exercise => exercise.aliases, label)
    const localAi = aiOf(localSearch, [innerEx])
    const innerRes = localAi.match({
      candidates: [{
        name: 'lever chest press',
        equipment: 'leverage machine',
        bodyPart: 'chest',
        level: 'high',
        rationale: '内侧变式不应剥离为精确匹配',
      }],
    })
    expect(innerRes.items[0]?.exerciseId).toBe('synthetic-inner')
    expect(innerRes.items[0]?.level).toBe('medium')
  })

  it('P3-A: rejects cross-body-part false hits while allowing synergistic muscles', () => {
    const events = []
    const shrugAndCalf = EXDB.filter(e => ['1221', '1220', '1625'].includes(e.id))
    const strictGuardSearch = createExerciseSearch({
      nameText: exercise => `${zh[exercise.id] || exercise.n} ${exercise.n}`,
      classicIds: V13_IDS,
    })
    const strictGuardAi = aiOf(strictGuardSearch, shrugAndCalf)
    const res = strictGuardAi.match({
      candidates: [{
        name: 'lever bench press',
        equipment: 'leverage machine',
        bodyPart: 'chest',
        level: 'high',
        rationale: '胸部卧推器械',
      }],
      fallback: { understanding: '固定卧推机', bodyParts: ['chest'], equipment: ['leverage machine'] },
    }, {
      diagnostics: { emit: event => events.push(event) },
    })
    // Must reject 1221 (back shrug), 1220 (lower legs calf), and 1625 (upper arms triceps)
    expect(idsOf(res)).toEqual([])
    expect(events.some(e => e.stage === 'filter' && e.decision === 'body_part_conflict')).toBe(true)

    // Synergistic body parts remain permitted: chest -> shoulders, upper arms -> chest
    const chestShoulder = EXDB.find(e => e.id === '0603')
    const upperArmChest = EXDB.find(e => e.id === '0251')
    const synAi = createExerciseAiSearch({
      searchScored: (_pool, q) => {
        if (q === 'overhead press') return [{ exercise: chestShoulder, score: 250 }]
        if (q === 'chest dip') return [{ exercise: upperArmChest, score: 250 }]
        return []
      },
      list: [chestShoulder, upperArmChest],
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
    })
    expect(synAi.match({
      candidates: [{ name: 'overhead press', bodyPart: 'chest', level: 'medium', rationale: 'synergy' }],
    }).items[0]?.exerciseId).toBe('0603')
    expect(synAi.match({
      candidates: [{ name: 'chest dip', bodyPart: 'upper arms', level: 'medium', rationale: 'synergy' }],
    }).items[0]?.exerciseId).toBe('0251')
  })

  it('P3-A: breaks posture ties deterministically between seated, supine, and prone siblings', () => {
    const lyingChest = EXDB.find(e => e.id === '1041')
    const seatedChest = EXDB.find(e => e.id === '0576')
    const proneCurl = EXDB.find(e => e.id === '0586')
    const seatedCurl = EXDB.find(e => e.id === '0599')
    const postureAi = createExerciseAiSearch({
      searchScored: (_pool, q) => {
        if (q === 'machine chest press') {
          return [
            { exercise: seatedChest, score: 260 },
            { exercise: lyingChest, score: 250 },
          ]
        }
        if (q === 'leg curl') {
          return [
            { exercise: seatedCurl, score: 260 },
            { exercise: proneCurl, score: 250 },
          ]
        }
        return []
      },
      list: [lyingChest, seatedChest, proneCurl, seatedCurl],
      bodyPartValues: BODYPARTS,
      equipmentValues: EQUIPMENTS,
    })

    const supineRes = postureAi.match({
      candidates: [{ name: 'machine chest press', equipment: 'leverage machine', bodyPart: 'chest', level: 'medium', rationale: 'supine' }],
    }, { hintText: '仰卧推胸' })
    expect(supineRes.items[0].exerciseId).toBe('1041')

    const seatedRes = postureAi.match({
      candidates: [{ name: 'machine chest press', equipment: 'leverage machine', bodyPart: 'chest', level: 'medium', rationale: 'seated' }],
    }, { hintText: '坐姿推胸' })
    expect(seatedRes.items[0].exerciseId).toBe('0576')

    const proneRes = postureAi.match({
      candidates: [{ name: 'leg curl', posture: 'prone', equipment: 'leverage machine', bodyPart: 'upper legs', level: 'medium', rationale: 'prone' }],
    })
    expect(proneRes.items[0].exerciseId).toBe('0586')

    const seatedCurlRes = postureAi.match({
      candidates: [{ name: 'leg curl', posture: 'seated', equipment: 'leverage machine', bodyPart: 'upper legs', level: 'medium', rationale: 'seated' }],
    })
    expect(seatedCurlRes.items[0].exerciseId).toBe('0599')
  })

  it('P3-B: recalls 1041 via BM25 fallback at medium level across 7 lying bench paraphrases without hallucinating on unknown tokens', () => {
    const queries = [
      'lever lying bench press',
      'lying lever bench press',
      'plate loaded bench press',
      'flat machine chest press',
      'horizontal machine chest press',
      'supine chest press',
      'lever bench press',
    ]
    for (const q of queries) {
      const events = []
      const res = AI.zh.match({
        candidates: [{
          name: q,
          equipment: 'leverage machine',
          bodyPart: 'chest',
          level: 'high',
          rationale: '挂片式平躺胸推器械',
        }],
        fallback: { understanding: '固定仰卧推胸器械', bodyParts: ['chest'], equipment: ['leverage machine'] },
      }, {
        diagnostics: { emit: event => events.push(event) },
      })
      expect(res.items[0]?.exerciseId, q).toBe('1041')
      expect(res.items[0]?.level, q).toBe('medium')
      expect('bm25' in res.items[0]).toBe(false)
      expect(events.some(e => e.stage === 'recall' && e.queryOrigin === 'bm25')).toBe(true)
    }

    for (const bogus of [
      'levitating barbell bench press',
      'quantum flux squat machine',
      'plate of pasta',
      'orbital prism contraption',
    ]) {
      const res = AI.zh.match({
        candidates: [{ name: bogus, level: 'high', rationale: 'out of catalogue' }],
      })
      expect(res.items, bogus).toEqual([])
    }

    // Existing strict-AND hits must never emit bm25 diagnostics
    const cleanEvents = []
    const cleanRes = AI.zh.match({
      candidates: [{
        name: '杠铃卧推',
        nameEn: 'barbell bench press',
        equipment: 'barbell',
        bodyPart: 'chest',
        level: 'high',
        rationale: '经典卧推',
      }],
    }, {
      diagnostics: { emit: event => cleanEvents.push(event) },
    })
    expect(cleanRes.items[0]?.exerciseId).toBe('0025')
    expect(cleanRes.items[0]?.level).toBe('high')
    expect(cleanEvents.some(e => e.stage === 'recall' && e.queryOrigin === 'bm25')).toBe(false)
  })
})
