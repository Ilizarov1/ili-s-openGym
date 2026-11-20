import { Controller, Delete, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { agentCall, agentUid } from './agent.http.js';
import { AgentService } from './agent.service.js';

@Controller()
export class AgentMemoriesController {
  constructor(
    private readonly sessions: SessionService,
    private readonly agent: AgentService,
  ) {}

  @SessionRequired()
  @Get('agent/memories')
  async list(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const uid = agentUid(req, this.sessions);
    const memories = await agentCall(() => this.agent.listMemories(uid));
    json(res, 200, { memories });
  }

  @SessionRequired()
  @Post('agent/memories')
  async create(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const uid = agentUid(req, this.sessions);
    const body = await readBody(req);
    json(res, 201, await agentCall(() => this.agent.createMemory(uid, body)));
  }

  @SessionRequired()
  @Patch('agent/memories/:memoryId')
  async update(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('memoryId') memoryId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    const body = await readBody(req);
    json(res, 200, await agentCall(() => this.agent.updateMemory(uid, memoryId, body)));
  }

  @SessionRequired()
  @Delete('agent/memories/:memoryId')
  async remove(@Req() req: IncomingMessage, @Res() res: ServerResponse, @Param('memoryId') memoryId: string): Promise<void> {
    const uid = agentUid(req, this.sessions);
    await agentCall(() => this.agent.deleteMemory(uid, memoryId));
    json(res, 200, { ok: true });
  }
}
