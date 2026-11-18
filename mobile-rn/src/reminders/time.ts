import { DEFAULT_REMINDER_TIME } from './constants';

export type ReminderTime = { hour: number; minute: number };

const TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

/** Strict local `H:MM` / `HH:MM` reader. Anything malformed returns `null`. */
export function parseReminderTime(value: string | undefined | null): ReminderTime | null {
  const match = TIME_PATTERN.exec((value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Canonical `HH:MM`, used for storage and notification identifiers. */
export function reminderTimeText(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Canonical `HH:MM`, or the fallback (default `08:00`) when the input is unreadable. */
export function normalizeReminderTime(
  value: string | undefined | null,
  fallback: string = DEFAULT_REMINDER_TIME,
): string {
  const parsed = parseReminderTime(value);
  return parsed ? reminderTimeText(parsed.hour, parsed.minute) : fallback;
}

/** Local clock of a scheduled instant, e.g. `08:00`. */
export function reminderClock(at: Date): string {
  return reminderTimeText(at.getHours(), at.getMinutes());
}
