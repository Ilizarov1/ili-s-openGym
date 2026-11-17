import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { cleanupSg } from '../../frontend/src/lib/history';
import { SG_NAME_MAX, supersetMeta } from '../../frontend/src/lib/superset-meta';
import { Button, Card, Field, styles } from './ui';
import { ExercisePicker } from './ExercisePicker';
import { exerciseMode, exerciseName, type CustomExercise, type Profile, type Routine, type RoutineExercise } from './training';
import type { ProfileChange } from './profileChanges';
import { changeSuperset, exerciseUnits } from './supersets';

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const modes = { reps: '力量', time: '计时', cardio: '有氧' } as const;

type PlanSlot = { exercise: RoutineExercise; sets: string; amount: string; load: string };

function makeSlot(exercise: RoutineExercise, profile: Profile): PlanSlot {
  const mode = exerciseMode(exercise, profile);
  return {
    exercise, sets: String(exercise.sets ?? 3),
    amount: String(mode === 'cardio' ? exercise.min ?? 20 : mode === 'time' ? exercise.sec ?? 45 : exercise.reps ?? 8),
    load: String(mode === 'cardio' ? exercise.speed ?? 0 : exercise.weight ?? 0),
  };
}

function serializeSlot(slot: PlanSlot, profile: Profile): RoutineExercise | null {
  const { exercise, sets, amount, load } = slot;
  const initial = makeSlot(exercise, profile);
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

export function PlanEditor({ profile, routine, onSave, onCustom, onClose }: {
  profile: Profile; routine?: Routine; onSave: (routine: Routine) => void;
  onCustom: (exercise: CustomExercise, create: boolean) => void; onClose: () => void;
}) {
  const [name, setName] = useState(routine?.name ?? '');
  const [slots, setSlots] = useState(() => (routine?.ex ?? []).filter(Boolean).map(exercise => makeSlot(exercise, profile)));
  const [picking, setPicking] = useState(false);
  const targets = slots.map(slot => slot.exercise);
  const units = exerciseUnits(targets);
  const exercises = slots.map(slot => serializeSlot(slot, profile));
  const saveable = name.trim() && exercises.length > 0 && exercises.every(exercise => exercise !== null);
  const setSlot = (index: number, slot: PlanSlot) => setSlots(values => values.map((old, i) => i === index ? slot : old));
  const setGroupFields = (unit: number[], fields: Pick<RoutineExercise, 'sgName' | 'sgRest'>) =>
    setSlots(values => values.map((slot, index) => unit.includes(index) ? { ...slot, exercise: { ...slot.exercise, ...fields } } : slot));

  if (picking) return <ExercisePicker profile={profile} onSave={onCustom} onClose={() => setPicking(false)}
    onPick={exercise => { setSlots(values => [...values, makeSlot(exercise, profile)]); setPicking(false); }} />;

  return <ScrollView style={styles.grow} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.heading}>{routine ? '编辑计划' : '新建计划'}</Text>
    <Field label="计划名称" value={name} onChangeText={setName} maxLength={80} />
    {slots.map((slot, index) => {
      const mode = exerciseMode(slot.exercise, profile);
      const unit = units.find(group => group.includes(index))!;
      const grouped = unit.length > 1;
      const groupStart = grouped && unit[0] === index;
      const meta = groupStart ? supersetMeta(targets, unit) : null;
      return <Card key={index}>
        {groupStart && <View style={styles.stack}>
          <Text style={styles.title}>超级组</Text>
          <Field label="超级组名称" value={slot.exercise.sgName ?? meta?.name ?? ''} onChangeText={sgName => setGroupFields(unit, { sgName })} maxLength={SG_NAME_MAX} />
          <Field label="轮间休息秒数" placeholder="沿用动作休息设置" value={String(slot.exercise.sgRest || meta?.rest || '')} maxLength={4}
            keyboardType="number-pad" onChangeText={text => { if (/^\d*$/.test(text)) setGroupFields(unit, { sgRest: Number(text) }); }} />
        </View>}
        <Text style={styles.title}>{exerciseName(profile, slot.exercise.id)} · {modes[mode]}</Text>
        <View style={styles.row}>
          {Object.entries(modes).map(([key, title]) => <Button key={key} label={title} secondary disabled={key === mode}
            onPress={() => {
              const { min, sec, reps, speed, weight, ...target } = slot.exercise;
              setSlot(index, makeSlot({ ...target, mode: key }, profile));
            }} />)}
        </View>
        <View style={styles.row}>
          <Field label="组数" value={slot.sets} onChangeText={sets => setSlot(index, { ...slot, sets })} keyboardType="number-pad" />
          <Field label={mode === 'reps' ? '次数' : mode === 'time' ? '秒' : '分钟'} value={slot.amount}
            onChangeText={amount => setSlot(index, { ...slot, amount })} keyboardType={mode === 'reps' ? 'default' : 'decimal-pad'} />
          <Field label={mode === 'cardio' ? '速度' : '重量'} value={slot.load} onChangeText={load => setSlot(index, { ...slot, load })} keyboardType="decimal-pad" />
        </View>
        {(grouped || index > 0) && <Button label={grouped ? '移出超级组' : '与上一动作组成超级组'} secondary onPress={() => {
          const next = changeSuperset(targets, index, grouped);
          setSlots(values => values.map((item, i) => ({ ...item, exercise: next[i] })));
        }} />}
        <Button label="移除此动作" secondary onPress={() => setSlots(values => {
          const remaining = values.filter((_, i) => i !== index).map(item => ({ ...item, exercise: { ...item.exercise } }));
          cleanupSg(remaining.map(item => item.exercise));
          return remaining;
        })} />
      </Card>;
    })}
    <Button label="添加计划动作" secondary onPress={() => setPicking(true)} />
    <Button label="保存计划" disabled={!saveable} onPress={() => {
      if (!saveable) return;
      const ex = exercises.flatMap(exercise => exercise ? [{ ...exercise }] : []);
      cleanupSg(ex);
      onSave({ id: routine?.id ?? randomUUID(), name: name.trim(), ex });
    }} />
    <Button label="取消" secondary onPress={onClose} />
  </ScrollView>;
}

