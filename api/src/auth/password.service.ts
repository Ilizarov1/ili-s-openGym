/* Password sign-in rules shared by the sign-in, Settings and admin-reset routes.
 *
 * The hashing, policy and reset-code primitives stay in api/password.js. This
 * service only ports the account-level rules the legacy entry kept beside the
 * routes: who holds a name, who holds an e-mail, and the two backoff counters a
 * password check spends before scrypt runs.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  hashPassword as hashPw,
  hashResetCode as hashResetCodeOf,
  makeResetCode as makeResetCodeOf,
  needsRehash as needsRehashOf,
  normalizeEmail as normalizeEmailOf,
  maskEmail as maskEmailOf,
  nameKey as nameKeyOf,
  passwordLength,
  passwordProblem,
  resetCodeMatches as resetCodeMatchesOf,
  verifyPassword,
  MIN_LENGTH,
  MAX_LENGTH,
  RESET_TTL_MS,
} from '../../password.js';
import { AuditService } from '../audit/audit.service.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { json } from '../common/http/reply.js';
import { text } from '../common/http/body-reader.js';
import { ThrottleService } from './throttle.service.js';

/** The fields the routes need from a stored password record. */
export interface PasswordRecord {
  h: string;
  set?: string;
}

export interface PasswordAttempt {
  verify(pw: unknown, stored: unknown): Promise<boolean>;
  failed(
    user: DbUser | null | undefined,
    msg: string,
    unknown?: string,
    opts?: { ev?: string; act?: string },
  ): void;
  ok(): void;
  void(): void;
}

export interface LoginTarget {
  k: string;
  user: DbUser | null;
  resolve: () => DbUser | null;
  email: boolean;
  key: string;
}

export const POLICY_ERRORS: Record<string, string> = {
  'too-short': `the password needs at least ${MIN_LENGTH} characters`,
  'too-long': `the password can have at most ${MAX_LENGTH} characters`,
  'too-common': 'this password is too easy to guess',
};

export const EMAIL_ERRORS = {
  invalid: { error: 'that is not an e-mail address', code: 'email-invalid' },
  taken: { error: 'another profile already uses this e-mail address', code: 'email-taken' },
};

export const WRONG = { error: 'wrong name or password', code: 'bad-credentials' };

/** A password that counts for anything: one the instance still signs people in with. */
export const hasPassword = (user: DbUser | null | undefined): boolean => {
  const pw = user && (user as { pw?: unknown }).pw;
  return !!(pw && typeof (pw as { h?: unknown }).h === 'string');
};

export const passwordRecord = (user: DbUser | null | undefined): PasswordRecord | null => {
  const pw = user && (user as { pw?: unknown }).pw;
  return pw && typeof (pw as { h?: unknown }).h === 'string' ? (pw as PasswordRecord) : null;
};

export const sessionVersion = (user: DbUser): number =>
  typeof user.sv === 'number' ? user.sv : 0;

export const acctKey = (user: DbUser): string => 'acct:' + user.id;

/** A profile's name or e-mail is held while a password or an unused reset code says so. */
const holdsName = (user: DbUser): boolean => {
  if (hasPassword(user)) return true;
  const exp = (user as { pwReset?: { exp?: unknown } }).pwReset?.exp;
  return typeof exp === 'number' && exp > Date.now();
};

