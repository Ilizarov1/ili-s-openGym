import { Controller, Param, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { json } from '../common/http/reply.js';
import { agentCall, agentUid } from './agent.http.js';
import { AgentService } from './agent.service.js';

@Controller()
export class AgentProposalsController {
  constructor(
    private readonly sessions: SessionService,
    private readonly agent: AgentService,
  ) {}

  @SessionRequired()
  @Post('agent/proposals/:proposalId/confirm')
  async confirm(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('proposalId') proposalId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    json(res, 200, await agentCall(() => this.agent.confirmProposal(uid, proposalId)));
  }

  @SessionRequired()
  @Post('agent/proposals/:proposalId/reject')
  async reject(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('proposalId') proposalId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    json(res, 200, await agentCall(() => this.agent.rejectProposal(uid, proposalId)));
  }
}
