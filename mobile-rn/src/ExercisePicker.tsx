import { useMemo, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { searchCatalogue } from './catalogue';
import { Button, Card, Field, styles } from './ui';
import { type CustomExercise, type Profile, type RoutineExercise } from './training';

export function ExercisePicker({ profile, onPick, onSave, onClose }: {
  profile: Profile; onPick: (exercise: RoutineExercise) => void;
  onSave: (exercise: CustomExercise, create: boolean) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<CustomExercise | null>(null);
  const [name, setName] = useState('');
  const q = query.trim().toLowerCase();
  const matching = useMemo(() => searchCatalogue(q), [q]);
  const custom = (profile.customEx ?? []).filter(exercise => (exercise?.n ?? exercise?.name ?? '').toLowerCase().includes(q));

  function edit(exercise: CustomExercise) {
    setEditing(exercise);
    setName(exercise.n ?? exercise.name ?? '');
  }

  return <ScrollView style={styles.grow} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Button label="返回" secondary onPress={onClose} />
    <Text style={styles.heading}>动作库</Text>
    <Field label="搜索动作" value={query} onChangeText={setQuery} autoCorrect={false} />
    {editing ? <Card>
      <Field label="自定义动作名称" value={name} onChangeText={setName} maxLength={80} />
      <Button label="保存自定义动作" disabled={!name.trim()} onPress={() => {
        const create = !editing.id;
        onSave({ ...editing, id: editing.id || `custom-${randomUUID()}`, n: name.trim() }, create);
        setEditing(null);
      }} />
      <Button label="取消编辑" secondary onPress={() => setEditing(null)} />
    </Card> : <Button label="新建自定义动作" secondary onPress={() => edit({ id: '', bp: 'full body', eq: 'other' })} />}
    {custom.map(exercise => <Card key={exercise.id}>
      <Button label={exercise.n ?? exercise.name ?? exercise.id} secondary
        onPress={() => onPick({ id: exercise.id, mode: exercise.bp === 'cardio' ? 'cardio' : 'reps' })} />
      <Button label="编辑自定义动作" secondary onPress={() => edit(exercise)} />
    </Card>)}
    {matching.map(exercise => <Button key={exercise.id} label={exercise.name} secondary
      onPress={() => onPick({ id: exercise.id, mode: exercise.cardio ? 'cardio' : 'reps' })} />)}
    {custom.length + matching.length === 0 && <Text style={styles.muted}>没有匹配的动作</Text>}
  </ScrollView>;
}
