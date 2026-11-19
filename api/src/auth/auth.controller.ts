/* Session, passkey, password, account-credential and device-link routes.
 *
 * Paths are relative to the global `api` prefix. Password routes live in their
 * own controller because the whole set is absent (a plain 404, as before) while
 * PASSWORD_LOGIN is off; auth-routes.module.ts registers it conditionally.
 */
import { Controller, Delete, Get, Post, Req, Res, Inject } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { BusyError } from '../../password.js';
import { createDeviceLink, burnDeviceLink, dropDeviceLinks, findDeviceLink } from '../../device-link.js';
import {
  addPasskeyRecord,
  listPasskeys,
  MAX_PASSKEYS,
  passkeyRemovalRefused,
  removePasskeyRecord,
  renamePasskeyRecord,
  transportsOf,
} from '../../passkeys-store.js';
import { AuditService } from '../audit/audit.service.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { readBody, text } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { PresenceService } from '../presence/presence.service.js';
import { AdminOnly, Public, SessionRequired } from './access.decorators.js';
import { AuthService } from './auth.service.js';
import { ChallengeStore, type Challenge } from './challenge.store.js';
import { PasskeyService } from './passkey.service.js';
import {
  acctKey,
  EMAIL_ERRORS,
  hasPassword,
  PasswordService,
  passwordRecord,
  sessionVersion,
  WRONG,
} from './password.service.js';
import { SessionService } from './session.service.js';
import { ThrottleService } from './throttle.service.js';

type ChallengeExtra = Challenge & {
  code?: string;
  sv?: number;
  proof?: string;
  lh?: string;
};

const LIMIT = { error: `a profile can have at most ${MAX_PASSKEYS} passkeys`, code: 'passkey-limit' };
const LINK_INVALID = { error: 'that code is wrong, used or expired', code: 'link-invalid' };

const notSignedIn = (res: ServerResponse): void => json(res, 401, { error: 'not signed in' });
const disabledAnswer = (res: ServerResponse): void =>
  json(res, 403, { error: 'this account has been disabled', code: 'disabled' });
const nameTakenAnswer = (res: ServerResponse): void =>
  json(res, 409, { error: 'another profile already signs in with this name', code: 'name-taken' });

@Controller()
export class SessionController {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly sessions: SessionService,
    private readonly accounts: AccountStore,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  /* A paired phone's token is renewed once it is past half its life; a browser's
   * cookie is left alone, and a cookie replayed as a Bearer is not renewed. */
  @SessionRequired()
  @Get('me')
  me(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const session = this.sessions.sessionOf(req);
    if (!session) return notSignedIn(res);
    const renew =
      !!session.bearer &&
      session.kind !== 'c' &&
      session.exp - Date.now() < (this.config.sessionDays * 86400000) / 2;
    json(res, 200, {
      user: this.accounts.publicUser(session.user),
      ...(renew ? { token: this.sessions.makeSession(session.user) } : {}),
    });
  }

  // Reachable without a session: there is no cookie to clear, so it is a no-op 200.
  @Public()
  @Post('logout')
  logout(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const user = this.sessions.readSession(req);
    if (user) this.audit.audit(req, 'auth.logout', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': this.sessions.clearCookies() });
  }

  /* "Sign out everywhere": bump the session version, which invalidates every
   * cookie and Bearer ever issued for the account, and drop the pairing codes
   * and unused device links waiting to become one. Passkeys stay. */
  @SessionRequired()
  @Post('logout/all')
  logoutAll(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    user.sv = sessionVersion(user) + 1;
    this.auth.clearPairings(user.id);
    dropDeviceLinks(this.accounts.db as any, user.id);
    this.accounts.save();
    this.audit.audit(req, 'auth.logout.all', { user });
    json(res, 200, { ok: true }, { 'Set-Cookie': this.sessions.clearCookies() });
  }
}

@Controller()
export class PasskeyAuthController {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly audit: AuditService,
    private readonly throttle: ThrottleService,
    private readonly challenges: ChallengeStore,
    private readonly passkeys: PasskeyService,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Public()
  @Post('register/options')
  async registerOptions(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) {
      json(res, 400, { error: 'name required' });
      return;
    }
    const code = text(body.code).trim().toUpperCase();
    if (
      this.config.inviteOnly &&
      !this.accounts.db.invites.some(i => i.code === code && !i.usedBy && !i.revoked)
    ) {
      // The rejected code itself is never recorded.
      this.audit.audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      json(res, 403, { error: 'a valid invite code is required', code: 'invite' });
      return;
    }
    const uid = crypto.randomBytes(12).toString('base64url');
    const options = await this.passkeys.registrationOptions(uid, name);
    const cid = this.challenges.put({ kind: 'register', challenge: options.challenge, name, uid, code } as any);
    json(res, 200, { cid, options });
  }

