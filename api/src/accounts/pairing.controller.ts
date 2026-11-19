import { Controller, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuditService } from '../audit/audit.service.js';
import { Public, SessionRequired } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { ThrottleService } from '../auth/throttle.service.js';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { OwnerProofService } from './owner-proof.service.js';
import { PairingStore } from './pairing.store.js';

@Controller('pair')
export class PairingController {
  constructor(
    private readonly pairings: PairingStore,
    private readonly proof: OwnerProofService,
    private readonly accounts: AccountStore,
    private readonly sessions: SessionService,
    private readonly throttle: ThrottleService,
    private readonly audit: AuditService,
  ) {}

  @SessionRequired()
  @Post('create')
  async create(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    const body = await readBody(req);
    const proof = await this.proof.verify(req, res, user, body, 'pair');
    if (!proof) return;
    // Awaited: a sign-out everywhere, a disable or an admin reset may have ended this session.
    if (!this.proof.stillSignedIn(req, user)) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    if (proof === 'passkey') this.accounts.save(); // the confirming passkey's counter and last use
    const code = this.pairings.create(user.id);
    this.audit.audit(req, 'auth.pair.create', { user, msg: proof });
    json(res, 200, { code });
  }

  /* No session required: the code is the credential, one-shot and five minutes
   * long. The response carries the token in the body, never a cookie. */
  @Public()
  @Post('redeem')
  async redeem(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const entry = this.pairings.take(body.code);
    if (!entry) {
      this.throttle.auditFail(req, 'auth.pair.fail', { ok: false, msg: 'code-invalid' });
      json(res, 400, { error: 'invalid or expired code', code: 'pair-invalid' });
      return;
    }
    const user = this.accounts.findUser(entry.uid);
    if (!user || user.disabled) {
      this.audit.audit(req, 'auth.pair.fail', { ok: false, uid: entry.uid, msg: 'user-unavailable' });
      json(res, 400, { error: 'invalid or expired code', code: 'pair-invalid' });
      return;
    }
    this.audit.audit(req, 'auth.pair.ok', { user });
    json(res, 200, { token: this.sessions.makeSession(user), user: this.accounts.publicUser(user) });
  }
}
