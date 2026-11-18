/** A future training day, before it becomes a scheduled notification. */
export type TrainingReminderPreview = {
  /** Local calendar day, `YYYY-MM-DD`. */
  iso: string;
  /** Local calendar date and reminder time as an instant. */
  at: Date;
  title: string;
  body: string;
  /** Routines planned for that day, in merge order. */
  routineIds: string[];
};

export type BuildTrainingRemindersOptions = {
  /** Injectable clock so the 60-day window is deterministic in tests. */
  now?: Date;
  /** Local `HH:MM`; defaults to `08:00`. */
  time?: string;
  /** Defaults to 60 and is capped at 60. */
  windowDays?: number;
  /**
   * Extra completed days. `profile.workouts` already covers synced history; the caller
   * passes locally queued (not yet synced) workout days here.
   */
  completedDays?: readonly string[];
};

/** Notification permission as shown in the reminder settings screen. */
export type TrainingReminderPermission = 'granted' | 'denied' | 'undetermined';

/**
 * Android exact-alarm access.
 *
 * Expo Notifications does not expose `AlarmManager.canScheduleExactAlarms()`, so on
 * Android 12+ the value is `unknown` unless a caller injects a platform check. `denied`
 * and `unknown` both mean "may be delayed" in the UI.
 */
export type ExactAlarmStatus = 'granted' | 'denied' | 'unknown';

export type TrainingReminderSyncOptions = {
  enabled: boolean;
  /** Local `HH:MM`; defaults to `08:00`. */
  time?: string;
  /** Only the settings toggle may pass `true`: a background resync never prompts. */
  interactive?: boolean;
  /**
   * Current workspace key (`server|user` or `practice`). Stored on each scheduled
   * notification so another workspace's stale reminder is replaced.
   */
  workspace?: string;
  /** Injectable clock for deterministic tests. */
  now?: Date;
  /** Extra completed days, e.g. locally queued workouts. */
  completedDays?: readonly string[];
  /**
   * Known Android exact-alarm state. When omitted the module reads what Expo
   * exposes (Android 12+ is `unknown`); a native checker can inject the real value.
   */
  exactAlarm?: ExactAlarmStatus;
  /**
   * Replace even matching scheduled notifications. Used after the "Alarms &
   * reminders" page was opened, because an alarm scheduled without exact access
   * stays inexact otherwise.
   */
  force?: boolean;
};

export type TrainingReminderSyncResult = {
  /** Number of training reminders scheduled for the current 60-day window. */
  scheduled: number;
  permission: TrainingReminderPermission;
  exactAlarm: ExactAlarmStatus;
  error?: string;
};
