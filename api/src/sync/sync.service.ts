/* Training-state sync, ported from the legacy GET/PUT /api/data routes.
 *
 * PUT is the sensitive one: the request body is read first, then one
 * synchronous function does readStrict -> version check -> stampPut -> atomic
 * write with nothing awaited in between, so two writes to the same profile in
 * this process cannot interleave. The version cache is invalidated only after
 * the file is committed; media reference marks and integration events run
 * afterwards and may fail without turning the committed write into an error.
 */
import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { stampPut } from '../../sync-stamps.js';
import type { DbUser } from '../common/persistence/account-store.js';
import { AccountStore } from '../common/persistence/account-store.js';
import { AtomicWriter } from '../common/persistence/atomic-write.js';
import { Paths } from '../common/persistence/paths.js';
import { StateStore, UNREADABLE, forClient } from '../common/persistence/state-store.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { MediaService } from '../media/media.service.js';

/* How many earlier write ids a document keeps (`_wids`, legacy server.js). */
const WID_KEEP = 50;

const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);
const records = (v: unknown): unknown[] => (Array.isArray(v) ? v.filter(record) : []);

export type ReqWithUser = IncomingMessage & { user?: DbUser | null };

export interface JsonReply {
  status: number;
  body: Record<string, unknown>;
}

interface CommitOk {
  ok: true;
  cur: any;
  curRev: number;
  next: any;
}

interface CommitRefused {
  ok: false;
  status: number;
  body: Record<string, unknown>;
}

type CommitResult = CommitOk | CommitRefused;

@Injectable()
export class SyncService {
  constructor(
    private readonly accounts: AccountStore,
    private readonly states: StateStore,
    private readonly paths: Paths,
    private readonly writer: AtomicWriter,
    private readonly media: MediaService,
    private readonly integrations: IntegrationsService,
  ) {}

  /* GET /api/data: the whole document for a client, or 503 when the file is
   * there but cannot be read — never an empty document a device would adopt. */
  read(uid: string): JsonReply {
    const state = this.states.readStrict(uid);
    if (state === UNREADABLE) {
      console.error('state file unreadable for', uid);
      return { status: 503, body: { error: 'state unreadable' } };
    }
    const user = this.accounts.findUser(uid);
    if (user) this.accounts.notePull(user);
    return { status: 200, body: { state: forClient(state), rev: state?._rev || 0 } };
  }

  /* GET /api/data/rev: the cached revision probe. `wid` only when the stored
   * document has one; a missing file reads as revision 0. */
  readRev(uid: string): { rev: unknown; wid?: unknown } {
    const doc = this.states.readCached(uid);
    return { rev: doc?._rev || 0, ...(doc?._wid ? { wid: doc._wid } : {}) };
  }

  /* PUT /api/data. The caller has already read the JSON body; everything from
   * validation to the atomic write is synchronous. */
  write(uid: string, body: Record<string, unknown>): JsonReply {
    const state = body.state as any;
    if (!state || typeof state !== 'object') return { status: 400, body: { error: 'state required' } };
    // `{}` or `{"_rev":5}` would empty the document while keeping the counter;
    // `_rev` and `_ts` are bookkeeping, not profile fields.
    if (!Array.isArray(state) && !Object.keys(state).some(k => k !== '_rev' && k !== '_ts')) {
      return { status: 400, body: { error: 'state required' } };
    }
    // The server walks these lists (reminder tick, admin, Coach), so a truthy
    // non-array is refused; absent or null is fine, arrays are not documents.
    const list = (v: unknown) => v == null || Array.isArray(v);
    if (Array.isArray(state) || !list(state.workouts) || !list(state.routines)) {
      return { status: 400, body: { error: 'invalid state' } };
    }
    // Entries that are not objects carry nothing to show and would make the
    // server's own readers throw; drop them instead of stranding the client.
    for (const k of ['workouts', 'routines']) {
      if (Array.isArray(state[k])) state[k] = records(state[k]);
    }

    const commit = this.commit(uid, body, state);
    if (!commit.ok) return { status: commit.status, body: commit.body };

    // The file is committed. These are bookkeeping only: a failure here is
    // logged, never returned as a failed write.
    if (this.media.enabled) {
      try {
        this.media.store.noteState(uid, commit.next);
      } catch (e) {
        console.error('media noteState', e);
      }
    }
    try {
      this.integrations.hub.onStateWrite(uid, commit.cur, commit.next);
    } catch (e) {
      console.error('integrations onStateWrite', e);
    }

    // The receipt names the revision the client sent for; when stampPut fixed
    // the document the file holds one revision more, so the client's next
    // probe sees it moved and reads the stored copy back.
    return {
      status: 200,
      body: { ok: true, ts: commit.next._ts || null, rev: commit.curRev + 1, wid: commit.next._wid },
    };
  }

