/* In-memory training presence, shared by /api/activity, the admin list and
 * the nudge check. Never persisted; one instance per process. */
import { Injectable } from '@nestjs/common';

export interface PresenceRow {
  name?: string;
  exIdx?: number;
  exTotal?: number;
  setsDone?: number;
  setsTotal?: number;
  startedAt?: number;
  updatedAt: number;
  hiddenAt?: number;
}

export const PRESENCE_TTL = 70000;
export const PRESENCE_HIDDEN_GRACE = 45000;

@Injectable()
export class PresenceService {
  private readonly presence = new Map<string, PresenceRow>();
  private timer?: NodeJS.Timeout;

  start(): void {
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const [uid, row] of this.presence) if (!this.listed(row, now)) this.presence.delete(uid);
    }, 30000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private listed(p: PresenceRow, now: number): boolean {
    return now - p.updatedAt < PRESENCE_TTL && (p.hiddenAt === undefined || now - p.hiddenAt < PRESENCE_HIDDEN_GRACE);
  }

  getLive(uid: string): Omit<PresenceRow, 'hiddenAt'> | null {
    const p = this.presence.get(uid);
    if (!p) return null;
    if (!this.listed(p, Date.now())) {
      this.presence.delete(uid);
      return null;
    }
    const { hiddenAt: _away, ...live } = p;
    return live;
  }

  /** Records a heartbeat. `hidden` marks the first hide; the next one clears it. */
  heartbeat(uid: string, row: Omit<PresenceRow, 'updatedAt' | 'hiddenAt'>): void {
    const prior = this.presence.get(uid);
    const next: PresenceRow = { ...row, updatedAt: Date.now() };
    if (row.name === undefined && prior?.name !== undefined) next.name = prior.name;
    this.presence.set(uid, next);
  }

  setHidden(uid: string, hidden: boolean): void {
    const prior = this.presence.get(uid);
    if (!prior) return;
    if (hidden) {
      if (prior.hiddenAt === undefined) prior.hiddenAt = Date.now();
    } else {
      delete prior.hiddenAt;
    }
  }

  remove(uid: string): void {
    this.presence.delete(uid);
  }

  entries(): Array<[string, Omit<PresenceRow, 'hiddenAt'>]> {
    const now = Date.now();
    const out: Array<[string, Omit<PresenceRow, 'hiddenAt'>]> = [];
    for (const [uid, row] of this.presence) {
      if (!this.listed(row, now)) {
        this.presence.delete(uid);
        continue;
      }
      const { hiddenAt: _away, ...live } = row;
      out.push([uid, live]);
    }
    return out;
  }
}
