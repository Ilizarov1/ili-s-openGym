/**
 * Self-contained PR / estimated-1RM cards for StatsScreen's exercise history.
 *
 * Props are only the profile, the exercise id and the already-loaded history.
 * The component never reads App state, so dropping it under the existing exercise
 * branch cannot change any other page behaviour.
 */

import { useMemo } from 'react';
import { View } from 'react-native';
import {
  Badge,
  Card,
  Divider,
  LineChart,
  ListRow,
  SectionHeader,
  StatTile,
  Text,
  useTheme,
} from '../design';
import { unitOf, type Profile, type Unit, type Workout } from '../training';
import {
  candidateDetail,
  candidateValueText,
  formatDayLabel,
  formatMonthDay,
  formatNumber,
  modeLabel,
} from './format';
import { normalizeHistory } from './history';
import { oneRmFormulaLabel, oneRmProjectionFromWorkouts } from './oneRm';
import { exerciseRecordFromWorkouts } from './records';
import type { OneRmPoint, ProgressHistoryItem, WorkoutSource } from './types';

export type ExerciseRecordSectionProps = {
  profile: Profile;
  exerciseId: string;
  history: readonly ProgressHistoryItem[];
  /** Hands back the stored workout and its stored unit, ready for the history editor. */
  onOpenWorkout?: (workout: Workout, unit: Unit) => void;
};

function oneRmSourceText(point: OneRmPoint, unit: Unit): string {
  return `${formatNumber(point.weight, 2)} ${unit} × ${formatNumber(point.reps, 0)} 次`;
}

export function ExerciseRecordSection({
  profile,
  exerciseId,
  history,
  onOpenWorkout,
}: ExerciseRecordSectionProps) {
  const theme = useTheme();
  const workouts = useMemo(() => normalizeHistory(profile, history), [profile, history]);
  const record = useMemo(
    () => exerciseRecordFromWorkouts(profile, workouts, exerciseId),
    [exerciseId, profile, workouts],
  );
  const oneRm = useMemo(
    () => oneRmProjectionFromWorkouts(profile, workouts, exerciseId),
    [exerciseId, profile, workouts],
  );
  const unit = unitOf(profile);

  const openSource = (source: WorkoutSource) => {
    if (onOpenWorkout) onOpenWorkout(source.workout, source.unit);
  };

  const chartPoints = oneRm.points
    .filter(point => Number.isFinite(point.source.at))
    .map(point => ({
      x: point.source.at,
      y: point.value,
      label: formatMonthDay(point.source.date) || undefined,
    }));

  return (
    <View style={{ gap: theme.space.md }} testID="stats-exercise-records">
      <SectionHeader title="个人纪录" />
      <Card>
        {record.record ? (
          <>
            <Text tone="secondary" variant="caption">
              {`${modeLabel(record.mode, record.metric)}${record.assisted ? ' · 按最小辅助量排名' : ''}`}
            </Text>
            <StatTile
              detail={`${formatDayLabel(record.record.source.date)} · ${candidateDetail(record.record)}`}
              icon="trophy"
              label="最佳纪录"
              tone="accent"
              value={candidateValueText(record.record)}
            />
            <Divider />
            <ListRow
              accessibilityLabel={`纪录来源，${formatDayLabel(record.record.source.date)}，${candidateDetail(record.record)}`}
              chevron={onOpenWorkout != null}
              onPress={onOpenWorkout ? () => openSource(record.record!.source) : undefined}
              subtitle={`${formatDayLabel(record.record.source.date)} · ${candidateDetail(record.record)}`}
              title="来源训练"
              trailing={record.record.source.pending ? <Badge tone="orange">待同步</Badge> : undefined}
            />
          </>
        ) : (
          <Text tone="secondary" variant="subhead">
            暂无纪录。完成包含这个动作的正式组后，这里会显示最佳重量、次数或时长。
          </Text>
        )}
      </Card>

      <SectionHeader title="估算 1RM" />
      <Card>
        {oneRm.best ? (
          <>
            <StatTile
              detail={`${oneRmFormulaLabel(oneRm.formula)} · ${formatDayLabel(oneRm.best.source.date)} · ${oneRmSourceText(oneRm.best, unit)}`}
              icon="chartLine"
              label="最佳 1RM"
              tone="blue"
              value={`${formatNumber(oneRm.best.value, 2)} ${unit}`}
            />
            <Divider />
            {chartPoints.length > 0 ? (
              <LineChart
                accessibilityLabel={`估算 1RM 曲线，共 ${oneRm.points.length} 个训练点，最佳 ${formatNumber(oneRm.best.value, 2)} ${unit}`}
                emptyLabel="暂无可估算组"
                height={150}
                onPointPress={onOpenWorkout
                  ? index => {
                      const pair = chartPoints[index];
                      if (pair) {
                        const source = oneRm.points.filter(item => Number.isFinite(item.source.at))[index]?.source;
                        if (source) openSource(source);
                      }
                    }
                  : undefined}
                points={chartPoints}
                unit={unit}
              />
            ) : (
              <Text tone="secondary" variant="footnote">
                这个 1RM 点没有可用日期，暂时无法绘制曲线。
              </Text>
            )}
            {oneRm.points.length > 1 ? (
              <>
                <Divider />
                {oneRm.points.slice(-5).reverse().map(point => (
                  <ListRow
                    accessibilityLabel={`${formatDayLabel(point.source.date)}，估算 ${formatNumber(point.value, 2)} ${unit}，来源 ${oneRmSourceText(point, unit)}`}
                    chevron={onOpenWorkout != null}
                    key={`${point.source.key}-${point.entryIndex}`}
                    onPress={onOpenWorkout ? () => openSource(point.source) : undefined}
                    subtitle={`${oneRmSourceText(point, unit)} · ${oneRmFormulaLabel(point.formula)}`}
                    title={`${formatMonthDay(point.source.date) || '训练'} · ${formatNumber(point.value, 2)} ${unit}`}
                    trailing={point.source.pending ? <Badge tone="orange">待同步</Badge> : undefined}
                  />
                ))}
                {oneRm.points.length > 5 ? (
                  <Text tone="secondary" variant="caption">
                    列表显示最近 5 个训练点，曲线包含全部。
                  </Text>
                ) : null}
              </>
            ) : null}
            <Divider />
            <ListRow
              accessibilityLabel={`最佳 1RM 来源，${formatDayLabel(oneRm.best.source.date)}，${oneRmSourceText(oneRm.best, unit)}`}
              chevron={onOpenWorkout != null}
              onPress={onOpenWorkout ? () => openSource(oneRm.best!.source) : undefined}
              subtitle={`${formatDayLabel(oneRm.best.source.date)} · ${oneRmSourceText(oneRm.best, unit)} · ${oneRmFormulaLabel(oneRm.formula)}`}
              title="最佳来源"
              trailing={oneRm.best.source.pending ? <Badge tone="orange">待同步</Badge> : undefined}
            />
            <Text tone="secondary" variant="caption">
              {`每场训练取最佳估算组；${oneRmFormulaLabel(oneRm.formula)} 公式。`}
            </Text>
          </>
        ) : (
          <View style={{ gap: theme.space.xs }}>
            <Text tone="secondary" variant="subhead">
              暂无可估算组。
            </Text>
            <Text tone="secondary" variant="footnote">
              1RM 只从正式完成的力量组估算；辅助器械、计时、有氧和只有旧版最高重量的记录不会产生估算。
            </Text>
          </View>
        )}
      </Card>
    </View>
  );
}
