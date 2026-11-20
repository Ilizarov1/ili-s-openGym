import { useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { Alert, BackHandler, PanResponder, ScrollView, View } from 'react-native';
import {
  ActionSheet,
  Button,
  Card,
  Chip,
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
import type { IconName } from '../design';
import { changeSuperset, exerciseUnits, nextSupersetSet, supersetRestSeconds } from '../supersets';
import { RestTimer, resolveRestSeconds } from '../restTimer';
import { supersetMeta } from '../../../frontend/src/lib/superset-meta';
import { EffortSheet } from '../EffortSheet';
import { draftEffortOf, effortPreferenceOf, formatEffort, scaleName } from '../effort';
import { SetField } from './WorkoutSetField';
import { WorkoutFocusView, type FocusToggleOptions } from './WorkoutFocusView';
import { WorkoutCompletePrompt, WorkoutFinishPanel } from './WorkoutFinishPanels';
import {
  MAX_WORK_SETS,
  REST_PAUSE_MAX,
  REST_PAUSE_MIN,
  WORKOUT_VIEWS,
  WORKOUT_VIEW_LABELS,
  addClusterSegment,
  addDropSegment,
  addWorkSet,
  backupExerciseIds,
  draftClusterTotal,
  editDraftSet,
  exerciseMode,
  exerciseName,
  removeClusterSegment,
  removeDropSegment,
  removeSet,
  setDraftEffort,
  setClusterSegment,
  setDropSegment,
  startDraftRest,
  swapExercise,
  updateSet,
  updateSetReps,
  validSet,
  validSetSegments,
  validWorkoutDay,
  workoutViewOf,
  type Draft,
  type Profile,
  type QueuedWorkout,
  type RatingScale,
  type WorkoutView,
} from '../training';

export type WorkoutScreenProps = {
  profile: Profile;
  draft: Draft;
  queue: QueuedWorkout[];
  e2e?: boolean;
  onChange: (draft: Draft) => boolean;
  onFinish: () => void;
  onDiscard: () => void;
  /** Put the workout aside and go back to the tabs; the draft and its rest stay. */
  onCollapse?: () => void;
  onPick: (replaceIndex?: number) => void;
};

type MenuItem = NonNullable<ComponentProps<typeof ActionSheet>['items']>[number];
type Menu = { kind: 'workout' } | { kind: 'exercise'; index: number } | null;
type RatingSheet = {
  exerciseIndex: number;
  setIndex: number;
  scale: RatingScale;
  value: number | null;
  cardio: boolean;
};

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

function clampPosition(draft: Draft) {
  const last = Math.max(0, draft.exercises.length - 1);
  const raw = typeof draft.position === 'number' && Number.isInteger(draft.position) ? draft.position : 0;
  return Math.min(Math.max(raw, 0), last);
}

function unitFinished(draft: Draft, unit: number[]) {
  return unit.length > 0 && unit.every(index => {
    const sets = draft.exercises[index]?.sets ?? [];
    return sets.length > 0 && sets.every(set => set.at !== null);
  });
}

function unitHasWork(draft: Draft, unit: number[]) {
  return unit.some(index => draft.exercises[index]?.sets.some(set => set.at === null));
}

/** The unit Prev/Next lands on, skipping finished units when the setting is on. */
function stepUnit(draft: Draft, units: number[][], from: number, direction: 1 | -1, skipDone: boolean) {
  const adjacent = from + direction;
  if (adjacent < 0 || adjacent >= units.length) return -1;
  if (!skipDone) return adjacent;
  for (let index = adjacent; index >= 0 && index < units.length; index += direction) {
    if (unitHasWork(draft, units[index])) return index;
  }
  return adjacent;
}

/**
 * The first unit after the current one with unfinished work, wrapping once. Used
 * by the list's fold-and-advance rule and by focus when a whole unit is finished.
 */
function nextUnfinishedUnit(draft: Draft, units: number[][], fromIndex: number) {
  const current = units.findIndex(unit => unit.includes(fromIndex));
  const ordered = current < 0
    ? units
    : [...units.slice(current + 1), ...units.slice(0, current)];
  return ordered.find(unit => unitHasWork(draft, unit)) ?? null;
}

export function WorkoutScreen({ profile, draft, queue, e2e = false, onChange, onFinish, onDiscard, onCollapse, onPick }: WorkoutScreenProps) {
  const theme = useTheme();
  const list = useRef<ScrollView>(null);
  const unitTops = useRef(new Map<number, number>());
  const memberOffsets = useRef(new Map<number, number>());
  const highWater = useRef<number[]>([]);
  const setCounts = useRef<number[]>([]);
  const [menu, setMenu] = useState<Menu>(null);
  const [jump, setJump] = useState(false);
  const [rating, setRating] = useState<RatingSheet | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [openedState, setOpenedState] = useState(() => ({
    length: draft.exercises.length,
    keys: new Set<string>(),
  }));
  const effort = effortPreferenceOf(profile);

  // The layout is this session's snapshot. A draft from before the setting existed
  // reads the saved profile default, and anything unknown reads as cards.
  const view = workoutViewOf(draft.view ?? profile.workoutView);
  const listMode = view === 'list' || view === 'compact';
  const focusMode = view === 'focus';
  const dense = view === 'compact';
  const skipDone = !listMode && profile.skipDone === true;
  const foldOn = draft.foldDone ?? profile.foldDone === true;
  const collapseOn = listMode && foldOn;

  const targets = draft.exercises.map(exercise => exercise.target);
  const units = exerciseUnits(targets);
  const groups = units.flatMap(unit => {
    const nextSet = unit.length > 1 ? nextSupersetSet(draft, unit) : undefined;
    return unit.map(() => ({ unit, nextSet }));
  });
  const done = draft.exercises.reduce((total, exercise) => total + exercise.sets.filter(set => set.at !== null).length, 0);
  const total = draft.exercises.reduce((count, exercise) => count + exercise.sets.length, 0);
  const backfill = draft.backfillDay != null;
  const backfillReady = !backfill || (draft.name.trim() !== '' && validWorkoutDay(draft.backfillDay ?? '') && done > 0);

  const position = clampPosition(draft);
  const unitIndex = units.findIndex(unit => unit.includes(position));
  const currentUnit = unitIndex >= 0 ? units[unitIndex] : [];
  const opened = openedState.length === draft.exercises.length ? openedState.keys : new Set<string>();

  // Android Back closes this screen's own sheets first; App's handler only sees the
  // next press and puts the workout aside.
  useEffect(() => {
    if (!menu && !jump && !rating && !finishOpen && !completeOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (rating) setRating(null);
      else if (menu) setMenu(null);
      else if (jump) setJump(false);
      else if (completeOpen) setCompleteOpen(false);
      else if (finishOpen) setFinishOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [completeOpen, finishOpen, jump, menu, rating]);

  const collapsed = new Set<string>();
  if (collapseOn) {
    for (const unit of units) {
      const key = unit.join('-');
      if (!unit.includes(position) && !opened.has(key) && unitFinished(draft, unit)) collapsed.add(key);
    }
  }

  // The per-exercise high-water counts distinguish a first completion from a
  // re-check, so unchecking and ticking a finished set never advances the list.
  // Removing a set lowers that exercise's mark the same way, keeping the next
  // completion new instead of reading as a re-check.
  if (highWater.current.length !== draft.exercises.length) {
    highWater.current = draft.exercises.map(exercise =>
      exercise.sets.filter(set => set.at !== null).length);
    setCounts.current = draft.exercises.map(exercise => exercise.sets.length);
  } else {
    draft.exercises.forEach((exercise, index) => {
      const before = setCounts.current[index];
      if (before != null && exercise.sets.length < before) {
        highWater.current[index] = Math.min(
          highWater.current[index] ?? 0,
          exercise.sets.filter(set => set.at !== null).length,
        );
      }
      setCounts.current[index] = exercise.sets.length;
    });
  }

  function setUnitOpen(key: string, open: boolean) {
    setOpenedState(previous => {
      const keys = new Set(previous.length === draft.exercises.length ? previous.keys : []);
      if (open) keys.add(key); else keys.delete(key);
      return { length: draft.exercises.length, keys };
    });
  }

  function scrollToExercise(exerciseIndex: number) {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const owner = units.find(unit => unit.includes(exerciseIndex));
      if (!owner) return;
      const y = (unitTops.current.get(owner[0]) ?? 0) + (memberOffsets.current.get(exerciseIndex) ?? 0);
      list.current?.scrollTo({ y: Math.max(0, y), animated: true });
    }));
  }

  function navigateUnit(direction: 1 | -1) {
    const target = stepUnit(draft, units, unitIndex, direction, skipDone);
    if (target < 0) return;
    onChange({ ...draft, position: units[target][0] });
    requestAnimationFrame(() => list.current?.scrollTo({ y: 0, animated: false }));
  }

  const navigateRef = useRef(navigateUnit);
  navigateRef.current = navigateUnit;
  const swipe = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) =>
      Math.abs(gesture.dx) > 18 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dx <= -48) navigateRef.current(1);
      else if (gesture.dx >= 48) navigateRef.current(-1);
    },
  })).current;

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

  function toggleSet(exerciseIndex: number, setIndex: number, options?: FocusToggleOptions) {
    const exercise = draft.exercises[exerciseIndex];
    const set = exercise?.sets[setIndex];
    if (!exercise || !set) return;
    const complete = set.at !== null;
    const at = complete ? null : Date.now();
    let next = updateSet(draft, exerciseIndex, setIndex, { at });
    const controlsRest = draft.rest?.exerciseIndex === exerciseIndex && draft.rest.setIndex === setIndex;
    if (at === null) {
      onChange(controlsRest ? { ...next, rest: null } : next);
      return;
    }

    const doneCount = next.exercises[exerciseIndex].sets.filter(row => row.at !== null).length;
    const previous = highWater.current[exerciseIndex] ?? 0;
    const isNew = doneCount > previous;
    highWater.current[exerciseIndex] = Math.max(previous, doneCount);

    const { unit, nextSet } = groups[exerciseIndex];
    const grouped = unit.length > 1;
    const hasRemainingSets = next.exercises.some(entry => entry.sets.some(row => row.at === null));
    const round = nextSet?.round;
    const seconds = hasRemainingSets && draft.backfillDay == null
      ? round != null && grouped
        ? supersetRestSeconds(next, unit, round, resolveRestSeconds(undefined, profile.restSec))
        : resolveRestSeconds(exercise.target, profile.restSec)
      : 0;

    // Fold and advance: only a first completion of a set in the current unit moves
    // the list's marker, and only to a unit that still has work. Completing an
    // earlier or later unit leaves the marker alone.
    if (isNew && collapseOn) {
      const owner = units.find(candidate => candidate.includes(exerciseIndex));
      const current = units.find(candidate => candidate.includes(position));
      if (owner && current && owner.includes(position) && unitFinished(next, owner)) {
        const upcoming = nextUnfinishedUnit(next, units, position);
        if (upcoming) {
          next = { ...next, position: upcoming[0] };
          scrollToExercise(upcoming[0]);
        }
      }
    }

    // Focus advances along its own round sequence; finishing the whole unit falls
    // through to the next unit with work, exactly like the cards' Next.
    if (options?.focus) {
      const owner = units.find(candidate => candidate.includes(exerciseIndex)) ?? unit;
      if (unitFinished(next, owner)) {
        const upcoming = nextUnfinishedUnit(next, units, position);
        next = { ...next, position: upcoming ? upcoming[0] : exerciseIndex };
      } else if (options.nextExercise != null) {
        next = { ...next, position: options.nextExercise };
      }
    }

    const rest = startDraftRest(exerciseIndex, setIndex, seconds, at);
    const saved = onChange({ ...next, rest });
    if (!saved) return;
    if (grouped && !focusMode) {
      const upcoming = nextSupersetSet(next, unit);
      if (upcoming && upcoming.exerciseIndex !== exerciseIndex) scrollToExercise(upcoming.exerciseIndex);
    }
    // The last unfinished set, ticked for the first time: offer Finish or keep going.
    // A re-check is not new progress, so it never raises this again.
    const allDone = next.exercises.length > 0 &&
      next.exercises.every(entry => entry.sets.every(row => row.at !== null));
    if (isNew && allDone && draft.backfillDay == null) setCompleteOpen(true);
  }

  function requestFinish() {
    const invalidAt = draft.exercises.findIndex(exercise => exercise.sets.some(set =>
      set.at !== null && (!validSet(set, exerciseMode(exercise.target, profile)) || !validSetSegments(set))));
    if (invalidAt >= 0) {
      onChange({ ...draft, position: invalidAt });
      scrollToExercise(invalidAt);
      Alert.alert('有组数据无效', '已定位到需要更正的组。补全重量、次数和分段后再结束训练。');
      return;
    }
    if (backfill) {
      if (backfillReady) onFinish();
      return;
    }
    setFinishOpen(true);
  }

  function selectUnit(unit: number[]) {
    if (unit.includes(position)) return;
    onChange({ ...draft, position: unit[0] });
  }

  function jumpToUnit(unit: number[]) {
    const key = unit.join('-');
    if (collapsed.has(key)) setUnitOpen(key, true);
    onChange({ ...draft, position: unit[0] });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const y = (unitTops.current.get(unit[0]) ?? 0) - theme.space.sm;
      list.current?.scrollTo({ y: Math.max(0, y), animated: true });
    }));
  }

  function layoutIcon(value: WorkoutView): IconName {
    if (value === 'list') return 'list';
    if (value === 'compact') return 'compact';
    if (value === 'focus') return 'target';
    return 'layout';
  }

  function workoutMenuItems(): MenuItem[] {
    const items: MenuItem[] = WORKOUT_VIEWS.map(value => ({
      label: `${WORKOUT_VIEW_LABELS[value]}${value === view ? ' · 当前' : ''}`,
      icon: layoutIcon(value),
      tone: value === view ? 'accent' : 'default',
      onPress: () => onChange({ ...draft, view: value }),
    }));
    if (listMode) {
      items.push({
        label: foldOn ? '取消折叠已完成动作' : '折叠已完成动作',
        icon: 'minimize',
        tone: foldOn ? 'accent' : 'default',
        onPress: () => onChange({ ...draft, foldDone: !foldOn }),
      });
    }
    items.push({ label: '放弃训练', icon: 'trash', tone: 'danger', onPress: onDiscard });
    return items;
  }

  function renderExerciseCard(exerciseIndex: number, denseCard: boolean) {
    const exercise = draft.exercises[exerciseIndex];
    const name = exerciseName(profile, exercise.target.id);
    const { unit, nextSet } = groups[exerciseIndex];
    const grouped = unit.length > 1;
    const groupStart = grouped && unit[0] === exerciseIndex;
    const groupName = groupStart ? supersetMeta(targets, unit).name : '';
    const affected = grouped ? unit : [...(groups[exerciseIndex - 1]?.unit ?? []), exerciseIndex];
    const canGroup = affected.every(index => draft.exercises[index].sets.every(set => set.at === null));
    const completed = exercise.sets.some(set => set.at !== null);
    const mode = exerciseMode(exercise.target, profile);
    const weightLabel = mode === 'cardio' ? '速度' : '重量';
    const amountLabel = mode === 'cardio' ? '分钟' : mode === 'time' ? '秒' : '次数';
    const replacements = backupExerciseIds(exercise.target, profile);
    const actions = exerciseMenuItems(exerciseIndex);
    // Strength work sets follow the profile scale. Cardio always asks for RPE
    // (a run has no reps left); timed holds keep their own entry points.
    const ratingScale: RatingScale | null = effort === 'none'
      ? null
      : mode === 'cardio' ? 'rpe' : mode === 'reps' ? effort : null;

    return (
      <View
        key={exerciseIndex}
        onLayout={event => memberOffsets.current.set(exerciseIndex, event.nativeEvent.layout.y)}
      >
        <Card gap={theme.space.sm} style={{ marginBottom: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.space.sm }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              {groupStart && !denseCard ? (
                <Text tone="accent" variant="footnote">
                  {groupName ? `超级组 · ${groupName}` : '超级组'}
                </Text>
              ) : null}
              <Text numberOfLines={2} variant="headline">{name}</Text>
              {!denseCard && nextSet?.exerciseIndex === exerciseIndex ? (
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

          {!denseCard && exercise.target.side ? (
            <Text tone="secondary" variant="footnote">次数填写双侧合计。</Text>
          ) : null}

          {!denseCard && replacements.length > 0 ? (
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
            const segments = set.type === 'dropset' ? set.drops ?? [] : set.type === 'restpause' ? set.clusters ?? [] : [];
            const segmentsValid = validSetSegments(set);
            const valid = validSet(set, mode) && segmentsValid;
            const available = (complete || valid) && (!grouped || complete ||
              (nextSet?.exerciseIndex === exerciseIndex && nextSet.setIndex === setIndex));
            const number = exercise.sets.slice(0, setIndex + 1).filter(row => !!row.warmup === !!set.warmup).length;
            const label = set.warmup ? `热身第 ${number} 组` : `第 ${number} 组`;
            const controlLabel = grouped ? `${name} ${label}` : label;
            // A row already rated in this draft keeps its own scale, exactly like
            // history: changing the setting later relabels only unrated rows.
            const setScale = set.effortScale ?? ratingScale;
            const ratingValue = setScale ? draftEffortOf(set, setScale) : null;
            const ratingLabel = setScale
              ? ratingValue == null
                ? `${scaleName(setScale)} 未评分`
                : `${scaleName(setScale)} ${formatEffort(ratingValue)}`
              : '';
            const editWeight = (weight: string) => {
              onChange(editDraftSet(draft, exerciseIndex, setIndex, 'weight', weight, profile));
            };
            const editReps = (reps: string) => {
              const retotaled = set.type === 'restpause'
                ? updateSetReps(draft, exerciseIndex, setIndex, reps)
                : draft;
              onChange(editDraftSet(retotaled, exerciseIndex, setIndex, 'reps', reps, profile));
            };

            return (
              <View key={set.key ?? String(setIndex)} style={{ gap: theme.space.xs }}>
                <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
                  <Text
                    numberOfLines={1}
                    style={{ width: NUMBER_COLUMN }}
                    tone={complete ? 'tertiary' : 'secondary'}
                    variant="footnote"
                  >
                    {set.warmup ? '热身' : number}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <SetField
                      accessibilityLabel={`${controlLabel}${weightLabel}`}
                      field="weight"
                      keyboardType="decimal-pad"
                      min={0}
                      mode={mode}
                      onChangeText={editWeight}
                      step={mode === 'cardio' ? 0.5 : 2.5}
                      value={set.weight}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <SetField
                      accessibilityLabel={`${controlLabel}${set.type === 'restpause' ? '总次数' : amountLabel}`}
                      field="reps"
                      keyboardType={mode === 'cardio' ? 'decimal-pad' : 'number-pad'}
                      min={0}
                      mode={mode}
                      onChangeText={editReps}
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
                    onPress={() => toggleSet(exerciseIndex, setIndex)}
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
                {setScale != null && !set.warmup ? (
                  <View
                    style={{
                      alignItems: 'center',
                      flexDirection: 'row',
                      gap: theme.space.sm,
                      paddingLeft: NUMBER_COLUMN + theme.space.xs,
                    }}
                  >
                    <Button
                      accessibilityLabel={`${controlLabel}${ratingLabel}`}
                      icon="gauge"
                      onPress={() => setRating({
                        exerciseIndex,
                        setIndex,
                        scale: setScale,
                        value: ratingValue,
                        cardio: mode === 'cardio',
                      })}
                      size="xs"
                      testID={`set-effort-${exerciseIndex}-${setIndex}`}
                      variant={ratingValue == null ? 'secondary' : 'tinted'}
                    >
                      {ratingLabel}
                    </Button>
                    {!denseCard && ratingValue != null ? (
                      <Text tone="secondary" variant="footnote">可修改或清除</Text>
                    ) : null}
                  </View>
                ) : null}

                {!set.warmup && mode === 'reps' ? (
                  <>
                    {(set.type === 'dropset' ? set.drops ?? [] : []).map((drop, dropIndex) => (
                      <View
                        key={drop.key ?? `d${dropIndex}`}
                        style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}
                      >
                        <Text
                          numberOfLines={1}
                          style={{ paddingLeft: theme.space.sm, width: NUMBER_COLUMN + theme.space.md }}
                          tone="secondary"
                          variant="caption"
                        >
                          递减{dropIndex + 1}
                        </Text>
                        <View style={{ flex: 1 }}>
                          <Stepper
                            accessibilityLabel={`${controlLabel}递减${dropIndex + 1}${weightLabel}`}
                            keyboardType="decimal-pad"
                            min={0}
                            onChangeText={weight => onChange(setDropSegment(draft, exerciseIndex, setIndex, dropIndex, { w: weight }))}
                            step={2.5}
                            value={drop.w}
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Stepper
                            accessibilityLabel={`${controlLabel}递减${dropIndex + 1}次数`}
                            keyboardType="number-pad"
                            min={1}
                            onChangeText={reps => onChange(setDropSegment(draft, exerciseIndex, setIndex, dropIndex, { r: reps }))}
                            step={1}
                            value={drop.r}
                          />
                        </View>
                        <IconButton
                          accessibilityLabel={`删除${controlLabel}递减${dropIndex + 1}`}
                          name="xmark"
                          onPress={() => onChange(removeDropSegment(draft, exerciseIndex, setIndex, dropIndex))}
                          size="sm"
                        />
                      </View>
                    ))}

                    {(set.type === 'restpause' ? set.clusters ?? [] : []).map((cluster, clusterIndex) => (
                      <View
                        key={cluster.key ?? `c${clusterIndex}`}
                        style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}
                      >
                        <Text
                          numberOfLines={1}
                          style={{ paddingLeft: theme.space.sm, width: NUMBER_COLUMN + theme.space.md }}
                          tone="secondary"
                          variant="caption"
                        >
                          分段{clusterIndex + 1}
                        </Text>
                        <View style={{ flex: 1 }}>
                          <Stepper
                            accessibilityLabel={`${controlLabel}分段${clusterIndex + 1}次数`}
                            keyboardType="number-pad"
                            min={1}
                            onChangeText={reps => onChange(setClusterSegment(draft, exerciseIndex, setIndex, clusterIndex, { r: reps }))}
                            step={1}
                            value={cluster.r}
                          />
                        </View>
                        <View style={{ flex: 1 }}>
                          <Stepper
                            accessibilityLabel={`${controlLabel}分段${clusterIndex + 1}短休秒数`}
                            keyboardType="number-pad"
                            max={REST_PAUSE_MAX}
                            min={REST_PAUSE_MIN}
                            onChangeText={restSec => onChange(setClusterSegment(draft, exerciseIndex, setIndex, clusterIndex, { restSec }))}
                            step={5}
                            value={cluster.restSec}
                          />
                        </View>
                        <IconButton
                          accessibilityLabel={`删除${controlLabel}分段${clusterIndex + 1}`}
                          name="xmark"
                          onPress={() => onChange(removeClusterSegment(draft, exerciseIndex, setIndex, clusterIndex))}
                          size="sm"
                        />
                      </View>
                    ))}

                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
                      {set.type !== 'restpause' ? (
                        <Button
                          icon="arrowDown"
                          onPress={() => onChange(addDropSegment(draft, exerciseIndex, setIndex, profile))}
                          size="xs"
                          variant="ghost"
                        >
                          {set.type === 'dropset' ? '添加递减段' : '改为递减组'}
                        </Button>
                      ) : null}
                      {set.type !== 'dropset' ? (
                        <Button
                          icon="bolt"
                          onPress={() => onChange(addClusterSegment(draft, exerciseIndex, setIndex, profile))}
                          size="xs"
                          variant="ghost"
                        >
                          {set.type === 'restpause' ? '添加段' : '改为休息暂停'}
                        </Button>
                      ) : null}
                    </View>

                    {set.type === 'restpause' && segments.length > 0 ? (
                      <Text tone="secondary" variant="caption">
                        {`总 ${draftClusterTotal(set)} 次 · ${segments.length} 段 · 短休按秒计`}
                      </Text>
                    ) : null}
                    {set.type === 'dropset' && segments.length > 0 ? (
                      <Text tone="secondary" variant="caption">
                        {`主组 ${set.reps} 次 · ${segments.length} 段递减`}
                      </Text>
                    ) : null}
                    {!segmentsValid ? (
                      <Text tone="danger" variant="caption">
                        分段的数据无效，补全重量、次数和短休后才能完成这一组。
                      </Text>
                    ) : null}
                  </>
                ) : null}
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

          {!denseCard ? (
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
          ) : null}
        </Card>
      </View>
    );
  }

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']} scroll={false} testID="workout-screen">
      <View style={{ paddingHorizontal: theme.layout.pagePadding }}>
        <Header
          backLabel="收起"
          compact
          onBack={backfill ? undefined : onCollapse}
          right={(
            <>
              <Elapsed start={draft.start} frozen={e2e} />
              <Button
                disabled={Boolean(backfill && !backfillReady)}
                onPress={requestFinish}
                size="sm"
                testID="finish-workout"
                variant="primary"
              >
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

        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm, justifyContent: 'space-between' }}>
          <Text tone="secondary" variant="footnote">已完成 {done} 组</Text>
          {listMode && units.length > 0 ? (
            <Button icon="list" onPress={() => setJump(true)} size="xs" variant="secondary">
              跳转动作
            </Button>
          ) : null}
        </View>

        {focusMode ? (
          units.length > 0 ? (
            <WorkoutFocusView
              canNextUnit={unitIndex >= 0 && unitIndex < units.length - 1}
              canPrevUnit={unitIndex > 0}
              currentIndex={position}
              draft={draft}
              onAddSet={exerciseIndex => onChange(addWorkSet(draft, exerciseIndex))}
              onCluster={(exerciseIndex, setIndex, clusterIndex, changes) =>
                onChange(setClusterSegment(draft, exerciseIndex, setIndex, clusterIndex, changes))}
              onDrop={(exerciseIndex, setIndex, dropIndex, changes) =>
                onChange(setDropSegment(draft, exerciseIndex, setIndex, dropIndex, changes))}
              onNavigateUnit={navigateUnit}
              onOpenExercise={exerciseIndex => setMenu({ kind: 'exercise', index: exerciseIndex })}
              onRate={(exerciseIndex, setIndex, scale, value, cardio) =>
                setRating({ exerciseIndex, setIndex, scale, value, cardio })}
              onReps={(exerciseIndex, setIndex, reps) => {
                const retotaled = draft.exercises[exerciseIndex]?.sets[setIndex]?.type === 'restpause'
                  ? updateSetReps(draft, exerciseIndex, setIndex, reps)
                  : draft;
                onChange(editDraftSet(retotaled, exerciseIndex, setIndex, 'reps', reps, profile));
              }}
              onToggle={toggleSet}
              onWeight={(exerciseIndex, setIndex, weight) =>
                onChange(editDraftSet(draft, exerciseIndex, setIndex, 'weight', weight, profile))}
              profile={profile}
              unit={currentUnit}
            />
          ) : null
        ) : listMode ? (
          units.map((unit, groupIndex) => {
            const key = unit.join('-');
            const isCurrent = unit.includes(position);
            const isCollapsed = collapsed.has(key);
            const groupMeta = unit.length > 1 ? supersetMeta(targets, unit) : null;
            const unitDone = unit.reduce((total, index) =>
              total + draft.exercises[index].sets.filter(set => set.at !== null).length, 0);
            return (
              <View
                key={key}
                onLayout={event => unitTops.current.set(unit[0], event.nativeEvent.layout.y)}
                style={{ gap: theme.space.sm }}
              >
                <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm, justifyContent: 'space-between' }}>
                  <Text numberOfLines={1} style={{ flex: 1 }} tone="secondary" variant="footnote">
                    {`${unit.length > 1 ? '超级组' : '动作'} ${groupIndex + 1}/${units.length}`}
                    {!dense && unit.length > 1 && groupMeta?.name ? ` · ${groupMeta.name}` : ''}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: theme.space.xs }}>
                    {!isCollapsed ? (
                      isCurrent ? (
                        <Chip icon="check" selected size="sm">当前</Chip>
                      ) : (
                        <Chip onPress={() => selectUnit(unit)} size="sm">设为当前</Chip>
                      )
                    ) : null}
                    {!isCurrent && foldOn && unitFinished(draft, unit) && opened.has(key) ? (
                      <Chip onPress={() => setUnitOpen(key, false)} size="sm">折叠</Chip>
                    ) : null}
                  </View>
                </View>
                {isCollapsed ? (
                  <Card onPress={() => setUnitOpen(key, true)} style={{ marginBottom: 0 }}>
                    <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} variant="subhead" weight="600">
                          {unit.map(index => exerciseName(profile, draft.exercises[index].target.id)).join(' + ')}
                        </Text>
                        <Text tone="secondary" variant="footnote">{`${unitDone} 组已完成`}</Text>
                      </View>
                      <Icon color={theme.colors.label3} name="chevronDown" size={theme.sizes.buttonIcon} />
                    </View>
                  </Card>
                ) : unit.map(index => renderExerciseCard(index, dense))}
              </View>
            );
          })
        ) : currentUnit.length > 0 ? (
          <>
            <View
              {...swipe.panHandlers}
              onLayout={event => unitTops.current.set(currentUnit[0], event.nativeEvent.layout.y)}
            >
              <View style={{ gap: theme.space.sm }}>
                <Text tone="secondary" variant="footnote">
                  {`${currentUnit.length > 1 ? '超级组' : '动作'} ${unitIndex + 1}/${units.length}`}
                </Text>
                {currentUnit.map(index => renderExerciseCard(index, false))}
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
              <Button
                disabled={unitIndex <= 0}
                icon="chevronLeft"
                onPress={() => navigateUnit(-1)}
                size="sm"
                style={{ flex: 1 }}
                variant="secondary"
              >
                上一个
              </Button>
              <Button
                disabled={unitIndex < 0 || unitIndex >= units.length - 1}
                icon="chevronRight"
                iconPosition="right"
                onPress={() => navigateUnit(1)}
                size="sm"
                style={{ flex: 1 }}
                variant="secondary"
              >
                下一个
              </Button>
            </View>
          </>
        ) : null}

        <Button icon="plus" onPress={() => onPick()} variant="secondary">
          添加动作
        </Button>
        <Button onPress={onDiscard} variant="danger">
          放弃训练
        </Button>
      </ScrollView>

      <RestTimer rest={draft.rest} frozen={e2e} onChange={rest => onChange({ ...draft, rest })} />

      <ActionSheet
        items={workoutMenuItems()}
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
      <ActionSheet
        items={units.map((unit, index) => ({
          label: `${index + 1}. ${unit.map(entry => exerciseName(profile, draft.exercises[entry].target.id)).join(' + ')}`,
          icon: unit.length > 1 ? 'link' : 'dumbbell',
          tone: unit.includes(position) ? 'accent' : 'default',
          onPress: () => jumpToUnit(unit),
        }))}
        onClose={() => setJump(false)}
        title="跳转动作"
        visible={jump}
      />
      {rating ? (
        <EffortSheet
          cardio={rating.cardio}
          onClear={() => {
            onChange(setDraftEffort(draft, rating.exerciseIndex, rating.setIndex, null, null));
            setRating(null);
          }}
          onClose={() => setRating(null)}
          onSave={value => {
            onChange(setDraftEffort(draft, rating.exerciseIndex, rating.setIndex, rating.scale, value));
            setRating(null);
          }}
          scale={rating.scale}
          value={rating.value}
          visible
        />
      ) : null}
      <WorkoutFinishPanel
        done={done}
        onContinue={() => setFinishOpen(false)}
        onDiscard={() => { setFinishOpen(false); onDiscard(); }}
        onSave={() => { setFinishOpen(false); onFinish(); }}
        total={total}
        visible={finishOpen}
      />
      <WorkoutCompletePrompt
        onContinue={() => setCompleteOpen(false)}
        onSave={() => { setCompleteOpen(false); onFinish(); }}
        visible={completeOpen}
      />
    </Screen>
  );
}

export default WorkoutScreen;
