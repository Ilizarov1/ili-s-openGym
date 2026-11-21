/* Proposal persistence and one-time confirmation.
 *
 * The read of the original proposal, the target version check, the business
 * write and the `consumed` mark all happen inside one AgentStore.update, so a
 * concurrent confirmation sees the consumed proposal and returns its result.
 */
import { Injectable } from '@nestjs/common';
import { AgentError } from '../../agent-runtime/errors.js';
import type { AgentAccountData, AgentProposal } from './agent.types.js';
import { AgentStore } from './agent.store.js';

export interface AgentProposalApplyResult {
  proposal: AgentProposal;
  result: unknown;
  applied: boolean;
}

@Injectable()
export class AgentProposalStore {
  constructor(private readonly store: AgentStore) {}

  async save(uid: string, proposal: AgentProposal): Promise<AgentProposal> {
    return this.store.update(uid, data => {
      data.proposals[proposal.proposalId] = proposal;
      return proposal;
    });
  }

  async get(uid: string, proposalId: string): Promise<AgentProposal | null> {
    return this.store.read(uid).proposals[proposalId] || null;
  }

  async confirm(
    uid: string,
    proposalId: string,
    apply: (data: AgentAccountData, proposal: AgentProposal) => unknown,
  ): Promise<AgentProposalApplyResult> {
    return this.store.update(uid, data => {
      const proposal = data.proposals[proposalId];
      if (!proposal) throw new AgentError('proposal_not_found', undefined, { details: { proposalId } });
      if (proposal.status === 'consumed') {
        return { proposal, result: proposal.result, applied: false };
      }
      if (proposal.status !== 'pending') {
        throw new AgentError('proposal_consumed', 'this proposal can no longer be applied', {
          details: { proposalId, status: proposal.status },
        });
      }
      if (proposal.runId) {
        const run = data.runs[proposal.runId];
        if (!run || run.status !== 'completed') {
          // A late model answer must not become an applicable write after its
          // run was cancelled, interrupted or failed.
          throw new AgentError('proposal_consumed', 'the run that produced this proposal did not complete', {
            details: { proposalId, runId: proposal.runId, runStatus: run?.status },
          });
        }
      }
      const result = apply(data, proposal);
      const consumed: AgentProposal = {
        ...proposal,
        status: 'consumed',
        result,
        consumedAt: Date.now(),
      };
      data.proposals[proposalId] = consumed;
      return { proposal: consumed, result, applied: true };
    });
  }

  async reject(uid: string, proposalId: string): Promise<AgentProposal> {
    return this.store.update(uid, data => {
      const proposal = data.proposals[proposalId];
      if (!proposal) throw new AgentError('proposal_not_found', undefined, { details: { proposalId } });
      if (proposal.status === 'rejected') return proposal;
      if (proposal.status === 'consumed') {
        throw new AgentError('proposal_consumed', 'this proposal was already applied', { details: { proposalId } });
      }
      const rejected: AgentProposal = {
        ...proposal,
        status: 'rejected',
        rejectedAt: Date.now(),
      };
      data.proposals[proposalId] = rejected;
      return rejected;
    });
  }

  /** Drop the pending proposals of a run that can no longer complete. */
  async expireForRun(uid: string, runId: string): Promise<number> {
    return this.store.update(uid, data => {
      let count = 0;
      const at = Date.now();
      for (const proposal of Object.values(data.proposals)) {
        if (proposal.runId !== runId || proposal.status !== 'pending') continue;
        proposal.status = 'expired';
        proposal.rejectedAt = at;
        count++;
      }
      return count;
    });
  }
}
