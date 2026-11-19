/* Step-up proof for changes that add or remove a lasting way in.
 *
 * Ported from the legacy `proveOwner()`: either a WebAuthn assertion made for
 * this request (a `login` challenge from /api/login/options) or the account's
 * current password, only while PASSWORD_LOGIN is enabled. Used by pair/create.
 * Refusals are written here because the legacy helper answered them itself.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { MAX_LENGTH, passwordLength, verifyPassword } from '../../password.js';
import { AuditService } from '../audit/audit.service.js';
import { ChallengeStore } from '../auth/challenge.store.js';
import { SessionService } from '../auth/session.service.js';
import { ThrottleService } from '../auth/throttle.service.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { json } from '../common/http/reply.js';

export type OwnerProof = 'passkey' | 'password';

const hasPassword = (user: DbUser): boolean =>
  !!user && !!(user as any).pw && typeof (user as any).pw.h === 'string';

const passwordWayIn = (passwordLogin: boolean, user: DbUser): boolean =>
  passwordLogin && hasPassword(user);

const acctKey = (user: DbUser): string => 'acct:' + user.id;

@Injectable()
export class OwnerProofService {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly sessions: SessionService,
    private readonly challenges: ChallengeStore,
    private readonly throttle: ThrottleService,
    private readonly audit: AuditService,
  ) {}

  private async passkeyStepUp(user: DbUser, body: Record<string, unknown>): Promise<boolean> {
    const challenge = this.challenges.take(body.cid);
    if (!challenge || challenge.kind !== 'login') return false;
    const credential = body.credential as any;
    const row = (this.accounts.db.creds as any[]).find(
      c => c.id === credential?.id && c.userId === user.id,
    );
    if (!row) return false;
    try {
      const result = await (verifyAuthenticationResponse as any)({
        response: credential,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: false,
        credential: {
          id: row.id,
          publicKey: Buffer.from(row.publicKey, 'base64url'),
          counter: row.counter,
          transports: row.transports,
        },
      });
      if (!result.verified) return false;
      row.counter = result.authenticationInfo.newCounter;
      row.lastUsed = new Date().toISOString();
      return true;
    } catch {
      return false;
    }
  }

  async verify(
    req: IncomingMessage,
    res: ServerResponse,
    user: DbUser,
    body: Record<string, unknown>,
    act: string,
  ): Promise<OwnerProof | null> {
    if (body.credential) {
      if (await this.passkeyStepUp(user, body)) return 'passkey';
      this.audit.audit(req, 'auth.proof.fail', { ok: false, user, msg: 'step-up-failed', act });
      json(res, 403, { error: 'the passkey could not be verified', code: 'passkey' });
      return null;
    }
    if (!passwordWayIn(this.config.passwordLogin, user)) {
      json(res, 403, { error: 'confirm with your passkey first', code: 'passkey-required' });
      return null;
    }
    const current = typeof body.current === 'string' ? body.current : '';
    const wrongCurrent = (): null => {
      json(res, 403, { error: 'your current password is not right', code: 'current-wrong' });
      return null;
    };
    if (!current) {
      json(res, 403, { error: 'enter your current password', code: 'current-required' });
      return null;
    }

    const key = acctKey(user);
    const address = 'password|' + this.throttle.limitAddress(req);
    const wait = this.throttle.accountFails.retryAfter(key) || this.throttle.addrFails.retryAfter(address);
    if (wait) {
      json(
        res,
        429,
        { error: 'too many attempts, try again later', code: 'locked', retryAfter: wait },
        { 'Retry-After': String(wait) },
      );
      return null;
    }

    const byAccount = this.throttle.accountFails.attempt(key);
    const byAddress = this.throttle.addrFails.attempt(address);
    const settle = (): void => {
      byAccount.undo();
      byAddress.undo();
    };

    const record = (user as any).pw;
    let matches: boolean;
    try {
      matches = passwordLength(current) <= MAX_LENGTH && (await verifyPassword(current, record.h));
    } catch (e) {
      settle();
      throw e;
    }
    if (!matches) {
      this.audit.audit(req, 'auth.proof.fail', { ok: false, user, msg: 'bad-current', act });
      if (byAccount.lock) this.audit.audit(req, 'auth.password.locked', { ok: false, user });
      if (byAddress.lock) this.audit.audit(req, 'auth.throttled', { ok: false, msg: 'password' });
      return wrongCurrent();
    }
    // Changed or removed while the hash was being checked: it is no longer current.
    if ((user as any).pw !== record) {
      settle();
      return wrongCurrent();
    }
    this.throttle.accountFails.clear(key);
    byAddress.undo();
    return 'password';
  }

  /** The legacy after-await check: a sign-out, disable or reset may have ended the session. */
  stillSignedIn(req: IncomingMessage, user: DbUser): boolean {
    return this.sessions.readSession(req) === user;
  }
}
