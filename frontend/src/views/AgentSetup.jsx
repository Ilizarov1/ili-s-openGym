import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { useAgent } from '../agent/store.js'
import { agentApi } from '../agent/api.js'
import '../agent/agent.css'

const PROVIDERS = ['fixture', 'openai', 'deepseek']

export default function AgentSetup() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  const toast = useUI(s => s.toast)
  const profiles = useAgent(s => s.profiles)
  const loadProfiles = useAgent(s => s.loadProfiles)
  const loading = useAgent(s => s.loading)
  const error = useAgent(s => s.error)
  const ensureOwner = useAgent(s => s.ensureOwner)
  const ownerId = useAgent(s => s.ownerId)
  const [editing, setEditing] = useState(null)
  const [provider, setProvider] = useState('openai')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [imageCapable, setImageCapable] = useState(false)
  const [busy, setBusy] = useState(false)
  const enabled = config?.agent?.enabled !== false
  const requiresKey = provider !== 'fixture' && (!editing || provider !== editing.provider)

  useEffect(() => {
    if (!user) return
    ensureOwner(user.id)
  }, [user, ensureOwner])

  useEffect(() => {
    if (user) void loadProfiles()
  }, [user, loadProfiles])

  if (!user) return null
  if (ownerId !== user.id) {
    return <div className="agent-page"><p className="agent-note">{t('Loading…')}</p></div>
  }

  const reset = () => {
    setEditing(null)
    setProvider('openai')
    setModel('')
    setApiKey('')
    setImageCapable(false)
  }

  const beginEdit = profile => {
    setEditing(profile)
    const supported = PROVIDERS.includes(profile.provider)
    setProvider(supported ? profile.provider : 'deepseek')
    setModel(supported ? profile.model || '' : 'deepseek-flash')
    setApiKey('')
    setImageCapable(supported ? profile.capabilities?.image === true : true)
  }

  const save = async event => {
    event.preventDefault()
    setBusy(true)
    try {
      if (editing) {
        await agentApi.updateProfile(editing.id, {
          provider,
          model: model.trim(),
          capabilities: { image: imageCapable },
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        })
        toast(t('Configuration updated'))
      } else {
        await agentApi.createProfile({
          provider,
          model: model.trim(),
          capabilities: { image: imageCapable },
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        })
        toast(t('Configuration saved'))
      }
      reset()
      await loadProfiles()
    } catch (failure) {
      toast(failure.message || t('Could not save'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async profile => {
    if (!globalThis.confirm?.(t('Delete this configuration?'))) return
    try {
      await agentApi.deleteProfile(profile.id)
      await loadProfiles()
      if (editing?.id === profile.id) reset()
      toast(t('Configuration deleted'))
    } catch (failure) {
      toast(failure.message || t('Could not delete'))
    }
  }

  return <div className="agent-page">
    <div className="agent-head">
      <div>
        <h1>{t('Agent model configurations')}</h1>
        <p>{t('The instance default is read-only. Add your own key for server execution.')}</p>
      </div>
      <button type="button" className="btn" onClick={() => nav('/agent')}>{t('Back to the agent')}</button>
    </div>

    {!enabled ? <div className="agent-card"><p className="agent-note">{t('The agent runtime is disabled on this instance.')}</p></div> : null}
    {error ? <div className="agent-card"><p className="agent-error">{error}</p></div> : null}

    <div className="agent-grid">
      <div className="agent-main">
        <section className="agent-card">
          <h2>{t('Available configurations')}</h2>
          {loading ? <p className="agent-note">{t('Loading…')}</p> : null}
          {profiles.length ? profiles.map(profile => <div className="agent-row" key={profile.id}>
            <div className="agent-row-main">
              <div className="agent-row-title">{profile.label} <span className="agent-status">{profile.source === 'default' ? t('Instance') : t('Yours')}</span></div>
              <div className="agent-row-sub">
                {profile.provider}{profile.model ? ` · ${profile.model}` : ''}
                {profile.keyHint ? ` · ••••${profile.keyHint}` : ''}
                {profile.available ? '' : ` · ${profile.reason || t('Unavailable')}`}
              </div>
              <div className="agent-row-sub">
                {profile.capabilities?.text ? t('Text') : null}
                {profile.capabilities?.image ? ` · ${t('Images')}` : null}
                {profile.capabilities?.tools ? ` · ${t('Tools')}` : null}
              </div>
            </div>
            {profile.source === 'default' ? <span className="agent-note">{t('Read-only')}</span> : <div className="agent-actions">
              <button type="button" className="btn xs" onClick={() => beginEdit(profile)}>{t('Edit')}</button>
              <button type="button" className="btn xs" onClick={() => { void remove(profile) }}>{t('Delete')}</button>
            </div>}
          </div>) : <p className="agent-note">{t('No configurations found.')}</p>}
        </section>
      </div>

      <aside className="agent-side">
        <form className="agent-card" onSubmit={save}>
          <h2>{editing ? t('Edit configuration') : t('Add a configuration')}</h2>
          <div className="agent-field">
            <label htmlFor="agent-provider">{t('Provider')}</label>
            <select id="agent-provider" className="agent-select" value={provider} onChange={event => { setProvider(event.target.value); setApiKey('') }}>
              {PROVIDERS.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
          <div className="agent-field">
            <label htmlFor="agent-model">{t('Model')}</label>
            <input id="agent-model" value={model} onChange={event => setModel(event.target.value)} placeholder={provider === 'fixture' ? 'fixture' : provider === 'deepseek' ? 'deepseek-flash' : 'gpt-5.6'} required />
          </div>
          {provider !== 'fixture' ? <div className="agent-field">
            <label htmlFor="agent-key">{editing && !requiresKey ? t('Replace API key (leave blank to keep it)') : t('API key')}</label>
            <input id="agent-key" type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" required={requiresKey} />
          </div> : null}
          <div className="agent-field">
            <label htmlFor="agent-image" style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--label)', fontSize: '14.5px' }}>
              <input id="agent-image" type="checkbox" checked={imageCapable} onChange={event => setImageCapable(event.target.checked)} />
              {t('该模型可读取图片')}
            </label>
            <p className="agent-note">{t('勾选后，这份配置会声明可以读取图片；不勾选则按仅文本处理。')}</p>
          </div>
          <p className="agent-note">{t('The key is encrypted on the server and only its last four characters are shown again.')}</p>
          <div className="agent-actions" style={{ marginTop: 12 }}>
            <button type="submit" className="btn tinted" disabled={busy || !model.trim() || (requiresKey && apiKey.trim().length < 8)}>{busy ? t('Saving…') : t('Save')}</button>
            {editing ? <button type="button" className="btn" onClick={reset}>{t('Cancel')}</button> : null}
          </div>
        </form>
      </aside>
    </div>
  </div>
}
