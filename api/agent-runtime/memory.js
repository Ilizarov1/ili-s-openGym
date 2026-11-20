/* Long-term memory: selection, projection and the proposal path.
 *
 * Only records the user confirmed belong here. A model can propose one; the
 * same proposal fence that guards business writes guards this one.
 */
import { AgentError } from './errors.js';
import { isMemoryCategory } from './contracts.js';
import { createIds } from './ids.js';

const SECRET_KEY = /secret|token|api[_-]?key|password|credential|authorization|cookie/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = redact(child);
  }
  return out;
}

/**
 * @param {Array<Record<string, any>>} memories
 * @param {{ scope?: string, kinds?: string[], limit?: number, maxChars?: number }} [options]
 */
export function selectMemories(memories, options = {}) {
  const { scope, kinds, limit = 8, maxChars = 4000 } = options;
  const wanted = kinds && kinds.length ? new Set(kinds) : null;
  const chosen = [];
  const sorted = [...(memories || [])]
    .filter(memory => memory && typeof memory === 'object' && typeof memory.id === 'string')
    .filter(memory => {
      if (scope !== undefined && memory.scope !== undefined && memory.scope !== scope) return false;
      return !wanted || wanted.has(memory.category);
    })
    .sort((left, right) => {
      const byTime = (Number(right.updatedAt) || 0) - (Number(left.updatedAt) || 0);
      if (byTime) return byTime;
      const byVersion = (Number(right.version) || 0) - (Number(left.version) || 0);
      return byVersion || String(left.id).localeCompare(String(right.id));
    });
  let used = 0;
  for (const memory of sorted) {
    if (chosen.length >= limit) break;
    const size = JSON.stringify(memory.value ?? null).length;
    if (chosen.length && used + size > maxChars) continue;
    chosen.push(memory);
    used += size;
  }
  return chosen;
}

/** The memory shape the model sees: no internal metadata, no secret-looking fields. */
export function projectMemories(memories) {
  return (memories || []).map(memory => ({
    id: memory.id,
    category: memory.category,
    value: redact(memory.value),
    ...(memory.source === undefined ? {} : { source: memory.source }),
    ...(memory.updatedAt === undefined ? {} : { updatedAt: memory.updatedAt }),
    ...(memory.version === undefined ? {} : { version: memory.version }),
  }));
}

/**
 * @param {{
 *   ids?: ReturnType<typeof createIds>,
 *   runId?: string,
 *   scope: string,
 *   memory: { category: string, value: unknown, source?: string },
 *   targetVersion?: string | number,
 *   now?: () => number,
 * }} input
 */
export function createMemoryProposal(input) {
  const {
    ids = createIds(),
    runId,
    scope,
    memory,
    targetVersion,
    now = Date.now,
  } = input || {};
  if (!scope) throw new AgentError('invalid_request', 'a memory proposal needs a scope');
  if (!memory || typeof memory !== 'object') throw new AgentError('invalid_request', 'a memory proposal needs a memory');
  if (!isMemoryCategory(memory.category)) {
    throw new AgentError('invalid_request', 'unknown memory category', {
      details: { category: memory.category },
    });
  }
  if (memory.value === undefined) throw new AgentError('invalid_request', 'a memory proposal needs a value');
  return {
    proposalId: ids.proposal(),
    ...(runId ? { runId } : {}),
    kind: 'memory.save',
    changes: [{
      op: 'save',
      category: memory.category,
      value: redact(memory.value),
      ...(memory.source ? { source: String(memory.source).slice(0, 200) } : {}),
    }],
    targetScope: [scope],
    ...(targetVersion === undefined ? {} : { targetVersion }),
    status: 'pending',
    createdAt: now(),
  };
}

/**
 * An adapter for createProposalService that writes a confirmed memory.
 * The store's memories are expected to be scoped by the caller's account;
 * `scope` in the proposal is checked again here.
 */
export function createMemoryProposalAdapter(store) {
  if (!store || typeof store.create !== 'function') throw new Error('memory proposal adapter needs a store');
  return {
    async apply({ proposal }) {
      if (!proposal || proposal.kind !== 'memory.save') {
        throw new AgentError('invalid_request', 'not a memory proposal');
      }
      const change = Array.isArray(proposal.changes) ? proposal.changes[0] : null;
      if (!change || change.op !== 'save' || !isMemoryCategory(change.category)) {
        throw new AgentError('invalid_request', 'memory proposal changes are invalid');
      }
      if (!Array.isArray(proposal.targetScope) || proposal.targetScope.length !== 1) {
        throw new AgentError('scope_denied', 'memory proposal has an invalid scope');
      }
      return store.create({
        scope: proposal.targetScope[0],
        category: change.category,
        value: change.value,
        ...(change.source ? { source: change.source } : {}),
      });
    },
  };
}

/** A deterministic in-memory store for the shared tests. */
export function createMemoryStore(initial = [], now = Date.now) {
  const map = new Map();
  let seq = 0;
  const ids = createIds(() => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`);
  for (const memory of initial) map.set(memory.id, memory);
  return {
    list: () => [...map.values()],
    get: id => map.get(id) || null,
    create({ category, value, source, scope }) {
      if (!isMemoryCategory(category)) throw new AgentError('invalid_request', 'unknown memory category');
      const at = now();
      const memory = {
        id: ids.memory(),
        ...(scope === undefined ? {} : { scope }),
        category,
        value,
        ...(source === undefined ? {} : { source }),
        createdAt: at,
        updatedAt: at,
        version: 1,
      };
      map.set(memory.id, memory);
      return memory;
    },
    update(id, patch) {
      const current = map.get(id);
      if (!current) throw new AgentError('memory_not_found');
      const next = {
        ...current,
        ...(patch.category === undefined ? {} : { category: patch.category }),
        ...(patch.value === undefined ? {} : { value: patch.value }),
        ...(patch.source === undefined ? {} : { source: patch.source }),
        updatedAt: now(),
        version: (current.version || 0) + 1,
      };
      map.set(id, next);
      return next;
    },
    delete(id) {
      return map.delete(id);
    },
  };
}
