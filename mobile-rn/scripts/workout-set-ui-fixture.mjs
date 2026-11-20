/**
 * Build a Debug-app SQLite state with a pre-existing workout draft for the
 * workout-set UI acceptance cases. Run `make-ui-fixture.mjs` first to produce
 * the base database, then this script patches its `practice` state.
 *
 * Scenarios:
 * - old-incomplete: legacy dropset row (`type`/`drops`, no segment times)
 * - old-complete:   legacy completed dropset (`at` set, no segment times)
 * - rest-running:   a running rest dock with a dropset and plain rows
 * - mixed-effort:   profile RIR with one historical RPE row, so the card header says 评分
 * - effort-none:    effort off and no stored rating, so the rating column is omitted
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const [baseArg, outArg, scenario = 'old-incomplete'] = process.argv.slice(2);
if (!baseArg || !outArg) {
  throw new Error('usage: node workout-set-ui-fixture.mjs <base.db> <out.db> [old-incomplete|old-complete|rest-running]');
}
const base = resolve(baseArg);
const out = resolve(outArg);

const source = new DatabaseSync(base);
const row = source.prepare("SELECT state FROM workspace WHERE scope = 'practice'").get();
if (!row) throw new Error('base fixture has no practice state');
const state = JSON.parse(row.state);
source.close();

const routine = (state.profile?.routines ?? []).find(item => item?.id === 'fixture-upper');
if (!routine) throw new Error('base fixture has no fixture-upper routine');

const now = Date.now();
const start = now - 12 * 60 * 1000;
const plain = (weight, reps, at = null, extra = {}) => ({ weight: String(weight), reps: String(reps), at, ...extra });
const dropset = at => ({
  weight: '60',
  reps: '7',
  at,
  type: 'dropset',
  drops: [
    { w: '50', r: '8' },
    { w: '40', r: '9' },
  ],
});

const completeAt = now - 4 * 60 * 1000;
const running = scenario === 'rest-running';
const mixed = scenario === 'mixed-effort';
if (mixed) state.profile.effort = 'rir';
if (scenario === 'effort-none') state.profile.effort = 'none';
const exercises = [
  {
    target: { ...routine.ex[0] },
    sets: [
      plain(40, 8, scenario === 'old-complete' ? now - 6 * 60 * 1000 : null, { warmup: true }),
      plain(
        60,
        8,
        running || scenario === 'old-complete' ? now - 5 * 60 * 1000 : null,
        mixed ? { effortScale: 'rpe', effort: 8 } : {},
      ),
      dropset(scenario === 'old-complete' ? completeAt : null),
      plain(60, 7),
    ],
  },
  {
    target: { ...routine.ex[1] },
    sets: [plain(20, 10), plain(20, 10), plain(20, 10)],
  },
];

const draft = {
  id: 'fixture-workout-set-ui',
  routineId: routine.id,
  routineIds: [routine.id],
  name: routine.name,
  unit: 'kg',
  start,
  view: 'cards',
  exercises,
  rest: scenario === 'rest-running'
    ? { endsAt: now + 90 * 1000, exerciseIndex: 0, setIndex: 1 }
    : null,
};

if (scenario === 'modes') {
  state.profile.customEx = [
    ...(state.profile.customEx ?? []),
    { id: 'custom-cardio', n: '跑步机', bp: 'full-body', eq: 'machine' },
    { id: 'custom-time', n: '平板支撑', bp: 'waist', eq: 'bodyweight' },
  ];
  draft.name = '有氧与计时字段';
  draft.exercises = [
    {
      target: { id: 'custom-cardio', mode: 'cardio', speed: 8, min: 20, restSec: 60 },
      sets: [
        { weight: '8', reps: '20', at: null },
        { weight: '8', reps: '20', at: null },
      ],
    },
    {
      target: { id: 'custom-time', mode: 'time', weight: 10, sec: 45, restSec: 60 },
      sets: [{ weight: '10', reps: '45', at: null }],
    },
  ];
}

state.draft = draft;

const target = new DatabaseSync(out);
target.exec('CREATE TABLE IF NOT EXISTS workspace (scope TEXT PRIMARY KEY, state TEXT NOT NULL)');
target.prepare('INSERT OR REPLACE INTO workspace (scope, state) VALUES (?, ?)').run('practice', JSON.stringify(state));
target.close();

console.log(`workout-set-ui fixture: ${scenario} -> ${out}`);
