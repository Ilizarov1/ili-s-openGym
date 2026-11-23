import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AI_SEARCH_DISPLAY_LIMIT,
  expandAiSearchMatch,
  matchAiSearch,
} from '../src/agent/ai-search-matcher.ts';

function makeExercise(id, name, n, bodyPart, equipment) {
  return {
    id,
    name,
    aliases: [],
    n,
    bp: bodyPart,
    eq: equipment,
    tg: 'pectorals',
    bodyPart,
    equipment,
    target: 'pectorals',
    cardio: bodyPart === 'cardio',
    custom: false,
  };
}

function makeSource(pool, scoreMap = {}) {
  return {
    search() {
      return { items: [], total: 0, suggestions: [] };
    },
    aiSearch: {
      pool,
      bodyPartValues: ['chest', 'shoulders', 'back', 'upper legs', 'upper arms'],
      equipmentValues: ['dumbbell', 'barbell', 'leverage machine', 'cable', 'body weight'],
      searchScored(query) {
        const key = String(query || '').trim();
        const exactHits = scoreMap[key];
        if (exactHits) return exactHits;
        const lower = key.toLowerCase();
        return pool
          .map(exercise => {
            const nameMatch = exercise.name.toLowerCase().includes(lower)
              || (exercise.n && exercise.n.toLowerCase().includes(lower));
            return nameMatch ? { exercise, score: 85 } : null;
          })
          .filter(Boolean);
      },
    },
  };
}

const POOL = [
  makeExercise('0001', '哑铃卧推', 'dumbbell bench press', 'chest', 'dumbbell'),
  makeExercise('0002', '上斜哑铃卧推', 'incline dumbbell press', 'chest', 'dumbbell'),
  makeExercise('0003', '下斜哑铃卧推', 'decline dumbbell press', 'chest', 'dumbbell'),
  makeExercise('0004', '哑铃飞鸟', 'dumbbell fly', 'chest', 'dumbbell'),
  makeExercise('0005', '坐姿器械推胸', 'lever chest press', 'chest', 'leverage machine'),
  makeExercise('0006', '杠铃卧推', 'barbell bench press', 'chest', 'barbell'),
  makeExercise('0007', '绳索夹胸', 'cable chest fly', 'chest', 'cable'),
  makeExercise('0008', '哑铃推举', 'dumbbell shoulder press', 'shoulders', 'dumbbell'),
  makeExercise('0009', '哑铃侧平举', 'dumbbell lateral raise', 'shoulders', 'dumbbell'),
  makeExercise('0010', '哑铃前平举', 'dumbbell front raise', 'shoulders', 'dumbbell'),
  makeExercise('0011', '哑铃弯举', 'dumbbell bicep curl', 'upper arms', 'dumbbell'),
  makeExercise('0012', '俯卧撑', 'push up', 'chest', 'body weight'),
];

test('AI_SEARCH_DISPLAY_LIMIT is 10', () => {
  assert.equal(AI_SEARCH_DISPLAY_LIMIT, 10);
});

