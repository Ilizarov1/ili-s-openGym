/**
 * 统计页：概览（次数、本周、总训练量、本周完成度）、训练记录、动作历史。
 *
 * 只展示 `history` 里已有的数据；没有训练时只有空状态，不显示任何占位模块。
 * 删除确认、编辑面板和补录入口都由 App 通过回调提供，本页不改数据。
 */

import { useEffect, useMemo, useState } from 'react';
import { BackHandler, FlatList, StyleSheet, View } from 'react-native';
import { sessionVolume, workoutDay } from '../../../frontend/src/lib/history';
import { clustersOf, dropsOf, isWarmupRow } from '../../../frontend/src/lib/workout-model';
import { supersetMeta } from '../../../frontend/src/lib/superset-meta';
import { effortNoteOf } from '../effort';
import {
  ActionSheet,
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Header,
  IconButton,
  IconTile,
  ListRow,
  ProgressBar,
  Screen,
  SectionHeader,
  StatTile,
  Text,
  space,
  useTheme,
} from '../design';
import { exerciseUnits } from '../supersets';
import {
  exerciseName,
  inProfileUnit,
  localDate,
  unitOf,
  workoutKey,
  type LoggedSet,
  type Profile,
  type Unit,
  type Workout,
} from '../training';

export type StatsHistoryItem = { workout: Workout; unit: Unit; pending: boolean };

export type StatsScreenProps = {
  profile: Profile;
  history: StatsHistoryItem[];
  onEdit: (workout: Workout, unit: Unit) => void;
  onDelete: (workout: Workout) => void;
  onBackfill: () => void;
};

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
});

/** 周一至周日的本地日期串，用于“本周”统计。 */
function weekDays(now: number) {
  const today = new Date(now);
  const offset = (today.getDay() + 6) % 7;
  return Array.from({ length: 7 }, (_, index) =>
    localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset + index).getTime()));
}

/** 固定周计划里排了几次训练；没有排程时不显示完成度，避免造一个分母。 */
function weeklyTarget(profile: Profile) {
  return Object.values(profile.week ?? {}).reduce((total, value) => {
    const ids = (Array.isArray(value) ? value : value ? [value] : []).filter(id => id && id !== 'rest');
    return total + ids.length;
  }, 0);
}

function formatVolume(value: number, unit: Unit) {
  const rounded = Math.round(Math.max(0, Number.isFinite(value) ? value : 0));
  return `${String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} ${unit}`;
}

function describeSet(set: LoggedSet, unit: Unit) {
  const clusters = clustersOf(set);
  const drops = dropsOf(set);
  let text: string;
  if (set.r != null) text = `${set.w ?? 0} ${unit} × ${set.r}`;
  else if (set.sec != null) text = `${set.sec} 秒${set.w != null ? ` · ${set.w} ${unit}` : ''}`;
  else if (set.min != null) text = `${set.min} 分钟${set.speed != null ? ` · 速度 ${set.speed}` : ''}`;
  else text = '已完成';
  if (clusters.length) {
    const sum = clusters.reduce((total: number, cluster: { r?: number }) => total + (Number(cluster.r) || 0), 0);
    const reps = Number(set.r) || 0;
    if (sum === reps) text += `（${clusters.map((cluster: { r?: number }) => cluster.r ?? 0).join(' + ')}）`;
    else if (sum < reps) text += `（${reps - sum} + ${clusters.map((cluster: { r?: number }) => cluster.r ?? 0).join(' + ')}）`;
  } else if (drops.length) {
    text += drops.map((drop: { w?: number; r?: number }) => ` ↘ ${drop.w ?? 0} ${unit} × ${drop.r ?? 0}`).join('');
  }
  // The row's own saved scale, never the profile's: switching the setting does not
  // relabel history. A failure mark without a rating reads as a marked RIR 0.
  const effort = effortNoteOf(set);
  return effort ? `${text} · ${effort}` : text;
}

function setsSummary(sets: LoggedSet[], unit: Unit) {
  return sets.map(set => `${isWarmupRow(set) ? '热身 ' : ''}${describeSet(set, unit)}`).join(' · ');
}

