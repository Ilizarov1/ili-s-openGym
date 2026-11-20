import { Controller, Delete, Get, Param, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { json } from '../common/http/reply.js';
import { agentCall, agentUid } from './agent.http.js';
import { AgentService } from './agent.service.js';

@Controller()
export class AgentSessionsController {
  constructor(
    private readonly sessions: SessionService,
    private readonly agent: AgentService,
  ) {}

  @SessionRequired()
  @Get('agent/sessions')
  async list(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const uid = agentUid(req, this.sessions);
    const sessions = await agentCall(() => this.agent.listSessions(uid));
    json(res, 200, { sessions });
  }

  @SessionRequired()
  @Get('agent/sessions/:sessionId')
  async get(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('sessionId') sessionId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    json(res, 200, await agentCall(() => this.agent.getSession(uid, sessionId)));
  }

  @SessionRequired()
  @Delete('agent/sessions/:sessionId')
  async remove(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('sessionId') sessionId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    await agentCall(() => this.agent.deleteSession(uid, sessionId));
    json(res, 200, { ok: true });
  }
}
