/* POST /api/account/delete: the account's own exit.
 *
 * The legacy order: confirm the typed name, refuse the last admin, prove
 * ownership (a paired device token is proof when the profile has no password),
 * re-check the session and the admin count after every await, then delete.
 */
import { Controller, Inject, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuditService } from '../audit/audit.service.js';
import { SessionService } from '../auth/session.service.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { OwnerProofService } from './owner-proof.service.js';

const hasPassword = (user: DbUser): boolean =>
  !!user && !!(user as any).pw && typeof (user as any).pw.h === 'string';

@Controller('account')
export class AccountController {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly sessions: SessionService,
    private readonly proof: OwnerProofService,
    private readonly deletion: AccountDeletionService,
    private readonly audit: AuditService,
  ) {}

  private lastAdminLeaving(user: DbUser): boolean {
    const users = this.accounts.db.users;
    return this.accounts.isAdmin(user) && users.length > 1 && users.filter(u => this.accounts.isAdmin(u)).length <= 1;
  }

  @Post('delete')
  async remove(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const s = this.sessions.sessionOf(req);
    if (!s) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    const user = s.user;
    const body = await readBody(req);
    if (this.sessions.sessionOf(req)?.user !== user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    if (typeof body.name !== 'string' || body.name.trim() !== user.name) {
      json(res, 400, { error: 'type the account name to confirm', code: 'confirm-name' });
      return;
    }
    if (this.lastAdminLeaving(user)) {
      json(res, 409, { error: 'the last admin cannot leave while other profiles remain', code: 'last-admin' });
      return;
    }
    // A cookie value replayed as a Bearer is not a paired device: only a
    // token minted for a phone (`kind` other than `c`) proves ownership.
    const paired = s.bearer && s.kind !== 'c';
    const passwordWayIn = this.config.passwordLogin && hasPassword(user);
    const proof = paired && !passwordWayIn ? 'device' : await this.proof.verify(req, res, user, body, 'account-delete');
    if (!proof) return;
    if (this.sessions.readSession(req) !== user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    if (this.lastAdminLeaving(user)) {
      json(res, 409, { error: 'the last admin cannot leave while other profiles remain', code: 'last-admin' });
      return;
    }
    this.deletion.remove(user);
    this.audit.audit(req, 'auth.account.delete', { user, msg: proof });
    json(res, 200, { ok: true }, { 'Set-Cookie': this.sessions.clearCookies() });
  }
}
