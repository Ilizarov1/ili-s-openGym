// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  GenUISurface, GenUISkeleton, StreamStepsBar,
  GenUIBriefing, GenUINodePending, normalizeGenUINodes,
} from './CoachGenUI.jsx'
import { _setLangState } from '../lib/i18n-core.js'

// Media and the body map bring their own asset loaders and store subscriptions; the surface's
// job here is the block contract, so they are replaced by their visible shape.
vi.mock('./Media.jsx', () => ({
  Thumb: ({ ex, id }) => <span className="thumb thumb-x" data-ex={id || ex?.id} />,
  default: () => null,
}))
vi.mock('./BodyMap.jsx', () => ({
  default: ({ load }) => <div className="bodymap" data-load={JSON.stringify(load || {})} />,
  BodyMapLegend: () => null,
}))

const DAY = 86400000
const now = Date.now()
const workout = (id, ago, w = 62.5) => ({
  id,
  d: new Date(now - ago * DAY).toISOString().slice(0, 10),
  start: now - ago * DAY,
  name: 'Push Day',
  entries: [{ id: '0025', sets: [{ w, r: 8, done: true }, { w, r: 8, done: true }, { w, r: 8, done: true }] }],
})

const baseState = () => ({
  unit: 'kg',
  workouts: [workout('w1', 21, 60), workout('w2', 14), workout('w3', 7), workout('w4', 1)],
  customEx: [],
  routines: [{ id: 'r1', name: 'Push Day', ex: [{ id: '0025', sets: 3, reps: 8 }] }],
  week: {},
  coach: { log: [], snapshots: [], chat: [] },
})

let root, container
const update = mut => { mut(S) }
let S

async function render(ui) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(ui) })
}
const text = () => container.textContent || ''
const buttons = () => [...container.querySelectorAll('button')]
const button = re => buttons().find(b => re.test(b.textContent || ''))
async function click(el) {
  expect(el).toBeTruthy()
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => { S = baseState() })
afterEach(async () => {
  _setLangState('en', null, null, null, true, false)
  if (root) { await act(async () => { root.unmount() }); root = null }
  container?.remove()
  container = null
})

describe('StreamStepsBar', () => {
  it('shows the live phase and a stop button that calls back', async () => {
    const onStop = vi.fn()
    await render(<StreamStepsBar steps={[{ stepName: 'analyze', label: 'Analyzing your training log', done: false }]}
      activeTool="training_log" onStop={onStop} />)
    expect(text()).toContain('Analyzing your training log')
    expect(container.querySelector('.genui-step.live')).toBeTruthy()
    await click(button(/Stop/))
    expect(onStop).toHaveBeenCalled()
  })

  it('says it is searching the library while that tool runs, and thinking for other tools', async () => {
    await render(<StreamStepsBar steps={[]} activeTool="search_catalogue" />)
    expect(text()).toContain('Searching exercise library…')
    expect(text()).not.toContain('thinking…')

    await act(async () => {
      root.render(<StreamStepsBar steps={[]} activeTool="training_log" />)
    })
    expect(text()).toContain('thinking…')
    expect(text()).not.toContain('Searching exercise library…')
  })
})

describe('GenUISkeleton', () => {
  it('renders multi-section shimmer placeholders that are hidden from assistive tech', async () => {
    await render(<GenUISkeleton steps={[{ stepName: 'analyze', done: false }]} activeTool="training_log" hasText={false} />)
    const wrap = container.querySelector('.genui-skel-wrap')
    expect(wrap).toBeTruthy()
    expect(wrap.getAttribute('aria-hidden')).toBe('true')
    expect(container.querySelectorAll('.genui-skel')).toHaveLength(2)
    expect(container.querySelector('.genui-skel .genui-skel-box')).toBeTruthy()
    expect(container.querySelectorAll('.genui-skel-avatar')).toHaveLength(2)
    expect(container.querySelectorAll('.genui-skel-line').length).toBeGreaterThan(3)
  })

  it('keeps only the visual card once prose is streaming without active tools', async () => {
    await render(<GenUISkeleton hasText />)
    expect(container.querySelectorAll('.genui-skel')).toHaveLength(1)
    expect(container.querySelector('.genui-skel-box')).toBeTruthy()
    expect(container.querySelector('.genui-skel-avatar')).toBeFalsy()
  })
})

