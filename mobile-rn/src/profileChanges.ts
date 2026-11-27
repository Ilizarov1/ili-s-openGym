import { randomUUID } from 'expo-crypto';
import { chooseFixedWeek, refillIfComplete, saveRotation } from '../../frontend/src/lib/rotation';
import { deleteRoutine } from '../../frontend/src/lib/routines';
import { effectiveRoutines } from '../../frontend/src/lib/history';
import { addWeighIn, dailyModeOf, editWeighIn, readingsOf, removeWeighIn } from '../../frontend/src/lib/weigh-ins.js';
import { normalizeMediaRef, workoutMediaOf } from '../../frontend/src/lib/media-refs.js';
import { readDayPhoto } from '../../frontend/src/lib/day-photos.js';
import { measurementValue } from '../../frontend/src/lib/measurements.js';
import {
  applyCoachChatAppend,
  applyCoachChatClear,
  applyCoachProposal,
  applyCoachProposalApplied,
  guardClearedChat,
  revertLastCoachChanges,
  type CoachApplyMeta,
} from './agent/coach-bridge';
import { inProfileUnit, localDate, unitOf, workoutKey, type CoachChatMessage, type CoachProposalChange, type CustomExercise, type DayPhotoEntry, type EffortScale, type MeasurementEntry, type MediaRefLike, type Profile, type Routine, type Unit, type Workout } from './training';

export type ProfileChange =
  | { kind: 'routine'; routine: Routine; create: true }
  | { kind: 'routine'; routine: Pick<Routine, 'id'> & Partial<Routine>; create: false }
  | { kind: 'deleteRoutine'; key: string }
  | { kind: 'custom'; exercise: CustomExercise; create: boolean }
  | { kind: 'favorite'; id: string; fav: boolean }
  | { kind: 'workout'; key: string; patch: Partial<Workout>; unit: Unit }
  | { kind: 'effort'; effort: EffortScale }
  | { kind: 'settings'; values: Partial<Profile> }
  | { kind: 'week'; day: number; ids: string[]; onlyIfEmpty?: boolean }
  | { kind: 'dayPlan'; day: string; id: string | null }
  | { kind: 'rotation'; key: string; ids: string[]; at: number; onlyIfEmpty?: boolean }
  // Progress & body data (P2). Each intent names the reading/day/photo it changes and is
  // replayed on the freshest profile, so it never replaces a whole synced array.
  | { kind: 'weighIn'; action: 'add'; d: string; at: string | null; w: number; id: string; t: number; unit: Unit }
  | { kind: 'weighIn'; action: 'edit'; d: string; id: string; to: string; at: string | null; w: number; t: number; unit: Unit }
  | { kind: 'weighIn'; action: 'remove'; d: string; id: string; t: number }
  | { kind: 'measurement'; d: string; values: Record<string, number | null>; base: Record<string, number | null>; t: number }
  | { kind: 'measurement'; d: string; remove: true; t: number }
  | { kind: 'dayPhoto'; d: string; ref: MediaRefLike; t: number }
  | { kind: 'dayPhoto'; hash: string; remove: true; t: number }
  | { kind: 'workoutMedia'; key: string; ref: MediaRefLike; t: number }
  | { kind: 'workoutMedia'; key: string; hash: string; remove: true; t: number }
  // AI Coach intents. Each is a replayable statement about the synced `coach` namespace, not a
  // whole-value replacement, so a phone's "New conversation" and a proposal apply survive a
  // round-trip through `/api/data` (L-010).
  | { kind: 'coachChatAppend'; message: CoachChatMessage }
  | { kind: 'coachChatClear'; at: number }
  | { kind: 'coachProposalApplied'; messageId: string; nodeId: string }
  | { kind: 'coachApplyProposal'; changes: CoachProposalChange[]; meta: CoachApplyMeta }
  | { kind: 'coachRevertLast'; at?: number };

export type PendingChange = { id: string; value: ProfileChange };
export const prepareChanges = (values: ProfileChange[]): PendingChange[] =>
  values.map(value => ({ id: randomUUID(), value }));