  @Public()
  @Post('register/verify')
  async registerVerify(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const c = this.challenges.take(body.cid) as ChallengeExtra | null;
    if (!c || c.kind !== 'register' || !c.uid) {
      this.throttle.auditFail(req, 'auth.register.fail', { ok: false, msg: 'challenge-expired' });
      json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
      return;
    }
    let verification: any;
    try {
      verification = await this.passkeys.verifyRegistration(body, c.challenge);
    } catch (e) {
      // e.message can echo attacker-supplied response fields, so only the reason code is kept.
      this.throttle.auditFail(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'verify-error' });
      json(res, 400, this.passkeys.verifyAnswer(e));
      return;
    }
    if (!verification.verified) {
      this.throttle.auditFail(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'not-verified' });
      json(res, 400, { error: 'not verified' });
      return;
    }
    const credential = verification.registrationInfo.credential;
    const db = this.accounts.db;
    if (db.creds.find(x => x.id === credential.id)) {
      this.audit.audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'credential-exists' });
      json(res, 409, { error: 'credential already registered' });
      return;
    }
    // Re-check the invite at the last moment (it may have been used/revoked since options), then burn it.
    let invite: any = null;
    if (this.config.inviteOnly) {
      invite = db.invites.find(i => i.code === c.code && !i.usedBy && !i.revoked) || null;
      if (!invite) {
        this.audit.audit(req, 'auth.register.fail', { ok: false, name: c.name, msg: 'invite-invalid' });
        json(res, 403, { error: 'invite code is no longer valid, ask for a new one', code: 'invite' });
        return;
      }
    }
    const created = new Date().toISOString();
    const user = { id: c.uid, name: c.name || '', created } as unknown as DbUser;
    if (invite) {
      user.invitedBy = invite.code;
      invite.usedBy = user.id;
      invite.usedAt = created;
    }
    this.auth.claimFirstAdmin(req, user);
    db.users.push(user);
    db.creds.push({
      id: credential.id,
      userId: user.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: transportsOf((body.credential as any)?.response?.transports),
      // What Settings → Passkeys shows; a passkey from before then has neither.
      created,
      lastUsed: created,
    } as any);
    this.accounts.save();
    this.audit.audit(req, 'auth.register.ok', { user, msg: invite ? invite.code : undefined });
    json(res, 200, { user: this.accounts.publicUser(user) }, { 'Set-Cookie': this.sessions.sessionCookie(user) });
  }

  @Public()
  @Post('login/options')
  async loginOptions(@Res() res: ServerResponse): Promise<void> {
    const options = await this.passkeys.authenticationOptions();
    const cid = this.challenges.put({ kind: 'login', challenge: options.challenge });
    json(res, 200, { cid, options });
  }

  @Public()
  @Post('login/verify')
  async loginVerify(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const c = this.challenges.take(body.cid);
    if (!c || c.kind !== 'login') {
      this.throttle.auditFail(req, 'auth.login.fail', { ok: false, msg: 'challenge-expired' });
      json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
      return;
    }
    const db = this.accounts.db;
    const credentialId = (body.credential as any)?.id;
    const cred = db.creds.find(x => x.id === credentialId);
    if (!cred) {
      // No credential id goes in the log: it is a stable handle for one passkey.
      this.throttle.auditFail(req, 'auth.login.fail', { ok: false, msg: 'unknown-credential' });
      json(res, 404, { error: 'unknown passkey, create a profile first', code: 'unknown-credential' });
      return;
    }
    let verification: any;
    try {
      verification = await this.passkeys.verifyAuthentication(cred, body, c.challenge);
    } catch (e) {
      this.throttle.auditFail(req, 'auth.login.fail', {
        ok: false,
        user: db.users.find(u => u.id === cred.userId),
        uid: cred.userId,
        msg: 'verify-error',
      });
      json(res, 400, this.passkeys.verifyAnswer(e));
      return;
    }
    if (!verification.verified) {
      this.throttle.auditFail(req, 'auth.login.fail', {
        ok: false,
        user: db.users.find(u => u.id === cred.userId),
        uid: cred.userId,
        msg: 'not-verified',
      });
      json(res, 400, { error: 'not verified' });
      return;
    }
    (cred as any).counter = verification.authenticationInfo.newCounter;
    (cred as any).lastUsed = new Date().toISOString();
    this.accounts.save();
    const user = db.users.find(u => u.id === cred.userId);
    if (!user) {
      this.audit.audit(req, 'auth.login.fail', { ok: false, uid: cred.userId, msg: 'user-missing' });
      json(res, 500, { error: 'user missing' });
      return;
    }
    if (user.disabled) {
      this.audit.audit(req, 'auth.login.fail', { ok: false, user, msg: 'account-disabled' });
      disabledAnswer(res);
      return;
    }
    this.audit.audit(req, 'auth.login.ok', { user });
    json(res, 200, { user: this.accounts.publicUser(user) }, { 'Set-Cookie': this.sessions.sessionCookie(user) });
  }
}

