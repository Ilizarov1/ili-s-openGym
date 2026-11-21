// @vitest-environment happy-dom
// Favourites (issue #6): the Library floats starred exercises to the top of the current
// result list — after the search and body-part filters, without reordering the rest.
import React, { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Library from './Library.jsx'
import { EXDB } from '../lib/exercises.js'
import { CASED_NAME_LANGS, EXERCISE_NAME_LANGS, _setLangState } from '../lib/i18n-core.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const state = {
    S: null,
    USER: { id: 'u1' },
    CONFIG: { agent: { enabled: true } },
    ai: {
      interrupted: null,
      reopen: vi.fn(),
      clear: vi.fn(),
      getRun: vi.fn(),
      cancelRun: vi.fn(),
    },
  }
  state.snapshot = () => ({ S: state.S, config: state.CONFIG, user: state.USER, update: mut => { const next = structuredClone(state.S); mut(next); state.S = next } })
  return state
})
vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector ? selector(mocks.snapshot()) : mocks.snapshot()
  useStore.getState = mocks.snapshot
  return { useStore }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }))
vi.mock('../sheets.jsx', () => ({ exerciseDetailSheet: vi.fn(), addToRoutineSheet: vi.fn(), customExSheet: vi.fn() }))
vi.mock('../agent/api.js', () => ({
  agentApi: {
    getRun: (...args) => mocks.ai.getRun(...args),
    cancelRun: (...args) => mocks.ai.cancelRun(...args),
  },
}))
vi.mock('../components/ExerciseAiSearch.jsx', async () => {
  const React = await import('react')
  const { forwardRef, useImperativeHandle } = React
  return {
    default: forwardRef(function AiStub(props, ref) {
      useImperativeHandle(ref, () => ({ reopen: mocks.ai.reopen }))
      return <div data-testid="ai-state">
        <button type="button" onClick={() => props.onExit()}>ai-exit</button>
        <button type="button" onClick={() => props.onFallbackPick('bodyPart', 'chest')}>ai-body-part</button>
        <button type="button" onClick={() => props.onFallbackPick('equipment', 'barbell')}>ai-equipment</button>
      </div>
    }),
    readInterrupted: () => mocks.ai.interrupted,
    clearInterrupted: (...args) => mocks.ai.clear(...args),
  }
})

const mounted = []
function render() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  act(() => root.render(<Library />))
  return host
}
const names = host => [...host.querySelectorAll('.item .tt')].map(el => el.textContent).slice(1)   // drop "Create your own"
const cssSource = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

