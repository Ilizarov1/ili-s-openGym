// The Web client's agent API surface: same-origin cookies, stable error codes.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ api: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: mocks.api }))

import { agentApi } from './api.js'

const failure = (status, code, message = 'failed') => {
  const error = Object.assign(new Error(message), { status, data: code ? { code } : {} })
  return error
}

beforeEach(() => {
  mocks.api.mockReset()
})

describe('agent API', () => {
  it('starts a run with the idempotency key and task id left to the server default', async () => {
    mocks.api.mockResolvedValue({ runId: 'run_1', status: 'accepted' })
    const answer = await agentApi.startRun({ requestId: 'req_12345678', profileId: 'default', input: { prompt: 'hi' } })
    expect(answer.runId).toBe('run_1')
    expect(mocks.api).toHaveBeenCalledWith('/api/agent/runs', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'req_12345678', profileId: 'default', input: { prompt: 'hi' } }),
    })
  })

  it('maps a server conflict code without losing the message', async () => {
    mocks.api.mockRejectedValue(failure(409, 'proposal_conflict', 'target changed'))
    await expect(agentApi.confirmProposal('prop_1')).rejects.toMatchObject({
      status: 409,
      code: 'proposal_conflict',
      message: 'target changed',
    })
  })

  it('maps 401 and 503 to stable codes', async () => {
    mocks.api.mockRejectedValueOnce(failure(401))
    await expect(agentApi.listProfiles()).rejects.toMatchObject({ status: 401, code: 'http' })
    mocks.api.mockRejectedValueOnce(failure(503, 'agent_disabled'))
    await expect(agentApi.listMemories()).rejects.toMatchObject({ status: 503, code: 'agent_disabled' })
  })

  it('encodes ids in paths and uses DELETE/PATCH', async () => {
    mocks.api.mockResolvedValue({ ok: true })
    await agentApi.deleteMemory('mem/a b')
    expect(mocks.api).toHaveBeenCalledWith('/api/agent/memories/mem%2Fa%20b', { method: 'DELETE' })
    await agentApi.updateProfile('profile_1', { model: 'gpt' })
    expect(mocks.api).toHaveBeenCalledWith('/api/agent/configs/profile_1', {
      method: 'PATCH',
      body: JSON.stringify({ model: 'gpt' }),
    })
    await agentApi.updateMemory('mem_1', { value: 'new' })
    expect(mocks.api).toHaveBeenCalledWith('/api/agent/memories/mem_1', {
      method: 'PATCH',
      body: JSON.stringify({ value: 'new' }),
    })
  })

  it('lists sessions and memories by their arrays', async () => {
    mocks.api.mockResolvedValueOnce({ sessions: [{ id: 's1' }] })
    await expect(agentApi.listSessions()).resolves.toEqual({ sessions: [{ id: 's1' }] })
    mocks.api.mockResolvedValueOnce({ memories: [{ id: 'm1' }] })
    await expect(agentApi.listMemories()).resolves.toEqual({ memories: [{ id: 'm1' }] })
  })
})
