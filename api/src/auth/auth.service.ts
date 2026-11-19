/* Account rules shared by every credential route: who is the owner, what a
 * profile's public shape is, the owner step-up proof, and the side effects a
 * new password has on sessions.
 *
 * `proveOwner` is the legacy helper byte for byte: a passkey assertion made for
 * this request, or the current password while password sign-in is on. A refusal
 * is answered here because the legacy helper answered it itself.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dropDeviceLinks } from '../../device-link.js';
import { AuditService } from '../audit/audit.service.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { json } from '../common/http/reply.js';
import { PairingStore } from '../accounts/pairing.store.js';
import { PasskeyService } from './passkey.service.js';
import {
  acctKey,
  hasPassword,
  passwordRecord,
  PasswordService,
  sessionVersion,
} from './password.service.js';
import { SessionService } from './session.service.js';

export type OwnerProof = 'passkey' | 'password';

@Injectable()
export class AuthService {
  /** Resolved lazily: phone pairing is a separate feature's in-memory map. */
  private pairingStore: PairingStore | null | undefined;

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly passkeys: PasskeyService,
    private readonly moduleRef: ModuleRef,
  ) {}

  publicUser(user: DbUser): Record<string, unknown> {
    return this.accounts.publicUser(user);
  }

  hasPassword(user: DbUser | null | undefined): boolean {
    return hasPassword(user);
  }

  passwordWayIn(user: DbUser | null | undefined): boolean {
    return this.passwords.passwordWayIn(user);
  }

  passkeyCount(user: DbUser): number {
    return this.accounts.db.creds.filter(c => c.userId === user.id).length;
  }

  /** The first profile on an empty instance becomes its owner, decided at push time. */
  claimFirstAdmin(req: IncomingMessage, user: DbUser): void {
    if (!this.config.firstUserAdmin || this.accounts.db.users.length !== 0) return;
    user.admin = true;
    user.owner = true;
    this.audit.audit(req, 'admin.first-user', { user });
  }

  /** The last admin may not leave while anyone else is on the instance. */
  lastAdminLeaving(user: DbUser): boolean {
    const db = this.accounts.db;
    return this.accounts.isAdmin(user) && db.users.length > 1 && db.users.filter(u => this.accounts.isAdmin(u)).length <= 1;
  }

  /* Proof that whoever holds this session is the account's owner right now.
   * Returns the proof used, or null once the refusal has been answered. */
  async proveOwner(
    req: IncomingMessage,
    res: ServerResponse,
    user: DbUser,
    body: Record<string, unknown>,
    act: string,
  ): Promise<OwnerProof | null> {
    if (body.credential) {
      if (await this.passkeys.stepUp(user, body)) return 'passkey';
      this.audit.audit(req, 'auth.proof.fail', { ok: false, user, msg: 'step-up-failed', act });
      json(res, 403, { error: 'the passkey could not be verified', code: 'passkey' });
      return null;
    }
    if (!this.passwords.passwordWayIn(user)) {
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
    const check = this.passwords.attempt(req, res, acctKey(user));
    if (!check) return null;
    const rec = passwordRecord(user);
    if (!rec || !(await check.verify(current, rec.h))) {
      check.failed(user, 'bad-current', undefined, { ev: 'auth.proof.fail', act });
      return wrongCurrent();
    }
    // Changed or removed while it was being checked: it is no longer the current password.
    if ((user as { pw?: unknown }).pw !== rec) {
      check.void();
      return wrongCurrent();
    }
    check.ok();
    return 'password';
  }

  /** Taking the address away: the same proof as setting one, unless there is none. */
  async removeEmail(
    req: IncomingMessage,
    res: ServerResponse,
    user: DbUser,
    body: Record<string, unknown>,
  ): Promise<void> {
    if (!(user as { email?: unknown }).email) {
      json(res, 200, { ok: true, email: null });
      return;
    }
    const proof = await this.proveOwner(req, res, user, body, 'email-remove');
    if (!proof) return;
    if (this.sessions.readSession(req) !== user) {
      json(res, 401, { error: 'not signed in' });
      return;
    }
    delete (user as { email?: unknown }).email;
    this.accounts.save();
    this.audit.audit(req, 'auth.email.remove', { user, msg: proof });
    json(res, 200, { ok: true, email: null });
  }

  /* A new password ends every other session of the account, the way "sign out
   * everywhere" does, pending pairing codes and device links included. The
   * caller's own session is re-issued by the route. Always a new record, never
   * an edit of the old one: a check still running against the old one tells
   * the two apart by that. */
  setPassword(user: DbUser, h: string): void {
    (user as { pw?: unknown }).pw = { h, set: new Date().toISOString() };
    delete (user as { pwReset?: unknown }).pwReset;
    user.sv = sessionVersion(user) + 1;
    this.clearPairings(user.id);
    dropDeviceLinks(this.accounts.db as any, user.id);
  }

  /** "Sign out everywhere" and a new password both take the profile's pairing codes. */
  clearPairings(uid: string): void {
    const store = this.pairings();
    if (store) store.dropUser(uid);
  }

  private pairings(): PairingStore | null {
    if (this.pairingStore !== undefined) return this.pairingStore ?? null;
    try {
      this.pairingStore = this.moduleRef.get(PairingStore, { strict: false });
    } catch {
      // Phone pairing has not been registered in this build; nothing to clear.
      this.pairingStore = null;
    }
    return this.pairingStore ?? null;
  }
}
