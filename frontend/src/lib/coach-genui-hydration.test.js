import { afterEach, describe, expect, it } from 'vitest'
import {
  hydrateExerciseTrend, hydrateMuscleLoad, hydrateExerciseAlternatives,
  hydrateKpiStrip, resolveExerciseRef,
} from './coach-genui-hydration.js'
import { _setLangState } from './i18n-core.js'

const DAY = 86400000
const BASE = Date.parse('2026-03-20T18:00:00Z')

const entry = (id, sets) => ({ id, sets })
const work = (w, r = 8) => ({ w, r, done: true })
const warm = (w, r = 5) => ({ w, r, done: true, phase: 'warmup' })
const workout = (id, dayOffset, entries) => ({
  id, d: new Date(BASE + dayOffset * DAY).toISOString().slice(0, 10),
  start: BASE + dayOffset * DAY, name: 'Push Day', entries,
})

const state = ({ workouts = [], customEx = [] } = {}) => ({
  unit: 'kg', workouts, customEx, routines: [], week: {},
})

describe('hydrateExerciseTrend', () => {
  const S = state({
    workouts: [
      workout('w-old', -70, [entry('0025', [work(55)])]),
      workout('w1', -60, [entry('0025', [warm(80), work(60)])]),
      workout('w2', -20, [entry('0025', [work(62.5)])]),
      workout('w3', -10, [entry('0025', [work(62.5)])]),
      workout('w4', -2, [entry('0025', [work(62.5)])]),
    ],
  })

  it('walks the last N weeks, ignores warm-ups, and reports the shape of the curve', () => {
    const t = hydrateExerciseTrend(S, { exId: '0025', weeks: 8 })
    expect(t.name).toBe('barbell bench press')
    expect(t.metric).toBe('e1rm')
    expect(t.sessions).toBe(3)                    // the -70 day session is outside the window
    expect(t.points.map(p => p.d)).toEqual([
      S.workouts[2].d, S.workouts[3].d, S.workouts[4].d,
    ])
    expect(t.first).toBe(79.2)                    // 62.5 × 8 → Epley
    expect(t.last).toBe(t.first)
    expect(t.delta).toBe(0)
    expect(t.pct).toBe(0)
    expect(t.stalled).toBe(true)                  // three flat sessions
  })

  it('reads top weight and session volume from the same completed sets', () => {
    const weight = hydrateExerciseTrend(S, { exId: '0025', metric: 'weight' })
    expect(weight.points.map(p => p.y)).toEqual([62.5, 62.5, 62.5])

    const volume = hydrateExerciseTrend(S, { exId: '0025', metric: 'volume' })
    expect(volume.points.map(p => p.y)).toEqual([500, 500, 500])   // 62.5 × 8, one completed work set
  })

  it('marks a lift that is still adding load as not stalled', () => {
    const rising = state({
      workouts: [
        workout('r1', -30, [entry('0025', [work(60)])]),
        workout('r2', -20, [entry('0025', [work(65)])]),
        workout('r3', -10, [entry('0025', [work(70)])]),
      ],
    })
    const t = hydrateExerciseTrend(rising, { exId: '0025', weeks: 8 })
    expect(t.delta).toBeGreaterThan(0)
    expect(t.stalled).toBe(false)
  })

  it('resolves a custom exercise and degrades to an empty trend with no log', () => {
    const custom = state({
      customEx: [{ id: 'custom-1', n: 'My Sled Push', bp: 'upper legs' }],
      workouts: [workout('c1', -3, [entry('custom-1', [work(40, 10)])])],
    })
    expect(hydrateExerciseTrend(custom, { exId: 'custom-1' }).name).toBe('My Sled Push')
    const empty = hydrateExerciseTrend(state(), { exId: '0025' })
    expect(empty).toMatchObject({ points: [], sessions: 0, first: null, last: null, delta: null, stalled: false })
  })
})

describe('hydrateMuscleLoad', () => {
  const S = state({
    workouts: [
      workout('m-old', -5, [entry('0025', [work(60), work(60)])]),
      workout('m-new', -1, [entry('0025', [warm(80), work(65), work(65), work(65)])]),
    ],
  })

  it('counts finished work sets inside the window, anchored to the newest session', () => {
    const three = hydrateMuscleLoad(S, { window: '72h', focusMuscles: ['chest'] })
    expect(three.sessions).toBe(1)
    expect(three.totalSets).toBe(3)
    expect(three.focusSummary).toEqual([{ muscle: 'chest', label: 'Chest', sets: 3 }])
    expect(three.load.chest).toBeGreaterThan(0)
    expect(three.load.deltoids).toBeGreaterThan(0)   // the bench's secondary work

    const week = hydrateMuscleLoad(S, { window: '7d', focusMuscles: ['chest'] })
    expect(week.sessions).toBe(2)
    expect(week.totalSets).toBe(5)
  })

  it('falls back to the hardest-worked muscles when no focus is named', () => {
    const data = hydrateMuscleLoad(S, { window: '7d' })
    expect(data.focusSummary.length).toBeGreaterThan(0)
    expect(data.focusSummary[0].sets).toBeGreaterThanOrEqual(data.focusSummary.at(-1).sets)
  })
})

