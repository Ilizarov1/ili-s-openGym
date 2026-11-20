// The full-screen start chooser behind the TabBar's centre button on a day with
// nothing planned: today's list (started as one merged session), every other
// routine on its own, and freestyle. It only reports the choice; App starts.

import { View } from 'react-native';
import {
  Button,
  Card,
  Divider,
  EmptyState,
  Header,
  IconTile,
  ListRow,
  Screen,
  SectionHeader,
  Text,
  useTheme,
} from '../design';
import type { Routine } from '../training';

export type StartScreenProps = {
  today: Routine[];
  routines: Routine[];
  onStartToday: () => void;
  onStartRoutine: (routine: Routine) => void;
  onStartFree: () => void;
  onClose: () => void;
};

const countOf = (routine: Routine) => (routine.ex ?? []).filter(item => item?.id).length;

export function StartScreen({ today, routines, onStartToday, onStartRoutine, onStartFree, onClose }: StartScreenProps) {
  const theme = useTheme();
  const todayIds = new Set(today.map(routine => routine.id));
  const others = routines.filter(routine => !todayIds.has(routine.id));
  const trainable = today.filter(routine => countOf(routine) > 0);
  const inset = theme.layout.listRowPaddingX + theme.sizes.tileMd + theme.space.md;

  const row = (routine: Routine) => {
    const count = countOf(routine);
    return (
      <ListRow
        chevron
        disabled={count === 0}
        key={routine.id}
        leading={<IconTile name="dumbbell" />}
        onPress={() => onStartRoutine(routine)}
        subtitle={count > 0 ? `${count} 个动作` : '暂无动作'}
        testID={`start-routine-${routine.id}`}
        title={routine.name}
      />
    );
  };

  return (
    <Screen testID="start-screen">
      <Header
        onBack={onClose}
        subtitle={today.length > 0 ? `今日 ${today.map(routine => routine.name).join(' + ')}` : '今天休息，也可以直接开始'}
        title="开始训练"
      />

      {today.length > 0 ? (
        <>
          <SectionHeader title="今日计划" />
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.md }}>
              <IconTile name="calendar" />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={2} variant="headline">
                  {today.map(routine => routine.name).join(' + ')}
                </Text>
                <Text tone="secondary" variant="footnote">
                  {`${trainable.reduce((total, routine) => total + countOf(routine), 0)} 个动作 · 合并为一场`}
                </Text>
              </View>
            </View>
            <Button
              disabled={trainable.length === 0}
              icon="play"
              onPress={onStartToday}
              testID="start-today"
              variant="primary"
            >
              开始今日训练
            </Button>
            {today.length > 1 ? (
              <Text tone="secondary" variant="footnote">
                按计划顺序合并；同名动作仍各占一个训练位置。
              </Text>
            ) : null}
          </Card>
        </>
      ) : (
        <EmptyState
          icon="moon"
          text="今天没有排程。可以从全部计划挑一套，或者直接自由训练。"
          title="休息日"
        />
      )}

      {others.length > 0 ? (
        <>
          <SectionHeader title="其他计划" />
          <Card padded={false}>
            {others.map((routine, index) => (
              <View key={routine.id}>
                {index > 0 ? <Divider inset={inset} /> : null}
                {row(routine)}
              </View>
            ))}
          </Card>
        </>
      ) : null}

      <Card padded={false}>
        <ListRow
          chevron
          leading={<IconTile name="bolt" tone="neutral" />}
          onPress={onStartFree}
          subtitle="不套用计划，从动作库开始"
          title="自由训练"
        />
      </Card>

      <Button onPress={onClose} style={{ marginTop: theme.space.md }} variant="secondary">
        取消
      </Button>
    </Screen>
  );
}

export default StartScreen;
