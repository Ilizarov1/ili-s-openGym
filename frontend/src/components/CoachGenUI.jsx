// The controlled component catalogue behind the Coach's generative UI.
//
// The model sends data, never code: one of five flat block types, each a small declared
// parameter set. Every visual value is hydrated here from the real training log
// (lib/coach-genui-hydration.js), and the only write a block can offer is a whitelisted change
// set applied through lib/coach.js — snapshot, atomic apply, undo. An unknown block degrades to
// a quiet notice; it never takes the surface down with it.
//
// v2 adds a flat, ordered narrative: `nodes[]` interleaves prose with the same block types and
// five light primitives (kpi_strip, comparison_table, checklist, callout, prose), drawn as one
// single-column briefing (GenUIBriefing). GenUISurface stays for old messages, demo streams and
// the existing tests; both share every block renderer.
import { useEffect, useMemo, useState } from 'react'
import { t, tn, exerciseNameFor, useLang } from '../lib/i18n.js'
import { fmtNum, DAYN } from '../lib/format.js'
import Icon from './Icon.jsx'
import LineChart from './LineChart.jsx'
import BodyMap from './BodyMap.jsx'
import { Thumb } from './Media.jsx'
import { Button, Check } from './ui.jsx'
import { EXIDX } from '../lib/exercises.js'
import {
  markStale, applicable, applyChangeSet, planHash, changeTitle, changeValues, exTitle,
} from '../lib/coach.js'
import {
  hydrateExerciseTrend, hydrateMuscleLoad, hydrateExerciseAlternatives,
  hydrateKpiStrip, resolveExerciseRef,
} from '../lib/coach-genui-hydration.js'