describe('hydrateExerciseAlternatives', () => {
  const S = state({ customEx: [{ id: 'custom-1', n: 'My Sled Push', bp: 'chest', eq: 'other' }] })

  it('keeps only exercises the catalogue or the profile really owns, and enriches them', () => {
    const data = hydrateExerciseAlternatives(S, {
      forExId: '0025',
      routineId: 'r1',
      items: [
        { exId: '0289', reason: 'Neutral wrist angle', tag: 'Dumbbell' },
        { exId: 'not-a-real-exercise', reason: 'hallucinated' },
        { exId: 'custom-1', reason: 'Your own movement' },
      ],
    })
    expect(data.forExId).toBe('0025')
    expect(data.items.map(i => i.exId)).toEqual(['0289', 'custom-1'])
    expect(data.items[0]).toMatchObject({
      name: 'dumbbell bench press', bp: 'chest', eq: 'dumbbell',
      reason: 'Neutral wrist angle', tag: 'Dumbbell', routineId: 'r1', hasMedia: true,
    })
    expect(data.items[1]).toMatchObject({ name: 'My Sled Push', hasMedia: false })
  })

  it('drops an item with no id and returns an empty list when nothing is real', () => {
    const data = hydrateExerciseAlternatives(S, { items: [{ reason: 'no id' }, { exId: 'nope' }] })
    expect(data.items).toEqual([])
  })
})

describe('resolveExerciseRef', () => {
  it('resolves a catalogue exercise with its name, body part and equipment', () => {
    const ref = resolveExerciseRef(state(), '0025')
    expect(ref).toMatchObject({
      exId: '0025',
      name: 'barbell bench press',
      bp: 'chest',
      eq: 'barbell',
      hasMedia: true,
    })
    expect(ref.ex.id).toBe('0025')
  })

  it('resolves an exercise the profile owns, without claiming shipped media', () => {
    const custom = state({ customEx: [{ id: 'custom-1', n: 'My Sled Push', bp: 'upper legs', eq: 'other' }] })
    expect(resolveExerciseRef(custom, 'custom-1')).toMatchObject({
      exId: 'custom-1',
      name: 'My Sled Push',
      bp: 'upper legs',
      eq: 'other',
      hasMedia: false,
    })
  })

  it('returns null for an id neither the catalogue nor the profile owns', () => {
    expect(resolveExerciseRef(state(), 'not-a-real-exercise')).toBeNull()
    expect(resolveExerciseRef(state(), undefined)).toBeNull()
    expect(resolveExerciseRef(state(), '')).toBeNull()
  })

  it('uses the loaded language pack for the name', () => {
    _setLangState('zh', {}, null, { '0025': '杠铃卧推' }, false, false)
    try {
      expect(resolveExerciseRef(state(), '0025').name).toBe('杠铃卧推')
    } finally {
      _setLangState('en', null, null, null, true, false)
    }
  })
})

