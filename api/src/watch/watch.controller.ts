/* The nine /api/watch routes, ported one-for-one from api/server.js.
 *
 * The page's side (pair, links, unlink, snapshot, events, ack) needs a session
 * and nothing more — minting a watch token only ever opens the two mailbox
 * routes. The watch's side (redeem, box GET/POST) uses the watch token itself
 * and is exempt from the session guard; `redeem` is also CSRF-exempt and
 * throttled by the shared address counters, exactly as in the legacy entry.
 */
import { Controller, Get, Post, Put, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuditService } from '../audit/audit.service.js';
import { Public, SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { ThrottleService } from '../auth/throttle.service.js';
import { readBody, text } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { AccountStore } from '../common/persistence/account-store.js';
import { WatchService } from './watch.service.js';

@Controller('watch')
export class WatchController {
  constructor(
    private readonly watch: WatchService,
    private readonly accounts: AccountStore,
    private readonly sessions: SessionService,
    private readonly throttle: ThrottleService,
    private readonly audit: AuditService,
  ) {}

  /* A session is all minting a code asks: the code itself only leads to the
   * mailbox. One live code per profile, ten minutes. */
  @SessionRequired()
  @Post('pair')
  pair(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const user = this.sessions.readSession(req);
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    const { code, exp } = this.watch.pairCode(user.id);
    this.audit.audit(req, 'auth.watch.pair', { user });
    json(res, 200, { code, exp });
  }

  /* No session: the code is the credential, one-shot and ten minutes long.
   * The body is read before the address check is repeated, as in the legacy
   * dispatcher — requests sent at once all passed the first one together. */
  @Public()
  @Post('redeem')
  async redeem(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const wait = this.throttle.pausedFor(req, 'watch');
    if (wait) {
      json(
        res,
        429,
        { error: 'too many attempts, try again later', code: 'locked', retryAfter: wait },
        { 'Retry-After': String(wait) },
      );
      return;
    }
    const uid = this.watch.redeemCode(text(body.code));
    const user = uid ? this.accounts.findUser(uid) : null;
    if (!user || user.disabled) {
      this.throttle.strikeAddress(req, 'watch');
      this.throttle.auditFail(req, 'auth.watch.fail', { ok: false, msg: 'code-invalid' });
      json(res, 400, { error: 'invalid or expired code', code: 'pair-invalid' });
      return;
    }
    const { token, link } = this.watch.createLink(user.id, this.watch.sessionVersion(user), text(body.name));
    this.audit.audit(req, 'auth.watch.ok', { user, msg: link.name });
    json(res, 200, { token, id: link.id, name: user.name || '' });
  }

  @SessionRequired()
  @Get('links')
  links(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const user = this.sessions.readSession(req);
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    json(res, 200, { links: this.watch.links(user.id) });
  }

  /* The link's token stops working at once; when it was the last one the
   * mailbox file goes too. */
  @SessionRequired()
  @Post('unlink')
  async unlink(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    const body = await readBody(req);
    const id = text(body.id) || null;
    const links = this.watch.unlink(user.id, id);
    this.audit.audit(req, 'auth.watch.unlink', { user });
    json(res, 200, { ok: true, links });
  }

  /* The page's side: its snapshot for the watches, and what they sent. */
  @SessionRequired()
  @Put('snapshot')
  async snapshot(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    const body = await readBody(req);
    if (!this.watch.links(user.id).length) {
      json(res, 409, { error: 'no watch paired', code: 'no-watch' });
      return;
    }
    const box = this.watch.readBox(user.id);
    if (!this.watch.putSnapshot(box, body.json)) {
      json(res, 400, { error: 'not a snapshot' });
      return;
    }
    this.watch.writeBox(user.id, box);
    json(res, 200, { ok: true });
  }

  @SessionRequired()
  @Get('events')
  events(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const user = this.sessions.readSession(req);
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    const links = this.watch.links(user.id);
    const seen = links.reduce((m, l) => Math.max(m, (l.seen as number) || 0), 0);
    json(res, 200, {
      events: links.length ? this.watch.queuedEvents(this.watch.readBox(user.id)) : [],
      paired: links.length,
      seen,
    });
  }

  @SessionRequired()
  @Post('ack')
  async ack(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    const body = await readBody(req);
    const box = this.watch.readBox(user.id);
    if (this.watch.ackEvents(box, body.ids)) this.watch.writeBox(user.id, box);
    json(res, 200, { ok: true });
  }

  /* The watch's side (its Side Service, with the watch token): the snapshot,
   * and its events. GET reaches the mailbox with the same token as POST, so
   * both are public to the session guard. */
  @Public()
  @Get('box')
  getBox(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const link = this.watch.watchLinkFor(req);
    if (!link) {
      json(res, 401, { error: 'not paired', code: 'watch-unpaired' });
      return;
    }
    const box = this.watch.readBox(link.userId);
    json(res, 200, { json: box.snapshot, at: box.snapAt });
  }

  @Public()
  @Post('box')
  async putBox(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const link = this.watch.watchLinkFor(req);
    if (!link) {
      json(res, 401, { error: 'not paired', code: 'watch-unpaired' });
      return;
    }
    const body = await readBody(req);
    const box = this.watch.readBox(link.userId);
    const accepted = this.watch.pushEvents(box, body.events);
    if (accepted.length) this.watch.writeBox(link.userId, box);
    json(res, 200, { accepted, json: box.snapshot, at: box.snapAt });
  }
}
