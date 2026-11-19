/* Invite codes: one-shot, revocable, 16 uppercase hex characters.
 *
 * Validation elsewhere is an exact string compare, so codes already in db.json
 * keep working whatever their length; only new codes are generated here.
 */
import { Inject, Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { text } from '../common/http/body-reader.js';
import { HttpError } from '../common/http/http-error.js';
import { AccountStore, type DbInvite, type DbUser } from '../common/persistence/account-store.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class InviteService {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly audit: AuditService,
  ) {}

  list(): { invites: Array<DbInvite & { usedByName: string | null }>; invite_only: boolean } {
    const db = this.accounts.db;
    return {
      invites: db.invites.map(invite => ({
        ...invite,
        usedByName: invite.usedBy
          ? (db.users.find(user => user.id === invite.usedBy) || ({} as DbUser)).name || null
          : null,
      })),
      invite_only: this.config.inviteOnly,
    };
  }

  create(req: IncomingMessage, actor: DbUser, note: unknown): DbInvite {
    const db = this.accounts.db;
    let code: string;
    do {
      code = crypto.randomBytes(8).toString('hex').toUpperCase();
    } while (db.invites.some(invite => invite.code === code));
    const invite: DbInvite = {
      code,
      note: text(note).slice(0, 60),
      createdBy: actor.id,
      created: new Date().toISOString(),
    };
    db.invites.push(invite);
    this.accounts.save();
    this.audit.audit(req, 'admin.invite.create', { user: actor, msg: code });
    return invite;
  }

  revoke(req: IncomingMessage, code: unknown, actor: DbUser): void {
    const db = this.accounts.db;
    const wanted = text(code).toUpperCase();
    const invite = db.invites.find(entry => entry.code === wanted);
    if (!invite) throw new HttpError(404, 'no such code');
    if (invite.usedBy) throw new HttpError(400, 'already used, cannot revoke');
    db.invites = db.invites.filter(entry => entry.code !== invite.code);
    this.accounts.save();
    this.audit.audit(req, 'admin.invite.revoke', { user: actor, msg: invite.code });
  }
}
