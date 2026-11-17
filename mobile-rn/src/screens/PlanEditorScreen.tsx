import { useState } from 'react';
import { View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { cleanupSg } from '../../../frontend/src/lib/history';
import { SG_NAME_MAX, supersetMeta } from '../../../frontend/src/lib/superset-meta';
import {
  Button,
  Card,
  EmptyState,
  Header,
  IconButton,
  Screen,
  Segmented,
  Text,
  TextField,
  useTheme,
  type SegmentedOption,
} from '../design';
import { ExerciseLibraryScreen } from './ExerciseLibraryScreen';
import type { Connection } from '../server';
import {
  exerciseMode,
  exerciseName,
  type CustomExercise,
  type Profile,
  type Routine,
  type RoutineExercise,
} from '../training';
import { changeSuperset, exerciseUnits } from '../supersets';

type ExerciseMode = 'reps' | 'time' | 'cardio';

const modes: SegmentedOption<ExerciseMode>[] = [
  { value: 'reps', label: '力量' },
  { value: 'time', label: '计时' },
  { value: 'cardio', label: '有氧' },
];

const amountUnits: Record<ExerciseMode, string> = { reps: '次', time: '秒', cardio: '分钟' };

type PlanSlot = { key: string; exercise: RoutineExercise; sets: string; amount: string; load: string };

/** The editable strings for one slot, derived from the saved exercise. */
function slotFields(exercise: RoutineExercise, profile: Profile) {
  const mode = exerciseMode(exercise, profile);
  return {
    sets: String(exercise.sets ?? 3),
    amount: String(mode === 'cardio' ? exercise.min ?? 20 : mode === 'time' ? exercise.sec ?? 45 : exercise.reps ?? 8),
    load: String(mode === 'cardio' ? exercise.speed ?? 0 : exercise.weight ?? 0),
  };
}

function makeSlot(exercise: RoutineExercise, profile: Profile): PlanSlot {
  return { key: randomUUID(), exercise, ...slotFields(exercise, profile) };
}

function serializeSlot(slot: PlanSlot, profile: Profile): RoutineExercise | null {
  const { exercise, sets, amount, load } = slot;
  const initial = slotFields(exercise, profile);
  if (sets === initial.sets && amount === initial.amount && load === initial.load) return exercise;
  const mode = exerciseMode(exercise, profile);
  const count = Number(sets);
  const number = Number(amount);
  const weight = Number(load.replace(',', '.'));
  if (!Number.isInteger(count) || count < 1 || count > 50 || !load.trim() || !Number.isFinite(weight) || weight < 0 || weight > 5000) return null;
  if (mode === 'reps' ? !/^\d+(?:\s*[-–]\s*\d+)?$/.test(amount) || Number(amount.match(/^\d+/)?.[0]) < 1
    : !Number.isFinite(number) || number <= 0 || (mode === 'time' && !Number.isInteger(number))) return null;
  const { min, sec, reps, speed, weight: oldWeight, ...saved } = exercise;
  return { ...saved, mode, sets: count, ...(mode === 'cardio' ? { min: number, speed: weight }
    : mode === 'time' ? { sec: number, weight } : { reps: Number.isInteger(number) ? number : amount, weight }) };
}

export type PlanEditorScreenProps = {
  profile: Profile;
  routine?: Routine;
  server: string | null;
  connection?: Connection | null;
  onSave: (routine: Routine) => void;
  onCustom: (exercise: CustomExercise, create: boolean) => void;
  onFavorite: (id: string, favourite: boolean) => void;
  onClose: () => void;
};

export function PlanEditorScreen({
  profile,
  routine,
  server,
  connection = null,
  onSave,
  onCustom,
  onFavorite,
  onClose,
}: PlanEditorScreenProps) {
  const theme = useTheme();
  const [name, setName] = useState(routine?.name ?? '');
  const [slots, setSlots] = useState<PlanSlot[]>(() => (routine?.ex ?? []).filter(Boolean).map(exercise => makeSlot(exercise, profile)));
  const [expanded, setExpanded] = useState<string[]>(() => slots.slice(0, 1).map(slot => slot.key));
  const [picking, setPicking] = useState(false);

  const targets = slots.map(slot => slot.exercise);
  const units = exerciseUnits(targets);
  const exercises = slots.map(slot => serializeSlot(slot, profile));
  const saveable = name.trim() !== '' && exercises.length > 0 && exercises.every(exercise => exercise !== null);

  function setSlot(index: number, slot: PlanSlot) {
    setSlots(values => values.map((old, i) => i === index ? slot : old));
  }

  function setGroupFields(unit: number[], fields: Pick<RoutineExercise, 'sgName' | 'sgRest'>) {
    setSlots(values => values.map((slot, index) => unit.includes(index) ? { ...slot, exercise: { ...slot.exercise, ...fields } } : slot));
  }

  function toggle(key: string) {
    setExpanded(values => values.includes(key) ? values.filter(value => value !== key) : [...values, key]);
  }

  function remove(index: number) {
    const key = slots[index]?.key;
    setSlots(values => {
      const remaining = values.filter((_, i) => i !== index).map(item => ({ ...item, exercise: { ...item.exercise } }));
      cleanupSg(remaining.map(item => item.exercise));
      return remaining;
    });
    if (key) setExpanded(values => values.filter(value => value !== key));
  }

  function submit() {
    if (!saveable) return;
    const ex = exercises.flatMap(exercise => exercise ? [{ ...exercise }] : []);
    cleanupSg(ex);
    onSave({ id: routine?.id ?? randomUUID(), name: name.trim(), ex });
  }

  if (picking) {
    return (
      <ExerciseLibraryScreen
        connection={connection}
        onBack={() => setPicking(false)}
        onCustom={onCustom}
        onFavorite={onFavorite}
        onPick={(exercise: RoutineExercise) => {
          const slot = makeSlot(exercise, profile);
          setSlots(values => [...values, slot]);
          setExpanded(values => [...values, slot.key]);
          setPicking(false);
        }}
        profile={profile}
        server={server}
      />
    );
  }

  return (
    <Screen testID="plan-editor-screen">
      <Header
        compact
        onBack={onClose}
        right={(
          <Button disabled={!saveable} onPress={submit} size="sm" variant="primary">
            保存
          </Button>
        )}
        title={routine ? '编辑计划' : '新建计划'}
      />

      <TextField label="计划名称" maxLength={80} onChangeText={setName} value={name} />

      {slots.length === 0 ? (
        <View style={{ marginTop: theme.space.md }}>
          <EmptyState icon="dumbbell" text="从动作库选择动作，把它加入这个计划。" title="还没有动作" />
        </View>
      ) : null}

      {slots.map((slot, index) => {
        const mode = exerciseMode(slot.exercise, profile);
        const unit = units.find(group => group.includes(index))!;
        const grouped = unit.length > 1;
        const groupStart = grouped && unit[0] === index;
        const meta = groupStart ? supersetMeta(targets, unit) : null;
        const open = expanded.includes(slot.key);
        const target = exercises[index];
        const exerciseTitle = exerciseName(profile, slot.exercise.id);
        const amountLabel = amountUnits[mode];
        const loadLabel = mode === 'cardio' ? '速度' : '重量';
        const summary = `${slot.sets} 组 · ${slot.amount} ${amountLabel} · ${loadLabel} ${slot.load}`;
        return (
          <Card key={slot.key} style={index === 0 ? { marginTop: theme.space.md } : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={2} variant="headline">{exerciseTitle}</Text>
                <Text style={{ marginTop: theme.space.xxs }} tone="secondary" variant="footnote">
                  {summary}
                </Text>
              </View>
              <IconButton
                accessibilityLabel={`移除此动作：${exerciseTitle}`}
                name="trash"
                onPress={() => remove(index)}
                size="sm"
                tone="danger"
              />
              <IconButton
                accessibilityLabel={open ? `收起${exerciseTitle}` : `展开${exerciseTitle}`}
                name={open ? 'chevronUp' : 'chevronDown'}
                onPress={() => toggle(slot.key)}
                size="sm"
              />
            </View>

            {open ? (
              <>
                {groupStart ? (
                  <View style={{ gap: theme.space.sm, marginTop: theme.space.sm }}>
                    <Text variant="headline">超级组</Text>
                    <TextField
                      label="超级组名称"
                      maxLength={SG_NAME_MAX}
                      onChangeText={sgName => setGroupFields(unit, { sgName })}
                      value={slot.exercise.sgName ?? meta?.name ?? ''}
                    />
                    <TextField
                      keyboardType="number-pad"
                      label="轮间休息秒数"
                      maxLength={4}
                      onChangeText={text => {
                        if (/^\d*$/.test(text)) setGroupFields(unit, { sgRest: Number(text) });
                      }}
                      placeholder="沿用动作休息设置"
                      value={String(slot.exercise.sgRest || meta?.rest || '')}
                    />
                  </View>
                ) : null}

                <Segmented
                  onChange={next => {
                    const { min, sec, reps, speed, weight, ...rest } = slot.exercise;
                    setSlot(index, { ...makeSlot({ ...rest, mode: next }, profile), key: slot.key });
                  }}
                  options={modes}
                  value={mode}
                />

                <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
                  <TextField
                    containerStyle={{ flex: 1 }}
                    keyboardType="number-pad"
                    label="组数"
                    onChangeText={sets => setSlot(index, { ...slot, sets })}
                    value={slot.sets}
                  />
                  <TextField
                    containerStyle={{ flex: 1 }}
                    keyboardType={mode === 'reps' ? 'default' : 'decimal-pad'}
                    label={amountLabel}
                    onChangeText={amount => setSlot(index, { ...slot, amount })}
                    value={slot.amount}
                  />
                  <TextField
                    containerStyle={{ flex: 1 }}
                    keyboardType="decimal-pad"
                    label={loadLabel}
                    onChangeText={load => setSlot(index, { ...slot, load })}
                    value={slot.load}
                  />
                </View>

                {target === null ? (
                  <Text tone="danger" variant="footnote">
                    请检查该动作的组数、{amountLabel}和{loadLabel}。
                  </Text>
                ) : null}

                {grouped || index > 0 ? (
                  <Button
                    onPress={() => {
                      const next = changeSuperset(targets, index, grouped);
                      setSlots(values => values.map((item, i) => ({ ...item, exercise: next[i] })));
                    }}
                    size="sm"
                    variant="secondary"
                  >
                    {grouped ? '移出超级组' : '与上一动作组成超级组'}
                  </Button>
                ) : null}
              </>
            ) : null}
          </Card>
        );
      })}

      <Button icon="plus" onPress={() => setPicking(true)} variant="tinted">
        添加计划动作
      </Button>

      <Button onPress={onClose} style={{ marginTop: theme.space.md }} variant="secondary">
        取消
      </Button>
    </Screen>
  );
}