const num = n => (Number.isFinite(n) ? fmtNum(n) : '–')
const cap = s => String(s || '').replace(/(^|[\s(])(\p{L})/gu, (m, sp, ch) => sp + ch.toUpperCase())

// What one exercise of a proposed routine will be created as, in the app's own notation: minutes
// and pace for cardio, a hold in seconds, sets × reps (a range when the Coach gave one) otherwise.
const formatRx = e => {
  if (!e) return ''
  if (e.mode === 'cardio') return e.speed != null ? `${e.min || 20} min · ${e.speed}` : `${e.min || 20} min`
  if (e.mode === 'time') return `${e.sets || 3}×${e.sec || 45}s`
  return Number.isInteger(e.repsMin) && Number.isInteger(e.repsMax)
    ? `${e.sets || 3}×${e.repsMin}-${e.repsMax}`
    : `${e.sets || 3}×${e.reps || 10}`
}

// Body parts the catalogue uses, as the translation keys the rest of the app already ships.
const BP_KEY = {
  back: 'Back muscles', cardio: 'Cardio', chest: 'Chest', 'lower arms': 'Forearms',
  'lower legs': 'Calves', neck: 'Neck', shoulders: 'Shoulders', 'upper arms': 'Arms',
  'upper legs': 'Legs', waist: 'Abs', other: 'Other',
}
const bpLabel = bp => t(BP_KEY[bp] || 'Other')

// Equipment the catalogue stores lower-case, with a real entry in every locale pack. A tag that
// is not one of these (a model's free text, a custom exercise's own label) is shown as sent.
const EQ_TAG_KEYS = new Set([
  'dumbbell', 'barbell', 'cable', 'body weight', 'kettlebell', 'band',
  'leverage machine', 'smith machine',
])
const eqLabel = tag => {
  const key = String(tag || '').toLowerCase()
  return EQ_TAG_KEYS.has(key) ? cap(t(key)) : tag
}

const TREND_METRICS = [
  ['e1rm', '1RM'],
  ['weight', 'Weight'],
  ['volume', 'Volume'],
]
const TREND_WEEKS = [4, 8, 12, 24]
const LOAD_WINDOWS = ['72h', '7d', '28d']

/* ============================== live progress ============================== */

const STEP_I18N = {
  prepare: () => t('Reading your training…'),
  analyze: () => t('Analyzing your training log'),
  catalogue: () => t('Suggested swaps'),
  compose: () => t('Thinking about your question…'),
  validate: () => t('Reading your training…'),
}

/** The compact strip above a live answer: which phase is running, and a way out of it. */
export function StreamStepsBar({ steps = [], activeTool = null, onStop }) {
  return <div className="genui-steps" role="status" aria-live="polite">
    <div className="genui-steps-track">
      {steps.map((step, i) => {
        const label = STEP_I18N[step.stepName] ? STEP_I18N[step.stepName]() : step.label
        return <span key={step.stepName || i} className={'genui-step' + (step.done ? ' done' : ' live')}>
          {step.done ? <Icon name="check" /> : <i className="genui-dot" aria-hidden="true" />}
          <span>{label}</span>
        </span>
      })}
      {(activeTool || !steps.length) && <span className="genui-step live">
        <i className="genui-dot" aria-hidden="true" /><span>{activeTool === 'search_catalogue' ? t('Searching exercise library…') : t('thinking…')}</span>
      </span>}
    </div>
    {onStop && <button type="button" className="genui-stop" onClick={onStop}>
      <Icon name="xmark" />{t('Stop')}
    </button>}
  </div>
}

/** Smooth shimmer skeleton shown while streaming before the first GenUI card lands.
 *  `steps`/`activeTool` drive the extra placeholder sections, and `hasText` lets the caller say
 *  whether the live bubble already carries prose while the cards are still composing. */
export function GenUISkeleton({ steps = [], activeTool = null, hasText = false }) {
  const rows = !!activeTool || !hasText || steps.length > 0
  return <div className="genui-skel-wrap" aria-hidden="true">
    <div className="genui-card genui-skel">
      <div className="genui-skel-line short" />
      <div className="genui-skel-line title" />
      <div className="genui-skel-box" />
      <div className="genui-skel-row">
        <span className="genui-skel-pill" />
        <span className="genui-skel-pill" />
        {activeTool && <span className="genui-skel-pill" />}
      </div>
    </div>
    {rows && <div className="genui-card genui-skel genui-skel-rows">
      <div className="genui-skel-line short" />
      <div className="genui-skel-row">
        <span className="genui-skel-avatar" />
        <span className="genui-skel-line mid" />
      </div>
      <div className="genui-skel-row">
        <span className="genui-skel-avatar" />
        <span className="genui-skel-line mid" />
      </div>
      <div className="genui-skel-row">
        <span className="genui-skel-pill" />
        <span className="genui-skel-pill" />
      </div>
    </div>}
  </div>
}

/**
 * A type-matched micro-skeleton for one node while it is composing. Small on purpose: the
 * briefing already holds the prose, so this only reserves the shape of the thing arriving.
 */
export function GenUINodePending({ type = 'prose' }) {
  const kind = type || 'prose'
  if (kind === 'kpi_strip') {
    return <div className="genui-pending genui-pending-kpi" aria-hidden="true">
      <span className="genui-skel-pill" />
      <span className="genui-skel-pill" />
      <span className="genui-skel-pill" />
    </div>
  }
  if (kind === 'exercise_trend' || kind === 'muscle_load') {
    return <div className="genui-pending genui-pending-box" aria-hidden="true">
      <span className="genui-pending-line short" />
      <span className="genui-pending-block" />
    </div>
  }
  if (kind === 'comparison_table') {
    return <div className="genui-pending genui-pending-rows" aria-hidden="true">
      <span className="genui-pending-line short" />
      <span className="genui-pending-line mid" />
      <span className="genui-pending-line mid" />
      <span className="genui-pending-line mid" />
    </div>
  }
  if (kind === 'checklist') {
    return <div className="genui-pending genui-pending-rows" aria-hidden="true">
      <span className="genui-pending-line short" />
      <span className="genui-pending-line mid" />
      <span className="genui-pending-line mid" />
    </div>
  }
  if (kind === 'callout') {
    return <div className="genui-pending genui-pending-callout" aria-hidden="true">
      <span className="genui-pending-line mid" />
    </div>
  }
  return <div className="genui-pending genui-pending-prose" aria-hidden="true">
    <span className="genui-pending-line mid" />
  </div>
}

/* ============================== the surface ============================== */

/**
 * Draw a flat list of blocks. `S`, `update`, `toast` and the callbacks come from CoachChat, so
 * a block in history behaves exactly like one still streaming.
 */
export function GenUISurface({ blocks = [], S, update, toast, onSubmitForm, onAppliedProposal, messageId }) {
  if (!Array.isArray(blocks) || !blocks.length) return null
  return <div className="genui" data-message={messageId || undefined}>
    {blocks.map((block, i) => <div key={block?.id || i} className="genui-item" style={{ '--genui-i': i }}>
      <GenUIBlock block={block} S={S} update={update}
        toast={toast} onSubmitForm={onSubmitForm} onAppliedProposal={onAppliedProposal} />
    </div>)}
  </div>
}

function GenUIBlock({ block, S, update, toast, onSubmitForm, onAppliedProposal }) {
  if (!block || typeof block !== 'object') return <FallbackNoticeBlock block={{}} />
  switch (block.type) {
    case 'exercise_trend': return <ExerciseTrendBlock block={block} S={S} />
    case 'muscle_load': return <MuscleLoadBlock block={block} S={S} />
    case 'exercise_alternatives': return <ExerciseAlternativesBlock block={block} S={S} onSubmitForm={onSubmitForm} />
    case 'quick_form': return <QuickFormBlock block={block} onSubmitForm={onSubmitForm} />
    case 'proposal_action': return <ProposalActionBlock block={block} S={S} update={update} toast={toast} onAppliedProposal={onAppliedProposal} />
    default: return <FallbackNoticeBlock block={block} />
  }
}

/* ============================== v2 narrative briefing ============================== */

/**
 * The ordered node list behind any `kind: 'genui'` message. v2 messages carry `nodes`; v1
 * messages still carry `{ text, blocks }`, which become one prose node followed by the blocks.
 * No migration, no lost history.
 */
export function normalizeGenUINodes(message) {
  if (Array.isArray(message?.nodes) && message.nodes.length > 0) return message.nodes
  return [
    ...(message?.text ? [{ id: 'prose_0', type: 'prose', text: message.text }] : []),
    ...(Array.isArray(message?.blocks) ? message.blocks : []),
  ]
}

/**
 * One continuous column: prose and primitives arrive in the order the model wrote them.
 * Every subcomponent is declared at module scope so a streaming update never remounts the
 * composer or resets an inline control.
 */
export function GenUIBriefing({
  nodes = [], pendingNode = null, streaming = false, S, update, toast,
  onSubmitForm, onAppliedProposal, onToggleChecklist, checkedMap = {}, messageId,
}) {
  useLang()
  const list = Array.isArray(nodes) ? nodes : []
  const cursorAt = streaming && !pendingNode ? list.length - 1 : -1
  return <div className="genui-briefing" data-message={messageId || undefined}>
    {list.map((node, i) => {
      if (!node || typeof node !== 'object') return null
      return <GenUINode key={node.id || 'node_' + i} node={node} S={S} update={update} toast={toast}
        onSubmitForm={onSubmitForm} onAppliedProposal={onAppliedProposal}
        onToggleChecklist={onToggleChecklist} checkedMap={checkedMap} cursor={i === cursorAt} />
    })}
    {pendingNode && <GenUINodePending type={pendingNode.nodeType || pendingNode.type} />}
  </div>
}

function GenUINode({ node, S, update, toast, onSubmitForm, onAppliedProposal, onToggleChecklist, checkedMap, cursor }) {
  switch (node.type) {
    case 'prose': return <ProseNode node={node} cursor={cursor} />
    case 'kpi_strip': return <KpiStripNode node={node} S={S} />
    case 'comparison_table': return <ComparisonTableNode node={node} S={S} />
    case 'checklist': return <ChecklistNode node={node} checkedMap={checkedMap} onToggleChecklist={onToggleChecklist} />
    case 'callout': return <CalloutNode node={node} />
    case 'exercise_trend': return <ExerciseTrendBlock block={node} S={S} embedded />
    case 'muscle_load': return <MuscleLoadBlock block={node} S={S} embedded />
    case 'exercise_alternatives': return <ExerciseAlternativesBlock block={node} S={S} onSubmitForm={onSubmitForm} />
    case 'quick_form': return <QuickFormBlock block={node} onSubmitForm={onSubmitForm} />
    case 'proposal_action': return <ProposalActionBlock block={node} S={S} update={update} toast={toast} onAppliedProposal={onAppliedProposal} />
    case 'fallback_notice': return <FallbackNoticeBlock block={node} />
    default: return null
  }
}

/* ---------- 1. prose ---------- */

function ProseNode({ node, cursor }) {
  const tone = node.tone && node.tone !== 'normal' ? ' tone-' + node.tone : ''
  return <p className={'genui-prose' + tone}>
    {node.text}
    {cursor && <span className="genui-cursor" aria-hidden="true" />}
  </p>
}

/* ---------- 2. kpi strip ---------- */

function KpiStripNode({ node, S }) {
  const langVer = useLang()
  const data = useMemo(() => hydrateKpiStrip(S, node), [S, node, langVer])
  if (!data.items.length) return null
  return <div className="genui-kpi-strip">
    {data.items.map((item, i) => <KpiItem key={(item.kind || 'kpi') + '_' + i} item={item} />)}
  </div>
}

function KpiItem({ item }) {
  const has = !!item.hasData
  const value = item.kind === 'prescription' ? (item.value || '–') : (has ? num(item.value) : '–')
  // Muscle names are the app's own translation keys; exercise names and prescriptions are not.
  const label = item.kind === 'muscle_sets' && item.label ? t(item.label) : item.label
  return <div className="genui-kpi-item" data-kind={item.kind}>
    <div className="genui-kpi-l">{label || (item.kind === 'session_count' ? t('Sessions') : '')}</div>
    <div className="genui-kpi-v">
      {item.kind === 'muscle_sets' && has
        ? <span className="genui-kpi-n">{t('{0} sets', num(item.value))}</span>
        : <span className="genui-kpi-n">{value}</span>}
      {item.kind === 'exercise_stat' && has && !!item.unit && <span className="genui-kpi-u">{item.unit}</span>}
    </div>
    <div className="genui-kpi-meta">
      {item.kind === 'exercise_stat' && has && <>
        <span className={'genui-kpi-delta' + (item.delta > 0 ? ' up' : item.delta < 0 ? ' down' : '')}>
          {item.delta > 0 ? '▲' : item.delta < 0 ? '▼' : '•'} {Math.abs(item.pct || 0)}%
        </span>
        {item.stalled && <span className="genui-stall">{t('Stalled')}</span>}
      </>}
      {item.kind === 'muscle_sets' && <span className="genui-kpi-tag">{t(item.window)}</span>}
      {item.kind === 'session_count' && <span className="genui-kpi-tag">{t('{0}w', item.weeks)}</span>}
    </div>
  </div>
}

/* ---------- 3. comparison table ---------- */

function ComparisonTableNode({ node, S }) {
  const langVer = useLang()
  const columns = Array.isArray(node.columns) ? node.columns : []
  const rows = Array.isArray(node.rows) ? node.rows : []
  if (!columns.length || !rows.length) return null
  return <section className="genui-table-wrap" data-lang={langVer}>
    <div className="genui-table-h">{node.title || t('Comparison')}</div>
    <table className="genui-table">
      <thead>
        <tr>{columns.map((c, i) => <th key={i} scope="col">{String(c ?? '')}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, r) => {
          const cells = Array.isArray(row) ? row : []
          return <tr key={r}>
            {columns.map((_, c) => <td key={c}><TableCell cell={cells[c]} S={S} /></td>)}
          </tr>
        })}
      </tbody>
    </table>
  </section>
}

