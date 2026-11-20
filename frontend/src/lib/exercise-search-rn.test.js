// The RN picker uses the same engine as Web, with Chinese display names and the
// profile's saved aliases. These tests pin the shared contract without importing
// React Native or Metro.
import { expect, it } from 'vitest'
import { EXDB } from './exercises-data.js'
import zh from '../exercise-names/zh.js'
import V13_IDS from './catalogue-v13-ids.json' with { type: 'json' }
import { createExerciseSearch, isOneLimbExercise } from './exercise-search.js'

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

function rnSearch() {
  const list = EXDB.map(exercise => ({
    ...exercise,
    name: zh[exercise.id] ?? exercise.n,
    aliases: [],
  }))
  const engine = createExerciseSearch({
    nameText: exercise => `${exercise.name} ${exercise.n}`,
    aliasesOf: exercise => exercise.aliases,
    translate: value => LABELS[value] ?? value,
    classicIds: V13_IDS,
  })
  return { engine, list }
}

it('finds 1204 by its Chinese name, English name and a multi-word English query', () => {
  const { engine, list } = rnSearch()
  expect(engine.searchExercises(list, '绳索单臂高位下拉').map(e => e.id)).toContain('1204')
  expect(engine.searchExercises(list, 'cable one arm lat pulldown').map(e => e.id)).toContain('1204')
  expect(engine.searchExercises(list, 'cable pulldown').map(e => e.id)).toContain('1204')
})

it('inherits the Web typo tolerance and body-part labels', () => {
  const { engine, list } = rnSearch()
  expect(engine.searchExercises(list, 'dumbell').length).toBeGreaterThan(0)
  const chest = engine.searchExercises(list, '胸部')
  expect(chest.length).toBeGreaterThan(0)
  expect(chest.some(exercise => exercise.bp === 'chest')).toBe(true)
  const core = engine.searchExercises(list, '核心')
  expect(core.length).toBeGreaterThan(0)
  expect(core.some(exercise => (exercise.sm || []).includes('core'))).toBe(true)
})

it('reads saved aliases and drops them when the profile clears them', () => {
  const { engine, list } = rnSearch()
  const target = list.find(exercise => exercise.id === '1204')
  expect(engine.searchExercises(list, '我的高位下拉')).toEqual([])
  target.aliases = ['我的高位下拉']
  expect(engine.searchExercises(list, '我的高位下拉')).toEqual([target])
  target.aliases = []
  expect(engine.searchExercises(list, '我的高位下拉')).toEqual([])
})

it('matches a custom exercise alias and keeps its own name searchable', () => {
  const { engine, list } = rnSearch()
  const custom = { id: 'custom-1', n: '自建划船', name: '自建划船', aliases: ['Viking row'], custom: true }
  list.unshift(custom)
  expect(engine.searchExercises(list, 'Viking row')).toEqual([custom])
  expect(engine.searchExercises(list, '自建划船')).toEqual([custom])
})

it('uses the shared one-limb rule on the original English catalogue name', () => {
  const target = EXDB.find(exercise => exercise.id === '1204')
  expect(isOneLimbExercise(target)).toBe(true)
  expect(isOneLimbExercise({ id: 'c1', n: 'one arm row', custom: true })).toBe(false)
  expect(isOneLimbExercise({ id: 'x', n: 'band one arm row' })).toBe(true)
  expect(isOneLimbExercise({ id: 'y', n: 'single leg stretch' })).toBe(false)
})
