// Client-side hydration for the Coach's generative UI blocks.
//
// The model (or the demo streamer) only names an exercise, a metric and a window. Every number
// on the cards is then computed here, from the training log this device already holds: a chart
// of a lift the Coach invented, or a body map with made-up volume, is exactly the failure mode
// this layer exists to prevent. Pure functions over `S`, so the maths is testable without a
// browser, a server or a model.
import { EXIDX } from './exercises.js'
import { exerciseNameFor } from './i18n.js'
import { workoutAt } from './history.js'
import { bestSetOf } from './onerm.js'
import { completedVolumeOf, hasCompletedWork, isWarmupRow } from './workout-model.js'
import { MUSCLES, MUSCLE_NAME, loadOf, rankOf } from './muscles.js'

const round1 = n => Math.round(Number(n) * 10) / 10

const exerciseOf = (S, exId) =>
  EXIDX[exId] || (S?.customEx || []).find(c => c && c.id === exId) || null

const workoutsInWindow = (S, days) => {
  const timed = (S?.workouts || [])
    .map(w => ({ w, t: workoutAt(w) }))
    .filter(x => Number.isFinite(x.t))
  if (!timed.length) return []
  // Anchored to the newest session, not the wall clock: a seeded demo whose timestamps slide,
  // or an imported log from last month, still shows its real recent load instead of an empty
  // card. With no history there is nothing to anchor to and the window is empty.
  const anchor = Math.max(...timed.map(x => x.t))
  const from = anchor - days * 86400000
  return timed.filter(x => x.t >= from && x.t <= anchor)
}

/** Top completed work weight in one entry, warm-ups and unticked rows excluded. */
function topWeightOf(entry) {
  let top = 0
  for (const set of entry?.sets || []) {
    if (!hasCompletedWork(set) || isWarmupRow(set)) continue
    const w = Number(set.w) || 0
    if (w > top) top = w
  }
  return top
}

function entriesOf(workout, exId) {
  return (workout?.entries || []).filter(entry => entry && entry.id === exId)
}

/**
 * One lift's trend over the last `weeks` weeks, from the real log.
 *
 * `metric` is `e1rm` (estimated one-rep max), `weight` (heaviest completed work set) or `volume`
 * (that session's volume for the exercise). Points are time-sorted; `stalled` says the last two
 * sessions both failed to beat the one before them, which is the shape a plateau makes.
 */
