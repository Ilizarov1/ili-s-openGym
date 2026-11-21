// Local image attachments. Only a file the app already registered is read;
// the first bytes are sniffed, the size is capped, and only metadata is logged.
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';
import { manipulateAsync, SaveFormat, type Action } from 'expo-image-manipulator';
import { AgentError } from './shared';
import type { AgentAiImageInput, AgentAttachment } from './types';

const MAX_BYTES = 2 * 1024 * 1024;
const AI_MAX_BYTES = 1024 * 1024;
const AI_RAW_MAX_BYTES = 40 * 1024 * 1024;
const AI_ATTEMPTS: [number, number][] = [
  [1280, 0.85],
  [1280, 0.7],
  [1200, 0.7],
  [960, 0.6],
];

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

/** The subset of `expo-image-picker`'s asset the normalizer needs. */
export type AiImageAsset = {
  uri: string;
  width: number;
  height: number;
  fileSize?: number | null;
  type?: string | null;
  exif?: unknown;
};

function exifValue(exif: Record<string, unknown> | null | undefined, names: string[]) {
  if (!exif) return undefined;
  for (const name of names) {
    if (exif[name] != null) return exif[name];
  }
  return undefined;
}

function exifNumber(exif: Record<string, unknown> | null | undefined, names: string[]) {
  const value = exifValue(exif, names);
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/** EXIF orientation 1..8; 1 or null means upright. */
function orientationOf(exif: Record<string, unknown> | null | undefined) {
  const value = exifNumber(exif, ['Orientation', 'orientation']);
  return value != null && value >= 1 && value <= 8 ? value : null;
}

function rawDimensions(exif: Record<string, unknown> | null | undefined, width: number, height: number) {
  const exifWidth = exifNumber(exif, ['PixelXDimension', 'ImageWidth', 'ExifImageWidth']);
  const exifHeight = exifNumber(exif, ['PixelYDimension', 'ImageHeight', 'ExifImageHeight']);
  const explicit = !!(exifWidth && exifWidth > 0 && exifHeight && exifHeight > 0);
  return {
    width: explicit ? exifWidth as number : width,
    height: explicit ? exifHeight as number : height,
    explicit,
  };
}

function resizeActions(width: number, height: number, maxEdge: number): Action[] {
  const longEdge = Math.max(width, height);
  if (!(longEdge > maxEdge)) return [];
  return [{ resize: width >= height ? { width: maxEdge } : { height: maxEdge } }];
}

async function encodeOnce(uri: string, actions: Action[], compress: number) {
  const result = await manipulateAsync(uri, actions, { compress, format: SaveFormat.JPEG });
  const file = new File(result.uri);
  const bytes = await file.bytes();
  return { ...result, bytes };
}

function invalid(): AgentError {
  return new AgentError('agent_media_invalid', 'this image cannot be decoded');
}

/**
 * Normalize one picked image for the AI exercise search: honour EXIF
 * orientation, try 1280/0.85 → 1280/0.7 → 1200/0.7 → 960/0.6 until the decoded
 * JPEG is at most 1 MiB, and return an inline data URL plus metadata. The bytes
 * and the data URL are never logged.
 */
export async function normalizeAiImage(asset: AiImageAsset): Promise<AgentAiImageInput> {
  if (!asset?.uri) throw new AgentError('agent_media_invalid', 'no image was selected');
  if (asset.type && asset.type !== 'image' && asset.type !== 'livePhoto') {
    throw new AgentError('agent_media_invalid', 'please select a still image');
  }
  if (asset.fileSize != null && asset.fileSize > AI_RAW_MAX_BYTES) {
    throw new AgentError('agent_media_too_large', 'the original image is too large', {
      details: { size: asset.fileSize, limit: AI_RAW_MAX_BYTES },
    });
  }

  const exif = asset.exif && typeof asset.exif === 'object' ? asset.exif as Record<string, unknown> : null;
  const orientation = orientationOf(exif);
  const raw = rawDimensions(exif, asset.width, asset.height);
  let encoded: Awaited<ReturnType<typeof encodeOnce>> | null = null;

  try {
    for (const [edge, quality] of AI_ATTEMPTS) {
      let attempt = await encodeOnce(asset.uri, resizeActions(asset.width, asset.height, edge), quality);
      if (attempt.bytes.byteLength === 0 || attempt.width <= 0 || attempt.height <= 0) throw invalid();
      // Android decoders normally apply EXIF orientation before the manipulator
      // sees the pixels. If a decoder leaves a 90°/270° image raw, the sides are
      // still in the camera order; rotate and resize once more.
      if ((orientation === 6 || orientation === 8) && raw.explicit && raw.width !== raw.height) {
        const rawLandscape = raw.width > raw.height;
        const outLandscape = attempt.width > attempt.height;
        if (rawLandscape === outLandscape) {
          attempt = await encodeOnce(
            attempt.uri,
            [{ rotate: orientation === 6 ? 90 : 270 }, ...resizeActions(attempt.height, attempt.width, edge)],
            quality,
          );
          if (attempt.bytes.byteLength === 0 || attempt.width <= 0 || attempt.height <= 0) throw invalid();
        }
      }
      if (attempt.bytes.byteLength <= AI_MAX_BYTES) {
        encoded = attempt;
        break;
      }
    }
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw invalid();
  }
  if (!encoded) {
    throw new AgentError('agent_media_too_large', 'the compressed image is still too large', {
      details: { limit: AI_MAX_BYTES },
    });
  }

  const base64 = await new File(encoded.uri).base64();
  const mime = 'image/jpeg';
  const size = encoded.bytes.byteLength;
  console.info('[agent-ai-image]', JSON.stringify({
    mime,
    size,
    width: Math.round(encoded.width),
    height: Math.round(encoded.height),
  }));
  return {
    id: `image_${randomUUID()}`,
    mime,
    size,
    width: Math.round(encoded.width),
    height: Math.round(encoded.height),
    dataUrl: `data:${mime};base64,${base64}`,
    createdAt: Date.now(),
  };
}
