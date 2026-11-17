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
  Stepper,
  Text,
  TextField,
  useTheme,
  type SegmentedOption,
} from '../design';
import { ExerciseLibraryScreen } from './ExerciseLibraryScreen';
import {
  DEFAULT_REST_PAUSE_SEC,
  REST_PAUSE_MAX,
  REST_PAUSE_MIN,
  clampRestPauseSec,
  exerciseMode,
  exerciseName,
  sanitizeIntensifier,
  type CustomExercise,
  type Profile,
  type Routine,
  type RoutineExercise,
  type RoutineIntensifier,
} from '../training';
import { changeSuperset, exerciseUnits } from '../supersets';

type ExerciseMode = 'reps' | 'time' | 'cardio';
type IntensifierKind = 'none' | 'dropset' | 'restpause';

const modes: SegmentedOption<ExerciseMode>[] = [
  { value: 'reps', label: '力量' },
  { value: 'time', label: '计时' },
  { value: 'cardio', label: '有氧' },
];

const intensifiers: SegmentedOption<IntensifierKind>[] = [
  { value: 'none', label: '普通组' },
  { value: 'dropset', label: '递减组' },
  { value: 'restpause', label: '休息暂停' },
];

const amountUnits: Record<ExerciseMode, string> = { reps: '次', time: '秒', cardio: '分钟' };

function integerInput(text: string, min: number, max?: number) {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= min && (max == null || value <= max) ? value : null;
}

function intensifierSummary(intensifier?: RoutineIntensifier) {
  if (intensifier?.type === 'dropset') return `递减 ${intensifier.count} 段 · 每段降 ${intensifier.pct}%`;
  if (intensifier?.type === 'restpause') return `休息暂停 · 总 ${intensifier.totalReps} 次 · 短休 ${intensifier.restSec} 秒`;
  return '';
}

function invalidIntensifier(intensifier?: RoutineIntensifier) {
  if (intensifier?.type === 'dropset') {
    return !Number.isInteger(intensifier.count) || intensifier.count < 1 ||
      !Number.isInteger(intensifier.pct) || intensifier.pct < 5 || intensifier.pct > 90;
  }
  if (intensifier?.type === 'restpause') {
    return !Number.isInteger(intensifier.totalReps) || intensifier.totalReps < 1 ||
      !Number.isInteger(intensifier.restSec) || intensifier.restSec < REST_PAUSE_MIN || intensifier.restSec > REST_PAUSE_MAX;
  }
  return false;
}

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
  const mode = exerciseMode(exercise, profile);
  const { intensifier: _intensifier, ...plain } = exercise;
  const intensifier = mode === 'reps' ? sanitizeIntensifier(exercise.intensifier) : undefined;
  const source = intensifier ? { ...plain, intensifier } : plain;
  return { key: randomUUID(), exercise: source, ...slotFields(source, profile) };
}

function serializeSlot(slot: PlanSlot, profile: Profile): RoutineExercise | null {
  const { exercise, sets, amount, load } = slot;
  const initial = slotFields(exercise, profile);
  if (sets === initial.sets && amount === initial.amount && load === initial.load) return exercise;
  const mode = exerciseMode(exercise, profile);
  const restPause = mode === 'reps' && exercise.intensifier?.type === 'restpause';
  const count = Number(sets);
  const number = Number(amount);
  const weight = Number(load.replace(',', '.'));
  const validCount = Number.isInteger(count) && count >= 1 && count <= 50;
  if ((!validCount && !restPause) || !load.trim() || !Number.isFinite(weight) || weight < 0 || weight > 5000) return null;
  const savedCount = validCount ? count : Math.max(1, Math.trunc(Number(exercise.sets) || 1));
  if (mode === 'reps' ? !/^\d+(?:\s*[-–]\s*\d+)?$/.test(amount) || Number(amount.match(/^\d+/)?.[0]) < 1
    : !Number.isFinite(number) || number <= 0 || (mode === 'time' && !Number.isInteger(number))) return null;
  const { min, sec, reps, speed, weight: oldWeight, ...saved } = exercise;
  if (mode !== 'reps') {
    const { intensifier: _intensifier, ...plain } = saved;
    return { ...plain, mode, sets: savedCount, ...(mode === 'cardio' ? { min: number, speed: weight } : { sec: number, weight }) };
  }
  const intensifier = saved.intensifier;
  if (intensifier?.type === 'dropset' &&
    (!Number.isInteger(intensifier.count) || intensifier.count < 1 || intensifier.pct < 5 || intensifier.pct > 90)) return null;
  if (intensifier?.type === 'restpause' &&
    (!Number.isInteger(intensifier.totalReps) || intensifier.totalReps < 1 ||
      !Number.isInteger(intensifier.restSec) || intensifier.restSec < REST_PAUSE_MIN || intensifier.restSec > REST_PAUSE_MAX)) return null;
  return { ...saved, mode, sets: savedCount, reps: Number.isInteger(number) ? number : amount, weight };
}

export type PlanEditorScreenProps = {
  profile: Profile;
  routine?: Routine;
  server: string | null;
  onSave: (routine: Routine) => void;
  onCustom: (exercise: CustomExercise, create: boolean) => void;
  onClose: () => void;
};

