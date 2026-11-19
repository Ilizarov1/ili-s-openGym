/* GET /api/nudge-check: the phone app's background check. Session required;
 * the answer is a few bytes (date, done, nudge, rev), never the workouts. */
import { Controller, Get, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SessionRequired } from '../auth/access.decorators.js';
import { json } from '../common/http/reply.js';
import type { DbUser } from '../common/persistence/account-store.js';
import { ReminderService } from './reminder.service.js';

@Controller()
export class NudgeController {
  constructor(private readonly reminders: ReminderService) {}

  @SessionRequired()
  @Get('nudge-check')
  nudgeCheck(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const user = (req as any).user as DbUser;
    const date = new URL(req.url || '/', 'http://x').searchParams.get('date') || '';
    json(res, 200, this.reminders.checkNudge(user, date));
  }
}
