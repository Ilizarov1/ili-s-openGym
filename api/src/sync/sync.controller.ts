/* GET/PUT /api/data and GET /api/data/rev.
 *
 * The global AccessGuard requires a session for these routes (the default
 * access level), and puts the live account on `req.user`. Bodies are read
 * here with the shared 5 MiB JSON reader; the compare-and-write itself is the
 * synchronous section in SyncService.
 */
import { Controller, Get, Put, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { SyncService, type ReqWithUser } from './sync.service.js';

@Controller('data')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get()
  getData(@Req() req: ReqWithUser, @Res() res: ServerResponse): void {
    const user = req.user;
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    const reply = this.sync.read(user.id);
    json(res, reply.status, reply.body);
  }

  @Get('rev')
  getRev(@Req() req: ReqWithUser, @Res() res: ServerResponse): void {
    const user = req.user;
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    json(res, 200, this.sync.readRev(user.id));
  }

  @Put()
  async putData(@Req() req: ReqWithUser, @Res() res: ServerResponse): Promise<void> {
    const user = req.user;
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    const body = await readBody(req);
    const reply = this.sync.write(user.id, body);
    json(res, reply.status, reply.body);
  }
}
