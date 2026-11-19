/* The four private-media routes, ported from the legacy entry.
 *
 * PUT carries raw bytes: media.js consumes the request stream itself, so this
 * controller never reads a body for an upload and only lifts the body deadline
 * after the session and the hourly budget passed. GET streams the caller's own
 * file only: the directory is the access check, another profile's file is
 * exactly as missing as one that was never uploaded.
 */
import { Controller, Get, Post, Put, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HASH_RE, MediaError } from '../../media.js';
import { AuditService } from '../audit/audit.service.js';
import { SessionRequired } from '../auth/access.decorators.js';
import { readBody } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import type { DbUser } from '../common/persistence/account-store.js';
import { sendMediaFile } from './media-file.js';
import { MediaService } from './media.service.js';
import { MediaThrottle } from './media-throttle.js';

@Controller('media')
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly throttle: MediaThrottle,
    private readonly audit: AuditService,
  ) {}

  /** Which of these the caller's own folder does not have, so a device uploads
   *  only those. */
  @SessionRequired()
  @Post('missing')
  async missing(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    const body = await readBody(req);
    const hashes = body.hashes;
    if (
      !Array.isArray(hashes) ||
      hashes.length > 1000 ||
      !hashes.every(h => typeof h === 'string' && HASH_RE.test(h))
    ) {
      throw new MediaError(400, 'bad-request', {
        error: 'hashes must be a list of at most 1000 lowercase sha256 hex strings',
      });
    }
    json(res, 200, this.media.store.missing(user.id, hashes));
  }

  /** "Reset everything": every file the caller's current state does not
   *  reference goes now, without the grace. A state that cannot be read
   *  removes nothing. */
  @SessionRequired()
  @Post('sweep')
  async sweep(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    await readBody(req);
    this.throttle.sweep(req, user);
    const r = this.media.store.sweep(user.id, { graceMs: 0 });
    this.audit.audit(req, 'media.sweep', {
      user,
      msg: `${r.removed} file(s), ${(r.freedBytes / 1048576).toFixed(1)} MB${
        r.skipped ? ', state unreadable' : ''
      }`,
    });
    json(res, 200, { removed: r.removed, freedBytes: r.freedBytes, usage: this.media.store.usage(user.id) });
  }

  /** The raw bytes of one file, named by the sha256 the client computed.
   *  media.js checks the hash, the magic bytes, the caps, the quota and the
   *  free disk; this route only adds the session and the hourly budget. */
  @SessionRequired()
  @Put(':hash')
  async upload(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    // `missing` and `sweep` pass the request hook so their POST routes work;
    // no other method on those names was a route in the legacy table.
    const hash = (req as any).mediaHash as string | undefined;
    if (!hash) {
      json(res, 404, { error: 'not found' });
      return;
    }
    try {
      this.throttle.upload(req, user);
    } catch (e) {
      // A refusal before receive(): take what is already on the wire so the
      // answer reaches the client, exactly as the legacy route did.
      this.media.store.discard(req);
      throw e;
    }
    (req as any).allowSlowBody?.(); // a signed-in upload within its budget may take the half hour
    const r = await this.media.store.receive(user.id, hash, req);
    json(res, r.status, r.body);
  }

  @SessionRequired()
  @Get(':hash')
  async download(@Req() req: IncomingMessage, @Res() res: ServerResponse): Promise<void> {
    const user = (req as any).user as DbUser;
    const hash = (req as any).mediaHash as string | undefined;
    if (!hash) {
      json(res, 404, { error: 'not found' });
      return;
    }
    // Only ever the caller's own folder.
    const f = this.media.store.file(user.id, hash);
    if (!f) throw new MediaError(404, 'media-missing');
    await sendMediaFile(res, f, hash);
  }
}
