/* The seven /api/integrations routes.
 *
 * The legacy factory owns the response shapes, the per-profile lookups and the
 * 401 it writes before a handler runs; this controller only gives Nest a way
 * in. Every handler is session-only (the default access level, also stated on
 * the class), so the AccessGuard refuses an anonymous request before it gets
 * here. A hub refusal with a `status` is answered by the factory itself; any
 * other error escapes to the global exception filter.
 */
import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { integrationRoutes } from '../../integrations/routes.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { IntegrationsService } from './integrations.service.js';

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

@SessionRequired()
@Controller('integrations')
export class IntegrationsController {
  private readonly handlers: Record<string, RouteHandler>;

  constructor(integrations: IntegrationsService, sessions: SessionService, audit: AuditService) {
    this.handlers = integrationRoutes({
      json,
      readBody,
      readSession: (req: IncomingMessage) => sessions.readSession(req),
      hub: integrations.hub,
      // The legacy default (`audit = () => {}`) narrows the parameter type to zero arguments.
      audit: ((req: IncomingMessage, ev: string, fields: Parameters<AuditService['audit']>[2]) =>
        audit.audit(req, ev, fields)) as any,
    }) as unknown as Record<string, RouteHandler>;
  }

  private run(key: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.handlers[key](req, res);
  }

  @Get()
  async list(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.run('GET /api/integrations', req, res);
  }

  @Post('connect')
  async connect(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.run('POST /api/integrations/connect', req, res);
  }

  @Post('update')
  async update(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.run('POST /api/integrations/update', req, res);
  }

  @Post('disconnect')
  async disconnect(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.run('POST /api/integrations/disconnect', req, res);
  }

  @Post('test')
  async test(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.run('POST /api/integrations/test', req, res);
  }

  @Post('retry')
  async retry(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.run('POST /api/integrations/retry', req, res);
  }

  @Get('log')
  async log(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.run('GET /api/integrations/log', req, res);
  }
}
