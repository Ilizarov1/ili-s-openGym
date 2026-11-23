// Exercise demos (issue: P2 exercise demos).
//
// Built-in exercises keep their still and clip on the paired server, under the
// same `exercise-media/still/` and `exercise-media/clip/` folders the Web client
// uses (frontend/src/lib/exercises.js: imgSrc/gifSrc). Custom exercises carry a
// MediaRef in synced state, never the bytes; the file itself is downloaded from
// the profile's own `/api/media/{hash}` with the pair's Bearer token.
//
// The download is checked against the size and SHA-256 the state names before
// the player or image component ever sees it, and it lives in a private cache
// directory scoped by server, account and hash. The detail screen deletes its
// files when it closes; switching workspaces aborts the old request and removes
// what it wrote.

import { useEffect, useRef, useState } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { cleanUrl, mediaOf, normalizeMediaRef } from '../../frontend/src/lib/media-refs.js';
import { photoDirectory } from './body/photos';
import { catalogueClip, catalogueExercise, catalogueStill } from './catalogue';
import type { Connection } from './server';
import type { CustomExercise, MediaRefLike, Profile } from './training';

export type ExerciseMediaKind = 'video' | 'gif' | 'image' | 'none';

export type ExerciseMediaUnavailable = 'practice' | 'disabled' | 'missing' | 'failed';

/** A bundled `require()` asset id, a local file URI or a remote URL. */
export type ExerciseMediaSource = string | number;

export type ExerciseMediaState = {
  kind: ExerciseMediaKind;
  /** A bundled asset id, a local file URI for custom media, or a server URL. */
  uri: ExerciseMediaSource | null;
  posterUri: ExerciseMediaSource | null;
  loading: boolean;
  origin: 'builtin' | 'custom' | 'none';
  unavailable?: ExerciseMediaUnavailable;
};

type NormalizedMediaRef = {
  kind: 'image' | 'gif' | 'video';
  hash: string;
  mime: string;
  size: number;
  width: number;
  height: number;
  dur?: number;
  poster?: { hash: string; mime: string; size: number; width: number; height: number };
};

const FALLBACK: ExerciseMediaState = {
  kind: 'none',
  uri: null,
  posterUri: null,
  loading: false,
  origin: 'none',
};

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  // MOV and MP4 are the same container; Android's decoders are far happier with
  // the .mp4 name, exactly as the Web client renames it (media-refs.js playExt).
  'video/quicktime': 'mp4',
  'video/webm': 'webm',
};

const MEDIA_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const CONFIG_TIMEOUT_MS = 3_000;
const CONFIG_TRUE_TTL_MS = 10 * 60_000;
const CONFIG_FALSE_TTL_MS = 30_000;

const configCache = new Map<string, { at: number; enabled: boolean }>();
const configPending = new Map<string, Promise<boolean>>();

export function builtinMedia(server: string | null, exerciseId: string): ExerciseMediaState {
  // The RN package carries the curated 180 px catalogue. Prefer it so the
  // detail screen works offline; the server remains a fallback for a build
  // that omitted some files.
  const bundledStill = catalogueStill(exerciseId);
  const bundledClip = catalogueClip(exerciseId);
  if (bundledClip != null) {
    return {
      kind: 'video',
      uri: bundledClip,
      posterUri: bundledStill,
      loading: false,
      origin: 'builtin',
    };
  }
  if (bundledStill != null) {
    return {
      kind: 'image',
      uri: bundledStill,
      posterUri: bundledStill,
      loading: false,
      origin: 'builtin',
    };
  }

  const base = server?.trim().replace(/\/+$/, '') ?? '';
  if (!base) return { ...FALLBACK, unavailable: 'practice' };
  // catalogueExercise resolves a female/male drawing alias to the exercise the
  // harness stores, so 2440 and 0025 (barbell bench press) name the same files.
  const exercise = catalogueExercise(exerciseId) as { id: string; img?: string; gif?: string } | null;
  if (!exercise?.gif && !exercise?.img) return { ...FALLBACK, unavailable: 'missing' };
  const still = `${base}/exercise-media/still/${exercise.img ?? `${exercise.id}.webp`}`;
  if (!exercise.gif) {
    return {
      kind: 'image',
      uri: still,
      posterUri: still,
      loading: false,
      origin: 'builtin',
    };
  }
  return {
    kind: 'video',
    uri: `${base}/exercise-media/clip/${exercise.gif}`,
    posterUri: still,
    loading: false,
    origin: 'builtin',
  };
}

