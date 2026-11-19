/* JSON body reader with the legacy semantics.
 *
 * Nest's global body parser is disabled in main.ts; controllers call readBody
 * on the routes that take a body. 5 MiB cap, `{}` for an empty body, JSON only,
 * 400 for invalid JSON, 413 for an oversized one.
 */
import type { IncomingMessage } from 'node:http';
import { HttpError } from './http-error.js';

const MAX_BODY = 5 * 1024 * 1024;

export function readBody(req: IncomingMessage & { allowSlowBody?: () => void }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (over) {
        if (size > 2 * MAX_BODY) req.destroy();
        return;
      }
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, 'body too large'));
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (over) return;
      if (!chunks.length) return resolve({});
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) {
        return reject(new HttpError(415, 'content-type must be application/json'));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(new HttpError(400, 'invalid json'));
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return reject(new HttpError(400, 'invalid json'));
      }
      resolve(body as Record<string, unknown>);
    });
    req.on('error', e => reject(Object.assign(e, { clientGone: true })));
  });
}

/* A caller-supplied field meant to be text. String() alone throws on
 * `{"code":{"toString":1}}`. */
export const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

export const b64uToBuf = (s: string): Buffer => Buffer.from(s, 'base64url');
