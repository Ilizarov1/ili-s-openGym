/* Admin dashboard business rules: user list/detail, disable, delete, roles,
 * owner handover and recovery codes. The permission matrix is the legacy one:
 * admins act on plain members, the owner is the only one who may act on an
 * admin, and no admin can be disabled at all.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { dropDeviceLinks, recoveryLinkOf } from '../../device-link.js';
import { AuditService } from '../audit/audit.service.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { StateStore } from '../common/persistence/state-store.js';
import { HttpError } from '../common/http/http-error.js';
import { PresenceService } from '../presence/presence.service.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { PairingStore } from './pairing.store.js';
import { RecoveryService } from './recovery.service.js';

const hasPassword = (user: DbUser): boolean =>
  !!user && !!(user as any).pw && typeof (user as any).pw.h === 'string';

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Legacy `records()`: only dereferenceable objects survive a damaged state file. */
const records = (value: unknown): Array<Record<string, any>> =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** The later of the last push (`_ts`) and the last pull (`lastPull`). */
const lastSyncOf = (user: DbUser, state: any): number | null =>
  Math.max(Number(state?._ts) || 0, Number(user?.lastPull) || 0) || null;

@Injectable()
export class AdminService {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly states: StateStore,
    private readonly presence: PresenceService,
    private readonly audit: AuditService,
    private readonly deletion: AccountDeletionService,
    private readonly recovery: RecoveryService,
    private readonly pairings: PairingStore,
  ) {}

  listUsers(): Record<string, unknown> {
    const db = this.accounts.db;
    const users = db.users.map(user => {
      const state = this.states.read(user.id) || {};
      const workouts = records(state.workouts);
      const last = workouts[workouts.length - 1];
      return {
        id: user.id,
        name: user.name,
        created: user.created || null,
        disabled: !!user.disabled,
        admin: this.accounts.isAdmin(user),
        owner: this.accounts.isOwner(user),
        invitedBy: user.invitedBy || null,
        workouts: workouts.length,
        lastWorkout: last ? last.d : null,
        lastSync: lastSyncOf(user, state),
        hasPush: db.subs.some(sub => sub.userId === user.id),
        live: this.presence.getLive(user.id),
        ...(this.config.passwordLogin ? { password: hasPassword(user), email: user.email || null } : {}),
      };
    });
    return {
      users,
      invite_only: this.config.inviteOnly,
      ...(this.config.passwordLogin ? { password_login: true } : {}),
      now: Date.now(),
    };
  }

  getUser(id: string | null | undefined): Record<string, unknown> {
    const user = this.accounts.findUser(id);
    if (!user) throw new HttpError(404, 'no such user');
    const state = this.states.read(user.id) || {};
    return {
      user: {
        id: user.id,
        name: user.name,
        created: user.created || null,
        disabled: !!user.disabled,
        admin: this.accounts.isAdmin(user),
        owner: this.accounts.isOwner(user),
        invitedBy: user.invitedBy || null,
        ...(this.config.passwordLogin
          ? {
              password: hasPassword(user),
              email: user.email || null,
              resetUntil: (user as any).pwReset?.exp > Date.now() ? (user as any).pwReset.exp : null,
            }
          : {}),
        recoveryUntil: recoveryLinkOf(this.accounts.db as any, user.id)?.exp || null,
      },
      unit: state.unit || 'kg',
      lastSync: lastSyncOf(user, state),
      routines: records(state.routines).map(routine => ({
        id: routine.id,
        name: routine.name,
        emoji: routine.emoji,
        count: records(routine.ex).length,
      })),
      bodyweight: records(state.bodyweight),
      // records() already copied; newest first, and media refs stay the owner's own.
      workouts: records(state.workouts)
        .reverse()
        .map(({ media, ...workout }) => workout),
    };
  }

  issueRecovery(req: IncomingMessage, id: unknown, actor: DbUser): Record<string, unknown> {
    const target = this.accounts.findUser(typeof id === 'string' ? id : null);
    if (!target) throw new HttpError(404, 'no such user');
    if (target.id === actor.id) {
      throw new HttpError(400, 'you are signed in: add a passkey in Settings instead', {
        extra: { code: 'self' },
      });
    }
    if (this.accounts.isOwner(target)) {
      throw new HttpError(403, 'the owner recovers with the server command (recover.js)', {
        extra: { code: 'owner' },
      });
    }
    if (this.accounts.isAdmin(target) && !this.accounts.isOwner(actor)) {
      this.audit.audit(req, 'admin.denied', { ok: false, user: actor, target, msg: 'recovery' });
      throw new HttpError(403, 'only the owner can make a recovery code for an admin');
    }
    if (target.disabled) {
      throw new HttpError(400, 'enable the account first', { extra: { code: 'disabled' } });
    }
    const made = this.recovery.issue(req, target, actor);
    return { ok: true, name: target.name, code: made.code, expires: made.exp };
  }

  setDisabled(req: IncomingMessage, id: unknown, disabled: unknown, actor: DbUser): Record<string, unknown> {
    const user = this.accounts.findUser(typeof id === 'string' ? id : null);
    if (!user) throw new HttpError(404, 'no such user');
    if (this.accounts.isAdmin(user)) throw new HttpError(400, 'cannot disable an admin');
    user.disabled = !!disabled;
    if (user.disabled) {
      this.presence.remove(user.id); // drop them off "training now" at once
      this.pairings.dropUser(user.id);
      dropDeviceLinks(this.accounts.db as any, user.id);
    }
    this.accounts.save();
    this.audit.audit(req, user.disabled ? 'admin.user.disable' : 'admin.user.enable', {
      user: actor,
      target: user,
    });
    return { ok: true, id: user.id, disabled: user.disabled };
  }

  deleteUser(req: IncomingMessage, id: unknown, actor: DbUser): Record<string, unknown> {
    const db = this.accounts.db;
    const user = this.accounts.findUser(typeof id === 'string' ? id : null);
    if (!user) throw new HttpError(404, 'no such user');
    if (user.id === actor.id) throw new HttpError(400, 'you cannot delete your own account');
    if (this.accounts.isAdmin(user) && db.users.filter(u => this.accounts.isAdmin(u)).length <= 1) {
      throw new HttpError(400, 'cannot delete the last admin');
    }
    if (this.accounts.isOwner(user)) {
      throw new HttpError(400, 'the owner cannot be deleted; hand the role to another admin first');
    }
    if (this.accounts.isAdmin(user) && !this.accounts.isOwner(actor)) {
      this.audit.audit(req, 'admin.denied', { ok: false, user: actor, target: user });
      throw new HttpError(403, 'only the owner can delete an admin');
    }
    const name = user.name;
    this.pairings.dropUser(user.id);
    this.deletion.remove(user);
    // Logged with the name, because the id is about to mean nothing to anyone reading this back.
    this.audit.audit(req, 'admin.user.delete', { user: actor, msg: name });
    return { ok: true, id: user.id };
  }

  setRole(req: IncomingMessage, id: unknown, admin: unknown, actor: DbUser): Record<string, unknown> {
    const user = this.accounts.findUser(typeof id === 'string' ? id : null);
    if (!user) throw new HttpError(404, 'no such user');
    if (user.id === actor.id) throw new HttpError(400, 'the owner stays an admin');
    if (typeof admin !== 'boolean') throw new HttpError(400, 'admin must be true or false');
    if (this.config.adminUids.includes(user.id)) {
      throw new HttpError(400, 'this admin is set in ADMIN_UIDS on the server');
    }
    if (admin && user.disabled) throw new HttpError(400, 'enable the account first');
    if (admin) user.admin = true;
    else {
      delete user.admin;
      delete user.owner;
    }
    this.accounts.save();
    this.audit.audit(req, admin ? 'admin.role.grant' : 'admin.role.revoke', {
      user: actor,
      target: user,
    });
    return { ok: true, id: user.id, admin: this.accounts.isAdmin(user) };
  }

  transferOwner(req: IncomingMessage, id: unknown, actor: DbUser): Record<string, unknown> {
    const user = this.accounts.findUser(typeof id === 'string' ? id : null);
    if (!user) throw new HttpError(404, 'no such user');
    if (user.id === actor.id) throw new HttpError(400, 'you already are the owner');
    if (!this.accounts.isAdmin(user) || user.disabled) {
      throw new HttpError(400, 'make them an admin first');
    }
    for (const other of this.accounts.db.users) delete other.owner;
    user.owner = true;
    this.accounts.save();
    this.audit.audit(req, 'admin.owner.transfer', { user: actor, target: user });
    return { ok: true, id: user.id };
  }
}