function TableCell({ cell, S }) {
  if (cell && typeof cell === 'object' && cell.exId != null) {
    const ref = resolveExerciseRef(S, cell.exId)
    if (ref) {
      return <span className="genui-cell-ex">
        {ref.hasMedia && <Thumb ex={ref.ex} id={ref.exId} size={24} />}
        <span className="genui-cell-n">{ref.name}</span>
        {!!cell.note && <span className="genui-cell-note">{cell.note}</span>}
      </span>
    }
    return <span className="genui-cell-unknown">{cell.note || '–'}</span>
  }
  return <>{cell == null ? '' : String(cell)}</>
}

/* ---------- 4. checklist (read-only numbered steps for legacy compatibility) ---------- */

function ChecklistNode({ node }) {
  useLang()
  const items = (Array.isArray(node.items) ? node.items : []).filter(item => item && item.label)
  if (!items.length) return null
  return <section className="genui-checklist">
    {!!node.title && <header className="genui-checklist-hd">
      <span className="genui-checklist-t">{node.title}</span>
    </header>}
    <ol className="genui-steps-list">
      {items.map((item, idx) => <li key={item.id ?? idx} className="genui-step-item">
        <span className="genui-step-num" aria-hidden="true">{idx + 1}</span>
        <span className="genui-check-m">
          <span className="genui-check-label">{item.label}</span>
          {!!item.detail && <span className="genui-check-detail">{item.detail}</span>}
        </span>
      </li>)}
    </ol>
  </section>
}