function editablePlan(profile: Profile) {
  return {
    ...profile,
    routines: (profile.routines ?? []).filter(Boolean),
    week: { ...profile.week },
    dayPlan: { ...profile.dayPlan },
  };
}

function insert<T extends { id: string }>(items: T[] = [], value: T) {
  return items.some(item => item?.id === value.id) ? items : [...items, value];
}

function edit<T extends { id: string }>(items: T[] = [], value: Pick<T, 'id'> & Partial<T>) {
  return items.map(item => item?.id === value.id ? { ...item, ...value } : item);
}

type DeletedMaps = NonNullable<Profile['deleted']> & {
  bodyweight?: Record<string, number>;
};

type AddReadingInput = {
  d: string;
  at?: string | null;
  w: number;
  t?: number;
  id?: string;
  src?: string;
  sid?: string;
};

type EditReadingInput = { d?: string; at?: string | null; w?: number };

/** The upstream JS module's narrow inferred parameter types do not name these fields; keep one
 * typed view of the same functions so the change replay can pass its explicit values. */
const weighInApi = {
  add: addWeighIn as unknown as (state: Profile, input: AddReadingInput, mode?: string) => unknown,
  edit: editWeighIn as unknown as (
    state: Profile,
    d: string,
    id: string,
    input: EditReadingInput,
    now?: number,
    mode?: string,
  ) => unknown,
  remove: removeWeighIn as unknown as (
    state: Profile,
    d: string,
    id: string,
    now?: number,
    mode?: string,
  ) => unknown,
};

function deletedMaps(profile: Profile): DeletedMaps {
  return { ...(profile.deleted ?? {}) } as DeletedMaps;
}

/**
 * Existing Web convention: a positive stamp is when the entry was removed, a negative one when
 * it was added back. `back` only writes when there is a removal to undo.
 */
function withDeletion(
  profile: Profile,
  field: 'bodyweight' | 'measurements',
  key: string,
  at: number,
  mode: 'gone' | 'back',
) {
  const deleted = deletedMaps(profile);
  const current = deleted[field]?.[key];
  if (mode === 'back' && !(typeof current === 'number' && current > 0)) return profile;
  if (mode === 'gone' && typeof current === 'number' && current >= at) return profile;
  const value = mode === 'gone'
    ? Math.max(at, Math.abs(current ?? 0) + 1)
    : -Math.max(at, Math.abs(current ?? 0) + 1);
  return {
    ...profile,
    deleted: { ...deleted, [field]: { ...deleted[field], [key]: value } },
  };
}

function weightInUnit(value: number, from: Unit, to: Unit) {
  if (from === to) return Math.round(value * 10) / 10;
  const converted = from === 'kg' ? value / 0.45359237 : value * 0.45359237;
  return Math.round(converted * 10) / 10;
}

function bodyweightCopy(profile: Profile): Profile {
  return {
    ...profile,
    bodyweight: (profile.bodyweight ?? []).filter(Boolean).map(day => ({
      ...day,
      ...(Array.isArray(day.ins) ? { ins: day.ins.map(reading => ({ ...reading })) } : {}),
      ...(day.gone ? { gone: { ...day.gone } } : {}),
    })),
  };
}

