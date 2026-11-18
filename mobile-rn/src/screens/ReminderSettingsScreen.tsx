/**
 * 训练提醒设置：开关、本地时刻、系统权限和未来排程预览。
 *
 * The screen only renders props and calls callbacks; all notification scheduling,
 * permission requests and settings navigation live in `src/reminders`.
 */

import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Badge,
  Button,
  Card,
  Divider,
  Header,
  Icon,
  IconTile,
  Screen,
  SectionHeader,
  SwitchRow,
  Text,
  TextField,
  useTheme,
} from '../design';
import { normalizeReminderTime, parseReminderTime, reminderClock, reminderTimeText } from '../reminders/time';
import type {
  ExactAlarmStatus,
  TrainingReminderPermission,
  TrainingReminderPreview,
} from '../reminders/types';

export type ReminderSettingsScreenProps = {
  enabled: boolean;
  /** Local `HH:MM`. */
  time: string;
  permission: TrainingReminderPermission;
  exactAlarm: ExactAlarmStatus;
  /** Future training days from `buildTrainingReminders`. */
  next: readonly TrainingReminderPreview[];
  onClose: () => void;
  onToggle: (enabled: boolean) => void;
  onChangeTime: (time: string) => void;
  onRequestPermission: () => void;
  onOpenAlarmSettings: () => void;
  /** A permission request or schedule sync is running. */
  busy?: boolean;
  /** Sync or scheduling error from `syncTrainingReminders`. */
  error?: string;
};

const PREVIEW_LIMIT = 6;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

const PERMISSION_LABEL: Record<TrainingReminderPermission, string> = {
  granted: '已允许',
  denied: '已拒绝',
  undetermined: '未授权',
};

const PERMISSION_TONE: Record<TrainingReminderPermission, 'accent' | 'orange' | 'danger'> = {
  granted: 'accent',
  denied: 'danger',
  undetermined: 'orange',
};

const PERMISSION_DETAIL: Record<TrainingReminderPermission, string> = {
  granted: '系统通知已允许，训练日会按时提醒。',
  denied: '系统通知已被拒绝，训练日不会提醒。请在 Android 设置中允许通知。',
  undetermined: '尚未授权通知，训练日不会提醒。',
};

const EXACT_ALARM_LABEL: Record<ExactAlarmStatus, string> = {
  granted: '准时',
  denied: '可能延迟',
  unknown: '可能延迟',
};

const EXACT_ALARM_TONE: Record<ExactAlarmStatus, 'accent' | 'orange'> = {
  granted: 'accent',
  denied: 'orange',
  unknown: 'orange',
};

const EXACT_ALARM_DETAIL: Record<ExactAlarmStatus, string> = {
  granted: '系统允许精确闹钟，提醒会准时送达。',
  denied: '系统未允许精确闹钟，提醒仍会安排，但可能延迟。',
  unknown: '无法确认精确闹钟权限，提醒仍会安排，但可能延迟。',
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  warning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
});

