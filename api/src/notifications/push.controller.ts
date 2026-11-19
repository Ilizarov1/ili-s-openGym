/* /api/push routes, with the legacy request/response shapes.
 *
 * GET /api/push/public-key is public (the browser needs the key before it has
 * a session to subscribe with); every other route needs a session, enforced by
 * the global AccessGuard and @SessionRequired().
 */
import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Public, SessionRequired } from '../auth/access.decorators.js';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import type { DbUser } from '../common/persistence/account-store.js';
import { NotificationsService } from './notifications.service.js';

@Controller('push')
export class PushController {
  constructor(private readonly notifications: NotificationsService) {}

  @Public()
  @Get('public-key')
  publicKey(@Res() res: ServerResponse): void {
    json(res, 200, { key: this.notifications.publicKey() });
  }

  @SessionRequired()
  @Post('subscribe')
  async subscribe(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    const body = await readBody(req);
    this.notifications.subscribe(user, body);
    json(res, 200, { ok: true });
  }

  @SessionRequired()
  @Get('status')
  status(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const user = (req as any).user as DbUser;
    const endpoint = new URL(req.url || '/', 'http://x').searchParams.get('endpoint') || '';
    json(res, 200, this.notifications.status(user, endpoint));
  }

  @SessionRequired()
  @Post('unsubscribe')
  async unsubscribe(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    const body = await readBody(req);
    this.notifications.unsubscribe(user, body);
    json(res, 200, { ok: true });
  }

  @SessionRequired()
  @Post('test')
  async test(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    await this.notifications.test(user);
    json(res, 200, { ok: true });
  }

  @SessionRequired()
  @Post('rest-timer')
  async restTimer(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    const body = await readBody(req);
    this.notifications.restTimer(user, body);
    json(res, 200, { ok: true });
  }

  @SessionRequired()
  @Post('rest-timer/cancel')
  async cancelRestTimer(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    const body = await readBody(req);
    this.notifications.cancelRestTimer(user, body);
    json(res, 200, { ok: true });
  }
}
