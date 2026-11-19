/* The single media store: uploads/, quotas, reference marks and the cleanup
 * sweep. Media controllers, the sync commit and account deletion share it. */
import { Inject, Injectable } from '@nestjs/common';
import path from 'node:path';
import { createMediaStore, mediaConfig, mediaLimits } from '../../media.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountStore } from '../common/persistence/account-store.js';
import { StateStore } from '../common/persistence/state-store.js';

@Injectable()
export class MediaService {
  readonly limits = mediaLimits(process.env);
  readonly enabled = this.limits.enabled;
  readonly store: any;
  private timer?: NodeJS.Timeout;
  private firstTimer?: NodeJS.Timeout;

  constructor(
    @Inject(RUNTIME_CONFIG) config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    stateStore: StateStore,
  ) {
    this.store = (createMediaStore as any)({
      dir: path.join(config.dataDir, 'uploads'),
      limits: this.limits,
      readState: (uid: string) => stateStore.read(uid),
    });
  }

  start(): void {
    try {
      this.store.cleanTmp();
    } catch (e) {
      console.error('media: boot cleanup failed', (e as Error).message);
    }
    if (!this.enabled) return;
    this.timer = setInterval(() => this.sweepAll(), 3600000);
    this.timer.unref();
    // A first pass a few minutes after boot, so an instance redeployed more
    // often than hourly still gets one, exactly like the legacy entry.
    this.firstTimer = setTimeout(() => this.sweepAll(), 5 * 60000);
    this.firstTimer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = undefined;
    this.firstTimer = undefined;
  }

  config(): Record<string, unknown> {
    return mediaConfig(this.limits);
  }

  sweepAll(): void {
    try {
      const result = this.store.sweepAll({ uids: this.accounts.db.users.map(u => u.id) });
      if (result.removed || result.tmp) {
        console.log(
          `media: swept ${result.removed} unreferenced file(s), ${(result.freedBytes / 1048576).toFixed(1)} MB, ${result.tmp} stale upload(s)`,
        );
      }
    } catch (e) {
      console.error('media: sweep failed', e);
    }
  }
}
