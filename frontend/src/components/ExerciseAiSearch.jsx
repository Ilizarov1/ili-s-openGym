// AI exercise search: the shared Web recognition state for the Library and the
// exercise picker. The sheet-like launcher, the summary card, candidates, the
// fallback channel and the follow-up row all live here so both entry points
// behave the same way. Web is server-execution only: every run goes through
// `agentApi` with `taskId: exercise-search.v1`.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { agentApi } from '../agent/api.js'
import { useStore } from '../store/useStore.js'
import { createWebAiSearch } from '../lib/exercises.js'
import { t } from '../lib/i18n.js'
import { uid } from '../lib/format.js'
import { nav } from '../lib/nav.js'
import Icon from './Icon.jsx'
import { Thumb } from './Media.jsx'
import EmptyState from './EmptyState.jsx'
import { Button } from './ui.jsx'
// The exercise-search diagnostics contract is plain standard JS shared with the
// API server and RN; the Web client imports it across the tree boundary the same
// way it already imports the coach core.
import { createExerciseSearchTrace, logExerciseSearchMedia, safeExerciseSearchError } from '../../../api/agent-runtime/exercise-search-diagnostics.js'
import './ExerciseAiSearch.css'

export const AI_SEARCH_TASK_ID = 'exercise-search.v1'
export const AI_SEARCH_POLL_MS = 2000
export const AI_SEARCH_MAX_RUNS = 6
export const AI_SEARCH_MAX_IMAGE_BYTES = 1024 * 1024
const MAX_RAW_IMAGE_BYTES = 25 * 1024 * 1024
const REF_PREFIX = 'gym_ai_search_last:'
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const LIMIT_CODES = new Set(['turn_limit', 'session_deleted', 'session_conflict'])

const ATTEMPTS = [
  { max: 1280, quality: 0.85 },
  { max: 1280, quality: 0.7 },
  { max: 1200, quality: 0.7 },
  { max: 960, quality: 0.6 },
]

const ERROR_TEXT = {
  agent_media_invalid: '图片格式无效或已损坏，请换一张再试。',
  agent_media_too_large: '图片太大，请换一张或压缩后再试。',
  turn_limit: '这次对话已达到追问上限，请重新发起。',
  session_busy: '上一轮检索仍在运行，请稍后重试。',
  session_conflict: '对话状态已变化，请重新发起。',
  session_deleted: '这次对话已失效，请重新发起。',
  profile_capability_missing: '当前模型无法读取图片，请换一个可用配置或只用文字检索。',
  agent_disabled: 'AI 检索在此实例上已停用。',
  agent_config_missing: '还没有可用的模型配置，请先完成配置。',
  model_unavailable: '模型暂时不可用，请稍后重试。',
  run_not_found: '这次检索已结束或过期，请重新发起。',
  invalid_request: '检索请求无效，请修改输入后再试。',
  interrupted: '上次检索被中断，请重新发起。',
  timeout: '网络响应超时，请检查网络后重试。',
  network: '网络连接失败，请检查网络后重试。',
  http: '检索失败，请稍后重试。',
}

const storage = () => {
  try {
    return globalThis.localStorage || null
  } catch {
    return null
  }
}

const DIAGNOSTICS_KEY = 'opengym:ai-search-diagnostics'

/** The Web diagnostics switch: exactly '1' in localStorage, OFF whenever storage is unreachable. */
const diagnosticsEnabled = () => {
  try {
    return storage()?.getItem(DIAGNOSTICS_KEY) === '1'
  } catch {
    return false
  }
}

/** Fresh id for one image pick; it joins the pick's own `media` event with the run that submits it. */
const newMediaAttemptId = () => `mat_${globalThis.crypto?.randomUUID?.() || uid()}`

export const aiSearchRefKey = accountId => REF_PREFIX + (accountId || 'guest')

/** The persisted reference to the last run, or null when there is none for this account. */
export function readInterrupted(accountId) {
  const store = storage()
  if (!store) return null
  try {
    const saved = JSON.parse(store.getItem(aiSearchRefKey(accountId)) || 'null')
    if (!saved || !saved.runId) return null
    if ((saved.accountId || 'guest') !== (accountId || 'guest')) return null
    return saved
  } catch {
    return null
  }
}

export function writeInterrupted(accountId, ref) {
  const store = storage()
  if (!store || !ref?.runId) return
  try {
    store.setItem(aiSearchRefKey(accountId), JSON.stringify({
      runId: ref.runId,
      sessionId: ref.sessionId || null,
      location: 'server',
      accountId: accountId || 'guest',
    }))
  } catch {
    /* storage refused: the run simply has no resume hint */
  }
}

