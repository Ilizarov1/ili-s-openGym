import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';

const channelId = 'rest-timer';
const notificationId = 'open-gym-active-rest';
let operations = Promise.resolve();

Notifications.setNotificationHandler({
  handleNotification: async () => {
    const inBackground = AppState.currentState !== 'active';
    return { shouldShowBanner: inBackground, shouldShowList: inBackground, shouldPlaySound: inBackground, shouldSetBadge: false };
  },
});

export async function enableRestNotifications() {
  await Notifications.setNotificationChannelAsync(channelId, {
    name: '组间休息', importance: Notifications.AndroidImportance.HIGH,
    enableVibrate: true, vibrationPattern: [0, 220, 120, 220], lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted || (await Notifications.requestPermissionsAsync()).granted;
}

export function useRestNotification(enabled: boolean | undefined, endsAt: number | undefined) {
  const [error, setError] = useState('');
  useEffect(() => {
    if (enabled === undefined) return;
    let stale = false;
    operations = operations.then(async () => {
      if (stale) return;
      await Notifications.cancelScheduledNotificationAsync(notificationId);
      if (stale || !enabled || !endsAt || endsAt <= Date.now()) return;
      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted || stale || endsAt <= Date.now()) return;
      await Notifications.scheduleNotificationAsync({
        identifier: notificationId,
        content: { title: '组间休息结束', body: '可以开始下一组训练了。', sound: 'default' },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: endsAt, channelId },
      });
    }).then(() => { if (!stale) setError(''); }, () => {
      if (!stale) setError('无法安排休息通知，请检查 Android 通知设置。');
    });
    return () => { stale = true; };
  }, [enabled, endsAt]);
  return error;
}