describe('GenUISurface transitions', () => {
  it('marks each block with a staggered transition index', async () => {
    await render(<GenUISurface S={S} update={update} blocks={[
      { id: 'b1', type: 'fallback_notice', text: 'one' },
      { id: 'b2', type: 'fallback_notice', text: 'two' },
      { id: 'b3', type: 'fallback_notice', text: 'three' },
    ]} />)
    const items = [...container.querySelectorAll('.genui-item')]
    expect(items).toHaveLength(3)
    expect(items.map(el => el.style.getPropertyValue('--genui-i'))).toEqual(['0', '1', '2'])
  })
})

describe('exercise_trend block', () => {
  it('hydrates the KPI header and chart from the log', async () => {
    await render(<GenUISurface S={S} update={update} blocks={[{
      id: 'blk_trend_1', type: 'exercise_trend', exId: '0025', metric: 'e1rm', weeks: 8, title: 'Bench trend',
    }]} />)
    expect(text()).toContain('Bench trend')
    expect(text()).toContain('first → last session')
    expect(container.querySelector('.chart-i svg')).toBeTruthy()
    expect(container.querySelector('.genui-kpis')).toBeTruthy()
  })

  it('shows the empty hint instead of a chart with fewer than two sessions', async () => {
    const one = { ...S, workouts: [workout('only', 1)] }
    await render(<GenUISurface S={one} update={update} blocks={[{
      id: 'blk_trend_1', type: 'exercise_trend', exId: '0025', metric: 'e1rm', weeks: 8,
    }]} />)
    expect(text()).toContain('Not enough history to draw a trend yet.')
    expect(container.querySelector('.chart-i')).toBeFalsy()
  })

  it('falls back to the localized exercise name when the block has no title', async () => {
    _setLangState('zh', {}, null, { '0025': '杠铃卧推' }, false, false)
    await render(<GenUISurface S={S} update={update} blocks={[{
      id: 'blk_trend_zh', type: 'exercise_trend', exId: '0025', metric: 'e1rm', weeks: 8,
    }]} />)
    expect(container.querySelector('.genui-h').textContent).toBe('杠铃卧推')
  })
})

describe('muscle_load block', () => {
  it('renders the body map and the focus muscle set counts', async () => {
    await render(<GenUISurface S={S} update={update} blocks={[{
      id: 'blk_muscle_1', type: 'muscle_load', window: '72h', focusMuscles: ['chest', 'triceps'],
    }]} />)
    expect(container.querySelector('.bodymap')).toBeTruthy()
    expect(text()).toContain('Muscle load')
    expect(text()).toContain('Focus muscles')
    expect(text()).toContain('Chest')
  })
})

describe('exercise_alternatives block', () => {
  it('drops unknown ids, keeps the real ones, and offers a swap', async () => {
    const onSubmitForm = vi.fn()
    await render(<GenUISurface S={S} update={update} onSubmitForm={onSubmitForm} blocks={[{
      id: 'blk_alt_1', type: 'exercise_alternatives', forExId: '0025', routineId: 'r1',
      items: [
        { exId: '0289', reason: 'Neutral wrist angle', tag: 'Dumbbell' },
        { exId: 'invented-id', reason: 'not real' },
      ],
    }]} />)
    expect(container.querySelectorAll('.genui-alt')).toHaveLength(1)
    expect(text()).toContain('dumbbell bench press')
    expect(text()).toContain('Neutral wrist angle')
    await click(button(/Swap/))
    expect(onSubmitForm).toHaveBeenCalledWith(expect.objectContaining({
      formId: 'swap_choice',
      values: expect.objectContaining({ exId: '0289' }),
    }))
  })

  it('localizes exercise names and a known equipment tag from the active language pack', async () => {
    const onSubmitForm = vi.fn()
    _setLangState('zh', { dumbbell: '哑铃' }, null, { '0025': '杠铃卧推', '0289': '哑铃卧推' }, false, false)
    await render(<GenUISurface S={S} update={update} onSubmitForm={onSubmitForm} blocks={[{
      id: 'blk_alt_zh', type: 'exercise_alternatives', forExId: '0025', routineId: 'r1',
      items: [{ exId: '0289', reason: 'Neutral wrist angle', tag: 'dumbbell' }],
    }]} />)
    expect(text()).toContain('杠铃卧推')                                   // the target in the swap button
    expect(text()).toContain('哑铃卧推')                                   // the alternative's name
    expect(container.querySelector('.genui-alt-tags .tag').textContent).toBe('哑铃')
  })
})

