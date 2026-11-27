// Unit coverage for the RN AI Coach bridge and its replayable sync intents.
//
// The modules under test are TypeScript + shared Web JS. Node 24 strips types natively; two RN
// details need a test-time loader: `expo-crypto` (native module) and Metro's `require()` media
// table. Both are replaced with inert equivalents; nothing the assertions cover is stubbed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const EXTENSIONS = ['.js', '.ts', '.tsx', '.mjs', '.json'];
const KNOWN_EXTENSIONS = ['.js', '.ts', '.tsx', '.mjs', '.cjs', '.json'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-crypto') {
      return {
        url: 'data:text/javascript,' + encodeURIComponent(
          "import { randomUUID } from 'node:crypto'; export { randomUUID };",
        ),
        shortCircuit: true,
      };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) &&
        !KNOWN_EXTENSIONS.some(extension => specifier.endsWith(extension))) {
        for (const extension of EXTENSIONS) {
          try {
            return nextResolve(specifier + extension, context);
          } catch {
            // try the next candidate extension
          }
        }
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) {
      const text = readFileSync(fileURLToPath(url), 'utf8');
      return { format: 'module', source: `export default ${text};`, shortCircuit: true };
    }
    // Metro turns media imports into `require()` calls; names are what this test exercises.
    if (url.includes('catalogueMedia.generated')) {
      return {
        format: 'module',
        source: 'export const CATALOGUE_CLIPS = {}; export const CATALOGUE_STILL = {};',
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const bridge = await import('../src/agent/coach-bridge.ts');
const { applyChanges, prepareChanges } = await import('../src/profileChanges.ts');
const { catalogueName } = await import('../src/catalogue.js');

const profileOf = (extra = {}) => ({
  unit: 'kg',
  routines: [],
  week: {},
  workouts: [],
  coach: { chat: [], log: [], snapshots: [] },
  ...extra,
});

const userMessage = (id, at, text) => ({ id, role: 'user', kind: 'text', at, text });

test('buildGenUIHistory emits strict per-node NDJSON and never bracketed summaries (L-009)', () => {
  const chat = [
    userMessage('u1', 100, '分析下我最近的训练'),
    {
      id: 'a1',
      role: 'coach',
      kind: 'genui',
      at: 200,
      nodes: [
        { id: 'p1', type: 'prose', text: '最近 4 周\n深蹲稳步上升。' },
        { id: 't1', type: 'exercise_trend', exId: '0043', metric: 'e1rm', weeks: 8 },
        {
          id: 'pa1',
          type: 'proposal_action',
          title: '调整深蹲',
          summary: '把组数提到 4 组',
          changes: [
            { id: 'c1', type: 'sets', target: { routineId: 'r1', exId: '0043' }, before: 3, after: 4, why: '基础力量' },
          ],
        },
        { id: 'cl1', type: 'checklist', items: [{ id: 'x', label: '旧清单' }] },
      ],
    },
    { id: 'a2', role: 'assistant', kind: 'text', at: 300, text: '还需要别的吗？' },
    userMessage('old', 50, '清空前的问题'),
  ];

  const turns = bridge.buildGenUIHistory(chat, 60);
  assert.deepEqual(turns.map(turn => turn.role), ['user', 'assistant', 'assistant']);
  assert.equal(turns[0].content, '分析下我最近的训练');
  assert.ok(!turns.some(turn => /\[Shown |\[Proposal /.test(turn.content)));

  const lines = turns[1].content.split('\n');
  assert.equal(lines.length, 3, 'checklist is legacy and omitted; prose/trend/proposal are one line each');
  const nodes = lines.map(line => JSON.parse(line));
  assert.deepEqual(nodes.map(node => node.type), ['prose', 'exercise_trend', 'proposal_action']);
  assert.equal(nodes[0].text, '最近 4 周\n深蹲稳步上升。');
  assert.equal(nodes[2].changes[0].after, 4);
  assert.equal(JSON.parse(turns[2].content).type, 'prose');
});

test('countGenUITurns and pruneClearedChat respect chatClearedAt and the 40-line cap', () => {
  const chat = [
    userMessage('before', 10, '清空之前'),
    userMessage('u1', 110, '一'),
    userMessage('u2', 210, '二'),
    { id: 'a1', role: 'coach', kind: 'text', at: 220, text: '回答' },
  ];
  assert.equal(bridge.countGenUITurns(chat, 100), 2);
  assert.deepEqual(bridge.pruneClearedChat(chat, 100).map(message => message.id), ['u1', 'u2', 'a1']);
  assert.equal(bridge.countGenUITurns(chat, 0), 3);

  const many = Array.from({ length: 55 }, (_, index) => userMessage(`m${index}`, 1000 + index, `x${index}`));
  const pruned = bridge.pruneClearedChat(many, 0);
  assert.equal(pruned.length, 40);
  assert.equal(pruned[0].id, 'm15');
  assert.equal(pruned.at(-1).id, 'm54');
});

test('coachApplyProposal with add-routine + weekdays schedules the week, snapshots and logs', () => {
  const proposal = {
    id: 'n1',
    type: 'proposal_action',
    title: '新建胸肩推日',
    summary: '每周一、周四',
    changes: [
      {
        id: 'c1',
        type: 'add-routine',
        target: {},
        after: {
          name: '胸肩推日',
          weekdays: [1, 4],
          ex: [
            { id: '0043', sets: 4, reps: 8 },
            { id: '0025', mode: 'time', sec: 60 },
          ],
        },
      },
    ],
  };
  const base = profileOf({
    coach: {
      chat: [{ id: 'm1', role: 'coach', kind: 'genui', at: 100, nodes: [proposal] }],
      log: [],
      snapshots: [],
    },
  });

  const applied = applyChanges(base, prepareChanges([{
    kind: 'coachApplyProposal',
    changes: proposal.changes,
    meta: { proposalId: 'p1', summary: '每周一、周四', now: 5000, messageId: 'm1', nodeId: 'n1' },
  }]));

  assert.equal(applied.routines.length, 1);
  const routine = applied.routines[0];
  assert.equal(routine.name, '胸肩推日');
  assert.equal(routine.ex.length, 2);
  assert.equal(routine.ex[0].sets, 4);
  assert.equal(routine.ex[1].mode, 'time');
  assert.equal(routine.ex[1].sec, 60);
  assert.deepEqual(applied.week['1'], [routine.id]);
  assert.deepEqual(applied.week['4'], [routine.id]);

  assert.equal(applied.coach.snapshots.length, 1);
  assert.deepEqual(applied.coach.snapshots[0].routines, []);
  assert.deepEqual(applied.coach.snapshots[0].week, {});
  assert.equal(applied.coach.snapshots[0].at, 5000);

  const review = applied.coach.log.at(-1);
  assert.equal(review.kind, 'review');
  assert.equal(review.proposalId, 'p1');
  assert.equal(review.decisions[0].status, 'accepted');
  assert.equal(typeof review.changeId, 'string', 'the pending-change id is recorded for replay idempotency');
  assert.equal(applied.coach.chat[0].nodes[0].applied, true);

  // Undo restores both lists atomically and names the snapshot it consumed.
  const reverted = applyChanges(applied, prepareChanges([{ kind: 'coachRevertLast', at: 6000 }]));
  assert.deepEqual(reverted.routines, []);
  assert.deepEqual(reverted.week, {});
  assert.equal(reverted.coach.snapshots.length, 0);
  const revert = reverted.coach.log.at(-1);
  assert.equal(revert.kind, 'revert');
  assert.equal(revert.snap, '5000|p1');

  // A second, different undo has nothing to pop and must not invent a log line.
  const logs = reverted.coach.log.length;
  const again = applyChanges(reverted, prepareChanges([{ kind: 'coachRevertLast', at: 7000 }]));
  assert.deepEqual(again.routines, []);
  assert.equal(again.coach.log.length, logs);
});

test('applyCoachProposal is atomic and idempotent by intent id', () => {
  const base = profileOf();
  const broken = [{
    id: 'bad',
    type: 'add-exercise',
    target: { routineId: 'missing', exId: '0043' },
    after: { id: '0043', sets: 3 },
  }];
  const result = bridge.applyCoachProposal(base, broken, { proposalId: 'p-bad', now: 1000 });
  assert.equal(result.applied, 0);
  assert.equal(result.profile, base, 'a failed change leaves the original profile untouched');
  assert.equal(base.coach.snapshots.length, 0);

  const good = [{
    id: 'c1',
    type: 'add-routine',
    target: {},
    after: { name: '腿日', ex: [{ id: '0043', sets: 5, reps: 5 }] },
  }];
  const once = bridge.applyCoachProposal(base, good, { proposalId: 'p1', now: 2000, intentId: 'intent-1' });
  assert.equal(once.applied, 1);
  const twice = bridge.applyCoachProposal(once.profile, good, { proposalId: 'p1', now: 2000, intentId: 'intent-1' });
  assert.equal(twice.duplicate, true);
  assert.equal(twice.profile, once.profile);
  assert.equal(once.profile.routines.length, 1);
});

test('coachChatClear never lets cleared history resurrect (L-010)', () => {
  let profile = profileOf();
  profile = applyChanges(profile, prepareChanges([{
    kind: 'coachChatAppend',
    message: userMessage('old1', 1000, '会被清空'),
  }]));
  assert.deepEqual(profile.coach.chat.map(message => message.id), ['old1']);

  // Appending the same id again is a no-op.
  profile = applyChanges(profile, prepareChanges([{
    kind: 'coachChatAppend',
    message: userMessage('old1', 1000, '会被清空'),
  }]));
  assert.equal(profile.coach.chat.length, 1);

  profile = applyChanges(profile, prepareChanges([{ kind: 'coachChatClear', at: 2000 }]));
  assert.equal(profile.coach.chatClearedAt, 2000);
  assert.deepEqual(profile.coach.chat, []);

  // Replaying the pre-clear append (same id, older timestamp) must not bring it back.
  profile = applyChanges(profile, prepareChanges([{
    kind: 'coachChatAppend',
    message: userMessage('old1', 1000, '会被清空'),
  }]));
  assert.deepEqual(profile.coach.chat, []);
  assert.equal(profile.coach.chatClearedAt, 2000);

  profile = applyChanges(profile, prepareChanges([{
    kind: 'coachChatAppend',
    message: userMessage('new1', 2001, '清空后的新消息'),
  }]));
  assert.deepEqual(profile.coach.chat.map(message => message.id), ['new1']);

  // A stale clear replay can only move the watermark forward, never back.
  profile = applyChanges(profile, prepareChanges([{ kind: 'coachChatClear', at: 1500 }]));
  assert.ok(profile.coach.chatClearedAt >= 2001);

  profile = applyChanges(profile, prepareChanges([{
    kind: 'coachChatAppend',
    message: userMessage('new2', 2002, '继续'),
  }]));
  assert.deepEqual(profile.coach.chat.map(message => message.id), ['new2']);

  // Adopting a server copy with an older watermark is raised and pruned.
  const adopted = bridge.guardClearedChat({
    coach: {
      chatClearedAt: 0,
      chat: [userMessage('server-old', 100, '旧内容'), userMessage('server-new', 900, '较新')],
    },
  }, 500);
  assert.equal(adopted.coach.chatClearedAt, 500);
  assert.deepEqual(adopted.coach.chat.map(message => message.id), ['server-new']);
});

test('coachChatAppend gives a missing timestamp a watermark-safe `at`', () => {
  const profile = applyChanges(profileOf({ coach: { chatClearedAt: 5000, chat: [], log: [], snapshots: [] } }), prepareChanges([{
    kind: 'coachChatAppend',
    message: { id: 'm', role: 'user', kind: 'text', at: 0, text: '新' },
  }]));
  assert.equal(profile.coach.chat.length, 1);
  assert.ok(profile.coach.chat[0].at > 5000);

  // RN's `assistant` alias is persisted as Web's `role: 'coach'` + `kind: 'genui'`.
  const assistant = applyChanges(profileOf(), prepareChanges([{
    kind: 'coachChatAppend',
    message: {
      id: 'a1',
      role: 'assistant',
      at: 10,
      nodes: [{ id: 'p1', type: 'prose', text: '回答' }],
    },
  }]));
  assert.equal(assistant.coach.chat[0].role, 'coach');
  assert.equal(assistant.coach.chat[0].kind, 'genui');
});

test('coachProposalApplied is idempotent on replay', () => {
  const base = profileOf({
    coach: {
      chat: [{
        id: 'm1',
        role: 'coach',
        kind: 'genui',
        at: 100,
        nodes: [{ id: 'n1', type: 'proposal_action', title: '提案', changes: [] }],
      }],
      log: [],
      snapshots: [],
    },
  });
  const once = applyChanges(base, prepareChanges([{ kind: 'coachProposalApplied', messageId: 'm1', nodeId: 'n1' }]));
  assert.equal(once.coach.chat[0].nodes[0].applied, true);

  const twice = applyChanges(once, prepareChanges([{ kind: 'coachProposalApplied', messageId: 'm1', nodeId: 'n1' }]));
  assert.equal(twice.coach.chat[0].nodes[0].applied, true);
  assert.equal(twice.coach.chat.length, 1);
  assert.equal(bridge.applyCoachProposalApplied(once, { messageId: 'm1', nodeId: 'n1' }), once);
});

test('resolveExerciseName resolves built-ins, imported xunji-ex custom exercises and unknown ids', () => {
  const custom = {
    id: 'xunji-ex-shoulder-press',
    n: '自定义肩推',
    alias: 'Shoulder Press Custom',
  };
  const profile = { customEx: [custom] };
  assert.equal(bridge.resolveExerciseName('xunji-ex-shoulder-press', profile), '自定义肩推');
  assert.equal(bridge.resolveExerciseName('0043', profile), catalogueName('0043'));
  assert.notEqual(bridge.resolveExerciseName('0043', profile), '0043');
  assert.equal(bridge.resolveExerciseName('missing-id', profile), 'missing-id');
});

test('hydrate wrappers read completed work and print localized names (L-008)', () => {
  const now = Date.now();
  const profile = {
    unit: 'kg',
    workouts: [{
      id: 'w1',
      d: '2026-11-26',
      start: now - 3600000,
      end: now,
      name: '腿日',
      entries: [{
        id: '0043',
        sets: [
          { w: 100, r: 5, done: true },
          { w: 160, r: 5, done: false },
        ],
      }],
    }],
    customEx: [],
  };

  const trend = bridge.hydrateCoachTrend(profile, { exId: '0043', metric: 'weight', weeks: 8 });
  assert.equal(trend.sessions, 1);
  assert.equal(trend.last, 100, 'only `done: true` rows count');
  assert.equal(trend.name, catalogueName('0043'));

  const kpi = bridge.hydrateCoachKpi(profile, {
    items: [{ kind: 'exercise_stat', exId: '0043', metric: 'weight', weeks: 4 }],
  });
  assert.equal(kpi.items.length, 1);
  assert.equal(kpi.items[0].hasData, true);
  assert.equal(kpi.items[0].label, catalogueName('0043'));

  const hydrated = bridge.hydrateCoachNode(profile, {
    id: 't1',
    type: 'exercise_trend',
    exId: '0043',
    metric: 'weight',
    weeks: 4,
  });
  assert.equal(hydrated.type, 'exercise_trend');
  assert.equal(hydrated.data.last, 100);

  const muscle = bridge.hydrateCoachMuscleLoad(profile, { window: '72h' });
  assert.equal(muscle.sessions, 1);
  assert.equal(muscle.totalSets, 1, 'warm-ups and unticked rows stay out of the load');
  assert.ok(Object.keys(muscle.load).length > 0);
  assert.equal(muscle.window, '72h');

  const sessions = bridge.hydrateCoachKpi(profile, {
    items: [{ kind: 'session_count', weeks: 4 }],
  });
  assert.equal(sessions.items[0].kind, 'session_count');
  assert.equal(sessions.items[0].value, 1);
});
