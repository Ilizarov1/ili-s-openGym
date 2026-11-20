/* Business-write proposals.
 *
 * A model never writes. It produces a structured proposal: immutable changes,
 * the task's target scope and the target version it saw. Confirmation can only
 * name a stored proposal; the adapter checks the version and applies the
 * change once. A repeated confirmation returns the first result.
 */
import { AgentError } from './errors.js';
import { createIds } from './ids.js';

const STATUSES = new Set(['pending', 'consumed', 'rejected', 'expired']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertArray(value, name) {
  if (!Array.isArray(value)) throw new AgentError('invalid_request', `proposal ${name} must be an array`);
  return value;
}

/**
 * @param {{
 *   store: { get(id: string): any, save(proposal: any): any },
 *   adapter: { apply(input: { proposal: any }): any },
 *   ids?: ReturnType<typeof createIds>,
 *   now?: () => number,
 * }} options
 */
export function createProposalService(options) {
  const { store, adapter, ids = createIds(), now = Date.now } = options || {};
  if (!store || typeof store.get !== 'function' || typeof store.save !== 'function') {
    throw new Error('createProposalService needs a proposal store');
  }
  if (!adapter || typeof adapter.apply !== 'function') {
    throw new Error('createProposalService needs an adapter with apply()');
  }
  const chains = new Map();

  async function get(proposalId) {
    if (typeof proposalId !== 'string' || !proposalId) {
      throw new AgentError('invalid_request', 'proposal id is required');
    }
    return (await store.get(proposalId)) || null;
  }

  async function create(input) {
    if (!input || typeof input !== 'object') throw new AgentError('invalid_request', 'proposal is required');
    if (typeof input.kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(input.kind)) {
      throw new AgentError('invalid_request', 'proposal kind is invalid');
    }
    const changes = assertArray(input.changes, 'changes');
    const targetScope = assertArray(input.targetScope, 'targetScope');
    for (const id of targetScope) {
      if (typeof id !== 'string' || !id) throw new AgentError('invalid_request', 'proposal targetScope must contain ids');
    }
    const proposal = {
      proposalId: input.proposalId || ids.proposal(),
      ...(input.runId ? { runId: input.runId } : {}),
      kind: input.kind,
      changes: structuredCloneSafe(changes),
      targetScope: [...targetScope],
      ...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion }),
      status: 'pending',
      createdAt: input.createdAt || now(),
      ...(input.meta === undefined ? {} : { meta: structuredCloneSafe(input.meta) }),
    };
    deepFreeze(proposal);
    await store.save(proposal);
    return proposal;
  }

  function serialise(proposalId, work) {
    const previous = chains.get(proposalId) || Promise.resolve();
    const next = previous.then(work, work);
    const tracked = next.catch(() => undefined);
    chains.set(proposalId, tracked);
    return next.finally(() => {
      if (chains.get(proposalId) === tracked) chains.delete(proposalId);
    });
  }

  async function confirmOnce(proposalId) {
    const proposal = await get(proposalId);
    if (!proposal) throw new AgentError('proposal_not_found', undefined, { details: { proposalId } });
    if (proposal.status === 'consumed') {
      return { proposal, result: proposal.result, applied: false };
    }
    if (proposal.status !== 'pending') {
      throw new AgentError('proposal_consumed', 'this proposal can no longer be applied', {
        details: { proposalId, status: proposal.status },
      });
    }
    const result = await adapter.apply({ proposal });
    const consumed = {
      ...proposal,
      status: 'consumed',
      result: structuredCloneSafe(result),
      consumedAt: now(),
    };
    deepFreeze(consumed);
    await store.save(consumed);
    return { proposal: consumed, result, applied: true };
  }

  return {
    create,
    get,
    confirm(proposalId) {
      return serialise(proposalId, () => confirmOnce(proposalId));
    },
    reject(proposalId) {
      return serialise(proposalId, async () => {
        const proposal = await get(proposalId);
        if (!proposal) throw new AgentError('proposal_not_found', undefined, { details: { proposalId } });
        if (proposal.status === 'rejected') return proposal;
        if (proposal.status === 'consumed') {
          throw new AgentError('proposal_consumed', 'this proposal was already applied', { details: { proposalId } });
        }
        const rejected = { ...proposal, status: 'rejected', rejectedAt: now() };
        deepFreeze(rejected);
        await store.save(rejected);
        return rejected;
      });
    },
  };
}

/** The in-memory store used by the shared tests and a single-process local run. */
export function createMemoryProposalStore(initial = []) {
  const map = new Map();
  for (const proposal of initial) map.set(proposal.proposalId, proposal);
  return {
    get: id => map.get(id) || null,
    save(proposal) {
      if (!proposal || !STATUSES.has(proposal.status)) throw new Error('invalid proposal status');
      map.set(proposal.proposalId, proposal);
    },
    all: () => [...map.values()],
  };
}

function structuredCloneSafe(value) {
  if (value === undefined) return undefined;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}
