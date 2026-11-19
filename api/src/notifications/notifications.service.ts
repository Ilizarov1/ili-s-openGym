/* Web Push, subscriptions and the rest-timer alerts, ported from the legacy
 * entry.
 *
 * The VAPID identity is read from DATA_DIR/vapid.json at construction (the
 * legacy module did it at import), so it is generated once, kept at 0600 and
 * reused across restarts. No timer starts here: the LifecycleCoordinator calls
 * start() after app.listen() and stop() while shutting down, which clears the
 * rest timers and the throttle sweep.
 *
 * A push endpoint is a URL this server connects out to, chosen by whoever is
 * signed in, so every send goes through guardedLookup (private addresses) and
 * every stored row is bounded in size — the same rules as the legacy sender.
 */
import { Inject, Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import { MAX_PUSH_ENDPOINT, guardedLookup, pushEndpointError } from '../../net-guard.js';
import { restTimerPush, testPush } from '../../push-messages.js';
import { createWindow } from '../../rate-limit.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { HttpError } from '../common/http/http-error.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { AtomicWriter } from '../common/persistence/atomic-write.js';
import { Paths } from '../common/persistence/paths.js';
import { StateStore } from '../common/persistence/state-store.js';
import { LifecycleCoordinator } from '../lifecycle/lifecycle.coordinator.js';
// web-push ships no type declarations; the legacy entry treats it as untyped too.
// @ts-ignore
import webpush from 'web-push';

const PUSH_TIMEOUT_MS = 10000;
const PUSH_CONCURRENCY = 6;
const MAX_SUBS_PER_USER = 20;
const MAX_REST_TIMERS_PER_USER = 5;
const MAX_PUSH_KEY = 256;
const PUSH_KEY_RE = /^[A-Za-z0-9_\-+/]+={0,2}$/;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  [key: string]: unknown;
}

function pushKeyError(v: unknown): string | null {
  if (typeof v !== 'string' || !v || v.length > MAX_PUSH_KEY || !PUSH_KEY_RE.test(v)) {
    return 'invalid subscription keys';
  }
  return null;
}

/* A device id is what the browser made up for itself: one short token per
 * browser profile, nothing identifying. Anything else is treated as absent. */
const deviceIdOf = (v: unknown): string | undefined =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : undefined;

