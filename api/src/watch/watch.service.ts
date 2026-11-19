/* The Zepp OS watch relay, ported from api/server.js (the helpers around
 * watch-relay.js) and from the nine /api/watch routes.
 *
 * A watch link is its own credential (`ogw_…`): it opens the two mailbox
 * routes and nothing else, is stored only as a hash, and carries the account's
 * session version so "sign out everywhere", a disable or a new password ends
 * it with every session. Pairing codes are hashed, one per profile, ten
 * minutes, and live in the shared WatchCodesStore (account deletion clears
 * them too).
 *
 * The mailbox is `watch-<uid>.json`: snapshot, links and the event queue, all
 * through atomicWrite with 0600. Nothing here applies an event — the page
 * stays the only place that does.
 */
import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import {
  ackEvents,
  boxOf,
  createWatchCode,
  createWatchLink,
  dropWatchLinks,
  findWatchLink,
  listWatchLinks,
  pushEvents,
  putSnapshot,
  queuedEvents,
  takeWatchCode,
  touchWatchLink,
} from '../../watch-relay.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { AtomicWriter } from '../common/persistence/atomic-write.js';
import { Paths } from '../common/persistence/paths.js';
import { LifecycleCoordinator } from '../lifecycle/lifecycle.coordinator.js';
import { WatchCodesStore, type WatchCodeEntry } from './watch-codes.store.js';

interface LegacyCodeEntry {
  userId: string;
  exp: number;
}

/* watch-relay.js was written against a Map of `{ userId, exp }`; the shared
 * WatchCodesStore keys the same hash to `{ uid, exp }` because account
 * deletion reads `uid`. This view bridges the two without a second store. */
class CodeMapView {
  constructor(private readonly map: Map<string, WatchCodeEntry>) {}

  delete(key: string): boolean {
    return this.map.delete(key);
  }

  set(key: string, value: LegacyCodeEntry): this {
    this.map.set(key, { uid: value.userId, exp: value.exp });
    return this;
  }

  *[Symbol.iterator](): IterableIterator<[string, LegacyCodeEntry]> {
    for (const [key, value] of this.map) {
      yield [key, { userId: value.uid, exp: value.exp }];
    }
  }
}

@Injectable()
export class WatchService {
  private readonly codes: CodeMapView;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly accounts: AccountStore,
    private readonly paths: Paths,
    private readonly writer: AtomicWriter,
    private readonly watchCodes: WatchCodesStore,
    private readonly lifecycle: LifecycleCoordinator,
  ) {
    this.codes = new CodeMapView(this.watchCodes.map);
    this.lifecycle.register({
      name: 'watch-codes',
      start: () => this.start(),
      stop: () => this.stop(),
    });
  }

  /* Expired pairing codes go the way the legacy one-minute tick took them.
   * The coordinator calls this after listen; the constructor starts nothing. */
  start(): void {
    this.timer = setInterval(() => this.watchCodes.sweep(), 60000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  pairCode(uid: string): { code: string; exp: number } {
    return createWatchCode(this.codes as any, uid);
  }

  /* The profile a code belongs to; the code is used up even when expired. The
   * caller passes the already-cleaned text. */
  redeemCode(code: string): string | null {
    return takeWatchCode(this.codes as any, code);
  }

  links(uid: string): Array<Record<string, unknown>> {
    return listWatchLinks(this.accounts.db as any, uid);
  }

  /* One link (`id`) or all of the profile's (null). The last unlink takes the
   * mailbox with it: nothing is left to read it. */
  unlink(uid: string, id: string | null): Array<Record<string, unknown>> {
    if (dropWatchLinks(this.accounts.db as any, uid, id as any)) this.accounts.save();
    const links = this.links(uid);
    if (!links.length) {
      try {
        fs.unlinkSync(this.paths.watchFile(uid));
      } catch {
        /* never had a watch */
      }
    }
    return links;
  }

  dropLinks(uid: string): void {
    if (dropWatchLinks(this.accounts.db as any, uid)) this.accounts.save();
  }

  dropCodes(uid: string): void {
    this.watchCodes.clearUser(uid);
  }

  createLink(uid: string, sv: number, name: unknown): { token: string; link: any } {
    const { token, link } = createWatchLink(this.accounts.db as any, uid, sv, name);
    this.accounts.save();
    return { token, link };
  }

  /* The session version a watch link must carry; the same number sessions are
   * signed with, so a link dies with them. */
  sessionVersion(user: DbUser): number {
    return typeof user.sv === 'number' ? user.sv : 0;
  }

  /* `watch-<uid>.json` read back; a missing or corrupt file is an empty box,
   * exactly like the legacy helper, never a 500. */
  readBox(uid: string): any {
    try {
      return boxOf(JSON.parse(fs.readFileSync(this.paths.watchFile(uid), 'utf8')));
    } catch {
      return boxOf(null);
    }
  }

  writeBox(uid: string, box: any): void {
    this.writer.write(this.paths.watchFile(uid), JSON.stringify(box), 0o600);
  }

  putSnapshot(box: any, jsonText: unknown): boolean {
    return putSnapshot(box, jsonText as any);
  }

  queuedEvents(box: any): unknown[] {
    return queuedEvents(box);
  }

  pushEvents(box: any, events: unknown): string[] {
    return pushEvents(box, events as any);
  }

  ackEvents(box: any, ids: unknown): boolean {
    return ackEvents(box, ids as any);
  }

  /* The watch link a request carries (`Authorization: Bearer ogw_…`), or null.
   * Never a session: an account that may not sign in, or whose sessions were
   * all ended since, has no live links either. A link used at most once an
   * hour refreshes its `seen`. */
  watchLinkFor(req: IncomingMessage): any {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return null;
    const link = findWatchLink(this.accounts.db as any, auth.slice(7).trim(), (uid: string) => {
      const user = this.accounts.findUser(uid);
      return user && !user.disabled ? this.sessionVersion(user) : null;
    });
    if (link && touchWatchLink(link)) this.accounts.save();
    return link;
  }
}
