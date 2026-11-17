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

const target = (id, sets, reps, weight) => ({ id, mode: 'reps', sets, reps, weight, restSec: 90 });
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

const today = new Date().getDay();
const week = {
  [String(today)]: 'fixture-upper',
  [String((today + 2) % 7)]: 'fixture-lower',
  [String((today + 4) % 7)]: 'fixture-back',
};

const profile = {
  unit: 'kg',
  restSec: 90,
  volumeWarmups: true,
  routines,
  workouts,
  week,
  scheduleMode: 'week',
  customEx: [{ id: 'custom-demo', n: '自定义划船', bp: 'back', eq: 'cable' }],
};

const state = { profile, draft: null, queue: [], restAlerts: false };
const db = new DatabaseSync(out);
db.exec('CREATE TABLE IF NOT EXISTS workspace (scope TEXT PRIMARY KEY, state TEXT NOT NULL)');
db.prepare('INSERT OR REPLACE INTO workspace (scope, state) VALUES (?, ?)').run('practice', JSON.stringify(state));
db.close();
console.log(`fixture: ${out}`);
console.log(`routines: ${routines.length}; workouts: ${workouts.length}; today: ${dayOf(0)}`);