@Controller()
export class PasswordController {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly throttle: ThrottleService,
    private readonly passwords: PasswordService,
    private readonly auth: AuthService,
    private readonly presence: PresenceService,
  ) {}

  @Public()
  @Post('login/password')
  async loginPassword(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const target = this.passwords.loginTarget(body);
    const pw = typeof body.password === 'string' ? body.password : '';
    if (!target || !pw) {
      json(res, 400, { error: 'name and password required', code: 'missing' });
      return;
    }
    const check = this.passwords.attempt(req, res, target.key);
    if (!check) return;
    const user = target.user;
    const rec = passwordRecord(user);
    if (!(await check.verify(pw, rec?.h))) {
      check.failed(user, 'bad-password', target.email ? 'unknown-email' : 'unknown-name');
      json(res, 401, WRONG);
      return;
    }
    // Right for the password read before the await — which a change, an admin
    // reset or a removal may have replaced since.
    const still = (): boolean =>
      !!user && hasPassword(user) && (user as { pw?: unknown }).pw === rec && target.resolve() === user;
    if (!still()) {
      check.void();
      json(res, 401, WRONG);
      return;
    }
    if (!user || user.disabled) {
      check.void();
      this.audit.audit(req, 'auth.password.fail', { ok: false, user, msg: 'account-disabled' });
      disabledAnswer(res);
      return;
    }
    check.ok();
    // A hash made with older parameters is replaced now, while the password is at hand.
    if (rec && this.passwords.needsRehash(rec.h)) {
      try {
        const h = await this.passwords.hash(pw);
        if (still() && user) {
          rec.h = h;
          this.accounts.save();
        }
      } catch (e) {
        if (!(e instanceof BusyError)) throw e;
      }
      if (!still()) {
        json(res, 401, WRONG);
        return;
      }
    }
    this.audit.audit(req, 'auth.password.ok', { user });
    json(res, 200, { user: this.accounts.publicUser(user) }, { 'Set-Cookie': this.sessions.sessionCookie(user) });
  }

  @Public()
  @Post('register/password')
  async registerPassword(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const name = text(body.name).trim().slice(0, 40);
    if (!name) {
      json(res, 400, { error: 'name required', code: 'missing' });
      return;
    }
    const db = this.accounts.db;
    const code = text(body.code).trim().toUpperCase();
    const invite = (): any => db.invites.find(i => i.code === code && !i.usedBy && !i.revoked);
    if (this.config.inviteOnly && this.passwords.addressPaused(req, res, 'signup')) return;
    if (this.config.inviteOnly && !invite()) {
      this.audit.audit(req, 'auth.register.denied', { ok: false, name, msg: 'invite-rejected' });
      this.passwords.strikeAddress(req, 'signup');
      json(res, 403, { error: 'a valid invite code is required', code: 'invite' });
      return;
    }
    const problem = this.passwords.passwordProblem(body.password, name);
    if (problem) return this.passwords.policyError(res, problem);
    const taken = (): void => nameTakenAnswer(res);
    // A name is also matched against every sign-in e-mail, so a name that is an
    // address is the e-mail question asked through the name field.
    const nameIsAddress = name.includes('@');
    if (nameIsAddress && this.passwords.addressPaused(req, res, 'email')) return;
    if (!nameIsAddress && this.passwords.nameTaken(name)) return taken();
    const hasEmail = typeof body.email === 'string' && body.email.trim() !== '';
    const email = hasEmail ? this.passwords.normalizeEmail(body.email) : null;
    if (hasEmail && !email) {
      json(res, 400, EMAIL_ERRORS.invalid);
      return;
    }
    const emailRefused = (): void => {
      this.passwords.strikeAddress(req, 'email');
      this.audit.audit(req, 'auth.register.fail', { ok: false, name, msg: 'email-taken' });
      json(res, 409, EMAIL_ERRORS.taken);
    };
    if (email && this.passwords.addressPaused(req, res, 'email')) return;
    const h = await this.passwords.hash(body.password);
    let inv: any = null;
    if (this.config.inviteOnly) {
      inv = invite();
      if (!inv) {
        this.audit.audit(req, 'auth.register.fail', { ok: false, name, msg: 'invite-invalid' });
        json(res, 403, { error: 'invite code is no longer valid, ask for a new one', code: 'invite' });
        return;
      }
    }
    if (this.passwords.nameTaken(name)) {
      // No name in the row: it is an address, and the log keeps none.
      if (nameIsAddress) {
        this.passwords.strikeAddress(req, 'email');
        this.audit.audit(req, 'auth.register.fail', { ok: false, msg: 'email-taken' });
      }
      return taken();
    }
    // No await from here to the push: nothing can take the address between this check and it.
    if (email && this.passwords.emailTaken(email)) return emailRefused();
    const created = new Date().toISOString();
    const user = {
      id: crypto.randomBytes(12).toString('base64url'),
      name,
      created,
      pw: { h, set: created },
    } as unknown as DbUser;
    if (email) user.email = email;
    if (inv) {
      user.invitedBy = inv.code;
      inv.usedBy = user.id;
      inv.usedAt = created;
    }
    this.auth.claimFirstAdmin(req, user);
    db.users.push(user);
    this.accounts.save();
    this.audit.audit(req, 'auth.register.ok', { user, msg: inv ? inv.code + ' · password' : 'password' });
    json(res, 200, { user: this.accounts.publicUser(user) }, { 'Set-Cookie': this.sessions.sessionCookie(user) });
  }

  @SessionRequired()
  @Get('account/password')
  accountPassword(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    json(res, 200, {
      set: hasPassword(user),
      setAt: passwordRecord(user)?.set || null,
      passkeys: this.auth.passkeyCount(user),
      name: user.name,
      nameTaken: this.passwords.nameTaken(user.name, user.id),
      // Only the owner's own session is ever handed their address.
      email: (user as { email?: unknown }).email || null,
    });
  }

  @SessionRequired()
  @Post('account/password')
  async setAccountPassword(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const session = this.sessions.sessionOf(req);
    if (!session) return notSignedIn(res);
    const { user } = session;
    const body = await readBody(req);
    const problem = this.passwords.passwordProblem(body.next, user.name);
    if (problem) return this.passwords.policyError(res, problem);
    const taken = (): void => nameTakenAnswer(res);
    if (this.passwords.nameTaken(user.name, user.id)) return taken();
    const proof = await this.auth.proveOwner(req, res, user, body, 'password');
    if (!proof) return;
    const h = await this.passwords.hash(body.next);
    // Everything above awaited: an admin reset, a disable or "sign out everywhere"
    // may have ended this session in the meantime.
    if (this.sessions.sessionOf(req)?.user !== user) return notSignedIn(res);
    if (this.passwords.nameTaken(user.name, user.id)) return taken();
    const first = !hasPassword(user);
    this.auth.setPassword(user, h);
    // Whatever pause wrong guesses put on this account was about a password that no longer exists.
    this.throttle.accountFails.clear(acctKey(user));
    this.accounts.save();
    this.audit.audit(req, first ? 'auth.password.set' : 'auth.password.change', { user, msg: proof });
    // This session carries on under the new version: a new cookie, or a new token for a phone.
    if (session.bearer) {
      json(res, 200, { ok: true, token: this.sessions.makeSession(user) });
      return;
    }
    json(res, 200, { ok: true }, { 'Set-Cookie': this.sessions.sessionCookie(user) });
  }

  @SessionRequired()
  @Delete('account/password')
  async deleteAccountPassword(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const lastWayIn = (): void =>
      json(res, 409, { error: 'the password is the only way into this profile', code: 'last-way-in' });
    if (!hasPassword(user)) {
      json(res, 200, { ok: true });
      return;
    }
    if (!this.auth.passkeyCount(user)) return lastWayIn();
    const proof = await this.auth.proveOwner(req, res, user, body, 'password-remove');
    if (!proof) return;
    // Everything above awaited: the session may have ended, and the profile's
    // last passkey may have been removed by a request that ran alongside this one.
    if (this.sessions.readSession(req) !== user) return notSignedIn(res);
    if (proof === 'passkey') this.accounts.save(); // the confirming passkey's counter and last use
    if (!hasPassword(user)) {
      json(res, 200, { ok: true });
      return;
    }
    if (!this.auth.passkeyCount(user)) return lastWayIn();
    delete (user as { pw?: unknown }).pw;
    this.accounts.save();
    this.audit.audit(req, 'auth.password.remove', { user });
    json(res, 200, { ok: true });
  }

  @SessionRequired()
  @Post('account/email')
  async setAccountEmail(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const session = this.sessions.sessionOf(req);
    if (!session) return notSignedIn(res);
    const { user } = session;
    const body = await readBody(req);
    if (body.email == null || (typeof body.email === 'string' && body.email.trim() === '')) {
      return this.auth.removeEmail(req, res, user, body);
    }
    const email = this.passwords.normalizeEmail(body.email);
    if (!email) {
      json(res, 400, EMAIL_ERRORS.invalid);
      return;
    }
    if (email === (user as { email?: unknown }).email) {
      json(res, 200, { ok: true, email });
      return;
    }
    const acct = 'email|' + acctKey(user);
    const paused = (): boolean =>
      this.passwords.accountPaused(res, acct) || this.passwords.addressPaused(req, res, 'email');
    if (paused()) return;
    const proof = await this.auth.proveOwner(req, res, user, body, 'email');
    if (!proof) return;
    if (this.sessions.sessionOf(req)?.user !== user) return notSignedIn(res);
    if (paused()) return;
    if (this.passwords.emailTaken(email, user.id)) {
      if (proof === 'passkey') this.accounts.save(); // the confirming passkey's counter and last use
      this.passwords.strikeAddress(req, 'email');
      this.passwords.strikeAccount(acct);
      this.audit.audit(req, 'auth.email.fail', { ok: false, user, msg: 'email-taken' });
      json(res, 409, EMAIL_ERRORS.taken);
      return;
    }
    const first = !(user as { email?: unknown }).email;
    user.email = email;
    this.accounts.save();
    this.audit.audit(req, first ? 'auth.email.set' : 'auth.email.change', {
      user,
      msg: proof + ' · ' + this.passwords.maskEmail(email),
    });
    json(res, 200, { ok: true, email });
  }

  @SessionRequired()
  @Delete('account/email')
  async deleteAccountEmail(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    await this.auth.removeEmail(req, res, user, await readBody(req));
  }

  /* An admin hands out a one-time code; issuing it ends the old password and
   * every session of the account at once, and drops its pairing codes, device
   * links and live presence. Passkeys are left alone. */
  @AdminOnly()
  @Post('admin/user/password-reset')
  async adminPasswordReset(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const admin = (req as { user?: DbUser }).user as DbUser;
    const body = await readBody(req);
    const db = this.accounts.db;
    const u = db.users.find(x => x.id === body.id);
    if (!u) {
      json(res, 404, { error: 'no such user' });
      return;
    }
    if (this.accounts.isAdmin(u)) {
      json(res, 400, { error: 'an admin sets their own password in Settings' });
      return;
    }
    if (this.passwords.nameTaken(u.name, u.id)) return nameTakenAnswer(res);
    const code = this.passwords.makeResetCode();
    delete (u as { pw?: unknown }).pw;
    (u as { pwReset?: unknown }).pwReset = {
      h: this.passwords.hashResetCode(code),
      exp: Date.now() + this.passwords.resetTtlMs,
      by: admin.id,
    };
    u.sv = sessionVersion(u) + 1;
    this.auth.clearPairings(u.id);
    dropDeviceLinks(db as any, u.id);
    this.presence.remove(u.id);
    this.accounts.save();
    this.audit.audit(req, 'admin.password.reset', { user: admin, target: u });
    json(res, 200, {
      ok: true,
      name: u.name,
      code,
      expires: (u as { pwReset?: { exp?: number } }).pwReset?.exp,
    });
  }

  @Public()
  @Post('login/password-reset')
  async loginPasswordReset(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    // The name or the e-mail, in the same fields sign-in takes them.
    const k = this.passwords.nameKey(text(body.identifier ?? body.name ?? body.email).slice(0, 300));
    const code = text(body.code).slice(0, 64);
    if (!k || !code) {
      json(res, 400, { error: 'name and code required', code: 'missing' });
      return;
    }
    // Wrong codes count against the address only.
    if (this.passwords.addressPaused(req, res, 'password')) return;
    const db = this.accounts.db;
    const find = (): DbUser | null =>
      db.users.find(
        u =>
          (u as { pwReset?: unknown }).pwReset &&
          (this.passwords.nameKey(u.name) === k || (u as { email?: unknown }).email === k) &&
          this.passwords.resetCodeMatches(code, (u as { pwReset?: unknown }).pwReset),
      ) || null;
    const user = find();
    const invalid = (): void =>
      json(res, 400, { error: 'that reset code is wrong or has expired', code: 'reset-invalid' });
    if (!user) {
      this.passwords.strikeAddress(req, 'password');
      this.audit.audit(req, 'auth.password.reset', { ok: false, msg: 'reset-invalid' });
      return invalid();
    }
    if (user.disabled) {
      this.audit.audit(req, 'auth.password.reset', { ok: false, user, msg: 'account-disabled' });
      disabledAnswer(res);
      return;
    }
    // The code is good and stays good until a password is actually set with it.
    const problem = this.passwords.passwordProblem(body.next, user.name);
    if (problem) return this.passwords.policyError(res, problem);
    if (this.passwords.nameTaken(user.name, user.id)) return nameTakenAnswer(res);
    const h = await this.passwords.hash(body.next);
    // Single use: a second request that raced this one through the hash finds the code gone.
    if (find() !== user) return invalid();
    if (this.passwords.nameTaken(user.name, user.id)) return nameTakenAnswer(res);
    this.auth.setPassword(user, h);
    this.throttle.accountFails.clear(acctKey(user));
    this.accounts.save();
    this.audit.audit(req, 'auth.password.reset', { user });
    json(res, 200, { user: this.accounts.publicUser(user) }, { 'Set-Cookie': this.sessions.sessionCookie(user) });
  }
}

