// Server agent API. Web has no local execution in the first version: every
// call goes to /api/agent and uses the normal session or Bearer auth.
import { api } from '../lib/api.js'

const request = async (path, options) => {
  try {
    return await api(path, options)
  } catch (error) {
    if (error && error.data && error.data.code) error.code = error.data.code
    else if (error && !error.code) error.code = 'http'
    throw error
  }
}

const post = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body || {}) })
const patch = (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body || {}) })
const remove = path => request(path, { method: 'DELETE' })

export const agentApi = {
  listProfiles: () => request('/api/agent/configs'),
  createProfile: body => post('/api/agent/configs', body),
  updateProfile: (id, body) => patch(`/api/agent/configs/${encodeURIComponent(id)}`, body),
  deleteProfile: id => remove(`/api/agent/configs/${encodeURIComponent(id)}`),
  startRun: body => post('/api/agent/runs', body),
  getRun: id => request(`/api/agent/runs/${encodeURIComponent(id)}`),
  cancelRun: id => post(`/api/agent/runs/${encodeURIComponent(id)}/cancel`),
  listSessions: () => request('/api/agent/sessions'),
  getSession: id => request(`/api/agent/sessions/${encodeURIComponent(id)}`),
  deleteSession: id => remove(`/api/agent/sessions/${encodeURIComponent(id)}`),
  listMemories: () => request('/api/agent/memories'),
  saveMemory: body => post('/api/agent/memories', body),
  updateMemory: (id, body) => patch(`/api/agent/memories/${encodeURIComponent(id)}`, body),
  deleteMemory: id => remove(`/api/agent/memories/${encodeURIComponent(id)}`),
  confirmProposal: id => post(`/api/agent/proposals/${encodeURIComponent(id)}/confirm`),
  rejectProposal: id => post(`/api/agent/proposals/${encodeURIComponent(id)}/reject`),
}

export default agentApi
