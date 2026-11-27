import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { parseHTML } from 'linkedom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CoachChat, { MAX_GENUI_TURNS, countGenUITurns, buildGenUIHistory } from './CoachChat.jsx'
import { askCoach, refinePlan } from '../lib/coach-api.js'
import { CONSENT_VERSION } from '../lib/coach.js'   // the consent a fixture grants is the current one, whatever its number
import { effectiveRoutine } from '../lib/history.js'
import { todayISO } from '../lib/format.js'

// The chat is where a plan is imported. These pin that the Import button applies the pending
// plan through the store, writes the decision into the thread, and leaves today startable.
const mocks = vi.hoisted(() => {
  const state = { S: null, pending: null, job: null, community: false, maxMessageLen: 2200, nav: vi.fn(), toast: vi.fn(), openSheet: vi.fn(), refresh: vi.fn(), stream: vi.fn() }
  state.storeSnapshot = () => ({
    S: state.S,
    user: { id: 'u1' },
    ready: true,
    config: { coach: { enabled: true, ...(state.community ? { community: true } : {}) } },
    coachLocal: null,
    update: mut => mut(state.S),
  })
  state.uiSnapshot = () => ({ toast: state.toast, openSheet: state.openSheet })
  return state
})

vi.mock('../store/useStore.js', () => {
  const useStore = selector => selector(mocks.storeSnapshot())
  useStore.getState = mocks.storeSnapshot
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const useUI = selector => selector ? selector(mocks.uiSnapshot()) : mocks.uiSnapshot()
  useUI.getState = mocks.uiSnapshot
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.nav }))
vi.mock('../lib/coach-api.js', () => ({
  useCoachStatus: () => ({ pending: mocks.pending, job: mocks.job, cap: null, loading: false, lastError: null, last: null, refresh: mocks.refresh, maxMessageLen: mocks.maxMessageLen }),
  resolvePending: vi.fn(() => Promise.resolve({})),
  refinePlan: vi.fn(() => Promise.resolve({})),
  requestReview: vi.fn(() => Promise.resolve({})),
  requestDebrief: vi.fn(() => Promise.resolve({})),
  askCoach: vi.fn(() => Promise.resolve({})),
  cohortStats: vi.fn(() => Promise.resolve({ ok: false, enabled: true, sharing: false })),
  setCohortShare: vi.fn(() => Promise.resolve({ ok: true, sharing: true })),
  JOB_ERRORS: { internal: 'x' },
  ensureAiConsent: vi.fn(() => Promise.resolve(true)),
  isDeclined: e => e?.code === 'declined',
  awaitedJob: () => null,
  settleAwaited: vi.fn(),
}))
vi.mock('../sheets.jsx', () => ({ startFlow: vi.fn(), confirmSheet: vi.fn() }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(() => Promise.resolve({})),
  IS_APPLE: false, IS_ANDROID: false, BIO: 'biometrics',
}))
vi.mock('../coach.css', () => ({}))
// One stream per test: each test decides what events arrive and when the run finishes.
vi.mock('../lib/coach-genui-client.js', () => ({
  streamCoachGenUI: (...args) => mocks.stream(...args),
}))

let dom, root, container
const TODAY_WD = new Date(todayISO() + 'T12:00:00').getDay()

const bundle = week => ({
  opengym_plan: 1, name: 'Coach plan', summary: 'a plan',
  week,
  routines: [
    { id: 'x1', name: 'Full body A', emoji: '💪', why: 'first', ex: [{ id: '0001', sets: 3, reps: 10, mode: 'reps', why: 'because' }] },
    { id: 'x2', name: 'Full body B', emoji: '🏋️', ex: [{ id: '0002', sets: 3, reps: 8, mode: 'reps' }] }
  ],
  customEx: [],
})
const everyDay = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [d, 'x1']))

const state = () => ({
  unit: 'kg', lang: 'en', customEx: [], workouts: [], bodyweight: [], exWeights: {},
  dayPlan: {}, routines: [], week: {},
  coach: {
    consent: { agreedAt: '2026-07-01T00:00:00Z', version: CONSENT_VERSION },
    profile: { goal: 'muscle', experience: 'new', daysPerWeek: 3, sessionMin: 60, preferredDays: [1, 3, 5], equipment: [] },
    log: [], snapshots: [], chat: [{ id: 'c1', role: 'user', kind: 'intake', at: 1 }], timings: []
  },
})

