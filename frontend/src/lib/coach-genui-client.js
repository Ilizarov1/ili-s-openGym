// The Coach's streaming transport for generative UI.
//
// One entry point, two providers. On a real server it consumes the AG-UI SSE stream of
// `POST /api/agent/coach/stream`; in the demo build it runs the same event sequence locally so
// the GitHub Pages deployment can show the whole experience without a backend. Both speak the
// same vocabulary, so the renderer (components/CoachGenUI.jsx) never knows which one it got.
//
// A server without the endpoint (404/503) or a phone running the Coach on its own key rejects
// with `{ code: 'genui_unavailable', fallback: true }`: CoachChat then answers through the old
// `askCoach()` path, exactly as before this feature existed.
import { DEMO } from './demo.js'
import { MOBILE } from './mobile.js'
import { getLang, t } from './i18n.js'
import { ensureAiConsent } from './coach-api.js'
import { appBase, remoteAuth } from './api.js'
import { planHash } from './coach.js'
import { EXDB, EXIDX } from './exercises.js'
import { muscleGroupsOf } from './muscles.js'
import { hydrateExerciseTrend, hydrateMuscleLoad } from './coach-genui-hydration.js'
import { useStore } from '../store/useStore.js'

const unavailable = message => Object.assign(
  new Error(message || 'The streaming Coach is not available here.'),
  { code: 'genui_unavailable', fallback: true },
)
const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' })

const byok = () => MOBILE && useStore.getState()?.coachLocal?.mode === 'byok'

/* ============================== server: AG-UI SSE ============================== */

/**
 * POST the question and feed every parsed AG-UI event to `onEvent`.
 * Returns the RUN_FINISHED payload (`{ text, blocks }`) once the stream closes.
 */
async function streamFromServer({ text, formSubmission, history, S, today, maxVisuals, signal, onEvent }) {
  await ensureAiConsent()

  const auth = remoteAuth()
  const base = (auth?.base || appBase().replace(/\/$/, '')) + '/api/agent/coach/stream'
  const headers = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    ...(auth?.headers || {}),
  }
  const response = await fetch(base, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    signal,
    body: JSON.stringify({
      text: String(text || ''),
      formSubmission: formSubmission || null,
      today: today || null,
      plan: { routines: S?.routines || [], week: S?.week || {} },
      lang: getLang(),
      ...(Array.isArray(history) && history.length > 0 ? { history } : {}),
      ...(maxVisuals != null ? { maxVisuals } : {}),
    }),
  })

  if (response.status === 404 || response.status === 503) throw unavailable()
  if (response.status === 429) {
    let body = null
    try { body = await response.json() } catch { /* not JSON: a proxy's page */ }
    throw Object.assign(new Error(body?.error || 'Too many turns'), {
      status: 429,
      code: body?.code || 'turn_limit',
      data: body || {},
    })
  }
  if (!response.ok) {
    let body = null
    try { body = await response.json() } catch { /* not JSON: a proxy's page */ }
    throw Object.assign(new Error(body?.error || ('HTTP ' + response.status)), {
      status: response.status,
      code: body?.code || 'http',
      data: body || {},
    })
  }
  const reader = response.body?.getReader?.()
  if (!reader) throw unavailable()

  const decoder = new TextDecoder()
  let buffer = ''
  let seen = 0
  let finished = null
  let runError = null

  const dispatch = frame => {
    for (const raw of String(frame).split(/\r?\n/)) {
      const line = raw.trimEnd()
      if (!line || line.startsWith(':')) continue   // heartbeat / comment
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload) continue
      let event
      try { event = JSON.parse(payload) } catch { continue }
      if (!event || typeof event !== 'object') continue
      seen++
      if (event.type === 'RUN_FINISHED') finished = event
      if (event.type === 'RUN_ERROR') runError = event
      onEvent?.(event)
    }
  }

  const drain = () => {
    for (;;) {
      const match = buffer.match(/\r?\n\r?\n/)
      if (!match || match.index == null) return
      const frame = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      dispatch(frame)
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    drain()
  }
  buffer += decoder.decode()
  if (buffer.trim()) dispatch(buffer)

  if (signal?.aborted) throw aborted()
  if (runError) {
    throw Object.assign(new Error(runError.message || t('Something went wrong on the server.')), {
      code: runError.code || 'run_error',
      data: { code: runError.code },
    })
  }
  // A 200 that never spoke the protocol is not a stream we can trust: fall back rather than
  // persist an empty reply.
  if (!seen) throw unavailable()
  return finished
    ? {
      nodes: Array.isArray(finished.nodes) ? finished.nodes : null,
      text: String(finished.text ?? ''),
      blocks: Array.isArray(finished.blocks) ? finished.blocks : [],
    }
    : { nodes: null, text: '', blocks: [] }
}

