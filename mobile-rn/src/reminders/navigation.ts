import type { NotificationResponse } from 'expo-notifications';
import * as Notifications from 'expo-notifications';
import { useLayoutEffect, useRef } from 'react';
import { isTrainingReminderIdentifier } from './constants';

/** True for a tap on one of this feature's notifications. */
export function isTrainingReminderResponse(response: NotificationResponse | null | undefined): boolean {
  if (!response) return false;
  const data = response.notification.request.content.data;
  if (data?.kind === 'training-reminder') return true;
  return isTrainingReminderIdentifier(response.notification.request.identifier);
}

/**
 * Open the plan tab when a training reminder is tapped.
 *
 * The last response is read on mount, which covers a cold start (the response is
 * already in native state before React mounts), and a listener covers taps while
 * the app is running. The response is cleared only after one of our reminders was
 * handled, so an ordinary app launch does not accidentally navigate.
 */
export function useTrainingReminderNavigation(onOpenPlan: () => void): void {
  const handler = useRef(onOpenPlan);

  useLayoutEffect(() => {
    handler.current = onOpenPlan;
  }, [onOpenPlan]);

  useLayoutEffect(() => {
    const handle = (response: NotificationResponse) => {
      if (!isTrainingReminderResponse(response)) return;
      try {
        handler.current();
      } finally {
        Notifications.clearLastNotificationResponse();
      }
    };

    const last = Notifications.getLastNotificationResponse();
    if (last) handle(last);
    const subscription = Notifications.addNotificationResponseReceivedListener(handle);
    return () => subscription.remove();
  }, []);
}
