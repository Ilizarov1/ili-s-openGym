/* In-memory phone pairing codes: 8 characters, 5 minutes, one live code per profile.
 *
 * This is deliberately not persisted. A process restart drops every code, exactly
 * as the legacy `pairings` Map did; the phone simply asks for a new one.
 */
import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { text } from '../common/http/body-reader.js';

export interface PairingEntry {
  uid: string;
  exp: number;
}

const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const PAIR_CODE_TTL_MS = 5 * 60000;
const SWEEP_MS = 60000;

@Injectable()
export class PairingStore {
  private readonly codes = new Map<string, PairingEntry>();
  private timer?: NodeJS.Timeout;

  /** A new code for `uid`; the profile's previous unused code stops working. */
  create(uid: string): string {
    for (const [code, entry] of this.codes) if (entry.uid === uid) this.codes.delete(code);
    let code: string;
    do {
      code = Array.from(crypto.randomBytes(8))
        .map(byte => PAIR_CODE_ALPHABET[byte % PAIR_CODE_ALPHABET.length])
        .join('');
    } while (this.codes.has(code));
    this.codes.set(code, { uid, exp: Date.now() + PAIR_CODE_TTL_MS });
    return code;
  }

  /** Consumes a code. Wrong, expired and already-used codes all answer null. */
  take(raw: unknown): PairingEntry | null {
    const code = text(raw).trim().toUpperCase();
    const entry = this.codes.get(code);
    if (entry) this.codes.delete(code);
    if (!entry || entry.exp < Date.now()) return null;
    return entry;
  }

  dropUser(uid: string): void {
    for (const [code, entry] of this.codes) if (entry.uid === uid) this.codes.delete(code);
  }

  sweep(now = Date.now()): void {
    for (const [code, entry] of this.codes) if (entry.exp < now) this.codes.delete(code);
  }

  /** Started by the lifecycle coordinator after listen; never at import time. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