@Controller()
export class AccountPasskeyController {
  constructor(
    private readonly accounts: AccountStore,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly challenges: ChallengeStore,
    private readonly passwords: PasswordService,
    private readonly passkeys: PasskeyService,
    private readonly auth: AuthService,
  ) {}

  private state(user: DbUser): Record<string, unknown> {
    const passkeys = listPasskeys(this.accounts.db as any, user.id) as Array<Record<string, unknown>>;
    const withPassword = this.passwords.passwordWayIn(user);
    return {
      passkeys,
      password: withPassword,
      lastWayIn: passkeys.length + (withPassword ? 1 : 0) <= 1,
    };
  }

  @SessionRequired()
  @Get('account/passkeys')
  list(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    json(res, 200, {
      ...this.state(user),
      ...(this.auth.lastAdminLeaving(user) ? { deleteBlocked: 'last-admin' } : {}),
    });
  }

  @SessionRequired()
  @Post('account/passkeys/options')
  async addOptions(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    if (this.auth.passkeyCount(user) >= MAX_PASSKEYS) {
      json(res, 409, LIMIT);
      return;
    }
    const proof = await this.auth.proveOwner(req, res, user, body, 'passkey-add');
    if (!proof) return;
    // Awaited: a sign-out everywhere, a disable or an admin reset may have ended this session.
    if (this.sessions.readSession(req) !== user) return notSignedIn(res);
    if (proof === 'passkey') this.accounts.save(); // the confirming passkey's counter and last use
    const options = await this.passkeys.moreOptions(user);
    const cid = this.challenges.put({
      challenge: options.challenge,
      uid: user.id,
      kind: 'add-passkey',
      sv: sessionVersion(user),
      proof,
    } as any);
    json(res, 200, { cid, options });
  }

