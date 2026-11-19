/* In-memory one-shot WebAuthn challenges: 5-minute TTL, one kind per ceremony.
 * Shared by sign-up, sign-in, adding a passkey and redeeming a device link. */
import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';

export type ChallengeKind = 'register' | 'login' | 'add-passkey' | 'device-link';

export interface Challenge {
  kind: ChallengeKind;
  challenge: string;
  name?: string;
  uid?: string;
  exp: number;
}

const MAX_CHALLENGES = 20000;

@Injectable()
export class ChallengeStore {
  private readonly map = new Map<string, Challenge>();
  private timer?: NodeJS.Timeout;

  start(): void {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [key, value] of this.map) if (value.exp < now) this.map.delete(key);
    }, 60000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  put(data: Omit<Challenge, 'exp'>): string {
    while (this.map.size >= MAX_CHALLENGES) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
    const cid = crypto.randomBytes(16).toString('base64url');
    this.map.set(cid, { ...data, exp: Date.now() + 5 * 60000 });
    return cid;
  }

  take(cid: unknown): Challenge | null {
    if (typeof cid !== 'string') return null;
    const c = this.map.get(cid);
    this.map.delete(cid);
    if (!c || c.exp < Date.now()) return null;
    return c;
  }
}