describe('quick_form block', () => {
  it('collects choices and a 1–10 scale, then locks itself after submitting', async () => {
    const onSubmitForm = vi.fn()
    await render(<GenUISurface S={S} update={update} onSubmitForm={onSubmitForm} blocks={[{
      id: 'blk_form_1', type: 'quick_form', formId: 'shoulder_triage', title: 'Quick check before I adjust',
      submitLabel: 'Send answers',
      fields: [
        { name: 'painArea', label: 'Where does it hurt?', kind: 'single_choice', options: [{ value: 'front_shoulder', label: 'Front shoulder' }, { value: 'elbow', label: 'Elbow' }] },
        { name: 'intensity', label: 'Discomfort (1–10)', kind: 'scale', min: 1, max: 10 },
        { name: 'equipment', label: 'Equipment', kind: 'multi_choice', options: [{ value: 'dumbbell', label: 'Dumbbells' }, { value: 'cable', label: 'Cables' }] },
      ],
    }]} />)

    await click(button(/Front shoulder/))
    await click(button(/^7$/))
    await click(button(/Dumbbells/))
    await click(button(/Send answers/))

    expect(onSubmitForm).toHaveBeenCalledWith(expect.objectContaining({
      formId: 'shoulder_triage',
      values: { painArea: 'front_shoulder', intensity: 7, equipment: ['dumbbell'] },
    }))
    expect(onSubmitForm.mock.calls[0][0].summaryText).toContain('Front shoulder')
    const submit = button(/Answers sent/)
    expect(submit).toBeTruthy()
    expect(submit.disabled).toBe(true)
  })
})

