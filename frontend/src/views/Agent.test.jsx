// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  navs: [], toast: vi.fn(), profiles: [], start: null,
  USER: { id: 'u1', name: 'Owner' },
  config: { agent: { enabled: true } },
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: mocks.USER, config: mocks.config })
  const useStore = selector => (selector ? selector(snap()) : snap())
  useStore.getState = snap
  return { useStore }
})
vi.mock('../store/useUI.js', () => {
  const snap = () => ({ toast: mocks.toast })
  const useUI = selector => (selector ? selector(snap()) : snap())
  useUI.getState = snap
  return { useUI }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => (...args) => mocks.navs.push(args) }))
vi.mock('../agent/api.js', () => ({
  agentApi: {
    listProfiles: vi.fn(async () => ({ profiles: mocks.profiles })),
    listSessions: vi.fn(async () => ({ sessions: [] })),
    listMemories: vi.fn(async () => ({ memories: [] })),
    startRun: vi.fn(async body => {
      mocks.start = body
      return { runId: 'run_1', status: 'accepted' }
    }),
    getRun: vi.fn(async () => ({
      runId: 'run_1', status: 'completed', result: { text: 'fixture answer' },
    })),
    cancelRun: vi.fn(async () => ({ runId: 'run_1', status: 'cancelled' })),
    confirmProposal: vi.fn(async () => ({ applied: true, result: { version: 2 } })),
    rejectProposal: vi.fn(async () => ({ status: 'rejected' })),
    getSession: vi.fn(async () => ({ messages: [] })),
    deleteSession: vi.fn(async () => ({ ok: true })),
    saveMemory: vi.fn(async () => ({ id: 'm1' })),
    deleteMemory: vi.fn(async () => ({ ok: true })),
  },
}))

import Agent from './Agent.jsx'
import { useAgent } from '../agent/store.js'
import { agentApi } from '../agent/api.js'

function button(host, text) {
  return [...host.querySelectorAll('button')].find(node => node.textContent === text)
}
async function flush() {
  await act(async () => { new Promise(resolve => setTimeout(resolve, 0)) })
}

function typeInto(element, value) {
  const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

let host
let root
beforeEach(() => {
  mocks.navs = []
  mocks.toast = vi.fn()
  mocks.start = null
  mocks.config = { agent: { enabled: true } }
  mocks.profiles = [{
    id: 'default', source: 'default', provider: 'fixture', model: 'fixture',
    capabilities: { text: true, image: true, tools: true }, version: 1, label: 'Instance default', available: true,
  }]
  useAgent.setState({ profiles: [], activeRun: null, sessions: [], memories: [], loading: false, error: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('Agent page', () => {
  it('starts a run and shows the server result', async () => {
    await act(async () => { root.render(<Agent />) })
    await flush()
    const prompt = host.querySelector('textarea')
    await act(async () => { typeInto(prompt, 'hello') })
    const start = button(host, 'Start run')
    expect(start).toBeTruthy()
    await act(async () => { start.click() })
    await flush()
    expect(mocks.start).toMatchObject({
      requestId: expect.stringMatching(/^[0-9a-f-]{8,}$/i),
      profileId: 'default',
      input: { prompt: 'hello' },
    })
    expect(host.textContent).toContain('fixture answer')
    expect(agentApi.getRun).toHaveBeenCalledWith('run_1')
  })

  it('cancels an open run', async () => {
    useAgent.setState({ activeRun: { runId: 'run_1', status: 'running' } })
    await act(async () => { root.render(<Agent />) })
    await flush()
    const cancel = button(host, 'Cancel')
    expect(cancel).toBeTruthy()
    await act(async () => { cancel.click() })
    await flush()
    expect(agentApi.cancelRun).toHaveBeenCalledWith('run_1')
    useAgent.getState().stopPolling()
  })

  it('confirms a stored proposal', async () => {
    useAgent.setState({
      activeRun: {
        runId: 'run_1', status: 'completed',
        result: { text: 'ready', proposal: { proposalId: 'prop_1', status: 'pending', changes: [{ field: 'value' }] } },
      },
    })
    await act(async () => { root.render(<Agent />) })
    await flush()
    const confirm = button(host, 'Confirm')
    expect(confirm).toBeTruthy()
    await act(async () => { confirm.click() })
    await flush()
    expect(agentApi.confirmProposal).toHaveBeenCalledWith('prop_1')
  })

  it('shows the disabled state from /api/config', async () => {
    mocks.config = { agent: { enabled: false } }
    await act(async () => { root.render(<Agent />) })
    await flush()
    expect(host.textContent).toContain('The agent runtime is disabled')
  })
})