/* ---------- 5. callout ---------- */

const CALLOUT_ICON = { info: 'info', tip: 'lightbulb', warning: 'warning' }

function CalloutNode({ node }) {
  const variant = CALLOUT_ICON[node.variant] ? node.variant : 'info'
  return <div className={'genui-callout is-' + variant} role="note">
    <Icon name={CALLOUT_ICON[variant]} />
    <div className="genui-callout-m">
      {!!node.title && <div className="genui-callout-t">{node.title}</div>}
      <div className="genui-callout-x">{node.text}</div>
    </div>
  </div>
}

/* ============================== 1. exercise trend ============================== */

function ExerciseTrendBlock({ block, S, embedded = false }) {
  const langVer = useLang()
  const [metric, setMetric] = useState(() => block.metric || 'e1rm')
  const [weeks, setWeeks] = useState(() => block.weeks || 8)
  const data = useMemo(() => hydrateExerciseTrend(S, {
    exId: block.exId,
    metric,
    weeks,
  }), [S?.workouts, S?.customEx, block.exId, metric, weeks, langVer])

  const unit = S?.unit || ''
  const metricLabel = data.metric === 'weight' ? t('Weight')
    : data.metric === 'volume' ? t('Volume ({0})', unit)
      : t('Estimated 1RM')
  const deltaCls = data.delta > 0 ? 'up' : data.delta < 0 ? 'down' : ''

  return <section className={'genui-card' + (embedded ? ' genui-embedded' : '')} data-block-type="exercise_trend">
    <header className="genui-card-hd">
      <div className="genui-eyebrow">{metricLabel}</div>
      <h3 className="genui-h">{block.title || data.name}</h3>
      {!!block.caption && <p className="genui-cap">{block.caption}</p>}
    </header>
    <div className="genui-seg-row">
      <div className="genui-seg" role="group" aria-label={metricLabel}>
        {TREND_METRICS.map(([value, key]) => <button key={value} type="button"
          className={'genui-seg-btn' + (metric === value ? ' on' : '')}
          aria-pressed={metric === value} onClick={() => setMetric(value)}>{t(key)}</button>)}
      </div>
      <div className="genui-seg" role="group" aria-label={t('{0}w', weeks)}>
        {TREND_WEEKS.map(w => <button key={w} type="button"
          className={'genui-seg-btn' + (Number(weeks) === w ? ' on' : '')}
          aria-pressed={Number(weeks) === w} onClick={() => setWeeks(w)}>{t('{0}w', w)}</button>)}
      </div>
    </div>
    {data.sessions >= 2 ? <>
      <div className="genui-kpis">
        <span className="genui-kpi-l">{t('first → last session')}</span>
        <span className="genui-kpi-v">
          <span className="tag">{num(data.first)}</span>
          <Icon name="chevronRight" />
          <span className="tag acc">{num(data.last)}</span>
          {unit ? <span className="genui-unit">{unit}</span> : null}
        </span>
        <span className={'ins-delta ' + deltaCls}>
          {data.delta > 0 ? '▲' : data.delta < 0 ? '▼' : '•'} {Math.abs(data.pct)}%
        </span>
        {data.stalled && <span className="genui-stall">{t('Stalled')}</span>}
      </div>
      <div className="genui-chart"><LineChart points={data.points} h={140} unit={unit} /></div>
      <div className="genui-foot">{tn('{0} session', '{0} sessions', data.sessions)}</div>
    </> : <div className="genui-empty">
      <Icon name="chartLine" />
      <span>{t('Not enough history to draw a trend yet.')}</span>
    </div>}
  </section>
}

