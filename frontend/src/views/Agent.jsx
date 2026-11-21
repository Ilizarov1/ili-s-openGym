import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { useAgent } from '../agent/store.js'
import { agentApi } from '../agent/api.js'
import Icon from '../components/Icon.jsx'
import '../agent/agent.css'

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const CATEGORIES = ['preference', 'goal', 'constraint', 'note']

const statusLabel = status => ({
  accepted: t('Queued'),
  running: t('Running'),
  completed: t('Completed'),
  failed: t('Failed'),
  cancelled: t('Cancelled'),
  interrupted: t('Interrupted'),
}[status] || status)

export default function Agent() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const toast = useUI(s => s.toast)
  const profiles = useAgent(s => s.profiles)
  const activeRun = useAgent(s => s.activeRun)
  const sessions = useAgent(s => s.sessions)
  const memories = useAgent(s => s.memories)
  const loading = useAgent(s => s.loading)
  const error = useAgent(s => s.error)
  const loadProfiles = useAgent(s => s.loadProfiles)
  const loadSessions = useAgent(s => s.loadSessions)
  const loadMemories = useAgent(s => s.loadMemories)
  const startRun = useAgent(s => s.startRun)
  const cancelRun = useAgent(s => s.cancelRun)
  const startPolling = useAgent(s => s.startPolling)
  const stopPolling = useAgent(s => s.stopPolling)
  const confirmProposal = useAgent(s => s.confirmProposal)
  const rejectProposal = useAgent(s => s.rejectProposal)
  const deleteMemory = useAgent(s => s.deleteMemory)
  const deleteSession = useAgent(s => s.deleteSession)
  const clearError = useAgent(s => s.clearError)

  const [prompt, setPrompt] = useState('')
  const [profileId, setProfileId] = useState('')
  const [sessionId, setSessionId] = useState(() => `ses_${globalThis.crypto?.randomUUID?.() || Date.now()}`)
  const [lastBody, setLastBody] = useState(null)
  const [confirmResult, setConfirmResult] = useState(null)
  const [handledProposal, setHandledProposal] = useState(null)
  const [memoryCategory, setMemoryCategory] = useState('preference')
  const [memoryValue, setMemoryValue] = useState('')
  const requestRef = useRef({ prompt: '', id: '' })
  const enabled = config?.agent?.enabled !== false

  const newRequestId = () => globalThis.crypto?.randomUUID?.() || `req_${Date.now()}_${Math.random().toString(36).slice(2)}`

  useEffect(() => {
    if (!user) return
    void loadProfiles()
    void loadSessions()
    void loadMemories()
  }, [user, loadProfiles, loadSessions, loadMemories])

  useEffect(() => {
    if (!profiles.length) return
    if (!profileId || !profiles.some(profile => profile.id === profileId && profile.available)) {
      const first = profiles.find(profile => profile.available)
      if (first) setProfileId(first.id)
    }
  }, [profiles, profileId])

  const runId = activeRun?.runId
  const runStatus = activeRun?.status
  useEffect(() => {
    if (!runId || TERMINAL.has(runStatus)) {
      stopPolling()
      return undefined
    }
    startPolling(runId)
    return () => stopPolling()
  }, [runId, runStatus, startPolling, stopPolling])

  useEffect(() => {
    if (runStatus === 'completed') void loadSessions()
  }, [runStatus, loadSessions])

  // A terminal run closes the idempotency window: resubmitting the same text
  // is a new task and must reach the server with a new request id. While a
  // submission is still open (or its response was lost), the id is reused so
  // the server deduplicates instead of running the model twice.
  useEffect(() => {
    if (runStatus && TERMINAL.has(runStatus)) requestRef.current = { prompt: '', id: '' }
  }, [runStatus])

  if (!user) return null

  const submit = async (body) => {
    clearError()
    setConfirmResult(null)
    const run = await startRun(body)
    if (run) void loadSessions()
  }

  const onRun = async () => {
    const text = prompt.trim()
    if (!text || !profileId) return
    let id = requestRef.current.prompt === text ? requestRef.current.id : ''
    if (!id) {
      id = newRequestId()
      requestRef.current = { prompt: text, id }
    }
    const body = { requestId: id, profileId, sessionId, input: { prompt: text } }
    setLastBody(body)
    await submit(body)
  }

  const onRetry = () => {
    if (!lastBody) return
    // An explicit retry of a failed or cancelled run is a new attempt, so it
    // needs a new request id; the server would otherwise return the old job.
    const id = newRequestId()
    requestRef.current = { prompt: lastBody.input.prompt, id }
    void submit({ ...lastBody, requestId: id })
  }

  const canRun = enabled && !!profileId && !!prompt.trim() && !loading
  const proposal = activeRun?.result?.proposal || activeRun?.result?.structured?.proposal || null
  const resultText = activeRun?.result?.text
    || (activeRun?.result?.structured ? JSON.stringify(activeRun.result.structured, null, 2) : '')

  return <div className="agent-page">
    <div className="agent-head">
      <div>
        <h1>{t('AI Agent')}</h1>
        <p>{t('Run a server-side task with your own model configuration.')}</p>
      </div>
      <div className="agent-actions">
        <button type="button" className="btn" onClick={() => nav('/settings')}>{t('Back to settings')}</button>
        <button type="button" className="btn tinted" onClick={() => nav('/agent/setup')}>{t('Model configurations')}</button>
      </div>
    </div>

    {!enabled ? <div className="agent-card"><p className="agent-note">{t('The agent runtime is disabled on this instance.')}</p></div> : null}
    {error ? <div className="agent-card"><p className="agent-error">{error}</p><button type="button" className="btn xs" onClick={clearError}>{t('Dismiss')}</button></div> : null}

    <div className="agent-grid">
      <div className="agent-main">
        <section className="agent-card">
          <h2>{t('New run')}</h2>
          <div className="agent-field">
            <label htmlFor="agent-profile">{t('Model configuration')}</label>
            <select id="agent-profile" className="agent-select" value={profileId} onChange={event => setProfileId(event.target.value)} disabled={!enabled}>
              {profiles.length ? profiles.map(profile => <option key={profile.id} value={profile.id} disabled={!profile.available}>{profile.label} · {profile.provider}{profile.model ? ` · ${profile.model}` : ''}{!profile.available && profile.reason ? ` (${profile.reason})` : ''}</option>) : <option value="">{t('No configuration')}</option>}
            </select>
          </div>
          <textarea className="agent-textarea" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t('Ask the agent, or describe a change to prepare.')} disabled={!enabled} />
          <div className="agent-actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn tinted" onClick={onRun} disabled={!canRun}>{loading ? t('Starting…') : t('Start run')}</button>
            <button type="button" className="btn" onClick={() => { setSessionId(`ses_${globalThis.crypto?.randomUUID?.() || Date.now()}`); setConfirmResult(null); requestRef.current = { prompt: '', id: '' } }}>{t('New conversation')}</button>
            {activeRun && !TERMINAL.has(activeRun.status) ? <button type="button" className="btn" onClick={() => { void cancelRun(activeRun.runId) }}>{t('Cancel')}</button> : null}
            {lastBody && activeRun && TERMINAL.has(activeRun.status) && activeRun.status !== 'completed' ? <button type="button" className="btn" onClick={onRetry}>{t('Retry')}</button> : null}
          </div>
          {!profiles.some(profile => profile.available) ? <p className="agent-note" style={{ marginTop: 10 }}>{t('Add a model configuration before starting a run.')} <button type="button" className="btn xs tinted" onClick={() => nav('/agent/setup')}>{t('Open setup')}</button></p> : null}
        </section>

        {activeRun ? <section className="agent-card">
          <div className="agent-row">
            <div className="agent-row-main">
              <h2>{t('Run')}</h2>
              <div className="agent-row-sub">{activeRun.runId}</div>
            </div>
            <span className={`agent-status ${activeRun.status}`}>{statusLabel(activeRun.status)}</span>
          </div>
          {resultText ? <pre className="agent-result">{resultText}</pre> : null}
          {activeRun.error ? <p className="agent-error">{activeRun.error.code}: {activeRun.error.message}</p> : null}
          {proposal ? <div style={{ marginTop: 12 }}>
            <h3>{t('Proposed change')}</h3>
            <ul className="agent-changes">
              {(proposal.changes || []).map((change, index) => <li key={index}><code>{JSON.stringify(change)}</code></li>)}
            </ul>
            <div className="agent-actions">
              <button type="button" className="btn tinted" disabled={proposal.status !== 'pending' || handledProposal?.id === proposal.proposalId} onClick={async () => {
                const answer = await confirmProposal(proposal.proposalId)
                if (answer) {
                  setConfirmResult(answer)
                  setHandledProposal({ id: proposal.proposalId, status: 'consumed' })
                  toast(t('Change applied'))
                }
              }}>{handledProposal?.id === proposal.proposalId ? t('Applied') : t('Confirm')}</button>
              <button type="button" className="btn" disabled={proposal.status !== 'pending' || handledProposal?.id === proposal.proposalId} onClick={async () => {
                const answer = await rejectProposal(proposal.proposalId)
                if (answer) {
                  setHandledProposal({ id: proposal.proposalId, status: 'rejected' })
                  toast(t('Proposal rejected'))
                }
              }}>{t('Reject')}</button>
            </div>
            {confirmResult ? <pre className="agent-pre">{JSON.stringify(confirmResult, null, 2)}</pre> : null}
          </div> : null}
        </section> : null}

        <section className="agent-card">
          <h2>{t('Conversations')}</h2>
          {sessions.length ? sessions.map(session => <div className="agent-row" key={session.id}>
            <div className="agent-row-main">
              <div className="agent-row-title">{session.title || session.id}</div>
              <div className="agent-row-sub">{t('{0} messages', session.messageCount)} · {new Date(session.updatedAt).toLocaleString()}</div>
            </div>
            <button type="button" className="btn xs" onClick={async () => {
              const detail = await agentApi.getSession(session.id)
              setSessionId(session.id)
              setPrompt((detail.messages || []).map(message => `${message.role}: ${message.content}`).join('\n') || '')
            }}>{t('Load')}</button>
            <button type="button" className="btn xs" onClick={() => { void deleteSession(session.id) }}>{t('Delete')}</button>
          </div>) : <p className="agent-note">{t('No conversations yet.')}</p>}
        </section>
      </div>

      <aside className="agent-side">
        <section className="agent-card">
          <h2>{t('Memories')}</h2>
          <p className="agent-note">{t('Only memories you confirm are sent to the model.')}</p>
          <div className="agent-field">
            <label htmlFor="agent-memory-category">{t('Category')}</label>
            <select id="agent-memory-category" className="agent-select" value={memoryCategory} onChange={event => setMemoryCategory(event.target.value)}>
              {CATEGORIES.map(category => <option key={category} value={category}>{t(category)}</option>)}
            </select>
          </div>
          <div className="agent-field">
            <label htmlFor="agent-memory-value">{t('Value')}</label>
            <input id="agent-memory-value" value={memoryValue} onChange={event => setMemoryValue(event.target.value)} placeholder={t('e.g. I train in the morning')} />
          </div>
          <button type="button" className="btn tinted sm" disabled={!memoryValue.trim()} onClick={async () => {
            try {
              await agentApi.saveMemory({ category: memoryCategory, value: memoryValue.trim(), source: 'user' })
              setMemoryValue('')
              await loadMemories()
            } catch (failure) {
              toast(failure.message || t('Could not save'))
            }
          }}>{t('Save memory')}</button>
          {memories.length ? memories.map(memory => <div className="agent-row" key={memory.id}>
            <div className="agent-row-main">
              <div className="agent-row-title">{t(memory.category)}</div>
              <div className="agent-row-sub">{typeof memory.value === 'string' ? memory.value : JSON.stringify(memory.value)}</div>
            </div>
            <button type="button" className="btn xs" onClick={() => { void deleteMemory(memory.id) }}>{t('Delete')}</button>
          </div>) : <p className="agent-note" style={{ marginTop: 10 }}>{t('No memories saved.')}</p>}
        </section>
        <section className="agent-card">
          <h2>{t('How it runs')}</h2>
          <p className="agent-note">{t('Web uses the server execution only. The model receives the task instructions, your input, the facts the task declares and the memories you confirmed.')}</p>
          <p className="agent-note" style={{ marginTop: 8 }}><Icon name="lock" /> {t('Credentials stay on the server and are never shown again.')}</p>
        </section>
      </aside>
    </div>
  </div>
}