function installDom() {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
  dom = parsed.window
  globalThis.window = dom
  globalThis.document = dom.document
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.navigator })
  for (const key of ['HTMLElement', 'Node', 'Element', 'Event', 'Blob']) globalThis[key] = dom[key]
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.getElementById('root')
  root = createRoot(container)
}

async function mount(pending, job = null, { community = false, S = state() } = {}) {
  mocks.S = S
  mocks.pending = pending
  mocks.job = job
  mocks.community = community
  installDom()
  await act(async () => { root.render(React.createElement(CoachChat)) })
}

const byText = re => [...container.querySelectorAll('button')].find(b => re.test(b.textContent || ''))
async function click(el) {
  expect(el).toBeTruthy()
  await act(async () => { el.dispatchEvent(new dom.Event('click', { bubbles: true })) })
}

// A state with a real routine and a quick form in the thread: submitting it asks a free-form
// question, which is the streaming path every account now takes (routines or none).
const streamingState = () => {
  const s = state()
  s.routines = [{ id: 'x1', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 8 }] }]
  s.coach.chat.push({
    id: 'gform', role: 'coach', kind: 'genui', at: 2, text: '', blocks: [],
    nodes: [{
      id: 'qf1', type: 'quick_form', formId: 'ask_form', title: 'How is my bench?',
      submitLabel: 'Ask', fields: [],
    }],
  })
  return s
}

async function submitQuickForm() {
  await click(byText(/^Ask$/))
}

beforeEach(() => { vi.clearAllMocks(); mocks.stream.mockReset() })
afterEach(async () => {
  if (root) { await act(async () => { root.unmount() }); root = null }
  container = null; dom = null
})

