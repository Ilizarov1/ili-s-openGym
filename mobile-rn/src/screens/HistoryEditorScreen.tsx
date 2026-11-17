import { useState } from 'react';
import { View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { isWarmupRow, nextBurstReps, nextDropWeight } from '../../../frontend/src/lib/workout-model';
import { dropGrid } from '../../../frontend/src/lib/plates';
import { Button, Card, Header, IconButton, Screen, Text, TextField, useTheme } from '../design';
import {
  exerciseName,
  exerciseRestPauseSec,
  validClusterSegment,
  validDropSegment,
  validWorkoutDay,
  type HistorySave,
  type LoggedSet,
  type Profile,
  type Unit,
  type Workout,
  type WorkoutEntry,
} from '../training';

function moveTime(time: number, day: string) {
  const date = new Date(time);
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  date.setFullYear(year, month - 1, dayOfMonth);
  return date.getTime();
}

type EditDrop = { key: string; w: string; r: string };
type EditCluster = { key: string; r: string; restSec: string };
type EditSet = {
  key: string;
  original: LoggedSet;
  dirty: boolean;
  drops: EditDrop[];
  clusters: EditCluster[];
};
type EditEntry = { key: string; entry: WorkoutEntry; sets: EditSet[] };

function localEntries(workout: Workout): EditEntry[] {
  return (workout.entries ?? []).filter(Boolean).map(entry => ({
    key: randomUUID(),
    entry,
    sets: (entry.sets ?? []).map(set => ({
      key: randomUUID(),
      original: { ...set },
      dirty: false,
      drops: !isWarmupRow(set) && set.type === 'dropset' && Array.isArray(set.drops)
        ? set.drops.map(drop => ({ key: randomUUID(), w: String(drop.w ?? 0), r: String(drop.r ?? 0) }))
        : [],
      clusters: !isWarmupRow(set) && set.type === 'restpause' && Array.isArray(set.clusters)
        ? set.clusters.map(cluster => ({
          key: randomUUID(), r: String(cluster.r ?? 0), restSec: String(cluster.restSec ?? 15),
        }))
        : [],
    })),
  }));
}

function numberIn(text: string) {
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : Number.NaN;
}

/** Read-only per-side line for records written by the Web client, kept as they are. */
function sideLine(set: LoggedSet, unit: Unit) {
  const describe = (side: LoggedSet | undefined, label: string) => {
    if (!side) return '';
    let text = `${label}${side.w ?? 0} ${unit} × ${side.r ?? 0}`;
    if (side.drops?.length) text += side.drops.map(drop => ` ↘ ${drop.w ?? 0} ${unit} × ${drop.r ?? 0}`).join('');
    if (side.clusters?.length) text += `（${side.clusters.map(cluster => cluster.r ?? 0).join(' + ')}）`;
    return text;
  };
  return [describe(set.sides?.L, 'L '), describe(set.sides?.R, 'R ')].filter(Boolean).join(' · ');
}

export type HistoryEditorScreenProps = {
  workout: Workout;
  profile: Profile;
  unit: Unit;
  onSave: (change: HistorySave) => void;
  onClose: () => void;
};

export function HistoryEditorScreen({ workout, profile, unit, onSave, onClose }: HistoryEditorScreenProps) {
  const theme = useTheme();
  const [name, setName] = useState(workout.name || '训练');
  const [day, setDay] = useState(workout.d);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [local, setLocal] = useState<EditEntry[]>(() => localEntries(workout));

  function markDirty(setKey: string) {
    setLocal(entries => entries.map(entry => ({
      ...entry,
      sets: entry.sets.map(set => set.key === setKey ? { ...set, dirty: true } : set),
    })));
  }

  function changeField(setKey: string, key: keyof LoggedSet, value: string) {
    setFields(previous => ({ ...previous, [`${setKey}-${key}`]: value }));
    markDirty(setKey);
  }

  function originalValue(set: EditSet, key: keyof LoggedSet) {
    const field = fields[`${set.key}-${key}`];
    if (field !== undefined) return field;
    const value = set.original[key];
    return value == null ? '' : String(value);
  }

  function currentReps(set: EditSet) {
    return Math.max(0, Math.trunc(numberIn(originalValue(set, 'r'))));
  }

  function addDrop(entry: EditEntry, set: EditSet) {
    const base = set.drops.length ? numberIn(set.drops[set.drops.length - 1].w) : numberIn(originalValue(set, 'w'));
    const pct = entry.entry.target?.intensifier?.type === 'dropset' ? entry.entry.target.intensifier.pct : 20;
    const weight = nextDropWeight(Number.isFinite(base) ? base : 0, pct,
      dropGrid({ ...profile, unit }, { ...(entry.entry.target ?? {}), id: entry.entry.id }));
    const reps = Math.max(1, currentReps(set)) || 8;
    setLocal(entries => entries.map(row => row.key === entry.key ? {
      ...row,
      sets: row.sets.map(item => item.key === set.key ? {
        ...item,
        dirty: true,
        drops: [...item.drops, { key: randomUUID(), w: String(weight), r: String(reps) }],
      } : item),
    } : row));
  }

  function addCluster(entry: EditEntry, set: EditSet) {
    const restSec = String(exerciseRestPauseSec(entry.entry.target, profile));
    const base = set.clusters.length ? numberIn(set.clusters[set.clusters.length - 1].r) : currentReps(set);
    if (!(base > 0)) return;
    const added = Math.max(1, nextBurstReps(base));
    const clusters = set.clusters.length
      ? [...set.clusters, { key: randomUUID(), r: String(added), restSec }]
      : [
        { key: randomUUID(), r: String(Math.trunc(base)), restSec },
        { key: randomUUID(), r: String(added), restSec },
      ];
    setLocal(entries => entries.map(row => row.key === entry.key ? {
      ...row,
      sets: row.sets.map(item => item.key === set.key ? { ...item, dirty: true, clusters } : item),
    } : row));
  }

  function removeDrop(entry: EditEntry, set: EditSet, index: number) {
    setLocal(entries => entries.map(row => row.key === entry.key ? {
      ...row,
      sets: row.sets.map(item => item.key === set.key ? {
        ...item, dirty: true, drops: item.drops.filter((_, drop) => drop !== index),
      } : item),
    } : row));
  }

  function removeCluster(entry: EditEntry, set: EditSet, index: number) {
    const remaining = set.clusters.filter((_, cluster) => cluster !== index);
    if (remaining.length > 1) {
      setLocal(entries => entries.map(row => row.key === entry.key ? {
        ...row,
        sets: row.sets.map(item => item.key === set.key ? { ...item, dirty: true, clusters: remaining } : item),
      } : row));
      return;
    }
    // One or none left: the row reads as an ordinary set again, keeping the last segment's reps.
    const reps = remaining.length
      ? numberIn(remaining[0].r)
      : numberIn(set.clusters[index]?.r ?? originalValue(set, 'r'));
    setFields(previous => ({ ...previous, [`${set.key}-r`]: String(Math.max(1, Math.trunc(reps) || 1)) }));
    setLocal(entries => entries.map(row => row.key === entry.key ? {
      ...row,
      sets: row.sets.map(item => item.key === set.key ? { ...item, dirty: true, clusters: [] } : item),
    } : row));
  }

  function changeDrop(entry: EditEntry, set: EditSet, index: number, key: 'w' | 'r', value: string) {
    setLocal(entries => entries.map(row => row.key === entry.key ? {
      ...row,
      sets: row.sets.map(item => item.key === set.key ? {
        ...item,
        dirty: true,
        drops: item.drops.map((drop, dropIndex) => dropIndex === index ? { ...drop, [key]: value } : drop),
      } : item),
    } : row));
  }

  function changeCluster(entry: EditEntry, set: EditSet, index: number, key: 'r' | 'restSec', value: string) {
    setLocal(entries => entries.map(row => row.key === entry.key ? {
      ...row,
      sets: row.sets.map(item => item.key === set.key ? {
        ...item,
        dirty: true,
        clusters: item.clusters.map((cluster, clusterIndex) => clusterIndex === index ? { ...cluster, [key]: value } : cluster),
      } : item),
    } : row));
  }

  function clearSegments(entry: EditEntry, set: EditSet) {
    if (set.clusters.length) {
      const reps = set.clusters.reduce((total, cluster) => {
        const value = numberIn(cluster.r);
        return total + (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
      }, 0);
      setFields(previous => ({ ...previous, [`${set.key}-r`]: String(Math.max(1, reps)) }));
    }
    setLocal(entries => entries.map(row => row.key === entry.key ? {
      ...row,
      sets: row.sets.map(item => item.key === set.key ? { ...item, dirty: true, drops: [], clusters: [] } : item),
    } : row));
  }

  function serializeSet(set: EditSet, dayChanged: boolean, start: number, end: number): LoggedSet {
    if (!set.dirty) {
      const out = { ...set.original };
      if (dayChanged && out.at != null && Number.isFinite(workout.start)) {
        out.at = Math.min(end, start + Math.max(0, out.at - workout.start));
      }
      return out;
    }
    const out: LoggedSet = { ...set.original };
    for (const key of ['w', 'r', 'sec', 'min', 'speed'] as const) {
      const id = `${set.key}-${key}`;
      if (fields[id] === undefined) continue;
      const text = fields[id];
      const value = Number(text.replace(',', '.'));
      const count = key === 'r' || key === 'sec';
      if (!text.trim() || !Number.isFinite(value) || value < 0 || (count && (!Number.isInteger(value) || value < 1)) ||
          (key === 'min' && value <= 0) || (key === 'w' && value > 5000)) {
        throw new Error('请检查各组的重量、次数或时长。');
      }
      (out as Record<string, number>)[key] = value;
    }
    if (set.drops.length) {
      if (!set.drops.every(validDropSegment)) throw new Error('请检查递减段的重量和次数。');
      out.type = 'dropset';
      out.drops = set.drops.map(drop => ({ w: numberIn(drop.w), r: Math.trunc(numberIn(drop.r)) }));
      delete out.clusters;
    } else if (set.clusters.length) {
      if (!set.clusters.every(validClusterSegment)) throw new Error('请检查休息暂停各分段的次数和短休。');
      out.type = 'restpause';
      out.clusters = set.clusters.map(cluster => ({
        r: Math.trunc(numberIn(cluster.r)),
        restSec: Math.round(numberIn(cluster.restSec)),
      }));
      out.r = out.clusters.reduce((total, cluster) => total + (cluster.r ?? 0), 0);
      delete out.drops;
    } else {
      delete out.type;
      delete out.drops;
      delete out.clusters;
    }
    if (dayChanged && out.at != null && Number.isFinite(workout.start)) {
      out.at = Math.min(end, start + Math.max(0, out.at - workout.start));
    }
    return out;
  }

  function save() {
    if (!name.trim() || !validWorkoutDay(day)) {
      setError('请填写训练名称和有效日期。');
      return;
    }
    const dayChanged = day !== workout.d;
    const start = dayChanged
      ? Math.min(Number.isFinite(workout.start) ? moveTime(workout.start, day) : new Date(`${day}T12:00:00`).getTime(), Date.now())
      : workout.start;
    const duration = Number.isFinite(workout.end - workout.start) ? Math.max(0, workout.end - workout.start) : 0;
    const end = dayChanged ? Math.min(start + duration, Date.now()) : workout.end;
    const base = (workout.entries ?? []).filter(Boolean);
    const entries = local.map(item => ({
      ...item.entry,
      sets: item.sets.map(set => serializeSet(set, dayChanged, start, end)),
    }));
    const patch: Partial<Workout> = { _ts: Math.max(Date.now(), (workout._ts ?? 0) + 1) };
    if (name.trim() !== workout.name) patch.name = name.trim();
    if (dayChanged) {
      patch.d = day;
      patch.start = start;
      patch.end = end;
    }
    onSave({ patch, base, entries });
  }

  const fieldsFor = (set: EditSet, key: keyof LoggedSet, label: string) => {
    const id = `${set.key}-${key}`;
    const value = fields[id] ?? originalValue(set, key);
    if (fields[id] === undefined && value === '') return null;
    return (
      <TextField
        containerStyle={{ flex: 1 }}
        keyboardType="decimal-pad"
        key={id}
        label={label}
        onChangeText={text => changeField(set.key, key, text)}
        value={value}
      />
    );
  };

  const segmentTotal = (set: EditSet) => set.clusters.reduce((total, cluster) => {
    const value = numberIn(cluster.r);
    return total + (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
  }, 0);

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

      {local.map(item => (
        <Card key={item.key} style={{ marginTop: theme.space.md }}>
          <Text variant="headline">{exerciseName(profile, item.entry.id)}</Text>
          {item.sets.map((set, index) => {
            if (!set.original.done) return null;
            if ('sides' in set.original) return (
              <Text key={set.key} style={{ marginTop: theme.space.sm }} tone="secondary" variant="footnote">
                {`${index + 1} · ${sideLine(set.original, unit)}`}
              </Text>
            );
            return (
              <View key={set.key} style={{ gap: theme.space.sm, marginTop: theme.space.sm }}>
                <View style={{ alignItems: 'flex-end', flexDirection: 'row', gap: theme.space.sm }}>
                <Text style={{ marginBottom: theme.space.sm }} tone="secondary" variant="subhead">
                  {index + 1}
                </Text>
                {fieldsFor(set, 'w', unit)}
                {set.clusters.length ? (
                  <View style={{ flex: 1, marginBottom: theme.space.sm }}>
                    <Text tone="secondary" variant="footnote">{`总 ${segmentTotal(set)} 次`}</Text>
                  </View>
                ) : fieldsFor(set, 'r', '次数')}
                {fieldsFor(set, 'sec', '秒')}
                {fieldsFor(set, 'min', '分钟')}
                {fieldsFor(set, 'speed', '速度')}
              </View>

              {set.drops.map((drop, dropIndex) => (
                <View key={drop.key} style={{ alignItems: 'flex-end', flexDirection: 'row', gap: theme.space.sm }}>
                  <Text style={{ marginBottom: theme.space.sm }} tone="secondary" variant="caption">
                    {`递减${dropIndex + 1}`}
                  </Text>
                  <TextField
                    containerStyle={{ flex: 1 }}
                    keyboardType="decimal-pad"
                    label={unit}
                    onChangeText={value => changeDrop(item, set, dropIndex, 'w', value)}
                    value={drop.w}
                  />
                  <TextField
                    containerStyle={{ flex: 1 }}
                    keyboardType="number-pad"
                    label="次数"
                    onChangeText={value => changeDrop(item, set, dropIndex, 'r', value)}
                    value={drop.r}
                  />
                  <IconButton
                    accessibilityLabel={`删除递减${dropIndex + 1}`}
                    name="xmark"
                    onPress={() => removeDrop(item, set, dropIndex)}
                    size="sm"
                  />
                </View>
              ))}

              {set.clusters.map((cluster, clusterIndex) => (
                <View key={cluster.key} style={{ alignItems: 'flex-end', flexDirection: 'row', gap: theme.space.sm }}>
                  <Text style={{ marginBottom: theme.space.sm }} tone="secondary" variant="caption">
                    {`分段${clusterIndex + 1}`}
                  </Text>
                  <TextField
                    containerStyle={{ flex: 1 }}
                    keyboardType="number-pad"
                    label="次数"
                    onChangeText={value => changeCluster(item, set, clusterIndex, 'r', value)}
                    value={cluster.r}
                  />
                  <TextField
                    containerStyle={{ flex: 1 }}
                    keyboardType="number-pad"
                    label="短休秒"
                    onChangeText={value => changeCluster(item, set, clusterIndex, 'restSec', value)}
                    value={cluster.restSec}
                  />
                  <IconButton
                    accessibilityLabel={`删除分段${clusterIndex + 1}`}
                    name="xmark"
                    onPress={() => removeCluster(item, set, clusterIndex)}
                    size="sm"
                  />
                </View>
              ))}

              {set.original.r != null && !isWarmupRow(set.original) ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
                  {!set.clusters.length ? (
                    <Button
                      icon="arrowDown"
                      onPress={() => addDrop(item, set)}
                      size="xs"
                      variant="ghost"
                    >
                      {set.drops.length ? '添加递减段' : '改为递减组'}
                    </Button>
                  ) : null}
                  {!set.drops.length ? (
                    <Button
                      icon="bolt"
                      onPress={() => addCluster(item, set)}
                      size="xs"
                      variant="ghost"
                    >
                      {set.clusters.length ? '添加分段' : '改为休息暂停'}
                    </Button>
                  ) : null}
                  {set.drops.length || set.clusters.length ? (
                    <Button
                      onPress={() => clearSegments(item, set)}
                      size="xs"
                      variant="danger"
                    >
                      恢复普通组
                    </Button>
                  ) : null}
                </View>
              ) : null}
            </View>
            );
          })}
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

export default HistoryEditorScreen;