export function hydrateExerciseTrend(S, { exId, metric = 'e1rm', weeks = 8 } = {}) {
  const ex = exerciseOf(S, exId)
  const span = Number.isFinite(Number(weeks)) && Number(weeks) > 0 ? Number(weeks) : 8
  const method = ['e1rm', 'weight', 'volume'].includes(metric) ? metric : 'e1rm'
  const points = workoutsInWindow(S, span * 7)
    .map(({ w, t }) => {
      const entries = entriesOf(w, exId)
      if (!entries.length) return null
      let y = null
      if (method === 'e1rm') {
        for (const entry of entries) {
          const best = bestSetOf(entry)
          if (best && (y == null || best.est > y)) y = best.est
        }
      } else if (method === 'weight') {
        for (const entry of entries) {
          const wgt = topWeightOf(entry)
          if (wgt > 0 && (y == null || wgt > y)) y = wgt
        }
      } else {
        y = entries.reduce((sum, entry) =>
          sum + (entry.sets || []).reduce((n, set) => n + (isWarmupRow(set) ? 0 : completedVolumeOf(set)), 0), 0)
        if (!(y > 0)) y = null
      }
      return y == null ? null : { t, d: w.d || null, y: round1(y) }
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t)

  const sessions = points.length
  const first = sessions ? points[0].y : null
  const last = sessions ? points[sessions - 1].y : null
  const delta = sessions ? round1(last - first) : null
  const pct = sessions && first ? Math.round((last - first) / first * 100) : 0
  const stalled = sessions >= 3 &&
    !(points[sessions - 1].y > points[sessions - 2].y) &&
    !(points[sessions - 2].y > points[sessions - 3].y)

  return {
    exId,
    name: ex ? exerciseNameFor(ex) : String(exId || ''),
    metric: method,
    weeks: span,
    points,
    sessions,
    first,
    last,
    delta,
    pct,
    stalled,
  }
}

const WINDOW_DAYS = { '72h': 3, '7d': 7, '28d': 28 }

/**
 * Effective work-set load per muscle over a window, from finished workouts only.
 * `focusSummary` names the requested muscles (or the hardest-worked ones when none are named)
 * with the sets behind each shade of the body map.
 */
export function hydrateMuscleLoad(S, { window = '72h', focusMuscles = [] } = {}) {
  const key = WINDOW_DAYS[window] ? window : '72h'
  const days = WINDOW_DAYS[key]
  const timed = workoutsInWindow(S, days)

  const load = loadOf(timed.flatMap(({ w }) => (w.entries || []).map(entry => ({
    id: entry.id,
    ex: entry.exercise || entry,
    sets: (entry.sets || []).filter(set => hasCompletedWork(set) && !isWarmupRow(set)).length,
  }))))

  const totalSets = timed.reduce((sum, { w }) => {
    const sets = (w.entries || []).reduce((n, entry) =>
      n + (entry.sets || []).filter(set => hasCompletedWork(set) && !isWarmupRow(set)).length, 0)
    return sum + sets
  }, 0)

  const asked = (focusMuscles || []).filter(m => MUSCLES.includes(m))
  const focus = asked.length ? asked : rankOf(load).worked.slice(0, 5)
  const focusSummary = focus.map(muscle => ({
    muscle,
    label: MUSCLE_NAME[muscle] || muscle,
    sets: round1(load[muscle] || 0),
  }))

  return { window: key, load, focusSummary, totalSets, sessions: timed.length }
}

/**
 * The swaps a block may offer, narrowed to exercises this build really has. A catalogue id the
 * model made up is dropped rather than drawn as an empty card; a custom exercise the profile
 * owns is kept, since it is just as real, but it carries no shipped media.
 */
export function hydrateExerciseAlternatives(S, { forExId, routineId = null, items = [] } = {}) {
  const hydrated = []
  for (const item of items || []) {
    const exId = item?.exId
    const ex = exerciseOf(S, exId)
    if (!ex) continue
    hydrated.push({
      exId,
      name: exerciseNameFor(ex) || String(exId),
      bp: ex.bp || null,
      eq: ex.eq || '',
      reason: item.reason || '',
      tag: item.tag || ex.eq || '',
      routineId: item.routineId || routineId || null,
      hasMedia: !!EXIDX[exId],
    })
  }
  return { forExId: forExId || null, routineId, items: hydrated }
}

/**
 * Resolve one exercise id to the localized name a table cell or KPI label may safely print.
 * Only the catalogue and the profile's own custom exercises exist; anything else is null and
 * the caller falls back to the cell's own note.
 */
export function resolveExerciseRef(S, exId) {
  const ex = exerciseOf(S, exId)
  if (!ex) return null
  return {
    exId,
    name: exerciseNameFor(ex) || String(exId),
    bp: ex.bp || null,
    eq: ex.eq || '',
    hasMedia: !!EXIDX[exId],
    ex,
  }
}

/**
 * Hydrate a `kpi_strip` node from the local log.
 *
 * Real statistics (`exercise_stat`, `muscle_sets`, `session_count`) are computed here; a
 * `prescription` (`4×8`, `RIR 2`) is the model's own short label and passes through untouched.
 * Nothing is ever named `NaN`: an empty log yields null values and `hasData: false`, which the
 * strip draws as an en dash.
 */
export function hydrateKpiStrip(S, { items = [] } = {}) {
  const hydratedItems = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    const kind = item.kind

    if (kind === 'exercise_stat') {
      const trend = hydrateExerciseTrend(S, {
        exId: item.exId,
        metric: item.metric || 'e1rm',
        weeks: item.weeks || 6,
      })
      hydratedItems.push({
        kind: 'exercise_stat',
        exId: item.exId,
        metric: trend.metric,
        weeks: trend.weeks,
        label: item.label || trend.name || String(item.exId || ''),
        value: trend.last,
        unit: S?.unit || 'kg',
        delta: trend.delta,
        pct: trend.pct,
        stalled: trend.stalled,
        sessions: trend.sessions,
        hasData: trend.last != null,
      })
      continue
    }

    if (kind === 'muscle_sets') {
      const hydrated = hydrateMuscleLoad(S, {
        window: item.window || '72h',
        focusMuscles: item.muscle ? [item.muscle] : [],
      })
      const muscle = item.muscle
      const sets = round1(loadEntry(hydrated.load, muscle))
      hydratedItems.push({
        kind: 'muscle_sets',
        muscle,
        window: hydrated.window,
        label: item.label || MUSCLE_NAME[muscle] || muscle || '',
        value: sets,
        sessions: hydrated.sessions,
        hasData: hydrated.sessions > 0,
      })
      continue
    }

    if (kind === 'session_count') {
      const raw = Number(item.weeks)
      const span = Number.isFinite(raw) && raw > 0 ? raw : 4
      const count = workoutsInWindow(S, span * 7).length
      hydratedItems.push({
        kind: 'session_count',
        weeks: span,
        label: item.label || '',
        value: count,
        hasData: count > 0,
      })
      continue
    }

    if (kind === 'prescription') {
      hydratedItems.push({
        kind: 'prescription',
        label: String(item.label || ''),
        value: String(item.value ?? ''),
        hasData: Boolean(item.value != null && String(item.value).trim()),
      })
      continue
    }
  }
  return { items: hydratedItems }
}

const loadEntry = (load, muscle) => (muscle ? load?.[muscle] || 0 : 0)
