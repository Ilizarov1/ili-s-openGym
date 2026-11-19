/* Append-only audit log (audit.log), ported from the legacy entry.
 *
 * Deliberately has no dependency on Auth or Accounts: those modules call
 * audit(), and Accounts hosts the HTTP endpoints that read or clear the log.
 */
import { Inject, Injectable } from '@nestjs/common';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AtomicWriter } from '../common/persistence/atomic-write.js';
import { Paths } from '../common/persistence/paths.js';
import type { DbUser } from '../common/persistence/account-store.js';

export interface AuditFields {
  ok?: boolean;
  user?: DbUser | null;
  uid?: string;
  name?: string;
  target?: DbUser | null;
  msg?: string;
  act?: string;
}

export interface AuditRow {
  id: number;
  ts: number;
  ev: string;
  ok: boolean;
  uid?: string;
  name?: string;
  tgt?: string;
  tname?: string;
  msg?: string;
  act?: string;
  ip?: string;
}

type ReqLike = Partial<Pick<IncomingMessage, 'headers' | 'socket'>> & { headers?: Record<string, unknown> };

@Injectable()
export class AuditService {
  readonly on: boolean;
  readonly max: number;
  readonly days: number;
  readonly ipMode: 'off' | 'net' | 'full';
  private seq = 0;
  private count = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly paths: Paths,
    private readonly writer: AtomicWriter,
  ) {
    this.on = !/^(0|false|no|off)$/i.test(process.env.AUDIT_LOG || '');
    this.max = Math.max(0, +(process.env.AUDIT_MAX || 5000) || 0);
    this.days = Math.max(0, +(process.env.AUDIT_DAYS || 90) || 0);
    const ip = process.env.AUDIT_IP || '';
    this.ipMode = /^full$/i.test(ip) ? 'full' : /^(1|true|yes|on|net)$/i.test(ip) ? 'net' : 'off';
  }

  /** Prunes on boot and seeds the sequence, then runs hourly. */
  start(): void {
    if (!this.on) return;
    this.compact();
    this.timer = setInterval(() => this.compact(), 3600000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  clientIp(req: ReqLike): string | null {
    if (this.ipMode === 'off') return null;
    const headers = (req.headers || {}) as Record<string, string | string[] | undefined>;
    const raw =
      String(headers['cf-connecting-ip'] || '').trim() ||
      String(headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      String(headers['x-real-ip'] || '').trim() ||
      String((req.socket as { remoteAddress?: string } | undefined)?.remoteAddress || '')
        .replace(/^::ffff:/, '')
        .trim();
    const ip = raw.replace(/^\[|\]$/g, '').slice(0, 45);
    if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return null;
    if (this.ipMode === 'full') return ip;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip.replace(/\.\d{1,3}$/, '.0/24');
    const groups = ip.split(':').filter(Boolean).slice(0, 3).join(':');
    return groups ? groups + '::/48' : null;
  }

  rows(): AuditRow[] {
    let text: string;
    try {
      text = fs.readFileSync(this.paths.auditFile, 'utf8');
    } catch {
      return [];
    }
    const rows: AuditRow[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line);
        if (row && row.id && row.ev) rows.push(row);
      } catch {
        /* torn line */
      }
    }
    return rows;
  }

  keep(rows: AuditRow[]): AuditRow[] {
    let out = rows;
    if (this.days) {
      const cut = Date.now() - this.days * 86400000;
      out = out.filter(r => r.ts >= cut);
    }
    if (this.max && out.length > this.max) out = out.slice(out.length - this.max);
    return out;
  }

  compact(): void {
    const rows = this.rows();
    for (const row of rows) if (+row.id > this.seq) this.seq = +row.id;
    const keep = this.keep(rows);
    this.count = keep.length;
    if (keep.length === rows.length) return;
    try {
      this.writer.write(this.paths.auditFile, keep.map(r => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    } catch (e) {
      console.error('audit compact failed', (e as Error).message);
    }
  }

  /** Never throws: a log that cannot be written must not break signing in. */
  audit(req: ReqLike, ev: string, f: AuditFields = {}): void {
    if (!this.on) return;
    const rec: AuditRow = { id: ++this.seq, ts: Date.now(), ev, ok: f.ok !== false };
    if (f.user) {
      rec.uid = f.user.id;
      rec.name = String(f.user.name || '').slice(0, 40);
    } else {
      if (f.uid) rec.uid = f.uid;
      if (f.name) rec.name = String(f.name).slice(0, 40);
    }
    if (f.target) {
      rec.tgt = f.target.id;
      rec.tname = String(f.target.name || '').slice(0, 40);
    }
    if (f.msg) rec.msg = String(f.msg).slice(0, 120);
    if (f.act) rec.act = String(f.act).slice(0, 40);
    const ip = this.clientIp(req);
    if (ip) rec.ip = ip;
    try {
      fs.appendFileSync(this.paths.auditFile, JSON.stringify(rec) + '\n');
    } catch (e) {
      console.error('audit write failed', (e as Error).message);
      return;
    }
    if (this.max && ++this.count > this.max * 1.25) this.compact();
  }

  /** Owner-only clear: the sequence is not reset, so the wipe leaves a gap. */
  clear(req: ReqLike, user: DbUser): void {
    try {
      fs.unlinkSync(this.paths.auditFile);
    } catch {
      /* nothing logged yet */
    }
    this.count = 0;
    this.audit(req, 'admin.audit.clear', { user });
  }
}