  @SessionRequired()
  @Post('account/passkeys/verify')
  async addVerify(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const c = this.challenges.take(text(body.cid)) as ChallengeExtra | null;
    if (!c || c.kind !== 'add-passkey' || c.uid !== user.id) {
      this.audit.audit(req, 'auth.passkey.fail', { ok: false, user, msg: 'challenge-expired' });
      json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
      return;
    }
    const cred = await this.passkeys.newPasskey(req, res, c, body, 'auth.passkey.fail', user);
    if (!cred) return;
    if (this.sessions.readSession(req) !== user || sessionVersion(user) !== c.sv) return notSignedIn(res);
    const added: any = addPasskeyRecord(this.accounts.db as any, user.id, cred);
    if (added.error) {
      this.audit.audit(req, 'auth.passkey.fail', { ok: false, user, msg: added.code });
      json(res, 409, { error: added.error, code: added.code });
      return;
    }
    this.accounts.save();
    this.audit.audit(req, 'auth.passkey.add', { user, msg: c.proof });
    json(res, 200, { ok: true, ...this.state(user) });
  }

  @SessionRequired()
  @Post('account/passkeys/rename')
  async rename(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    const r: any = renamePasskeyRecord(this.accounts.db as any, user.id, text(body.id), body.name);
    if (r.error) {
      json(res, 404, { error: r.error, code: r.code });
      return;
    }
    this.accounts.save();
    json(res, 200, { ok: true, ...this.state(user) });
  }

