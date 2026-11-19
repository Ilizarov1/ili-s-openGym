/* The per-profile media budgets, ported from the legacy entry.
 *
 * Every upload is signed in and behind a proxy one address can be a whole
 * household, so these count per profile rather than per address. Refusals are
 * MediaError(429, 'locked') with Retry-After, and a client that keeps hammering
 * a closed window writes one `media.throttled` audit row per window, not one
 * per request.
 */
import { Injectable } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { MediaError } from '../../media.js';
import { createWindow } from '../../rate-limit.js';
import { AuditService } from '../audit/audit.service.js';
import type { DbUser } from '../common/persistence/account-store.js';
import { MediaService } from './media.service.js';

const HOUR_MS = 3600000;

type Window = ReturnType<typeof createWindow>;

@Injectable()
export class MediaThrottle {
  private readonly uploads: Window;
  private readonly sweeps: Window;
  /** Uid -> until when its throttle has already been recorded. */
  private readonly noted = new Map<string, number>();

  constructor(media: MediaService, private readonly audit: AuditService) {
    // The hourly budget is generous (a backup import re-uploads everything at
    // once); the two-in-flight cap in media.js keeps one phone from holding
    // many sockets.
    this.uploads = createWindow({ max: media.limits.uploadsPerHour, windowMs: HOUR_MS });
    // Deleting everything unreferenced is what "reset everything" does; ten an
    // hour is plenty.
    this.sweeps = createWindow({ max: 10, windowMs: HOUR_MS });
  }

  upload(req: IncomingMessage, user: DbUser): void {
    this.take(req, user, this.uploads, 'upload');
  }

  sweep(req: IncomingMessage, user: DbUser): void {
    this.take(req, user, this.sweeps, 'sweep');
  }

  private take(req: IncomingMessage, user: DbUser, win: Window, kind: 'upload' | 'sweep'): void {
    const wait = win.take(user.id);
    if (!wait) return;
    if ((this.noted.get(user.id) || 0) < Date.now()) {
      this.noted.set(user.id, Date.now() + wait * 1000);
      this.audit.audit(req, 'media.throttled', { ok: false, user, msg: kind });
    }
    throw new MediaError(429, 'locked', { retryAfter: wait }, { 'Retry-After': String(wait) } as any);
  }
}