/** The link a custom exercise carries, validated again here (never fetched). */
export function customExerciseLink(exercise: CustomExercise | undefined) {
  return cleanUrl(exercise?.url) as string | null;
}

/**
 * Whether the instance says it stores media (`GET /api/config` has a `media`
 * block). A failed probe counts as unavailable, which is the safe side: the
 * detail screen then shows the placeholder instead of waiting on a download.
 */
export function mediaUploadsEnabled(connection: Connection): Promise<boolean> {
  const now = Date.now();
  const cached = configCache.get(connection.server);
  if (cached && now - cached.at < (cached.enabled ? CONFIG_TRUE_TTL_MS : CONFIG_FALSE_TTL_MS)) {
    return Promise.resolve(cached.enabled);
  }
  const pending = configPending.get(connection.server);
  if (pending) return pending;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    try {
      const response = await fetch(`${connection.server}/api/config`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const data = await response.json() as { media?: unknown };
      return !!data?.media;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  })().then(enabled => {
    configCache.set(connection.server, { at: Date.now(), enabled });
    return enabled;
  }).finally(() => {
    configPending.delete(connection.server);
  });

  configPending.set(connection.server, request);
  return request;
}

type CustomMediaFiles = {
  main: string | null;
  poster: string | null;
  cleanup: () => void;
};

/**
 * Downloads a custom exercise's media and poster into a cache directory scoped
 * by server/account. The poster is reported as soon as it is ready so the
 * detail can show a cover while a video downloads. The returned cleanup deletes
 * every file this call wrote.
 */
