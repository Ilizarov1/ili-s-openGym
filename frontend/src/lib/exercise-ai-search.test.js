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