function EntryRows({ workout, profile, unit, onExercise }: {
  workout: Workout;
  profile: Profile;
  unit: Unit;
  onExercise: (id: string) => void;
}) {
  const theme = useTheme();
  const entries = (workout.entries ?? []).filter(Boolean);
  if (entries.length === 0) {
    return <Text tone="secondary" variant="subhead">这次训练没有记录动作。</Text>;
  }
  const units = exerciseUnits(entries.map(entry => ({ sg: entry.sg ?? entry.target?.sg })));
  return (
    <>
      {units.map(indices => {
        const name = indices.length > 1 ? supersetMeta(entries, indices, { onTarget: true }).name : '';
        return (
          <View key={indices[0]} style={{ gap: theme.space.xxs }}>
            {indices.length > 1 ? (
              <Text tone="secondary" variant="caption">{name ? `超级组 · ${name}` : '超级组'}</Text>
            ) : null}
            {indices.map(index => {
              const entry = entries[index];
              const title = exerciseName(profile, entry.id);
              const summary = setsSummary((entry.sets ?? []).filter(set => set?.done), unit);
              return (
                <ListRow
                  key={index}
                  accessibilityLabel={`${title}，查看动作历史`}
                  chevron
                  onPress={() => onExercise(entry.id)}
                  subtitle={summary || '没有完成的组'}
                  title={title}
                />
              );
            })}
          </View>
        );
      })}
    </>
  );
}