@Injectable()
export class NotificationsService {
  private readonly vapid: VapidKeys;
  private readonly agent: https.Agent;
  private readonly restTimers = new Map<string, NodeJS.Timeout>();
  private readonly pushTests = createWindow({ max: 10, windowMs: 600000 });
  private readonly restTimerSets = createWindow({ max: 60, windowMs: 60000 });
  private sweepTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    @Inject(RUNTIME_CONFIG) config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly states: StateStore,
    private readonly paths: Paths,
    private readonly writer: AtomicWriter,
    private readonly lifecycle: LifecycleCoordinator,
  ) {
    this.vapid = this.loadVapid();
    const subject = process.env.VAPID_SUBJECT || (config.secure ? config.origin : 'mailto:admin@localhost');
    (webpush as any).setVapidDetails(subject, this.vapid.publicKey, this.vapid.privateKey);

    this.agent = new https.Agent({ lookup: guardedLookup as any, keepAlive: false });
    this.lifecycle.signal.addEventListener('abort', () => this.agent.destroy(), { once: true });

    this.pruneOversizedSubscriptions();

    // Registered, not started: main.ts starts the coordinator after listen.
    this.lifecycle.register({
      name: 'notifications',
      order: 10,
      start: () => this.start(),
      stop: () => this.stop(),
    });
  }

  private loadVapid(): VapidKeys {
    try {
      return JSON.parse(fs.readFileSync(this.paths.vapidFile, 'utf8')) as VapidKeys;
    } catch {
      const keys = (webpush as any).generateVAPIDKeys() as VapidKeys;
      this.writer.write(this.paths.vapidFile, JSON.stringify(keys), 0o600);
      return keys;
    }
  }

  /* A db.json from before these limits may already carry an oversized row:
   * drop it once at boot, before the next save has to write it again. Only
   * size decides here, exactly as before. */
  private pruneOversizedSubscriptions(): void {
    const before = this.accounts.db.subs;
    if (!Array.isArray(before)) return;
    const n = before.length;
    const tooBig = (v: unknown) => typeof v === 'string' && v.length > MAX_PUSH_KEY;
    this.accounts.db.subs = before.filter(
      s =>
        !(
          String((s as any)?.endpoint ?? '').length > MAX_PUSH_ENDPOINT ||
          tooBig((s as any)?.keys?.p256dh) ||
          tooBig((s as any)?.keys?.auth)
        ),
    );
    if (this.accounts.db.subs.length !== n) {
      console.error(`push: dropped ${n - this.accounts.db.subs.length} oversized subscription(s)`);
      this.accounts.save();
    }
  }

  start(): void {
    if (this.stopped || this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.pushTests.sweep();
      this.restTimerSets.sweep();
    }, 600000);
    this.sweepTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const timer of this.restTimers.values()) clearTimeout(timer);
    this.restTimers.clear();
  }

  publicKey(): string {
    return this.vapid.publicKey;
  }

  /* `deviceId` narrows the send to the subscriptions one browser registered
   * (the rest-timer alert belongs to the device that started the rest); a
   * subscription stored without one (an older client) still gets everything.
   * A device with no subscription of its own gets nothing, as before. */
  sendPush(userId: string, payload: PushPayload, deviceId?: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.lifecycle.track(this.deliver(userId, payload, deviceId));
  }

  private async deliver(userId: string, payload: PushPayload, deviceId?: string): Promise<void> {
    let subs = this.accounts.db.subs.filter(s => s.userId === userId);
    if (deviceId) subs = subs.filter(s => !(s as any).deviceId || (s as any).deviceId === deviceId);
    if (!subs.length) return;
    const body = JSON.stringify(payload);
    let dirty = false;
    let next = 0;

    const worker = async (): Promise<void> => {
      while (!this.stopped && next < subs.length) {
        const sub = subs[next++] as any;
        // Re-judged before every send: the agent never sees a literal address,
        // so an endpoint that is private (however it got into db.json) is
        // dropped here rather than connected to.
        const bad = pushEndpointError(sub.endpoint);
        if (bad) {
          console.error('push endpoint refused', userId, bad);
          this.accounts.db.subs = this.accounts.db.subs.filter(s => (s as any).endpoint !== sub.endpoint);
          dirty = true;
          continue;
        }
        try {
          await (webpush as any).sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            body,
            { urgency: 'high', timeout: PUSH_TIMEOUT_MS, agent: this.agent },
          );
        } catch (e) {
          const err = e as any;
          console.error('push send failed', userId, err.statusCode, err.body || err.message);
          // 404/410: the push service says the subscription is gone. 403: it
          // refuses our VAPID signature — a subscription made against a key
          // this instance no longer has. Neither will ever deliver again.
          if (err.statusCode === 404 || err.statusCode === 410 || err.statusCode === 403) {
            this.accounts.db.subs = this.accounts.db.subs.filter(s => (s as any).endpoint !== sub.endpoint);
            dirty = true;
          }
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, subs.length) }, worker));
    // Pruning dead subscriptions is bookkeeping, not the send. Most callers do
    // not await this function (the rest-timer timeout, the Coach hook), so a
    // ./data that cannot be written right now must not become an unhandled
    // rejection and take the process down. The row is already gone in memory;
    // the next save writes it out.
    if (dirty) {
      try {
        this.accounts.save();
      } catch (e) {
        console.error('push: could not save db.json', (e as Error).message);
      }
    }
  }

  subscribe(user: DbUser, body: Record<string, unknown>): void {
    const sub = body.subscription as any;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      throw new HttpError(400, 'invalid subscription');
    }
    const bad = pushEndpointError(sub.endpoint) || pushKeyError(sub.keys.p256dh) || pushKeyError(sub.keys.auth);
    if (bad) throw new HttpError(400, bad);

    // Only the two keys the push protocol needs are kept: `sub` is caller-
    // supplied and would otherwise put arbitrary fields into db.json.
    const keys = { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) };
    const deviceId = deviceIdOf(body.deviceId);

    // A row filed under another account moves only for a caller that sends its
    // keys: the endpoint alone is a URL anyone could learn, the keys are what
    // the browser holds. The legitimate move (a shared browser signing into a
    // second account) carries them.
    const keyDigest = (k: any) => crypto.createHash('sha256').update(`${k?.p256dh}\n${k?.auth}`).digest();
    const sameKeys = (k: any) => crypto.timingSafeEqual(keyDigest(k), keyDigest(keys));
    if (
      this.accounts.db.subs.some(
        s => (s as any).endpoint === sub.endpoint && s.userId !== user.id && !sameKeys((s as any).keys),
      )
    ) {
      throw new HttpError(409, 'this subscription belongs to another account');
    }

    // An upsert: the client re-sends its subscription on every boot, so a row
    // this instance lost comes back without anyone touching Settings. The same
    // endpoint sent again keeps its original `created`. No usable id in the
    // request leaves the id the row already has.
    const prev = this.accounts.db.subs.find(s => (s as any).endpoint === sub.endpoint) as any;
    const storedDevice = deviceId || prev?.deviceId;
    this.accounts.db.subs = this.accounts.db.subs.filter(s => (s as any).endpoint !== sub.endpoint);

    // A browser holds one subscription per device; the cap is far above real
    // use and only stops one account piling up endpoints without limit.
    const mine = this.accounts.db.subs.filter(s => s.userId === user.id);
    if (mine.length >= MAX_SUBS_PER_USER) {
      const drop = new Set(mine.slice(0, mine.length - MAX_SUBS_PER_USER + 1).map(s => (s as any).endpoint));
      this.accounts.db.subs = this.accounts.db.subs.filter(s => !drop.has((s as any).endpoint));
    }

    this.accounts.db.subs.push({
      userId: user.id,
      endpoint: sub.endpoint,
      keys,
      ...(storedDevice ? { deviceId: storedDevice } : {}),
      created: prev?.created || new Date().toISOString(),
    });
    this.accounts.save();
  }

  /** Whether this instance still holds the caller's subscription for `endpoint`. */
  status(user: DbUser, endpoint: string): { subscribed: boolean; deviceId?: string | null } {
    const row = this.accounts.db.subs.find(s => s.userId === user.id && (s as any).endpoint === endpoint) as any;
    return row ? { subscribed: true, deviceId: row.deviceId || null } : { subscribed: false };
  }

  unsubscribe(user: DbUser, body: Record<string, unknown>): void {
    const endpoint = body.endpoint;
    this.accounts.db.subs = this.accounts.db.subs.filter(
      s => !(s.userId === user.id && (s as any).endpoint === endpoint),
    );
    this.accounts.save();
  }

  async test(user: DbUser): Promise<void> {
    this.throttle(this.pushTests, user);
    await this.sendPush(user.id, testPush(this.states.readCached(user.id)?.lang));
  }

  /* Rest-timer alerts: the client schedules on start/extend, cancels on skip or
   * on-screen completion; this only fires when the tab was backgrounded or
   * suspended and never got to cancel it. One timer per device, not per
   * account. In memory only — an API restart drops whatever is pending. */
  restTimer(user: DbUser, body: Record<string, unknown>): void {
    this.throttle(this.restTimerSets, user);
    // Validated before it is clamped: a missing or unusable value is a 400,
    // not a 1-second push. `Number()` only on a number or a string.
    const raw = body.seconds;
    const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (!(n >= 1)) throw new HttpError(400, 'seconds required');
    const sec = Math.min(3600, Math.round(n));
    this.scheduleRestTimer(user.id, deviceIdOf(body.deviceId), sec, this.states.readCached(user.id)?.lang);
  }

  cancelRestTimer(user: DbUser, body: Record<string, unknown>): void {
    this.cancelTimer(user.id, deviceIdOf(body.deviceId));
  }

  private throttle(win: ReturnType<typeof createWindow>, user: DbUser): void {
    const wait = win.take(user.id);
    if (!wait) return;
    throw new HttpError(429, 'too many requests, try again later', {
      extra: { code: 'locked', retryAfter: wait },
      headers: { 'Retry-After': String(wait) },
    });
  }

  private restKey(userId: string, deviceId?: string): string {
    return `${userId}:${deviceId || ''}`;
  }

  private scheduleRestTimer(userId: string, deviceId: string | undefined, sec: number, lang: unknown): void {
    const key = this.restKey(userId, deviceId);
    const previous = this.restTimers.get(key);
    if (previous) clearTimeout(previous);
    this.restTimers.delete(key); // re-inserted below, so the map stays oldest first

    // A person has a timer or two pending, never more than the devices they
    // train with. Each request with a new id used to leave another hour-long
    // timer (and its push to every id-less subscription) behind, without
    // limit; past this many, the oldest goes.
    const mine = [...this.restTimers.keys()].filter(k => k.startsWith(userId + ':'));
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_REST_TIMERS_PER_USER + 1))) {
      clearTimeout(this.restTimers.get(old));
      this.restTimers.delete(old);
    }

    this.restTimers.set(
      key,
      setTimeout(() => {
        this.restTimers.delete(key);
        void this.sendPush(userId, restTimerPush(lang), deviceId);
      }, sec * 1000),
    );
  }

  private cancelTimer(userId: string, deviceId?: string): void {
    // No device id: an older client — clear everything the account has
    // pending, as it always did.
    for (const [key, timer] of this.restTimers) {
      if (deviceId ? key === this.restKey(userId, deviceId) : key.startsWith(userId + ':')) {
        clearTimeout(timer);
        this.restTimers.delete(key);
      }
    }
  }
}
