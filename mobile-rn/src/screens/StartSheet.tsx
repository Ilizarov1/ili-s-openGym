// The bottom sheet behind the TabBar's central start button: today's
// recommendations, every routine, free training and a backfill session.
// It only reports the choice; App opens the workout.

import { View } from 'react-native';
import {
  Button,
  Card,
  Divider,
  IconTile,
  ListRow,
  SectionHeader,
  Sheet,
  Text,
  useTheme,
} from '../design';
import type { Routine } from '../training';

export type StartSheetProps = {
  visible: boolean;
  recommended: Routine[];
  routines: Routine[];
  onStartRoutine: (routine: Routine) => void;
  onStartFree: () => void;
  onBackfill: () => void;
  onClose: () => void;
};

export function StartSheet({
  visible,
  recommended,
  routines,
  onStartRoutine,
  onStartFree,
  onBackfill,
  onClose,
}: StartSheetProps) {
  const theme = useTheme();
  const exerciseCount = (routine: Routine) => (routine.ex ?? []).filter(Boolean).length;

  const recommendedRows = recommended.filter(routine => exerciseCount(routine) > 0);
  const recommendedIds = new Set(recommendedRows.map(routine => routine.id));
  const otherRoutines = routines.filter(routine => !recommendedIds.has(routine.id));
  const inset = theme.layout.listRowPaddingX + theme.sizes.tileMd + theme.space.md;

  const startRoutine = (routine: Routine) => {
    onClose();
    onStartRoutine(routine);
  };

  const routineRow = (routine: Routine) => {
    const count = exerciseCount(routine);
    return (
      <ListRow
        chevron
        disabled={count === 0}
        leading={<IconTile name="dumbbell" />}
        onPress={() => startRoutine(routine)}
        subtitle={count > 0 ? `${count} 个动作` : '暂无动作'}
        testID={`start-routine-${routine.id}`}
        title={routine.name}
      />
    );
  };

  return (
    <Sheet onClose={onClose} testID="start-sheet" title="开始训练" visible={visible}>
      {recommendedRows.length > 0 ? (
        <>
          <SectionHeader title="今日推荐" />
          <Card padded={false}>
            {recommendedRows.map((routine, index) => (
              <View key={routine.id}>
                {index > 0 ? <Divider inset={inset} /> : null}
                {routineRow(routine)}
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {otherRoutines.length > 0 ? (
        <>
          <SectionHeader title="全部计划" />
          <Card padded={false}>
            {otherRoutines.map((routine, index) => (
              <View key={routine.id}>
                {index > 0 ? <Divider inset={inset} /> : null}
                {routineRow(routine)}
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {recommendedRows.length === 0 && otherRoutines.length === 0 ? (
        <Text style={{ marginBottom: theme.space.md }} tone="secondary" variant="footnote">
          还没有训练计划，可以直接开始自由训练。
        </Text>
      ) : null}

      <Card padded={false}>
        <ListRow
          chevron
          leading={<IconTile name="bolt" tone="neutral" />}
          onPress={() => {
            onClose();
            onStartFree();
          }}
          subtitle="不套用计划，从动作库开始"
          title="自由训练"
        />
        <Divider inset={inset} />
        <ListRow
          chevron
          leading={<IconTile name="history" tone="orange" />}
          onPress={() => {
            onClose();
            onBackfill();
          }}
          subtitle="记下之前完成的训练"
          title="补录训练"
        />
      </Card>

      <Button onPress={onClose} variant="secondary">
        取消
      </Button>
    </Sheet>
  );
}