describe('proposal_action block', () => {
  it('applies the checked change through applyChangeSet and refuses a second apply', async () => {
    const toast = vi.fn()
    await render(<GenUISurface S={S} update={update} toast={toast} blocks={[{
      id: 'blk_prop_1', type: 'proposal_action', title: 'A little more volume',
      summary: 'Adds one set to the bench.',
      changes: [{
        id: 'gc1', type: 'sets', target: { routineId: 'r1', exId: '0025' },
        before: 3, after: 4, why: 'You are recovering well.',
      }],
    }]} />)

    expect(text()).toContain('Adds one set to the bench.')
    expect(container.querySelector('[role="checkbox"]').getAttribute('aria-checked')).toBe('true')
    await click(button(/Apply 1 change/))

    expect(S.routines[0].ex[0].sets).toBe(4)
    expect(S.coach.snapshots).toHaveLength(1)       // undo is automatic
    expect(S.coach.log).toHaveLength(1)
    expect(container.querySelector('.genui-applied')).toBeTruthy()
    expect(button(/Apply/)).toBeFalsy()              // cannot be applied twice
    expect(toast).toHaveBeenCalled()
  })

  it('does not apply when every change is unchecked', async () => {
    await render(<GenUISurface S={S} update={update} blocks={[{
      id: 'blk_prop_2', type: 'proposal_action', title: 'A change',
      changes: [{ id: 'gc1', type: 'sets', target: { routineId: 'r1', exId: '0025' }, before: 3, after: 4, why: 'because' }],
    }]} />)
    await click(container.querySelector('[role="checkbox"]'))
    const apply = button(/Apply nothing/)
    expect(apply.disabled).toBe(true)
    expect(S.routines[0].ex[0].sets).toBe(3)
  })

  it('localizes change titles and before/after values from the active name pack', async () => {
    _setLangState('zh', {}, null, { '0025': '杠铃卧推', '0289': '哑铃卧推' }, false, false)
    await render(<GenUISurface S={S} update={update} blocks={[{
      id: 'blk_prop_zh', type: 'proposal_action', title: '中文建议',
      changes: [
        { id: 'gc1', type: 'sets', target: { routineId: 'r1', exId: '0025' }, before: 3, after: 4 },
        { id: 'gc2', type: 'swap-exercise', target: { routineId: 'r1', exId: '0025' }, before: { id: '0025' }, after: { id: '0289' } },
      ],
    }]} />)
    const titles = [...container.querySelectorAll('.pcard-chg-t')].map(el => el.textContent)
    expect(titles[0]).toContain('杠铃卧推')                // changeTitle → exTitle
    expect(titles[1]).toContain('杠铃卧推')                // "Swap A for B" title
    expect(container.querySelectorAll('.pcard-chg-v')[1].textContent).toContain('哑铃卧推')   // changeValues
  })

  it('honors block.applied so history shows Accepted without an Apply button or a stale-plan warning', async () => {
    await render(<GenUISurface S={S} update={update} blocks={[{
      id: 'blk_applied', type: 'proposal_action', title: 'Already applied', applied: true,
      planHash: 'a-plan-that-moved',
      changes: [{ id: 'gc1', type: 'sets', target: { routineId: 'r1', exId: '0025' }, before: 5, after: 4, why: 'changed' }],
    }]} />)
    expect(text()).toContain('Accepted')
    expect(button(/Apply/)).toBeFalsy()
    expect(container.querySelector('.genui-warn')).toBeFalsy()
    expect(container.querySelectorAll('.pcard-chg-stale')).toHaveLength(0)
  })

  it('passes the proposal node id back when applied', async () => {
    const onAppliedProposal = vi.fn()
    await render(<GenUISurface S={S} update={update} onAppliedProposal={onAppliedProposal} blocks={[{
      id: 'blk_prop_node', type: 'proposal_action', title: 'Add a set',
      changes: [{ id: 'gc1', type: 'sets', target: { routineId: 'r1', exId: '0025' }, before: 3, after: 4, why: 'because' }],
    }]} />)
    await click(button(/Apply 1 change/))
    expect(onAppliedProposal).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'blk_prop_node' }))
  })

  it('previews an add-routine proposal, then creates the routine and schedules its weekdays', async () => {
    const toast = vi.fn()
    await render(<GenUISurface S={S} update={update} toast={toast} blocks={[{
      id: 'blk_new_routine', type: 'proposal_action', title: 'A two-day push pull',
      summary: 'Two sessions a week.',
      changes: [{
        id: 'gc_new', type: 'add-routine', target: {}, before: null, why: 'Your pressing has room.',
        after: {
          name: 'Push Day', emoji: '🏋️', weekdays: [1, 4, 4],
          ex: [
            { id: '0025', sets: 4, reps: 8, repsMin: 6, repsMax: 10, mode: 'reps' },
            { id: '0007', sets: 3, mode: 'time', sec: 45 },
          ],
        },
      }],
    }]} />)

    expect(container.querySelector('.pcard-chg-t').textContent).toContain('Push Day')
    // The days it will be scheduled on, deduplicated, as the app names them.
    expect([...container.querySelectorAll('.genui-routine-days .tag')].map(el => el.textContent))
      .toEqual(['Monday', 'Thursday'])
    // Every exercise with its localized name and the prescription it will be created with.
    expect([...container.querySelectorAll('.genui-routine-ex-name')].map(el => el.textContent))
      .toEqual(['Barbell Bench Press', 'Alternate Lateral Pulldown'])
    expect([...container.querySelectorAll('.genui-routine-ex-rx')].map(el => el.textContent))
      .toEqual(['4×6-10', '3×45s'])
    expect(container.querySelector('.pcard-chg-w').textContent).toBe('Your pressing has room.')

    await click(button(/Apply 1 change/))

    const created = S.routines.at(-1)
    expect(created.name).toBe('Push Day')
    expect(created.ex.map(e => e.id)).toEqual(['0025', '0007'])
    expect(S.week[1]).toEqual([created.id])
    expect(S.week[4]).toEqual([created.id])
    expect(container.querySelector('.genui-applied')).toBeTruthy()
    expect(button(/Apply/)).toBeFalsy()
  })
})

