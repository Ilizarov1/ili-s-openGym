import { Controller, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionRequired } from '../auth/access.decorators.js';
import { readBody, text } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import type { DbUser } from '../common/persistence/account-store.js';
import { PresenceService } from '../presence/presence.service.js';

/* Live-workout heartbeat. `active` replaces the row (clearing any hidden mark),
 * `reason: 'hidden'` keeps the first hidden time, anything else drops the row. */
@Controller()
export class ActivityController {
  constructor(private readonly presence: PresenceService) {}

  @SessionRequired()
  @Post('activity')
  async activity(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    const body = await readBody(req);
    if (body.active) {
      this.presence.heartbeat(user.id, {
        name: text(body.name).slice(0, 60),
        exIdx: +(body.exIdx as any) || 0,
        exTotal: +(body.exTotal as any) || 0,
        setsDone: +(body.setsDone as any) || 0,
        setsTotal: +(body.setsTotal as any) || 0,
        startedAt: +(body.startedAt as any) || Date.now(),
      });
    } else if (body.reason === 'hidden') {
      this.presence.setHidden(user.id, true);
    } else {
      this.presence.remove(user.id);
    }
    json(res, 200, { ok: true });
  }
}