/* ============================== 2. muscle load ============================== */

function MuscleLoadBlock({ block, S, embedded = false }) {
  const langVer = useLang()
  const [win, setWin] = useState(() => (block.window && LOAD_WINDOWS.includes(block.window) ? block.window : '72h'))
  const data = useMemo(() => hydrateMuscleLoad(S, {
    window: win,
    focusMuscles: block.focusMuscles || [],
  }), [S?.workouts, S?.customEx, win, block.focusMuscles, langVer])

  return <section className={'genui-card' + (embedded ? ' genui-embedded' : '')} data-block-type="muscle_load">
    <header className="genui-card-hd">
      <div className="genui-eyebrow">{t(data.window)}</div>
      <h3 className="genui-h">{block.title || t('Muscle load')}</h3>
      {!!block.caption && <p className="genui-cap">{block.caption}</p>}
    </header>
    <div className="genui-seg-row">
      <div className="genui-seg" role="group" aria-label={t('Muscle load')}>
        {LOAD_WINDOWS.map(w => <button key={w} type="button"
          className={'genui-seg-btn' + (win === w ? ' on' : '')}
          aria-pressed={win === w} onClick={() => setWin(w)}>{t(w)}</button>)}
      </div>
    </div>
    <div className="genui-muscle">
      <BodyMap load={data.load} className="genui-map" />
      <div className="genui-focus">
        <div className="genui-focus-h">{t('Focus muscles')}</div>
        {data.focusSummary.length
          ? data.focusSummary.map(item => <div key={item.muscle} className="genui-focus-row">
            <span className="genui-focus-n">{t(item.label)}</span>
            <span className="genui-focus-v">{num(item.sets)}</span>
          </div>)
          : <div className="genui-empty small">{t('No data yet')}</div>}
        <div className="genui-foot">{t('{0} sets', data.totalSets)}</div>
      </div>
    </div>
  </section>
}

