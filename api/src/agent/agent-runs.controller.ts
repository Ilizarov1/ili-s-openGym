import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { agentCall, agentUid } from './agent.http.js';
import { AgentService } from './agent.service.js';

@Controller()
export class AgentRunsController {
  constructor(
    private readonly sessions: SessionService,
    private readonly agent: AgentService,
  ) {}

  @SessionRequired()
  @Post('agent/runs')
  async start(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const uid = agentUid(req, this.sessions);
    const body = await readBody(req);
    const result = await agentCall(() => this.agent.start(uid, body));
    json(res, 202, result);
  }

  @SessionRequired()
  @Get('agent/runs/:runId')
  async get(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('runId') runId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    json(res, 200, await agentCall(() => this.agent.get(uid, runId)));
  }

  @SessionRequired()
  @Post('agent/runs/:runId/cancel')
  async cancel(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('runId') runId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    json(res, 200, await agentCall(() => this.agent.cancel(uid, runId)));
  }
}
