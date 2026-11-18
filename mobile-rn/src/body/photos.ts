/**
 * 进度照片：系统选图、EXIF 方向、重编码、SHA-256、应用私有目录、待上传队列和认证回退。
 *
 * 与 Web 的约定保持一致：
 * - 同步状态里只放 `MediaRef`，不放字节；字节在应用私有目录和服务器 `/api/media/{hash}`。
 * - 当天最新训练还有媒体空位时写 `workouts[].media`（最多 6 个），否则写
 *   `Profile.dayPhotos[hash]`；实例不支持按日照片时会提前提示。
 * - 删除按日照片写 `{ _ts }` tombstone；删除训练媒体只改该训练自己的 `media` 字段。
 * - 文件按 server + account 分目录，练习模式单独一个目录；切换工作区不会看到别人的照片。
 *
 * `uploadPendingPhotos(connection, state)` 供 App 在同步前调用：只上传字节，不新增引用，
 * 因此重试不会产生第二份照片；失败的队列项保留错误信息并可再次重试。
 */

import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat, type Action } from 'expo-image-manipulator';
import {
  normalizeMediaRef,
  referencedHashes,
  workoutMediaOf,
  WORKOUT_MEDIA_MAX,
} from '../../../frontend/src/lib/media-refs.js';
import { dayPhotosOf, workoutOn } from '../../../frontend/src/lib/day-photos.js';
import type { ProfileChange } from '../profileChanges';
import type { Connection } from '../server';
import type { LocalState, PhotoUpload } from '../storage';
import {
  localDate,
  workoutKey,
  type MediaRefLike,
  type Profile,
  type Workout,
} from '../training';

const MB = 1024 * 1024;
const MAX_RAW_PHOTO_MB = 40;
const DEFAULT_IMAGE_MB = 2;
const IMAGE_MAX_EDGE = 1600;
const MAX_DOWNLOAD_BYTES = 64 * MB;
const UPLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CONFIG_TIMEOUT_MS = 4_000;
const CONFIG_TRUE_TTL_MS = 10 * 60_000;
const CONFIG_FALSE_TTL_MS = 30_000;

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export class PhotoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoError';
  }
}

export type PhotoCapabilities = {
  /** The instance stores media at all (`GET /api/config` has a `media` block). */
  enabled: boolean;
  /** It keeps photos filed under a day (`media.days`). */
  days: boolean;
  /** It keeps a logged workout's `media` list (`media.workouts`). */
  workouts: boolean;
  imageMB: number;
  /** False when an offline probe had to fall back to optimistic defaults. */
  known: boolean;
};

const LOCAL_CAPABILITIES: PhotoCapabilities = {
  enabled: true,
  days: true,
  workouts: true,
  imageMB: DEFAULT_IMAGE_MB,
  known: true,
};

type CachedCapabilities = { at: number; value: PhotoCapabilities };

const capabilityCache = new Map<string, CachedCapabilities>();
const capabilityPending = new Map<string, Promise<PhotoCapabilities>>();

function positiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The instance's media limits, cached per server; a failed probe falls back to the last answer. */
export function photoCapabilities(connection: Connection | null): Promise<PhotoCapabilities> {
  if (!connection) return Promise.resolve(LOCAL_CAPABILITIES);
  const cached = capabilityCache.get(connection.server);
  const fresh = cached && Date.now() - cached.at < (cached.value.enabled ? CONFIG_TRUE_TTL_MS : CONFIG_FALSE_TTL_MS);
  if (cached && fresh) return Promise.resolve(cached.value);
  const pending = capabilityPending.get(connection.server);
  if (pending) return pending;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG_TIMEOUT_MS);
    try {
      const response = await fetch(`${connection.server}/api/config`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { media?: { imageMB?: unknown; days?: unknown; workouts?: unknown } };
      const media = data?.media;
      const value: PhotoCapabilities = media && typeof media === 'object'
        ? {
          enabled: true,
          days: media.days === true,
          workouts: media.workouts === true,
          imageMB: positiveNumber(media.imageMB, DEFAULT_IMAGE_MB),
          known: true,
        }
        : { enabled: false, days: false, workouts: false, imageMB: DEFAULT_IMAGE_MB, known: true };
      return value;
    } catch {
      // Offline is not a reason to block a photo: keep the last known answer, or allow it
      // locally and let the reference sync once the instance answers again.
      return cached?.value ?? { ...LOCAL_CAPABILITIES, known: false };
    } finally {
      clearTimeout(timeout);
    }
  })().then(value => {
    capabilityCache.set(connection.server, { at: Date.now(), value });
    return value;
  }).finally(() => {
    capabilityPending.delete(connection.server);
  });

  capabilityPending.set(connection.server, request);
  return request;
}