function dayLabel(iso: string): string {
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return `${WEEKDAYS[date.getDay()] ?? ''} · ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

export function ReminderSettingsScreen({
  enabled,
  time,
  permission,
  exactAlarm,
  next,
  onClose,
  onToggle,
  onChangeTime,
  onRequestPermission,
  onOpenAlarmSettings,
  busy = false,
  error,
}: ReminderSettingsScreenProps) {
  const theme = useTheme();
  const [timeText, setTimeText] = useState(() => normalizeReminderTime(time));

  useEffect(() => {
    setTimeText(normalizeReminderTime(time));
  }, [time]);

  const changeTime = (value: string) => {
    const cleaned = value.replace(/[^\d:]/g, '').slice(0, 5);
    setTimeText(cleaned);
    const parsed = parseReminderTime(cleaned);
    if (parsed) onChangeTime(reminderTimeText(parsed.hour, parsed.minute));
  };

  const dividerInset = theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md;
  const shown = next.slice(0, PREVIEW_LIMIT);
  const hidden = next.length - shown.length;

  return (
    <Screen testID="reminder-settings-screen">
      <Header compact onBack={onClose} title="训练提醒" subtitle="按计划在训练日提醒" />

      {error ? (
        <View style={[styles.warning, { gap: theme.space.xs, marginBottom: theme.space.md }]}>
          <Icon color={theme.colors.danger} name="warning" size={theme.sizes.buttonIcon} />
          <Text accessibilityLiveRegion="polite" style={styles.grow} tone="danger" variant="footnote">
            {error}
          </Text>
        </View>
      ) : null}

      <Card padded={false}>
        <SwitchRow
          disabled={busy}
          onValueChange={onToggle}
          subtitle="按周排程或轮换计划，在每个训练日提醒一次"
          title="训练提醒"
          value={enabled}
        />
        <View
          style={{
            paddingHorizontal: theme.layout.listRowPaddingX,
            paddingBottom: theme.space.md,
          }}
        >
          <Text tone="secondary" variant="footnote">
            只保存在这台手机的当前工作区；切换账号后各工作区使用自己的设置。
          </Text>
        </View>
      </Card>

      <SectionHeader style={{ marginTop: theme.space.sm }} title="提醒时刻" />
      <Card gap={theme.space.sm}>
        <TextField
          autoCorrect={false}
          editable={!busy}
          keyboardType="numbers-and-punctuation"
          label="本地时刻"
          maxLength={5}
          onBlur={() => setTimeText(normalizeReminderTime(time))}
          onChangeText={changeTime}
          placeholder="08:00"
          testID="reminder-time"
          value={timeText}
        />
        <Text tone="secondary" variant="footnote">
          24 小时制，按手机本地时区计算。当天已过的时刻不会补发。
        </Text>
      </Card>

      <SectionHeader style={{ marginTop: theme.space.sm }} title="通知权限" />
      <Card gap={theme.space.sm}>
        <View style={[styles.row, { gap: theme.space.md }]}>
          <IconTile name="bell" size="md" tone={permission === 'granted' ? 'soft' : 'neutral'} />
          <View style={styles.grow}>
            <Text numberOfLines={1} variant="headline">系统通知</Text>
            <Text tone="secondary" variant="footnote">{PERMISSION_DETAIL[permission]}</Text>
          </View>
          <Badge tone={PERMISSION_TONE[permission]}>{PERMISSION_LABEL[permission]}</Badge>
        </View>
        {permission !== 'granted' ? (
          <Button disabled={busy} icon="bell" onPress={onRequestPermission} variant="tinted">
            允许通知
          </Button>
        ) : null}
      </Card>

      <SectionHeader style={{ marginTop: theme.space.sm }} title="精确闹钟" />
      <Card gap={theme.space.sm}>
        <View style={[styles.row, { gap: theme.space.md }]}>
          <IconTile name="timer" size="md" tone={exactAlarm === 'granted' ? 'soft' : 'orange'} />
          <View style={styles.grow}>
            <Text numberOfLines={1} variant="headline">提醒时间</Text>
            <Text tone="secondary" variant="footnote">{EXACT_ALARM_DETAIL[exactAlarm]}</Text>
          </View>
          <Badge tone={EXACT_ALARM_TONE[exactAlarm]}>{EXACT_ALARM_LABEL[exactAlarm]}</Badge>
        </View>
        {exactAlarm !== 'granted' ? (
          <Button disabled={busy} icon="timer" onPress={onOpenAlarmSettings} variant="secondary">
            打开系统闹钟设置
          </Button>
        ) : null}
      </Card>

      <SectionHeader style={{ marginTop: theme.space.sm }} title="排程预览" />
      {enabled ? (
        next.length ? (
          <>
            <Card padded={false}>
              {shown.map((item, index) => (
                <View key={item.iso}>
                  {index > 0 ? <Divider inset={dividerInset} /> : null}
                  <View
                    style={[
                      styles.row,
                      {
                        gap: theme.space.md,
                        paddingVertical: theme.layout.listRowPaddingY,
                        paddingHorizontal: theme.layout.listRowPaddingX,
                      },
                    ]}
                  >
                    <IconTile name="calendar" size="sm" tone="soft" />
                    <View style={styles.grow}>
                      <Text variant="body">{dayLabel(item.iso)}</Text>
                      <Text numberOfLines={2} tone="secondary" variant="footnote">
                        {`${reminderClock(item.at)} · ${item.body}`}
                      </Text>
                    </View>
                  </View>
                </View>
              ))}
            </Card>
            {hidden > 0 ? (
              <Text style={{ marginTop: theme.space.sm }} tone="secondary" variant="footnote">
                {`还有 ${hidden} 个训练日未显示。`}
              </Text>
            ) : null}
            <Text style={{ marginTop: theme.space.sm }} tone="secondary" variant="caption">
              {`未来 60 天共 ${next.length} 个训练日，每天最多一条提醒。`}
            </Text>
          </>
        ) : (
          <Card>
            <Text variant="headline">未来 60 天没有可安排的训练日</Text>
            <Text tone="secondary" variant="footnote">
              请检查计划排程，或把提醒时刻改到稍晚的时间。
            </Text>
          </Card>
        )
      ) : (
        <Card>
          <Text tone="secondary" variant="subhead">
            开启训练提醒后，这里会列出未来 60 天的训练日、时刻和计划名称。
          </Text>
        </Card>
      )}
    </Screen>
  );
}