@Injectable()
export class PasswordService {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly throttle: ThrottleService,
    private readonly audit: AuditService,
  ) {}

  passwordWayIn(user: DbUser | null | undefined): boolean {
    return this.config.passwordLogin && hasPassword(user);
  }

  nameKey(name: unknown): string {
    return nameKeyOf(name);
  }

  text(value: unknown): string {
    return text(value);
  }

  hash(password: unknown): Promise<string> {
    return hashPw(password) as Promise<string>;
  }

  needsRehash(stored: unknown): boolean {
    return !!needsRehashOf(stored);
  }

  normalizeEmail(raw: unknown): string | null {
    return normalizeEmailOf(raw) as string | null;
  }

  maskEmail(email: unknown): string {
    return maskEmailOf(email) as string;
  }

  resetCodeMatches(code: unknown, stored: unknown): boolean {
    return !!resetCodeMatchesOf(code, stored);
  }

  makeResetCode(): string {
    return makeResetCodeOf() as string;
  }

  hashResetCode(code: unknown): string {
    return hashResetCodeOf(code) as string;
  }

  readonly resetTtlMs = RESET_TTL_MS;

  passwordProblem(password: unknown, name: unknown): string | null {
    return passwordProblem(password, name) as string | null;
  }

  policyError(res: ServerResponse, problem: string | null): void {
    if (!problem) return;
    json(res, 400, { error: POLICY_ERRORS[problem], code: problem });
  }

  tooMany(res: ServerResponse, secs: number): void {
    json(
      res,
      429,
      { error: 'too many attempts, try again later', code: 'locked', retryAfter: secs },
      { 'Retry-After': String(secs) },
    );
  }

  /** A pause already standing for this address and kind, answered with 429. */
  addressPaused(req: IncomingMessage, res: ServerResponse, kind: string): boolean {
    const wait = this.throttle.pausedFor(req, kind);
    if (wait) this.tooMany(res, wait);
    return wait > 0;
  }

  strikeAddress(req: IncomingMessage, kind: string): void {
    this.throttle.strikeAddress(req, kind);
  }

  /** A pause on this account's e-mail attempts, answered with 429. */
  accountPaused(res: ServerResponse, key: string): boolean {
    const wait = this.throttle.addrFails.retryAfter(key);
    if (wait) this.tooMany(res, wait);
    return wait > 0;
  }

  strikeAccount(key: string): void {
    this.throttle.addrFails.fail(key);
  }

  /** Everyone with a password and this folded name, or null. */
  passwordHolder(key: string): DbUser | null {
    return this.accounts.db.users.find(u => hasPassword(u) && nameKeyOf(u.name) === key) || null;
  }

  /** Everyone with a password and this folded address, or null. */
  emailHolder(email: string): DbUser | null {
    return this.accounts.db.users.find(u => hasPassword(u) && (u as { email?: unknown }).email === email) || null;
  }

  /** A profile name is taken by another password holder, pending reset or address. */
  nameTaken(name: unknown, exceptId?: string): boolean {
    const key = nameKeyOf(name);
    return this.accounts.db.users.some(
      u =>
        u.id !== exceptId &&
        ((holdsName(u) && nameKeyOf(u.name) === key) || (u as { email?: unknown }).email === key),
    );
  }

  /** An address is taken by another profile's address or by a name that is one. */
  emailTaken(email: string, exceptId?: string): boolean {
    return this.accounts.db.users.some(
      u =>
        u.id !== exceptId &&
        ((u as { email?: unknown }).email === email || (holdsName(u) && nameKeyOf(u.name) === email)),
    );
  }

  /** Who a sign-in body names: `identifier`, the older `name`, or an address-only `email`. */
  loginTarget(body: Record<string, unknown>): LoginTarget | null {
    const onlyEmail = body.identifier === undefined && body.name === undefined;
    const k = nameKeyOf(text(body.identifier ?? body.name ?? body.email).slice(0, 300));
    if (!k) return null;
    const resolve = (): DbUser | null =>
      (k.includes('@') ? this.emailHolder(k) : null) || (onlyEmail ? null : this.passwordHolder(k));
    const user = resolve();
    return {
      k,
      user,
      resolve,
      email: k.includes('@'),
      key: user ? acctKey(user) : 'id:' + k,
    };
  }

  /* One password check, counted against the account and the caller's address the
   * moment it starts (see api/rate-limit.js). Answers 429 itself and returns null
   * when either counter is paused. The caller settles the attempt once: failed()
   * for a wrong password, ok() for a right one, void() when the answer says
   * nothing about the password. */
  attempt(req: IncomingMessage, res: ServerResponse, key: string): PasswordAttempt | null {
    const address = 'password|' + this.throttle.limitAddress(req);
    const wait = this.throttle.accountFails.retryAfter(key) || this.throttle.addrFails.retryAfter(address);
    if (wait) {
      this.tooMany(res, wait);
      return null;
    }
    const byName = this.throttle.accountFails.attempt(key);
    const byAddress = this.throttle.addrFails.attempt(address);
    const settle = (): void => {
      byName.undo();
      byAddress.undo();
    };
    const audit = this.audit;
    const throttle = this.throttle;

    return {
      // Longer than any password that can be set: wrong, without hashing a megabyte to find out.
      async verify(pw: unknown, stored: unknown): Promise<boolean> {
        try {
          return passwordLength(pw) <= MAX_LENGTH && (await verifyPassword(pw, stored));
        } catch (e) {
          settle();
          throw e;
        }
      },
      // The audit line names the account only when there is one — what someone typed into
      // the name field is sometimes their password.
      failed(
        user: DbUser | null | undefined,
        msg: string,
        unknown = 'unknown-name',
        opts: { ev?: string; act?: string } = {},
      ): void {
        const { ev = 'auth.password.fail', act } = opts;
        audit.audit(req, ev, user ? { ok: false, user, msg, act } : { ok: false, msg: unknown, act });
        if (byName.lock) {
          audit.audit(req, 'auth.password.locked', user ? { ok: false, user } : { ok: false, msg: unknown });
        }
        if (byAddress.lock) audit.audit(req, 'auth.throttled', { ok: false, msg: 'password' });
      },
      // A right password starts the name over; the address keeps whatever else it has run up.
      ok(): void {
        throttle.accountFails.clear(key);
        byAddress.undo();
      },
      void: settle,
    };
  }
}