function applyWeighInChange(state: Profile, change: Extract<ProfileChange, { kind: 'weighIn' }>): Profile {
  const unit = unitOf(state);
  const mode = dailyModeOf(state);
  const days = state.bodyweight ?? [];

  if (change.action === 'add') {
    const existing = days
      .filter(day => day?.d === change.d)
      .flatMap(day => readingsOf(day) as { id: string; t?: number }[])
      .find(reading => String(reading.id) === change.id);
    if (existing && Number(existing.t) > change.t) return state;
    const next = bodyweightCopy(state);
    const reading = weighInApi.add(next, {
      d: change.d,
      at: change.at,
      w: weightInUnit(change.w, change.unit, unit),
      t: change.t,
      id: change.id,
    }, mode);
    return reading ? withDeletion(next, 'bodyweight', change.d, change.t, 'back') : state;
  }

  if (change.action === 'edit') {
    const day = days.find(item => item?.d === change.d);
    const old = day ? (readingsOf(day) as { id: string; t?: number }[]).find(reading => String(reading.id) === change.id) : null;
    if (!old) return state;
    // A reading edited later on another device wins over this offline correction.
    if (Number(old.t) > change.t) return state;
    const next = bodyweightCopy(state);
    const result = weighInApi.edit(next, change.d, change.id, {
      d: change.to,
      at: change.at,
      w: weightInUnit(change.w, change.unit, unit),
    }, change.t, mode);
    if (!result) return state;
    if (change.to === change.d) return withDeletion(next, 'bodyweight', change.d, change.t, 'back');
    const oldDayGone = !(next.bodyweight ?? []).some(item => item?.d === change.d);
    const stamped = oldDayGone
      ? withDeletion(next, 'bodyweight', change.d, Math.max(change.t, Number(day?.t) + 1 || 0), 'gone')
      : next;
    return withDeletion(stamped, 'bodyweight', change.to, change.t, 'back');
  }

  const day = days.find(item => item?.d === change.d);
  const reading = day ? (readingsOf(day) as { id: string; t?: number }[]).find(item => String(item.id) === change.id) : null;
  if (!day || !reading) return state;
  if (Number(reading.t) > change.t) return state;
  const count = (readingsOf(day) as unknown[]).length;
  if (count > 1) {
    const next = bodyweightCopy(state);
    weighInApi.remove(next, change.d, change.id, change.t, mode);
    return next;
  }
  // The last reading deletes the day itself, recorded with the same `deleted.bodyweight`
  // semantics the Web store uses.
  const next = { ...state, bodyweight: days.filter(item => item?.d !== change.d) };
  return withDeletion(next, 'bodyweight', change.d, Math.max(change.t, Number(day.t) + 1 || 0), 'gone');
}

function applyMeasurementChange(state: Profile, change: Extract<ProfileChange, { kind: 'measurement' }>): Profile {
  const entries = (state.measurements ?? []).filter(Boolean);
  const existing = entries.find(entry => entry?.d === change.d);
  if ('remove' in change) {
    if (!existing) return state;
    if (Number(existing.t) > change.t) return state;
    const at = Math.max(change.t, Number(existing.t) + 1 || 0);
    const next = { ...state, measurements: entries.filter(entry => entry?.d !== change.d) };
    return withDeletion(next, 'measurements', change.d, at, 'gone');
  }

  const entry: MeasurementEntry = existing
    ? {
      ...existing,
      ...(Array.isArray(existing.other) ? { other: existing.other.map(row => ({ ...row })) } : {}),
    }
    : { d: change.d, t: change.t };
  let touched = false;
  for (const [key, value] of Object.entries(change.values)) {
    const base = change.base[key] ?? null;
    const current = existing ? measurementValue(existing, key) as number | null : null;
    // A field another device changed since this form was opened stays that device's.
    if (current !== base) continue;
    if (key.startsWith('other:')) {
      const id = key.slice(6);
      const rows = entry.other ?? [];
      const at = rows.findIndex(row => row.id === id);
      if (at < 0) continue;
      const rowsCopy = rows.map(row => ({ ...row }));
      rowsCopy[at] = { ...rowsCopy[at], value };
      entry.other = rowsCopy;
    } else if (value == null) {
      delete entry[key];
    } else {
      entry[key] = value;
    }
    touched = true;
  }
  if (!touched) return state;
  entry.t = existing && Number(existing.t) > change.t ? Number(existing.t) + 1 : change.t;
  const next = {
    ...state,
    measurements: [...entries.filter(item => item?.d !== change.d), entry].sort((a, b) => a.d.localeCompare(b.d)),
  };
  return withDeletion(next, 'measurements', change.d, change.t, 'back');
}

