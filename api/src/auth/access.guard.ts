/* One guard for the whole API: CSRF, entry throttle, then the route's access
 * level (session / admin / owner), in the legacy order.
 *
 * Guards only refuse; business services still write their own audit rows, so an
 * unauthenticated /api/admin probe is a 401 without an `admin.denied` entry.
 */
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IncomingMessage } from 'node:http';
import { originHint } from '../../verify-error.js';
import { AuditService } from '../audit/audit.service.js';
import { AccountStore } from '../common/persistence/account-store.js';
import { HttpError } from '../common/http/http-error.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { ACCESS_KEY, type AccessLevel } from './access.decorators.js';
import { CsrfService } from './csrf.service.js';
import { SessionService, type SessionInfo } from './session.service.js';
import { ThrottleService } from './throttle.service.js';

export function routeKeyOf(req: IncomingMessage): string {
  const raw = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
  let path = raw.split('?')[0];
  if (/^\/api\/media\/[0-9a-f]{64}$/.test(path)) path = '/api/media/{hash}';
  return `${req.method} ${path}`;
}

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly sessions: SessionService,
    private readonly csrf: CsrfService,
    private readonly throttle: ThrottleService,
    private readonly audit: AuditService,
    private readonly accounts: AccountStore,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<IncomingMessage>();
    const key = routeKeyOf(req);

    if (!this.csrf.ok(req, key)) {
      const refusal = this.csrf.refusal(req);
      if (refusal.status === 403) {
        // Same operator hint as the legacy entry, in the container log only.
        console.warn(
          originHint(key, req.headers.origin, this.config.origin, req.headers['sec-fetch-site']),
        );
      }
      const { error, ...extra } = refusal.body as Record<string, unknown>;
      throw new HttpError(refusal.status, String(error), { extra });
    }

    const wait = this.throttle.admit(req, key);
    if (wait) {
      throw new HttpError(429, 'too many attempts, try again later', {
        headers: { 'Retry-After': String(wait) },
        extra: { code: 'locked', retryAfter: wait },
      });
    }

    const level = this.reflector.getAllAndOverride<AccessLevel>(ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? 'session';

    const session = this.sessions.sessionOf(req);
    (req as any).session = session;
    (req as any).user = session?.user || null;

    if (level === 'public' || level === 'optional') return true;
    if (!session) throw new HttpError(401, 'not signed in');
    if (level === 'admin' || level === 'owner') {
      if (!this.accounts.isAdmin(session.user)) {
        this.audit.audit(req, 'admin.denied', { ok: false, user: session.user });
        throw new HttpError(403, 'forbidden');
      }
      if (level === 'owner' && !this.accounts.isOwner(session.user)) {
        this.audit.audit(req, 'admin.denied', { ok: false, user: session.user });
        throw new HttpError(403, 'only the owner can do this');
      }
    }
    return true;
  }
}

export type AuthedRequest = IncomingMessage & { session?: SessionInfo | null; user?: unknown; mediaHash?: string };
