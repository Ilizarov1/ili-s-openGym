/* Immutable snapshot of the environment the API reads at boot.
 *
 * Existing modules under api/ (password.js, media.js, coach/*) read
 * process.env while they are imported. The Nest entry must therefore not
 * rewrite the environment before importing them; this snapshot only mirrors
 * the values for the migrated code.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const flag = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value || '');

export interface RuntimeConfigShape {
  port: number;
  dataDir: string;
  rpId: string;
  rpName: string;
  origin: string;
  secure: boolean;
  sessionDays: number;
  maxBody: number;
  adminUids: string[];
  inviteOnly: boolean;
  firstUserAdmin: boolean;
  allowGuest: boolean;
  passwordLogin: boolean;
  defaultLang: string;
  trustProxy: boolean;
  bodyTimeoutMs: number;
  secret: string;
  secretFile: string;
}

function readDefaultLang(): string {
  const value = String(process.env.DEFAULT_LANG || '').trim();
  if (!value) return '';
  if (/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(value)) return value;
  console.warn(`DEFAULT_LANG "${value.slice(0, 40)}" is not a language tag such as pt-BR or de — ignored`);
  return '';
}

function ensureSecret(dataDir: string): { secret: string; file: string } {
  const file = path.join(dataDir, 'secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return { secret: fs.readFileSync(file, 'utf8').trim(), file };
}

export function loadRuntimeConfig(): RuntimeConfigShape {
  const dataDir = process.env.DATA_DIR || '/data';
  fs.mkdirSync(dataDir, { recursive: true });

  // Best effort, exactly like the legacy entry: a bind mount may refuse chmod.
  for (const name of ['secret', 'db.json', 'coach.json']) {
    try {
      fs.chmodSync(path.join(dataDir, name), 0o600);
    } catch {
      /* not present yet, or the host filesystem says no */
    }
  }

  const { secret, file } = ensureSecret(dataDir);
  const origin = process.env.ORIGIN || 'http://localhost:8080';

  return Object.freeze({
    port: +(process.env.PORT || 3000),
    dataDir,
    rpId: process.env.RP_ID || 'localhost',
    rpName: process.env.RP_NAME || 'openGym',
    origin,
    secure: /^https:/i.test(origin),
    sessionDays: Math.max(1, +(process.env.SESSION_DAYS || 90) || 90),
    maxBody: 5 * 1024 * 1024,
    adminUids: (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean),
    inviteOnly: flag(process.env.INVITE_ONLY),
    firstUserAdmin: flag(process.env.FIRST_USER_ADMIN),
    allowGuest: !/^(0|false|no|off)$/i.test(process.env.ALLOW_GUEST || ''),
    passwordLogin: flag(process.env.PASSWORD_LOGIN),
    defaultLang: readDefaultLang(),
    trustProxy: flag(process.env.TRUST_PROXY),
    bodyTimeoutMs: Math.max(50, +(process.env.BODY_TIMEOUT_MS || 300000) || 300000),
    secret,
    secretFile: file,
  });
}

export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');
