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
  USER: { id: 'u1' },
  navs: [],
  profiles: [],
  match: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  cancelRun: vi.fn(),
  deleteSession: vi.fn(),
  listProfiles: vi.fn(),
  runSeq: 0,
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
    listProfiles: (...args) => mocks.listProfiles(...args),
    startRun: (...args) => mocks.startRun(...args),
    getRun: (...args) => mocks.getRun(...args),
    cancelRun: (...args) => mocks.cancelRun(...args),
    deleteSession: (...args) => mocks.deleteSession(...args),
  },
}))

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
  mocks.profiles = [PROFILE]
  mocks.runSeq = 0
  mocks.navs = []
  mocks.match.mockReset()
  mocks.match.mockReturnValue({
    items: [{ exerciseId: EXERCISE.id, name: EXERCISE.n, rationale: '胸部推举', level: 'high', exercise: EXERCISE }],
    fallback: { understanding: '像卧推，建议看胸部', bodyParts: ['chest'], equipment: ['barbell'] },
  })
  mocks.listProfiles.mockReset().mockImplementation(async () => ({ profiles: mocks.profiles }))
  mocks.startRun.mockReset().mockImplementation(async () => {
    mocks.runSeq += 1
    return { runId: `run${mocks.runSeq}`, status: 'accepted', profile: PROFILE }
  })
  mocks.getRun.mockReset().mockImplementation(async runId => ({ ...completed(), runId }))
  mocks.cancelRun.mockReset().mockResolvedValue({})
  mocks.deleteSession.mockReset().mockResolvedValue({})
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