export function clearInterrupted(accountId, runId) {
  const store = storage()
  if (!store) return
  try {
    const key = aiSearchRefKey(accountId)
    const saved = JSON.parse(store.getItem(key) || 'null')
    if (runId && saved?.runId && saved.runId !== runId) return
    store.removeItem(key)
  } catch {
    /* storage refused */
  }
}

/** Decoded size of a data URL, without turning the base64 back into bytes. */
export function dataUrlBytes(dataUrl) {
  const base64 = String(dataUrl || '').split(',')[1] || ''
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

const imageError = code => Object.assign(new Error(code), { code })

const readDataUrl = file => new Promise((resolve, reject) => {
  if (typeof FileReader === 'undefined') {
    reject(imageError('invalid'))
    return
  }
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result || ''))
  reader.onerror = () => reject(imageError('invalid'))
  reader.readAsDataURL(file)
})

const loadImage = src => new Promise((resolve, reject) => {
  if (typeof Image === 'undefined') {
    reject(imageError('invalid'))
    return
  }
  const image = new Image()
  image.onload = () => resolve(image)
  image.onerror = () => reject(imageError('invalid'))
  image.src = src
})

/**
 * Read a picked image, orient it through the browser's own decoder, then try
 * the documented quality/size ladder until the decoded JPEG is at most 1 MiB.
 * The returned value is the data URL the task receives inline. The optional
 * second parameter is a diagnostics summary: invoked once, at the canvas step's
 * success or failure, with the produced dimensions and bytes plus the
 * compression round count. The return value and the throws stay exactly as
 * they were, so callers may ignore the callback entirely.
 */
