import { effectiveRoutineIds, workoutDay } from '../../../frontend/src/lib/history';
import type { Profile, Routine, Workout } from '../training';
import { DEFAULT_REMINDER_TIME, TRAINING_REMINDER_WINDOW_DAYS } from './constants';
import { parseReminderTime } from './time';
import type { BuildTrainingRemindersOptions, TrainingReminderPreview } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TWO_NAMES = 2;

/** Local calendar day of an instant, without going through UTC. */
export function localIsoDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Whole calendar days from the local day of `now` to `iso`.
 *
 * Noon is used on both sides so a DST shift (23 or 25 hours) cannot turn the
 * day difference into zero or two. Returns `null` for an unreadable date.
 */
export function trainingReminderDayOffset(now: Date, iso: string): number | null {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(today.getTime()) || Number.isNaN(date.getTime())) return null;
  const offset = Math.round((date.getTime() - today.getTime()) / DAY_MS);
  return Number.isFinite(offset) ? offset : null;
}

function completedDaysOf(profile: Profile, extra: readonly string[] | undefined): Set<string> {
  const days = new Set<string>();
  for (const workout of profile.workouts ?? []) {
    if (!workout) continue;
    const day = workoutDay(workout);
    if (typeof day === 'string' && day) days.add(day);
  }
  for (const day of extra ?? []) {
    if (typeof day === 'string' && day) days.add(day);
  }
  return days;
}

function routineLabel(names: string[]): string {
  const labels = names.map(name => {
    const text = typeof name === 'string' ? name.trim() : '';
    return text || '未命名计划';
  });
  if (labels.length <= MAX_TWO_NAMES) return labels.join(' + ');
  return `${labels.length} 个计划`;
}

/**
 * Pure expansion of the current profile into future training-day reminders.
 *
 * Behaviour mirrors the upstream `buildReminderNotifications`:
 * - the window is at most 60 natural days starting today;
 * - a day with a completed workout (`profile.workouts`, plus `completedDays`) is skipped;
 * - a rest day (`effectiveRoutineIds` empty, including a `rest` day-plan override) is skipped;
 * - several routines on one day merge into a single reminder;
 * - `now` is asked for every day, exactly like upstream, so a coach-week session is
 *   reminded on each day until it is logged;
 * - the reminder is a local wall-clock time (`08:00` by default); a time that already
 *   passed today is not backfilled.
 *
 * `now` is injectable so the calendar boundary and the "already passed" rule are
 * deterministic in tests.
 */
export function buildTrainingReminders(
  profile: Profile,
  options: BuildTrainingRemindersOptions = {},
): TrainingReminderPreview[] {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) return [];

  const time = parseReminderTime(options.time ?? DEFAULT_REMINDER_TIME);
  if (!time) return [];

  const requestedWindow = options.windowDays ?? TRAINING_REMINDER_WINDOW_DAYS;
  const windowDays = Math.min(
    TRAINING_REMINDER_WINDOW_DAYS,
    Math.max(0, Math.trunc(Number.isFinite(requestedWindow) ? requestedWindow : TRAINING_REMINDER_WINDOW_DAYS)),
  );

  const routines: Routine[] = (Array.isArray(profile.routines) ? profile.routines : [])
    .filter((routine): routine is Routine => Boolean(routine));
  const state: Profile = {
    ...profile,
    routines,
    workouts: (profile.workouts ?? []).filter((workout): workout is Workout => Boolean(workout)),
    week: profile.week ?? {},
    dayPlan: profile.dayPlan ?? {},
  };
  const completed = completedDaysOf(state, options.completedDays);
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const reminders: TrainingReminderPreview[] = [];

  for (let offset = 0; offset < windowDays; offset++) {
    const day = new Date(base);
    day.setDate(base.getDate() + offset);
    const iso = localIsoDate(day);
    if (completed.has(iso)) continue;

    const planned: unknown = effectiveRoutineIds(state, iso, iso);
    const routineIds = (Array.isArray(planned) ? planned : [])
      .filter((id): id is string => typeof id === 'string');
    const dayRoutines = routineIds
      .map(id => routines.find(routine => routine.id === id))
      .filter((routine): routine is Routine => Boolean(routine));
    if (!dayRoutines.length) continue;

    const at = new Date(day);
    at.setHours(time.hour, time.minute, 0, 0);
    if (at.getTime() <= now.getTime()) continue;

    const label = routineLabel(dayRoutines.map(routine => routine.name));
    reminders.push({
      iso,
      at,
      title: '训练日',
      body: `今天有「${label}」，开始吧！`,
      routineIds: dayRoutines.map(routine => routine.id),
    });
  }

  return reminders;
}