beforeEach(() => {
  mocks.S = { unit: 'kg', lang: 'en', routines: [], workouts: [], customEx: [], exWeights: {}, equipProfiles: [], activeEquipId: null, equipFilterOn: false }
  mocks.CONFIG = { agent: { enabled: true } }
  mocks.USER = { id: 'u1' }
  mocks.ai.interrupted = null
  mocks.ai.reopen = vi.fn()
  mocks.ai.clear = vi.fn()
  mocks.ai.getRun = vi.fn(async () => ({ status: 'running' }))
  mocks.ai.cancelRun = vi.fn(async () => ({}))
  localStorage.clear()
  document.body.innerHTML = ''
})
afterEach(() => { act(() => { mounted.splice(0).forEach(root => root.unmount()) }) })

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
function setSearch(host, value) {
  const input = host.querySelector('.search input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
const sparkle = host => host.querySelector('[aria-label="AI 检索动作"]')

describe('Library favourites', () => {
  it('puts favourites first, marked with a star, and leaves the rest in catalogue order', () => {
    const plain = names(render())
    act(() => { mounted.splice(0).forEach(root => root.unmount()) })
    const fav = [plain[6], plain[2]]
    mocks.S.favEx = fav.map(n => EXDB.find(e => e.n === n).id)
    const host = render()
    const shown = names(host)
    expect(shown.slice(0, 2)).toEqual(plain.filter(n => fav.includes(n)))
    expect(shown.slice(2)).toEqual(plain.filter(n => !fav.includes(n)))
    const rows = [...host.querySelectorAll('.item')].slice(1)
    expect(rows[0].querySelector('.fav-star')).not.toBeNull()
    expect(rows[2].querySelector('.fav-star')).toBeNull()
  })

  // The Library is the one page whose header puts a text button beside the title, so it leaves the
  // title the least room of anywhere in the app — 95px for Polish, 125px for Russian on a 320px
  // screen. The button must stay reachable (it is flex:none, the title block shrinks), but a title
  // squeezed that far must not come apart: at 34px "Упражнения" broke into three lines, so the
  // title drops a step on phone widths and breaks a word only as a last resort.
  it('keeps the header button reachable without shredding the title', () => {
    expect(cssSource).toContain('.hdr>div{min-width:0}')
    expect(cssSource).toContain('.hdr>.btn{flex:none}')
    // the page title is --fs-large, which drops from 34 to 30 px on phone widths (P1 type scale)
    expect(cssSource).toMatch(/\.hdr h1\{font-size:var\(--fs-large\)/)
    expect(cssSource).toMatch(/@media \(max-width:420px\)\{:root\{--fs-large:1\.875rem\}\}/)
    const h1 = cssSource.match(/^\.hdr h1\{([^}]*)\}/m)
    expect(h1?.[1]).toContain('overflow-wrap:break-word')
    expect(h1[1]).not.toContain('overflow-wrap:anywhere')
    expect(h1[1]).not.toContain('hyphens:auto')
  })

  it('keeps a favourite on top inside a body-part filter, but never pulls one in from elsewhere', () => {
    const chest = EXDB.filter(e => e.bp === 'chest')
    const legs = EXDB.find(e => e.bp !== 'chest')
    mocks.S.favEx = [chest[4].id, legs.id]
    const host = render()
    const chip = [...host.querySelectorAll('.chips .chip')].find(b => b.textContent === 'chest')
    act(() => chip.click())
    const shown = names(host)
    expect(shown[0]).toBe(chest[4].n)
    expect(shown).not.toContain(legs.n)
  })
})

// #290 took the title-casing off every translated name; the packs stored lower-case then read
// lower-case down the whole list. Only German's own casing is left alone.
describe('Library exercise-name casing per language', () => {
  const packs = import.meta.glob('../exercise-names/*.js', { eager: true, import: 'default' })
  afterEach(() => _setLangState('en', {}, null, null))

  for (const lang of EXERCISE_NAME_LANGS) {
    it(`${lang}: every translated row is ${CASED_NAME_LANGS.includes(lang) ? 'left in its own casing' : 'title-cased'}`, () => {
      const pack = packs[`../exercise-names/${lang}.js`]
      _setLangState(lang, {}, null, pack)
      // Starred so they render on the first page: a partial pack may not cover the first rows.
      mocks.S.favEx = Object.keys(pack).slice(0, 3)
      const rows = [...render().querySelectorAll('.item .tt')].slice(1)   // drop "Create your own"
      expect(rows.length).toBeGreaterThan(0)
      const translated = rows.filter(el => Object.values(pack).some(n => el.textContent.startsWith(n)))
      expect(translated.length, lang).toBeGreaterThan(0)
      for (const el of translated) expect(el.classList.contains('capitalize'), `${lang}: ${el.textContent}`).toBe(!CASED_NAME_LANGS.includes(lang))
    })
  }
})

// The header counts the catalogue, and from the first exercise of your own, those too (owner
// request for v1.3.10): "1324 animated exercises + 5 of your own". It has to stay one line on a
// phone, so it runs under the title row at full width, never wraps, and ellipsizes as a last resort.
describe('Library header count', () => {
  const sub = host => host.querySelector('.hdr .sub').textContent
  const own = n => Array.from({ length: n }, (_, i) => ({ id: 'c' + i, n: 'my move ' + i, bp: 'chest', eq: '', custom: true }))
  afterEach(() => _setLangState('en', {}, null, null))

  it('shows only the catalogue while you have no exercises of your own', () => {
    expect(sub(render())).toBe(`${EXDB.length} exercises with animations`)
  })

  it('adds "+ 1 of your own" for a single custom exercise', () => {
    mocks.S.customEx = own(1)
    expect(sub(render())).toBe(`${EXDB.length} animated exercises + 1 of your own`)
  })

  it('adds the count for several custom exercises', () => {
    mocks.S.customEx = own(5)
    expect(sub(render())).toBe(`${EXDB.length} animated exercises + 5 of your own`)
  })

  it('uses the language\'s own plural forms (Russian: 1 своё, 2 своих, 5 своих)', async () => {
    const { default: ru } = await import('../locales/ru.js')
    _setLangState('ru', ru, null, null)
    const forms = ru['{1} animated exercises + {0} of your own']
    expect(typeof forms).toBe('object')
    mocks.S.customEx = own(1)
    const one = sub(render())
    act(() => { mounted.splice(0).forEach(root => root.unmount()) })
    mocks.S.customEx = own(5)
    const five = sub(render())
    expect(one).toContain(String(EXDB.length))
    expect(five).toBe(forms.many.replace('{0}', '5').replace('{1}', String(EXDB.length)))
    expect(one).not.toBe(five.replace('5', '1'))
  })

  it('keeps the subtitle on one line on wider screens, clipping with an ellipsis', () => {
    expect(sub(render())).toBeTruthy()
    const rule = cssSource.match(/^\.hdr\.lib-hdr>\.sub\.lib-count\{([^}]*)\}/m)?.[1] || ''
    expect(rule).toContain('white-space:nowrap')
    expect(rule).toContain('overflow:hidden')
    expect(rule).toContain('text-overflow:ellipsis')
    expect(rule).toContain('flex:1 0 100%')
    expect(cssSource).toMatch(/^\.hdr\.lib-hdr\{[^}]*flex-wrap:wrap/m)
  })

  it('lets the subtitle wrap on narrow phones so nothing is cut at 320 px', () => {
    const narrow = cssSource.match(/@media \(max-width:360px\)\{\.hdr\.lib-hdr>\.sub\.lib-count\{([^}]*)\}\}/)?.[1] || ''
    expect(narrow).toContain('white-space:normal')
    expect(narrow).toContain('overflow:visible')
  })
})

