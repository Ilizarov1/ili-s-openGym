import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { Profile } from '../training';
import { buildTrainingReminders } from './schedule';
import { normalizeReminderTime } from './time';
import { syncTrainingReminders } from './sync';
import type { ExactAlarmStatus, TrainingReminderPreview, TrainingReminderSyncResult } from './types';

export type TrainingReminderSyncSettings = {
  enabled: boolean;
  time: string;
  /** `server|user` or `practice`; tagged on every scheduled notification. */
  workspace: string;
  /** Locally queued workout days that are not in `profile.workouts` yet. */
  completedDays?: readonly string[];
  /** Optional known exact-alarm state, when a native check is available. */
  exactAlarm?: ExactAlarmStatus;
};

export type TrainingReminderSyncState = {
  result: TrainingReminderSyncResult | null;
  /** Future training days for the settings preview, recomputed with every resync. */
  next: TrainingReminderPreview[];
  syncing: boolean;
  /** Re-run the queue now. Only the settings toggle passes `true`. */
  refresh: (interactive?: boolean) => Promise<void>;
};

const TIMEZONE_POLL_MS = 30_000;

/**
 * Keep the scheduled queue in step with the profile and preference.
 *
 * Recomputes on:
 * - profile changes (plan edit, server sync, finished workout in practice mode);
 * - the enabled flag or reminder time;
 * - the workspace key (account switch);
 * - foreground resume (`AppState`);
 * - a local timezone offset change or a new local day while the app stays open.
 *
 * Every resync is non-interactive: only an explicit `refresh(true)` from the
 * settings toggle may show the system permission dialog.
 */
export function useTrainingReminderSync(
  profile: Profile | null | undefined,
  settings: TrainingReminderSyncSettings,
): TrainingReminderSyncState {
  const [result, setResult] = useState<TrainingReminderSyncResult | null>(null);
  const [next, setNext] = useState<TrainingReminderPreview[]>([]);
  const [syncing, setSyncing] = useState(false);
  const latest = useRef({ profile, settings });
  const mounted = useRef(true);
  const sequence = useRef(0);

  useEffect(() => {
    latest.current = { profile, settings };
  });

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback((interactive = false): Promise<void> => {
    const current = latest.current;
    if (!current.profile) return Promise.resolve();
    const request = ++sequence.current;
    const time = normalizeReminderTime(current.settings.time);
    const preview = buildTrainingReminders(current.profile, {
      time,
      completedDays: current.settings.completedDays,
    });
    if (mounted.current && request === sequence.current) setNext(preview);
    setSyncing(true);
    return syncTrainingReminders(current.profile, {
      enabled: current.settings.enabled,
      time,
      interactive,
      workspace: current.settings.workspace,
      completedDays: current.settings.completedDays,
      exactAlarm: current.settings.exactAlarm,
    }).then(outcome => {
      if (mounted.current && request === sequence.current) setResult(outcome);
    }).catch(() => {
      if (mounted.current && request === sequence.current) {
        setResult({
          scheduled: 0,
          permission: 'undetermined',
          exactAlarm: 'unknown',
          error: '无法更新训练提醒，请检查 Android 通知设置。',
        });
      }
    }).finally(() => {
      if (mounted.current && request === sequence.current) setSyncing(false);
    });
  }, []);

  const completedKey = settings.completedDays?.join('|') ?? '';
  useEffect(() => {
    refresh(false).catch(() => undefined);
  }, [completedKey, profile, refresh, settings.enabled, settings.time, settings.workspace]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') refresh(false).catch(() => undefined);
    });
    return () => subscription.remove();
  }, [refresh]);

  useEffect(() => {
    let offset = new Date().getTimezoneOffset();
    let day = new Date().toDateString();
    const timer = setInterval(() => {
      const now = new Date();
      const currentOffset = now.getTimezoneOffset();
      const currentDay = now.toDateString();
      if (currentOffset === offset && currentDay === day) return;
      offset = currentOffset;
      day = currentDay;
      // A new local day shifts the 60-day window; a new offset moves every wall-clock
      // reminder. Either way the queued notifications must be rebuilt.
      refresh(false).catch(() => undefined);
    }, TIMEZONE_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  return { result, next, syncing, refresh };
}
