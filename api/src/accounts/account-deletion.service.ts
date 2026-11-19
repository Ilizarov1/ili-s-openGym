/* Removes every trace of a profile. Both the admin delete and the account's
 * own delete end here, in the legacy order. */
import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import * as coachConfig from '../../coach/config.js';
import { dropDeviceLinks } from '../../device-link.js';
import { dropWatchLinks } from '../../watch-relay.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { Paths } from '../common/persistence/paths.js';
import { StateStore } from '../common/persistence/state-store.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { MediaService } from '../media/media.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { WatchCodesStore } from '../watch/watch-codes.store.js';

@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly accounts: AccountStore,
    private readonly paths: Paths,
    private readonly stateStore: StateStore,
    private readonly presence: PresenceService,
    private readonly media: MediaService,
    private readonly integrations: IntegrationsService,
    private readonly watchCodes: WatchCodesStore,
  ) {}

  remove(user: DbUser): void {
    const db = this.accounts.db;
    db.users = db.users.filter(x => x.id !== user.id);
    db.creds = (db.creds || []).filter(c => c.userId !== user.id);
    db.subs = (db.subs || []).filter(x => x.userId !== user.id);
    dropDeviceLinks(db as any, user.id);
    dropWatchLinks(db as any, user.id);
    this.watchCodes.clearUser(user.id);
    this.presence.remove(user.id);
    this.stateStore.invalidate(user.id);

    try {
      fs.unlinkSync(this.paths.stateFile(user.id));
    } catch {
      /* already gone */
    }
    try {
      fs.unlinkSync(this.paths.watchFile(user.id));
    } catch {
      /* never had a watch */
    }
    try {
      coachConfig.clearProfileAuth(user.id);
    } catch {
      /* nothing stored */
    }
    try {
      this.media.store.removeUser(user.id);
    } catch (e) {
      console.error('media: could not remove uploads of', user.id, (e as Error).message);
    }
    try {
      this.integrations.hub.removeUser(user.id);
    } catch (e) {
      console.error('integrations: could not remove', user.id, (e as Error).message);
    }
    this.accounts.save();
  }
}
