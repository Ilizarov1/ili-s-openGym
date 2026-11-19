/* The 18 Coach routes, wired straight to api/coach/routes.js.
 *
 * The legacy factory owns the status codes, bodies, config reads and job
 * enqueueing; this controller only maps Nest route metadata onto the handler
 * map it builds once. User routes still answer their own 401/503 and the admin
 * routes still call their own requireAdmin, exactly as before the migration —
 * the guard is an additional front door, not a replacement.
 */
import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { coachRoutes } from '../../coach/routes.js';
import { AuditService } from '../audit/audit.service.js';
import { AdminOnly, SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { LifecycleCoordinator } from '../lifecycle/lifecycle.coordinator.js';

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

const handler = (routes: Record<string, RouteHandler>, key: string): RouteHandler => {
  const fn = routes[key];
  if (!fn) throw new Error(`coach route missing: ${key}`);
  return fn;
};

@Controller()
export class CoachController {
  private readonly routes: Record<string, RouteHandler>;

  constructor(
    private readonly sessions: SessionService,
    private readonly accounts: AccountStore,
    private readonly audit: AuditService,
    lifecycle: LifecycleCoordinator,
  ) {
    this.routes = coachRoutes({
      json,
      readBody,
      signal: lifecycle.signal,
      readSession: (req: IncomingMessage) => this.sessions.readSession(req),
      /* Same contract as server.js: 401 with no session, 403 plus one
         `admin.denied` row for a signed-in non-admin. */
      requireAdmin: (req: IncomingMessage, res: ServerResponse): DbUser | null => {
        const user = this.sessions.readSession(req);
        if (!user) {
          json(res, 401, { error: 'not signed in' });
          return null;
        }
        if (!this.accounts.isAdmin(user)) {
          this.audit.audit(req, 'admin.denied', { ok: false, user });
          json(res, 403, { error: 'forbidden' });
          return null;
        }
        return user;
      },
    }) as unknown as Record<string, RouteHandler>;
  }

  private call(key: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    return Promise.resolve(handler(this.routes, key)(req, res));
  }

  /* ------------------------------ user ------------------------------ */

  @SessionRequired()
  @Get('coach/disclosure')
  async disclosure(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('GET /api/coach/disclosure', req, res);
  }

  @SessionRequired()
  @Get('coach/status')
  async status(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('GET /api/coach/status', req, res);
  }

  @SessionRequired()
  @Post('coach/plan')
  async plan(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/coach/plan', req, res);
  }

  @SessionRequired()
  @Post('coach/review')
  async review(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/coach/review', req, res);
  }

  @SessionRequired()
  @Post('coach/debrief')
  async debrief(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/coach/debrief', req, res);
  }

  @SessionRequired()
  @Post('coach/ask')
  async ask(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/coach/ask', req, res);
  }

  @SessionRequired()
  @Post('coach/adapt')
  async adapt(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/coach/adapt', req, res);
  }

  @SessionRequired()
  @Get('coach/cohort')
  async cohort(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('GET /api/coach/cohort', req, res);
  }

  @SessionRequired()
  @Post('coach/cohort/share')
  async shareCohort(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/coach/cohort/share', req, res);
  }

  @SessionRequired()
  @Post('coach/pending/resolve')
  async resolvePending(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/coach/pending/resolve', req, res);
  }

  @SessionRequired()
  @Post('coach/forget')
  async forget(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/coach/forget', req, res);
  }

  @SessionRequired()
  @Get('coach/account')
  async account(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('GET /api/coach/account', req, res);
  }

  /* ------------------------------ admin ------------------------------ */

  @AdminOnly()
  @Get('admin/coach')
  async admin(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('GET /api/admin/coach', req, res);
  }

  @AdminOnly()
  @Post('admin/coach/config')
  async adminConfig(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/admin/coach/config', req, res);
  }

  @AdminOnly()
  @Post('admin/coach/test')
  async adminTest(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/admin/coach/test', req, res);
  }

  @AdminOnly()
  @Post('admin/coach/models')
  async adminModels(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/admin/coach/models', req, res);
  }

  @AdminOnly()
  @Post('admin/coach/connect')
  async adminConnect(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/admin/coach/connect', req, res);
  }

  @AdminOnly()
  @Post('admin/coach/disconnect')
  async adminDisconnect(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    await this.call('POST /api/admin/coach/disconnect', req, res);
  }
}
