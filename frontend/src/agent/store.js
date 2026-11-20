// Agent page state. One store so the setup page and the run page share the
// profile list; polling is owned by the page and stopped on unmount.
import { create } from 'zustand'
import { agentApi } from './api.js'

let pollTimer = null

const errorText = error => (error && error.message) || 'The agent request failed.'

export const useAgent = create((set, get) => ({
  profiles: [],
  activeRun: null,
  sessions: [],
  memories: [],
  loading: false,
  error: null,

  async loadProfiles() {
    set({ loading: true, error: null })
    try {
      const data = await agentApi.listProfiles()
      set({ profiles: Array.isArray(data.profiles) ? data.profiles : [], loading: false })
      return data.profiles || []
    } catch (error) {
      set({ loading: false, error: errorText(error) })
      return []
    }
  },

  async loadSessions() {
    try {
      const data = await agentApi.listSessions()
      set({ sessions: Array.isArray(data.sessions) ? data.sessions : [] })
    } catch (error) {
      set({ error: errorText(error) })
    }
  },

  async loadMemories() {
    try {
      const data = await agentApi.listMemories()
      set({ memories: Array.isArray(data.memories) ? data.memories : [] })
    } catch (error) {
      set({ error: errorText(error) })
    }
  },

  setRun(run) {
    set({ activeRun: run || null })
  },

  async startRun(body) {
    set({ loading: true, error: null })
    try {
      const started = await agentApi.startRun(body)
      const run = await agentApi.getRun(started.runId)
      set({ activeRun: run, loading: false })
      return run
    } catch (error) {
      set({ loading: false, error: errorText(error) })
      return null
    }
  },

  async refreshRun(runId) {
    try {
      const run = await agentApi.getRun(runId)
      set({ activeRun: run })
      return run
    } catch (error) {
      set({ error: errorText(error) })
      return null
    }
  },

  async cancelRun(runId) {
    try {
      const run = await agentApi.cancelRun(runId)
      set({ activeRun: run })
      return run
    } catch (error) {
      set({ error: errorText(error) })
      return null
    }
  },

  startPolling(runId) {
    get().stopPolling()
    pollTimer = setInterval(() => {
      void get().refreshRun(runId)
    }, 1200)
  },

  stopPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  },

  async confirmProposal(id) {
    try {
      const result = await agentApi.confirmProposal(id)
      set({ error: null })
      return result
    } catch (error) {
      set({ error: errorText(error) })
      return null
    }
  },

  async rejectProposal(id) {
    try {
      const result = await agentApi.rejectProposal(id)
      set({ error: null })
      return result
    } catch (error) {
      set({ error: errorText(error) })
      return null
    }
  },

  async deleteMemory(id) {
    try {
      await agentApi.deleteMemory(id)
      await get().loadMemories()
    } catch (error) {
      set({ error: errorText(error) })
    }
  },

  async deleteSession(id) {
    try {
      await agentApi.deleteSession(id)
      await get().loadSessions()
    } catch (error) {
      set({ error: errorText(error) })
    }
  },

  clearError() {
    set({ error: null })
  },
}))
