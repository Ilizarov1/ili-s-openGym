/* Reads state-<uid>.json with the legacy strictness and cache semantics.
 *
 * GET /api/data and PUT /api/data use readStrict so a corrupt file is a 503,
 * never an empty document a client would adopt. GET /api/data/rev uses the
 * bounded cache. Successful writes must call invalidate(uid).
 */
import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import { Paths } from './paths.js';

export const UNREADABLE = Symbol('unreadable');
export type Unreadable = typeof UNREADABLE;

export interface StateSummary {
  mtimeMs: number;
  size: number;
  rem: { on: boolean; tz?: unknown; time?: unknown; nudge?: boolean };
  consent: boolean;
  settled: string;
  wrapped: unknown;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  hitAt: number;
  S: unknown;
}

const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

export function forClient<T>(S: T): T {
  if (!S || typeof S !== 'object') return S;
  if (!('_unstamped' in (S as object) || '_prior' in (S as object))) return S;
  const { _unstamped, _prior, ...rest } = S as Record<string, unknown>;
  return rest as T;
}

@Injectable()
export class StateStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly summaries = new Map<string, StateSummary>();
  private readonly cacheMax = 64;
  private readonly cacheTtl = Math.max(50, +(process.env.STATE_CACHE_TTL_MS || 600000) || 600000);

  constructor(private readonly paths: Paths) {}

  read(uid: string): any {
    try {
      return JSON.parse(fs.readFileSync(this.paths.stateFile(uid), 'utf8'));
    } catch {
      return null;
    }
  }

  readStrict(uid: string): any | Unreadable | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.paths.stateFile(uid), 'utf8');
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : UNREADABLE;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return UNREADABLE;
    }
  }

  readCached(uid: string): any {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.paths.stateFile(uid));
    } catch {
      this.cache.delete(uid);
      return null;
    }
    const now = Date.now();
    for (const [key, value] of this.cache) if (now - value.hitAt > this.cacheTtl) this.cache.delete(key);
    const hit = this.cache.get(uid);
    this.cache.delete(uid);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      hit.hitAt = now;
      this.cache.set(uid, hit);
      return hit.S;
    }
    const S = this.read(uid);
    this.cache.set(uid, { mtimeMs: st.mtimeMs, size: st.size, hitAt: now, S });
    while (this.cache.size > this.cacheMax) {
      const first = this.cache.keys().next().value;
      if (first === undefined) break;
      this.cache.delete(first);
    }
    return S;
  }

  summary(uid: string): StateSummary | null {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.paths.stateFile(uid));
    } catch {
      this.summaries.delete(uid);
      return null;
    }
    const had = this.summaries.get(uid);
    if (had && had.mtimeMs === st.mtimeMs && had.size === st.size) return had;
    const S = this.readCached(uid);
    const r = S?.reminder;
    const sum: StateSummary = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      rem: r && typeof r === 'object' ? { on: !!r.on, tz: r.tz, time: r.time, nudge: !!r.nudge } : { on: false },
      consent: !!S?.coach?.consent?.agreedAt,
      settled: '',
      wrapped: S?.wrapped ?? null,
    };
    this.summaries.set(uid, sum);
    return sum;
  }

  forgetSummary(uid: string): void {
    this.summaries.delete(uid);
  }

  invalidate(uid: string): void {
    this.cache.delete(uid);
    this.summaries.delete(uid);
  }

  clear(): void {
    this.cache.clear();
    this.summaries.clear();
  }
}

export { record };
