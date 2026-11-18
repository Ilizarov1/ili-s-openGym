/** Shared, side-effect-free constants for the training reminder feature. */

/** Android channel of the training reminder. The rest timer keeps its own `rest-timer` channel. */
export const TRAINING_REMINDER_CHANNEL_ID = 'training-reminders';

/**
 * First Android notification identifier of the training reminder.
 *
 * The feature owns the contiguous range `[4000, 4060)`: the rest timer uses the
 * string identifier `open-gym-active-rest`, so cancelling this range never touches it.
 */
export const TRAINING_REMINDER_ID_BASE = 4000;

/** Upstream schedules at most 60 natural days ahead; the range cap matches that window. */
export const TRAINING_REMINDER_WINDOW_DAYS = 60;

/** Default local reminder time, the same as the Web/Capacitor client. */
export const DEFAULT_REMINDER_TIME = '08:00';

/** Scheduled notification identifier for a day offset inside the 60-day window. */
export function trainingReminderId(offset: number): string {
  return String(TRAINING_REMINDER_ID_BASE + offset);
}

/** Offset of one of this feature's identifiers, or `null` for any other notification. */
export function trainingReminderOffset(identifier: string): number | null {
  if (!/^\d+$/.test(identifier)) return null;
  const offset = Number(identifier) - TRAINING_REMINDER_ID_BASE;
  return Number.isInteger(offset) && offset >= 0 && offset < TRAINING_REMINDER_WINDOW_DAYS ? offset : null;
}

/** True for identifiers owned by the training reminder, never for the rest timer's. */
export function isTrainingReminderIdentifier(identifier: string): boolean {
  return trainingReminderOffset(identifier) !== null;
}
