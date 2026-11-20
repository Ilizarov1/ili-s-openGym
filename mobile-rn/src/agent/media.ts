// Local image attachments. Only a file the app already registered is read;
// the first bytes are sniffed, the size is capped, and only metadata is logged.
import { File } from 'expo-file-system';
import { AgentError } from './shared';
import type { AgentAttachment } from './types';

const MAX_BYTES = 2 * 1024 * 1024;

const sniff = (bytes: Uint8Array): { mime: string; ext: string } | null => {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
};

export async function readAttachment(id: string, uri: string): Promise<AgentAttachment> {
  const file = new File(uri);
  if (!file.exists) throw new AgentError('agent_media_invalid', 'attachment file does not exist');
  if (file.size > MAX_BYTES) {
    throw new AgentError('agent_media_too_large', 'attachment exceeds the image limit', {
      details: { size: file.size, limit: MAX_BYTES },
    });
  }
  const bytes = await file.bytes();
  const kind = sniff(bytes);
  if (!kind) throw new AgentError('agent_media_invalid', 'attachment is not a still image');
  const base64 = await file.base64();
  return {
    id,
    kind: 'image',
    mime: kind.mime,
    name: `${id.slice(0, 16)}.${kind.ext}`,
    size: bytes.length,
    dataUrl: `data:${kind.mime};base64,${base64}`,
  };
}

export async function readAttachments(items: { id: string; uri: string }[]): Promise<AgentAttachment[]> {
  const out: AgentAttachment[] = [];
  for (const item of items) out.push(await readAttachment(item.id, item.uri));
  return out;
}