function applyDayPhotoChange(
  state: Profile,
  change: Extract<ProfileChange, { kind: 'dayPhoto' }>,
): Profile {
  const map: Record<string, DayPhotoEntry> = { ...(state.dayPhotos ?? {}) };
  if ('remove' in change) {
    const current = readDayPhoto(map[change.hash]) as { d: string; m: MediaRefLike } | null;
    if (!current) return state;
    const previous = Number(map[change.hash]?._ts) || 0;
    if (previous > change.t) return state;
    return {
      ...state,
      dayPhotos: {
        ...map,
        [change.hash]: { _ts: Math.max(change.t, previous + 1) },
      },
    };
  }
  const ref = normalizeMediaRef(change.ref) as MediaRefLike | null;
  if (!ref) return state;
  if (readDayPhoto(map[ref.hash])) return state;
  const previous = Number(map[ref.hash]?._ts) || 0;
  if (previous > change.t) return state;
  return {
    ...state,
    dayPhotos: {
      ...map,
      [ref.hash]: { d: change.d, m: ref, _ts: Math.max(change.t, previous + 1) },
    },
  };
}

function applyWorkoutMediaChange(
  state: Profile,
  change: Extract<ProfileChange, { kind: 'workoutMedia' }>,
): Profile {
  const workouts = (state.workouts ?? []).filter(Boolean);
  const index = workouts.findIndex(workout => workoutKey(workout) === change.key);
  if (index < 0) return state;
  const workout = workouts[index];
  const raw = Array.isArray(workout.media) ? [...workout.media] : [];
  const stamp = Math.max(change.t, Number(workout._ts) + 1 || 0);

  if ('remove' in change) {
    const left = raw.filter(ref => ref?.hash !== change.hash);
    if (left.length === raw.length) return state;
    const { media: _media, ...rest } = workout;
    const updated = left.length
      ? { ...workout, media: left, _ts: stamp }
      : { ...rest, _ts: stamp };
    return { ...state, workouts: workouts.map((item, at) => at === index ? updated : item) };
  }

  const ref = normalizeMediaRef(change.ref) as MediaRefLike | null;
  if (!ref) return state;
  if (raw.some(item => item?.hash === ref.hash)) return state;
  if (workoutMediaOf(workout).length >= 6) return state;
  const updated = { ...workout, media: [...raw, ref], _ts: stamp };
  return { ...state, workouts: workouts.map((item, at) => at === index ? updated : item) };
}

