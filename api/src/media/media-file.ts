/* A stored media file, streamed with the legacy security headers.
 *
 * The bytes were chosen by a person, so the answer must never be something a
 * browser would run: the type comes from the sniffed extension (never text/*
 * or SVG), nosniff stops a browser second-guessing it, the sandbox CSP
 * neuters it even when opened as a page, CORP keeps other sites from embedding
 * it, and no-store keeps a copy out of the HTTP cache. No Range and no ETag:
 * nothing asks for them.
 */
import fs from 'node:fs';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { MediaError } from '../../media.js';

export interface MediaFileInfo {
  path: string;
  ext: string;
  mime: string;
  size: number;
}

export async function sendMediaFile(res: ServerResponse, f: MediaFileInfo, hash: string): Promise<void> {
  let fd: number;
  try {
    fd = fs.openSync(f.path, 'r');
  } catch {
    // Swept between the lookup and here.
    throw new MediaError(404, 'media-missing');
  }
  const size = fs.fstatSync(fd).size;
  res.writeHead(200, {
    'Content-Type': f.mime,
    'Content-Length': String(size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Disposition': `inline; filename="${hash}.${f.ext}"`,
    'X-Robots-Tag': 'noindex',
    // The paired phone reads the length before the body to refuse an
    // oversized answer; it is CORS-safelisted already, this only spells it
    // out for older WebViews.
    'Access-Control-Expose-Headers': 'Content-Length',
  });
  try {
    // The descriptor is already open: the path is ignored by the stream and
    // autoClose closes it when the download ends or the client goes away.
    await pipeline(fs.createReadStream(f.path, { fd }), res);
  } catch {
    res.destroy(); // the client went away mid-download; nothing left to answer
  }
}