describe('Library similar exercises', () => {
  const search = (host, text) => {
    const input = host.querySelector('.search input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    act(() => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  const label = host => host.querySelector('.similar-label')?.textContent || null

  it('offers what comes close instead of "No match" when nothing matches exactly', () => {
    const host = render()
    search(host, 'dumbbell curl qwxz')
    expect(label(host)).toBe('No exact match. These come close:')
    expect(host.textContent).not.toContain('No match')
    expect(names(host).slice(0, 5).some(n => /dumbbell.*curl/.test(n))).toBe(true)
  })

  it('lists similar ones under a short result list, without repeating a result', () => {
    const host = render()
    search(host, 'face pull')
    expect(label(host)).toBe('Similar exercises')
    const all = names(host)
    expect(new Set(all).size).toBe(all.length)
  })
})

// A2/A4/A5/A14/A12 Web paths: AI mode owns the list, restores the exact snapshot on x,
// applies only the fallback chip's dimension, and reopens the launcher from the sparkle.
describe('Library AI search entry', () => {
  it('hides chips and disables the text field while AI is open', async () => {
    const host = render()
    setSearch(host, 'press')
    act(() => sparkle(host).click())
    expect(host.querySelector('[data-testid="ai-state"]')).toBeTruthy()
    expect(host.querySelector('.search input').disabled).toBe(true)
    expect(host.querySelector('.lib-filters')).toBeNull()
    expect(host.querySelector('.list')).toBeNull()
  })

  it('restores the exact text, body part and page size snapshot on x', async () => {
    const host = render()
    setSearch(host, 'press')
    const chest = [...host.querySelectorAll('.chips .chip')].find(b => b.textContent === 'chest')
    act(() => chest.click())
    const before = host.querySelectorAll('.list .item').length
    if (before < 45) {
      const more = [...host.querySelectorAll('button')].find(b => b.textContent === 'Show more')
      if (more) act(() => more.click())
    }
    const shownBefore = host.querySelectorAll('.list .item').length
    act(() => sparkle(host).click())
    act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'ai-exit').click())
    expect(host.querySelector('.search input').value).toBe('press')
    expect([...host.querySelectorAll('.chips .chip')].find(b => b.textContent === 'chest').getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelectorAll('.list .item').length).toBe(shownBefore)
  })

  it('applies only the fallback dimension and never restores the snapshot', async () => {
    const host = render()
    setSearch(host, 'press')
    act(() => [...host.querySelectorAll('.chips .chip')].find(b => b.textContent === 'chest').click())
    act(() => sparkle(host).click())
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent === 'ai-equipment').click() })
    expect(host.querySelector('.search input').value).toBe('')
    expect([...host.querySelectorAll('.chips .chip')].find(b => b.textContent === 'chest').getAttribute('aria-pressed')).toBe('false')
    const equipment = [...host.querySelectorAll('.lib-filters .chip')].find(b => b.textContent === 'barbell')
    expect(equipment).toBeTruthy()
    expect(equipment.classList.contains('on')).toBe(true)
  })

  it('reopens the launcher from the sparkle while AI mode is active', async () => {
    const host = render()
    act(() => sparkle(host).click())
    act(() => sparkle(host).click())
    expect(mocks.ai.reopen).toHaveBeenCalledOnce()
  })

  it('does not render the sparkle when the instance disabled the agent runtime', () => {
    mocks.CONFIG = { agent: { enabled: false } }
    const host = render()
    expect(sparkle(host)).toBeNull()
  })

  it('shows the interrupted notice for an open run and cancels it', async () => {
    mocks.ai.interrupted = { runId: 'old-run', sessionId: 'old-session', accountId: 'u1' }
    mocks.ai.getRun = vi.fn(async () => ({ status: 'running' }))
    const host = render()
    await flush()
    expect(host.textContent).toContain('上次检索未完成')
    expect(mocks.ai.cancelRun).toHaveBeenCalledWith('old-run')
    expect(mocks.ai.clear).toHaveBeenCalledWith('u1', 'old-run')
    act(() => [...host.querySelectorAll('button')].find(b => b.textContent === '重新发起').click())
    expect(host.querySelector('[data-testid="ai-state"]')).toBeTruthy()
  })

  it('does not show the interrupted notice for a terminal run', async () => {
    mocks.ai.interrupted = { runId: 'old-run', sessionId: 'old-session', accountId: 'u1' }
    mocks.ai.getRun = vi.fn(async () => ({ status: 'completed' }))
    const host = render()
    await flush()
    expect(host.textContent).not.toContain('上次检索未完成')
    expect(mocks.ai.clear).toHaveBeenCalledWith('u1', 'old-run')
  })
})