export function applyChanges(profile: Profile, changes: readonly PendingChange[]) {
  const next = changes.reduce((state, { id, value: change }) => {
    switch (change.kind) {
      case 'routine':
        if (change.create && (state.deleted?.routines?.[change.routine.id] ?? 0) > 0) return state;
        return { ...state, routines: change.create ? insert(state.routines, change.routine) : edit(state.routines, change.routine) };
      case 'deleteRoutine': {
        const next = editablePlan(state);
        deleteRoutine(next, change.key);
        if (next.rotation?.sequence.includes(change.key)) {
          const sequence = next.rotation.sequence.filter(id => id !== change.key);
          next.rotation = sequence.some(id => next.routines.some(routine => routine.id === id))
            ? { ...next.rotation, sequence, at: 0 } : null;
        }
        if (next.queue?.ids.includes(change.key)) {
          const ids = next.queue.ids.filter(id => id !== change.key);
          next.queue = ids.length ? { ...next.queue, ids } : null;
        }
        return next;
      }
      case 'custom':
        if (change.create && (state.deleted?.customEx?.[change.exercise.id] ?? 0) > 0) return state;
        return { ...state, customEx: change.create ? insert(state.customEx, change.exercise) : edit(state.customEx, change.exercise) };
      case 'favorite': {
        if (!change.id) return state;
        const list = Array.isArray(state.favEx) ? state.favEx.filter(id => typeof id === 'string') : [];
        const has = list.includes(change.id);
        if (change.fav === has) return state;
        // One exercise at a time, always against the latest state: a replay over
        // another device's copy adds or removes only this id and keeps the rest.
        return { ...state, favEx: change.fav ? [...list, change.id] : list.filter(id => id !== change.id) };
      }
      case 'workout':
        return { ...state, workouts: state.workouts?.map(workout => {
          if (!workout || workoutKey(workout) !== change.key) return workout;
          const { entries, vol, ...details } = change.patch;
          const id = workout.id ?? change.key;
          const converted = entries ? inProfileUnit({ unit: change.unit, workout: { ...workout, id, entries, vol } }, unitOf(state)) : null;
          return { ...workout, ...details, id, ...(converted ? { entries: converted.entries, vol: converted.vol } : {}) };
        }) };
      case 'effort': {
        // Only the preference changes. History keeps whatever scale each row was
        // saved in, and an old `showRir` is dropped so the explicit answer wins.
        // Choosing a scale also lifts a synced web profile's Effort module switch:
        // without that the row would look dead on this device.
        const next = { ...state, effort: change.effort };
        delete next.showRir;
        if (change.effort !== 'none') {
          const modules = state.modules && typeof state.modules === 'object' && !Array.isArray(state.modules)
            ? state.modules : {};
          next.modules = { ...modules, effort: true };
        }
        return next;
      }
      case 'settings':
        return { ...state, ...change.values };
      case 'week': {
        if (change.onlyIfEmpty && state.week?.[String(change.day)]) return state;
        const next = editablePlan(state);
        const ids = change.ids.filter(id => next.routines.some(routine => routine.id === id));
        if (ids.length) next.week[String(change.day)] = ids;
        else delete next.week[String(change.day)];
        return next;
      }
      case 'dayPlan': {
        const next = editablePlan(state);
        if (change.id == null) delete next.dayPlan[change.day];
        else if (change.id === 'rest' || next.routines.some(routine => routine.id === change.id)) {
          next.dayPlan[change.day] = change.id;
        } else {
          delete next.dayPlan[change.day];
        }
        return next;
      }
      case 'rotation': {
        if (change.onlyIfEmpty && state.rotation) return state;
        const next = editablePlan(state);
        const ids = change.ids.filter(id => id === 'rest' || next.routines.some(routine => routine.id === id));
        const day = localDate(change.at);
        if (!ids.some(id => id !== 'rest')) {
          chooseFixedWeek(next, day);
          return next;
        }
        next.scheduleMode = 'rotation';
        next.rotation ??= { id: change.key, sequence: [], label: '' };
        saveRotation(next, ids, next.rotation.label, day, change.at);
        return next;
      }
      case 'weighIn':
        return applyWeighInChange(state, change);
      case 'measurement':
        return applyMeasurementChange(state, change);
      case 'dayPhoto':
        return applyDayPhotoChange(state, change);
      case 'workoutMedia':
        return applyWorkoutMediaChange(state, change);
      case 'coachChatAppend':
        return applyCoachChatAppend(state, change.message);
      case 'coachChatClear':
        return applyCoachChatClear(state, change.at);
      case 'coachProposalApplied':
        return applyCoachProposalApplied(state, { messageId: change.messageId, nodeId: change.nodeId });
      case 'coachApplyProposal':
        // The pending-change id makes a replay after a lost PUT acknowledgement a no-op.
        return applyCoachProposal(state, change.changes, { ...change.meta, intentId: id }).profile;
      case 'coachRevertLast':
        return revertLastCoachChanges(state, {
          ...(change.at != null ? { now: change.at } : {}),
          intentId: id,
        }).profile;
    }
  }, profile);
  // One last watermark guard on every local/server replay: a `settings` patch or an older
  // remote copy can never lower `chatClearedAt` or bring cleared lines back (L-010).
  return guardClearedChat(next, Number(profile.coach?.chatClearedAt) || 0);
}

export function recommendedRoutines(profile: Profile, pending: readonly Workout[] = []): Routine[] {
  const state = editablePlan({ ...profile, workouts: [...(profile.workouts ?? []), ...pending].filter(Boolean) });
  const day = localDate(Date.now());
  refillIfComplete(state, day);
  return effectiveRoutines(state, day);
}

export function advanceRotation(profile: Profile, at: number): Profile {
  if (!profile.queue?.rotationId || profile.queue.rotationId !== profile.rotation?.id) return profile;
  const next = editablePlan(profile);
  return refillIfComplete(next, localDate(at), at) ? next : profile;
}