describe('the Coach chat', () => {
  it('opens with the questionnaire summary and pitches the plan as a card with routine tabs', async () => {
    await mount({ id: 'p1', kind: 'create', bundle: bundle(everyDay) })
    expect(container.textContent).toContain('Build muscle')
    expect(container.textContent).toContain('3 days a week')
    expect(container.querySelectorAll('.pcard-tab').length).toBe(2)
    expect(container.textContent).toContain('because')
    await click([...container.querySelectorAll('.pcard-tab')][1])
    expect(container.querySelector('.pcard-rt-h b').textContent).toContain('Full body B')
  })

  it('imports the plan through the store, records it in the thread, and leaves today startable', async () => {
    await mount({ id: 'p1', kind: 'create', bundle: bundle(everyDay) })
    await click(byText(/Import this plan/))
    const s = mocks.S
    expect(s.routines.length).toBe(2)
    expect(s.week[TODAY_WD]).toBeTruthy()
    const todays = effectiveRoutine(s, todayISO())
    expect(todays && todays.ex.length).toBeGreaterThan(0)
    expect(s.coach.chat.at(-1).kind).toBe('applied')
    expect(s.coach.snapshots).toHaveLength(1)
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('leaves the week alone when the schedule switch is off', async () => {
    await mount({ id: 'p1', kind: 'create', bundle: bundle(everyDay) })
    const sw = container.querySelector('[role="switch"]')
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await click(sw)
    await click(byText(/Import this plan/))
    expect(Object.keys(mocks.S.week)).toHaveLength(0)
    expect(mocks.S.routines.length).toBe(2)
  })

  it('shows the typing bubble with an estimate while a job runs, and disables the composer', async () => {
    await mount(null, { id: 'j1', kind: 'create', state: 'running', startedAt: Date.now() })
    expect(container.querySelector('.typing')).toBeTruthy()
    expect(container.textContent).toContain('usually takes')
    expect(container.querySelector('.composer textarea').disabled).toBe(true)
  })

  it('caps the composer at the admin\'s configured message length, not the old 1000-char default (issue #267)', async () => {
    await mount(null)
    expect(container.querySelector('.composer textarea').getAttribute('maxLength')).toBe('2200')
  })

  it('falls back to 1000 while the status poll has not answered yet', async () => {
    mocks.maxMessageLen = undefined
    try {
      await mount(null)
      expect(container.querySelector('.composer textarea').getAttribute('maxLength')).toBe('1000')
    } finally {
      mocks.maxMessageLen = 2200
    }
  })

  it('applies the accepted subset of a review and logs it', async () => {
    mocks.S = state()
    await mount({ id: 'r1', kind: 'review', summary: 's', changes: [
      { id: 'a', type: 'week', target: { weekday: 1 }, before: null, after: null, why: 'rest' },
      { id: 'b', type: 'add-routine', target: {}, before: null, after: { name: 'Legs', ex: [{ id: '0001', sets: 3, reps: 10 }] }, why: 'legs' }
    ] })
    expect(container.querySelectorAll('[role="checkbox"]').length).toBe(2)
    await click([...container.querySelectorAll('[role="checkbox"]')][0])   // drop the week change
    await click(byText(/Apply 1 change/))
    expect(mocks.S.routines.map(r => r.name)).toEqual(['Legs'])
    expect(mocks.S.coach.chat.at(-1).kind).toBe('applied')
    expect(mocks.S.coach.log.at(-1).decisions.map(d => d.status)).toEqual(['accepted', 'rejected'])
  })

  it('keeps an applied review in the thread as a card that opens the whole proposal', async () => {
    await mount({ id: 'r1', kind: 'review', summary: 'a reading', changes: [
      { id: 'a', type: 'week', target: { weekday: 1 }, before: null, after: null, why: 'rest' },
      { id: 'b', type: 'add-routine', target: {}, before: null, after: { name: 'Legs', ex: [{ id: '0001', sets: 3, reps: 10 }] }, why: 'legs' }
    ] })
    await click([...container.querySelectorAll('[role="checkbox"]')][0])
    await click(byText(/Apply 1 change/))
    // The decision is in the store; re-render with the proposal gone, as the poll would.
    mocks.pending = null
    await act(async () => { root.render(React.createElement(CoachChat)) })
    const recap = container.querySelector('.recap')
    expect(recap).toBeTruthy()
    expect(recap.textContent).toContain('1 accepted · 1 declined')
    expect(recap.querySelectorAll('.recap-chip.yes').length).toBe(1)
    expect(recap.querySelectorAll('.recap-chip.no').length).toBe(1)
    expect(mocks.S.coach.chat.at(-1).ref).toBe(mocks.S.coach.log.at(-1).id)
    await click(recap)
    expect(mocks.openSheet).toHaveBeenCalled()
  })

  it('shows a debrief with its score ring and files it on "Got it"', async () => {
    await mount({ id: 'd1', kind: 'debrief', workout: { id: 'w1', name: 'Push', d: '2026-08-29' }, summary: 'ok', score: 8, highlights: ['a'], watch: [], nextTime: ['b'] })
    expect(container.querySelector('.deb-ring')).toBeTruthy()
    expect(container.textContent).toContain('Good session')
    expect(container.textContent).toContain('What went well')
    expect(container.textContent).not.toContain('Worth watching')
    await click(byText(/Got it/))
    expect(mocks.S.coach.log.at(-1).kind).toBe('debrief')
    expect(mocks.S.coach.log.at(-1).score).toBe(8)
    expect(mocks.S.coach.chat.at(-1).kind).toBe('debrief')
    expect(mocks.S.coach.chat.at(-1).ref).toBe(mocks.S.coach.log.at(-1).id)
  })

  it('keeps an unresolved debrief at its creation point, above later follow-ups (issue #2)', async () => {
    const s = state()
    s.coach.chat = [
      { id: 'u1', role: 'user', kind: 'text', text: 'How did my Pull Day go?', at: 1000 },
      { id: 'u2', role: 'user', kind: 'text', text: 'Should I add another pull day?', at: 3000 },
      { id: 'g1', role: 'coach', kind: 'genui', text: 'Keep the current split for another week.', blocks: [], at: 3500 },
    ]
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await mount({
        id: 'd1', kind: 'debrief', createdAt: 2000,
        workout: { id: 'w1', name: 'Pull Day', d: '2026-08-29' },
        summary: 'ok', score: 8, highlights: ['a'], watch: [], nextTime: ['b'],
      }, null, { S: s })

      const rows = [...container.querySelector('.msgs').children]
      const earlier = rows.findIndex(el => el.textContent.includes('How did my Pull Day go?'))
      const debrief = rows.findIndex(el => el.querySelector('.deb-ring'))
      const followedUp = rows.findIndex(el => el.textContent.includes('Should I add another pull day?'))
      const replied = rows.findIndex(el => el.textContent.includes('Keep the current split for another week.'))

      expect(earlier).toBeGreaterThanOrEqual(0)
      expect(debrief).toBeGreaterThan(earlier)
      expect(followedUp).toBeGreaterThan(debrief)
      expect(replied).toBeGreaterThan(debrief)
      // 4 === Node.DOCUMENT_POSITION_FOLLOWING (linkedom does not export the constant).
      expect(rows[debrief].compareDocumentPosition(rows[followedUp]) & 4).toBe(4)
      expect(rows[earlier].compareDocumentPosition(rows[debrief]) & 4).toBe(4)
      expect(errors.mock.calls.some(args => String(args[0]).includes('unique "key"'))).toBe(false)
    } finally {
      errors.mockRestore()
    }
  })

  it('falls back to the end of the thread when a pending card has no creation time', async () => {
    const s = state()
    s.coach.chat = [
      { id: 'u1', role: 'user', kind: 'text', text: 'First question', at: 1000 },
      { id: 'u2', role: 'user', kind: 'text', text: 'Second question', at: 3000 },
    ]
    await mount({
      id: 'd2', kind: 'debrief',
      workout: { id: 'w1', name: 'Pull Day', d: '2026-08-29' },
      summary: 'ok', score: 8, highlights: [], watch: [], nextTime: [],
    }, null, { S: s })
    const rows = [...container.querySelector('.msgs').children]
    const debrief = rows.findIndex(el => el.querySelector('.deb-ring'))
    const lastMessage = rows.findIndex(el => el.textContent.includes('Second question'))
    expect(debrief).toBeGreaterThan(lastMessage)
  })

  it('lays the plan’s week out from the day the week is set to start on', async () => {
    const days = () => [...container.querySelectorAll('.pcard-wd')].map(d => d.textContent)
    await mount({ id: 'p1', kind: 'create', bundle: bundle({ 0: 'x1', 1: 'x2' }) })
    expect(days()).toEqual(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'])
    const sunday = state(); sunday.weekStart = 0
    await mount({ id: 'p1', kind: 'create', bundle: bundle({ 0: 'x1', 1: 'x2' }) }, null, { S: sunday })
    expect(days()).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'])
    expect([...container.querySelectorAll('.pcard-wd.on')].map(d => d.textContent)).toEqual(['Su', 'Mo'])
  })

  it('offers the quick actions only when nothing is running', async () => {
    await mount(null)
    expect(byText(/Review my training/)).toBeTruthy()
    expect(byText(/Last workout/)).toBeFalsy()          // no workout logged yet
    await mount(null, { id: 'j1', kind: 'review', state: 'running', startedAt: Date.now() })
    expect(byText(/Review my training/)).toBeFalsy()
  })

  it('offers the comparison only when the instance allows it', async () => {
    await mount(null)
    expect(byText(/^Compare$/)).toBeFalsy()
    await mount(null, null, { community: true })
    expect(byText(/^Compare$/)).toBeTruthy()
  })
})

describe('the Coach chat: a 0-routine account', () => {
  // linkedom does not drive React 19's synthetic onChange from a dispatched 'input', so the
  // component's handler is called the way React would after a keystroke.
  const type = (el, value) => {
    const key = Object.keys(el).find(k => k.startsWith('__reactProps$'))
    const onChange = key ? el[key]?.onChange : null
    if (onChange) { onChange({ target: { value } }); return }
    Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set.call(el, value)
    el.dispatchEvent(new dom.Event('input', { bubbles: true }))
  }

  it('streams a typed message instead of hijacking it to the old plan job', async () => {
    const s = state()
    s.routines = []
    s.workouts = [{ id: 'w1', d: '2026-01-01', entries: [] }]   // imported history, no templates yet
    mocks.stream.mockImplementation(({ onEvent }) => {
      onEvent({ type: 'RUN_STARTED' })
      return Promise.resolve({
        text: '', blocks: [], nodes: [{ id: 'n1', type: 'prose', text: 'Here is what your log says.' }],
      })
    })
    await mount(null, null, { S: s })

    await act(async () => { type(container.querySelector('.composer textarea'), 'Build me a push day') })
    expect(container.querySelector('.composer textarea').value).toBe('Build me a push day')
    expect(container.querySelector('.composer .send').disabled).toBe(false)
    await click(container.querySelector('.composer .send'))

    expect(refinePlan).not.toHaveBeenCalled()
    expect(mocks.stream).toHaveBeenCalledTimes(1)
    expect(mocks.stream.mock.calls[0][0].text).toBe('Build me a push day')
    expect(s.coach.chat.at(-1)).toMatchObject({ role: 'coach', kind: 'genui' })
    expect(s.coach.chat.at(-2)).toMatchObject({ role: 'user', kind: 'text', text: 'Build me a push day' })
  })
})

describe('the Coach chat: v2 interleaved GenUI stream', () => {
  const finalNodes = [
    { id: 'node_1', type: 'prose', text: 'Your bench stalled.' },
    { id: 'node_2', type: 'kpi_strip', items: [{ kind: 'prescription', label: 'Top set', value: '4×8' }] },
    { id: 'node_4', type: 'prose', tone: 'closing', text: 'Try one fewer set next week.' },
  ]

  it('renders prose, pending, commit and drop live, then persists the final nodes', async () => {
    mocks.stream.mockImplementation(({ onEvent }) => new Promise(resolve => {
      mocks.emit = onEvent
      mocks.finish = resolve
    }))
    const s = streamingState()
    await mount(null, null, { S: s })
    await submitQuickForm()
    expect(mocks.stream).toHaveBeenCalled()

    const emit = async event => { await act(async () => { mocks.emit(event) }) }
    await emit({ type: 'RUN_STARTED' })
    expect(s.coach.chat.at(-1)).toMatchObject({ role: 'user', kind: 'text', text: 'How is my bench?' })

    await emit({ type: 'CUSTOM', name: 'genui.prose_delta', value: { nodeId: 'node_1', delta: 'Your bench stalled.' } })
    expect(container.querySelector('.genui-live .genui-prose').textContent).toContain('Your bench stalled.')
    expect(container.querySelector('.genui-cursor')).toBeTruthy()

    await emit({ type: 'CUSTOM', name: 'genui.node_commit', value: { node: finalNodes[0] } })
    expect(container.querySelector('.genui-cursor')).toBeTruthy()

    await emit({ type: 'CUSTOM', name: 'genui.node_pending', value: { nodeId: 'node_2', nodeType: 'kpi_strip' } })
    expect(container.querySelector('.genui-live .genui-pending-kpi')).toBeTruthy()
    expect(container.querySelector('.genui-cursor')).toBeFalsy()

    await emit({ type: 'CUSTOM', name: 'genui.node_commit', value: { node: finalNodes[1] } })
    expect(container.querySelector('.genui-live .genui-kpi-strip')).toBeTruthy()
    expect(container.querySelector('.genui-live .genui-pending')).toBeFalsy()

    await emit({ type: 'CUSTOM', name: 'genui.node_pending', value: { nodeId: 'node_3', nodeType: 'exercise_trend' } })
    expect(container.querySelector('.genui-live .genui-pending-box')).toBeTruthy()

    await emit({ type: 'CUSTOM', name: 'genui.node_drop', value: { nodeId: 'node_3' } })
    expect(container.querySelector('.genui-live .genui-pending')).toBeFalsy()

    await emit({ type: 'CUSTOM', name: 'genui.prose_delta', value: { nodeId: 'node_4', delta: 'Try one fewer set next week.', tone: 'closing' } })
    await emit({ type: 'CUSTOM', name: 'genui.node_commit', value: { node: finalNodes[2] } })
    expect(container.querySelectorAll('.genui-live .genui-prose')).toHaveLength(2)
    expect(container.querySelector('.genui-live .genui-prose.tone-closing')).toBeTruthy()

    await emit({ type: 'RUN_FINISHED', nodes: finalNodes, text: '', blocks: [] })
    await act(async () => { mocks.finish({ nodes: finalNodes, text: '', blocks: [] }) })

    expect(container.querySelector('.genui-live')).toBeFalsy()
    const saved = s.coach.chat.at(-1)
    expect(saved.kind).toBe('genui')
    expect(saved.nodes.map(n => n.id)).toEqual(['node_1', 'node_2', 'node_4'])
    expect(saved.nodes.map(n => n.type)).toEqual(['prose', 'kpi_strip', 'prose'])
    expect(container.querySelectorAll('.genui-briefing .genui-prose')).toHaveLength(2)
    expect(container.querySelector('.genui-briefing .genui-kpi-strip')).toBeTruthy()
  })

  it('keeps the partial nodes when the user stops the stream', async () => {
    mocks.stream.mockImplementation(({ onEvent, signal }) => new Promise((resolve, reject) => {
      onEvent({ type: 'RUN_STARTED' })
      onEvent({ type: 'CUSTOM', name: 'genui.prose_delta', value: { nodeId: 'prose_0', delta: 'You are close.' } })
      onEvent({ type: 'CUSTOM', name: 'genui.node_commit', value: { node: { id: 'prose_0', type: 'prose', text: 'You are close.' } } })
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' })))
    }))
    const s = streamingState()
    await mount(null, null, { S: s })
    await submitQuickForm()
    expect(container.querySelector('.genui-live .genui-cursor')).toBeTruthy()

    await click(byText(/Stop/))
    await act(async () => {})

    expect(container.querySelector('.genui-live')).toBeFalsy()
    const saved = s.coach.chat.at(-1)
    expect(saved.kind).toBe('genui')
    expect(saved.nodes).toEqual([{ id: 'prose_0', type: 'prose', text: 'You are close.' }])
    expect(container.textContent).toContain('You are close.')
  })

  it('draws a prose-only reply as a compact bubble, not a briefing', async () => {
    const s = state()
    s.coach.chat.push({
      id: 'g1', role: 'coach', kind: 'genui', at: 2, text: '', blocks: [],
      nodes: [
        { id: 'p1', type: 'prose', text: 'Keep the current split.' },
        { id: 'p2', type: 'prose', text: 'Add one rep next week.' },
      ],
    })
    await mount(null, null, { S: s })
    expect(container.querySelector('.genui-briefing')).toBeFalsy()
    const bubbles = [...container.querySelectorAll('.bub')].map(el => el.textContent)
    expect(bubbles.some(txt => txt.includes('Keep the current split.') && txt.includes('Add one rep next week.'))).toBe(true)
  })

  it('renders v1 { text, blocks } history through normalizeGenUINodes', async () => {
    const s = state()
    s.coach.chat.push(
      {
        id: 'g1', role: 'coach', kind: 'genui', at: 2,
        text: 'A legacy answer.', blocks: [{ id: 'b1', type: 'fallback_notice', text: 'Could not draw that.' }],
      },
      { id: 'g2', role: 'coach', kind: 'genui', at: 3, text: 'Just words.', blocks: [] },
    )
    await mount(null, null, { S: s })
    expect(container.querySelectorAll('.genui-briefing')).toHaveLength(1)
    expect(container.querySelector('.genui-briefing').textContent).toContain('A legacy answer.')
    expect(container.querySelector('.genui-briefing').textContent).toContain('Could not draw that.')
    const bubbles = [...container.querySelectorAll('.bub')].map(el => el.textContent)
    expect(bubbles.some(txt => txt.includes('Just words.'))).toBe(true)
  })

  it('renders legacy checklist nodes as read-only steps without interactive todo checkboxes', async () => {
    const s = state()
    s.coach.chat.push({
      id: 'g1', role: 'coach', kind: 'genui', at: 2, text: '', blocks: [],
      nodes: [{
        id: 'chk_msg', type: 'checklist', listId: 'warmup', title: 'Warm-up',
        items: [{ id: 'band', label: 'Band pull-apart' }, { id: 'slide', label: 'Wall slide' }],
      }],
    })
    await mount(null, null, { S: s })
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
    expect(container.textContent).toContain('Band pull-apart')
    expect(container.textContent).toContain('Wall slide')
  })
})

describe('the Coach chat: v2.1 ten-turn context', () => {
  const historyState = () => {
    const s = state()
    s.routines = [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 8 }] }]
    const chat = [{ id: 'intake', role: 'user', kind: 'intake', at: 1 }]
    for (let i = 0; i < 9; i++) {
      chat.push({ id: 'u' + i, role: 'user', kind: 'text', text: 'Q' + i, at: 10 + i * 2 })
      chat.push({ id: 'a' + i, role: 'coach', kind: 'text', text: 'A' + i, at: 11 + i * 2 })
    }
    chat.push({ id: 'err', role: 'coach', kind: 'error', text: 'server exploded' })
    chat.push({
      id: 'gen', role: 'coach', kind: 'genui', at: 40, text: '', blocks: [], nodes: [
        { id: 'p', type: 'prose', text: 'Here is the reading.' },
        { id: 'pa1', type: 'proposal_action', applied: true, title: 'Applied swap', planHash: 'x', changes: [
          { id: 'c1', type: 'sets', target: { routineId: 'r1', exId: '0025' }, before: 3, after: 4, why: 'x' },
        ] },
        { id: 'pa2', type: 'proposal_action', applied: false, title: 'Pending swap', planHash: 'x', changes: [
          { id: 'c2', type: 'swap-exercise', target: { routineId: 'r1', exId: '0025' }, before: { id: '0025' }, after: { id: '0289' }, why: 'y' },
        ] },
        { id: 't', type: 'exercise_trend', exId: '0025', metric: 'e1rm', weeks: 8 },
        { id: 'm', type: 'muscle_load', window: '7d' },
        { id: 'alts', type: 'exercise_alternatives', items: [{ exId: '0289' }, { exId: '0290' }, {}] },
        { id: 'c', type: 'callout', title: 'Note title', text: 'Note body' },
        { id: 'ct', type: 'comparison_table', title: 'Press options', columns: ['A', 'B'] },
      ],
    })
    s.coach.chat = chat
    return s
  }

  it('counts and forwards every turn as valid NDJSON — no 6–8 truncation or bracket pseudo-text', () => {
    const s = historyState()
    expect(MAX_GENUI_TURNS).toBe(10)
    expect(countGenUITurns(s.coach.chat)).toBe(9)

    const history = buildGenUIHistory(s.coach.chat, s)
    // 9 user + 9 assistant text turns + the one genui reply; intake and error are skipped.
    expect(history).toHaveLength(19)
    expect(history.filter(m => m.role === 'user')).toHaveLength(9)
    expect(history.filter(m => m.role === 'user').map(m => m.content)).toEqual(expect.arrayContaining(['Q0', 'Q8']))

    // Every assistant turn must be valid line-by-line NDJSON so in-context learning reinforces JSON!
    for (const turn of history.filter(m => m.role === 'assistant')) {
      const lines = turn.content.split('\n').filter(Boolean)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        const parsed = JSON.parse(line)
        expect(typeof parsed.type).toBe('string')
      }
    }

    const assistant = history.at(-1)
    expect(assistant.role).toBe('assistant')
    const parsedNodes = assistant.content.split('\n').map(l => JSON.parse(l))
    expect(parsedNodes.map(n => n.type)).toEqual([
      'prose', 'proposal_action', 'proposal_action', 'exercise_trend',
      'muscle_load', 'exercise_alternatives', 'callout', 'comparison_table',
    ])
    expect(parsedNodes[1].applied).toBe(true)
    expect(parsedNodes[1].changes[0]).toMatchObject({ type: 'sets', before: 3, after: 4 })
    expect(parsedNodes[2].applied).toBeUndefined()
    expect(parsedNodes[3]).toMatchObject({ exId: '0025', metric: 'e1rm', weeks: 8 })
    expect(parsedNodes[4]).toMatchObject({ window: '7d' })
    expect(assistant.content).not.toContain('[Shown ')
    expect(assistant.content).not.toContain('[Proposal')

    const joined = history.map(m => m.content).join('\n')
    expect(joined).not.toContain('server exploded')
    expect(joined).not.toContain('Here is what I am working with:')
  })

  it('compacts an add-routine proposal to the fields the next turn needs, as valid NDJSON', () => {
    const s = state()
    s.coach.chat.push({
      id: 'gnew', role: 'coach', kind: 'genui', at: 2, text: '', blocks: [],
      nodes: [{
        id: 'pa_new', type: 'proposal_action', title: 'A new plan',
        changes: [{
          id: 'gc_new', type: 'add-routine', target: {}, why: 'chest focus',
          after: {
            name: 'Push', emoji: '🏋️', prog: 'linear', weekdays: [1, 4],
            ex: [
              { id: '0025', sets: 4, reps: 8, repsMin: 6, repsMax: 10, mode: 'reps', why: 'a long note', name: 'Barbell Bench Press' },
              { id: '0007', sets: 3, mode: 'time', sec: 45 },
            ],
          },
        }],
      }],
    })

    const assistant = buildGenUIHistory(s.coach.chat, s).find(m => m.role === 'assistant')
    const node = JSON.parse(assistant.content.split('\n')[0])
    expect(node.type).toBe('proposal_action')
    expect(node.changes[0].after).toEqual({
      name: 'Push', emoji: '🏋️', weekdays: [1, 4],
      ex: [
        { id: '0025', sets: 4, mode: 'reps', reps: 8, repsMin: 6, repsMax: 10 },
        { id: '0007', sets: 3, mode: 'time', sec: 45 },
      ],
    })
  })

  it('sends the prior conversation as history without duplicating the new user message', async () => {
    const s = streamingState()
    s.coach.chat.push({ id: 'earlier', role: 'user', kind: 'text', text: 'Earlier question', at: 1.5 })
    mocks.stream.mockImplementation(() => Promise.resolve({
      text: 'ok', blocks: [], nodes: [{ id: 'n1', type: 'prose', text: 'ok' }],
    }))
    await mount(null, null, { S: s })
    await submitQuickForm()

    expect(mocks.stream).toHaveBeenCalledTimes(1)
    const arg = mocks.stream.mock.calls[0][0]
    expect(arg.text).toBe('How is my bench?')
    expect(arg.history.at(-1)).toEqual({ role: 'user', content: 'Earlier question' })
    expect(arg.history.some(m => m.content === 'How is my bench?')).toBe(false)
  })

  it('persists applied:true on the matching proposal node in S.coach.chat', async () => {
    const s = state()
    s.routines = [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 8 }] }]
    s.coach.chat.push({
      id: 'gprop', role: 'coach', kind: 'genui', at: 2, text: '', blocks: [],
      nodes: [{
        id: 'prop1', type: 'proposal_action', title: 'Add a set',
        changes: [{ id: 'gc1', type: 'sets', target: { routineId: 'r1', exId: '0025' }, before: 3, after: 4, why: 'x' }],
      }],
    })
    await mount(null, null, { S: s })
    await click(byText(/Apply 1 change/))

    const saved = s.coach.chat.find(m => m.id === 'gprop')
    expect(saved.nodes[0].applied).toBe(true)
    expect(mocks.refresh).toHaveBeenCalled()
  })

  it('shows N/10 turns and a New conversation button once the conversation has started', async () => {
    const s = state()
    for (let i = 0; i < 3; i++) {
      s.coach.chat.push({ id: 'u' + i, role: 'user', kind: 'text', text: 'Q' + i, at: 2 + i })
      s.coach.chat.push({ id: 'a' + i, role: 'coach', kind: 'text', text: 'A' + i, at: 2 + i })
    }
    await mount(null, null, { S: s })
    expect(container.querySelector('.composer-turns').textContent).toBe('3/10 turns')
    expect(byText(/^New conversation$/)).toBeTruthy()
  })

  it('handles the 429 turn limit with a toast and never falls back to askCoach', async () => {
    const s = streamingState()
    mocks.stream.mockImplementation(() => Promise.reject(Object.assign(
      new Error('Too many turns'), { status: 429, code: 'turn_limit' },
    )))
    await mount(null, null, { S: s })
    await submitQuickForm()

    expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining('10-turn limit'))
    expect(askCoach).not.toHaveBeenCalled()
    // The failed turn never wrote a user message, and no empty reply was persisted.
    expect(s.coach.chat.at(-1).id).toBe('gform')
  })

  it('locks sending at 10 turns and Start a new conversation clears only the chat', async () => {
    const s = state()
    s.routines = [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 3, reps: 8 }] }]
    s.workouts = [{ id: 'w1', d: '2026-01-01', entries: [] }]
    s.coach.log = [{ id: 'log1' }]
    s.coach.snapshots = [{ id: 'snap1' }]
    const kept = {
      routines: s.routines, workouts: s.workouts, profile: s.coach.profile,
      log: s.coach.log, snapshots: s.coach.snapshots, consent: s.coach.consent,
    }
    for (let i = 0; i < 10; i++) s.coach.chat.push({ id: 'u' + i, role: 'user', kind: 'text', text: 'Q' + i, at: 2 + i })

    await mount(null, null, { S: s })
    expect(container.querySelector('.genui-turn-banner')).toBeTruthy()
    expect(container.querySelector('.composer textarea').disabled).toBe(true)
    expect(container.querySelector('.send').disabled).toBe(true)

    await click(byText(/Start a new conversation/))
    expect(s.coach.chat).toEqual([])
    expect(s.routines).toBe(kept.routines)
    expect(s.workouts).toBe(kept.workouts)
    expect(s.coach.profile).toBe(kept.profile)
    expect(s.coach.log).toBe(kept.log)
    expect(s.coach.snapshots).toBe(kept.snapshots)
    expect(s.coach.consent).toBe(kept.consent)

    await act(async () => { root.render(React.createElement(CoachChat)) })
    expect(container.querySelector('.genui-turn-banner')).toBeFalsy()
    expect(container.querySelector('.composer textarea').disabled).toBe(false)
  })
})