describe('hydrateKpiStrip', () => {
  const S = state({
    workouts: [
      workout('kpi-1', -20, [entry('0025', [work(60), work(60)])]),
      workout('kpi-2', -5, [entry('0025', [work(65), work(65)])]),
      workout('kpi-3', -1, [entry('0025', [work(70), work(70), work(70)])]),
    ],
  })

  it('computes a real exercise stat and ignores the model-supplied value', () => {
    const item = hydrateKpiStrip(S, { items: [{
      kind: 'exercise_stat', exId: '0025', metric: 'weight', weeks: 8, label: 'Bench', value: 9999,
    }] }).items[0]
    expect(item).toMatchObject({
      kind: 'exercise_stat',
      label: 'Bench',
      metric: 'weight',
      weeks: 8,
      value: 70,
      unit: 'kg',
      delta: 10,
      pct: 17,
      stalled: false,
      sessions: 3,
      hasData: true,
    })
    expect(Number.isNaN(item.value)).toBe(false)
    expect(Number.isNaN(item.pct)).toBe(false)

    const flat = state({ workouts: [
      workout('f1', -30, [entry('0025', [work(60)])]),
      workout('f2', -20, [entry('0025', [work(60)])]),
      workout('f3', -10, [entry('0025', [work(60)])]),
    ] })
    expect(hydrateKpiStrip(flat, { items: [{
      kind: 'exercise_stat', exId: '0025', metric: 'weight', weeks: 8,
    }] }).items[0]).toMatchObject({ value: 60, delta: 0, pct: 0, stalled: true })
  })

  it('shows an en dash instead of a number, and never NaN, with no history', () => {
    const item = hydrateKpiStrip(state(), { items: [{
      kind: 'exercise_stat', exId: '0025', weeks: 6, value: 123,
    }] }).items[0]
    expect(item.value).toBeNull()
    expect(item.delta).toBeNull()
    expect(item.hasData).toBe(false)
    expect(item.sessions).toBe(0)
    expect(Number.isNaN(item.value)).toBe(false)
    expect(Number.isNaN(item.delta)).toBe(false)
    expect(Number.isNaN(item.pct)).toBe(false)
  })

  it('computes muscle sets over the 72h, 7d and 28d windows from the log', () => {
    const items = hydrateKpiStrip(S, { items: [
      { kind: 'muscle_sets', muscle: 'chest', window: '72h', value: 999 },
      { kind: 'muscle_sets', muscle: 'chest', window: '7d', value: 999 },
      { kind: 'muscle_sets', muscle: 'chest', window: '28d', value: 999 },
    ] }).items
    expect(items.map(i => i.window)).toEqual(['72h', '7d', '28d'])
    expect(items.map(i => i.value)).toEqual([3, 5, 7])
    expect(items.every(i => i.muscle === 'chest' && i.hasData)).toBe(true)
    expect(items.some(i => Number.isNaN(i.value))).toBe(false)
  })

  it('degrades muscle sets to zero with no workouts, never NaN', () => {
    const item = hydrateKpiStrip(state(), { items: [{
      kind: 'muscle_sets', muscle: 'chest', window: '7d', value: 42,
    }] }).items[0]
    expect(item.value).toBe(0)
    expect(item.hasData).toBe(false)
    expect(Number.isFinite(item.value)).toBe(true)
  })

  it('counts real sessions in the requested week window', () => {
    const item = hydrateKpiStrip(S, { items: [{
      kind: 'session_count', weeks: 4, value: 99,
    }] }).items[0]
    expect(item).toMatchObject({ kind: 'session_count', weeks: 4, value: 3, hasData: true })
  })

  it('counts zero sessions with no workouts, never NaN', () => {
    const item = hydrateKpiStrip(state(), { items: [{ kind: 'session_count', weeks: 4 }] }).items[0]
    expect(item.value).toBe(0)
    expect(item.hasData).toBe(false)
    expect(Number.isFinite(item.value)).toBe(true)
  })

  it('passes a prescription label and value through untouched', () => {
    const item = hydrateKpiStrip(S, { items: [{
      kind: 'prescription', label: 'Sets × reps', value: '4×8',
    }] }).items[0]
    expect(item).toEqual({
      kind: 'prescription', label: 'Sets × reps', value: '4×8', hasData: true,
    })
  })
})

describe('localized exercise names', () => {
  afterEach(() => { _setLangState('en', null, null, null, true, false) })

  it('reads the loaded Chinese name pack for trends and alternatives, custom names untouched', () => {
    _setLangState('zh', {}, null, { '0025': '杠铃卧推', '0289': '哑铃卧推' }, false, false)
    const trend = hydrateExerciseTrend(
      state({ workouts: [workout('zh1', -20, [entry('0025', [work(60)])]), workout('zh2', -2, [entry('0025', [work(62.5)])])] }),
      { exId: '0025', weeks: 8 },
    )
    expect(trend.name).toBe('杠铃卧推')

    const alts = hydrateExerciseAlternatives(
      state({ customEx: [{ id: 'custom-1', n: 'My Sled Push', bp: 'chest', eq: 'other' }] }),
      { forExId: '0025', items: [{ exId: '0289' }, { exId: 'custom-1' }] },
    )
    expect(alts.items.map(i => i.name)).toEqual(['哑铃卧推', 'My Sled Push'])
  })

  it('falls back to the raw id when neither the catalogue nor the profile owns it', () => {
    _setLangState('zh', {}, null, { '0025': '杠铃卧推' }, false, false)
    expect(hydrateExerciseTrend(state(), { exId: 'missing-id' }).name).toBe('missing-id')
  })
})