function scopePart(value: string) {
  const safe = value.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 48) || 'scope';
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${safe}-${(hash >>> 0).toString(16)}`;
}

/** The private folder for this server and account; practice mode has its own folder. */
export function photoDirectory(connection: Connection | null) {
  const directory = connection
    ? new Directory(Paths.document, 'opengym-photos', scopePart(connection.server), scopePart(connection.user.id))
    : new Directory(Paths.document, 'opengym-photos', 'practice');
  directory.create({ intermediates: true, idempotent: true });
  return directory;
}

function extensionFor(ref: Pick<MediaRefLike, 'mime'>) {
  return MIME_EXT[ref.mime ?? ''] ?? 'jpg';
}

function photoFile(ref: Pick<MediaRefLike, 'hash' | 'mime'>, connection: Connection | null) {
  return new File(photoDirectory(connection), `${ref.hash}.${extensionFor(ref)}`);
}

function localPhotoUri(ref: Pick<MediaRefLike, 'hash' | 'mime'>, connection: Connection | null) {
  try {
    const file = photoFile(ref, connection);
    return file.exists ? file.uri : null;
  } catch {
    return null;
  }
}

function hexOf(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  return hexOf(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes));
}

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
export function photoOrientation(exif: Record<string, unknown> | null | undefined) {
  const value = exifNumber(exif, ['Orientation', 'orientation']);
  return value != null && value >= 1 && value <= 8 ? value : null;
}

/** The day a photo says it was taken, `YYYY-MM-DD`, or null. */
export function photoExifDay(exif: Record<string, unknown> | null | undefined) {
  const raw = exifValue(exif, ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime']);
  const match = /^(\d{4})[:\-](\d{2})[:\-](\d{2})/.exec(String(raw ?? '').trim());
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function rawDimensions(exif: Record<string, unknown> | null | undefined, assetWidth: number, assetHeight: number) {
  const width = exifNumber(exif, ['PixelXDimension', 'ImageWidth', 'ExifImageWidth']);
  const height = exifNumber(exif, ['PixelYDimension', 'ImageHeight', 'ExifImageHeight']);
  const explicit = !!(width && width > 0 && height && height > 0);
  return {
    width: explicit ? width as number : assetWidth,
    height: explicit ? height as number : assetHeight,
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
  return { ...result, bytes, mime: 'image/jpeg' as const };
}

export type PickedPhoto = {
  ref: MediaRefLike;
  /** The verified file in the app's private folder. */
  uri: string;
  /** The day EXIF says it was taken, when it is a valid past day. */
  exifDay: string | null;
  orientation: number | null;
  /** True when an identical file was already in this workspace's folder. */
  existed: boolean;
};

/**
 * Opens the system photo picker, re-encodes the chosen still (honouring EXIF orientation, which
 * the Android decoder applies), checks the decode, the cap and SHA-256, then writes a private copy.
 * Returns null when the user cancels.
 */
export async function pickProgressPhoto(
  connection: Connection | null,
  imageMB = DEFAULT_IMAGE_MB,
): Promise<PickedPhoto | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: false,
    exif: true,
    quality: 1,
  });
  if (result.canceled) return null;
  const asset = result.assets?.[0];
  if (!asset?.uri) throw new PhotoError('没有读取到所选照片，请重试。');
  if (asset.type && asset.type !== 'image' && asset.type !== 'livePhoto') {
    throw new PhotoError('请选择一张图片。');
  }
  if (asset.fileSize != null && asset.fileSize > MAX_RAW_PHOTO_MB * MB) {
    throw new PhotoError(`原图超过 ${MAX_RAW_PHOTO_MB} MB，无法处理。`);
  }

  const exif = asset.exif && typeof asset.exif === 'object' ? asset.exif as Record<string, unknown> : null;
  const orientation = photoOrientation(exif);
  const raw = rawDimensions(exif, asset.width, asset.height);
  const cap = positiveNumber(imageMB, DEFAULT_IMAGE_MB) * MB;
  const attempts: [number, number][] = [
    [IMAGE_MAX_EDGE, 0.85],
    [IMAGE_MAX_EDGE, 0.7],
    [1200, 0.7],
    [960, 0.6],
  ];

  let encoded: Awaited<ReturnType<typeof encodeOnce>> | null = null;
  try {
    for (const [edge, quality] of attempts) {
      let attempt = await encodeOnce(asset.uri, resizeActions(asset.width, asset.height, edge), quality);
      if (attempt.bytes.byteLength === 0 || attempt.width <= 0 || attempt.height <= 0) {
        throw new PhotoError('这张图片无法解码，请换一张。');
      }
      // The Android image loader applies EXIF orientation before the manipulator sees the
      // pixels, so a 90° tag normally comes back with its sides already swapped. If it did not
      // (a decoder that leaves pixels raw), swap here. 180°/mirror tags have no dimension
      // signal; the platform loader handles those, and a device that does not would need a
      // pixel-level check (documented gap).
      if ((orientation === 6 || orientation === 8) && raw.explicit && raw.width > 0 && raw.height > 0 && raw.width !== raw.height) {
        const rawLandscape = raw.width > raw.height;
        const outLandscape = attempt.width > attempt.height;
        if (rawLandscape === outLandscape) {
          const rotated = await encodeOnce(
            attempt.uri,
            [{ rotate: orientation === 6 ? 90 : 270 }, ...resizeActions(attempt.height, attempt.width, edge)],
            quality,
          );
          attempt = rotated;
        }
      }
      if (attempt.bytes.byteLength <= cap) {
        encoded = attempt;
        break;
      }
    }
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    throw new PhotoError('这张图片无法解码，请换一张。');
  }
  if (!encoded) throw new PhotoError(`照片超过 ${positiveNumber(imageMB, DEFAULT_IMAGE_MB)} MB，无法保存。`);

  const hash = await sha256(encoded.bytes);
  const mime = encoded.mime;
  const file = photoFile({ hash, mime }, connection);
  const existed = file.exists;
  file.write(encoded.bytes);

  const day = photoExifDay(exif);
  return {
    ref: {
      kind: 'image',
      hash,
      mime,
      size: encoded.bytes.byteLength,
      width: Math.round(encoded.width),
      height: Math.round(encoded.height),
    },
    uri: file.uri,
    exifDay: day && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= localDate(Date.now()) ? day : null,
    orientation,
    existed,
  };
}

/** The local file URI if this workspace already has the verified bytes; no network. */
export function localPhotoUriFor(ref: MediaRefLike, connection: Connection | null) {
  const normalized = normalizeMediaRef(ref) as MediaRefLike | null;
  return normalized ? localPhotoUri(normalized, connection) : null;
}

const downloadPending = new Map<string, Promise<string | null>>();

/**
 * Resolve a photo for display: the private local file first, then an authenticated, size- and
 * SHA-256-checked download from the paired instance. Returns null when neither is available.
 */
export async function resolvePhotoUri(ref: MediaRefLike, connection: Connection | null): Promise<string | null> {
  const normalized = normalizeMediaRef(ref) as MediaRefLike | null;
  if (!normalized) return null;
  const local = localPhotoUri(normalized, connection);
  if (local) return local;
  if (!connection) return null;
  if ((normalized.size ?? 0) > MAX_DOWNLOAD_BYTES) return null;

  const key = `${connection.server}|${connection.user.id}|${normalized.hash}`;
  const pending = downloadPending.get(key);
  if (pending) return pending;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(`${connection.server}/api/media/${normalized.hash}`, {
        headers: { Accept: '*/*', Authorization: `Bearer ${connection.token}` },
        signal: controller.signal,
      });
      if (!response.ok) return null;
      if (response.url && !response.url.startsWith(`${connection.server}/api/media/`)) return null;
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== normalized.size) return null;
      const bytes = new Uint8Array(buffer);
      if (await sha256(bytes) !== normalized.hash) return null;
      const file = photoFile(normalized, connection);
      file.write(bytes);
      return file.uri;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  })().finally(() => {
    downloadPending.delete(key);
  });

  downloadPending.set(key, request);
  return request;
}

function uploadMessage(status: number, code?: string) {
  if (status === 401) return '配对已失效，请重新连接同一个账号。';
  if (status === 413) return code === 'media-quota' ? '账号的媒体空间已满。' : '照片超过实例允许的大小。';
  if (status === 429) return '上传太频繁，请稍后重试。';
  if (status === 507) return '实例存储空间不足。';
  return `照片上传失败（HTTP ${status}）。`;
}

/** Upload one queued file. It only PUTs bytes; the synced reference is written by applyChanges. */
export async function uploadPhotoFile(connection: Connection, upload: PhotoUpload): Promise<void> {
  const normalized = normalizeMediaRef(upload.ref) as MediaRefLike | null;
  if (!normalized || normalized.hash !== upload.hash) throw new PhotoError('照片引用无效，无法上传。');
  const file = new File(upload.fileUri);
  if (!file.exists) throw new PhotoError('本机照片文件已丢失，请重新选择。');
  const bytes = await file.bytes();
  if (bytes.byteLength !== normalized.size || await sha256(bytes) !== normalized.hash) {
    throw new PhotoError('本机照片文件校验失败，请重新选择。');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(`${connection.server}/api/media/${normalized.hash}`, {
      method: 'PUT',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${connection.token}`,
        'Content-Type': normalized.mime ?? 'image/jpeg',
      },
      body: bytes.buffer,
      signal: controller.signal,
    });
    let data: { ok?: boolean; hash?: string; code?: string } | null = null;
    try {
      data = await response.json() as { ok?: boolean; hash?: string; code?: string };
    } catch {
      data = null;
    }
    if (!response.ok) throw new PhotoError(uploadMessage(response.status, data?.code));
    if (data && (data.ok === false || (data.hash != null && data.hash !== normalized.hash))) {
      throw new PhotoError('服务器没有确认这张照片，稍后会重试。');
    }
  } catch (error) {
    if (controller.signal.aborted) throw new PhotoError('照片上传超时，请检查网络后重试。');
    throw error instanceof PhotoError ? error : new PhotoError('照片上传失败，请检查网络后重试。');
  } finally {
    clearTimeout(timeout);
  }
}