/* ============================== 3. alternatives ============================== */

function ExerciseAlternativesBlock({ block, S, onSubmitForm }) {
  const langVer = useLang()
  const data = useMemo(() => hydrateExerciseAlternatives(S, {
    forExId: block.forExId,
    routineId: block.routineId,
    items: block.items || [],
  }), [S?.customEx, block.forExId, block.routineId, block.items, langVer])
  const targetEx = block.forExId ? (EXIDX[block.forExId] || (S?.customEx || []).find(c => c?.id === block.forExId)) : null
  const targetName = targetEx ? exerciseNameFor(targetEx) : (block.forExId || '')

  return <section className="genui-card">
    <header className="genui-card-hd">
      <div className="genui-eyebrow">{t('Suggested swaps')}</div>
      <h3 className="genui-h">{block.title || t('Suggested swaps')}</h3>
    </header>
    {data.items.length
      ? <div className="genui-alts">
        {data.items.map(item => {
          const ex = EXIDX[item.exId] || (S?.customEx || []).find(c => c?.id === item.exId) || { id: item.exId, n: item.name }
          return <div key={item.exId} className="genui-alt">
            <Thumb ex={ex} id={item.exId} />
            <div className="genui-alt-m">
              <div className="genui-alt-t">{item.name}</div>
              {!!item.reason && <div className="genui-alt-r">{item.reason}</div>}
              <div className="genui-alt-tags">
                {!!item.tag && <span className="tag">{eqLabel(item.tag)}</span>}
                {!!item.bp && <span className="tag">{bpLabel(item.bp)}</span>}
              </div>
            </div>
            {onSubmitForm && <button type="button" className="genui-alt-btn"
              onClick={() => onSubmitForm({
                formId: 'swap_choice',
                title: block.title,
                values: { exId: item.exId, forExId: block.forExId, routineId: item.routineId },
                summaryText: t('Swap {0} for {1}', cap(targetName), cap(item.name)),
              })}>{t('Swap {0} for {1}', cap(targetName), cap(item.name))}</button>}
          </div>
        })}
      </div>
      : <div className="genui-empty"><Icon name="swap" /><span>{t('No data yet')}</span></div>}
  </section>
}

