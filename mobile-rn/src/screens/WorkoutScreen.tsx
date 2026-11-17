import { useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { ScrollView, View } from 'react-native';
import {
  ActionSheet,
  Button,
  Card,
  Header,
  Icon,
  IconButton,
  PressableScale,
  Screen,
  Stepper,
  Text,
  TextField,
  useTheme,
} from '../design';
import { changeSuperset, exerciseUnits, nextSupersetSet, supersetRestSeconds } from '../supersets';
import { RestTimer, resolveRestSeconds } from '../restTimer';
import { supersetMeta } from '../../../frontend/src/lib/superset-meta';
import {
  MAX_WORK_SETS,
  addWorkSet,
  backupExerciseIds,
  exerciseName,
  removeSet,
  swapExercise,
  updateSet,
  validSet,
  validWorkoutDay,
  type Draft,
  type Profile,
  type QueuedWorkout,
} from '../training';

export type WorkoutScreenProps = {
  profile: Profile;
  draft: Draft;
  queue: QueuedWorkout[];
  e2e?: boolean;
  onChange: (draft: Draft) => boolean;
  onFinish: () => void;
  onDiscard: () => void;
  onPick: (replaceIndex?: number) => void;
};

type MenuItem = NonNullable<ComponentProps<typeof ActionSheet>['items']>[number];
type Menu = { kind: 'workout' } | { kind: 'exercise'; index: number } | null;

const NUMBER_COLUMN = 30;

function formatElapsed(millis: number) {
  const total = Math.max(0, Math.floor(millis / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const tail = `${minutes}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : tail;
}

function useElapsed(start: number, frozen: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (frozen) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [start, frozen]);
  return frozen ? '0:01' : formatElapsed(now - start);
}

/**
 * Its own component so the one-second tick repaints the label, not the set rows.
 * The "用时" prefix also keeps the header clock out of the `m:ss` shape the rest
 * countdown is matched by in the Android regression.
 */
function Elapsed({ start, frozen }: { start: number; frozen: boolean }) {
  const elapsed = useElapsed(start, frozen);
  return <Text tone="secondary" variant="footnote">用时 {elapsed}</Text>;
}

export function WorkoutScreen({ profile, draft, queue, e2e = false, onChange, onFinish, onDiscard, onPick }: WorkoutScreenProps) {
  const theme = useTheme();
  const list = useRef<ScrollView>(null);
  const positions = useRef(new Map<number, number>());
  const [menu, setMenu] = useState<Menu>(null);

  const targets = draft.exercises.map(exercise => exercise.target);
  const units = exerciseUnits(targets);
  const groups = units.flatMap(unit => {
    const nextSet = unit.length > 1 ? nextSupersetSet(draft, unit) : undefined;
    return unit.map(() => ({ unit, nextSet }));
  });
  const done = draft.exercises.reduce((total, exercise) => total + exercise.sets.filter(set => set.at !== null).length, 0);
  const canFinish = done > 0 && (draft.backfillDay == null || (draft.name.trim() !== '' && validWorkoutDay(draft.backfillDay)));

  function groupActionLabel(index: number, grouped: boolean) {
    return grouped ? '移出超级组' : index > 0 ? '与上一动作组成超级组' : '';
  }

  function exerciseMenuItems(index: number): MenuItem[] {
    const exercise = draft.exercises[index];
    if (!exercise) return [];
    const { unit } = groups[index];
    const grouped = unit.length > 1;
    const affected = grouped ? unit : [...(groups[index - 1]?.unit ?? []), index];
    const canGroup = affected.every(row => draft.exercises[row].sets.every(set => set.at === null));
    const completed = exercise.sets.some(set => set.at !== null);
    const items: MenuItem[] = [];
    if (!completed) {
      items.push({ label: '搜索替换动作', icon: 'magnifier', onPress: () => onPick(index) });
    }
    if ((grouped || index > 0) && canGroup) {
      items.push({
        label: groupActionLabel(index, grouped),
        icon: grouped ? 'xmark' : 'link',
        onPress: () => {
          const updated = changeSuperset(targets, index, grouped);
          onChange({ ...draft, exercises: draft.exercises.map((entry, row) => ({ ...entry, target: updated[row] })) });
        },
      });
    }
    return items;
  }

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']} scroll={false} testID="workout-screen">
      <View style={{ paddingHorizontal: theme.layout.pagePadding }}>
        <Header
          compact
          right={(
            <>
              <Elapsed start={draft.start} frozen={e2e} />
              <Button disabled={!canFinish} onPress={onFinish} size="sm" variant="primary">
                完成训练
              </Button>
              <IconButton
                accessibilityLabel="训练菜单"
                name="more"
                onPress={() => setMenu({ kind: 'workout' })}
                size="sm"
              />
            </>
          )}
          title={draft.name}
        />
      </View>

      <ScrollView
        contentContainerStyle={{
          gap: theme.space.md,
          paddingHorizontal: theme.layout.pagePadding,
          paddingBottom: theme.space.xxxl,
        }}
        keyboardShouldPersistTaps="handled"
        ref={list}
        style={{ flex: 1 }}
      >
        {draft.backfillDay != null ? (
          <Card gap={theme.space.sm} style={{ marginBottom: 0 }}>
            <TextField
              label="补录名称"
              maxLength={80}
              onChangeText={name => onChange({ ...draft, name })}
              value={draft.name}
            />
            <TextField
              label="补录日期"
              maxLength={10}
              onChangeText={backfillDay => onChange({ ...draft, backfillDay })}
              placeholder="YYYY-MM-DD"
              value={draft.backfillDay}
            />
          </Card>
        ) : null}

        <Text tone="secondary" variant="footnote">已完成 {done} 组</Text>

        {draft.exercises.map((exercise, exerciseIndex) => {
          const name = exerciseName(profile, exercise.target.id);
          const { unit, nextSet } = groups[exerciseIndex];
          const grouped = unit.length > 1;
          const groupStart = grouped && unit[0] === exerciseIndex;
          const groupName = groupStart ? supersetMeta(targets, unit).name : '';
          const affected = grouped ? unit : [...(groups[exerciseIndex - 1]?.unit ?? []), exerciseIndex];
          const canGroup = affected.every(index => draft.exercises[index].sets.every(set => set.at === null));
          const completed = exercise.sets.some(set => set.at !== null);
          const mode = exercise.target.mode;
          const weightLabel = mode === 'cardio' ? '速度' : '重量';
          const amountLabel = mode === 'cardio' ? '分钟' : mode === 'time' ? '秒' : '次数';
          const replacements = backupExerciseIds(exercise.target, profile);
          const actions = exerciseMenuItems(exerciseIndex);

          return (
            <View
              key={exerciseIndex}
              onLayout={event => positions.current.set(exerciseIndex, event.nativeEvent.layout.y)}
            >
              <Card gap={theme.space.sm} style={{ marginBottom: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.sm }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    {groupStart ? (
                      <Text tone="accent" variant="footnote">
                        {groupName ? `超级组 · ${groupName}` : '超级组'}
                      </Text>
                    ) : null}
                    <Text numberOfLines={2} variant="headline">{name}</Text>
                    {nextSet?.exerciseIndex === exerciseIndex ? (
                      <Text style={{ marginTop: theme.space.xxs }} tone="secondary" variant="footnote">
                        {nextSet.round === null ? `下一组 · ${name}热身` : `第 ${nextSet.round + 1} 轮 · 下一组 ${name}`}
                      </Text>
                    ) : null}
                  </View>
                  <IconButton
                    accessibilityLabel={`${name}菜单`}
                    disabled={actions.length === 0}
                    name="more"
                    onPress={() => setMenu({ kind: 'exercise', index: exerciseIndex })}
                    size="sm"
                  />
                </View>

                {exercise.target.side ? (
                  <Text tone="secondary" variant="footnote">次数填写双侧合计。</Text>
                ) : null}

                {replacements.length > 0 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
                    {replacements.map(id => (
                      <Button
                        disabled={completed}
                        key={id}
                        onPress={() => onChange(swapExercise(draft, exerciseIndex, id, profile, queue))}
                        size="sm"
                        variant="secondary"
                      >
                        替换为 {exerciseName(profile, id)}
                      </Button>
                    ))}
                  </View>
                ) : null}

                <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
                  <Text style={{ width: NUMBER_COLUMN }} tone="tertiary" variant="caption">组</Text>
                  <Text style={{ flex: 1 }} tone="tertiary" variant="caption">
                    {weightLabel === '重量' ? `重量 · ${draft.unit}` : weightLabel}
                  </Text>
                  <Text style={{ flex: 1 }} tone="tertiary" variant="caption">{amountLabel}</Text>
                  <View style={{ width: theme.sizes.tileSm }} />
                  <View style={{ width: theme.sizes.tileMd }} />
                </View>

                {exercise.sets.map((set, setIndex) => {
                  const complete = set.at !== null;
                  const valid = validSet(set, mode);
                  const available = valid && (!grouped || complete ||
                    (nextSet?.exerciseIndex === exerciseIndex && nextSet.setIndex === setIndex));
                  const number = exercise.sets.slice(0, setIndex + 1).filter(row => !!row.warmup === !!set.warmup).length;
                  const label = set.warmup ? `热身第 ${number} 组` : `第 ${number} 组`;
                  const controlLabel = grouped ? `${name} ${label}` : label;
                  const controlsRest = draft.rest?.exerciseIndex === exerciseIndex && draft.rest.setIndex === setIndex;
                  const editSet = (changes: { weight?: string; reps?: string }) => {
                    const edited = updateSet(draft, exerciseIndex, setIndex, { ...changes, at: null });
                    onChange(controlsRest ? { ...edited, rest: null } : edited);
                  };
                  const toggleSet = () => {
                    const at = complete ? null : Date.now();
                    const next = updateSet(draft, exerciseIndex, setIndex, { at });
                    if (at === null) {
                      onChange(controlsRest ? { ...next, rest: null } : next);
                      return;
                    }
                    const hasRemainingSets = next.exercises.some(entry => entry.sets.some(row => row.at === null));
                    const round = nextSet?.round;
                    const seconds = hasRemainingSets && draft.backfillDay == null
                      ? round != null && grouped
                        ? supersetRestSeconds(next, unit, round, resolveRestSeconds(undefined, profile.restSec))
                        : resolveRestSeconds(exercise.target, profile.restSec)
                      : 0;
                    const rest = seconds > 0 ? { endsAt: at + seconds * 1000, exerciseIndex, setIndex } : null;
                    if (onChange({ ...next, rest }) && grouped) {
                      const upcoming = nextSupersetSet(next, unit);
                      if (upcoming && upcoming.exerciseIndex !== exerciseIndex) requestAnimationFrame(() => {
                        const y = positions.current.get(upcoming.exerciseIndex);
                        if (y != null) list.current?.scrollTo({ y, animated: true });
                      });
                    }
                  };

                  return (
                    <View
                      key={set.key ?? String(setIndex)}
                      style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}
                    >
                      <Text
                        numberOfLines={1}
                        style={{ width: NUMBER_COLUMN }}
                        tone={complete ? 'tertiary' : 'secondary'}
                        variant="footnote"
                      >
                        {set.warmup ? '热身' : number}
                      </Text>
                      <View style={{ flex: 1 }}>
                        <Stepper
                          accessibilityLabel={`${controlLabel}${weightLabel}`}
                          keyboardType="decimal-pad"
                          min={0}
                          onChangeText={weight => editSet({ weight })}
                          step={mode === 'cardio' ? 0.5 : 2.5}
                          value={set.weight}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Stepper
                          accessibilityLabel={`${controlLabel}${amountLabel}`}
                          keyboardType={mode === 'cardio' ? 'decimal-pad' : 'number-pad'}
                          min={0}
                          onChangeText={reps => editSet({ reps })}
                          step={mode === 'time' ? 5 : 1}
                          value={set.reps}
                        />
                      </View>
                      <PressableScale
                        accessibilityLabel={`${controlLabel}完成`}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: complete, disabled: !available }}
                        disabled={!available}
                        hitSlop={theme.space.xs}
                        onPress={toggleSet}
                        scaleTo={theme.motion.pressScaleSmall}
                        style={{
                          alignItems: 'center',
                          backgroundColor: complete ? theme.colors.accent : theme.colors.surface2,
                          borderRadius: theme.radius.sm,
                          height: theme.sizes.tileSm,
                          justifyContent: 'center',
                          width: theme.sizes.tileSm,
                        }}
                      >
                        <Icon
                          color={complete ? theme.colors.onAccent : theme.colors.label3}
                          name="check"
                          size={18}
                        />
                      </PressableScale>
                      {complete ? <View style={{ width: theme.sizes.tileMd }} /> : (
                        <IconButton
                          accessibilityLabel={`删除${controlLabel}`}
                          name="xmark"
                          onPress={() => onChange(removeSet(draft, exerciseIndex, setIndex))}
                          size="sm"
                        />
                      )}
                    </View>
                  );
                })}

                <Button
                  disabled={exercise.sets.filter(set => !set.warmup).length >= MAX_WORK_SETS}
                  icon="plus"
                  onPress={() => onChange(addWorkSet(draft, exerciseIndex))}
                  size="sm"
                  variant="secondary"
                >
                  添加正式组
                </Button>

                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
                  <Button
                    disabled={completed}
                    onPress={() => onPick(exerciseIndex)}
                    size="sm"
                    variant="secondary"
                  >
                    搜索替换动作
                  </Button>
                  {grouped || exerciseIndex > 0 ? (
                    <Button
                      disabled={!canGroup}
                      onPress={() => {
                        const updated = changeSuperset(targets, exerciseIndex, grouped);
                        onChange({ ...draft, exercises: draft.exercises.map((entry, index) => ({ ...entry, target: updated[index] })) });
                      }}
                      size="sm"
                      variant="secondary"
                    >
                      {groupActionLabel(exerciseIndex, grouped)}
                    </Button>
                  ) : null}
                </View>
              </Card>
            </View>
          );
        })}

        <Button icon="plus" onPress={() => onPick()} variant="secondary">
          添加动作
        </Button>
        <Button onPress={onDiscard} variant="danger">
          放弃训练
        </Button>
      </ScrollView>

      <RestTimer endsAt={draft.rest?.endsAt ?? null} frozen={e2e} onCancel={() => onChange({ ...draft, rest: null })} />

      <ActionSheet
        items={[{ label: '放弃训练', icon: 'trash', tone: 'danger', onPress: onDiscard }]}
        onClose={() => setMenu(null)}
        title={draft.name}
        visible={menu?.kind === 'workout'}
      />
      <ActionSheet
        items={menu?.kind === 'exercise' ? exerciseMenuItems(menu.index) : []}
        onClose={() => setMenu(null)}
        title={menu?.kind === 'exercise' ? exerciseName(profile, draft.exercises[menu.index]?.target.id ?? '') : undefined}
        visible={menu?.kind === 'exercise'}
      />
    </Screen>
  );
}

export default WorkoutScreen;