export async function normalizeImageFile(file, onSummary) {
  if (!file) throw imageError('invalid')
  if (file.type && !String(file.type).startsWith('image/')) throw imageError('invalid')
  if (Number(file.size) > MAX_RAW_IMAGE_BYTES) throw imageError('too_large')
  const raw = await readDataUrl(file)
  if (!String(raw).startsWith('data:image/')) throw imageError('invalid')
  const image = await loadImage(raw)
  const width = Number(image.naturalWidth || image.width)
  const height = Number(image.naturalHeight || image.height)
  if (!(width > 0) || !(height > 0)) throw imageError('invalid')
  if (typeof document === 'undefined' || !document.createElement) throw imageError('invalid')
  let attempts = 0
  for (const attempt of ATTEMPTS) {
    attempts += 1
    const scale = Math.min(1, attempt.max / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
    if (!context || typeof canvas.toDataURL !== 'function') {
      onSummary?.({ status: 'failed', attempts })
      throw imageError('invalid')
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/jpeg', attempt.quality)
    if (dataUrlBytes(dataUrl) <= AI_SEARCH_MAX_IMAGE_BYTES) {
      onSummary?.({ status: 'ready', width: canvas.width, height: canvas.height, bytes: dataUrlBytes(dataUrl), attempts })
      return dataUrl
    }
  }
  onSummary?.({ status: 'failed', attempts })
  throw imageError('too_large')
}

function imageMessage(error) {
  if (error?.code === 'too_large' || error?.message === 'too_large') return t(ERROR_TEXT.agent_media_too_large)
  return t(ERROR_TEXT.agent_media_invalid)
}

/** A local pick failure maps onto the two declared media codes; anything else logs as `unknown`. */
const mediaErrorCode = failure => safeExerciseSearchError(
  failure?.code === 'invalid' || failure?.message === 'invalid' ? 'agent_media_invalid'
    : failure?.code === 'too_large' || failure?.message === 'too_large' ? 'agent_media_too_large'
      : failure?.code || failure?.message,
)

/**
 * The one terminal event a run's trace may carry, guarded inside the per-run
 * object so cancel-then-exit and every other overlap emit it exactly once. A
 * missing emit (switch off) or an already-ended trace is a plain no-op.
 */
const endTrace = (trace, status, phase, code) => {
  if (!trace?.emit || trace.ended) return
  trace.ended = true
  trace.emit({
    stage: 'end',
    status,
    ...(phase ? { phase } : {}),
    elapsedMs: Date.now() - trace.startedAt,
    ...(status === 'failed' ? { errorCode: safeExerciseSearchError(code) } : {}),
  })
}

function errorCode(error) {
  if (error?.code) return error.code
  if (error?.data?.code) return error.data.code
  if (error?.status === 413) return 'agent_media_too_large'
  if (error?.status === 429) return 'turn_limit'
  return error?.status ? 'http' : 'network'
}

function readableError(code) {
  return t(ERROR_TEXT[code] || ERROR_TEXT.http)
}

/** Resolution order on Web: the account's own profiles (id ascending), then the instance default. */
export function pickAiProfile(profiles, { needsImage = false } = {}) {
  const list = Array.isArray(profiles) ? profiles.filter(Boolean) : []
  const ordered = [
    ...list.filter(profile => profile.source === 'user').sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ...list.filter(profile => profile.source !== 'user'),
  ]
  return ordered.find(profile => profile.available !== false
    && profile.capabilities?.text !== false
    && (!needsImage || profile.capabilities?.image === true)) || null
}

const newRequestId = () => (globalThis.crypto?.randomUUID?.()
  ? `req_${globalThis.crypto.randomUUID()}`
  : `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`)

const LEVEL_LABEL = { high: '高', medium: '中', low: '低' }

const ExerciseAiSearch = forwardRef(function ExerciseAiSearch({
  accountId,
  onExit,
  onPick,
  onFallbackPick,
  closeOnPick = false,
  quick = null,
  normalizeImage = normalizeImageFile,
}, ref) {
  const S = useStore(state => state.S)
  const config = useStore(state => state.config)
  const userId = useStore(state => state.user?.id)
  const who = accountId || userId || 'guest'

  const [phase, setPhase] = useState('preflight')
  const [profiles, setProfiles] = useState([])
  const [profile, setProfile] = useState(null)
  const [panelText, setPanelText] = useState('')
  const [panelImage, setPanelImage] = useState(null)
  const [panelNotice, setPanelNotice] = useState('')
  const [panelError, setPanelError] = useState('')
  const [imageBusy, setImageBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [lastSent, setLastSent] = useState({ text: '', image: null })
  const [runCount, setRunCount] = useState(0)
  const [error, setError] = useState(null)
  const [followText, setFollowText] = useState('')
  const [followImage, setFollowImage] = useState(null)
  const [followBusy, setFollowBusy] = useState(false)
  const [followNotice, setFollowNotice] = useState(null)
  const [showFallback, setShowFallback] = useState(false)
  const [cancelling, setCancelling] = useState(false)

  const alive = useRef(true)
  const runToken = useRef(0)
  const pollTimer = useRef(null)
  const terminalRef = useRef(true)
  const runIdRef = useRef('')
  const sessionRef = useRef('')
  const sessionCreatedRef = useRef(false)
  const imagesRef = useRef([])
  // The latest successful pick, kept in memory only as { image, id } so a later
  // submit — including a retry that re-references the same image — can join the
  // pick's media event. It is never persisted, and it is released with the pick
  // replacement, the draft removal buttons and the session-reset flows.
  const mediaAttemptRef = useRef(null)
  // The open run's per-run diagnostics object. Only the user-driven cancel and
  // leave paths read it; run responses always arrive on their own trace.
  const openTraceRef = useRef(null)
  const lastSentRef = useRef({ text: '', image: null })
  const lastRequestRef = useRef(null)
  const resultRef = useRef(null)
  const resultPhaseRef = useRef('fallbackOnly')
  const SRef = useRef(S)
  const accountRef = useRef(who)
  SRef.current = S
  accountRef.current = who

  const cameraRef = useRef(null)
  const galleryRef = useRef(null)
  const followCameraRef = useRef(null)

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current)
    pollTimer.current = null
  }, [])

  const rememberResult = useCallback(matched => {
    resultRef.current = matched
    resultPhaseRef.current = matched.items.length ? 'candidates' : 'fallbackOnly'
    setResult(matched)
    setShowFallback(!matched.items.length)
  }, [])

  useEffect(() => {
    let live = true
    if (config?.agent?.enabled === false) {
      setPhase('configMissing')
      return undefined
    }
    agentApi.listProfiles()
      .then(data => {
        if (!live) return
        const list = Array.isArray(data) ? data : data?.profiles || []
        setProfiles(list)
        setPhase(pickAiProfile(list) ? 'sheetOpen' : 'configMissing')
      })
      .catch(() => {
        if (live) setPhase('configMissing')
      })
    return () => { live = false }
  }, [])

  useEffect(() => () => {
    alive.current = false
    stopPolling()
    const id = runIdRef.current
    if (id) {
      // A run still open when the page/overlay goes: the server must not
      // finish it into a conversation nobody is looking at.
      if (!terminalRef.current) agentApi.cancelRun(id).catch(() => {})
      clearInterrupted(accountRef.current, id)
    }
    const session = sessionRef.current
    if (session) agentApi.deleteSession(session).catch(() => {})
  }, [stopPolling])

  const finishRun = useCallback((run, trace) => {
    stopPolling()
    terminalRef.current = true
    const id = run?.runId || runIdRef.current
    if (id) clearInterrupted(accountRef.current, id)
    openTraceRef.current = null
    const status = run?.status
    if (status === 'completed') {
      let matched
      try {
        matched = createWebAiSearch(SRef.current).match(run.result, {
          hintText: lastSentRef.current.text,
          ...(trace?.emit ? { diagnostics: { emit: trace.emit } } : {}),
        })
      } catch {
        setError({ code: 'model_unavailable' })
        setPhase('error')
        endTrace(trace, 'failed', 'match', 'model_unavailable')
        return
      }
      rememberResult(matched)
      setPhase(matched.items.length ? 'candidates' : 'fallbackOnly')
      endTrace(trace, 'completed', 'match')
      setFollowText('')
      setFollowImage(null)
      setFollowNotice(null)
      setPanelError('')
    } else if (status === 'failed') {
      setError({ code: run?.error?.code || 'model_unavailable' })
      setPhase('error')
      endTrace(trace, 'failed', 'model', run?.error?.code || 'model_unavailable')
    } else if (status === 'cancelled') {
      setPhase(resultRef.current ? resultPhaseRef.current : 'sheetOpen')
      endTrace(trace, 'cancelled')
    } else if (status === 'interrupted') {
      setError({ code: 'interrupted' })
      setPhase('error')
      endTrace(trace, 'interrupted')
    }
  }, [rememberResult, stopPolling])

  const pollOnce = useCallback(async (id, token, trace) => {
    try {
      const run = await agentApi.getRun(id)
      if (!alive.current || token !== runToken.current) return
      if (run?.profile) setProfile(run.profile)
      if (TERMINAL.has(run?.status)) {
        finishRun(run, trace)
        return
      }
      pollTimer.current = setTimeout(() => { void pollOnce(id, token, trace) }, AI_SEARCH_POLL_MS)
    } catch (failure) {
      if (!alive.current || token !== runToken.current) return
      // The run may still be alive server-side; keep the interrupted reference
      // so leaving and coming back can still offer a recovery.
      setError({ code: errorCode(failure) })
      setPhase('error')
      endTrace(trace, 'failed', 'poll', errorCode(failure))
    }
  }, [finishRun])

  const cancelRound = useCallback(() => {
    const id = runIdRef.current
    runToken.current += 1
    terminalRef.current = true
    stopPolling()
    setCancelling(false)
    setPhase(resultRef.current ? resultPhaseRef.current : 'sheetOpen')
    endTrace(openTraceRef.current, 'cancelled')
    openTraceRef.current = null
    if (id) {
      clearInterrupted(accountRef.current, id)
      agentApi.cancelRun(id).catch(() => {})
    }
  }, [stopPolling])

  const resetSession = useCallback(() => {
    const old = sessionRef.current
    sessionRef.current = ''
    sessionCreatedRef.current = false
    imagesRef.current = []
    mediaAttemptRef.current = null
    if (old) agentApi.deleteSession(old).catch(() => {})
    setProfile(null)
    setRunCount(0)
  }, [])

  const exit = useCallback(({ notify = true } = {}) => {
    const id = runIdRef.current
    const session = sessionRef.current
    const open = !terminalRef.current
    runToken.current += 1
    stopPolling()
    runIdRef.current = ''
    terminalRef.current = true
    sessionRef.current = ''
    sessionCreatedRef.current = false
    imagesRef.current = []
    mediaAttemptRef.current = null
    if (open) endTrace(openTraceRef.current, 'cancelled')
    openTraceRef.current = null
    if (id) {
      clearInterrupted(accountRef.current, id)
      if (open) agentApi.cancelRun(id).catch(() => {})
    }
    if (session) agentApi.deleteSession(session).catch(() => {})
    if (notify) onExit?.()
  }, [onExit, stopPolling])

  const sendRequest = useCallback(async ({ text, image, surface = 'follow' }) => {
    const hintText = String(text || '').trim()
    if (!hintText && !image) return
    const needsImage = !!image
    const picked = pickAiProfile(profiles, { needsImage })
    if (!picked) {
      if (needsImage && surface === 'panel') {
        setPanelError(readableError('profile_capability_missing'))
      } else {
        setError({ code: needsImage ? 'profile_capability_missing' : 'agent_config_missing' })
        setPhase('error')
      }
      return
    }

    const token = runToken.current + 1
    runToken.current = token
    const previousRun = runIdRef.current
    if (previousRun && !terminalRef.current) {
      try { await agentApi.cancelRun(previousRun) } catch { /* it may already be gone */ }
      if (token !== runToken.current) return
    }
    runIdRef.current = ''
    terminalRef.current = true
    stopPolling()
    setCancelling(false)
    setError(null)
    setPanelError('')
    setShowFallback(false)

    const continuing = !!sessionRef.current && sessionCreatedRef.current
    const session = continuing ? sessionRef.current : uid()
    sessionRef.current = session

    const previousImages = imagesRef.current
    const images = image
      ? (previousImages[0] === image ? previousImages : [image, ...previousImages].slice(0, 2))
      : previousImages
    imagesRef.current = images
    const summaryImage = images[0] || null
    const summary = { text: hintText, image: summaryImage }
    lastSentRef.current = summary
    setLastSent(summary)
    lastRequestRef.current = { text: hintText, image, needsImage, surface }
    setRunCount(count => count + 1)
    setPhase('running')

    // One request id per run, also used as its trace id. The per-run object
    // carries the emit function, the start time, the end guard and this submit's
    // image-attempt id, and it travels with the token: late responses land on
    // the run they belong to, never on whatever run happens to be current.
    const requestId = newRequestId()
    const attempt = image ? mediaAttemptRef.current : null
    const trace = {
      emit: createExerciseSearchTrace({ traceId: requestId, source: 'web', enabled: diagnosticsEnabled() }),
      startedAt: Date.now(),
      ended: false,
      mediaAttemptId: attempt && attempt.image === image ? attempt.id : '',
    }

    const body = {
      taskId: AI_SEARCH_TASK_ID,
      requestId,
      profileId: picked.id,
      sessionId: session,
      sessionMode: continuing ? 'continue' : 'new',
      input: {
        ...(hintText ? { hintText } : {}),
        ...(images.length ? { images } : {}),
      },
    }
    trace.emit?.({
      stage: 'submit',
      execution: 'server',
      hasHint: !!hintText,
      imageCount: images.length,
      ...(trace.mediaAttemptId ? { mediaAttemptId: trace.mediaAttemptId } : {}),
    })

    try {
      const started = await agentApi.startRun(body)
      if (!alive.current || token !== runToken.current) {
        if (started?.runId) agentApi.cancelRun(started.runId).catch(() => {})
        return
      }
      if (!started?.runId) throw Object.assign(new Error('no run'), { code: 'model_unavailable' })
      if (!continuing) sessionCreatedRef.current = true
      if (started.profile) setProfile(started.profile)
      else setProfile(picked)
      runIdRef.current = started.runId
      terminalRef.current = false
      openTraceRef.current = trace
      writeInterrupted(accountRef.current, {
        runId: started.runId,
        sessionId: session,
        location: 'server',
        accountId: accountRef.current,
      })
      if (TERMINAL.has(started.status)) {
        const run = await agentApi.getRun(started.runId)
        if (alive.current && token === runToken.current) {
          finishRun({ ...run, profile: run.profile || started.profile || picked }, trace)
        }
        return
      }
      pollTimer.current = setTimeout(() => { void pollOnce(started.runId, token, trace) }, AI_SEARCH_POLL_MS)
    } catch (failure) {
      if (!alive.current || token !== runToken.current) return
      if (!continuing) sessionRef.current = ''
      if (runIdRef.current) clearInterrupted(accountRef.current, runIdRef.current)
      setError({ code: errorCode(failure) })
      setPhase('error')
      endTrace(trace, 'failed', 'submit', errorCode(failure))
    }
  }, [finishRun, pollOnce, profiles, stopPolling])

  const openPanel = useCallback(({ reset = false } = {}) => {
    if (reset) resetSession()
    setPanelText(lastSentRef.current.text || '')
    setPanelImage(lastSentRef.current.image || null)
    setPanelNotice('')
    setPanelError('')
    setPhase('sheetOpen')
  }, [resetSession])

  const reopen = useCallback(() => {
    if (!pickAiProfile(profiles)) {
      setPhase('configMissing')
      return
    }
    const id = runIdRef.current
    if (id) {
      runToken.current += 1
      terminalRef.current = true
      stopPolling()
      clearInterrupted(accountRef.current, id)
      agentApi.cancelRun(id).catch(() => {})
    }
    openPanel({ reset: runCount >= AI_SEARCH_MAX_RUNS })
  }, [openPanel, profiles, runCount, stopPolling])

  const restart = useCallback(() => {
    cancelRound()
    resetSession()
    setError(null)
    setResult(null)
    resultRef.current = null
    setRunCount(0)
    lastSentRef.current = { text: '', image: null }
    setLastSent({ text: '', image: null })
    setFollowText('')
    setFollowImage(null)
    openPanel({ reset: true })
  }, [cancelRound, openPanel, resetSession])

  const retry = useCallback(() => {
    const last = lastRequestRef.current
    if (!last) return
    const code = error?.code
    if (LIMIT_CODES.has(code)) {
      resetSession()
      setRunCount(0)
      imagesRef.current = []
    }
    void sendRequest({ text: last.text, image: last.image, surface: last.surface || 'follow' })
  }, [error, resetSession, sendRequest])

  const modify = useCallback(() => {
    openPanel()
  }, [openPanel])

  useImperativeHandle(ref, () => ({
    reopen,
    reset() {
      void exit({ notify: false })
    },
  }), [exit, reopen])

  const chooseImage = async (file, target) => {
    if (!file) return
    const replacing = target === 'panel' ? !!panelImage : !!followImage
    const mediaAttemptId = newMediaAttemptId()
    const enabled = diagnosticsEnabled()
    const startedAt = Date.now()
    const inputBytes = Number(file.size)
    let summary = null
    if (target === 'panel') {
      setImageBusy(true)
      setPanelError('')
      setPanelNotice('')
    } else {
      setFollowBusy(true)
      setFollowNotice('')
    }
    try {
      const dataUrl = await normalizeImage(file, enabled ? value => { summary = value } : undefined)
      // The pick completed even if the overlay went away meanwhile, so the
      // attempt is recorded first; the alive guard below only keeps the state
      // updates to the mounted case.
      mediaAttemptRef.current = { image: dataUrl, id: mediaAttemptId }
      logExerciseSearchMedia({
        mediaAttemptId,
        source: 'web',
        enabled,
        metrics: {
          status: 'ready',
          ...(Number.isFinite(inputBytes) ? { inputBytes } : {}),
          ...(summary?.status === 'ready' ? {
            outputBytes: summary.bytes,
            outputWidth: summary.width,
            outputHeight: summary.height,
            attempts: summary.attempts,
          } : {}),
          elapsedMs: Date.now() - startedAt,
        },
      })
      if (!alive.current) return
      if (target === 'panel') {
        setPanelImage(dataUrl)
        setPanelNotice(replacing ? t('已替换为新的图片') : '')
      } else {
        setFollowImage(dataUrl)
        setFollowNotice(replacing ? { text: t('已替换为新的图片'), error: false } : null)
      }
    } catch (failure) {
      logExerciseSearchMedia({
        mediaAttemptId,
        source: 'web',
        enabled,
        metrics: {
          status: 'failed',
          ...(Number.isFinite(inputBytes) ? { inputBytes } : {}),
          ...(summary?.attempts ? { attempts: summary.attempts } : {}),
          elapsedMs: Date.now() - startedAt,
          errorCode: mediaErrorCode(failure),
        },
      })
      if (!alive.current) return
      const message = imageMessage(failure)
      if (target === 'panel') setPanelError(message)
      else setFollowNotice({ text: message, error: true })
    } finally {
      if (alive.current) {
        if (target === 'panel') setImageBusy(false)
        else setFollowBusy(false)
      }
    }
  }

  const submitPanel = event => {
    event.preventDefault()
    if (imageBusy) return
    if (!panelText.trim() && !panelImage) return
    void sendRequest({ text: panelText, image: panelImage, surface: 'panel' })
  }

  const submitFollow = event => {
    event.preventDefault()
    if (phase === 'running' || followBusy || runCount >= AI_SEARCH_MAX_RUNS) return
    if (!followText.trim() && !followImage) return
    void sendRequest({ text: followText, image: followImage, surface: 'follow' })
  }

  const handlePick = (item, quickPick = false) => {
    if (!item?.exercise) return
    if (closeOnPick) exit()
    onPick?.(item.exercise, quickPick ? true : undefined)
  }

  const applyFallback = (kind, value) => {
    exit({ notify: false })
    onFallbackPick?.(kind, value)
  }

  const hiddenInputs = <>
    <input ref={cameraRef} data-ai-input="camera" type="file" accept="image/*" capture="environment" hidden
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseImage(file, 'panel') }} />
    <input ref={galleryRef} data-ai-input="gallery" type="file" accept="image/*" hidden
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseImage(file, 'panel') }} />
    <input ref={followCameraRef} data-ai-input="follow" type="file" accept="image/*" capture="environment" hidden
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void chooseImage(file, 'follow') }} />
  </>

  if (phase === 'preflight') {
    return <div className="ai-search ai-preflight" aria-busy="true">
      {hiddenInputs}
      <p className="ai-note">{t('Loading…')}</p>
    </div>
  }

  if (phase === 'configMissing') {
    const disabled = config?.agent?.enabled === false
    return <div className="ai-search">
      {hiddenInputs}
      <EmptyState icon="sparkles" title={t('AI 检索不可用')}
        text={disabled ? t('AI 检索在此实例上已停用。') : t('还没有可用的模型配置，先完成配置再回来检索。')}>
        {!disabled && <Button variant="primary" onClick={() => nav('/agent/setup')}>{t('去配置')}</Button>}
        <Button variant="ghost" onClick={() => exit()}>{t('返回')}</Button>
      </EmptyState>
    </div>
  }

  if (phase === 'sheetOpen') {
    const canSubmit = !imageBusy && (!!panelText.trim() || !!panelImage)
    const hasResult = !!resultRef.current
    return <section className="ai-search ai-launch" aria-label={t('AI 检索动作')}>
      {hiddenInputs}
      <div className="ai-launch-head">
        <div>
          <h3>{t('AI 检索动作')}</h3>
          <p className="ai-note">{t('描述想找的动作，或拍一张器械照片。')}</p>
        </div>
        <button type="button" className="iconbtn" aria-label={hasResult ? t('返回结果') : t('退出 AI 检索')}
          onClick={() => { if (hasResult) setPhase(resultPhaseRef.current); else exit() }}><Icon name="xmark" /></button>
      </div>
      <form onSubmit={submitPanel}>
        <textarea className="ai-textarea" value={panelText} maxLength={500} disabled={imageBusy}
          placeholder={t('描述想找的动作或器械，可加上你的条件（如：肩膀不适、只有哑铃）')}
          onChange={event => setPanelText(event.target.value)} />
        <div className="ai-pick-row">
          <Button type="button" size="sm" variant="tinted" icon="camera" disabled={imageBusy}
            onClick={() => cameraRef.current?.click()}>{t('拍照')}</Button>
          <Button type="button" size="sm" variant="tinted" icon="image" disabled={imageBusy}
            onClick={() => galleryRef.current?.click()}>{t('从相册选择')}</Button>
        </div>
        {panelImage ? <div className="ai-attach">
          <img src={panelImage} alt="" />
          <button type="button" className="ai-attach-x" aria-label={t('移除图片')}
            onClick={() => { setPanelImage(null); setPanelNotice(''); mediaAttemptRef.current = null }}><Icon name="xmark" /></button>
        </div> : null}
        {panelNotice ? <p className="ai-note" role="status">{panelNotice}</p> : null}
        {panelError ? <p className="ai-error" role="alert">{panelError}</p> : null}
        <Button type="submit" variant="primary" className="ai-submit" disabled={!canSubmit}>
          {imageBusy ? t('正在处理图片…') : t('AI 检索')}
        </Button>
        <p className="ai-footnote">{t('使用 AI 模型识别，需联网')}</p>
      </form>
    </section>
  }

  const running = phase === 'running'
  const items = Array.isArray(result?.items) ? result.items.slice(0, 5).filter(item => item?.exercise) : []
  const fallback = result?.fallback || null
  const clarifications = Array.isArray(result?.clarifications)
    ? result.clarifications.filter(chip => chip?.label && chip?.prompt).slice(0, 3)
    : []
  const limitReached = runCount >= AI_SEARCH_MAX_RUNS
  const activeProfile = profile
  const followLocked = running || followBusy || limitReached || !!error
  const canFollow = !followLocked && (!!followText.trim() || !!followImage)

  return <section className="ai-search" aria-label={t('AI 检索动作')}>
    {hiddenInputs}
    <div className="ai-summary">
      {lastSent.image ? <img className="ai-summary-thumb" src={lastSent.image} alt="" /> : <span className="ai-summary-thumb ai-summary-icon"><Icon name="sparkles" /></span>}
      <div className="ai-summary-main">
        <div className="ai-summary-text">{lastSent.text || t('图片检索')}</div>
        <div className="ai-summary-meta">
          {running ? t('正在检索…') : error ? t('检索失败') : t('检索完成')}
          {activeProfile ? ` · ${t('经 {0} 检索', activeProfile.label || activeProfile.provider || activeProfile.id)}` : ''}
        </div>
      </div>
      {running ? <Button size="sm" variant="ghost" disabled={cancelling}
        onClick={() => { setCancelling(true); cancelRound() }}>{t('取消')}</Button> : null}
      <button type="button" className="iconbtn" aria-label={t('退出 AI 检索')} onClick={() => exit()}><Icon name="xmark" /></button>
    </div>

    {error ? <div className="ai-error-card" role="alert">
      <p>{readableError(error.code)}</p>
      <div className="ai-actions">
        <Button size="sm" variant="tinted" onClick={retry}>{t('重试')}</Button>
        <Button size="sm" onClick={modify}>{t('修改')}</Button>
        {LIMIT_CODES.has(error.code) ? <Button size="sm" onClick={restart}>{t('重新发起')}</Button> : null}
      </div>
    </div> : null}

    {!result && running ? <div className="ai-loading" aria-busy="true">
      <span className="ai-spin" aria-hidden="true" />
      <p>{t('正在识别…')}</p>
    </div> : null}

    {items.length > 0 ? <div className="ai-results">
      <h4 className="sec">{t('识别到的动作')}</h4>
      <div className="list">
        {items.map(item => <div className="item ai-candidate tap-host" key={item.exerciseId || item.exercise?.id || item.name}>
          <Thumb ex={item.exercise} />
          <button type="button" className="grow item-open tap-main" onClick={() => handlePick(item)}>
            <span className="tt">{item.name}</span>
            <span className="ss">{item.rationale}</span>
          </button>
          <span className={`tag ai-level ${item.level || 'medium'}`}>{t(LEVEL_LABEL[item.level] || LEVEL_LABEL.medium)}</span>
          {quick ? <button type="button" className="iconbtn chev" style={{ padding: 8, margin: -8 }}
            aria-label={typeof quick.label === 'function' ? quick.label(item.exercise) : quick.label}
            onClick={() => handlePick(item, true)}><Icon name={quick.icon || 'plus'} /></button> : null}
        </div>)}
      </div>
    </div> : null}

    {!followLocked && clarifications.length > 0 ? <div className="ai-clarifications" data-ai-clarifications="">
      <p className="ai-note">{t('快速补充方向：')}</p>
      <div className="chips wrap">
        {clarifications.map(chip => <button
          type="button"
          key={chip.label}
          className="chip"
          onClick={() => { void sendRequest({ text: chip.prompt, surface: 'follow' }) }}
        >{chip.label}</button>)}
      </div>
    </div> : null}

    {items.length > 0 && !showFallback && fallback ? <button type="button" className="ai-fallback-open"
      onClick={() => setShowFallback(true)}>{t('都不对？继续追问，或看看建议筛选')}</button> : null}

    {fallback && (showFallback || items.length === 0) ? <div className="ai-fallback">
      <h4 className="sec">{items.length ? t('建议筛选') : t('没有找到动作，可以换个说法或看看建议筛选')}</h4>
      <p className="ai-understanding">{fallback.understanding}</p>
      {(fallback.bodyParts?.length || fallback.equipment?.length) ? <div className="chips wrap">
        {(fallback.bodyParts || []).map(value => <button type="button" key={`bp:${value}`} className="chip"
          onClick={() => applyFallback('bodyPart', value)}>{t(value)}</button>)}
        {(fallback.equipment || []).map(value => <button type="button" key={`eq:${value}`} className="chip"
          onClick={() => applyFallback('equipment', value)}>{t(value)}</button>)}
      </div> : null}
    </div> : null}

    {!error && !result && !running ? null : <div className="ai-follow-wrap">
      <form className="ai-follow" onSubmit={submitFollow}>
        <button type="button" className="iconbtn ai-follow-cam" aria-label={t('拍照')} disabled={followLocked}
          onClick={() => followCameraRef.current?.click()}><Icon name="camera" /></button>
        <input value={followText} maxLength={500} disabled={followLocked}
          placeholder={t('继续描述或追问…')} onChange={event => setFollowText(event.target.value)} />
        {followImage ? <span className="ai-follow-thumb">
          <img src={followImage} alt="" />
          <button type="button" aria-label={t('移除图片')}
            onClick={() => { setFollowImage(null); mediaAttemptRef.current = null }}><Icon name="xmark" /></button>
        </span> : null}
        <button type="submit" className="iconbtn ai-send" aria-label={t('发送')} disabled={!canFollow}>
          {running ? <span className="ai-spin" aria-hidden="true" /> : <Icon name="arrowUp" />}
        </button>
      </form>
      {followNotice ? <p className={followNotice.error ? 'ai-error' : 'ai-note'} role="status">{followNotice.text}</p> : null}
      {limitReached ? <p className="ai-note ai-limit">{t('已达到追问上限，请重新发起。')}
        <button type="button" className="btn xs tinted" onClick={restart}>{t('重新发起')}</button></p> : null}
    </div>}
  </section>
})

export default ExerciseAiSearch