export type PhotoUploadResult = {
  uploads: PhotoUpload[];
  uploaded: number;
  failed: number;
};

/** How many queued photos still need bytes on the paired instance. */
export function pendingPhotoCount(state: Pick<LocalState, 'photoUploads'>) {
  return (state.photoUploads ?? []).filter(upload => !upload.uploadedAt).length;
}

/**
 * Retry every queued upload. The queue is returned in the same order with `uploadedAt` or
 * `error` updated; references are never added here, so retrying cannot duplicate a photo.
 */
export async function uploadPendingPhotos(
  connection: Connection | null,
  state: Pick<LocalState, 'photoUploads'>,
): Promise<PhotoUploadResult> {
  const uploads = (state.photoUploads ?? []).map(item => ({ ...item }));
  if (!connection || uploads.length === 0) return { uploads, uploaded: 0, failed: 0 };
  let uploaded = 0;
  let failed = 0;
  for (const upload of uploads) {
    if (upload.uploadedAt) continue;
    try {
      await uploadPhotoFile(connection, upload);
      upload.uploadedAt = Date.now();
      delete upload.error;
      uploaded++;
    } catch (error) {
      upload.error = error instanceof Error ? error.message : '照片上传失败，请稍后重试。';
      failed++;
    }
  }
  return { uploads, uploaded, failed };
}

