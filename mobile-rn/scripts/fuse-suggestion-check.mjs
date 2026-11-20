// Repeatable calibration check for the zero-result Fuse.js index. Runs without
// Android, Metro or a device:
//   node scripts/fuse-suggestion-check.mjs
import assert from 'node:assert/strict';
import { EXDB } from '../../frontend/src/lib/exercises-data.js';
import zh from '../../frontend/src/exercise-names/zh.js';
import { createFuseSuggestionIndex } from '../src/fuseSuggestionIndex.js';

const pool = EXDB.map(exercise => ({
  id: exercise.id,
  name: zh[exercise.id] ?? exercise.n,
  aliases: [],
  eq: exercise.eq,
  tg: exercise.tg,
}));

const hits = createFuseSuggestionIndex(pool).search('高位下啦', 12);
assert.ok(hits.length > 0, 'expected the typo to reach the pulldown family');
assert.ok(hits.every(exercise => exercise.name.includes('高位下拉')), 'candidate outside the target family');
console.log('full pool:', hits.slice(0, 3).map(exercise => `${exercise.id} ${exercise.name}`));

const cablePool = pool.filter(exercise => exercise.eq === 'cable');
const cable = createFuseSuggestionIndex(cablePool).search('高位下啦', 3);
assert.equal(cable.length, 3);
assert.ok(cable.every(exercise => exercise.eq === 'cable' && exercise.name.includes('高位下拉')));
console.log('cable pool:', cable.map(exercise => `${exercise.id} ${exercise.name}`));

assert.equal(createFuseSuggestionIndex(pool).search('卧堆', 3).length, 0, 'unrelated query should stay empty');
console.log('fuse suggestion check OK');
