import { randomUUID } from 'expo-crypto';
import { chooseFixedWeek, refillIfComplete, saveRotation } from '../../frontend/src/lib/rotation';
import { deleteRoutine } from '../../frontend/src/lib/routines';
import { effectiveRoutines } from '../../frontend/src/lib/history';
import { inProfileUnit, localDate, unitOf, workoutKey, type CustomExercise, type EffortScale, type Profile, type Routine, type Unit, type Workout } from './training';

export type ProfileChange =
  | { kind: 'routine'; routine: Routine; create: true }
  | { kind: 'routine'; routine: Pick<Routine, 'id'> & Partial<Routine>; create: false }
  | { kind: 'deleteRoutine'; key: string }
  | { kind: 'custom'; exercise: CustomExercise; create: boolean }
  | { kind: 'workout'; key: string; patch: Partial<Workout>; unit: Unit }
  | { kind: 'effort'; effort: EffortScale }
  | { kind: 'settings'; values: Partial<Profile> }
  | { kind: 'week'; day: number; ids: string[]; onlyIfEmpty?: boolean }
  | { kind: 'rotation'; key: string; ids: string[]; at: number; onlyIfEmpty?: boolean };

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

export function applyChanges(profile: Profile, changes: readonly PendingChange[]) {
  return changes.reduce((state, { value: change }) => {
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
    }
  }, profile);
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