/* ============================== 4. quick form ============================== */

function QuickFormBlock({ block, onSubmitForm }) {
  const fields = Array.isArray(block.fields) ? block.fields : []
  const [values, setValues] = useState({})
  const [sent, setSent] = useState(false)

  const setOne = (name, value) => setValues(v => ({ ...v, [name]: value }))
  const toggle = (name, value) => setValues(v => {
    const cur = Array.isArray(v[name]) ? v[name] : []
    return { ...v, [name]: cur.includes(value) ? cur.filter(x => x !== value) : [...cur, value] }
  })
  const display = (field, value) => {
    if (Array.isArray(value)) return value.map(x => labelOf(field, x)).join(', ')
    return labelOf(field, value)
  }
  const labelOf = (field, value) => (field.options || []).find(o => o.value === value)?.label ?? String(value)

  const submit = () => {
    if (sent) return
    const parts = fields
      .map(field => {
        const value = values[field.name]
        if (value == null || value === '' || (Array.isArray(value) && !value.length)) return null
        return `${field.label}: ${display(field, value)}`
      })
      .filter(Boolean)
    const summaryText = parts.length ? parts.join(' · ') : String(block.title || '')
    setSent(true)
    onSubmitForm?.({ formId: block.formId, title: block.title, values, summaryText })
  }

  return <section className="genui-card">
    <header className="genui-card-hd">
      <div className="genui-eyebrow">{t('Quick check')}</div>
      <h3 className="genui-h">{block.title || t('Quick check')}</h3>
    </header>
    <div className="genui-form">
      {fields.map(field => {
        const name = field.name
        const value = values[name]
        if (field.kind === 'single_choice') {
          return <div key={name} className="genui-field">
            <div className="genui-field-l">{field.label}</div>
            <div className="genui-chips">
              {(field.options || []).map(opt => <button key={opt.value} type="button" disabled={sent}
                className={'genui-chip' + (value === opt.value ? ' on' : '')}
                aria-pressed={value === opt.value} onClick={() => setOne(name, opt.value)}>{opt.label}</button>)}
            </div>
          </div>
        }
        if (field.kind === 'multi_choice') {
          const list = Array.isArray(value) ? value : []
          return <div key={name} className="genui-field">
            <div className="genui-field-l">{field.label}</div>
            <div className="genui-chips">
              {(field.options || []).map(opt => <button key={opt.value} type="button" disabled={sent}
                className={'genui-chip' + (list.includes(opt.value) ? ' on' : '')}
                aria-pressed={list.includes(opt.value)} onClick={() => toggle(name, opt.value)}>{opt.label}</button>)}
            </div>
          </div>
        }
        if (field.kind === 'scale') {
          const min = Number.isFinite(field.min) ? field.min : 1
          const max = Number.isFinite(field.max) ? field.max : 10
          const steps = []
          for (let n = min; n <= max; n++) steps.push(n)
          return <div key={name} className="genui-field">
            <div className="genui-field-l">{field.label}</div>
            <div className="genui-scale">
              {steps.map(n => <button key={n} type="button" disabled={sent}
                className={'genui-scale-btn' + (value === n ? ' on' : '')}
                aria-pressed={value === n} onClick={() => setOne(name, n)}>{n}</button>)}
            </div>
          </div>
        }
        return null
      })}
    </div>
    <div className="genui-card-ft">
      <Button variant="primary" icon={sent ? 'check' : 'arrowUp'} disabled={sent} onClick={submit}>
        {sent ? t('Answers sent') : (block.submitLabel || t('Send answers'))}
      </Button>
    </div>
  </section>
}

/* ============================== 5. proposal ============================== */

/**
 * What an `add-routine` change will create, shown before it is applied: the weekdays it lands on
 * (as pills) and every exercise with its prescription. Compact by construction — the name wraps,
 * the prescription never does — so it reads at 375px as well as on a wide screen.
 */