test('expandAiSearchMatch preserves primary items and fills up to 10 deduplicated items', () => {
  const source = makeSource(POOL, {
    '哑铃卧推': [
      { exercise: POOL[0], score: 120 },
      { exercise: POOL[1], score: 95 },
      { exercise: POOL[2], score: 90 },
    ],
    'dumbbell bench press': [
      { exercise: POOL[0], score: 120 },
      { exercise: POOL[1], score: 95 },
      { exercise: POOL[2], score: 90 },
    ],
    '胸部推举': [
      { exercise: POOL[4], score: 80 },
    ],
  });

  const base = {
    items: [
      { exerciseId: '0001', name: '哑铃卧推', rationale: '核心主候选', level: 'high' },
      { exerciseId: '0005', name: '坐姿器械推胸', rationale: '次要主候选', level: 'medium' },
    ],
    fallback: {
      understanding: '用户在找哑铃练胸动作',
      bodyParts: ['chest'],
      equipment: ['dumbbell'],
    },
    clarifications: [],
  };

  const expanded = expandAiSearchMatch(
    source,
    {
      candidates: [
        { name: '哑铃卧推', nameEn: 'dumbbell bench press', bodyPart: 'chest', equipment: 'dumbbell', level: 'high' },
      ],
    },
    '胸部推举',
    base,
    AI_SEARCH_DISPLAY_LIMIT,
  );

  assert.equal(expanded.items.length, 10);
  // Original primary hits keep exact order, level, and rationale.
  assert.deepEqual(expanded.items[0], base.items[0]);
  assert.deepEqual(expanded.items[1], base.items[1]);

  // No duplicate exerciseIds.
  const ids = expanded.items.map(item => item.exerciseId);
  assert.equal(new Set(ids).size, ids.length);

  // Secondary scored hits (0002, 0003) appear before dimension-only fallback hits.
  assert.equal(expanded.items[2].exerciseId, '0002');
  assert.equal(expanded.items[2].level, 'low');
  assert.match(expanded.items[2].rationale, /^相近匹配/);
  assert.equal(expanded.items[3].exerciseId, '0003');
  assert.equal(expanded.items[3].level, 'low');

  // Dimension tiers fill remaining slots in priority order: (bp+eq) -> bp -> eq.
  const remainingIds = ids.slice(4);
  assert.ok(remainingIds.includes('0004'), 'chest + dumbbell should be included');
  assert.ok(remainingIds.includes('0006'), 'chest only should be included');
  assert.ok(remainingIds.includes('0007'), 'chest only should be included');
  assert.ok(remainingIds.includes('0012'), 'chest only should be included');
  for (const item of expanded.items.slice(2)) {
    assert.equal(item.level, 'low');
    assert.ok(item.rationale.length > 0);
  }
});

test('expandAiSearchMatch does not fabricate items when both items and candidates are empty (fallback-only)', () => {
  const source = makeSource(POOL);
  const base = {
    items: [],
    fallback: {
      understanding: '只是一张食物照片，没有训练动作',
      bodyParts: ['chest'],
      equipment: ['dumbbell'],
    },
    clarifications: [],
  };

  const expanded = expandAiSearchMatch(
    source,
    { candidates: [], fallback: base.fallback },
    '今天吃什么',
    base,
    AI_SEARCH_DISPLAY_LIMIT,
  );

  assert.equal(expanded.items.length, 0);
  assert.deepEqual(expanded, base);
});

test('matchAiSearch expands to maxItems when specified while keeping default limit at 5', () => {
  const source = makeSource(POOL);
  const structured = {
    candidates: [
      {
        name: '哑铃卧推',
        nameEn: 'dumbbell bench press',
        bodyPart: 'chest',
        equipment: 'dumbbell',
        rationale: '最贴合描述',
        level: 'high',
      },
    ],
    fallback: {
      understanding: '哑铃胸部推举动作',
      bodyParts: ['chest'],
      equipment: ['dumbbell'],
    },
  };

  const defaultResult = matchAiSearch(source, structured, '哑铃推胸');
  assert.ok(defaultResult.items.length <= 5, `expected default <= 5, got ${defaultResult.items.length}`);
  assert.equal(defaultResult.items[0].exerciseId, '0001');
  assert.equal(defaultResult.items[0].level, 'high');

  const tenResult = matchAiSearch(source, structured, '哑铃推胸', undefined, {
    maxItems: AI_SEARCH_DISPLAY_LIMIT,
  });
  assert.equal(tenResult.items.length, 10);
  assert.equal(tenResult.items[0].exerciseId, '0001');
  assert.equal(tenResult.items[0].level, 'high');
  assert.equal(new Set(tenResult.items.map(item => item.exerciseId)).size, 10);
});

test('matchAiSearch with fallback-only structured output stays empty even when maxItems is 10', () => {
  const source = makeSource(POOL);
  const structured = {
    candidates: [],
    fallback: {
      understanding: '未识别到健身器械',
      bodyParts: ['chest'],
      equipment: ['dumbbell'],
    },
  };

  const result = matchAiSearch(source, structured, '桌面水杯', undefined, {
    maxItems: AI_SEARCH_DISPLAY_LIMIT,
  });
  assert.equal(result.items.length, 0);
});
