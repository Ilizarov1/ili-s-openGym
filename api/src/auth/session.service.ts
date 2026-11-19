/* Signed sessions: cookies and Bearer tokens share one payload and one HMAC.
 * The format `<uid>:<exp>:<version>:<kind>` and the data-volume secret are
 * unchanged, so credentials issued before the migration keep working. */
import { Inject, Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';

export interface SessionInfo {
  user: DbUser;
  exp: number;
  kind: string | null;
  bearer?: boolean;
}

type ReqLike = Pick<IncomingMessage, 'headers'>;

@Injectable()
export class SessionService {
  readonly cookie: string;
  readonly legacyCookie = 'gymsid';
  private readonly secureFlag: string;

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
  ) {
    this.cookie = config.secure ? '__Host-gymsid' : 'gymsid';
    this.secureFlag = config.secure ? ' Secure;' : '';
  }

  private sign(payload: string): string {
    const mac = crypto.createHmac('sha256', this.config.secret).update(payload).digest('base64url');
    return payload + '.' + mac;
  }

  private verifySig(token: string): string | null {
    const i = token.lastIndexOf('.');
    if (i < 0) return null;
    const payload = token.slice(0, i);
    const mac = token.slice(i + 1);
    const expect = crypto.createHmac('sha256', this.config.secret).update(payload).digest('base64url');
    try {
      if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    } catch {
      return null;
    }
    return payload;
  }

  private versionOf(user: DbUser): number {
    return typeof user.sv === 'number' ? user.sv : 0;
  }

  makeSession(user: DbUser, kind: 'b' | 'c' = 'b'): string {
    const exp = Date.now() + this.config.sessionDays * 86400000;
    return this.sign(user.id + ':' + exp + ':' + this.versionOf(user) + ':' + kind);
  }

  cookieValues(req: ReqLike, name: string): string[] {
    const out: string[] = [];
    for (const c of String(req.headers.cookie || '').split(';')) {
      const i = c.indexOf('=');
      if (i < 0) continue;
      if (c.slice(0, i).trim() === name) out.push(c.slice(i + 1).trim());
    }
    return out;
  }

  cookieToken(req: ReqLike): string | null {
    const names = this.cookie === this.legacyCookie ? [this.cookie] : [this.cookie, this.legacyCookie];
    for (const name of names) {
      const vals = this.cookieValues(req, name);
      if (!vals.length) continue;
      if (vals.some(v => v !== vals[0])) return null;
      return vals[0];
    }
    return null;
  }

  sessionOf(req: ReqLike): SessionInfo | null {
    const auth = String(req.headers.authorization || '');
    const cookie = this.cookieToken(req);
    const tok = cookie || (auth.startsWith('Bearer ') ? auth.slice(7).trim() : null);
    const s = this.sessionUser(tok);
    return s && { ...s, bearer: !cookie };
  }

  sessionUser(tok: string | null): SessionInfo | null {
    if (!tok) return null;
    const payload = this.verifySig(tok);
    if (!payload) return null;
    const [uid, exp, ver, kind] = payload.split(':');
    if (!uid || +exp < Date.now()) return null;
    const user = this.accounts.findUser(uid);
    if (!user) return null;
    if (user.disabled) return null;
    const claimed = ver === undefined ? 0 : Number(ver);
    if (!Number.isInteger(claimed) || claimed !== this.versionOf(user)) return null;
    return { user, exp: +exp, kind: kind || null };
  }

  readSession(req: ReqLike): DbUser | null {
    return this.sessionOf(req)?.user || null;
  }

  bearerAuthenticates(req: ReqLike): boolean {
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ') || this.cookieToken(req)) return false;
    return !!this.sessionUser(auth.slice(7).trim());
  }

  sessionCookie(user: DbUser): string[] {
    const fresh = `${this.cookie}=${this.makeSession(user, 'c')}; Path=/; Max-Age=${
      this.config.sessionDays * 86400
    }; HttpOnly;${this.secureFlag} SameSite=Lax`;
    return this.cookie === this.legacyCookie ? [fresh] : [fresh, this.expireCookie(this.legacyCookie)];
  }

  expireCookie(name: string): string {
    return `${name}=; Path=/; Max-Age=0; HttpOnly;${this.secureFlag} SameSite=Lax`;
  }

  clearCookies(): string[] {
    return this.cookie === this.legacyCookie
      ? [this.expireCookie(this.legacyCookie)]
      : [this.expireCookie(this.cookie), this.expireCookie(this.legacyCookie)];
  }
}
