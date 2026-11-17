// Plan tab: the weekly schedule and the routine list share one screen behind a
// segmented control. Rows open the editors; routine actions live in an
// ActionSheet so a row never turns into a stack of full-width buttons.

import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
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
  MiniBodyMap,
  Screen,
  SectionHeader,
  Segmented,
  Text,
  space,
  useTheme,
} from '../design';
import type { Profile, Routine } from '../training';
import type { Connection } from '../server';

export type PlanScreenProps = {
  profile: Profile;
  connection: Connection | null;
  onCreate: () => void;
  onEdit: (routine: Routine) => void;
  onDelete: (routine: Routine) => void;
  onStart: (routine: Routine) => void;
  onSchedule: () => void;
};

type PlanView = 'schedule' | 'routines';

const VIEW_OPTIONS: { value: PlanView; label: string }[] = [
  { value: 'schedule', label: '日程' },
  { value: 'routines', label: '训练计划' },
];

/** Monday-first order of `Date#getDay()` values; `profile.week` uses those keys. */
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  trailing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  hint: {
    marginBottom: space.md,
  },
  footerButton: {
    marginTop: space.xs,
  },
});

export function PlanScreen({
  profile,
  connection,
  onCreate,
  onEdit,
  onDelete,
  onStart,
  onSchedule,
}: PlanScreenProps) {
  const theme = useTheme();
  const [view, setView] = useState<PlanView>('schedule');
  const [menu, setMenu] = useState<Routine | null>(null);

  const routines = (profile.routines ?? []).filter(Boolean);
  const rotationMode = profile.scheduleMode === 'rotation' || profile.queue != null;
  const rotationSequence = (profile.rotation?.sequence ?? []).filter(
    id => id === 'rest' || routines.some(routine => routine.id === id),
  );
  const queueIds = profile.queue?.ids ?? [];
  const today = new Date().getDay();

  const scheduledRoutines = (day: number): Routine[] => {
    const value = profile.week?.[String(day)];
    const ids = typeof value === 'string' ? [value] : value ?? [];
    return routines.filter(routine => ids.includes(routine.id));
  };
  const closeMenu = () => setMenu(null);

  return (
    <Screen testID="plan-screen">
      <Header
        right={connection ? undefined : <Badge tone="neutral">本机练习</Badge>}
        subtitle="你的每周安排"
        title="计划"
      />

      <Segmented
        onChange={setView}
        options={VIEW_OPTIONS}
        style={{ marginBottom: theme.space.lg }}
        testID="plan-segmented"
        value={view}
      />

      {routines.length === 0 ? (
        <EmptyState
          icon={view === 'schedule' ? 'calendar' : 'dumbbell'}
          text={view === 'schedule' ? '先新建一套计划，再安排到每周或轮换。' : '新建一套计划，安排动作、组数和重量。'}
          title="还没有训练计划"
        >
          <Button icon="plus" onPress={onCreate} variant="primary">
            新建计划
          </Button>
        </EmptyState>
      ) : view === 'routines' ? (
        <>
          <View style={[styles.actions, { marginBottom: theme.space.md }]}>
            <Button icon="plus" onPress={onCreate} size="sm" variant="tinted">
              新训练日
            </Button>
            <Button icon="calendar" onPress={onSchedule} size="sm" variant="secondary">
              训练排程
            </Button>
          </View>

          {routines.map(routine => (
            <Card key={routine.id} padded={false}>
              <ListRow
                chevron
                leading={<IconTile name="dumbbell" />}
                onPress={() => onEdit(routine)}
                subtitle={`${(routine.ex ?? []).filter(Boolean).length} 个动作`}
                title={routine.name}
                trailing={
                  <View style={styles.trailing}>
                    <MiniBodyMap routines={[routine]} />
                    <IconButton
                      accessibilityLabel={`${routine.name} 更多操作`}
                      name="more"
                      onPress={() => setMenu(routine)}
                      size="sm"
                    />
                  </View>
                }
              />
            </Card>
          ))}
        </>
      ) : (
        <>
          <SectionHeader
            action={rotationMode ? <Badge tone="accent">轮换模式</Badge> : undefined}
            title="本周安排"
          />
          <Card padded={false}>
            {WEEKDAY_ORDER.map((day, index) => {
              const list = scheduledRoutines(day);
              const isToday = day === today;
              return (
                <View key={day}>
                  {index > 0 ? (
                    <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
                  ) : null}
                  <ListRow
                    chevron
                    leading={<IconTile name="calendar" size="sm" tone={isToday ? 'accent' : 'neutral'} />}
                    onPress={onSchedule}
                    subtitle={isToday ? `${WEEKDAY_NAMES[day]} · 今天` : WEEKDAY_NAMES[day]}
                    title={list.length > 0 ? list.map(routine => routine.name).join(' + ') : '休息'}
                  />
                </View>
              );
            })}
          </Card>
          {rotationMode ? (
            <Text style={styles.hint} tone="secondary" variant="footnote">
              轮换模式下按轮换顺序训练，上面的每周安排只作参考。
            </Text>
          ) : null}

          {rotationMode ? (
            <>
              <SectionHeader title="轮换顺序" />
              {rotationSequence.length > 0 ? (
                <Card padded={false}>
                  {rotationSequence.map((id, index) => (
                    <View key={`${id}-${index}`}>
                      {index > 0 ? (
                        <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
                      ) : null}
                      <ListRow
                        chevron
                        leading={
                          <IconTile
                            name={id === 'rest' ? 'moon' : 'repeat'}
                            size="sm"
                            tone={id === 'rest' ? 'neutral' : 'soft'}
                          />
                        }
                        onPress={onSchedule}
                        subtitle={`第 ${index + 1} 项`}
                        title={id === 'rest' ? '休息日' : routines.find(routine => routine.id === id)?.name ?? id}
                        trailing={queueIds.includes(id) ? <Badge tone="accent">本轮</Badge> : undefined}
                      />
                    </View>
                  ))}
                </Card>
              ) : (
                <Text style={styles.hint} tone="secondary" variant="footnote">
                  还没有设置轮换顺序，打开排程编辑添加训练。
                </Text>
              )}
            </>
          ) : null}

          <Button icon="calendar" onPress={onSchedule} style={styles.footerButton} variant="primary">
            编辑排程
          </Button>
        </>
      )}

      <ActionSheet
        items={
          menu
            ? [
                {
                  label: '开始训练',
                  icon: 'play',
                  tone: 'accent',
                  onPress: () => {
                    const routine = menu;
                    closeMenu();
                    onStart(routine);
                  },
                },
                {
                  label: '编辑计划',
                  icon: 'pencil',
                  onPress: () => {
                    const routine = menu;
                    closeMenu();
                    onEdit(routine);
                  },
                },
                {
                  label: '删除计划',
                  icon: 'trash',
                  tone: 'danger',
                  onPress: () => {
                    const routine = menu;
                    closeMenu();
                    onDelete(routine);
                  },
                },
              ]
            : []
        }
        onClose={closeMenu}
        title={menu?.name ?? ''}
        visible={menu !== null}
      />
    </Screen>
  );
}
