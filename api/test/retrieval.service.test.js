import test from 'node:test';
import assert from 'node:assert/strict';
import { retrievalConfig, retrievalIndexKey, normalizedEndpoint, retrievalConfigured } from '../dist/src/agent/retrieval/config.js';
import { RetrievalService } from '../dist/src/agent/retrieval/retrieval.service.js';
import { FixtureRetrievalAdapter } from '../dist/src/agent/retrieval/fixture-retrieval.js';
import {
  buildRerankQuery,
  buildVectorQuery,
  buildWeightedTerms,
  hasVersionSuffix,
  stripNonSemanticSuffix,
} from '../dist/src/agent/retrieval/ranking.js';
import { assertExerciseSearchV2Output } from '../dist/src/agent/tasks/exercise-search-v2.js';

const config = {
  pgUrl: 'postgres://127.0.0.1:55432/opengym_retrieval', embeddingBackend: 'local',
  embeddingUrl: 'http://127.0.0.1:8765/v1/embeddings', embeddingModel: 'BAAI/bge-m3', embeddingDim: 1024,
  rerankBackend: 'local', rerankUrl: 'http://127.0.0.1:8765/v1/rerank', rerankModel: 'BAAI/bge-reranker-v2-m3',
  embeddingTimeoutMs: 5000, pgTimeoutMs: 3000, rerankTimeoutMs: 15000, catalogueHash: 'fixture', indexRetention: 3,
};
const recognition = {
  candidates: [
    { name: '坐姿杠铃推举', nameEn: 'seated barbell shoulder press', rationale: '杠铃坐姿向上推', level: 'high', equipment: 'barbell', bodyPart: 'shoulders' },
    { name: '坐姿哑铃肩推', nameEn: 'seated dumbbell shoulder press', rationale: '坐姿、双手上推', level: 'medium', equipment: 'dumbbell', bodyPart: 'shoulders' },
  ],
  fallback: { understanding: '坐姿向上推举', bodyParts: ['shoulders'], equipment: ['barbell'] },
};

test('retrieval configuration identity contains corpus and embedding endpoint/model/dimension', () => {
  assert.equal(normalizedEndpoint('https://user:secret@model.example/v1/embeddings?token=secret'), 'https://model.example/v1/embeddings');
  const a = retrievalIndexKey('catalogue-a', { ...config, embeddingUrl: 'https://model.example/v1/embeddings?key=one' });
  const b = retrievalIndexKey('catalogue-a', { ...config, embeddingUrl: 'https://model.example/v1/embeddings?key=two' });
  assert.equal(a, b);
  assert.notEqual(a, retrievalIndexKey('catalogue-b', config));
  assert.notEqual(a, retrievalIndexKey('catalogue-a', { ...config, embeddingModel: 'different-model' }));
  assert.equal(retrievalConfigured({ EXERCISE_SEARCH_PG_URL: 'postgres://localhost/db', EXERCISE_SEARCH_LOCAL_MODEL_URL: 'http://localhost:8765' }), true);
  assert.equal(retrievalConfigured({ EXERCISE_SEARCH_LOCAL_MODEL_URL: 'http://localhost:8765' }), false);
});

test('fixture goes through both recalls, fusion, rerank and confirmed equipment filter', async () => {
  const adapter = new FixtureRetrievalAdapter();
  const service = new RetrievalService({ connect: () => { throw new Error('fixture must not connect to PG'); }, end: async () => {} }, config, adapter);
  const stages = [];
  const result = await service.retrieve({
    input: { hintText: '坐姿肩推', confirmedEquipment: 'dumbbell' }, recognition,
    fixture: true, diagnostic: event => stages.push(event.stage),
  });
  assert.deepEqual(result.structured.rankedIds, ['1231']);
  assert.deepEqual(stages, ['retrieval_text', 'retrieval_vector', 'retrieval_fusion', 'rerank']);
  assert.deepEqual(result.historyMeta.matches.map(x => x.id), result.structured.rankedIds);
  assert.match(result.structured.items[0].rationale, /器械与识别条件一致/);
  assert.doesNotMatch(result.structured.items[0].rationale, /坐姿、双手上推/);
});

