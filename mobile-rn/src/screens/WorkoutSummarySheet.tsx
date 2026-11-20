// The sheet shown after a workout is saved: duration, volume, sets and the PRs
// computed against the history saved before this session. It only reads the saved
// record; App closes it and returns Home.

import { View } from 'react-native';
import { Button, Icon, Sheet, StatTile, Text, useTheme } from '../design';
import { formatDurationSeconds, formatVolume, type WorkoutSummary } from '../progress';
import { exerciseName, type Profile, type Unit, type Workout } from '../training';

export type WorkoutSummarySheetProps = {
  profile: Profile;
  workout: Workout;
  summary: WorkoutSummary;
  unit: Unit;
  onClose: () => void;
};

export function WorkoutSummarySheet({ profile, workout, summary, unit, onClose }: WorkoutSummarySheetProps) {
  const theme = useTheme();
  const prCount = summary.weightPrs.length + summary.oneRmPrs.length;
  return (
    <Sheet
      footer={<Button onPress={onClose} testID="summary-done" variant="primary">完成</Button>}
      onClose={onClose}
      testID="workout-summary"
      title="训练完成"
      visible
    >
      <View style={{ gap: theme.space.md }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.md }}>
          <StatTile
            label="时长"
            style={{ width: '47%' }}
            value={formatDurationSeconds(Math.round(summary.durationMs / 1000))}
          />
          <StatTile
            label="训练量"
            style={{ width: '47%' }}
            value={formatVolume(summary.volume, unit)}
          />
          <StatTile
            detail={`正式组 ${summary.workSets}`}
            label="已完成组"
            style={{ width: '47%' }}
            value={`${summary.sets} 组`}
          />
          <StatTile
            label="新纪录"
            style={{ width: '47%' }}
            value={prCount > 0 ? `${prCount} 项` : '—'}
          />
        </View>

        {summary.weightPrs.length > 0 ? (
          <View style={{ gap: theme.space.xs }}>
            <Text variant="headline">重量新纪录</Text>
            {summary.weightPrs.map(id => (
              <View key={id} style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
                <Icon color={theme.colors.accent} name="trophy" size={16} />
                <Text style={{ flex: 1 }} variant="footnote">{exerciseName(profile, id)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {summary.oneRmPrs.length > 0 ? (
          <View style={{ gap: theme.space.xs }}>
            <Text variant="headline">估算 1RM 新高</Text>
            {summary.oneRmPrs.map(item => (
              <View key={item.id} style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
                <Icon color={theme.colors.accent} name="chartLine" size={16} />
                <Text style={{ flex: 1 }} variant="footnote">{exerciseName(profile, item.id)}</Text>
                <Text tone="secondary" variant="footnote">{`${item.est} ${unit}`}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {prCount === 0 && (workout.entries ?? []).length > 0 ? (
          <Text tone="secondary" variant="footnote">
            这次没有刷新负重或估算 1RM 纪录，完成的组已经保存。
          </Text>
        ) : null}
        {prCount === 0 && (workout.entries ?? []).length === 0 ? (
          <Text tone="secondary" variant="footnote">
            这次没有记组，已保存为一次空训练记录。
          </Text>
        ) : null}
      </View>
    </Sheet>
  );
}

export default WorkoutSummarySheet;
