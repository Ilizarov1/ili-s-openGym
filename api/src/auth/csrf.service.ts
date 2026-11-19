/* CSRF check, identical to the legacy csrfOk().
 *
 * Exemptions are keyed by `METHOD /api/path`; the media hash is normalized to
 * `{hash}` by the guard before this runs.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { SessionService } from './session.service.js';

const CSRF_EXEMPT = new Set(['POST /api/pair/redeem', 'POST /api/watch/redeem', 'POST /api/watch/box']);

const PASSKEY_ROUTES = new Set([
  'POST /api/register/options',
  'POST /api/register/verify',
  'POST /api/login/options',
  'POST /api/login/verify',
]);

const SIGN_IN_ROUTES = new Set([
  'POST /api/login/password',
  'POST /api/register/password',
  'POST /api/login/password-reset',
  'POST /api/device-link/options',
  'POST /api/device-link/verify',
]);

const originsMatch = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

@Injectable()
export class CsrfService {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly sessions: SessionService,
  ) {}

  ok(req: IncomingMessage, key: string): boolean {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    if (CSRF_EXEMPT.has(key)) return true;
    if (!PASSKEY_ROUTES.has(key) && !SIGN_IN_ROUTES.has(key) && this.sessions.bearerAuthenticates(req)) return true;
    const site = String(req.headers['sec-fetch-site'] || '');
    if (site) return site === 'same-origin' || site === 'none';
    const origin = String(req.headers.origin || '');
    if (!origin) return true;
    return originsMatch(origin, this.config.origin);
  }

  /** The legacy answer when the check fails. */
  refusal(req: IncomingMessage): { status: number; body: Record<string, unknown> } {
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ') && !this.sessions.cookieToken(req) && !this.sessions.bearerAuthenticates(req)) {
      return { status: 401, body: { error: 'not signed in' } };
    }
    return {
      status: 403,
      body: {
        error: 'cross-origin request refused',
        code: 'origin-mismatch',
        expected: this.config.origin,
      },
    };
  }
}