export function StatsScreen({ profile, history, onEdit, onDelete, onBackfill }: StatsScreenProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [action, setAction] = useState<{ workout: Workout; unit: Unit } | null>(null);
  const [exerciseId, setExerciseId] = useState<string | null>(null);

  // 动作历史是统计页内部的一层，返回键先退出这层，再由 App 处理 Tab 返回。
  useEffect(() => {
    if (exerciseId == null) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setExerciseId(null);
      return true;
    });
    return () => subscription.remove();
  }, [exerciseId]);

  const unit = unitOf(profile);
  const records = useMemo(
    () => [...history].sort((a, b) => b.workout.start - a.workout.start),
    [history],
  );
  const stats = useMemo(() => {
    const days = weekDays(Date.now());
    const week = new Set(days);
    const weekDone = records.filter(({ workout }) => {
      const day = workoutDay(workout);
      return day != null && week.has(day);
    }).length;
    const volume = records.reduce((total, item) => {
      const workout = item.unit === unit
        ? item.workout
        : inProfileUnit({ unit: item.unit, workout: { ...item.workout, id: workoutKey(item.workout) } }, unit);
      return total + sessionVolume(workout, profile);
    }, 0);
    return { days, weekDone, volume };
  }, [records, profile, unit]);
  const target = weeklyTarget(profile);

  if (exerciseId != null) {
    const name = exerciseName(profile, exerciseId);
    const exerciseRecords = records.flatMap(({ workout, unit: itemUnit }) => {
      const entries = (workout.entries ?? []).filter(entry => entry?.id === exerciseId);
      return entries.length ? [{ workout, unit: itemUnit, entries }] : [];
    });

    return (
      <Screen testID="stats-exercise-history">
        <Header compact onBack={() => setExerciseId(null)} subtitle="动作历史" title={name} />
        {exerciseRecords.length === 0 ? (
          <EmptyState
            icon="history"
            text="完成包含这个动作的训练后，这里会按训练列出每一组的重量、次数或时长。"
            title="还没有这个动作的记录"
          />
        ) : exerciseRecords.map(({ workout, unit: itemUnit, entries }) => {
          const sets = entries.flatMap(entry => (entry.sets ?? []).filter(set => set?.done));
          return (
            <Card key={workoutKey(workout)}>
              <View style={[styles.row, { gap: theme.space.sm }]}>
                <Text numberOfLines={2} style={styles.grow} variant="headline">
                  {`${workout.d} · ${workout.name || '训练'}`}
                </Text>
                {sets.some(set => isWarmupRow(set)) ? <Badge tone="neutral">含热身</Badge> : null}
              </View>
              {sets.length === 0 ? (
                <Text tone="secondary" variant="subhead">没有完成的组</Text>
              ) : sets.map((set, index) => (
                <Text key={index} tone="secondary" variant="subhead">
                  {`${isWarmupRow(set) ? '热身 · ' : ''}${describeSet(set, itemUnit)}`}
                </Text>
              ))}
            </Card>
          );
        })}
      </Screen>
    );
  }

  const header = (
    <>
      <Header subtitle="训练记录与进步" title="统计" />
      {records.length > 0 ? (
        <>
          <Card>
            <StatTile icon="history" label="训练次数" tone="neutral" value={String(records.length)} />
            <Divider />
            <StatTile
              detail={`${stats.days[0].slice(5)} – ${stats.days[6].slice(5)}`}
              icon="calendar"
              label="本周训练"
              tone="blue"
              value={String(stats.weekDone)}
            />
            <Divider />
            <StatTile
              detail={profile.volumeWarmups === true ? '含热身组' : '仅正式组'}
              icon="dumbbell"
              label="总训练量"
              tone="accent"
              value={formatVolume(stats.volume, unit)}
            />
            {target > 0 ? (
              <>
                <Divider />
                <View style={{ gap: theme.space.sm }}>
                  <View style={styles.meta}>
                    <Text tone="secondary" variant="footnote">本周完成度</Text>
                    <Text tone="secondary" variant="footnote">{`${stats.weekDone}/${target} 次`}</Text>
                  </View>
                  <ProgressBar value={target > 0 ? stats.weekDone / target : 0} />
                  <Text tone="secondary" variant="footnote">
                    {stats.weekDone >= target ? '本周计划已完成' : `本周还剩 ${target - stats.weekDone} 次`}
                  </Text>
                </View>
              </>
            ) : null}
          </Card>
          <SectionHeader
            action={<Button icon="plus" onPress={onBackfill} size="xs" variant="ghost">补录训练</Button>}
            style={{ marginTop: theme.space.md }}
            title="最近训练"
          />
        </>
      ) : null}
    </>
  );

  return (
    <Screen scroll={false} testID="stats-screen">
      <FlatList
        contentContainerStyle={{ padding: theme.layout.pagePadding, paddingBottom: theme.layout.listBottomPadding }}
        data={records}
        keyExtractor={item => workoutKey(item.workout)}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={(
          <EmptyState
            icon="chart"
            text="完成第一次训练后，训练次数、训练量和每次的组数都会出现在这里。"
            title="还没有训练记录"
          >
            <Button icon="plus" onPress={onBackfill} variant="primary">补录训练</Button>
          </EmptyState>
        )}
        ListHeaderComponent={header}
        renderItem={({ item }) => {
          const { workout, unit: itemUnit, pending } = item;
          const key = workoutKey(workout);
          const open = expanded === key;
          const entries = (workout.entries ?? []).filter(Boolean);
          const title = workout.name || '训练';
          return (
            <Card padded={false}>
              <ListRow
                accessibilityLabel={`${title}，${workout.d}，${entries.length} 个动作${pending ? '，待同步' : ''}，${open ? '收起详情' : '展开详情'}`}
                chevron
                leading={<IconTile name="dumbbell" size="sm" tone="neutral" />}
                onPress={() => setExpanded(open ? null : key)}
                subtitle={`${workout.d} · ${entries.length} 个动作`}
                title={title}
                trailing={pending ? <Badge tone="orange">待同步</Badge> : undefined}
              />
              {open ? (
                <>
                  <Divider />
                  <View style={{ gap: theme.space.xs, padding: theme.layout.cardPadding }}>
                    <SectionHeader
                      action={(
                        <IconButton
                          accessibilityLabel="训练操作"
                          name="more"
                          onPress={() => setAction({ workout, unit: itemUnit })}
                          size="sm"
                        />
                      )}
                      title="动作详情"
                    />
                    <EntryRows onExercise={setExerciseId} profile={profile} unit={itemUnit} workout={workout} />
                  </View>
                </>
              ) : null}
            </Card>
          );
        }}
        style={styles.fill}
      />
      <ActionSheet
        items={action ? [
          {
            label: '编辑训练',
            icon: 'pencil' as const,
            onPress: () => onEdit(action.workout, action.unit),
          },
          {
            label: '删除训练',
            icon: 'trash' as const,
            tone: 'danger' as const,
            onPress: () => onDelete(action.workout),
          },
        ] : []}
        onClose={() => setAction(null)}
        title={action ? action.workout.name || '训练' : '训练'}
        visible={action !== null}
      />
    </Screen>
  );
}