export type ProgressPhotoTarget =
  | { kind: 'workout'; key: string; name: string }
  | { kind: 'day' };

export type ProgressPhoto = {
  hash: string;
  d: string;
  ref: MediaRefLike;
  source: 'workout' | 'day';
  workoutKey?: string;
  workoutName?: string;
  start: number;
};

/** Where a new progress photo goes for a day, or null when neither place has room. */
export function progressPhotoTarget(
  profile: Profile,
  day: string,
  canDay: boolean,
  canWorkout = true,
): ProgressPhotoTarget | null {
  const workout = canWorkout ? workoutOn({ workouts: profile.workouts ?? [] }, day) as Workout | null : null;
  if (workout && workoutMediaOf(workout).length < WORKOUT_MEDIA_MAX) {
    return { kind: 'workout', key: workoutKey(workout), name: workout.name || '训练' };
  }
  return canDay ? { kind: 'day' } : null;
}

/** Every still photo in the workspace: workout media first, then day-filed photos, newest first. */
export function progressPhotos(profile: Profile): ProgressPhoto[] {
  const out: ProgressPhoto[] = [];
  for (const workout of profile.workouts ?? []) {
    if (!workout?.d) continue;
    for (const ref of workoutMediaOf(workout) as MediaRefLike[]) {
      if (ref.kind === 'video') continue;
      out.push({
        hash: ref.hash,
        d: workout.d,
        ref,
        source: 'workout',
        workoutKey: workoutKey(workout),
        workoutName: workout.name || '训练',
        start: Number(workout.start) || 0,
      });
    }
  }
  for (const photo of dayPhotosOf(profile) as { hash: string; d: string; m: MediaRefLike }[]) {
    out.push({ hash: photo.hash, d: photo.d, ref: photo.m, source: 'day', start: 0 });
  }
  return out.sort((a, b) => {
    if (a.d !== b.d) return a.d < b.d ? 1 : -1;
    if (a.start !== b.start) return b.start - a.start;
    return a.hash.localeCompare(b.hash);
  });
}

