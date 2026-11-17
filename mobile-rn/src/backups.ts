import { randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { shareAsync } from 'expo-sharing';
import { advanceRotation, applyChanges, prepareChanges, type ProfileChange } from './profileChanges';
import type { LocalState } from './storage';
import { inProfileUnit, localDate, unitOf, workoutKey, type Profile, type QueuedWorkout } from './training';

const MAX_BACKUP_BYTES = 20 * 1024 * 1024;

export function snapshotOf(data: LocalState): Profile {
  const profile = data.profile;
  const existing = new Set(profile.workouts?.filter(Boolean).map(workoutKey));
  return {
    unit: unitOf(profile), routines: profile.routines ?? [], customEx: profile.customEx ?? [],
    workouts: [...(profile.workouts ?? []).filter(Boolean), ...data.queue
      .filter(item => !existing.has(item.workout.id)).map(item => inProfileUnit(item, unitOf(profile)))]
      .filter(workout => !data.workoutDeletes?.[workoutKey(workout)]),
    week: profile.week, scheduleMode: profile.scheduleMode, rotation: profile.rotation,
  };
}

export async function exportBackup(data: LocalState) {
  const yesterday = Date.now() - 86400000;
  for (const entry of Paths.cache.list()) {
    if (entry instanceof File && /^openGym-\d{4}-\d{2}-\d{2}-[\da-f]{8}\.json$/.test(entry.name) &&
      (entry.modificationTime ?? Date.now()) < yesterday) entry.delete();
  }
  const file = new File(Paths.cache, `openGym-${localDate(Date.now())}-${randomUUID().slice(0, 8)}.json`);
  file.write(JSON.stringify(snapshotOf(data), null, 2));
  await shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: '导出训练备份' });
}

export async function pickBackup(): Promise<Profile | null> {
  const result = await DocumentPicker.getDocumentAsync({ type: 'application/json', copyToCacheDirectory: true });
  if (result.canceled) return null;
  const file = new File(result.assets[0].uri);
  try {
    if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件超过 20 MB。');
    const backup = JSON.parse(await file.text()) as Profile | null;
    if (!backup || typeof backup !== 'object' || !['workouts', 'routines', 'customEx'].some(key => Array.isArray(backup[key])) ||
      (backup.unit != null && backup.unit !== 'kg' && backup.unit !== 'lb') ||
      (backup.workouts != null && (!Array.isArray(backup.workouts) || backup.workouts.some(workout =>
        !workout || typeof workout.d !== 'string' || !Number.isFinite(workout.start) || !Number.isFinite(workout.end) ||
        (workout.id != null && typeof workout.id !== 'string') || !Array.isArray(workout.entries) ||
        workout.entries.some(entry => !entry || typeof entry.id !== 'string' || !Array.isArray(entry.sets) ||
          entry.sets.some(set => !set || typeof set !== 'object' || Array.isArray(set)))))) ||
      (backup.routines != null && (!Array.isArray(backup.routines) || backup.routines.some(routine =>
        !routine || typeof routine.id !== 'string' || typeof routine.name !== 'string' ||
        (routine.ex != null && (!Array.isArray(routine.ex) || routine.ex.some(exercise => !exercise || typeof exercise.id !== 'string')))))) ||
      (backup.customEx != null && (!Array.isArray(backup.customEx) || backup.customEx.some(exercise =>
        !exercise || typeof exercise.id !== 'string' || typeof (exercise.n ?? exercise.name) !== 'string')))) {
      throw new Error('请选择有效的 openGym JSON 备份。');
    }
    return backup;
  } finally {
    if (file.exists) file.delete();
  }
}

export function restoreBackup(data: LocalState, source: Profile, paired: boolean): LocalState {
  const profile = data.profile;
  const currentWorkouts = new Set(snapshotOf(data).workouts?.map(workoutKey));
  const currentRoutines = new Set(profile.routines?.filter(Boolean).map(routine => routine.id));
  const currentCustom = new Set(profile.customEx?.filter(Boolean).map(exercise => exercise.id));
  const currentDeletes = profile.deleted;
  const changes: ProfileChange[] = [];
  const unit = unitOf(source);
  const toUnit = unitOf(profile);
  const factor = unit === toUnit ? 1 : toUnit === 'kg' ? 0.45359237 : 1 / 0.45359237;
  for (const exercise of (source.customEx ?? []).filter(Boolean)) {
    if (currentCustom.has(exercise.id) || (currentDeletes?.customEx?.[exercise.id] ?? 0) > 0) continue;
    currentCustom.add(exercise.id);
    changes.push({ kind: 'custom', exercise, create: true });
  }
  for (const routine of (source.routines ?? []).filter(Boolean)) {
    if (currentRoutines.has(routine.id) || (currentDeletes?.routines?.[routine.id] ?? 0) > 0) continue;
    currentRoutines.add(routine.id);
    changes.push({ kind: 'routine', create: true, routine: factor === 1 ? routine : {
      ...routine, ex: routine.ex?.map(item => item.weight == null ? item : { ...item, weight: Math.round(item.weight * factor * 100) / 100 }),
    } });
  }
  for (let day = 0; day < 7; day++) {
    const incoming = source.week?.[day];
    if (!profile.week?.[day] && (typeof incoming === 'string' || Array.isArray(incoming))) {
      const ids = (typeof incoming === 'string' ? [incoming] : incoming).filter(id => currentRoutines.has(id));
      if (ids.length) changes.push({ kind: 'week', day, ids, onlyIfEmpty: true });
    }
  }
  if (!profile.rotation && source.scheduleMode === 'rotation' && Array.isArray(source.rotation?.sequence)) {
    const ids = source.rotation.sequence.filter(id => id === 'rest' || currentRoutines.has(id));
    if (ids.some(id => id !== 'rest')) changes.push({ kind: 'rotation', ids, key: randomUUID(), at: Date.now(), onlyIfEmpty: true });
  }
  const queue: QueuedWorkout[] = [];
  const restoredAt = Date.now();
  for (const workout of (source.workouts ?? []).filter(Boolean)) {
    const id = workoutKey(workout);
    if (currentWorkouts.has(id) || data.workoutDeletes?.[id] || (currentDeletes?.workouts?.[id] ?? 0) > 0) continue;
    currentWorkouts.add(id);
    queue.push({ unit, workout: { ...workout, id, _ts: Math.max(workout._ts ?? 0, (profile.resetAt ?? 0) + 1, restoredAt) } });
  }
  const prepared = prepareChanges(changes);
  const next = applyChanges(profile, prepared);
  if (paired) return { ...data, profile: next, changes: [...(data.changes ?? []), ...prepared], queue: [...data.queue, ...queue] };
  next.workouts = [...(profile.workouts ?? []), ...queue.map(item => inProfileUnit(item, toUnit))];
  return { ...data, profile: advanceRotation(next, Date.now()) };
}
