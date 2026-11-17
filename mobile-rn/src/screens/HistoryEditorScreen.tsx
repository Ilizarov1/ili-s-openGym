import { useState } from 'react';
import { View } from 'react-native';
import { workoutVolume } from '../../../frontend/src/lib/history';
import { Button, Card, Header, Screen, Text, TextField, useTheme } from '../design';
import { exerciseName, validWorkoutDay, type LoggedSet, type Profile, type Unit, type Workout } from '../training';

function moveTime(time: number, day: string) {
  const date = new Date(time);
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  date.setFullYear(year, month - 1, dayOfMonth);
  return date.getTime();
}

export type HistoryEditorScreenProps = {
  workout: Workout;
  profile: Profile;
  unit: Unit;
  onSave: (patch: Partial<Workout>) => void;
  onClose: () => void;
};

export function HistoryEditorScreen({ workout, profile, unit, onSave, onClose }: HistoryEditorScreenProps) {
  const theme = useTheme();
  const [name, setName] = useState(workout.name || '训练');
  const [day, setDay] = useState(workout.d);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});

  function save() {
    if (!name.trim() || !validWorkoutDay(day)) {
      setError('请填写训练名称和有效日期。');
      return;
    }
    const originalEntries = (workout.entries ?? []).filter(Boolean);
    const entries = originalEntries.map((entry, ei) => {
      const sets = entry.sets.map((set, si) => {
        const next = { ...set };
        for (const key of ['w', 'r', 'sec', 'min', 'speed'] as const) {
          const field = fields[`${ei}-${si}-${key}`];
          if (field === undefined) continue;
          const value = Number(field.replace(',', '.'));
          const count = key === 'r' || key === 'sec';
          if (!field.trim() || !Number.isFinite(value) || value < 0 || (count && (!Number.isInteger(value) || value < 1)) ||
              (key === 'min' && value <= 0)) throw new Error('请检查各组的重量、次数或时长。');
          next[key] = value;
        }
        return next;
      });
      const topW = Math.max(0, ...sets.filter(set => set.done && set.phase !== 'warmup' && !set.warmup).map(set => set.w ?? 0));
      return { ...entry, sets, topW: topW || null };
    });
    const patch: Partial<Workout> = { _ts: Math.max(Date.now(), (workout._ts ?? 0) + 1) };
    if (name.trim() !== workout.name) patch.name = name.trim();
    if (day !== workout.d) {
      patch.d = day;
      const datedStart = Number.isFinite(workout.start) ? moveTime(workout.start, day) : new Date(`${day}T12:00:00`).getTime();
      const duration = Number.isFinite(workout.end - workout.start) ? Math.max(0, workout.end - workout.start) : 0;
      patch.start = Math.min(datedStart, Date.now());
      patch.end = Math.min(patch.start + duration, Date.now());
      entries.forEach((entry, ei) => entry.sets.forEach((set, si) => {
        const at = originalEntries[ei].sets[si].at;
        if (at != null && Number.isFinite(workout.start)) {
          set.at = Math.min(patch.end!, patch.start! + Math.max(0, at - workout.start));
        }
      }));
    }
    if (day !== workout.d || Object.keys(fields).length) {
      patch.entries = entries;
      patch.vol = workoutVolume({ ...workout, entries }, { warmups: profile.volumeWarmups === true,
        bodyweight: profile.volumeBodyweight === true ? workout.bw ?? 0 : 0 });
    }
    onSave(patch);
  }

  function numberField(ei: number, si: number, key: keyof LoggedSet, value: number | undefined, label: string) {
    if (value == null) return null;
    const id = `${ei}-${si}-${key}`;
    return (
      <TextField
        containerStyle={{ flex: 1 }}
        keyboardType="decimal-pad"
        key={id}
        label={label}
        onChangeText={text => setFields(previous => ({ ...previous, [id]: text }))}
        value={fields[id] ?? String(value)}
      />
    );
  }

  return (
    <Screen testID="history-editor-screen">
      <Header compact onBack={onClose} title="编辑训练记录" />

      <TextField label="训练名称" maxLength={80} onChangeText={setName} value={name} />
      <TextField
        containerStyle={{ marginTop: theme.space.md }}
        label="训练日期"
        maxLength={10}
        onChangeText={setDay}
        placeholder="YYYY-MM-DD"
        value={day}
      />

      {(workout.entries ?? []).filter(Boolean).map((entry, ei) => (
        <Card key={ei} style={{ marginTop: theme.space.md }}>
          <Text variant="headline">{exerciseName(profile, entry.id)}</Text>
          {entry.sets.map((set, si) => set.done && !('sides' in set) ? (
            <View
              key={si}
              style={{ alignItems: 'flex-end', flexDirection: 'row', gap: theme.space.sm }}
            >
              <Text style={{ marginBottom: theme.space.sm }} tone="secondary" variant="subhead">
                {si + 1}
              </Text>
              {numberField(ei, si, 'w', set.w, unit)}
              {numberField(ei, si, 'r', set.r, '次数')}
              {numberField(ei, si, 'sec', set.sec, '秒')}
              {numberField(ei, si, 'min', set.min, '分钟')}
              {numberField(ei, si, 'speed', set.speed, '速度')}
            </View>
          ) : null)}
        </Card>
      ))}

      {error ? (
        <Text style={{ marginBottom: theme.space.sm }} tone="danger" variant="footnote">
          {error}
        </Text>
      ) : null}

      <Button
        onPress={() => {
          setError('');
          try {
            save();
          } catch (err) {
            setError(err instanceof Error ? err.message : '无法保存训练。');
          }
        }}
        variant="primary"
      >
        保存训练修改
      </Button>

      <Button onPress={onClose} style={{ marginTop: theme.space.sm }} variant="secondary">
        取消
      </Button>
    </Screen>
  );
}