export type ProgressPhotoGroup = { d: string; photos: ProgressPhoto[] };

export function groupProgressPhotos(photos: ProgressPhoto[]): ProgressPhotoGroup[] {
  const out: ProgressPhotoGroup[] = [];
  for (const photo of photos) {
    const last = out.at(-1);
    if (last?.d === photo.d) last.photos.push(photo);
    else out.push({ d: photo.d, photos: [photo] });
  }
  return out;
}

export function addPhotoChanges(
  target: ProgressPhotoTarget,
  day: string,
  ref: MediaRefLike,
  now = Date.now(),
): ProfileChange[] {
  if (target.kind === 'workout') {
    return [{ kind: 'workoutMedia', key: target.key, ref, t: now }];
  }
  return [{ kind: 'dayPhoto', d: day, ref, t: now }];
}

export function removePhotoChange(photo: ProgressPhoto, now = Date.now()): ProfileChange {
  return photo.source === 'workout' && photo.workoutKey
    ? { kind: 'workoutMedia', key: photo.workoutKey, hash: photo.hash, remove: true, t: now }
    : { kind: 'dayPhoto', hash: photo.hash, remove: true, t: now };
}

export function photoIsPending(uploads: readonly PhotoUpload[], hash: string) {
  return uploads.some(upload => upload.hash === hash && !upload.uploadedAt);
}

export function photoIsInWorkspace(profile: Profile, hash: string) {
  return referencedHashes({
    workouts: profile.workouts ?? [],
    dayPhotos: profile.dayPhotos ?? {},
    customEx: profile.customEx ?? [],
  } as unknown as Record<string, unknown>).has(hash);
}

/** A local date a progress photo may be filed under: real, and not in the future. */
export function validPhotoDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const noon = new Date(`${day}T12:00:00`).getTime();
  return Number.isFinite(noon) && localDate(noon) === day && day <= localDate(Date.now());
}

/** Remove the private copy of a pick the user cancelled before it was filed. */
export function discardPickedPhoto(picked: PickedPhoto | null) {
  if (!picked || picked.existed) return;
  try {
    const file = new File(picked.uri);
    if (file.exists) file.delete();
  } catch {
    // Best effort: an orphan in the app's private folder is harmless.
  }
}

/** A queue entry for a picked photo; `d` is the day the user confirmed. */
export function photoUploadFor(picked: PickedPhoto, day: string, now = Date.now()): PhotoUpload {
  return {
    hash: picked.ref.hash,
    ref: picked.ref,
    d: day,
    fileUri: picked.uri,
    createdAt: now,
  };
}
