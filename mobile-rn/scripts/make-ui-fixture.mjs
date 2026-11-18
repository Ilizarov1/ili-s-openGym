import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const out = resolve(process.argv[2] ?? 'dist/ui/opengym-rn.db');
mkdirSync(dirname(out), { recursive: true });

const now = Date.now();
const dayOf = offset => {
  const date = new Date(now - offset * 86400000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const atOf = (offset, hour) => {
  const date = new Date(now - offset * 86400000);
  date.setHours(hour, 0, 0, 0);
  return date.getTime();
};

const target = (id, sets, reps, weight, restSec = 90) => ({ id, mode: 'reps', sets, reps, weight, restSec });
// A superset member: `sg` groups adjacent exercises, `sgName`/`sgRest` carry the one group name and
// round rest the app reads back from every member (frontend/src/lib/superset-meta.js).
const member = (id, sets, reps, weight, restSec, sg, sgName, sgRest) => ({
  ...target(id, sets, reps, weight, restSec),
  ...(sg ? { sg } : {}),
  ...(sgName ? { sgName } : {}),
  ...(sgRest ? { sgRest } : {}),
});
const work = (weight, reps, at) => ({ w: weight, r: reps, done: true, at });

const routines = [
  {
    id: 'fixture-upper',
    name: '胸部与肩部训练 A',
    ex: [
      target('0025', 4, 8, 60),
      target('0047', 3, 10, 20),
      target('1323', 3, 12, 15),
    ],
  },
  {
    id: 'fixture-lower',
    name: '腿部与臀部训练 A',
    ex: [
      target('0043', 4, 8, 80),
      target('0085', 3, 10, 40),
      target('2330', 3, 12, 35),
    ],
  },
  {
    id: 'fixture-back',
    name: '背部与手臂训练 A',
    ex: [
      target('0047', 4, 8, 55),
      target('1323', 3, 10, 25),
    ],
  },
  {
    // Uneven rounds: the 2-set bench opens round 1, the 1-set incline closes it, then bench round 2.
    // The 73-second group rest overrides the members' 25/40-second own rest.
    id: 'fixture-superset',
    name: '超级组推胸 A',
    ex: [
      member('0025', 2, 8, 40, 25, 'sg-fixture-push', 'Push pair', 73),
      member('0047', 1, 10, 20, 40, 'sg-fixture-push', 'Push pair', 73),
    ],
  },
  {
    // No sgRest: the round rest must be the longest member rest, 40, not 25.
    id: 'fixture-superset-rest',
    name: '超级组长休息 B',
    ex: [
      member('0043', 2, 8, 80, 25, 'sg-fixture-longest'),
      member('0085', 1, 10, 40, 40, 'sg-fixture-longest'),
    ],
  },
  {
    // Ungrouped on purpose, so the smoke test can create the group through the plan editor.
    id: 'fixture-superset-new',
    name: '超级组新建 C',
    ex: [
      target('0043', 2, 8, 80, 25),
      target('0085', 1, 10, 40, 40),
    ],
  },
  {
    // Exercises for the advanced-set, effort and favourite checks: one planned drop
    // set, one planned rest-pause set and a favourite on the first movement.
    id: 'fixture-advanced',
    name: '高级组与评分 A',
    ex: [
      { ...target('0025', 3, 8, 50), intensifier: { type: 'dropset', count: 2, pct: 20 } },
      { ...target('0047', 3, 10, 20), intensifier: { type: 'restpause', totalReps: 12, restSec: 15 } },
    ],
  },
];

const makeWorkout = (id, offset, routine, entries) => ({
  id,
  d: dayOf(offset),
  start: atOf(offset, 9),
  end: atOf(offset, 10),
  name: routine.name,
  routineId: routine.id,
  routineIds: [routine.id],
  bw: null,
  prs: [],
  entries,
  vol: entries.reduce((total, entry) => total + entry.sets.reduce((sum, set) => sum + set.w * set.r, 0), 0),
  _ts: now - offset * 86400000,
});

const upper = routines[0];
const lower = routines[1];
const back = routines[2];

const workouts = [
  makeWorkout('fixture-today', 0, upper, [
    {
      id: '0025',
      target: upper.ex[0],
      topW: 60,
      sets: [work(60, 8, atOf(0, 9) + 120000), work(60, 8, atOf(0, 9) + 240000), work(60, 7, atOf(0, 9) + 360000)],
    },
    {
      id: '0047',
      target: upper.ex[1],
      topW: 20,
      sets: [work(20, 10, atOf(0, 9) + 600000), work(20, 10, atOf(0, 9) + 720000)],
    },
  ]),
  makeWorkout('fixture-yesterday', 1, lower, [
    {
      id: '0043',
      target: lower.ex[0],
      topW: 80,
      sets: [work(80, 8, atOf(1, 9) + 120000), work(80, 8, atOf(1, 9) + 240000), work(80, 6, atOf(1, 9) + 360000)],
    },
    {
      id: '0085',
      target: lower.ex[1],
      topW: 40,
      sets: [work(40, 10, atOf(1, 9) + 600000), work(40, 9, atOf(1, 9) + 720000)],
    },
  ]),
  makeWorkout('fixture-back', 3, back, [
    {
      id: '0047',
      target: back.ex[0],
      topW: 55,
      sets: [work(55, 8, atOf(3, 9) + 120000), work(55, 8, atOf(3, 9) + 240000)],
    },
  ]),
];

// A saved superset gives the Stats screen a group to render before the smoke test records its own.
const supersetRoutine = routines[3];
const supersetLog = makeWorkout('fixture-superset-log', 2, supersetRoutine, [
  {
    id: '0025',
    sg: 'sg-fixture-push',
    target: supersetRoutine.ex[0],
    topW: 40,
    sets: [work(40, 8, atOf(2, 9) + 120000), work(40, 8, atOf(2, 9) + 240000)],
  },
  {
    id: '0047',
    sg: 'sg-fixture-push',
    target: supersetRoutine.ex[1],
    topW: 20,
    sets: [work(20, 10, atOf(2, 9) + 600000)],
  },
]);
supersetLog.name = '超级组历史样本';
workouts.push(supersetLog);

// A heavier older bench session gives the PR and 1RM cards two dated points.
const prLog = makeWorkout('fixture-pr', 10, upper, [
  {
    id: '0025',
    target: upper.ex[0],
    topW: 100,
    sets: [
      work(90, 6, atOf(10, 9) + 120000),
      work(100, 5, atOf(10, 9) + 240000),
      work(100, 6, atOf(10, 9) + 360000),
    ],
  },
]);
prLog.name = '胸部力量样本';
workouts.push(prLog);

const bodyweight = [
  {
    d: dayOf(6),
    w: 80.6,
    t: atOf(6, 20),
    ins: [
      { id: 'fixture-w1', at: '08:00', w: 80.2, t: atOf(6, 8) },
      { id: 'fixture-w2', at: '20:00', w: 81.0, t: atOf(6, 20) },
    ],
  },
  {
    d: dayOf(4),
    w: 80.4,
    t: atOf(4, 8),
    ins: [{ id: 'fixture-w3', at: '08:00', w: 80.4, t: atOf(4, 8) }],
  },
  {
    d: dayOf(2),
    w: 80.0,
    t: atOf(2, 8),
    ins: [{ id: 'fixture-w4', at: '08:00', w: 80.0, t: atOf(2, 8) }],
  },
];

const measurements = [
  {
    d: dayOf(6),
    t: atOf(6, 8),
    chest: 100,
    waist: 82,
    hips: 96,
    upperArmLeft: 36,
    upperArmRight: 36.5,
    thighLeft: 60,
    thighRight: 60.5,
    bodyFat: 18,
    other: [],
  },
  {
    d: dayOf(2),
    t: atOf(2, 8),
    chest: 99.5,
    waist: 82.5,
    hips: 96,
    upperArmLeft: 35.5,
    upperArmRight: 36,
    thighLeft: 59.5,
    thighRight: 60,
    bodyFat: 18.5,
    other: [],
  },
];

const today = new Date().getDay();
const week = {
  [String(today)]: 'fixture-upper',
  [String((today + 2) % 7)]: 'fixture-lower',
  [String((today + 4) % 7)]: 'fixture-back',
};

const profile = {
  unit: 'kg',
  restSec: 90,
  restPauseSec: 15,
  volumeWarmups: true,
  effort: 'rpe',
  oneRmFormula: 'epley',
  bwDaily: 'avg',
  favEx: ['0025', 'custom-demo'],
  routines,
  workouts,
  bodyweight,
  measurements,
  week,
  scheduleMode: 'week',
  customEx: [{ id: 'custom-demo', n: '自定义划船', bp: 'back', eq: 'cable' }],
};

const state = { profile, draft: null, queue: [], restAlerts: false, reminder: { on: false, time: '08:00' } };
const db = new DatabaseSync(out);
db.exec('CREATE TABLE IF NOT EXISTS workspace (scope TEXT PRIMARY KEY, state TEXT NOT NULL)');
db.prepare('INSERT OR REPLACE INTO workspace (scope, state) VALUES (?, ?)').run('practice', JSON.stringify(state));
db.close();
console.log(`fixture: ${out}`);
console.log(`routines: ${routines.length} (3 supersets, 1 advanced); workouts: ${workouts.length} (1 superset); today: ${dayOf(0)}`);
