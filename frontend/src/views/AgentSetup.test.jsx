// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  navs: [], toast: vi.fn(), profiles: [],
  USER: { id: 'u1', name: 'Owner' },
  CONFIG: { agent: { enabled: true } },
}))
vi.mock('../store/useStore.js', () => {
  const snap = () => ({ user: mocks.USER, config: mocks.CONFIG })
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
    createProfile: vi.fn(async body => ({ id: 'new', ...body, source: 'user', available: true })),
    updateProfile: vi.fn(async (id, body) => ({ id, ...body, source: 'user', available: true })),
    deleteProfile: vi.fn(async () => ({ ok: true })),
  },
}))

import AgentSetup from './AgentSetup.jsx'
import { useAgent } from '../agent/store.js'

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
  mocks.CONFIG = { agent: { enabled: true } }
  mocks.profiles = [
    {
      id: 'default', source: 'default', provider: 'fixture', model: 'fixture',
      capabilities: { text: true, image: true, tools: true }, version: 1, label: 'Instance default', available: true,
    },
    {
      id: 'profile_1', source: 'user', provider: 'openai', model: 'gpt-test',
      capabilities: { text: true, image: true, tools: true }, keyHint: '1234', version: 2, label: 'OpenAI', available: true,
    },
  ]
  useAgent.setState({ ownerId: mocks.USER.id, profiles: [], loading: false, error: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('AgentSetup', () => {
  it('shows the read-only default and never echoes a saved key', async () => {
    await act(async () => { root.render(<AgentSetup />) })
    await flush()
    expect(host.textContent).toContain('Instance default')
    expect(host.textContent).toContain('••••1234')

    const edit = button(host, 'Edit')
    expect(edit).toBeTruthy()
    await act(async () => { edit.click() })
    const key = host.querySelector('#agent-key')
    expect(key).toBeTruthy()
    expect(key.value).toBe('')
  })

  it('deletes a user configuration after confirmation', async () => {
    const confirm = vi.fn(() => true)
    globalThis.confirm = confirm
    await act(async () => { root.render(<AgentSetup />) })
    await flush()
    const remove = button(host, 'Delete')
    await act(async () => { remove.click() })
    await flush()
    const { agentApi } = await import('../agent/api.js')
    expect(agentApi.deleteProfile).toHaveBeenCalledWith('profile_1')
  })

  it('creates an OpenAI profile with the key and model', async () => {
    await act(async () => { root.render(<AgentSetup />) })
    await flush()
    const model = host.querySelector('#agent-model')
    const key = host.querySelector('#agent-key')
    await act(async () => {
      typeInto(model, 'gpt-new')
      typeInto(key, 'sk-new-1234')
    })
    const form = host.querySelector('form')
    await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    const { agentApi } = await import('../agent/api.js')
    expect(agentApi.createProfile).toHaveBeenCalledWith({
      provider: 'openai',
      model: 'gpt-new',
      capabilities: { image: false },
      apiKey: 'sk-new-1234',
    })
  })

  it('writes the image capability on create and edits it back from the profile', async () => {
    await act(async () => { root.render(<AgentSetup />) })
    await flush()
    await act(async () => {
      typeInto(host.querySelector('#agent-model'), 'gpt-vision')
      typeInto(host.querySelector('#agent-key'), 'sk-vision-1234')
    })
    const image = host.querySelector('#agent-image')
    expect(image.checked).toBe(false)
    await act(async () => { image.click() })
    await act(async () => { host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    const { agentApi } = await import('../agent/api.js')
    expect(agentApi.createProfile).toHaveBeenLastCalledWith({
      provider: 'openai',
      model: 'gpt-vision',
      capabilities: { image: true },
      apiKey: 'sk-vision-1234',
    })

    mocks.profiles = [{
      id: 'vision', source: 'user', provider: 'openai', model: 'gpt-vision',
      capabilities: { text: true, image: true, tools: false }, keyHint: '1234', version: 1, label: 'OpenAI', available: true,
    }]
    await act(async () => { await useAgent.getState().loadProfiles() })
    await act(async () => { button(host, 'Edit').click() })
    const imageEdit = host.querySelector('#agent-image')
    expect(imageEdit.checked).toBe(true)
    await act(async () => { imageEdit.click() })
    await act(async () => { host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()
    expect(agentApi.updateProfile).toHaveBeenLastCalledWith('vision', {
      provider: 'openai',
      model: 'gpt-vision',
      capabilities: { image: false },
    })
  })

  it('offers DeepSeek and requires a key for it', async () => {
    await act(async () => { root.render(<AgentSetup />) })
    await flush()
    const select = host.querySelector('#agent-provider')
    expect([...select.options].map(option => option.value)).toEqual(['fixture', 'openai', 'deepseek'])
    await act(async () => {
      select.value = 'deepseek'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      typeInto(host.querySelector('#agent-model'), 'deepseek-flash')
    })
    expect(host.querySelector('#agent-key')).toBeTruthy()
    const save = button(host, 'Save')
    expect(save.disabled).toBe(true)
  })

  it('shows the disabled state from /api/config', async () => {
    mocks.CONFIG = { agent: { enabled: false } }
    await act(async () => { root.render(<AgentSetup />) })
    await flush()
    expect(host.textContent).toContain('The agent runtime is disabled')
  })
})

