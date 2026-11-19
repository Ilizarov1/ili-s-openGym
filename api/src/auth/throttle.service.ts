/* Sign-in throttle: the same three counters and the same route table as the
 * legacy entry, reusing api/rate-limit.js. */
import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { createBackoff, createWindow } from '../../rate-limit.js';
import { ipv6Groups } from '../../net-guard.js';
import { AuditService } from '../audit/audit.service.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountStore } from '../common/persistence/account-store.js';
import { Inject } from '@nestjs/common';

const hasPassword = (u: any) => !!(u && u.pw && typeof u.pw.h === 'string');

const THROTTLED: Record<string, string | null> = {
  'POST /api/login/password': 'password',
  'POST /api/login/password-reset': 'password',
  'POST /api/register/password': 'signup',
  'POST /api/account/password': 'password',
  'DELETE /api/account/password': null,
  'POST /api/account/email': 'email',
  'DELETE /api/account/email': null,
  'POST /api/device-link/options': 'link',
  'POST /api/device-link/verify': 'link',
  'POST /api/account/passkeys/options': null,
  'POST /api/account/device-link': null,
  'POST /api/pair/create': null,
  'POST /api/watch/redeem': 'watch',
  'POST /api/watch/pair': null,
  'DELETE /api/account/passkeys': null,
  'POST /api/account/delete': null,
};

@Injectable()
export class ThrottleService {
  readonly authBurst = createWindow({ max: 60, windowMs: 60000 });
  readonly addrFails = createBackoff({ free: 20, baseMs: 30000, maxMs: 15 * 60000, forgetMs: 3600000 });
  readonly accountFails: ReturnType<typeof createBackoff> = createBackoff({
    free: 5,
    baseMs: 60000,
    maxMs: 3600000,
    forgetMs: 24 * 3600000,
    keep: ((key: string) => key.startsWith('acct:') && hasPassword(this.findByKey(key))) as any,
  });
  readonly failAudit = createWindow({ max: 10, windowMs: 60000 });
  readonly failAuditAll = createWindow({ max: 120, windowMs: 60000 });
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly audit: AuditService,
    private readonly accounts: AccountStore,
  ) {}

  private findByKey(key: string): any {
    const id = key.slice(5);
    return this.accounts.findUser(id);
  }

  start(): void {
    this.timer = setInterval(() => {
      this.authBurst.sweep();
      this.addrFails.sweep();
      this.accountFails.sweep();
      this.failAudit.sweep();
      this.failAuditAll.sweep();
    }, 60000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  limitAddress(req: Pick<IncomingMessage, 'headers' | 'socket'>): string {
    const sock = String(req.socket?.remoteAddress || '');
    let raw = sock;
    if (this.config.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
      raw =
        String(req.headers['cf-connecting-ip'] || '').trim() ||
        xff[xff.length - 1] ||
        String(req.headers['x-real-ip'] || '').trim() ||
        sock;
    }
    raw = raw.replace(/^\[|\]$/g, '');
    const groups: number[] | null = ipv6Groups(raw.toLowerCase());
    if (groups) {
      if (groups.slice(0, 5).every(x => x === 0) && groups[5] === 0xffff) {
        return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
      }
      return groups.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
    }
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) ? raw : 'unknown';
  }

  /** Seconds to wait before this request may run (0 = within budget). */
  admit(req: IncomingMessage, key: string): number {
    if (!(key in THROTTLED)) return 0;
    const addr = this.limitAddress(req);
    const kind = THROTTLED[key];
    return this.authBurst.take(addr) || (kind ? this.addrFails.retryAfter(kind + '|' + addr) : 0);
  }

  pausedFor(req: IncomingMessage, kind: string): number {
    return this.addrFails.retryAfter(kind + '|' + this.limitAddress(req));
  }

  strikeAddress(req: IncomingMessage, kind: string): void {
    const lock = this.addrFails.fail(kind + '|' + this.limitAddress(req));
    if (lock) this.audit.audit(req, 'auth.throttled', { ok: false, msg: kind });
  }

  auditFail(req: IncomingMessage, ev: string, fields: Record<string, unknown>): void {
    if (this.failAudit.take(ev + '|' + this.limitAddress(req)) || this.failAuditAll.take(ev)) return;
    this.audit.audit(req, ev, fields);
  }
}

export { THROTTLED };