  /* The compare-and-write section. No `await`, no async fs, no network call:
   * read, compare, merge and atomic write happen in one event-loop turn. */
  private commit(uid: string, body: Record<string, unknown>, state: any): CommitResult {
    const cur = this.states.readStrict(uid);
    if (cur === UNREADABLE) {
      console.error('state file unreadable for', uid);
      return { ok: false, status: 503, body: { error: 'state unreadable' } };
    }
    const curRev = cur?._rev || 0;
    const baseRev = body.baseRev;
    const baseWid = body.baseWid;
    // A client that last read an older document would silently drop the write
    // in between. `baseWid` catches the same revision naming another document
    // (a restored backup, a lost write). The current public state travels back.
    if (
      (baseRev != null && baseRev !== curRev) ||
      (baseRev != null && typeof baseWid === 'string' && cur?._wid && baseWid !== cur._wid)
    ) {
      return {
        ok: false,
        status: 409,
        body: { error: 'conflict', rev: curRev, state: forClient(cur) },
      };
    }
    delete state.active; // in-progress workouts stay device-local
    // "Reset everything" only moves forward: a write without the stamp, or with
    // an older one (an older client, a restored backup), keeps the stored one.
    const storedReset = Number(cur?.resetAt) || 0;
    if (storedReset > (Number(state.resetAt) || 0)) {
      state.resetAt = cur.resetAt;
      if (cur.resetIds && typeof cur.resetIds === 'object') state.resetIds = cur.resetIds;
      else delete state.resetIds;
    }
    // Removal records, edit stamps, unknown-field recovery, Coach/challenge
    // merges and the writer's own `_unstamped`/`_prior` notes all live here.
    const report: { changed?: boolean } = {};
    try {
      stampPut(cur, state, {
        overRead: baseRev != null && baseRev === curRev,
        stamped: body.stamped === true,
        report,
      } as any);
    } catch (e) {
      if (e instanceof RangeError) return { ok: false, status: 400, body: { error: 'invalid state' } };
      throw e;
    }
    state._rev = curRev + 1; // server-owned; whatever the client sent is ignored
    if (report.changed) state._rev = curRev + 2;
    state._wids = [...(Array.isArray(cur?._wids) ? cur._wids : []), ...(cur?._wid ? [cur._wid] : [])]
      .filter((x: unknown) => typeof x === 'string')
      .slice(-WID_KEEP);
    state._wid = crypto.randomBytes(8).toString('hex');
    let text: string;
    try {
      text = JSON.stringify(state);
    } catch (e) {
      if (e instanceof RangeError) return { ok: false, status: 400, body: { error: 'invalid state' } };
      throw e;
    }
    this.writer.write(this.paths.stateFile(uid), text);
    // The stat cache cannot see a same-size write inside one mtime tick; this
    // is the only state writer, so evicting here makes /api/data/rev correct.
    this.states.invalidate(uid);
    return { ok: true, cur, curRev, next: state };
  }
}
