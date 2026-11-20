import { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  Button,
  Card,
  Icon,
  IconButton,
  PressableScale,
  Stepper,
  Text,
  useTheme,
} from '../design';
import {
  REST_PAUSE_MAX,
  REST_PAUSE_MIN,
  draftSegmentDone,
  dropSetProgress,
  exerciseMode,
  exerciseName,
  nextDraftSegment,
  validSet,
  validSetSegments,
  type Draft,
  type Profile,
  type RatingScale,
} from '../training';
import { draftEffortOf, effortPreferenceOf, formatEffort, scaleName } from '../effort';
import { nextSupersetSet } from '../supersets';
import { SetField } from './WorkoutSetField';

type FocusSet = { exerciseIndex: number; setIndex: number };

export type FocusToggleOptions = { focus?: boolean; nextExercise?: number };

export type WorkoutFocusViewProps = {
  profile: Profile;
  draft: Draft;
  unit: number[];
  currentIndex: number;
  canPrevUnit: boolean;
  canNextUnit: boolean;
  onToggle: (exerciseIndex: number, setIndex: number, options?: FocusToggleOptions) => void;
  onWeight: (exerciseIndex: number, setIndex: number, value: string) => void;
  onReps: (exerciseIndex: number, setIndex: number, value: string) => void;
  onDrop: (exerciseIndex: number, setIndex: number, dropIndex: number, changes: { w?: string; r?: string }) => void;
  onCluster: (
    exerciseIndex: number,
    setIndex: number,
    clusterIndex: number,
    changes: { r?: string; restSec?: string },
  ) => void;
  onRate: (
    exerciseIndex: number,
    setIndex: number,
    scale: RatingScale,
    value: number | null,
    cardio: boolean,
  ) => void;
  onOpenExercise: (exerciseIndex: number) => void;
  onAddSet: (exerciseIndex: number) => void;
  onNavigateUnit: (direction: 1 | -1) => void;
};

function setNumberAt(sets: Draft['exercises'][number]['sets'], index: number) {
  const set = sets[index];
  return sets.slice(0, index + 1).filter(row => !!row.warmup === !!set?.warmup).length;
}

/**
 * Focus shows one set at a time. The visible-set pointer is local to the screen:
 * it starts on the current exercise's first unfinished set, is discarded when the
 * unit changes, and is never written to the draft. Completion still runs through
 * WorkoutScreen's shared toggle, so rest, superset flow and completion handling
 * are the same as every other layout.
 */