describe('fallbacks', () => {
  it('renders an unknown block as a quiet notice instead of throwing', async () => {
    await render(<GenUISurface S={S} update={update} blocks={[
      { id: 'x1', type: 'not_a_block', text: 'I could not draw that one.' },
      { id: 'x2', type: 'fallback_notice' },
    ]} />)
    expect(container.querySelectorAll('.genui-note')).toHaveLength(2)
    expect(text()).toContain('I could not draw that one.')
    expect(text()).toContain('Something went wrong on the server.')
  })
})

/* ============================== v2 narrative briefing ============================== */

describe('normalizeGenUINodes', () => {
  it('returns the v2 node list untouched when it is present and non-empty', () => {
    const nodes = [{ id: 'n1', type: 'prose', text: 'Hi' }]
    expect(normalizeGenUINodes({ nodes })).toBe(nodes)
  })

  it('converts a legacy text + blocks reply into prose followed by the blocks', () => {
    const blocks = [{ id: 'b1', type: 'fallback_notice', text: 'kept' }]
    expect(normalizeGenUINodes({ text: 'Old words', blocks })).toEqual([
      { id: 'prose_0', type: 'prose', text: 'Old words' },
      ...blocks,
    ])
  })

  it('handles text only, blocks only, and an empty message', () => {
    expect(normalizeGenUINodes({ text: 'Only words' }))
      .toEqual([{ id: 'prose_0', type: 'prose', text: 'Only words' }])
    const blocks = [{ id: 'b1', type: 'fallback_notice' }]
    expect(normalizeGenUINodes({ blocks })).toEqual(blocks)
    expect(normalizeGenUINodes({})).toEqual([])
  })
})

describe('GenUINodePending', () => {
  it('renders a type-matched micro skeleton hidden from assistive tech', async () => {
    await render(<>
      <GenUINodePending type="prose" />
      <GenUINodePending type="kpi_strip" />
      <GenUINodePending type="exercise_trend" />
      <GenUINodePending type="muscle_load" />
      <GenUINodePending type="comparison_table" />
      <GenUINodePending type="checklist" />
    </>)
    expect(container.querySelector('.genui-pending-prose')).toBeTruthy()
    expect(container.querySelector('.genui-pending-kpi')).toBeTruthy()
    expect(container.querySelectorAll('.genui-pending-box')).toHaveLength(2)
    expect(container.querySelectorAll('.genui-pending-rows')).toHaveLength(2)
    const all = [...container.querySelectorAll('.genui-pending')]
    expect(all).toHaveLength(6)
    expect(all.every(el => el.getAttribute('aria-hidden') === 'true')).toBe(true)
  })
})

describe('GenUIBriefing prose and cursor', () => {
  const nodes = [
    { id: 'p1', type: 'prose', tone: 'lead', text: 'Lead line.' },
    { id: 'p2', type: 'prose', text: 'Body line.' },
    { id: 'p3', type: 'prose', tone: 'closing', text: 'Closing line.' },
  ]

  it('renders prose tones and only blinks the cursor on the last prose while streaming', async () => {
    await render(<GenUIBriefing nodes={nodes} streaming S={S} update={update} />)
    expect(container.querySelector('.genui-prose.tone-lead').textContent).toContain('Lead line.')
    expect(container.querySelector('.genui-prose.tone-closing').textContent).toContain('Closing line.')
    const cursors = container.querySelectorAll('.genui-cursor')
    expect(cursors).toHaveLength(1)
    expect(container.querySelectorAll('.genui-prose')[2].contains(cursors[0])).toBe(true)

    // A pending node owns the tail: the prose cursor goes away.
    await act(async () => {
      root.render(<GenUIBriefing nodes={nodes} streaming pendingNode={{ nodeType: 'kpi_strip' }} S={S} update={update} />)
    })
    expect(container.querySelectorAll('.genui-cursor')).toHaveLength(0)
    expect(container.querySelector('.genui-pending-kpi')).toBeTruthy()

    // Once streaming stops the cursor is gone for good.
    await act(async () => {
      root.render(<GenUIBriefing nodes={nodes} S={S} update={update} />)
    })
    expect(container.querySelectorAll('.genui-cursor')).toHaveLength(0)
  })
})