export function PlanEditorScreen({ profile, routine, server, onSave, onCustom, onClose }: PlanEditorScreenProps) {
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
        onBack={() => setPicking(false)}
        onCustom={onCustom}
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
        const intensifier = mode === 'reps' ? slot.exercise.intensifier : undefined;
        const summary = intensifier?.type === 'restpause'
          ? `1 热身 + 1 正式 · 热身 ${slot.amount} 次 · 总 ${intensifier.totalReps} 次 · 短休 ${intensifier.restSec} 秒`
          : `${slot.sets} 组 · ${slot.amount} ${amountLabel} · ${loadLabel} ${slot.load}` +
            (intensifierSummary(intensifier) ? ` · ${intensifierSummary(intensifier)}` : '');
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
                    const { min, sec, reps, speed, weight, intensifier: _intensifier, ...rest } = slot.exercise;
                    setSlot(index, { ...makeSlot({ ...rest, mode: next }, profile), key: slot.key });
                  }}
                  options={modes}
                  value={mode}
                />

                <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
                  {intensifier?.type !== 'restpause' ? (
                    <TextField
                      containerStyle={{ flex: 1 }}
                      keyboardType="number-pad"
                      label="组数"
                      onChangeText={sets => setSlot(index, { ...slot, sets })}
                      value={slot.sets}
                    />
                  ) : null}
                  <TextField
                    containerStyle={{ flex: 1 }}
                    keyboardType={mode === 'reps' ? 'default' : 'decimal-pad'}
                    label={intensifier?.type === 'restpause' ? '热身次数' : amountLabel}
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

                {mode === 'reps' ? (
                  <View style={{ gap: theme.space.sm, marginTop: theme.space.sm }}>
                    <Text variant="headline">高级组</Text>
                    <Segmented
                      onChange={kind => {
                        let next: RoutineIntensifier | undefined;
                        if (kind === 'dropset') {
                          const current = slot.exercise.intensifier;
                          next = {
                            type: 'dropset',
                            count: current?.type === 'dropset' ? current.count : 2,
                            pct: current?.type === 'dropset' ? current.pct : 20,
                          };
                        } else if (kind === 'restpause') {
                          const current = slot.exercise.intensifier;
                          next = {
                            type: 'restpause',
                            totalReps: current?.type === 'restpause' ? current.totalReps : 12,
                            restSec: current?.type === 'restpause'
                              ? current.restSec
                              : clampRestPauseSec(profile.restPauseSec ?? DEFAULT_REST_PAUSE_SEC),
                          };
                        }
                        if (next) setSlot(index, { ...slot, exercise: { ...slot.exercise, intensifier: next } });
                        else {
                          const { intensifier: _intensifier, ...exercise } = slot.exercise;
                          setSlot(index, { ...slot, exercise });
                        }
                      }}
                      options={intensifiers}
                      value={intensifier?.type ?? 'none'}
                    />
                    {intensifier?.type === 'dropset' ? (
                      <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
                        <Stepper
                          accessibilityLabel="降重段数"
                          keyboardType="number-pad"
                          min={1}
                          onChangeText={text => {
                            const value = integerInput(text, 1);
                            if (value != null) setSlot(index, {
                              ...slot,
                              exercise: { ...slot.exercise, intensifier: { ...intensifier, count: value } },
                            });
                          }}
                          step={1}
                          unit="段"
                          value={String(intensifier.count)}
                        />
                        <Stepper
                          accessibilityLabel="每段降重百分比"
                          keyboardType="number-pad"
                          max={90}
                          min={5}
                          onChangeText={text => {
                            const value = integerInput(text, 5, 90);
                            if (value != null) setSlot(index, {
                              ...slot,
                              exercise: { ...slot.exercise, intensifier: { ...intensifier, pct: value } },
                            });
                          }}
                          step={5}
                          unit="%"
                          value={String(intensifier.pct)}
                        />
                      </View>
                    ) : null}
                    {intensifier?.type === 'restpause' ? (
                      <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
                        <Stepper
                          accessibilityLabel="休息暂停总次数"
                          keyboardType="number-pad"
                          min={1}
                          onChangeText={text => {
                            const value = integerInput(text, 1);
                            if (value != null) setSlot(index, {
                              ...slot,
                              exercise: { ...slot.exercise, intensifier: { ...intensifier, totalReps: value } },
                            });
                          }}
                          step={1}
                          unit="次"
                          value={String(intensifier.totalReps)}
                        />
                        <Stepper
                          accessibilityLabel="休息暂停短休秒数"
                          keyboardType="number-pad"
                          max={REST_PAUSE_MAX}
                          min={REST_PAUSE_MIN}
                          onChangeText={text => {
                            const value = integerInput(text, REST_PAUSE_MIN, REST_PAUSE_MAX);
                            if (value != null) setSlot(index, {
                              ...slot,
                              exercise: { ...slot.exercise, intensifier: { ...intensifier, restSec: value } },
                            });
                          }}
                          step={5}
                          unit="秒"
                          value={String(intensifier.restSec)}
                        />
                      </View>
                    ) : null}
                    {intensifier ? (
                      <Text tone="secondary" variant="footnote">
                        {intensifier.type === 'dropset'
                          ? `每个正式组之后追加 ${intensifier.count} 段降重，每段约轻 ${intensifier.pct}%。`
                          : `只生成一组热身和一组正式组，总 ${intensifier.totalReps} 次按短休拆成下降分段。`}
                      </Text>
                    ) : null}
                    {intensifier && invalidIntensifier(intensifier) ? (
                      <Text tone="danger" variant="footnote">
                        请检查高级组的段数、降幅、总次数或短休，短休需在 5–300 秒之间。
                      </Text>
                    ) : null}
                  </View>
                ) : null}

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
