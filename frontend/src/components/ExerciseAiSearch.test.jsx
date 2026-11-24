// @vitest-environment happy-dom
// The Web recognition state: preflight, the three input combinations, polling,
// candidates/fallback, follow-ups, cancellation, errors and the interrupted
// reference. The server and the shared matcher are mocked; the real component,
// its state machine and the store selectors are exercised.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const EXERCISE = { id: 'ex1', n: 'Bench Press', bp: 'chest', eq: 'barbell' }
const PROFILE = {
  id: 'default', source: 'default', provider: 'fixture', model: 'fixture',
  label: 'Fixture', capabilities: { text: true, image: true, tools: false }, version: 1, available: true,
}

const mocks = vi.hoisted(() => ({
  S: { gifSize: 'full', body: 'male', exerciseView: 'list' },
  CONFIG: { agent: { enabled: true } },
  PUBLIC_CONFIG: { agent: { enabled: true, exerciseSearchVersion: 'v1' } },
  USER: { id: 'u1' },
  navs: [],
  profiles: [],
  match: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  deleteSession: vi.fn(),
  listProfiles: vi.fn(),
  getPublicConfig: vi.fn(),
  runSeq: 0,
  runEvents: [],
  mediaEvents: [],
}))

vi.mock('../store/useStore.js', () => {
  const snap = () => ({ S: mocks.S, config: mocks.CONFIG, user: mocks.USER })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../lib/exercises.js', async importOriginal => ({
  ...(await importOriginal()),
  createWebAiSearch: () => ({ match: (...args) => mocks.match(...args) }),
}))
vi.mock('../agent/api.js', () => ({
  agentApi: {
    getPublicConfig: (...args) => mocks.getPublicConfig(...args),
    listProfiles: (...args) => mocks.listProfiles(...args),
    startRun: (...args) => mocks.startRun(...args),
    getRun: (...args) => mocks.getRun(...args),
    cancelRun: (...args) => mocks.cancelRun(...args),
    deleteSession: (...args) => mocks.deleteSession(...args),
  },
}))
// The diagnostics contract is replaced with an in-memory capture so the suite
// asserts exactly the events the component emits, with no console noise. The
// mock mirrors the module's own gating: no trace when the switch is off, no
// media line when the attempt id or switch is invalid, and only declared
// error codes pass through safeExerciseSearchError.
vi.mock('../../../api/agent-runtime/exercise-search-diagnostics.js', () => {
  const SAFE_ERROR_CODES = new Set([
    'invalid_request', 'scope_denied', 'profile_not_found', 'profile_capability_missing',
    'context_budget_exceeded', 'fact_missing', 'tool_not_allowed', 'tool_args_invalid',
    'tool_target_out_of_scope', 'tool_budget_exceeded', 'proposal_not_found', 'proposal_conflict',
    'proposal_consumed', 'run_not_found', 'run_terminal', 'run_cancelled', 'run_interrupted',
    'request_conflict', 'model_unavailable', 'model_timeout', 'model_response_too_large',
    'session_deleted', 'session_busy', 'session_conflict', 'turn_limit', 'memory_not_found',
    'agent_disabled', 'agent_config_disabled', 'agent_config_corrupt', 'agent_store_corrupt',
    'agent_media_invalid', 'agent_media_too_large', 'permission_denied', 'asset_missing',
  ])
  return {
    createExerciseSearchTrace: vi.fn(({ traceId, source, enabled }) => (enabled === true
      ? event => { mocks.runEvents.push({ traceId, source, ...event }) }
      : undefined)),
    logExerciseSearchMedia: vi.fn(({ mediaAttemptId, source, enabled, metrics }) => {
      if (enabled !== true) return
      mocks.mediaEvents.push({ mediaAttemptId, source, stage: 'media', ...(metrics || {}) })
    }),
    safeExerciseSearchError: vi.fn(code => (typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : 'unknown')),
  }
})

import ExerciseAiSearch, {
  AI_SEARCH_MAX_RUNS,
  dataUrlBytes,
  normalizeImageFile,
  readInterrupted,
} from './ExerciseAiSearch.jsx'