export function ScheduleEditor({ profile, onSave, onClose }: {
  profile: Profile; onSave: (value: ProfileChange) => void; onClose: () => void;
}) {
  const [mode, setMode] = useState(profile.scheduleMode === 'rotation' ? 'rotation' : 'week');
  const [day, setDay] = useState(new Date().getDay());
  const scheduled = profile.week?.[String(day)];
  const currentWeek = typeof scheduled === 'string' ? [scheduled] : scheduled ?? [];
  const initial = mode === 'week' ? currentWeek : profile.rotation?.sequence ?? [];
  const [selection, setSelection] = useState<null | string[]>(null);
  const ids = selection ?? initial;
  const routines = (profile.routines ?? []).filter(Boolean);
  return <ScrollView style={styles.grow} contentContainerStyle={styles.content}>
    <Text style={styles.heading}>训练排程</Text>
    <View style={styles.row}>
      <Button label="每周" secondary disabled={mode === 'week'} onPress={() => { setMode('week'); setSelection(null); }} />
      <Button label="轮换" secondary disabled={mode === 'rotation'} onPress={() => { setMode('rotation'); setSelection(null); }} />
    </View>
    {mode === 'week' ? <View style={[styles.row, { flexWrap: 'wrap' }]}>
      {weekdays.map((label, index) => <Button key={label} label={label} secondary disabled={index === day}
        onPress={() => { setDay(index); setSelection(null); }} />)}
    </View> : <Text style={styles.muted}>按点击顺序轮换。取消一项再添加，可以把它移到末尾。</Text>}
    {mode === 'rotation' && ids.length > 0 && <Text style={styles.text}>{ids.map(id => routines.find(routine => routine.id === id)?.name ?? id).join(' → ')}</Text>}
    {routines.map(routine => <Button key={routine.id} secondary label={`${ids.includes(routine.id) ? '✓ ' : ''}${routine.name}`}
      onPress={() => setSelection(ids.includes(routine.id) ? ids.filter(id => id !== routine.id) : [...ids, routine.id])} />)}
    <Button label={mode === 'week' ? '保存当天排程' : '保存轮换'} disabled={mode === 'rotation' && ids.length === 0}
      onPress={() => onSave(mode === 'week' ? { kind: 'week', day, ids }
        : { kind: 'rotation', key: profile.rotation?.id ?? randomUUID(), ids, at: Date.now() })} />
    {profile.scheduleMode === 'rotation' && <Button label="启用每周排程" secondary
      onPress={() => onSave({ kind: 'rotation', key: profile.rotation?.id ?? '', ids: [], at: Date.now() })} />}
    <Button label="返回" secondary onPress={onClose} />
  </ScrollView>;
}
