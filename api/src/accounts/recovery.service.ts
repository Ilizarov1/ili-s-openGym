/* Recovery codes (#584): a one-day device link made by an admin (or the local
 * recover.js command) for someone who lost every way in.
 *
 * The legacy order is preserved: bump the session version, drop the profile's
 * pairing codes, device links and live presence, then create the recovery link
 * and save the account store.
 */
import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { createDeviceLink, dropDeviceLinks, RECOVERY_TTL_MS } from '../../device-link.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { PresenceService } from '../presence/presence.service.js';
import { PairingStore } from './pairing.store.js';

export interface RecoveryCode {
  code: string;
  exp: number;
}

const sessionVersion = (user: DbUser): number =>
  typeof (user as any).sv === 'number' ? (user as any).sv : 0;

@Injectable()
export class RecoveryService {
  constructor(
    private readonly accounts: AccountStore,
    private readonly presence: PresenceService,
    private readonly audit: AuditService,
    private readonly pairings: PairingStore,
  ) {}

  /** `by` is the admin that issued it, or null for the server's own command. */
  issue(req: IncomingMessage, target: DbUser, by: DbUser | null): RecoveryCode {
    (target as any).sv = sessionVersion(target) + 1;
    this.pairings.dropUser(target.id);
    dropDeviceLinks(this.accounts.db as any, target.id);
    this.presence.remove(target.id);
    const made = createDeviceLink(this.accounts.db as any, target.id, Date.now(), RECOVERY_TTL_MS, {
      kind: 'recovery',
      by: by ? by.id : 'server',
    }) as { code: string; link: { exp: number } };
    this.accounts.save();
    this.audit.audit(req, by ? 'admin.recovery.create' : 'server.recovery.create', {
      ...(by ? { user: by } : {}),
      target,
      msg: by ? undefined : 'recover.js',
    });
    return { code: made.code, exp: made.link.exp };
  }
}
