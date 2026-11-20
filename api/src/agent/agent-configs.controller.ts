import { Controller, Delete, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { agentCall, agentUid } from './agent.http.js';
import { AgentService } from './agent.service.js';

@Controller()
export class AgentConfigsController {
  constructor(
    private readonly sessions: SessionService,
    private readonly agent: AgentService,
  ) {}

  @SessionRequired()
  @Get('agent/configs')
  async list(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const uid = agentUid(req, this.sessions);
    const profiles = await agentCall(() => this.agent.listProfiles(uid));
    json(res, 200, { profiles });
  }

  @SessionRequired()
  @Post('agent/configs')
  async create(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const uid = agentUid(req, this.sessions);
    const body = await readBody(req);
    json(res, 201, await agentCall(() => this.agent.createProfile(uid, body)));
  }

  @SessionRequired()
  @Patch('agent/configs/:profileId')
  async update(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('profileId') profileId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    const body = await readBody(req);
    json(res, 200, await agentCall(() => this.agent.updateProfile(uid, profileId, body)));
  }

  @SessionRequired()
  @Delete('agent/configs/:profileId')
  async remove(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('profileId') profileId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    await agentCall(() => this.agent.deleteProfile(uid, profileId));
    json(res, 200, { ok: true });
  }
}