/* ============================== demo: local AG-UI ============================== */

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(aborted())
  let timer = null
  const stop = () => { clearTimeout(timer); reject(aborted()) }
  timer = setTimeout(() => { signal?.removeEventListener?.('abort', stop); resolve() }, ms)
  signal?.addEventListener?.('abort', stop, { once: true })
})

const round1 = n => Math.round(Number(n) * 10) / 10
const cap = s => String(s || '').replace(/(^|\s)(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase())

/** The lift a demo question is about: the bench if the plan has one, else the first compound. */
function demoExercise(S) {
  const slots = (S?.routines || []).flatMap(routine => (routine.ex || []).map(entry => ({ routineId: routine.id, exId: entry.id })))
  const bench = slots.find(({ exId }) => /bench press/i.test(EXIDX[exId]?.n || ''))
  const compound = slots.find(({ exId }) => {
    const ex = EXIDX[exId]
    return ex && ex.bp !== 'cardio' && !ex.hd && ex.eq !== 'body weight'
  })
  const slot = bench || compound || slots[0]
  if (slot) return slot
  const fallback = EXDB.find(ex => ex.id === '0025') || EXDB[0]
  return { routineId: null, exId: fallback?.id }
}

/** Two real dumbbell/cable swaps for the same body part, not already in the plan. */
function demoAlternatives(S, targetExId) {
  const target = EXIDX[targetExId]
  if (!target) return []
  const inPlan = new Set((S?.routines || []).flatMap(routine => (routine.ex || []).map(entry => entry.id)))
  const samePart = EXDB.filter(ex =>
    ex && ex.id !== targetExId && ex.bp === target.bp && !inPlan.has(ex.id) && !ex.hd &&
    !/stretch|mobility|yoga|isometric|hold|pose|circles/i.test(ex.n || ''))
  const dumbbell = samePart.filter(ex => /dumbbell/i.test(ex.eq || ''))
  const cable = samePart.filter(ex => /cable/i.test(ex.eq || ''))
  const rest = samePart.filter(ex => !dumbbell.includes(ex) && !cable.includes(ex) && !/body weight/i.test(ex.eq || ''))
  return [...dumbbell, ...cable, ...rest].slice(0, 2)
}

function demoProposal(S, target, alternative) {
  const targetName = EXIDX[target.exId]?.n || String(target.exId)
  const altName = EXIDX[alternative.id]?.n || String(alternative.id)
  return {
    id: 'blk_prop_1',
    type: 'proposal_action',
    title: t('Swap {0} for {1}', cap(targetName), cap(altName)),
    summary: `Replaces ${targetName} with ${altName} for the next four weeks while the joint settles.`,
    planHash: planHash(S),
    changes: [{
      id: 'gc1',
      type: 'swap-exercise',
      target: { routineId: target.routineId, exId: target.exId },
      before: targetName,
      after: { id: alternative.id, name: altName },
      why: 'Same body part, a kinder joint angle, and a load you can still progress.',
    }],
  }
}

async function streamDemo({ text, formSubmission, S, signal, onEvent }) {
  const target = demoExercise(S)
  const targetEx = EXIDX[target.exId]
  const question = String(text || '').toLowerCase()
  const alternatives = demoAlternatives(S, target.exId)
  const trend = hydrateExerciseTrend(S, { exId: target.exId, metric: 'e1rm', weeks: 8 })
  const focus = muscleGroupsOf(targetEx).slice(0, 3)
  const muscle = hydrateMuscleLoad(S, { window: '72h', focusMuscles: focus })
  const runId = 'run_' + Date.now().toString(36)
  const threadId = 'demo'
  const emit = event => onEvent?.({ timestamp: Date.now(), runId, threadId, ...event })

  const vaguePain = /\b(hurt|hurts|pain|painful|ache|aches|discomfort|sore|niggle)\b/.test(question) &&
    !/\b(bench|stall|stalled|plateau|progress|swap|replace|increase)\b/.test(question)
  const scenario = formSubmission ? 'form' : vaguePain ? 'triage' : 'default'

  emit({ type: 'RUN_STARTED' })
  emit({ type: 'STEP_STARTED', stepName: 'analyze', label: t('Analyzing your training log') })
  emit({ type: 'TOOL_CALL_START', toolCallId: 'tool_log', toolCallName: 'training_log' })
  await sleep(250, signal)
  emit({
    type: 'TOOL_CALL_RESULT', toolCallId: 'tool_log', toolCallName: 'training_log',
    summary: `${trend.sessions} sessions for ${EXIDX[target.exId]?.n || 'this lift'}`,
  })
  emit({ type: 'STEP_FINISHED', stepName: 'analyze' })
  emit({ type: 'STEP_STARTED', stepName: 'catalogue', label: t('Reading your training…') })
  emit({ type: 'TOOL_CALL_START', toolCallId: 'tool_catalogue', toolCallName: 'exercise_catalogue' })
  await sleep(250, signal)
  emit({
    type: 'TOOL_CALL_RESULT', toolCallId: 'tool_catalogue', toolCallName: 'exercise_catalogue',
    summary: `${alternatives.length} real swaps found`,
  })
  emit({ type: 'STEP_FINISHED', stepName: 'catalogue' })

  const headers = {
    'exercise_trend': `${cap(trend.name)} · ${t('Estimated 1RM')}`,
    'muscle_load': t('Muscle load'),
    'exercise_alternatives': t('Suggested swaps'),
  }
  const blocks = []
  let answer = ''

  if (scenario === 'triage') {
    answer = `Before I touch the plan, help me read this properly. Where is it, how strong is it from 1 to 10, and what equipment do you have around you? Your last 72 hours already show ${round1(muscle.totalSets)} work sets, so I can keep the load sensible while we work it out.`
    blocks.push({
      id: 'blk_muscle_1', type: 'muscle_load', window: '72h', focusMuscles: focus,
      title: headers.muscle_load,
      caption: 'Recent work still sitting on the same area.',
    })
    blocks.push({
      id: 'blk_form_1', type: 'quick_form', formId: 'shoulder_triage',
      title: 'Quick check before I adjust',
      submitLabel: t('Send answers'),
      fields: [
        {
          name: 'painArea', label: t('Where does it hurt?'), kind: 'single_choice',
          options: [
            { value: 'front_shoulder', label: 'Front shoulder' },
            { value: 'side_shoulder', label: 'Side shoulder' },
            { value: 'elbow', label: 'Elbow' },
            { value: 'lower_back', label: 'Lower back' },
            { value: 'knee', label: 'Knee' },
            { value: 'other', label: 'Somewhere else' },
          ],
        },
        { name: 'intensity', label: t('Discomfort (1–10)'), kind: 'scale', min: 1, max: 10 },
        {
          name: 'equipment', label: t('Equipment'), kind: 'multi_choice',
          options: [
            { value: 'dumbbell', label: 'Dumbbells' },
            { value: 'cable', label: 'Cables' },
            { value: 'barbell', label: 'Barbell' },
            { value: 'body weight', label: 'Body weight' },
            { value: 'machine', label: 'Machines' },
          ],
        },
      ],
    })
  } else {
    const source = formSubmission?.values || {}
    if (scenario === 'form') {
      const area = String(source.painArea || 'the area').replace(/_/g, ' ')
      const intensity = source.intensity != null ? ` at ${source.intensity}/10` : ''
      answer = `Thanks — ${area}${intensity}. I have kept the pressing pattern but moved the load to a friendlier angle. The two swaps below are real exercises with the same target, and the change is ready to review; nothing touches your plan until you accept it.`
      if (alternatives.length) {
        blocks.push({
          id: 'blk_alt_1', type: 'exercise_alternatives', forExId: target.exId, routineId: target.routineId,
          title: headers.exercise_alternatives,
          items: alternatives.map(ex => ({
            exId: ex.id,
            reason: `${cap(ex.eq)} version: same ${targetEx?.bp || 'target'} stimulus, different joint angle.`,
            tag: cap(ex.eq),
          })),
        })
        blocks.push(demoProposal(S, target, alternatives[0]))
      }
    } else {
      const direction = trend.delta > 0 ? 'up' : trend.delta < 0 ? 'down' : 'flat'
      const trendLine = trend.sessions >= 2
        ? `${cap(trend.name)} is ${direction} ${Math.abs(trend.pct)}% across ${trend.sessions} sessions (${trend.first} → ${trend.last} ${S?.unit || 'kg'}).`
        : `${cap(trend.name)} needs another session or two before a trend means anything.`
      answer = `${trendLine} The 72-hour map shows ${round1(muscle.totalSets)} work sets, and the swaps keep the same movement pattern if you want a fresher angle. I have packaged one change for you to accept or dismiss — your plan stays untouched until then.`
      blocks.push({
        id: 'blk_trend_1', type: 'exercise_trend', exId: target.exId, metric: 'e1rm', weeks: 8,
        title: headers.exercise_trend,
        caption: trend.stalled ? 'Flat across your last three sessions.' : 'Built from your own logged sets.',
        highlightStall: trend.stalled,
      })
      blocks.push({
        id: 'blk_muscle_1', type: 'muscle_load', window: '72h', focusMuscles: focus,
        title: headers.muscle_load,
        caption: 'Effective work sets in the last 72 hours.',
      })
      if (alternatives.length) {
        blocks.push({
          id: 'blk_alt_1', type: 'exercise_alternatives', forExId: target.exId, routineId: target.routineId,
          title: headers.exercise_alternatives,
          items: alternatives.map(ex => ({
            exId: ex.id,
            reason: `${cap(ex.eq)} version: same ${targetEx?.bp || 'target'} stimulus, different joint angle.`,
            tag: cap(ex.eq),
          })),
        })
      }
      if (alternatives[0]) blocks.push(demoProposal(S, target, alternatives[0]))
    }
  }

  emit({ type: 'TEXT_MESSAGE_START', messageId: 'msg_demo', role: 'assistant' })
  const words = answer.split(/(\s+)/)
  for (let i = 0; i < words.length; i += 3) {
    const delta = words.slice(i, i + 3).join('')
    if (delta) emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'msg_demo', delta })
    if (i + 3 < words.length) await sleep(24, signal)
  }
  emit({ type: 'TEXT_MESSAGE_END', messageId: 'msg_demo' })

  for (const block of blocks) {
    await sleep(150, signal)
    emit({ type: 'CUSTOM', name: 'genui.block_upsert', value: { block } })
  }

  emit({ type: 'RUN_FINISHED', text: answer, blocks })
  return { text: answer, blocks }
}

/* ============================== entry point ============================== */

/**
 * Ask the Coach for a generative-UI answer.
 *
 * `onEvent` receives each AG-UI event as it arrives. Resolves with `{ text, blocks }` from
 * RUN_FINISHED, or rejects with `fallback: true` when this deployment cannot stream.
 */
export async function streamCoachGenUI({ text, formSubmission = null, history = null, S, today = null, maxVisuals = null, signal, onEvent } = {}) {
  if (signal?.aborted) throw aborted()
  if (DEMO) return streamDemo({ text, formSubmission, S, signal, onEvent })
  if (byok()) throw unavailable('This phone runs the Coach itself.')
  return streamFromServer({ text, formSubmission, history, S, today, maxVisuals, signal, onEvent })
}
