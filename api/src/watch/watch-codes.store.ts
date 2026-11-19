/* One-shot watch pairing codes, hashed at rest in memory, 10 minutes.
 * Shared by the watch routes and account deletion. */
import { Injectable } from '@nestjs/common';

export interface WatchCodeEntry {
  uid: string;
  exp: number;
  [key: string]: unknown;
}

@Injectable()
export class WatchCodesStore {
  readonly map = new Map<string, WatchCodeEntry>();

  clearUser(uid: string): void {
    for (const [key, value] of this.map) if (value.uid === uid) this.map.delete(key);
  }

  sweep(now = Date.now()): void {
    for (const [key, value] of this.map) if (value.exp <= now) this.map.delete(key);
  }
}
