// The per-date override picked from Home on a rest day: one routine, rest, or back
// to the weekly plan. The choice is a synced `dayPlan` change; this page only picks.

import { View } from 'react-native';
import { Divider, Header, IconTile, ListRow, Screen, Text, useTheme } from '../design';
import type { Routine } from '../training';

export type DayOverrideSheetProps = {
  routines: Routine[];
  /** The routine ids the day resolves to without the override. */
  current: string[];
  /** The override stored for the day, `'rest'` included; absent when none. */
  override?: string;
  onPick: (id: string | 'rest' | null) => void;
  onClose: () => void;
};

export function DayOverrideSheet({ routines, current, override, onPick, onClose }: DayOverrideSheetProps) {
  const theme = useTheme();
  const inset = theme.layout.listRowPaddingX + theme.sizes.tileMd + theme.space.md;
  const row = (routine: Routine) => {
    const count = (routine.ex ?? []).filter(item => item?.id).length;
    const selected = current.includes(routine.id);
    return (
      <View key={routine.id}>
        <ListRow
          chevron
          leading={<IconTile name="dumbbell" />}
          onPress={() => onPick(routine.id)}
          subtitle={count > 0 ? `${count} 个动作` : '暂无动作'}
          title={routine.name}
          trailing={selected ? <Text tone="accent" variant="footnote">当前</Text> : undefined}
        />
      </View>
    );
  };

  return (
    <Screen testID="day-override">
      <Header onBack={onClose} subtitle="只覆盖今天，不改变周计划与轮换" title="今天的训练" />
      <Text style={{ marginBottom: theme.space.sm }} tone="secondary" variant="footnote">
        今天按周计划是休息日。挑一套计划只覆盖今天，也可以保持休息。
      </Text>
      {routines.length > 0 ? (
        <>
          {routines.map((routine, index) => (
            <View key={routine.id}>
              {index > 0 ? <Divider inset={inset} /> : null}
              {row(routine)}
            </View>
          ))}
          <Divider inset={inset} />
        </>
      ) : null}
      <ListRow
        leading={<IconTile name="moon" tone="neutral" />}
        onPress={() => onPick('rest')}
        title="今天休息"
        trailing={override === 'rest' || (override == null && current.length === 0)
          ? <Text tone="accent" variant="footnote">当前</Text> : undefined}
      />
      {override != null ? (
        <ListRow
          leading={<IconTile name="reset" tone="neutral" />}
          onPress={() => onPick(null)}
          title="恢复周计划"
        />
      ) : null}
    </Screen>
  );
}

export default DayOverrideSheet;
