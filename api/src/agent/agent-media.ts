/* Attachments for the server runtime.
 *
 * Only a fixture image and already-registered media in the caller's own media
 * folder are readable. MIME, size and the actual magic bytes are checked; logs
 * carry metadata, never the bytes.
 */
import { Injectable } from '@nestjs/common';
import fs from 'node:fs';
import { AgentError } from '../../agent-runtime/errors.js';
import { HASH_RE, sniffMedia } from '../../media.js';
import { fixtureAllowed } from './agent.flags.js';
import { MediaService } from '../media/media.service.js';

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FIXTURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export interface AgentAttachment {
  id: string;
  kind: 'image';
  mime: string;
  name: string;
  size: number;
  dataUrl: string;
}

@Injectable()
export class AgentMedia {
  constructor(private readonly media: MediaService) {}

  async resolve(uid: string, ids: string[]): Promise<AgentAttachment[]> {
    const out: AgentAttachment[] = [];
    for (const id of ids || []) {
      if (id === 'fixture:image') {
        if (!fixtureAllowed()) {
          throw new AgentError('invalid_request', 'fixture attachments are not available on this instance');
        }
        out.push({
          id,
          kind: 'image',
          mime: 'image/png',
          name: 'fixture.png',
          size: FIXTURE_PNG.length,
          dataUrl: `data:image/png;base64,${FIXTURE_PNG.toString('base64')}`,
        });
        continue;
      }
      if (!HASH_RE.test(String(id))) {
        throw new AgentError('invalid_request', 'unknown attachment reference');
      }
      const file = this.media.store.file(uid, id);
      if (!file) throw new AgentError('invalid_request', 'attachment not found');
      if (file.size > MAX_IMAGE_BYTES) {
        throw new AgentError('agent_media_too_large', 'attachment exceeds the image limit', {
          details: { id, size: file.size, limit: MAX_IMAGE_BYTES },
        });
      }
      const head = Buffer.alloc(Math.min(64, file.size));
      let fd: number | null = null;
      try {
        fd = fs.openSync(file.path, 'r');
        fs.readSync(fd, head, 0, head.length, 0);
      } catch (error) {
        throw new AgentError('agent_media_invalid', 'attachment could not be read', { cause: error });
      } finally {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* already closed */ }
        }
      }
      const sniffed = sniffMedia(head);
      if (!sniffed || sniffed.kind !== 'image') {
        throw new AgentError('agent_media_invalid', 'attachment is not a still image', { details: { id } });
      }
      const bytes = fs.readFileSync(file.path);
      out.push({
        id,
        kind: 'image',
        mime: sniffed.mime,
        name: id.slice(0, 12),
        size: bytes.length,
        dataUrl: `data:${sniffed.mime};base64,${bytes.toString('base64')}`,
      });
    }
    return out;
  }
}
