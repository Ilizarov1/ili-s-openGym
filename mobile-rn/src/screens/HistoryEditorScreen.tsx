import { useState } from 'react';
import { View } from 'react-native';
import { workoutVolume } from '../../../frontend/src/lib/history';
import { isWarmupRow } from '../../../frontend/src/lib/workout-model';
import { Button, Card, Header, Screen, Text, TextField, useTheme } from '../design';
import { EffortSheet } from '../EffortSheet';
import {
  convertedEffortOf,
  derivedEffortOf,
  editorScaleFor,
  effortPreferenceOf,
  formatEffort,
  isCardioEntry,
  savedEffortOf,
  scaleName,
} from '../effort';
import {
  exerciseName,
  validWorkoutDay,
  type LoggedSet,
  type Profile,
  type RatingScale,
  type Unit,
  type Workout,
} from '../training';

type Rating = { scale: RatingScale; value: number };
type RatingSheet = { key: string; scale: RatingScale; value: number | null; cardio: boolean };

/** Ratings shown on open: profile scale when known, else the row's own saved scale. */
function initialRatings(workout: Workout, profile: Profile): Record<string, Rating | null> {
  const preference = effortPreferenceOf(profile);
  const ratings: Record<string, Rating | null> = {};
  (workout.entries ?? []).filter(Boolean).forEach((entry, ei) => {
    (entry.sets ?? []).forEach((set, si) => {
      if (!set?.done || 'sides' in set) return;
      if (!savedEffortOf(set)) return;
      const cardio = isCardioEntry(entry, set);
      const scale = editorScaleFor(preference, cardio, set);
      if (!scale) return;
      const value = convertedEffortOf(set, scale);
      if (value != null) ratings[`${ei}-${si}`] = { scale, value };
    });
  });
  return ratings;
}

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
  const [ratings, setRatings] = useState<Record<string, Rating | null>>(() => initialRatings(workout, profile));
  const [sheet, setSheet] = useState<RatingSheet | null>(null);
  const preference = effortPreferenceOf(profile);

  function save() {
    if (!name.trim() || !validWorkoutDay(day)) {
      setError('请填写训练名称和有效日期。');
      return;
    }
    const originalEntries = (workout.entries ?? []).filter(Boolean);
    const ratingsDirty = Object.entries(ratings).some(([key, rating]) => {
      const [ei, si] = key.split('-').map(Number);
      const saved = savedEffortOf(originalEntries[ei]?.sets?.[si]);
      if (rating == null) return saved != null;
      return !saved || saved.scale !== rating.scale || saved.value !== rating.value;
    });
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
        // Ratings are rewritten only in the editor and only when the user saves.
        // Clearing removes both keys, and saving one scale removes the other, so a
        // row never carries RPE and RIR at the same time.
        const rating = ratings[`${ei}-${si}`];
        if (rating !== undefined) {
          delete next.rpe;
          delete next.rir;
          if (rating) next[rating.scale] = Math.round(rating.value * 10) / 10;
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
    if (day !== workout.d || Object.keys(fields).length || ratingsDirty) {
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

  function effortRow(entry: (typeof workout.entries)[number], set: LoggedSet, ei: number, si: number) {
    // Per-side rows keep their own values and unknown fields: writing one aggregate
    // rating here would copy a single score onto both sides.
    if (!set.done || 'sides' in set) return null;
    const key = `${ei}-${si}`;
    const saved = savedEffortOf(set);
    const keyed = Object.prototype.hasOwnProperty.call(ratings, key);
    const local = keyed ? ratings[key] : undefined;
    const cardio = isCardioEntry(entry, set);
    const scale = local?.scale ?? editorScaleFor(preference, cardio, set);
    const derived = local == null && !saved && derivedEffortOf(set) != null;
    // New ratings only make sense on strength working reps or cardio. A row that
    // already carries a rating (even an old warm-up) stays editable so it can be
    // corrected or cleared; a warm-up never gets a fresh entry point.
    const canRate = scale != null && (
      saved != null || local != null || (!isWarmupRow(set) && (set.r != null || cardio))
    );
    const conversion = local && saved && local.scale !== saved.scale
      ? `原 ${scaleName(saved.scale)} ${formatEffort(saved.value)}，保存后按 ${scaleName(local.scale)} ${formatEffort(local.value)} 写入。`
      : '';
    const removed = keyed && local === null && saved != null;
    if (!canRate && !derived && !conversion && !removed) return null;
    const label = local ? `${scaleName(local.scale)} ${formatEffort(local.value)}` : '未评分';
    return (
      <View style={{ alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        {canRate && scale ? (
          <Button
            accessibilityLabel={`第 ${si + 1} 组评分 ${label}`}
            icon="gauge"
            onPress={() => setSheet({
              key,
              scale: local?.scale ?? scale,
              value: local?.value ?? null,
              cardio,
            })}
            size="xs"
            testID={`history-effort-${ei}-${si}`}
            variant={local ? 'tinted' : 'secondary'}
          >
            {local ? label : `${scaleName(scale)} ${label}`}
          </Button>
        ) : null}
        {derived ? (
          <Text tone="secondary" variant="footnote">力竭标记按 RIR 0 显示，未写入评分。</Text>
        ) : null}
        {conversion ? (
          <Text tone="secondary" variant="footnote">{conversion}</Text>
        ) : null}
        {removed ? (
          <Text tone="secondary" variant="footnote">保存后清除这组评分。</Text>
        ) : null}
      </View>
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
            <View key={si} style={{ gap: theme.space.xs }}>
              <View style={{ alignItems: 'flex-end', flexDirection: 'row', gap: theme.space.sm }}>
                <Text style={{ marginBottom: theme.space.sm }} tone="secondary" variant="subhead">
                  {si + 1}
                </Text>
                {numberField(ei, si, 'w', set.w, unit)}
                {numberField(ei, si, 'r', set.r, '次数')}
                {numberField(ei, si, 'sec', set.sec, '秒')}
                {numberField(ei, si, 'min', set.min, '分钟')}
                {numberField(ei, si, 'speed', set.speed, '速度')}
              </View>
              {effortRow(entry, set, ei, si)}
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

      {sheet ? (
        <EffortSheet
          cardio={sheet.cardio}
          onClear={() => {
            setRatings(previous => ({ ...previous, [sheet.key]: null }));
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
          onSave={value => {
            setRatings(previous => ({ ...previous, [sheet.key]: { scale: sheet.scale, value } }));
            setSheet(null);
          }}
          scale={sheet.scale}
          value={sheet.value}
          visible
        />
      ) : null}
    </Screen>
  );
}