describe('GenUIBriefing primitives', () => {
  it('renders prose, KPI strip, comparison table, checklist and callout in node order', async () => {
    _setLangState('zh', {}, null, { '0025': '杠铃卧推' }, false, false)
    const nodes = [
      { id: 'p1', type: 'prose', text: 'Your bench is moving.' },
      { id: 'k1', type: 'kpi_strip', items: [
        { kind: 'exercise_stat', exId: '0025', metric: 'weight', weeks: 8, label: 'Bench', value: 1234 },
        { kind: 'prescription', label: 'Top set', value: '4×8' },
      ] },
      { id: 'c1', type: 'comparison_table', title: 'Shoulder-friendly press', columns: ['Exercise', 'Setup'], rows: [
        [{ exId: '0025' }, 'Flat'],
        [{ exId: 'not-a-real-exercise', note: 'Unknown pick' }, 'Incline'],
      ] },
      { id: 'chk1', type: 'checklist', title: 'Warm-up', items: [
        { id: 'a', label: 'Band pull-apart', detail: '2×15' },
        { id: 'b', label: 'Wall slide' },
      ] },
      { id: 'call1', type: 'callout', variant: 'tip', title: 'Keep it easy', text: 'Lead with the elbows.' },
    ]
    await render(<GenUIBriefing nodes={nodes} S={S} update={update} />)

    const kinds = [...container.querySelector('.genui-briefing').children].map(el => el.className)
    expect(kinds[0]).toContain('genui-prose')
    expect(kinds[1]).toContain('genui-kpi-strip')
    expect(kinds[2]).toContain('genui-table-wrap')
    expect(kinds[3]).toContain('genui-checklist')
    expect(kinds[4]).toContain('genui-callout')

    // KPI: real hydration wins over the model's value, prescriptions pass through.
    expect(text()).toContain('Bench')
    expect(text()).toContain('62.5')
    expect(text()).toContain('4×8')
    expect(text()).not.toContain('1234')

    // Table: localized catalogue name + thumbnail; an unknown id degrades to its note.
    expect(text()).toContain('杠铃卧推')
    expect(text()).toContain('Unknown pick')
    expect(container.querySelectorAll('.genui-cell-ex .thumb')).toHaveLength(1)

    // Numbered steps (legacy checklist, read-only) and callout.
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
    expect(text()).toContain('Band pull-apart')
    expect(text()).toContain('2×15')
    expect(container.querySelector('.genui-callout.is-tip')).toBeTruthy()
    expect(text()).toContain('Keep it easy')
    expect(text()).toContain('Lead with the elbows.')
  })

  it('falls back to an en dash for every KPI with no history, never NaN', async () => {
    await render(<GenUIBriefing S={{ ...S, workouts: [] }} update={update} nodes={[{
      id: 'k1', type: 'kpi_strip', items: [
        { kind: 'exercise_stat', exId: '0025', weeks: 8 },
        { kind: 'muscle_sets', muscle: 'chest', window: '72h' },
        { kind: 'session_count', weeks: 4 },
      ],
    }]} />)
    const values = [...container.querySelectorAll('.genui-kpi-v .genui-kpi-n')].map(el => el.textContent)
    expect(values).toEqual(['–', '–', '–'])
    expect(text()).not.toContain('NaN')
  })

  it('renders info, tip and warning callouts with an optional title', async () => {
    await render(<GenUIBriefing S={S} update={update} nodes={[
      { id: 'c1', type: 'callout', variant: 'info', text: 'Info body' },
      { id: 'c2', type: 'callout', variant: 'tip', title: 'Tip title', text: 'Tip body' },
      { id: 'c3', type: 'callout', variant: 'warning', text: 'Warning body' },
    ]} />)
    expect(container.querySelector('.genui-callout.is-info')).toBeTruthy()
    expect(container.querySelector('.genui-callout.is-tip')).toBeTruthy()
    expect(container.querySelector('.genui-callout.is-warning')).toBeTruthy()
    expect(container.querySelectorAll('.genui-callout-t')).toHaveLength(1)
    expect(text()).toContain('Tip title')
    expect(text()).toContain('Warning body')
  })
})

