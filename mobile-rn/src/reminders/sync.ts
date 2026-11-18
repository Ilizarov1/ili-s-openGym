import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';
import type { Profile } from '../training';
import {
  DEFAULT_REMINDER_TIME,
  TRAINING_REMINDER_CHANNEL_ID,
  TRAINING_REMINDER_WINDOW_DAYS,
  trainingReminderId,
  trainingReminderOffset,
} from './constants';
import { buildTrainingReminders, trainingReminderDayOffset } from './schedule';
import { parseReminderTime, reminderTimeText } from './time';
import type {
  ExactAlarmStatus,
  TrainingReminderPermission,
  TrainingReminderPreview,
  TrainingReminderSyncOptions,
  TrainingReminderSyncResult,
} from './types';

export const EXACT_ALARM_SETTINGS_ACTION = 'android.settings.REQUEST_SCHEDULE_EXACT_ALARM';

/** Set when the user leaves for the exact-alarm settings; cleared by a successful resync. */
let rescheduleAfterSettings = false;
/**
 * The first enabled sync after a cold start replaces matching alarms once. An alarm
 * scheduled while exact access was missing stays inexact, and app restart is the
 * point where that can be repaired without rebuilding the queue on every state edit.
 */
let firstSync = true;

type ScheduledTrainingReminder = {
  identifier: string;
  offset: number;
  at: number | null;
  title: string | null;
  body: string | null;
  iso: string | null;
  workspace: string | null;
  channelId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function triggerTime(trigger: unknown): number | null {
  if (typeof trigger === 'number') return Number.isFinite(trigger) ? trigger : null;
  if (typeof trigger === 'string') {
    const parsed = Date.parse(trigger);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (trigger instanceof Date) return trigger.getTime();
  const record = asRecord(trigger);
  for (const key of ['value', 'timestamp', 'date']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (value instanceof Date) return value.getTime();
  }
  return null;
}

function triggerChannelId(trigger: unknown): string | null {
  const value = asRecord(trigger).channelId;
  return typeof value === 'string' ? value : null;
}

function permissionOf(status: Notifications.NotificationPermissionsStatus): TrainingReminderPermission {
  if (status.granted) return 'granted';
  return status.status === 'denied' ? 'denied' : 'undetermined';
}

/**
 * Current notification permission. The permission request is made only when
 * `interactive` is true, i.e. from the settings toggle; background resyncs never
 * open a system dialog.
 */
async function resolvePermission(interactive: boolean): Promise<TrainingReminderPermission> {
  try {
    let permission = permissionOf(await Notifications.getPermissionsAsync());
    if (permission !== 'granted' && interactive) {
      permission = permissionOf(await Notifications.requestPermissionsAsync());
    }
    return permission;
  } catch {
    return 'undetermined';
  }
}

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(TRAINING_REMINDER_CHANNEL_ID, {
    name: '训练提醒',
    description: '按训练计划在训练日提醒',
    importance: Notifications.AndroidImportance.DEFAULT,
    enableVibrate: true,
    vibrationPattern: [0, 180, 120, 180],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

async function removeChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.deleteNotificationChannelAsync(TRAINING_REMINDER_CHANNEL_ID);
  } catch {
    // The channel is already gone, or this build does not expose deletion.
  }
}

async function readScheduledTrainingReminders(): Promise<ScheduledTrainingReminder[] | null> {
  try {
    const requests = await Notifications.getAllScheduledNotificationsAsync();
    return requests.flatMap(request => {
      const offset = trainingReminderOffset(request.identifier);
      if (offset === null) return [];
      const data = request.content.data ?? {};
      return [{
        identifier: request.identifier,
        offset,
        at: triggerTime(request.trigger),
        title: request.content.title,
        body: request.content.body,
        iso: typeof data.iso === 'string' ? data.iso : null,
        workspace: typeof data.workspace === 'string' ? data.workspace : null,
        channelId: triggerChannelId(request.trigger),
      }];
    });
  } catch {
    return null;
  }
}

function sameReminder(
  current: ScheduledTrainingReminder,
  desired: TrainingReminderPreview,
  workspace: string | undefined,
): boolean {
  if (current.at === null || Math.abs(current.at - desired.at.getTime()) >= 1000) return false;
  if (current.title !== desired.title || current.body !== desired.body) return false;
  if (current.iso !== desired.iso) return false;
  if (workspace !== undefined && current.workspace !== workspace) return false;
  if (Platform.OS === 'android' && current.channelId !== TRAINING_REMINDER_CHANNEL_ID) return false;
  return true;
}

/**
 * Cancel only the training reminder's own identifier range.
 *
 * The rest timer's `open-gym-active-rest` notification is outside the numeric range,
 * so it keeps running. `removeChannel` is used when the feature is turned off: it
 * deletes `training-reminders` and leaves `rest-timer` untouched.
 */
export async function cancelTrainingReminders(options: { removeChannel?: boolean } = {}): Promise<void> {
  const cancellations: Promise<void>[] = [];
  for (let offset = 0; offset < TRAINING_REMINDER_WINDOW_DAYS; offset++) {
    cancellations.push(Notifications.cancelScheduledNotificationAsync(trainingReminderId(offset)).catch(() => undefined));
  }
  await Promise.all(cancellations);
  if (options.removeChannel) await removeChannel();
}

/**
 * Android exact-alarm access.
 *
 * `expo-notifications` falls back to an inexact alarm when
 * `AlarmManager.canScheduleExactAlarms()` is false, and does not expose that
 * check to JS. Android 12+ is therefore reported as `unknown` so the UI says
 * "可能延迟" and offers the system settings entry; a future native check can
 * pass `denied`/`granted` without changing the screen contract.
 */
export function readExactAlarmStatus(
  platform: string = Platform.OS,
  version: number | string = Platform.Version,
): ExactAlarmStatus {
  if (platform !== 'android') return 'granted';
  const api = Number(version);
  return Number.isFinite(api) && api < 31 ? 'granted' : 'unknown';
}

/** Open the system "Alarms & reminders" page, falling back to app settings. */
export async function openExactAlarmSettings(): Promise<void> {
  // The next sync must replace the queued alarms: one scheduled while exact access
  // was missing stays inexact even after the system permission is granted.
  rescheduleAfterSettings = true;
  if (Platform.OS !== 'android') {
    await Linking.openSettings();
    return;
  }
  try {
    await Linking.sendIntent(EXACT_ALARM_SETTINGS_ACTION);
  } catch {
    await Linking.openSettings();
  }
}

async function performSync(
  profile: Profile,
  options: TrainingReminderSyncOptions,
): Promise<TrainingReminderSyncResult> {
  const exactAlarm = options.exactAlarm ?? readExactAlarmStatus();
  let permission: TrainingReminderPermission = 'undetermined';

  try {
    if (!options.enabled) {
      permission = await resolvePermission(false);
      await cancelTrainingReminders({ removeChannel: true });
      return { scheduled: 0, permission, exactAlarm };
    }

    const rawTime = (options.time ?? '').trim() || DEFAULT_REMINDER_TIME;
    const parsedTime = parseReminderTime(rawTime);
    if (!parsedTime) {
      permission = await resolvePermission(false);
      await cancelTrainingReminders();
      return {
        scheduled: 0,
        permission,
        exactAlarm,
        error: '提醒时刻格式不正确，请使用 24 小时制，例如 08:00。',
      };
    }
    const time = reminderTimeText(parsedTime.hour, parsedTime.minute);

    permission = await resolvePermission(options.interactive === true);
    if (permission !== 'granted') {
      await cancelTrainingReminders();
      return {
        scheduled: 0,
        permission,
        exactAlarm,
        error: permission === 'denied'
          ? '系统通知权限未开启，无法安排训练提醒。'
          : '需要通知权限才能安排训练提醒。',
      };
    }

    await ensureChannel();

    const now = options.now ?? new Date();
    const expected = buildTrainingReminders(profile, {
      now,
      time,
      windowDays: TRAINING_REMINDER_WINDOW_DAYS,
      completedDays: options.completedDays,
    });
    const expectedById = new Map<string, TrainingReminderPreview>();
    for (const reminder of expected) {
      const offset = trainingReminderDayOffset(now, reminder.iso);
      if (offset === null || offset < 0 || offset >= TRAINING_REMINDER_WINDOW_DAYS) continue;
      expectedById.set(trainingReminderId(offset), reminder);
    }

    const existing = await readScheduledTrainingReminders();
    if (existing === null) await cancelTrainingReminders();
    const existingById = new Map((existing ?? []).map(item => [item.identifier, item]));

    // Reconcile instead of cancelling everything: a matching reminder is left alone,
    // only a changed one is replaced (same identifier) and a stale one is cancelled.
    // `force` replaces matching items too, upgrading alarms after exact access changed.
    const force = options.force === true || rescheduleAfterSettings || firstSync;
    let scheduled = 0;
    let failure = '';
    for (const [identifier, reminder] of expectedById) {
      const current = existingById.get(identifier);
      if (current && !force && sameReminder(current, reminder, options.workspace)) {
        scheduled++;
        continue;
      }
      try {
        if (current) await Notifications.cancelScheduledNotificationAsync(identifier);
        await Notifications.scheduleNotificationAsync({
          identifier,
          content: {
            title: reminder.title,
            body: reminder.body,
            data: {
              kind: 'training-reminder',
              iso: reminder.iso,
              workspace: options.workspace ?? '',
            },
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DATE,
            date: reminder.at.getTime(),
            channelId: TRAINING_REMINDER_CHANNEL_ID,
          },
        });
        scheduled++;
      } catch {
        failure = '无法安排全部训练提醒，请检查 Android 通知和闹钟设置。';
      }
    }

    for (const current of existing ?? []) {
      if (expectedById.has(current.identifier)) continue;
      try {
        await Notifications.cancelScheduledNotificationAsync(current.identifier);
      } catch {
        // A stale item that cannot be cancelled is retried on the next sync.
      }
    }

    if (force && !failure) {
      rescheduleAfterSettings = false;
      firstSync = false;
    }

    return {
      scheduled,
      permission,
      exactAlarm,
      ...(failure ? { error: failure } : {}),
    };
  } catch {
    return {
      scheduled: 0,
      permission,
      exactAlarm,
      error: '无法更新训练提醒，请检查 Android 通知设置。',
    };
  }
}

let operations: Promise<void> = Promise.resolve();

/**
 * Reconcile the notification queue with the current profile and preference.
 *
 * Calls are serialized so a background resync and an interactive toggle cannot
 * interleave their read/cancel/schedule steps. Only this feature's identifiers
 * and channel are touched.
 */
export function syncTrainingReminders(
  profile: Profile,
  options: TrainingReminderSyncOptions,
): Promise<TrainingReminderSyncResult> {
  const run = operations.then(
    () => performSync(profile, options),
    () => performSync(profile, options),
  );
  operations = run.then(() => undefined, () => undefined);
  return run;
}