export async function loadCustomMedia(
  ref: NormalizedMediaRef,
  connection: Connection,
  signal: AbortSignal,
  onPoster: (uri: string | null) => void,
): Promise<CustomMediaFiles> {
  const directory = workspaceMediaDirectory(connection);
  const written: File[] = [];
  const cleanup = () => {
    for (const file of written) {
      try {
        if (file.exists) file.delete();
      } catch {
        // Best effort: the cache may already be gone or locked by a player.
      }
    }
  };

  try {
    let poster: string | null = null;
    if (ref.poster) {
      try {
        const file = await downloadMediaFile(ref.poster, connection, directory, signal);
        written.push(file);
        poster = file.uri;
        if (!signal.aborted) onPoster(poster);
      } catch {
        if (signal.aborted) throw new Error('aborted');
      }
    }

    let main: string | null = null;
    try {
      const file = await downloadMediaFile(ref, connection, directory, signal);
      written.push(file);
      main = file.uri;
    } catch {
      if (signal.aborted) throw new Error('aborted');
    }

    return { main, poster, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function downloadMediaFile(
  ref: { hash: string; mime: string; size: number },
  connection: Connection,
  directory: Directory,
  signal: AbortSignal,
): Promise<File> {
  if (ref.size > MAX_DOWNLOAD_BYTES) throw new Error('file too large');
  const extension = MIME_EXT[ref.mime] ?? 'bin';
  const file = new File(directory, `${ref.hash}.${extension}`);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort);
  const timeout = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);

  try {
    const response = await fetch(`${connection.server}/api/media/${ref.hash}`, {
      // The token only ever goes to the paired instance's own media route.
      headers: { Accept: '*/*', Authorization: `Bearer ${connection.token}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // A redirect away from the paired instance must not hand its bytes over as
    // if they came from this account's own media folder.
    if (response.url && !response.url.startsWith(`${connection.server}/api/media/`)) {
      throw new Error('unexpected media origin');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength !== ref.size) throw new Error('size mismatch');
    const digest = await Crypto.digest(
      Crypto.CryptoDigestAlgorithm.SHA256,
      new Uint8Array(buffer),
    );
    if (toHex(digest) !== ref.hash) throw new Error('hash mismatch');
    if (signal.aborted || controller.signal.aborted) throw new Error('aborted');
    file.write(new Uint8Array(buffer));
    return file;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
  }
}

function workspaceMediaDirectory(connection: Connection): Directory {
  const directory = new Directory(
    Paths.cache,
    'opengym-media',
    scopePart(connection.server),
    scopePart(connection.user.id),
  );
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

// A readable, filesystem-safe folder name that still tells two servers or two
// accounts apart even when their names differ only in punctuation.
function scopePart(value: string) {
  const safe = value.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'scope';
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${safe}-${(hash >>> 0).toString(16)}`;
}

function toHex(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

const CUSTOM_IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index++) {
    table[BASE64_ALPHABET.charCodeAt(index)] = index;
  }
  return table;
})();

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const cleaned = base64.replace(/\s+/g, '');
  if (!cleaned || cleaned.length % 4 !== 0) {
    throw new Error('无效的图片 Base64 数据');
  }
  let padding = 0;
  if (cleaned.endsWith('==')) padding = 2;
  else if (cleaned.endsWith('=')) padding = 1;
  const byteLength = (cleaned.length / 4) * 3 - padding;
  const out = new Uint8Array(new ArrayBuffer(byteLength));
  let offset = 0;
  for (let index = 0; index < cleaned.length; index += 4) {
    const c0 = BASE64_LOOKUP[cleaned.charCodeAt(index)];
    const c1 = BASE64_LOOKUP[cleaned.charCodeAt(index + 1)];
    const c2Char = cleaned.charCodeAt(index + 2);
    const c3Char = cleaned.charCodeAt(index + 3);
    const c2 = c2Char === 61 ? 0 : BASE64_LOOKUP[c2Char];
    const c3 = c3Char === 61 ? 0 : BASE64_LOOKUP[c3Char];
    if (c0 < 0 || c1 < 0 || (c2Char !== 61 && c2 < 0) || (c3Char !== 61 && c3 < 0)) {
      throw new Error('无效的图片 Base64 编码');
    }
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[offset++] = (triple >> 16) & 0xff;
    if (c2Char !== 61 && offset < byteLength) out[offset++] = (triple >> 8) & 0xff;
    if (c3Char !== 61 && offset < byteLength) out[offset++] = triple & 0xff;
  }
  return out;
}

/**
 * Resolves the private workspace file URI for a custom exercise media ref if
 * it has already been written locally, or null when absent.
 */
export function localCustomMediaUri(
  ref: NormalizedMediaRef | MediaRefLike | null | undefined,
  connection: Connection | null,
): string | null {
  const normalized = ref ? (normalizeMediaRef(ref) as NormalizedMediaRef | null) : null;
  if (!normalized) return null;
  const extension = MIME_EXT[normalized.mime];
  if (!extension) return null;
  try {
    const file = new File(photoDirectory(connection), `${normalized.hash}.${extension}`);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

/**
 * Decodes an AI-captured image dataUrl, computes its SHA-256 hash, persists it
 * to `photoDirectory(connection)`, and returns a standard `MediaRefLike`.
 */
export async function saveCustomExerciseImage(
  image: { mime: string; width: number; height: number; dataUrl: string },
  connection: Connection | null,
): Promise<{ ref: MediaRefLike; fileUri: string }> {
  const extension = CUSTOM_IMAGE_MIME_EXT[image.mime];
  if (!extension) {
    throw new Error(`不支持的图片格式：${image.mime}`);
  }
  const match = /^data:([^;]+);base64,(.+)$/s.exec(image.dataUrl.trim());
  if (!match) {
    throw new Error('图片数据格式无效');
  }
  const bytes = decodeBase64(match[2]);
  if (bytes.byteLength === 0) {
    throw new Error('图片内容为空');
  }
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  const hash = toHex(digest);
  const file = new File(photoDirectory(connection), `${hash}.${extension}`);
  file.write(bytes);
  const ref: MediaRefLike = {
    kind: image.mime === 'image/gif' ? 'gif' : 'image',
    hash,
    mime: image.mime,
    size: bytes.byteLength,
    width: Math.max(1, Math.round(image.width)),
    height: Math.max(1, Math.round(image.height)),
    at: Date.now(),
  };
  return { ref, fileUri: file.uri };
}

type UseExerciseMediaOptions = {
  profile: Profile;
  connection: Connection | null;
  server: string | null;
  exerciseId: string;
  custom: boolean;
};

type StoredMediaState = ExerciseMediaState & { scope: string };

function initialState(
  custom: boolean,
  server: string | null,
  exerciseId: string,
  ref: NormalizedMediaRef | null,
  hasConnection: boolean,
  localCustomUri: string | null,
): ExerciseMediaState {
  if (!custom) return builtinMedia(server, exerciseId);
  if (ref && localCustomUri) {
    return {
      kind: ref.kind,
      uri: localCustomUri,
      posterUri: localCustomUri,
      loading: false,
      origin: 'custom',
    };
  }
  return {
    kind: ref?.kind ?? 'none',
    uri: null,
    posterUri: null,
    loading: !!ref && hasConnection,
    origin: 'custom',
  };
}

/**
 * Resolves what the detail should show. Built-in clips are played straight from
 * the server (the same files the list thumbnails use); custom media checks the
 * private local directory first, then fetches from the paired server when needed.
 */
export function useExerciseMedia({
  profile,
  connection,
  server,
  exerciseId,
  custom,
}: UseExerciseMediaOptions): ExerciseMediaState {
  const customExercise = custom
    ? (profile.customEx ?? []).find(exercise => exercise?.id === exerciseId)
    : undefined;
  const ref = customExercise ? (mediaOf(customExercise) as NormalizedMediaRef | null) : null;
  const localCustomUri = custom && ref ? localCustomMediaUri(ref, connection) : null;
  const mediaKey = ref
    ? [ref.kind, ref.hash, ref.mime, ref.size, ref.poster?.hash ?? '', ref.poster?.size ?? ''].join('|')
    : '';
  const connectionKey = connection
    ? `${connection.server}|${connection.user.id}|${connection.token}`
    : 'practice';
  const scope = [custom ? 'custom' : 'builtin', exerciseId, server ?? '', connectionKey, mediaKey].join('\u0000');
  const initial = initialState(custom, server, exerciseId, ref, !!connection, localCustomUri);
  const [stored, setStored] = useState<StoredMediaState>(() => ({ ...initial, scope }));
  // The effect reads the current custom exercise through this ref so an
  // unrelated profile update (a favourite toggle, a background sync) does not
  // restart a playing video; only the media identity below does.
  const exerciseRef = useRef(customExercise);
  exerciseRef.current = customExercise;

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let cleanup: (() => void) | null = null;
    const currentScope = scope;
    const write = (next: ExerciseMediaState) => {
      if (active) setStored({ ...next, scope: currentScope });
    };

    if (!custom) {
      write(builtinMedia(server, exerciseId));
      return () => controller.abort();
    }

    const exercise = exerciseRef.current;
    const mediaRef = exercise ? (mediaOf(exercise) as NormalizedMediaRef | null) : null;
    if (!mediaRef) {
      write({
        kind: 'none',
        uri: null,
        posterUri: null,
        loading: false,
        origin: 'custom',
        unavailable: 'missing',
      });
      return () => controller.abort();
    }
    const localUri = localCustomMediaUri(mediaRef, connection);
    if (localUri) {
      write({
        kind: mediaRef.kind,
        uri: localUri,
        posterUri: localUri,
        loading: false,
        origin: 'custom',
      });
      return () => controller.abort();
    }
    if (!connection) {
      write({
        kind: mediaRef.kind,
        uri: null,
        posterUri: null,
        loading: false,
        origin: 'custom',
        unavailable: 'practice',
      });
      return () => controller.abort();
    }

    write({
      kind: mediaRef.kind,
      uri: null,
      posterUri: null,
      loading: true,
      origin: 'custom',
    });

    void (async () => {
      const enabled = await mediaUploadsEnabled(connection);
      if (!active) return;
      if (!enabled) {
        write({
          kind: mediaRef.kind,
          uri: null,
          posterUri: null,
          loading: false,
          origin: 'custom',
          unavailable: 'disabled',
        });
        return;
      }
      try {
        const files = await loadCustomMedia(mediaRef, connection, controller.signal, poster => {
          if (active) {
            setStored(current => current.scope === currentScope
              ? { ...current, posterUri: poster }
              : current);
          }
        });
        if (!active) {
          files.cleanup();
          return;
        }
        cleanup = files.cleanup;
        write({
          kind: mediaRef.kind,
          uri: files.main,
          posterUri: files.poster,
          loading: false,
          origin: 'custom',
          unavailable: files.main || files.poster ? undefined : 'failed',
        });
      } catch {
        write({
          kind: mediaRef.kind,
          uri: null,
          posterUri: null,
          loading: false,
          origin: 'custom',
          unavailable: 'failed',
        });
      }
    })().catch(() => {
      write({
        kind: mediaRef.kind,
        uri: null,
        posterUri: null,
        loading: false,
        origin: 'custom',
        unavailable: 'failed',
      });
    });

    return () => {
      active = false;
      controller.abort();
      cleanup?.();
    };
    // The media identity and workspace are the only reasons to reload; see the
    // exerciseRef note above.
  }, [scope, connection, custom, exerciseId, server]);

  // A prop change (another account, server or exercise) is visible before the
  // effect runs; never hand the previous workspace's URI to the renderer.
  return stored.scope === scope ? stored : initial;
}
