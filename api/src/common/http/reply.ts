/* Response helpers that keep the byte-level contract of the legacy entry. */
import type { ServerResponse } from 'node:http';

export type ExtraHeaders = Record<string, string | string[] | number>;

export function json(res: ServerResponse, code: number, obj: unknown, extraHeaders?: ExtraHeaders): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  } as Record<string, string | number | string[]>);
  res.end(body);
}

/* Appends one Set-Cookie per call without letting a later header overwrite an
 * earlier one (Node replaces an array header only if you assign it again). */
export function addSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader('Set-Cookie');
  if (existing === undefined) res.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, cookie]);
  else res.setHeader('Set-Cookie', [String(existing), cookie]);
}

export function notFound(res: ServerResponse): void {
  json(res, 404, { error: 'not found' });
}