const mounted = []
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
async function tick(ms = 2000) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  await flush()
}
function setValue(element, value) {
  const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const byText = (host, text) => [...host.querySelectorAll('button')].find(node => node.textContent.trim() === text)
const byLabel = (host, label) => host.querySelector(`[aria-label="${label}"]`)

function render(props = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const ref = React.createRef()
  const all = {
    onExit: vi.fn(),
    onPick: vi.fn(),
    onFallbackPick: vi.fn(),
    ...props,
  }
  mounted.push(root)
  act(() => root.render(<ExerciseAiSearch ref={ref} {...all} />))
  return { host, root, ref, props: all }
}

async function pickImage(host, dataUrl = 'data:image/jpeg;base64,AAAA', which = 'gallery') {
  const input = host.querySelector(`input[data-ai-input="${which}"]`)
  const file = new File(['image'], 'photo.jpg', { type: 'image/jpeg' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
  return dataUrl
}

function completed(result = { structured: { candidates: [], fallback: { understanding: '像卧推' } } }) {
  return { runId: 'run', status: 'completed', profile: PROFILE, result }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  document.body.innerHTML = ''
  mocks.CONFIG = { agent: { enabled: true } }
  mocks.PUBLIC_CONFIG = { agent: { enabled: true, exerciseSearchVersion: 'v1' } }
  mocks.profiles = [PROFILE]
  mocks.runSeq = 0
  mocks.navs = []
  mocks.match.mockReset()
  mocks.match.mockReturnValue({
    items: [{ exerciseId: EXERCISE.id, name: EXERCISE.n, rationale: '胸部推举', level: 'high', exercise: EXERCISE }],
    fallback: { understanding: '像卧推，建议看胸部', bodyParts: ['chest'], equipment: ['barbell'] },
  })
  mocks.listProfiles.mockReset().mockImplementation(async () => ({ profiles: mocks.profiles }))
  mocks.getPublicConfig.mockReset().mockImplementation(async () => mocks.PUBLIC_CONFIG)
  mocks.startRun.mockReset().mockImplementation(async () => {
    mocks.runSeq += 1
    return { runId: `run${mocks.runSeq}`, status: 'accepted', profile: PROFILE }
  })
  mocks.getRun.mockReset().mockImplementation(async runId => ({ ...completed(), runId }))
  mocks.cancelRun.mockReset().mockResolvedValue({})
  mocks.deleteSession.mockReset().mockResolvedValue({})
  mocks.runEvents = []
  mocks.mediaEvents = []
})

afterEach(() => {
  act(() => { mounted.splice(0).forEach(root => root.unmount()) })
  vi.useRealTimers()
})

describe('ExerciseAiSearch image validation', () => {
  it('measures the decoded bytes of a data URL and rejects a non-image file', async () => {
    expect(dataUrlBytes('data:image/jpeg;base64,AAAA')).toBe(3)
    await expect(normalizeImageFile(new File(['x'], 'notes.txt', { type: 'text/plain' })))
      .rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('ExerciseAiSearch preflight and launcher', () => {
  it('shows the setup EmptyState instead of opening the sheet when no text profile exists', async () => {
    mocks.profiles = []
    const { host } = render()
    await flush()
    expect(host.textContent).toContain('AI 检索不可用')
    expect(host.textContent).not.toContain('使用 AI 模型识别，需联网')
    expect(byText(host, '去配置')).toBeTruthy()
  })

  it('does not render setup when the instance disabled the agent runtime', async () => {
    mocks.CONFIG = { agent: { enabled: false } }
    const { host } = render()
    await flush()
    expect(host.textContent).toContain('AI 检索在此实例上已停用')
    expect(byText(host, '去配置')).toBeUndefined()
  })

  it('disables the submit until text or an image, and replaces a second image', async () => {
    const { host, props } = render({ normalizeImage: async file => `data:image/jpeg;base64,${file.name}` })
    await flush()
    const submit = byText(host, 'AI 检索')
    expect(submit.disabled).toBe(true)
    expect(host.textContent).toContain('使用 AI 模型识别，需联网')

    await pickImage(host)
    expect(byText(host, 'AI 检索').disabled).toBe(false)
    expect(host.querySelector('.ai-attach img')).toBeTruthy()

    const second = host.querySelector('input[data-ai-input="gallery"]')
    const file = new File(['two'], 'second.jpg', { type: 'image/jpeg' })
    Object.defineProperty(second, 'files', { value: [file], configurable: true })
    await act(async () => {
      second.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(host.textContent).toContain('已替换为新的图片')
    expect(host.querySelector('.ai-attach img').getAttribute('src')).toContain('second.jpg')
    expect(props.onExit).not.toHaveBeenCalled()
  })
})

describe('ExerciseAiSearch runs', () => {
  it('refreshes the version for a newly reset session and keeps the task pinned across follow-ups', async () => {
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    mocks.PUBLIC_CONFIG = { agent: { enabled: true, exerciseSearchVersion: 'v2' } }
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    const first = mocks.startRun.mock.calls[0][0]
    expect(first.taskId).toBe('exercise-search.v2')
    expect(mocks.getPublicConfig).toHaveBeenCalledTimes(2) // preflight plus fresh session negotiation
    await tick()

    mocks.PUBLIC_CONFIG = { agent: { enabled: true, exerciseSearchVersion: 'v1' } }
    setValue(host.querySelector('.ai-follow input'), '换成哑铃')
    await act(async () => { host.querySelector('.ai-follow').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(mocks.startRun.mock.calls[1][0]).toMatchObject({ taskId: 'exercise-search.v2', sessionMode: 'continue', sessionId: first.sessionId })
    expect(mocks.getPublicConfig).toHaveBeenCalledTimes(2)
  })

  it('refreshes config again after restarting an expired session', async () => {
    mocks.startRun.mockRejectedValueOnce(Object.assign(new Error('expired'), { code: 'turn_limit' }))
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '第一轮')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    expect(mocks.startRun.mock.calls[0][0].taskId).toBe('exercise-search.v1')

    mocks.PUBLIC_CONFIG = { agent: { enabled: true, exerciseSearchVersion: 'v2' } }
    await act(async () => { byText(host, '重新发起').click() })
    setValue(host.querySelector('textarea'), '重开的新会话')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    expect(mocks.getPublicConfig).toHaveBeenCalledTimes(3)
    expect(mocks.startRun.mock.calls[1][0]).toMatchObject({ taskId: 'exercise-search.v2', sessionMode: 'new' })
  })

  it('sends a text-only run and renders candidates with a level badge', async () => {
    const { host, props } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()

    const body = mocks.startRun.mock.calls[0][0]
    expect(body).toMatchObject({
      taskId: 'exercise-search.v1',
      sessionMode: 'new',
      profileId: 'default',
      input: { hintText: '卧推' },
    })
    expect(body.requestId).toBeTruthy()
    expect(body.sessionId).toBeTruthy()
    expect(body.input.images).toBeUndefined()

    await tick()
    expect(mocks.getRun).toHaveBeenCalledWith('run1')
    expect(mocks.match).toHaveBeenCalled()
    expect(host.textContent).toContain('识别到的动作')
    expect(host.textContent).toContain(EXERCISE.n)
    expect(host.textContent).toContain('胸部推举')
    expect(host.textContent).toContain('高')
    expect(host.textContent).toContain('经 Fixture 检索')

    act(() => host.querySelector('.ai-candidate .tap-main').click())
    expect(props.onPick).toHaveBeenCalledWith(EXERCISE, undefined)
    expect(props.onExit).not.toHaveBeenCalled()
  })

  it('sends a pure-image run', async () => {
    const { host } = render({ normalizeImage: async () => 'data:image/jpeg;base64,IMAGE' })
    await flush()
    await pickImage(host)
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    const body = mocks.startRun.mock.calls[0][0]
    expect(body.input).toEqual({ images: ['data:image/jpeg;base64,IMAGE'] })
  })

  it('sends text and image together', async () => {
    const { host } = render({ normalizeImage: async () => 'data:image/jpeg;base64,IMAGE' })
    await flush()
    setValue(host.querySelector('textarea'), '这个器械')
    await pickImage(host)
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    expect(mocks.startRun.mock.calls[0][0].input).toEqual({
      hintText: '这个器械',
      images: ['data:image/jpeg;base64,IMAGE'],
    })
  })

  it('shows only the fallback channel when there are no candidates', async () => {
    mocks.match.mockReturnValue({ items: [], fallback: { understanding: '没找到，试试胸部', bodyParts: ['chest'] } })
    const { host, props } = render()
    await flush()
    setValue(host.querySelector('textarea'), '不认识')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    expect(host.textContent).toContain('没找到，试试胸部')
    expect(host.textContent).not.toContain('识别到的动作')
    expect(byText(host, '都不对？继续追问，或看看建议筛选')).toBeUndefined()
    act(() => [...host.querySelectorAll('.ai-fallback .chip')].find(b => b.textContent === 'chest').click())
    expect(props.onFallbackPick).toHaveBeenCalledWith('bodyPart', 'chest')
  })

  it('expands the fallback after candidates and applies a suggested chip', async () => {
    const { host, props } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    expect(host.textContent).not.toContain('像卧推，建议看胸部')
    act(() => byText(host, '都不对？继续追问，或看看建议筛选').click())
    expect(host.textContent).toContain('像卧推，建议看胸部')
    act(() => [...host.querySelectorAll('.ai-fallback .chip')].find(b => b.textContent === 'barbell').click())
    expect(props.onFallbackPick).toHaveBeenCalledWith('equipment', 'barbell')
  })

  it('continues the same session for a follow-up and replaces the candidates', async () => {
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    const first = mocks.startRun.mock.calls[0][0]

    setValue(host.querySelector('.ai-follow input'), '不是，是哑铃的')
    await act(async () => { host.querySelector('.ai-follow').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    const second = mocks.startRun.mock.calls[1][0]
    expect(second.sessionMode).toBe('continue')
    expect(second.sessionId).toBe(first.sessionId)
    expect(second.input.hintText).toBe('不是，是哑铃的')
    expect(second.requestId).not.toBe(first.requestId)
    await tick()
    expect(host.textContent).toContain('识别到的动作')
  })

  it('stops the follow-up input after five follow-ups (six runs)', async () => {
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '第一轮')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    for (let index = 1; index < AI_SEARCH_MAX_RUNS; index += 1) {
      setValue(host.querySelector('.ai-follow input'), `追问 ${index}`)
      await act(async () => { host.querySelector('.ai-follow').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
      await flush()
      await tick()
    }
    expect(mocks.startRun).toHaveBeenCalledTimes(AI_SEARCH_MAX_RUNS)
    expect(host.querySelector('.ai-follow input').disabled).toBe(true)
    expect(host.textContent).toContain('已达到追问上限')
  })
})

describe('ExerciseAiSearch errors and lifecycle', () => {
  it('maps a capability error for an image and keeps the panel open', async () => {
    mocks.profiles = [{ ...PROFILE, capabilities: { text: true, image: false, tools: false } }]
    const { host } = render({ normalizeImage: async () => 'data:image/jpeg;base64,IMAGE' })
    await flush()
    await pickImage(host)
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    expect(mocks.startRun).not.toHaveBeenCalled()
    expect(host.textContent).toContain('当前模型无法读取图片')
    expect(host.querySelector('textarea')).toBeTruthy()
  })

  it('shows the capability error when a follow-up sends an image to a text-only profile', async () => {
    mocks.profiles = [{ ...PROFILE, capabilities: { text: true, image: false, tools: false } }]
    const { host } = render({ normalizeImage: async () => 'data:image/jpeg;base64,IMAGE' })
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    await pickImage(host, undefined, 'follow')
    await act(async () => { host.querySelector('.ai-follow').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(mocks.startRun).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('当前模型无法读取图片')
  })

  it('shows a readable error and retries with a new request id', async () => {
    mocks.startRun.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'agent_media_invalid' }))
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    expect(host.textContent).toContain('图片格式无效或已损坏')
    const first = mocks.startRun.mock.calls[0][0]
    await act(async () => { byText(host, '重试').click() })
    await flush()
    const second = mocks.startRun.mock.calls[1][0]
    expect(second.requestId).not.toBe(first.requestId)
  })

  it('cancels and deletes the session on x, and clears the interrupted reference', async () => {
    const { host, props } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    const sessionId = mocks.startRun.mock.calls[0][0].sessionId
    expect(readInterrupted('u1')?.runId).toBe('run1')

    await tick()
    expect(readInterrupted('u1')).toBeNull()
    await act(async () => { byLabel(host, '退出 AI 检索').click() })
    await flush()
    expect(mocks.deleteSession).toHaveBeenCalledWith(sessionId)
    expect(props.onExit).toHaveBeenCalled()
    expect(readInterrupted('u1')).toBeNull()
  })

  it('cancels a running request when the sheet is reopened and starts a new run', async () => {
    const { host, ref } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await act(async () => { ref.current.reopen() })
    expect(mocks.cancelRun).toHaveBeenCalledWith('run1')
    expect(host.querySelector('textarea')).toBeTruthy()

    setValue(host.querySelector('textarea'), '第二个')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    expect(mocks.startRun).toHaveBeenCalledTimes(2)
    expect(mocks.startRun.mock.calls[1][0].input.hintText).toBe('第二个')
  })

  it('cancels on unmount while a run is flying', async () => {
    const { host, root } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    const sessionId = mocks.startRun.mock.calls[0][0].sessionId
    act(() => root.unmount())
    const at = mounted.indexOf(root)
    if (at >= 0) mounted.splice(at, 1)
    await flush()
    expect(mocks.cancelRun).toHaveBeenCalledWith('run1')
    expect(mocks.deleteSession).toHaveBeenCalledWith(sessionId)
  })

  it('keeps the old candidates clickable while a follow-up runs and restores them on cancel', async () => {
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    setValue(host.querySelector('.ai-follow input'), '再找找')
    await act(async () => { host.querySelector('.ai-follow').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(host.querySelector('.ai-candidate')).toBeTruthy()
    expect(host.querySelector('.ai-follow input').disabled).toBe(true)
    await act(async () => { byText(host, '取消').click() })
    await flush()
    expect(host.querySelector('.ai-follow input').disabled).toBe(false)
    expect(host.querySelector('.ai-follow input').value).toBe('再找找')
    expect(host.querySelector('.ai-candidate')).toBeTruthy()
  })

  it('uses the quick pick semantics when the picker passes a quick action', async () => {
    const { host, props } = render({ closeOnPick: true, quick: { icon: 'plus', label: ex => `Add ${ex.n}` } })
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    act(() => byLabel(host, 'Add Bench Press').click())
    expect(props.onPick).toHaveBeenCalledWith(EXERCISE, true)
    expect(props.onExit).toHaveBeenCalled()
  })
})

describe('ExerciseAiSearch diagnostics', () => {
  it('emits submit and one end on the same trace id and hands the matcher an emit bound to it', async () => {
    localStorage.setItem('opengym:ai-search-diagnostics', '1')
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()

    const traceId = mocks.startRun.mock.calls[0][0].requestId
    const submit = mocks.runEvents.find(event => event.stage === 'submit')
    expect(submit).toMatchObject({ traceId, source: 'web', execution: 'server', hasHint: true, imageCount: 0 })
    expect(submit.mediaAttemptId).toBeUndefined()
    const ends = mocks.runEvents.filter(event => event.stage === 'end')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ traceId, status: 'completed', phase: 'match' })
    expect(Number.isFinite(ends[0].elapsedMs)).toBe(true)

    const hints = mocks.match.mock.calls[0][1]
    expect(hints.hintText).toBe('卧推')
    expect(typeof hints.diagnostics?.emit).toBe('function')
    hints.diagnostics.emit({ stage: 'display', resultCount: 1 })
    const display = mocks.runEvents.find(event => event.stage === 'display')
    expect(display.traceId).toBe(traceId)
  })

  it('drops a late poll after a newer run instead of attributing it or ending the old trace twice', async () => {
    localStorage.setItem('opengym:ai-search-diagnostics', '1')
    let release = null
    mocks.getRun.mockReset()
    mocks.getRun.mockImplementation(() => {
      if (!release) return new Promise(resolve => { release = () => resolve(completed()) })
      return completed()
    })
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '第一次')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    await act(async () => { byText(host, '取消').click() })
    await flush()
    const firstTraceId = mocks.startRun.mock.calls[0][0].requestId
    expect(mocks.runEvents.filter(event => event.traceId === firstTraceId).map(event => event.stage))
      .toEqual(['submit', 'end'])
    expect(mocks.runEvents.find(event => event.traceId === firstTraceId && event.stage === 'end').status)
      .toBe('cancelled')

    setValue(host.querySelector('textarea'), '第二次')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    const secondTraceId = mocks.startRun.mock.calls[1][0].requestId
    expect(secondTraceId).not.toBe(firstTraceId)
    expect(mocks.runEvents.find(event => event.traceId === secondTraceId && event.stage === 'end').status)
      .toBe('completed')

    await act(async () => {
      release()
      await Promise.resolve()
      await Promise.resolve()
    })
    await flush()
    expect(mocks.runEvents.filter(event => event.traceId === firstTraceId).map(event => event.stage))
      .toEqual(['submit', 'end'])
    const firstEnds = mocks.runEvents.filter(event => event.traceId === firstTraceId && event.stage === 'end')
    expect(firstEnds).toHaveLength(1)
  })

  it('uses a different trace id per submission', async () => {
    localStorage.setItem('opengym:ai-search-diagnostics', '1')
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    setValue(host.querySelector('.ai-follow input'), '不是，是哑铃的')
    await act(async () => { host.querySelector('.ai-follow').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    await tick()

    const submits = mocks.runEvents.filter(event => event.stage === 'submit')
    expect(submits).toHaveLength(2)
    expect(submits[0].traceId).toBe(mocks.startRun.mock.calls[0][0].requestId)
    expect(submits[1].traceId).toBe(mocks.startRun.mock.calls[1][0].requestId)
    expect(submits[0].traceId).not.toBe(submits[1].traceId)
    const ends = mocks.runEvents.filter(event => event.stage === 'end')
    expect(ends.map(event => event.traceId)).toEqual([submits[0].traceId, submits[1].traceId])
  })

  it('emits nothing while the diagnostics switch is off', async () => {
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    expect(mocks.runEvents).toHaveLength(0)
    expect(mocks.mediaEvents).toHaveLength(0)
  })

  it('emits one media event per pick and carries its attempt id into the following submit', async () => {
    localStorage.setItem('opengym:ai-search-diagnostics', '1')
    const { host } = render({
      normalizeImage: async (file, onSummary) => {
        onSummary?.({ status: 'ready', width: 640, height: 480, bytes: 12345, attempts: 2 })
        return `data:image/jpeg;base64,${file.name}`
      },
    })
    await flush()
    await pickImage(host)
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()

    expect(mocks.mediaEvents).toHaveLength(1)
    const media = mocks.mediaEvents[0]
    expect(media).toMatchObject({ source: 'web', stage: 'media', status: 'ready', inputBytes: 5 })
    expect(media).toMatchObject({ outputBytes: 12345, outputWidth: 640, outputHeight: 480, attempts: 2 })
    expect(media.rotationApplied).toBeUndefined()
    expect(Number.isFinite(media.elapsedMs)).toBe(true)
    expect(media.mediaAttemptId).toMatch(/^mat_[0-9A-Za-z_-]{1,64}$/)

    const submit = mocks.runEvents.find(event => event.stage === 'submit')
    expect(submit).toMatchObject({ hasHint: false, imageCount: 1 })
    expect(submit.mediaAttemptId).toBe(media.mediaAttemptId)
  })

  it('keeps the image attempt id when a retry re-references the same image on a new trace', async () => {
    localStorage.setItem('opengym:ai-search-diagnostics', '1')
    mocks.startRun.mockReset()
    let failures = 0
    mocks.startRun.mockImplementation(async () => {
      if (!failures) {
        failures += 1
        throw Object.assign(new Error('bad'), { code: 'network' })
      }
      mocks.runSeq += 1
      return { runId: `run${mocks.runSeq}`, status: 'accepted', profile: PROFILE }
    })
    const { host } = render({ normalizeImage: async () => 'data:image/jpeg;base64,IMAGE' })
    await flush()
    await pickImage(host)
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    expect(host.textContent).toContain('网络连接失败')
    const first = mocks.runEvents.find(event => event.stage === 'submit')
    expect(first.mediaAttemptId).toBeTruthy()

    await act(async () => { byText(host, '重试').click() })
    await flush()
    const submits = mocks.runEvents.filter(event => event.stage === 'submit')
    expect(submits).toHaveLength(2)
    expect(submits[1].traceId).not.toBe(submits[0].traceId)
    expect(submits[1].mediaAttemptId).toBe(first.mediaAttemptId)
  })

  it('ends the original request trace at the submit phase when starting fails', async () => {
    localStorage.setItem('opengym:ai-search-diagnostics', '1')
    mocks.startRun.mockReset()
    mocks.startRun.mockImplementation(async () => {
      throw Object.assign(new Error('bad'), { code: 'network' })
    })
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    expect(host.textContent).toContain('网络连接失败')
    const end = mocks.runEvents.find(event => event.stage === 'end')
    expect(end).toMatchObject({ status: 'failed', phase: 'submit', errorCode: 'unknown' })
    expect(end.traceId).toBe(mocks.startRun.mock.calls[0][0].requestId)
  })

  it('ends with the run failure code when the server reports the run failed', async () => {
    localStorage.setItem('opengym:ai-search-diagnostics', '1')
    mocks.getRun.mockReset()
    mocks.getRun.mockResolvedValue({ runId: 'run1', status: 'failed', profile: PROFILE, error: { code: 'model_unavailable' } })
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '卧推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    const end = mocks.runEvents.find(event => event.stage === 'end')
    expect(end).toMatchObject({ status: 'failed', phase: 'model', errorCode: 'model_unavailable' })
    expect(end.traceId).toBe(mocks.startRun.mock.calls[0][0].requestId)
    expect(host.textContent).toContain('模型暂时不可用')
  })

  it('renders disambiguation chips when ambiguous and triggers a continue follow-up on click', async () => {
    mocks.match.mockReturnValue({
      items: [{ exerciseId: EXERCISE.id, name: '胸部推举', rationale: '推柄位置', level: 'medium', exercise: EXERCISE }],
      fallback: { understanding: '可能是推胸或推肩器械', bodyParts: ['chest'], equipment: ['leverage machine'] },
      clarifications: [
        { label: '往前推（练胸）', prompt: '这是往前推的坐姿推胸器械' },
        { label: '往上推（练肩）', prompt: '这是往上推的坐姿推肩器械' },
      ],
    })
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '这是啥器械')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()

    const box = host.querySelector('[data-ai-clarifications]')
    expect(box).toBeTruthy()
    expect(box.textContent).toContain('快速补充方向：')
    const chipButtons = [...box.querySelectorAll('button.chip')]
    expect(chipButtons.map(b => b.textContent)).toEqual(['往前推（练胸）', '往上推（练肩）'])

    // Second round clears clarifications after clicking a chip
    mocks.match.mockReturnValue({
      items: [{ exerciseId: EXERCISE.id, name: '胸部推举', rationale: '确认坐姿推胸', level: 'high', exercise: EXERCISE }],
      fallback: { understanding: '坐姿推胸', bodyParts: ['chest'], equipment: ['leverage machine'] },
      clarifications: [],
    })

    await act(async () => { chipButtons[0].click() })
    await flush()

    // While running, chips hide to prevent double-clicks
    expect(host.querySelector('[data-ai-clarifications]')).toBeNull()
    expect(mocks.startRun).toHaveBeenCalledTimes(2)
    const followCall = mocks.startRun.mock.calls[1][0]
    expect(followCall.sessionMode).toBe('continue')
    expect(followCall.sessionId).toBe(mocks.startRun.mock.calls[0][0].sessionId)
    expect(followCall.input.hintText).toBe('这是往前推的坐姿推胸器械')

    await tick()
    expect(host.querySelector('[data-ai-clarifications]')).toBeNull()
  })

  it('hides disambiguation chips once the follow-up turn limit is reached', async () => {
    mocks.match.mockReturnValue({
      items: [{ exerciseId: EXERCISE.id, name: '胸部推举', rationale: '推柄位置', level: 'medium', exercise: EXERCISE }],
      fallback: { understanding: '可能是推胸器械' },
      clarifications: [{ label: '往前推（练胸）', prompt: '这是往前推的坐姿推胸器械' }],
    })
    const { host } = render()
    await flush()
    setValue(host.querySelector('textarea'), '胸推')
    await act(async () => { byText(host, 'AI 检索').click() })
    await flush()
    await tick()
    expect(host.querySelector('[data-ai-clarifications]')).toBeTruthy()

    for (let i = 1; i < AI_SEARCH_MAX_RUNS; i++) {
      await act(async () => {
        host.querySelector('[data-ai-clarifications] button.chip').click()
      })
      await flush()
      await tick()
    }
    expect(host.querySelector('[data-ai-clarifications]')).toBeNull()
  })
})