export function WorkoutFocusView({
  profile,
  draft,
  unit,
  currentIndex,
  canPrevUnit,
  canNextUnit,
  onToggle,
  onWeight,
  onReps,
  onDrop,
  onCluster,
  onRate,
  onOpenExercise,
  onAddSet,
  onNavigateUnit,
}: WorkoutFocusViewProps) {
  const theme = useTheme();
  const [pointer, setPointer] = useState<FocusSet | null>(null);
  const unitKey = unit.join('-');

  useEffect(() => {
    setPointer(null);
  }, [unitKey]);

  if (!unit.length) return null;

  const anchor = unit.includes(currentIndex) ? currentIndex : unit[0];
  const anchorEntry = draft.exercises[anchor];
  const anchorOpen = anchorEntry?.sets.findIndex(row => row.at === null) ?? -1;
  const fallbackSetIndex = anchorOpen >= 0
    ? anchorOpen
    : Math.max(0, (anchorEntry?.sets.length ?? 1) - 1);
  const stored = pointer && unit.includes(pointer.exerciseIndex) &&
    draft.exercises[pointer.exerciseIndex]?.sets[pointer.setIndex]
    ? pointer
    : null;
  const selected = stored ?? { exerciseIndex: anchor, setIndex: fallbackSetIndex };
  const entry = draft.exercises[selected.exerciseIndex];
  const set = entry?.sets[selected.setIndex];
  if (!entry || !set) return null;

  const grouped = unit.length > 1;
  const mode = exerciseMode(entry.target, profile);
  const weightLabel = mode === 'cardio' ? '速度' : '重量';
  const amountLabel = mode === 'cardio' ? '分钟' : mode === 'time' ? '秒'
    : set.type === 'restpause' ? '总次数' : '次数';
  const number = setNumberAt(entry.sets, selected.setIndex);
  const setLabel = set.warmup ? `热身第 ${number} 组` : `第 ${number} 组`;
  const firstOpen = entry.sets.findIndex(row => row.at === null);
  const firstOpenLabel = firstOpen >= 0 ? setNumberAt(entry.sets, firstOpen) : null;
  const complete = set.at !== null;
  const locked = !complete && firstOpen >= 0 && selected.setIndex > firstOpen;
  const readOnly = complete || locked;
  const segmentsValid = validSetSegments(set);
  const valid = validSet(set, mode) && segmentsValid;
  const nextSet = grouped ? nextSupersetSet(draft, unit) : undefined;
  const turn = !grouped || complete ||
    (nextSet?.exerciseIndex === selected.exerciseIndex && nextSet.setIndex === selected.setIndex);
  const dropsetProgress = set.type === 'dropset' ? dropSetProgress(set) : null;
  const dropsetNext = set.type === 'dropset' ? nextDraftSegment(set) : null;
  const dropsetDone = dropsetProgress?.done ?? 0;
  const dropsetTotal = dropsetProgress?.total ?? 0;
  const dropsetComplete = dropsetProgress?.complete ?? false;
  const dropsetNextIsLast = dropsetProgress != null &&
    !dropsetComplete && dropsetDone >= dropsetTotal - 1;
  const dropsetActionLabel = dropsetNextIsLast ? '完成' : '完成下一段';
  const dropsetMainDone = set.type === 'dropset' && draftSegmentDone(set, 'main');
  const canComplete = !complete && valid && turn && (set.type !== 'dropset' || dropsetNext !== null);
  const sequence: FocusSet[] = Array.from(
    { length: Math.max(0, ...unit.map(index => draft.exercises[index]?.sets.length ?? 0)) },
    (_, setIndex) => unit
      .filter(index => draft.exercises[index]?.sets[setIndex])
      .map(exerciseIndex => ({ exerciseIndex, setIndex })),
  ).flat();
  const sequenceIndex = sequence.findIndex(item =>
    item.exerciseIndex === selected.exerciseIndex && item.setIndex === selected.setIndex);
  const effort = effortPreferenceOf(profile);
  const ratingScale: RatingScale | null = effort === 'none'
    ? null
    : mode === 'cardio' ? 'rpe' : mode === 'reps' ? effort : null;
  const setScale = set.effortScale ?? ratingScale;
  const ratingValue = setScale ? draftEffortOf(set, setScale) : null;
  const ratingLabel = setScale
    ? ratingValue == null
      ? `${scaleName(setScale)} 未评分`
      : `${scaleName(setScale)} ${formatEffort(ratingValue)}`
    : '';
  const drops = set.type === 'dropset' ? set.drops ?? [] : [];
  const clusters = set.type === 'restpause' ? set.clusters ?? [] : [];

  const selectSequence = (index: number) => {
    const item = sequence[index];
    if (item) setPointer(item);
  };
  const selectSet = (index: number) => {
    if (index >= 0 && index < entry.sets.length) {
      setPointer({ exerciseIndex: selected.exerciseIndex, setIndex: index });
    }
  };
  const skip = () => {
    if (selected.setIndex < entry.sets.length - 1) selectSet(selected.setIndex + 1);
  };
  const completeSet = () => {
    const upcoming = sequence[sequenceIndex + 1];
    // A dropset can need several presses; focus stays on it until the press that
    // finishes the whole set, so the next segment can be ticked without navigating.
    const finishesSet = set.type !== 'dropset' || dropsetNextIsLast;
    if (finishesSet) setPointer(upcoming ?? null);
    onToggle(selected.exerciseIndex, selected.setIndex, {
      focus: true,
      nextExercise: finishesSet ? upcoming?.exerciseIndex : undefined,
    });
  };

  return (
    <Card gap={theme.space.sm} style={{ marginBottom: 0 }}>
      {grouped ? (
        <View style={{ gap: theme.space.xxs }}>
          <Text tone="accent" variant="footnote">
            {`超级组 · ${unit.map(index => exerciseName(profile, draft.exercises[index].target.id)).join(' + ')}`}
          </Text>
          <Text tone="secondary" variant="footnote">
            {`第 ${selected.setIndex + 1} 组 · 动作 ${unit.indexOf(selected.exerciseIndex) + 1}/${unit.length}`}
          </Text>
        </View>
      ) : null}

      <View style={{ alignItems: 'flex-start', flexDirection: 'row', gap: theme.space.sm }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={2} variant="title3">
            {exerciseName(profile, entry.target.id)}
          </Text>
          <Text style={{ marginTop: theme.space.xxs }} tone="secondary" variant="footnote">
            {setLabel}
          </Text>
        </View>
        <IconButton
          accessibilityLabel={`${exerciseName(profile, entry.target.id)}菜单`}
          name="more"
          onPress={() => onOpenExercise(selected.exerciseIndex)}
          size="sm"
        />
      </View>

      {locked && firstOpenLabel != null ? (
        <Text tone="secondary" variant="footnote">
          {`先完成第 ${firstOpenLabel} 组才能输入；这一组可以浏览。`}
        </Text>
      ) : null}
      {complete ? (
        <Text tone="secondary" variant="footnote">
          已完成组只能在卡片、列表或紧凑布局中更正，可在训练菜单切换布局。
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
        <View style={{ flex: 1, gap: theme.space.xs }}>
          <Text tone="tertiary" variant="caption">
            {weightLabel === '重量' ? `重量 · ${draft.unit}` : weightLabel}
          </Text>
          <SetField
            accessibilityLabel={`${setLabel}${weightLabel}`}
            disabled={readOnly}
            field="weight"
            keyboardType="decimal-pad"
            min={0}
            mode={mode}
            onChangeText={value => onWeight(selected.exerciseIndex, selected.setIndex, value)}
            step={mode === 'cardio' ? 0.5 : 2.5}
            value={set.weight}
          />
        </View>
        <View style={{ flex: 1, gap: theme.space.xs }}>
          <Text tone="tertiary" variant="caption">{amountLabel}</Text>
          <SetField
            accessibilityLabel={`${setLabel}${amountLabel}`}
            disabled={readOnly}
            field="reps"
            keyboardType={mode === 'cardio' ? 'decimal-pad' : 'number-pad'}
            min={0}
            mode={mode}
            onChangeText={value => onReps(selected.exerciseIndex, selected.setIndex, value)}
            step={mode === 'time' ? 5 : 1}
            value={set.reps}
          />
        </View>
      </View>

      {set.type === 'dropset' ? (
        <View style={{ gap: theme.space.xs }}>
          <Text tone="secondary" variant="footnote">
            {`已勾 ${dropsetDone}/${dropsetTotal} 段`}
          </Text>
          <View style={{ gap: theme.space.xxs }}>
            <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
              <Icon
                color={dropsetMainDone ? theme.colors.accentInk : theme.colors.label4}
                name={dropsetMainDone ? 'checkCircle' : 'dot'}
                size={theme.sizes.buttonIcon}
              />
              <Text tone="secondary" variant="caption">主段</Text>
              <Text numberOfLines={1} style={{ flex: 1 }} tone="tertiary" variant="caption">
                {`${set.weight || '—'} ${draft.unit} × ${set.reps || '—'} 次`}
              </Text>
            </View>
            {!set.warmup && mode === 'reps' ? drops.map((drop, dropIndex) => {
              const segment = typeof drop.key === 'string' && drop.key !== '' ? drop.key : `d${dropIndex}`;
              const done = draftSegmentDone(set, segment);
              return (
                <View
                  key={segment}
                  style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}
                >
                  <Icon
                    color={done ? theme.colors.accentInk : theme.colors.label4}
                    name={done ? 'checkCircle' : 'dot'}
                    size={theme.sizes.buttonIcon}
                  />
                  <Text tone="secondary" variant="caption">{`降重 ${dropIndex + 1}`}</Text>
                  <View style={{ flex: 1 }}>
                    <Stepper
                      accessibilityLabel={`${setLabel}降重${dropIndex + 1}重量`}
                      disabled={readOnly}
                      keyboardType="decimal-pad"
                      min={0}
                      onChangeText={value => onDrop(selected.exerciseIndex, selected.setIndex, dropIndex, { w: value })}
                      step={2.5}
                      value={drop.w}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Stepper
                      accessibilityLabel={`${setLabel}降重${dropIndex + 1}次数`}
                      disabled={readOnly}
                      keyboardType="number-pad"
                      min={1}
                      onChangeText={value => onDrop(selected.exerciseIndex, selected.setIndex, dropIndex, { r: value })}
                      step={1}
                      value={drop.r}
                    />
                  </View>
                </View>
              );
            }) : null}
          </View>
        </View>
      ) : null}

      {set.type === 'restpause' && !set.warmup && mode === 'reps' ? (
        <View style={{ gap: theme.space.xs }}>
          {clusters.map((cluster, clusterIndex) => (
            <View
              key={cluster.key ?? `c${clusterIndex}`}
              style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}
            >
              <Text tone="secondary" variant="caption">{`分段${clusterIndex + 1}`}</Text>
              <View style={{ flex: 1 }}>
                <Stepper
                  accessibilityLabel={`${setLabel}分段${clusterIndex + 1}次数`}
                  disabled={readOnly}
                  keyboardType="number-pad"
                  min={1}
                  onChangeText={value => onCluster(selected.exerciseIndex, selected.setIndex, clusterIndex, { r: value })}
                  step={1}
                  value={cluster.r}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Stepper
                  accessibilityLabel={`${setLabel}分段${clusterIndex + 1}短休秒数`}
                  disabled={readOnly}
                  keyboardType="number-pad"
                  max={REST_PAUSE_MAX}
                  min={REST_PAUSE_MIN}
                  onChangeText={value => onCluster(selected.exerciseIndex, selected.setIndex, clusterIndex, { restSec: value })}
                  step={5}
                  value={cluster.restSec}
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {!valid && !readOnly ? (
        <Text tone="danger" variant="caption">
          这一组的重量或次数无效，补全后才能完成。
        </Text>
      ) : null}
      {grouped && !turn && !complete ? (
        <Text tone="secondary" variant="footnote">
          按超级组顺序完成前一组后即可勾选这一组。
        </Text>
      ) : null}

      {setScale != null && !set.warmup ? (
        <Button
          accessibilityLabel={`${setLabel}${ratingLabel}`}
          disabled={readOnly}
          icon="gauge"
          onPress={() => onRate(selected.exerciseIndex, selected.setIndex, setScale, ratingValue, mode === 'cardio')}
          size="sm"
          variant={ratingValue == null ? 'secondary' : 'tinted'}
        >
          {ratingLabel}
        </Button>
      ) : null}

      <Button
        accessibilityLabel={`${setLabel}完成`}
        disabled={!canComplete}
        icon="check"
        onPress={completeSet}
        variant="primary"
      >
        {complete ? '已完成' : set.type === 'dropset' ? dropsetActionLabel : '完成'}
      </Button>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        <Button
          disabled={selected.setIndex >= entry.sets.length - 1}
          onPress={skip}
          size="sm"
          variant="secondary"
        >
          跳过
        </Button>
        <Button
          icon="plus"
          onPress={() => onAddSet(selected.exerciseIndex)}
          size="sm"
          variant="secondary"
        >
          添加正式组
        </Button>
      </View>

      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <IconButton
          accessibilityLabel="上一组"
          disabled={sequenceIndex <= 0}
          name="chevronLeft"
          onPress={() => selectSequence(sequenceIndex - 1)}
          size="sm"
        />
        <View style={{ flex: 1, flexDirection: 'row', gap: theme.space.xs, justifyContent: 'center' }}>
          {entry.sets.map((row, index) => (
            <PressableScale
              accessibilityLabel={`第 ${index + 1} 组`}
              accessibilityRole="button"
              key={row.key ?? String(index)}
              onPress={() => selectSet(index)}
              scaleTo={theme.motion.pressScaleSmall}
              style={{
                backgroundColor: index === selected.setIndex
                  ? theme.colors.accent
                  : row.at !== null ? theme.colors.surface3 : theme.colors.surface2,
                borderRadius: theme.radius.pill,
                height: theme.space.sm,
                width: theme.space.sm,
              }}
            >
              <View />
            </PressableScale>
          ))}
        </View>
        <IconButton
          accessibilityLabel="下一组"
          disabled={sequenceIndex < 0 || sequenceIndex >= sequence.length - 1}
          name="chevronRight"
          onPress={() => selectSequence(sequenceIndex + 1)}
          size="sm"
        />
      </View>

      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
        <Button
          disabled={!canPrevUnit}
          icon="chevronLeft"
          onPress={() => onNavigateUnit(-1)}
          size="sm"
          style={{ flex: 1 }}
          variant="secondary"
        >
          上一动作
        </Button>
        <Button
          disabled={!canNextUnit}
          icon="chevronRight"
          iconPosition="right"
          onPress={() => onNavigateUnit(1)}
          size="sm"
          style={{ flex: 1 }}
          variant="secondary"
        >
          下一动作
        </Button>
      </View>

      {grouped ? (
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
          <Icon color={theme.colors.label3} name="link" size={theme.sizes.buttonIcon} />
          <Text style={{ flex: 1 }} tone="secondary" variant="footnote">
            {`${unit.map(index => exerciseName(profile, draft.exercises[index].target.id)).join(' + ')} · 按回合顺序切换`}
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

export default WorkoutFocusView;
