// The five-tab Home screen: greeting and date, the Monday-first week strip,
// this week's progress, today's recommendation and the latest workouts.
// Presentation only — App owns the profile, the history merge and every action.

import { StyleSheet, View } from 'react-native';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Header,
  IconButton,
  IconTile,
  ListRow,
  MiniBodyMap,
  ProgressBar,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '../design';
import { workoutKey, type Profile, type Routine, type Unit, type Workout } from '../training';
import type { Connection } from '../server';

export type HomeHistoryItem = { workout: Workout; unit: Unit; pending: boolean };

export type HomeScreenProps = {
  profile: Profile;
  connection: Connection | null;
  history: HomeHistoryItem[];
  recommended: Routine[];
  pending: number;
  onSettings: () => void;
  onStartRoutine: (routine: Routine) => void;
  onStartFree: () => void;
  onOpenStats: () => void;
  onOpenPlan: () => void;
};

/** Monday-first column labels, matching `WEEKDAY_ORDER`. */
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
/** `profile.week` is keyed by `Date#getDay()`; the strip runs Monday → Sunday. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const styles = StyleSheet.create({
  badges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  weekRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dayCell: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
  },
  dayNumber: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  routineHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  routineTitle: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  startButton: {
    alignSelf: 'flex-end',
  },
  emptyHint: {
    marginBottom: 12,
  },
});

function weekDates(now: Date) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return WEEKDAY_ORDER.map((day, index) => {
    const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
    return { day, date };
  });
}

function formatDate(date: Date) {
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAY_NAMES[date.getDay()]}`;
}

export function HomeScreen({
  profile,
  connection,
  history,
  recommended,
  pending,
  onSettings,
  onStartRoutine,
  onStartFree,
  onOpenStats,
  onOpenPlan,
}: HomeScreenProps) {
  const theme = useTheme();
  const now = new Date();
  const days = weekDates(now);
  const today = now.getDay();
  const week = profile.week ?? {};
  const rotationMode = profile.scheduleMode === 'rotation' || profile.queue != null;

  const plannedIds = (day: number): string[] => {
    const value = week[String(day)];
    const ids = typeof value === 'string' ? (value ? [value] : []) : value ?? [];
    return ids.filter(id => (profile.routines ?? []).some(routine => routine?.id === id));
  };
  const planned = Object.values(week).reduce<number>(
    (total, value) => total + (Array.isArray(value) ? value.filter(Boolean).length : value ? 1 : 0),
    0,
  );
  const weekStart = days[0].date.getTime();
  const weekEndDate = new Date(days[0].date);
  weekEndDate.setDate(weekEndDate.getDate() + 7);
  const weekEnd = weekEndDate.getTime();
  const completed = history.filter(({ workout }) => workout.start >= weekStart && workout.start < weekEnd).length;
  const remaining = Math.max(0, planned - completed);
  const progress = planned > 0 ? Math.min(1, completed / planned) : 0;

  const recommendations = recommended.filter(routine => (routine.ex ?? []).some(Boolean));
  const recent = history.slice(0, 3);
  const showBadges = !connection || pending > 0;

  return (
    <Screen testID="home-screen">
      <Header
        right={<IconButton accessibilityLabel="设置" name="gear" onPress={onSettings} />}
        subtitle={formatDate(now)}
        title={connection ? `你好，${connection.user.name}` : '你好'}
      />

      {showBadges ? (
        <View style={styles.badges}>
          {connection ? null : <Badge tone="neutral">本机练习</Badge>}
          {connection && pending > 0 ? <Badge tone="orange">{`${pending} 条待同步`}</Badge> : null}
        </View>
      ) : null}

      <Card>
        <View style={styles.weekRow}>
          {days.map(({ day, date }, index) => {
            const isToday = day === today;
            const hasPlan = rotationMode
              ? isToday && recommendations.length > 0
              : plannedIds(day).length > 0;
            return (
              <View key={day} style={styles.dayCell}>
                <Text tone={isToday ? 'accent' : 'secondary'} variant="caption2">
                  {WEEKDAY_LABELS[index]}
                </Text>
                <View
                  style={[
                    styles.dayNumber,
                    {
                      width: theme.sizes.tileSm,
                      height: theme.sizes.tileSm,
                      borderRadius: theme.radius.pill,
                      backgroundColor: isToday ? theme.colors.accent : 'transparent',
                    },
                  ]}
                >
                  <Text tone={isToday ? 'onAccent' : 'label'} variant="subhead" weight={isToday ? '600' : undefined}>
                    {date.getDate()}
                  </Text>
                </View>
                <View
                  style={{
                    width: theme.space.xs,
                    height: theme.space.xs,
                    borderRadius: theme.radius.pill,
                    backgroundColor: hasPlan
                      ? isToday
                        ? theme.colors.accent
                        : theme.colors.label2
                      : 'transparent',
                  }}
                />
              </View>
            );
          })}
        </View>
        {rotationMode ? (
          <Text tone="secondary" variant="footnote">
            {recommendations.length > 0
              ? `轮换进行中 · 今天 ${recommendations.map(routine => routine.name).join(' + ')}`
              : '轮换进行中 · 今天休息'}
          </Text>
        ) : null}
      </Card>

      <Card>
        <Text variant="body">{planned > 0 ? `本周还剩 ${remaining}/${planned} 次` : '本周还没有排程'}</Text>
        <ProgressBar value={progress} />
        <Text tone="secondary" variant="footnote">
          {planned > 0
            ? `已完成 ${completed} 次 · 计划 ${planned} 次`
            : rotationMode
              ? '轮换模式不使用每周排程，按轮换顺序训练。'
              : '在计划里安排训练日，这里会显示完成进度。'}
        </Text>
      </Card>

      <SectionHeader
        action={
          recommendations.length > 0 ? (
            <Button onPress={onOpenPlan} size="xs" variant="ghost">
              查看计划
            </Button>
          ) : undefined
        }
        title="今日训练"
      />
      {recommendations.length > 0 ? (
        recommendations.map(routine => (
          <Card key={routine.id}>
            <View style={styles.routineHead}>
              <IconTile name="dumbbell" />
              <View style={styles.routineTitle}>
                <Text numberOfLines={1} variant="headline">
                  {routine.name}
                </Text>
                <Text tone="secondary" variant="footnote">
                  {`${(routine.ex ?? []).filter(Boolean).length} 个动作`}
                </Text>
              </View>
              <MiniBodyMap height={theme.sizes.tileLg} routines={[routine]} />
            </View>
            <Button
              icon="play"
              onPress={() => onStartRoutine(routine)}
              size="sm"
              style={styles.startButton}
              variant="primary"
            >
              开始
            </Button>
          </Card>
        ))
      ) : (
        <EmptyState icon="calendar" text="挑一套计划开始，或者直接自由训练。" title="今天没有安排">
          <Button onPress={onOpenPlan} variant="primary">
            打开计划
          </Button>
          <Button onPress={onStartFree} variant="secondary">
            自由训练
          </Button>
        </EmptyState>
      )}

      <SectionHeader
        action={
          recent.length > 0 ? (
            <Button onPress={onOpenStats} size="xs" variant="ghost">
              查看全部
            </Button>
          ) : undefined
        }
        title="最近训练"
      />
      {recent.length > 0 ? (
        <Card padded={false}>
          {recent.map(({ workout, pending: queued }, index) => (
            <View key={workoutKey(workout)}>
              {index > 0 ? (
                <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
              ) : null}
              <ListRow
                chevron
                leading={<IconTile name="history" size="sm" tone="neutral" />}
                onPress={onOpenStats}
                subtitle={`${workout.d} · ${(workout.entries ?? []).filter(Boolean).length} 个动作`}
                title={workout.name || '训练'}
                trailing={queued ? <Badge tone="orange">待同步</Badge> : undefined}
              />
            </View>
          ))}
        </Card>
      ) : (
        <Text style={styles.emptyHint} tone="secondary" variant="footnote">
          还没有训练记录，完成第一次训练后会显示在这里。
        </Text>
      )}
    </Screen>
  );
}