function RoutinePreview({ after }) {
  const days = Array.isArray(after?.weekdays)
    ? [...new Set(after.weekdays.filter(d => Number.isInteger(d) && d >= 0 && d <= 6))]
    : []
  const ex = Array.isArray(after?.ex) ? after.ex.filter(e => e && e.id) : []
  if (!days.length && !ex.length) return null
  return <div className="genui-routine-preview">
    {days.length > 0 && <div className="genui-routine-days">
      {days.map(d => <span key={d} className="tag">{t(DAYN[d])}</span>)}
    </div>}
    {ex.length > 0 && <div className="genui-routine-ex">
      {ex.map((e, i) => <div key={`${e.id}_${i}`} className="genui-routine-ex-row">
        <span className="genui-routine-ex-name">{exTitle(e.id)}</span>
        <span className="genui-routine-ex-rx">{formatRx(e)}</span>
      </div>)}
    </div>}
  </div>
}

function ProposalActionBlock({ block, S, update, toast, onAppliedProposal }) {
  const langVer = useLang()
  const proposal = useMemo(() => ({
    id: block.id || 'genui_proposal',
    kind: 'review',
    planHash: block.planHash || planHash(S),
    summary: block.summary || '',
    changes: Array.isArray(block.changes) ? block.changes : [],
  }), [block, S?.routines, S?.week, langVer])

  const marked = useMemo(() => markStale(proposal, S), [proposal, S, langVer])
  const usable = applicable(marked)
  const [accepted, setAccepted] = useState(() => new Set(usable.map(c => c.id)))
  const [applied, setApplied] = useState(() => Boolean(block?.applied))

  useEffect(() => { if (block?.applied) setApplied(true) }, [block?.applied])

  const toggle = id => setAccepted(set => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const apply = () => {
    if (applied) return
    const ids = [...accepted].filter(id => usable.some(c => c.id === id))
    if (!ids.length) return
    try {
      update(s => { applyChangeSet(s, marked, ids) })
      setApplied(true)
      toast?.(tn('{0} change applied', '{0} changes applied', ids.length))
      onAppliedProposal?.({ nodeId: block.id, ids, proposal: marked })
    } catch (e) {
      toast?.(e.message || t('Could not apply those changes'))
    }
  }

  return <section className="genui-card genui-proposal">
    <header className="genui-card-hd">
      <div className="genui-eyebrow">{t('Suggestions')}</div>
      <h3 className="genui-h">{block.title || t('Suggestions')}</h3>
      {!!proposal.summary && <p className="genui-cap">{proposal.summary}</p>}
      {!applied && marked.planMoved && <p className="genui-warn">
        {t('Your plan changed since the Coach looked at it. Suggestions that no longer match are greyed out. Ask for a fresh review to see them again.')}
      </p>}
    </header>
    <div className="genui-changes">
      {marked.changes.map(change => {
        const stale = !applied && change.status === 'stale'
        const vals = changeValues(change, S)
        return <div key={change.id} className={'pcard-chg' + (stale ? ' stale' : '')}>
          {!stale && !applied && <Check checked={accepted.has(change.id)} onChange={() => toggle(change.id)} />}
          <div className="grow">
            <div className="pcard-chg-t">{changeTitle(change, S)}</div>
            {vals && <div className="pcard-chg-v">
              <span className="tag">{vals.before}</span>
              <Icon name="chevronRight" />
              <span className="tag acc">{vals.after}</span>
            </div>}
            {change.type === 'add-routine' && change.after && <RoutinePreview after={change.after} />}
            {!!change.why && <div className="pcard-chg-w">{change.why}</div>}
            {stale && <div className="pcard-chg-stale">{t('Doesn’t match your plan any more, so it can’t be applied.')}</div>}
          </div>
        </div>
      })}
    </div>
    <div className="genui-card-ft">
      {applied
        ? <div className="genui-applied"><Icon name="checkCircle" />{t('Accepted')}</div>
        : <Button variant="primary" icon="check" disabled={!accepted.size || !usable.length} onClick={apply}>
          {accepted.size ? tn('Apply {0} change', 'Apply {0} changes', accepted.size) : t('Apply nothing')}
        </Button>}
      <div className="genui-foot">{t('Undo the last Coach changes')}</div>
    </div>
  </section>
}

/* ============================== fallback ============================== */

function FallbackNoticeBlock({ block }) {
  return <div className="genui-note" role="note">
    <Icon name="info" />
    <span>{block.text || t('Something went wrong on the server.')}</span>
  </div>
}

export default GenUISurface
