import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuditService } from '../audit/audit.service.js';
import { AdminOnly, OwnerOnly } from '../auth/access.decorators.js';
import { readBody, text } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import type { DbUser } from '../common/persistence/account-store.js';
import { AdminService } from './admin.service.js';
import { InviteService } from './invite.service.js';

@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly invites: InviteService,
    private readonly audit: AuditService,
  ) {}

  @AdminOnly()
  @Get('users')
  users(@Res() res: ServerResponse): void {
    json(res, 200, this.admin.listUsers());
  }

  @AdminOnly()
  @Get('user')
  user(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const id = new URL(req.url || '', 'http://x').searchParams.get('id');
    json(res, 200, this.admin.getUser(id));
  }

  @AdminOnly()
  @Post('user/recovery')
  async recovery(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    json(res, 200, this.admin.issueRecovery(req, body.id, (req as any).user as DbUser));
  }

  @AdminOnly()
  @Post('user/disable')
  async disable(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    json(res, 200, this.admin.setDisabled(req, body.id, body.disabled, (req as any).user as DbUser));
  }

  @AdminOnly()
  @Post('user/delete')
  async remove(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    json(res, 200, this.admin.deleteUser(req, body.id, (req as any).user as DbUser));
  }

  @OwnerOnly()
  @Post('user/role')
  async role(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    json(res, 200, this.admin.setRole(req, body.id, body.admin, (req as any).user as DbUser));
  }

  @OwnerOnly()
  @Post('owner')
  async owner(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    json(res, 200, this.admin.transferOwner(req, body.id, (req as any).user as DbUser));
  }

  @AdminOnly()
  @Get('invites')
  inviteList(@Res() res: ServerResponse): void {
    json(res, 200, this.invites.list());
  }

  @AdminOnly()
  @Post('invites/new')
  async inviteNew(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    json(res, 200, { invite: this.invites.create(req, (req as any).user as DbUser, body.note) });
  }

  @AdminOnly()
  @Post('invites/revoke')
  async inviteRevoke(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    this.invites.revoke(req, body.code, (req as any).user as DbUser);
    json(res, 200, { ok: true });
  }

  @AdminOnly()
  @Get('audit')
  auditList(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const query = new URL(req.url || '', 'http://x').searchParams;
    const limit = Math.max(1, Math.min(200, Number(query.get('limit')) || 100));
    const before = Number(query.get('before')) || Infinity;
    const cat = query.get('cat') || '';
    let rows = this.audit.keep(this.audit.rows()).reverse();
    if (cat === 'fail') rows = rows.filter(row => !row.ok);
    else if (cat) rows = rows.filter(row => String(row.ev).startsWith(cat + '.'));
    const page = rows.filter(row => row.id < before).slice(0, limit);
    json(res, 200, {
      events: page,
      total: rows.length,
      nextBefore: page.length === limit ? page[page.length - 1].id : null,
      enabled: this.audit.on,
      ip_mode: this.audit.ipMode,
      retention: { max: this.audit.max, days: this.audit.days },
      now: Date.now(),
    });
  }

  @OwnerOnly()
  @Post('audit/clear')
  auditClear(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    this.audit.clear(req, (req as any).user as DbUser);
    json(res, 200, { ok: true });
  }
}