function withRetrievalEnv(run) {
  const keys = ['EXERCISE_SEARCH_PG_URL','EXERCISE_SEARCH_LOCAL_MODEL_URL','EXERCISE_SEARCH_EMBEDDING_BACKEND','EXERCISE_SEARCH_RERANK_BACKEND'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    EXERCISE_SEARCH_PG_URL: 'postgres://localhost/retrieval_test',
    EXERCISE_SEARCH_LOCAL_MODEL_URL: 'http://127.0.0.1:8765',
    EXERCISE_SEARCH_EMBEDDING_BACKEND: 'local',
    EXERCISE_SEARCH_RERANK_BACKEND: 'local',
  });
  return Promise.resolve().then(run).finally(() => {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
  });
}

function dbRow() {
  return { exercise_id: '1231', name_en: 'dumbbell seated one arm shoulder press', name_zh: '哑铃坐姿单臂肩部推举',
    rerank_text: 'dumbbell seated one arm shoulder press', equipment: 'dumbbell', body_part: 'shoulders', target: 'delts', posture: 'seated', score: .9 };
}

function retrievalHarness({ onQuery = () => undefined, delayedConnect = false } = {}) {
  const clients = [];
  let connectCount = 0;
  let resolveConnect;
  const pool = {
    connect() {
      connectCount++;
      if (delayedConnect) return new Promise(resolve => { resolveConnect = resolve; });
      const client = makeClient();
      clients.push(client);
      return Promise.resolve(client);
    },
    end: async () => {},
  };
  function makeClient() {
    const client = { id: clients.length, releases: [], statements: [], activeReject: undefined };
    client.query = async (sql, params) => {
      client.statements.push(sql);
      const override = onQuery(sql, client, params);
      if (override !== undefined) return await override;
      if (/SELECT build_id FROM retrieval_index_builds/.test(sql)) return { rows: [{ build_id: 'build-test' }], rowCount: 1 };
      if (/SELECT 1 FROM retrieval_index_builds/.test(sql)) return { rows: [{}], rowCount: 1 };
      if (/FROM retrieval_exercise_terms/.test(sql) || /WITH nearest AS/.test(sql)) return { rows: [dbRow()], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    };
    client.release = error => {
      client.releases.push(error);
      client.activeReject?.(error);
    };
    return client;
  }
  if (delayedConnect) {
    pool.resolve = () => { const client = makeClient(); clients.push(client); resolveConnect(client); };
  }
  return { pool, clients, get connectCount() { return connectCount; } };
}

const models = {
  embedText: async () => Array(1024).fill(0.01),
  rerank: async (_query, docs) => docs.map((_, index) => ({ index, relevanceScore: .91 })),
};

test('concurrent database retrievals reuse each pinned connection for both recall transactions', async () => withRetrievalEnv(async () => {
  const harness = retrievalHarness();
  const service = new RetrievalService(harness.pool, config, undefined, models);
  const requests = [0,1].map(() => service.retrieve({ input: { hintText: '坐姿', confirmedEquipment: 'dumbbell' }, recognition }));
  const results = await Promise.all(requests);
  assert.equal(harness.connectCount, 2);
  for (const client of harness.clients) {
    assert.equal(client.releases.length, 1);
    assert.equal(client.statements.filter(sql => sql === 'BEGIN READ ONLY').length, 4);
    assert.ok(client.statements.some(sql => /FROM retrieval_exercise_terms/.test(sql)));
    assert.ok(client.statements.some(sql => /WITH nearest AS/.test(sql)));
    assert.equal(client.statements.filter(sql => /hnsw\.ef_search/.test(sql)).length, 1);
    assert.equal(client.statements.filter(sql => /hnsw\.iterative_scan/.test(sql)).length, 1);
  }
  assert.ok(results.every(result => result.structured.rankedIds[0] === '1231'));
  assert.match(results[0].structured.items[0].rationale, /器械与识别条件一致/);
  assert.doesNotMatch(results[0].structured.items[0].rationale, /坐姿、双手上推/);
}));

test('a connection returned after cancellation is destroyed exactly once', async () => withRetrievalEnv(async () => {
  const harness = retrievalHarness({ delayedConnect: true });
  const service = new RetrievalService(harness.pool, config, undefined, models);
  const controller = new AbortController();
  const pending = service.retrieve({ input: {}, recognition, signal: controller.signal });
  controller.abort();
  harness.pool.resolve();
  await assert.rejects(pending, error => error.code === 'run_cancelled');
  assert.equal(harness.connectCount, 1);
  assert.equal(harness.clients[0].releases.length, 1);
  assert.ok(harness.clients[0].releases[0] instanceof Error);
}));

test('cancellation during a pinned read destroys the shared connection exactly once', async () => withRetrievalEnv(async () => {
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const harness = retrievalHarness({ onQuery: (sql, client) => {
    if (!/FROM retrieval_exercise_terms/.test(sql)) return undefined;
    return new Promise((_resolve, reject) => { client.activeReject = reject; markStarted(); });
  } });
  const service = new RetrievalService(harness.pool, config, undefined, models);
  const controller = new AbortController();
  const pending = service.retrieve({ input: { confirmedEquipment: 'dumbbell' }, recognition, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, error => error.code === 'run_cancelled');
  assert.equal(harness.connectCount, 1);
  assert.equal(harness.clients[0].releases.length, 1);
  assert.ok(harness.clients[0].releases[0] instanceof Error);
}));

test('a PostgreSQL statement timeout destroys the pinned connection exactly once', async () => withRetrievalEnv(async () => {
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const harness = retrievalHarness({ onQuery: sql => /FROM retrieval_exercise_terms/.test(sql) ? Promise.reject(timeout) : undefined });
  const service = new RetrievalService(harness.pool, config, undefined, models);
  await assert.rejects(service.retrieve({ input: { confirmedEquipment: 'dumbbell' }, recognition }), error => error.code === 'retrieval_timeout');
  assert.equal(harness.clients[0].releases.length, 1);
  assert.equal(harness.clients[0].releases[0], timeout);
}));

test('out-of-range rerank scores remain ordered but receive no confidence level', async () => withRetrievalEnv(async () => {
  const harness = retrievalHarness();
  const service = new RetrievalService(harness.pool, config, undefined, { ...models, rerank: async () => [{ index: 0, relevanceScore: 1.2 }] });
  const result = await service.retrieve({ input: { hintText: '坐姿', confirmedEquipment: 'dumbbell' }, recognition });
  assert.deepEqual(result.structured.rankedIds, ['1231']);
  assert.equal(result.structured.items[0].level, undefined);
  assert.match(result.structured.items[0].rationale, /器械与识别条件一致/);
}));

test('retrieval error diagnostics preserve a confirmed equipment flag', async () => withRetrievalEnv(async () => {
  const harness = retrievalHarness({ onQuery: sql => /FROM retrieval_exercise_terms/.test(sql) ? Promise.reject(new Error('text failed')) : undefined });
  const service = new RetrievalService(harness.pool, config, undefined, models);
  const events = [];
  await assert.rejects(service.retrieve({ input: { confirmedEquipment: 'dumbbell' }, recognition, diagnostic: event => events.push(event) }));
  assert.equal(events.at(-1).stage, 'retrieval_text');
  assert.equal(events.at(-1).hasConfirmedEquipment, true);
  assert.equal(harness.clients[0].releases.length, 1);
  assert.equal(harness.clients[0].releases[0], undefined);
}));

test('fixture drops unknown IDs and duplicate or invalid reranker indices', async () => {
  const adapter = new FixtureRetrievalAdapter();
  const unknown = { exercise_id: 'not-public', name_en: 'unknown', name_zh: '未知', rerank_text: 'unknown', equipment: 'barbell', body_part: 'shoulders', target: '', posture: '', score: 1 };
  adapter.textRecall = () => [unknown];
  adapter.vectorRecall = () => [unknown];
  adapter.rerank = () => [{ index: 0, relevanceScore: .9 }, { index: 0, relevanceScore: .8 }, { index: 7, relevanceScore: 1 }];
  const service = new RetrievalService({ connect: () => { throw new Error('fixture must not connect to PG'); }, end: async () => {} }, config, adapter);
  const unknownResult = await service.retrieve({ input: {}, recognition, fixture: true });
  assert.deepEqual(unknownResult.structured.rankedIds, []);

  const known = new FixtureRetrievalAdapter().textRecall(['barbell'], 'barbell')[0];
  adapter.textRecall = () => [known, known];
  adapter.vectorRecall = () => [known, known];
  adapter.rerank = () => [{ index: 0, relevanceScore: .9 }, { index: 0, relevanceScore: .8 }, { index: 999, relevanceScore: 1 }];
  const duplicateResult = await service.retrieve({ input: {}, recognition, fixture: true });
  assert.ok(duplicateResult.structured.rankedIds.every(id => adapter.hasId(id)));
  assert.equal(new Set(duplicateResult.structured.rankedIds).size, duplicateResult.structured.rankedIds.length);
});

test('diagnostics preserve up to 75 recall items and 30 fusion items without truncating to 5', async () => withRetrievalEnv(async () => {
  const manyRows = Array.from({ length: 80 }, (_, index) => ({
    ...dbRow(),
    exercise_id: String(index + 1).padStart(4, '0'),
    score: 1 - index * 0.005,
  }));
  const harness = retrievalHarness({
    onQuery: sql => (/FROM retrieval_exercise_terms/.test(sql) || /WITH nearest AS/.test(sql) ? { rows: manyRows, rowCount: manyRows.length } : undefined),
  });
  const service = new RetrievalService(harness.pool, config, undefined, models);
  const events = [];
  await service.retrieve({ input: { hintText: '坐姿推胸' }, recognition, diagnostic: event => events.push(event) });
  const byStage = Object.fromEntries(events.map(event => [event.stage, event]));
  assert.equal(byStage.retrieval_text.top.length, 75);
  assert.equal(byStage.retrieval_vector.top.length, 75);
  assert.equal(byStage.retrieval_fusion.top.length, 30);
  assert.equal(byStage.rerank.top.length, 10);
}));

test('buildRerankQuery and buildVectorQuery place candidate names first and omit noisy understanding from rerank', () => {
  const longUnderstanding = '一台放在力量区角落里的红色挂片式推胸器械，旁边有镜子和哑铃架，地面铺设黑色橡胶地垫，远处还可以看到龙门架与深蹲架以及许多其他器材。'.repeat(2);
  const rec = {
    candidates: [
      { name: '杠杆推胸', nameEn: 'lever chest press', rationale: '坐姿前推', level: 'high', equipment: 'leverage machine', bodyPart: 'chest' },
      { name: '杠杆上斜推胸', nameEn: 'lever incline chest press', rationale: '略微上斜', level: 'medium', equipment: 'leverage machine', bodyPart: 'chest' },
    ],
    fallback: { understanding: longUnderstanding, bodyParts: ['chest'], equipment: ['leverage machine'] },
  };
  const rerankQuery = buildRerankQuery({ hint: '坐姿推胸机', recognition: rec });
  assert.match(rerankQuery, /^English: lever chest press\. Chinese: 杠杆推胸/);
  assert.match(rerankQuery, /Attributes: chest, leverage machine, seated/);
  assert.ok(rerankQuery.includes('坐姿推胸机'));
  assert.equal(rerankQuery.includes('黑色橡胶地垫'), false);

  const vectorQuery = buildVectorQuery({ hint: '坐姿推胸机', recognition: rec });
  assert.match(vectorQuery, /^English: lever chest press\. Chinese: 杠杆推胸/);
  assert.match(vectorQuery, /Attributes: chest, leverage machine, seated/);
  assert.ok(vectorQuery.length < longUnderstanding.length + 120);

  const weighted = buildWeightedTerms(rec.candidates, '坐姿推胸机');
  const byTerm = Object.fromEntries(weighted.map(w => [w.term, w.weight]));
  assert.equal(byTerm['lever chest press'], 1);
  assert.equal(byTerm['坐姿推胸机'], 0.95);
  assert.ok(byTerm['lever incline chest press'] < byTerm['lever chest press']);
});

test('stripNonSemanticSuffix and version detection clean catalogue wrappers cleanly', () => {
  assert.equal(stripNonSemanticSuffix('lever incline chest press (plate loaded)'), 'lever incline chest press');
  assert.equal(stripNonSemanticSuffix('lever chest press v. 4'), 'lever chest press');
  assert.equal(stripNonSemanticSuffix('lever seated leg extension (version 2)'), 'lever seated leg extension');
  assert.equal(hasVersionSuffix('lever chest press v. 4'), true);
  assert.equal(hasVersionSuffix('lever high row (plate loaded) v. 2'), true);
  assert.equal(hasVersionSuffix('lever chest press'), false);
});

test('SQL selects aliases and weighted textRecall suppresses lower-ranked low candidates', async () => withRetrievalEnv(async () => {
  const rowA = {
    exercise_id: '0576', name_en: 'lever chest press', name_zh: '杠杆推胸',
    aliases: ['seated chest press machine'], rerank_text: 'English: lever chest press',
    equipment: 'leverage machine', body_part: 'chest', target: 'pectorals', posture: 'seated', score: 1.0,
  };
  const rowB = {
    exercise_id: '1350', name_en: 'lever seated row', name_zh: '杠杆坐姿划船',
    aliases: [], rerank_text: 'English: lever seated row',
    equipment: 'leverage machine', body_part: 'back', target: 'upper back', posture: 'seated', score: 1.0,
  };
  const capturedQueries = [];
  const harness = retrievalHarness({
    onQuery: (sql, _client, params) => {
      if (/FROM retrieval_exercise_terms/.test(sql)) {
        capturedQueries.push({ sql, params });
        return { rows: [{ ...rowA, score: 1.0 }, { ...rowB, score: 0.756 }], rowCount: 2 };
      }
      if (/WITH nearest AS/.test(sql)) {
        return { rows: [rowA, rowB], rowCount: 2 };
      }
      return undefined;
    },
  });
  let seenRerankQuery = '';
  const service = new RetrievalService(harness.pool, config, undefined, {
    embedText: async () => Array(1024).fill(0.01),
    rerank: async (query, docs) => {
      seenRerankQuery = query;
      return docs.map((d, index) => ({ index, relevanceScore: d.id === '0576' ? 0.99 : 0.70 }));
    },
  });
  const events = [];
  const rec = {
    candidates: [
      { name: '杠杆推胸', nameEn: 'lever chest press', rationale: '胸推', level: 'high', equipment: 'leverage machine', bodyPart: 'chest' },
      { name: '杠杆坐姿划船', nameEn: 'lever seated row', rationale: '低置信', level: 'low', equipment: 'leverage machine', bodyPart: 'back' },
    ],
    fallback: { understanding: '推胸机', bodyParts: ['chest'], equipment: ['leverage machine'] },
    clarifications: [{ label: '冗余消歧', prompt: '不应保留' }],
  };
  const result = await service.retrieve({
    input: { hintText: '推胸机' }, recognition: rec, diagnostic: e => events.push(e),
  });
  assert.equal(capturedQueries.length, 1);
  assert.match(capturedQueries[0].sql, /UNNEST\(/i);
  assert.match(capturedQueries[0].sql, /d\.aliases/);
  assert.deepEqual(capturedQueries[0].params[4], [0.95, 1, 1, 0.756, 0.756]);
  assert.equal(harness.clients[0].statements.filter(sql => sql === 'BEGIN READ ONLY').length, 4);
  assert.match(seenRerankQuery, /^English: lever chest press/);
  assert.equal(result.structured.rankedIds[0], '0576');
  assert.equal(result.structured.items[0].level, 'high');
  assert.equal('clarifications' in result.structured, false);
  const textEvent = events.find(e => e.stage === 'retrieval_text');
  assert.ok(textEvent.top[0].score > textEvent.top[1].score);
  assertExerciseSearchV2Output(result.structured, new Set(['0576', '1350']));
}));

test('canonical exercise beats versioned, one-arm, equipment-conflicting, and posture-conflicting items', async () => withRetrievalEnv(async () => {
  const canonical = {
    exercise_id: '0576', name_en: 'lever chest press', name_zh: '杠杆推胸',
    aliases: ['seated chest press machine'], rerank_text: 'English: lever chest press',
    equipment: 'leverage machine', body_part: 'chest', target: 'pectorals', posture: 'seated', score: 0.95,
  };
  const versioned = {
    exercise_id: '2277', name_en: 'lever chest press v. 4', name_zh: '杠杆推胸 v. 4',
    aliases: [], rerank_text: 'English: lever chest press v. 4',
    equipment: 'leverage machine', body_part: 'chest', target: 'pectorals', posture: 'seated', score: 0.96,
  };
  const singleArm = {
    exercise_id: '5815', name_en: 'lever one arm side chest press', name_zh: '杠杆单臂侧向推胸',
    aliases: [], rerank_text: 'English: lever one arm side chest press',
    equipment: 'leverage machine', body_part: 'chest', target: 'pectorals', posture: 'seated', score: 0.97,
  };
  const conflictEq = {
    exercise_id: '1073', name_en: 'suspender chest press', name_zh: '悬挂带推胸',
    aliases: [], rerank_text: 'English: suspender chest press',
    equipment: 'suspension trainer', body_part: 'chest', target: 'pectorals', posture: '', score: 0.98,
  };
  const rows = [conflictEq, singleArm, versioned, canonical];
  const harness = retrievalHarness({
    onQuery: sql => (/FROM retrieval_exercise_terms/.test(sql) || /WITH nearest AS/.test(sql) ? { rows, rowCount: rows.length } : undefined),
  });
  const service = new RetrievalService(harness.pool, config, undefined, {
    embedText: async () => Array(1024).fill(0.01),
    rerank: async (_q, docs) => docs.map((d, index) => ({
      index,
      relevanceScore: d.id === '1073' ? 0.994 : d.id === '5815' ? 0.992 : d.id === '2277' ? 0.990 : 0.986,
    })),
  });
  const rec = {
    candidates: [
      { name: '杠杆推胸', nameEn: 'lever chest press', rationale: '坐姿推胸', level: 'high', equipment: 'leverage machine', bodyPart: 'chest' },
    ],
    fallback: { understanding: '坐姿挂片推胸', bodyParts: ['chest'], equipment: ['leverage machine'] },
  };
  const result = await service.retrieve({ input: { hintText: '坐姿推胸' }, recognition: rec });
  assert.equal(result.structured.rankedIds[0], '0576');
  assert.equal(result.structured.items[0].level, 'high');

  // Posture conflict in explicit hintText blocks wrong posture from winning or getting high
  const seatedRow = { ...canonical, exercise_id: '0576', posture: 'seated' };
  const lyingRow = {
    exercise_id: '1041', name_en: 'lever lying chest press (plate loaded)', name_zh: '杠杆仰卧推胸(挂片式)',
    aliases: ['lever lying chest press'], rerank_text: 'English: lever lying chest press',
    equipment: 'leverage machine', body_part: 'chest', target: 'pectorals', posture: 'supine', score: 0.9,
  };
  const postureHarness = retrievalHarness({
    onQuery: sql => (/FROM retrieval_exercise_terms/.test(sql) || /WITH nearest AS/.test(sql) ? { rows: [seatedRow, lyingRow], rowCount: 2 } : undefined),
  });
  const postureService = new RetrievalService(postureHarness.pool, config, undefined, {
    embedText: async () => Array(1024).fill(0.01),
    rerank: async (_q, docs) => docs.map((d, index) => ({ index, relevanceScore: d.id === '0576' ? 0.989 : 0.986 })),
  });
  const postureResult = await postureService.retrieve({ input: { hintText: '平躺在长凳上推举' }, recognition: rec });
  assert.equal(postureResult.structured.rankedIds[0], '1041');
  assert.notEqual(postureResult.structured.items[0].level, 'high');
}));

test('VLM medium/low ceiling is never promoted to high, and confusable pairs downgrade to medium with clarifications', async () => withRetrievalEnv(async () => {
  const chestRow = {
    exercise_id: '0576', name_en: 'lever chest press', name_zh: '杠杆推胸',
    aliases: [], rerank_text: 'English: lever chest press',
    equipment: 'leverage machine', body_part: 'chest', target: 'pectorals', posture: 'seated', score: 0.95,
  };
  const shoulderRow = {
    exercise_id: '0603', name_en: 'lever shoulder press', name_zh: '杠杆肩部推举',
    aliases: [], rerank_text: 'English: lever shoulder press',
    equipment: 'leverage machine', body_part: 'shoulders', target: 'delts', posture: 'seated', score: 0.92,
  };

  // 1. VLM medium ceiling stays medium despite 0.995 rerank score
  const medHarness = retrievalHarness({
    onQuery: sql => (/FROM retrieval_exercise_terms/.test(sql) || /WITH nearest AS/.test(sql) ? { rows: [chestRow], rowCount: 1 } : undefined),
  });
  const medService = new RetrievalService(medHarness.pool, config, undefined, {
    embedText: async () => Array(1024).fill(0.01),
    rerank: async () => [{ index: 0, relevanceScore: 0.995 }],
  });
  const medRec = {
    candidates: [{ name: '杠杆推胸', nameEn: 'lever chest press', rationale: '可能推胸', level: 'medium', equipment: 'leverage machine', bodyPart: 'chest' }],
    fallback: { understanding: '推胸机', bodyParts: ['chest'], equipment: ['leverage machine'] },
  };
  const medResult = await medService.retrieve({ input: {}, recognition: medRec });
  assert.equal(medResult.structured.items[0].level, 'medium');
  assert.ok(Array.isArray(medResult.structured.clarifications) && medResult.structured.clarifications.length > 0);

  // 2. Confusable top-2 downgrades high -> medium and supplies clarifications
  const confHarness = retrievalHarness({
    onQuery: sql => (/FROM retrieval_exercise_terms/.test(sql) || /WITH nearest AS/.test(sql) ? { rows: [chestRow, shoulderRow], rowCount: 2 } : undefined),
  });
  const confService = new RetrievalService(confHarness.pool, config, undefined, {
    embedText: async () => Array(1024).fill(0.01),
    rerank: async (_q, docs) => docs.map((d, index) => ({ index, relevanceScore: d.id === '0576' ? 0.99 : 0.95 })),
  });
  const confRec = {
    candidates: [
      { name: '杠杆推胸', nameEn: 'lever chest press', rationale: '推胸', level: 'high', equipment: 'leverage machine', bodyPart: 'chest' },
      { name: '杠杆肩推', nameEn: 'lever shoulder press', rationale: '推肩', level: 'medium', equipment: 'leverage machine', bodyPart: 'shoulders' },
    ],
    fallback: { understanding: '推举器械', bodyParts: ['chest', 'shoulders'], equipment: ['leverage machine'] },
  };
  const confResult = await confService.retrieve({ input: {}, recognition: confRec });
  assert.equal(confResult.structured.items[0].level, 'medium');
  assert.ok(Array.isArray(confResult.structured.clarifications) && confResult.structured.clarifications.length >= 2);
  assertExerciseSearchV2Output(confResult.structured, new Set(['0576', '0603']));
}));

test('panoramic low-confidence guard and score floor reject to empty rankedIds with valid schema', async () => withRetrievalEnv(async () => {
  const rows = [
    {
      exercise_id: '0576', name_en: 'lever chest press', name_zh: '杠杆推胸',
      aliases: [], rerank_text: 'English: lever chest press',
      equipment: 'leverage machine', body_part: 'chest', target: 'pectorals', posture: 'seated', score: 0.9,
    },
  ];
  const harness = retrievalHarness({
    onQuery: sql => (/FROM retrieval_exercise_terms/.test(sql) || /WITH nearest AS/.test(sql) ? { rows, rowCount: 1 } : undefined),
  });
  const service = new RetrievalService(harness.pool, config, undefined, {
    embedText: async () => Array(1024).fill(0.01),
    rerank: async () => [{ index: 0, relevanceScore: 0.98 }],
  });

  // 1. Panoramic multi-machine guard: all low across >= 3 (equipment, bodyPart) pairs with generic hint
  const panoramicRec = {
    candidates: [
      { name: 'lever chest press', rationale: '背景器械1', level: 'low', equipment: 'leverage machine', bodyPart: 'chest' },
      { name: 'lever seated row', rationale: '背景器械2', level: 'low', equipment: 'leverage machine', bodyPart: 'back' },
      { name: 'cable pushdown', rationale: '背景器械3', level: 'low', equipment: 'cable', bodyPart: 'upper arms' },
    ],
    fallback: { understanding: '健身房全景照片，包含多台器械', bodyParts: ['chest', 'back'], equipment: ['leverage machine', 'cable'] },
  };
  const panoramicResult = await service.retrieve({ input: { hintText: '找器械' }, recognition: panoramicRec });
  assert.deepEqual(panoramicResult.structured.rankedIds, []);
  assert.equal(panoramicResult.structured.items, undefined);
  assert.ok(Array.isArray(panoramicResult.structured.clarifications) && panoramicResult.structured.clarifications.length > 0);
  assertExerciseSearchV2Output(panoramicResult.structured, new Set(['0576']));

  // 2. Score Floor guard: low rawScore without exactMatch rejects to empty
  const lowScoreService = new RetrievalService(harness.pool, config, undefined, {
    embedText: async () => Array(1024).fill(0.01),
    rerank: async () => [{ index: 0, relevanceScore: 0.12 }],
  });
  const oodRec = {
    candidates: [{ name: 'orbital prism contraption', rationale: 'unknown', level: 'medium' }],
    fallback: { understanding: 'unknown device' },
  };
  const oodResult = await lowScoreService.retrieve({ input: {}, recognition: oodRec });
  assert.deepEqual(oodResult.structured.rankedIds, []);
  assert.equal(oodResult.structured.items, undefined);
  assertExerciseSearchV2Output(oodResult.structured, new Set(['0576']));
}));

test('rerankTopK slices only reranker pool while preserving 30-item fusion diagnostics', async () => withRetrievalEnv(async () => {
  assert.equal(retrievalConfig({}).rerankTopK, 30);
  assert.equal(retrievalConfig({ EXERCISE_SEARCH_RERANK_TOP_K: '16' }).rerankTopK, 16);
  assert.throws(() => retrievalConfig({ EXERCISE_SEARCH_RERANK_TOP_K: '9' }), /EXERCISE_SEARCH_RERANK_TOP_K/);
  assert.throws(() => retrievalConfig({ EXERCISE_SEARCH_RERANK_TOP_K: '31' }), /EXERCISE_SEARCH_RERANK_TOP_K/);

  const manyRows = Array.from({ length: 35 }, (_, index) => ({
    ...dbRow(),
    exercise_id: String(index + 1).padStart(4, '0'),
    score: 1 - index * 0.01,
  }));
  const harness = retrievalHarness({
    onQuery: sql => (/FROM retrieval_exercise_terms/.test(sql) || /WITH nearest AS/.test(sql) ? { rows: manyRows, rowCount: manyRows.length } : undefined),
  });
  let rerankedIds = [];
  const service = new RetrievalService(harness.pool, { ...config, rerankTopK: 16 }, undefined, {
    embedText: async () => Array(1024).fill(0.01),
    rerank: async (_q, docs) => {
      rerankedIds = docs.map(d => d.id);
      return docs.map((_, index) => ({ index, relevanceScore: 0.90 - index * 0.01 }));
    },
  });
  const events = [];
  await service.retrieve({ input: { hintText: '坐姿推胸' }, recognition, diagnostic: event => events.push(event) });
  const byStage = Object.fromEntries(events.map(event => [event.stage, event]));
  assert.equal(byStage.retrieval_fusion.top.length, 30);
  assert.equal(rerankedIds.length, 16);
  assert.deepEqual(rerankedIds, byStage.retrieval_fusion.top.slice(0, 16).map(item => item.id));
  assert.equal(byStage.rerank.top.length, 10);
}));

test('concurrent embedText starts before textRecall finishes and aborts cleanly on textRecall error', async () => withRetrievalEnv(async () => {
  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  try {
    let embedStarted = false;
    let embedAborted = false;
    const harness = retrievalHarness({
      onQuery: (sql) => {
        if (/FROM retrieval_exercise_terms/.test(sql)) {
          assert.equal(embedStarted, true, 'embedText should start before textRecall finishes');
          return Promise.reject(new Error('pg text recall boom'));
        }
        return undefined;
      },
    });
    const service = new RetrievalService(harness.pool, config, undefined, {
      embedText: (_text, signal) => {
        embedStarted = true;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            embedAborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
      rerank: async () => [],
    });
    const events = [];
    await assert.rejects(
      service.retrieve({ input: { hintText: '坐姿推胸' }, recognition, diagnostic: event => events.push(event) }),
      error => error.code === 'retrieval_unavailable',
    );
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(embedStarted, true);
    assert.equal(embedAborted, true);
    assert.equal(unhandled, 0);
    assert.equal(events.at(-1).stage, 'retrieval_text');
    assert.equal(harness.clients[0].statements.filter(sql => sql === 'BEGIN READ ONLY').length, 3);

    // Mirror: embedText fails early while textRecall is still in flight (no unhandledRejection)
    let releaseText;
    const textPending = new Promise(resolve => { releaseText = resolve; });
    const mirrorHarness = retrievalHarness({
      onQuery: (sql) => (/FROM retrieval_exercise_terms/.test(sql) ? textPending : undefined),
    });
    const mirrorService = new RetrievalService(mirrorHarness.pool, config, undefined, {
      embedText: async () => { throw new Error('embed service down'); },
      rerank: async () => [],
    });
    const mirrorEvents = [];
    const pendingRetrieve = mirrorService.retrieve({ input: { hintText: '坐姿推胸' }, recognition, diagnostic: event => mirrorEvents.push(event) });
    await new Promise(resolve => setTimeout(resolve, 20));
    releaseText({ rows: [dbRow()], rowCount: 1 });
    await assert.rejects(pendingRetrieve, error => error.code === 'retrieval_unavailable');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(unhandled, 0);
    assert.equal(mirrorEvents.at(-1).stage, 'retrieval_vector');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}));