  @SessionRequired()
  @Delete('account/passkeys')
  async remove(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    const id = new URL(req.url || '/', 'http://x').searchParams.get('id') || '';
    const body = await readBody(req);
    const refuse = (r: { error: string; code: string }): void =>
      json(res, r.code === 'last-way-in' ? 409 : 404, { error: r.error, code: r.code });
    const refused: any = passkeyRemovalRefused(
      this.accounts.db as any,
      user.id,
      id,
      this.passwords.passwordWayIn(user) ? 1 : 0,
    );
    if (refused) return refuse(refused);
    const proof = await this.auth.proveOwner(req, res, user, body, 'passkey-remove');
    if (!proof) return;
    if (this.sessions.readSession(req) !== user) return notSignedIn(res);
    if (proof === 'passkey') this.accounts.save(); // the confirming passkey's counter and last use
    const r: any = removePasskeyRecord(
      this.accounts.db as any,
      user.id,
      id,
      this.passwords.passwordWayIn(user) ? 1 : 0,
    );
    if (r.error) return refuse(r);
    dropDeviceLinks(this.accounts.db as any, user.id);
    this.accounts.save();
    this.audit.audit(req, 'auth.passkey.remove', { user, msg: r.row.name || undefined });
    json(res, 200, { ok: true, ...this.state(user) });
  }

