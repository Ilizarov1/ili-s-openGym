/* The stub business adapter behind the write fence.
 *
 * A real write entry can replace this only once it can prove the same
 * atomicity: read the proposal, check the target version, write, mark consumed
 * in one account update. This stub touches only agent data.
 */
import { Injectable } from '@nestjs/common';
import { AgentError } from '../../agent-runtime/errors.js';
import type { AgentAccountData, AgentProposal } from './agent.types.js';
import { AgentMemoryStore } from './agent-memory.store.js';

@Injectable()
export class AgentProposalAdapter {
  constructor(private readonly memories: AgentMemoryStore) {}

  apply(data: AgentAccountData, proposal: AgentProposal): unknown {
    if (!Array.isArray(proposal.changes) || !proposal.changes.length) {
      throw new AgentError('invalid_request', 'a proposal needs at least one change');
    }
    if (proposal.kind === 'memory.save') {
      const { scope: _scope, ...memory } = this.memories.applyInData(data, proposal);
      return memory;
    }
    if (proposal.kind !== 'stub.write') {
      throw new AgentError('invalid_request', `unknown proposal kind: ${proposal.kind}`);
    }
    const targetId = Array.isArray(proposal.targetScope) ? proposal.targetScope[0] : '';
    const target = targetId ? data.stub.targets[targetId] : null;
    if (!target) {
      throw new AgentError('proposal_conflict', 'the proposal target no longer exists', {
        details: { targetId },
      });
    }
    if (proposal.targetVersion !== undefined && String(target.version) !== String(proposal.targetVersion)) {
      throw new AgentError('proposal_conflict', 'the target changed after the proposal was made', {
        details: { targetId, expected: proposal.targetVersion, current: target.version },
      });
    }
    const changes = Array.isArray(proposal.changes) ? proposal.changes : [];
    for (const raw of changes) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new AgentError('invalid_request', 'a proposal change must be an object');
      }
      const change = raw as Record<string, unknown>;
      if (change.field !== 'value') {
        throw new AgentError('invalid_request', `the stub adapter cannot change ${String(change.field)}`);
      }
      target.value = String(change.value);
    }
    target.version += 1;
    data.stub.writes.push({
      proposalId: proposal.proposalId,
      targetId,
      value: target.value,
      at: Date.now(),
    });
    return { targetId, version: target.version, value: target.value };
  }
}