describe('GenUIBriefing checklist (read-only steps)', () => {
  const nodes = [{ id: 'chk1', type: 'checklist', title: 'Warm-up', items: [
    { id: 'a', label: 'Band pull-apart', detail: '2×15' },
    { id: 'b', label: 'Wall slide' },
  ] }]

  it('renders legacy checklist items as a read-only numbered list with no interactive checkboxes', async () => {
    await render(<GenUIBriefing nodes={nodes} S={S} update={update} />)
    expect(text()).toContain('Warm-up')
    expect(text()).toContain('Band pull-apart')
    expect(text()).toContain('2×15')
    expect(text()).toContain('Wall slide')
    expect(container.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
    expect(container.querySelectorAll('.genui-step-item')).toHaveLength(2)
  })
})

describe('inline controls re-hydrate without the network', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('switches exercise_trend metric and period locally, with no fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const trendS = {
      ...S,
      workouts: [workout('t1', 100, 50), workout('t2', 35, 60), workout('t3', 1, 62.5)],
    }
    await render(<GenUIBriefing S={trendS} update={update} nodes={[{
      id: 'trend1', type: 'exercise_trend', exId: '0025', metric: 'e1rm', weeks: 8,
    }]} />)

    expect(container.querySelector('.genui-eyebrow').textContent).toBe('Estimated 1RM')
    expect(text()).toContain('76')
    expect(text()).toContain('79.2')
    expect(text()).not.toContain('62.5')
    expect(container.querySelector('.genui-foot').textContent).toBe('2 sessions')

    await click(button(/^Weight$/))
    expect(container.querySelector('.genui-eyebrow').textContent).toBe('Weight')
    expect(text()).toContain('62.5')

    await click(button(/^Volume$/))
    expect(container.querySelector('.genui-eyebrow').textContent).toBe('Volume (kg)')
    expect(text()).toContain('1,500')

    await click(button(/^1RM$/))
    expect(container.querySelector('.genui-eyebrow').textContent).toBe('Estimated 1RM')

    await click(button(/^4w$/))
    expect(text()).toContain('Not enough history to draw a trend yet.')
    expect(container.querySelector('.chart-i')).toBeFalsy()

    await click(button(/^24w$/))
    expect(container.querySelector('.genui-foot').textContent).toBe('3 sessions')
    expect(container.querySelector('.chart-i svg')).toBeTruthy()

    await click(button(/^12w$/))
    expect(container.querySelector('.genui-foot').textContent).toBe('2 sessions')

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('switches muscle_load windows locally, with no fetch', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const loadS = {
      ...S,
      workouts: [workout('m1', 20, 60), workout('m2', 5, 60), workout('m3', 1, 60)],
    }
    await render(<GenUIBriefing S={loadS} update={update} nodes={[{
      id: 'load1', type: 'muscle_load', window: '72h', focusMuscles: ['chest'],
    }]} />)

    expect(container.querySelector('.genui-eyebrow').textContent).toBe('72h')
    expect(container.querySelector('.genui-foot').textContent).toBe('3 sets')

    await click(button(/^7d$/))
    expect(container.querySelector('.genui-eyebrow').textContent).toBe('7d')
    expect(container.querySelector('.genui-foot').textContent).toBe('6 sets')

    await click(button(/^28d$/))
    expect(container.querySelector('.genui-eyebrow').textContent).toBe('28d')
    expect(container.querySelector('.genui-foot').textContent).toBe('9 sets')

    await click(button(/^72h$/))
    expect(container.querySelector('.genui-eyebrow').textContent).toBe('72h')
    expect(container.querySelector('.genui-foot').textContent).toBe('3 sets')

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