  @SessionRequired()
  @Post('account/device-link')
  async createLink(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = this.sessions.readSession(req);
    if (!user) return notSignedIn(res);
    const body = await readBody(req);
    if (this.auth.passkeyCount(user) >= MAX_PASSKEYS) {
      json(res, 409, LIMIT);
      return;
    }
    const proof = await this.auth.proveOwner(req, res, user, body, 'device-link');
    if (!proof) return;
    if (this.sessions.readSession(req) !== user) return notSignedIn(res);
    const { code, link } = createDeviceLink(this.accounts.db as any, user.id) as {
      code: string;
      link: { exp: number };
    };
    this.accounts.save();
    this.audit.audit(req, 'auth.link.create', { user, msg: proof });
    json(res, 200, { code, expires: link.exp });
  }
}

@Controller()
export class DeviceLinkController {
  constructor(
    private readonly accounts: AccountStore,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly challenges: ChallengeStore,
    private readonly passwords: PasswordService,
    private readonly passkeys: PasskeyService,
  ) {}

  /* Step one from the other device: the code is the credential. Finding a link
   * does not use it up, so a dismissed passkey prompt can be retried. */
  @Public()
  @Post('device-link/options')
  async options(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (this.passwords.addressPaused(req, res, 'link')) return;
    const link: any = findDeviceLink(this.accounts.db as any, text(body.code));
    if (!link) {
      this.passwords.strikeAddress(req, 'link');
      this.audit.audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
      json(res, 400, LINK_INVALID);
      return;
    }
    const user = this.accounts.findUser(link.userId);
    if (!user || user.disabled) {
      this.audit.audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'user-unavailable' });
      json(res, 400, LINK_INVALID);
      return;
    }
    // A recovery code still works on a profile full of passkeys: the oldest unused
    // one makes room at verify.
    if (link.kind !== 'recovery' && this.authPasskeyCount(user) >= MAX_PASSKEYS) {
      json(res, 409, LIMIT);
      return;
    }
    const options = await this.passkeys.moreOptions(user);
    const cid = this.challenges.put({
      challenge: options.challenge,
      uid: user.id,
      kind: 'device-link',
      lh: link.h,
    } as any);
    json(res, 200, {
      cid,
      options,
      id: user.id,
      name: user.name,
      ...(link.kind === 'recovery' ? { recovery: true } : {}),
    });
  }

  /* Step two: the new passkey is stored, the code is burned, and this device is
   * signed in by the passkey it just made. */
  @Public()
  @Post('device-link/verify')
  async verify(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (this.passwords.addressPaused(req, res, 'link')) return;
    const code = text(body.code);
    const c = this.challenges.take(text(body.cid)) as ChallengeExtra | null;
    const db = this.accounts.db;
    const link: any = findDeviceLink(db as any, code);
    if (!link) {
      this.passwords.strikeAddress(req, 'link');
      this.audit.audit(req, 'auth.link.fail', { ok: false, msg: 'link-invalid' });
      json(res, 400, LINK_INVALID);
      return;
    }
    if (!c || c.kind !== 'device-link' || c.lh !== link.h || c.uid !== link.userId) {
      this.audit.audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'challenge-expired' });
      json(res, 400, { error: 'challenge expired, try again', code: 'challenge-expired' });
      return;
    }
    const owner = this.accounts.findUser(link.userId);
    const cred = await this.passkeys.newPasskey(
      req,
      res,
      c,
      body,
      'auth.link.fail',
      owner || { id: link.userId },
    );
    if (!cred) return;
    // Everything above awaited: the code may have been used, replaced or dropped
    // since, and the profile may be gone or locked.
    const user = this.accounts.findUser(link.userId);
    if (findDeviceLink(db as any, code) !== link || !user || user.disabled) {
      this.audit.audit(req, 'auth.link.fail', { ok: false, uid: link.userId, msg: 'link-invalid' });
      json(res, 400, LINK_INVALID);
      return;
    }
    const recovery = link.kind === 'recovery';
    // Recovery on a full profile: the passkey used longest ago goes, to make room.
    let dropped: Record<string, unknown> | null = null;
    if (recovery && this.authPasskeyCount(user) >= MAX_PASSKEYS) {
      const oldest = (listPasskeys(db as any, user.id) as Array<Record<string, unknown>>)
        .slice()
        .sort((a, b) =>
          String(a.lastUsed || a.created || '').localeCompare(String(b.lastUsed || b.created || '')),
        )[0];
      if (oldest && !(removePasskeyRecord(db as any, user.id, String(oldest.id), 1) as any).error) {
        dropped = oldest;
      }
    }
    const added: any = addPasskeyRecord(db as any, user.id, cred);
    if (added.error) {
      this.audit.audit(req, 'auth.link.fail', { ok: false, user, msg: added.code });
      json(res, 409, { error: added.error, code: added.code });
      return;
    }
    added.row.lastUsed = added.row.created;
    burnDeviceLink(db as any, link);
    this.accounts.save();
    this.audit.audit(req, recovery ? 'auth.recovery.ok' : 'auth.link.ok', {
      user,
      msg:
        [added.row.name, dropped && `replaced ${dropped.name || 'a passkey'}`]
          .filter(Boolean)
          .join(', ') || undefined,
    });
    json(res, 200, { user: this.accounts.publicUser(user) }, { 'Set-Cookie': this.sessions.sessionCookie(user) });
  }

  private authPasskeyCount(user: DbUser): number {
    return this.accounts.db.creds.filter(c => c.userId === user.id).length;
  }
}
