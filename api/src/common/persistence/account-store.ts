/* The single in-process account database.
 *
 * Every module reads and writes accounts through this provider; a second copy
 * of db.json in memory would let two code paths overwrite each other. The
 * fallback ladder is the legacy one: a damaged db.json is kept aside and
 * db.json.bak is used; with neither readable the process refuses to start.
 */
import { Inject, Injectable } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../../config/runtime-config.js';
import { AtomicWriter } from './atomic-write.js';
import { Paths } from './paths.js';

export interface DbUser {
  id: string;
  name: string;
  admin?: boolean;
  owner?: boolean;
  disabled?: boolean;
  created?: number;
  lastPull?: number;
  sv?: number;
  [key: string]: unknown;
}

export interface DbCred {
  userId: string;
  credentialId: string;
  [key: string]: unknown;
}

export interface DbSub {
  userId: string;
  [key: string]: unknown;
}

export interface DbInvite {
  code: string;
  [key: string]: unknown;
}

export interface DbDeviceLink {
  [key: string]: unknown;
}

export interface Db {
  users: DbUser[];
  creds: DbCred[];
  subs: DbSub[];
  invites: DbInvite[];
  deviceLinks: DbDeviceLink[];
}

const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

const records = <T>(v: unknown): T[] => (Array.isArray(v) ? (v.filter(record) as T[]) : []);

export function emptyDb(): Db {
  return { users: [], creds: [], subs: [], invites: [], deviceLinks: [] };
}

@Injectable()
export class AccountStore {
  private readonly dbFile: string;
  readonly db: Db;

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly paths: Paths,
    private readonly writer: AtomicWriter,
  ) {
    this.dbFile = this.paths.dbFile;
    this.db = this.load() as Db;
    this.db.users = this.db.users || [];
    this.db.creds = this.db.creds || [];
    this.db.subs = this.db.subs || [];
    this.db.invites = this.db.invites || [];
    this.db.deviceLinks = this.db.deviceLinks || [];
  }

  private load(): Db | Record<string, unknown> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.dbFile, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyDb();
      throw e;
    }
    const parse = (text: string) => {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value as Db;
    };
    try {
      return parse(raw);
    } catch (err) {
      const aside = `${this.dbFile}.unreadable-${Date.now()}`;
      try {
        fs.copyFileSync(this.dbFile, aside as string);
      } catch {
        /* the original stays where it is anyway */
      }
      console.error(`db.json cannot be read (${(err as Error).message}); kept a copy as ${path.basename(aside)}`);
      try {
        const bak = parse(fs.readFileSync(this.dbFile + '.bak', 'utf8'));
        console.error('db.json: using db.json.bak, the copy of the last save');
        return bak;
      } catch {
        console.error('db.json: no readable db.json.bak either. Refusing to start: restore db.json from a backup.');
        process.exit(1);
      }
    }
    throw new Error('unreachable');
  }

  save(): void {
    const text = JSON.stringify(this.db, null, 2);
    this.writer.write(this.dbFile, text, 0o600);
    try {
      this.writer.write(this.dbFile + '.bak', text, 0o600);
    } catch (e) {
      console.error('db.json.bak could not be written', (e as Error).message);
    }
  }

  isAdmin(user: DbUser | null | undefined): boolean {
    return !!user && (user.admin === true || this.config.adminUids.includes(user.id));
  }

  ownerId(): string | null {
    const flagged = this.db.users.find(u => u.owner === true && this.isAdmin(u));
    if (flagged) return flagged.id;
    const fromEnv = this.config.adminUids.find(id => this.db.users.some(u => u.id === id));
    if (fromEnv) return fromEnv;
    return this.db.users.find(u => this.isAdmin(u))?.id || null;
  }

  isOwner(user: DbUser | null | undefined): boolean {
    return !!user && this.isAdmin(user) && user.id === this.ownerId();
  }

  publicUser(user: DbUser): Record<string, unknown> {
    return { id: user.id, name: user.name, admin: this.isAdmin(user), ...(this.isOwner(user) ? { owner: true } : {}) };
  }

  findUser(id: string | null | undefined): DbUser | null {
    if (!id) return null;
    return this.db.users.find(u => u.id === id) || null;
  }

  notePull(user: DbUser, now = Date.now()): void {
    const PULL_NOTE_MS = 10 * 60 * 1000;
    if (user.lastPull && now - user.lastPull < PULL_NOTE_MS) return;
    user.lastPull = now;
    try {
      this.save();
    } catch (e) {
      console.error('db save failed', (e as Error).message);
    }
  }
}
