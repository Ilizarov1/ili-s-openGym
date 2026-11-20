import { useEffect, useRef, useState } from 'react';
import { Alert, PanResponder, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { cleanupSg, moveRoutineEntry } from '../../../frontend/src/lib/history';
import { SG_NAME_MAX, supersetMeta } from '../../../frontend/src/lib/superset-meta';
import {
  Button,
  Card,
  EmptyState,
  Header,
  Icon,
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
import type { Connection } from '../server';
import type { ProfileChange } from '../profileChanges';
import { reorderRoutineUnitOrder, reorderRoutineUnits } from '../planReorder';
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
  type RoutineExercise,
  type RoutineIntensifier,
} from '../training';
import { changeSuperset, exerciseUnits } from '../supersets';

type ExerciseMode = 'reps' | 'time' | 'cardio';
type IntensifierKind = 'none' | 'dropset' | 'restpause';

const DEFAULT_ROUTINE_NAME = '新计划';
const DRAG_HOLD_MS = 380;
const DRAG_SLOP = 8;

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

/** Whether the slot still holds input the routine cannot store; it stays on screen for correction. */
function slotInvalid(slot: PlanSlot, profile: Profile) {
  if (serializeSlot(slot, profile) === null) return true;
  return exerciseMode(slot.exercise, profile) === 'reps' && invalidIntensifier(slot.exercise.intensifier);
}

type DragSource = {
  index: number;
  position: number;
  top: number;
  height: number;
  center: number;
};

type DragState = {
  position: number;
  dy: number;
  indicatorTop: number | null;
};

type PlanDragHandleProps = {
  index: number;
  active: boolean;
  disabled: boolean;
  accessibilityLabel: string;
  onLift: (index: number) => boolean;
  onStart: () => void;
  onMove: (dy: number) => void;
  onEnd: (dy: number) => void;
  onCancel: () => void;
};

/**
 * A dedicated grip target: hold it briefly, then the whole unit follows the finger and drops on
 * release. Moving before the hold completes is treated as a cancelled gesture, never as a move.
 */
function PlanDragHandle({
  index,
  active,
  disabled,
  accessibilityLabel,
  onLift,
  onStart,
  onMove,
  onEnd,
  onCancel,
}: PlanDragHandleProps) {
  const theme = useTheme();
  const api = useRef({ index, onLift, onStart, onMove, onEnd, onCancel });
  api.current = { index, onLift, onStart, onMove, onEnd, onCancel };
  const gesture = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    armed: boolean;
    base: number;
    dy: number;
  } | null>(null);

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponderCapture: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      const current = api.current;
      if (!current.onLift(current.index)) return;
      const state = { timer: null as ReturnType<typeof setTimeout> | null, armed: false, base: 0, dy: 0 };
      gesture.current = state;
      state.timer = setTimeout(() => {
        if (gesture.current !== state) return;
        state.armed = true;
        state.timer = null;
        state.base = state.dy;
        api.current.onStart();
      }, DRAG_HOLD_MS);
    },
    onPanResponderMove: (_event, info) => {
      const state = gesture.current;
      if (!state) return;
      state.dy = info.dy;
      if (!state.armed) {
        if (Math.abs(info.dy) > DRAG_SLOP) {
          if (state.timer) clearTimeout(state.timer);
          gesture.current = null;
          api.current.onCancel();
        }
        return;
      }
      api.current.onMove(info.dy - state.base);
    },
    onPanResponderRelease: (_event, info) => {
      const state = gesture.current;
      gesture.current = null;
      if (!state) return;
      if (state.timer) clearTimeout(state.timer);
      if (state.armed) api.current.onEnd(info.dy - state.base);
      else api.current.onCancel();
    },
    onPanResponderTerminate: () => {
      const state = gesture.current;
      gesture.current = null;
      if (state?.timer) clearTimeout(state.timer);
      api.current.onCancel();
    },
  })).current;

  useEffect(() => () => {
    const state = gesture.current;
    if (state?.timer) clearTimeout(state.timer);
    gesture.current = null;
  }, []);

  return (
    <View
      {...(disabled ? {} : responder.panHandlers)}
      accessibilityHint={disabled ? undefined : '长按后拖动，松手放到新位置'}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={disabled ? undefined : 'button'}
      accessible={!disabled}
      style={{
        alignItems: 'center',
        backgroundColor: active ? theme.colors.accentSoft : 'transparent',
        borderRadius: theme.radius.sm,
        height: theme.sizes.touch,
        justifyContent: 'center',
        opacity: disabled ? 0.35 : 1,
        width: theme.sizes.touch,
      }}
    >
      <Icon color={active ? theme.colors.accentInk : theme.colors.label3} name="grip" size={20} />
    </View>
  );
}

export type PlanEditorScreenProps = {
  profile: Profile;
  routineId?: string;
  server: string | null;
  connection?: Connection | null;
  /** Runs one committed change and reports whether it reached local storage. */
  onCommit: (changes: ProfileChange[]) => boolean;
  /** The routine is gone (deleted here or removed by a sync): leave and explain. */
  onMissing: () => void;
  onClose: () => void;
  onCustom: (exercise: CustomExercise, create: boolean) => void;
  onFavorite: (id: string, favourite: boolean) => void;
  /** Lets the hosting Modal route hardware back through the editor's unsaved-input guard. */
  registerClose?: (close: () => void) => () => void;
};

export function PlanEditorScreen({
  profile,
  routineId,
  server,
  connection = null,
  onCommit,
  onMissing,
  onClose,
  onCustom,
  onFavorite,
  registerClose,
}: PlanEditorScreenProps) {
  const theme = useTheme();
  const routine = routineId ? (profile.routines ?? []).find(item => item?.id === routineId) : undefined;
  const [name, setName] = useState(routine?.name ?? '');
  const [slots, setSlots] = useState<PlanSlot[]>(
    () => (routine?.ex ?? []).filter(Boolean).map(exercise => makeSlot(exercise, profile)),
  );
  const [expanded, setExpanded] = useState<string[]>(() => slots.slice(0, 1).map(slot => slot.key));
  const [picking, setPicking] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);

  const profileRef = useRef(profile);
  profileRef.current = profile;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const nameRef = useRef(name);
  nameRef.current = name;
  const savedNameRef = useRef(routine?.name ?? '');
  const missingRef = useRef(false);
  const closeRef = useRef<() => void>(() => onClose());
  const unitLayouts = useRef(new Map<string, { y: number; height: number }>());
  const boxHeight = useRef(0);
  const dragSource = useRef<DragSource | null>(null);

  const targets = slots.map(slot => slot.exercise);
  const units = exerciseUnits(targets);
  const exercises = slots.map(slot => serializeSlot(slot, profile));

  function latestRoutine() {
    if (!routineId) return undefined;
    return (profileRef.current.routines ?? []).find(item => item?.id === routineId);
  }

  function latestExercises(): RoutineExercise[] {
    return (latestRoutine()?.ex ?? []).filter(Boolean);
  }

  function submitEx(exercisesToSave: RoutineExercise[]) {
    if (!routineId) return;
    const ex = exercisesToSave.filter(Boolean).map(exercise => ({ ...exercise }));
    const saved = onCommit([{ kind: 'routine', create: false, routine: { id: routineId, ex } }]);
    if (!saved) setSaveFailed(true);
  }

  /** Replace slot `index` in the freshest routine, not in the array this component opened with. */
  function commitExercise(index: number, exercise: RoutineExercise) {
    const latest = latestExercises();
    if (!latest[index]) {
      setSaveFailed(true);
      return;
    }
    if (JSON.stringify(latest[index]) === JSON.stringify(exercise)) return;
    submitEx(latest.map((item, at) => at === index ? { ...exercise } : item));
  }

  function applySlot(index: number, slot: PlanSlot) {
    setSlots(values => values.map((item, at) => at === index ? slot : item));
    const exercise = serializeSlot(slot, profileRef.current);
    if (exercise) commitExercise(index, exercise);
  }

  function changeName(text: string) {
    setName(text);
    if (!routineId) return;
    const value = text.trim() || DEFAULT_ROUTINE_NAME;
    if (value === savedNameRef.current) return;
    const saved = onCommit([{ kind: 'routine', create: false, routine: { id: routineId, name: value } }]);
    if (saved) savedNameRef.current = value;
    else setSaveFailed(true);
  }

  function setGroupFields(unit: number[], fields: Pick<RoutineExercise, 'sgName' | 'sgRest'>) {
    setSlots(values => values.map((slot, index) => unit.includes(index)
      ? { ...slot, exercise: { ...slot.exercise, ...fields } }
      : slot));
    const ex = latestExercises().map(exercise => ({ ...exercise }));
    for (const index of unit) {
      const exercise = ex[index];
      if (!exercise) continue;
      if (fields.sgName !== undefined) {
        const clean = fields.sgName.trim().slice(0, SG_NAME_MAX);
        if (clean) exercise.sgName = clean;
        else delete exercise.sgName;
      }
      if (fields.sgRest !== undefined) {
        const rest = Number(fields.sgRest) > 0 ? Math.round(Number(fields.sgRest)) : 0;
        if (rest) exercise.sgRest = rest;
        else delete exercise.sgRest;
      }
    }
    submitEx(ex);
  }

  function toggle(key: string) {
    setExpanded(values => values.includes(key) ? values.filter(value => value !== key) : [...values, key]);
  }

  function addExercise(exercise: RoutineExercise) {
    const slot = makeSlot(exercise, profileRef.current);
    submitEx([...latestExercises(), { ...slot.exercise }]);
    setSlots(values => [...values, slot]);
    setExpanded(values => [...values, slot.key]);
  }

  function removeExercise(index: number) {
    const key = slotsRef.current[index]?.key;
    const latest = latestExercises();
    if (latest[index]) {
      const ex = latest.filter((_, at) => at !== index).map(exercise => ({ ...exercise }));
      cleanupSg(ex);
      submitEx(ex);
    } else {
      setSaveFailed(true);
    }
    setSlots(values => {
      const remaining = values
        .filter((_, at) => at !== index)
        .map(slot => ({ ...slot, exercise: { ...slot.exercise } }));
      cleanupSg(remaining.map(slot => slot.exercise));
      return remaining;
    });
    if (key) setExpanded(values => values.filter(value => value !== key));
  }

  function toggleGroup(index: number) {
    const unit = units.find(group => group.includes(index));
    if (!unit) return;
    const grouped = unit.length > 1;
    if (!grouped && index < 1) return;
    const latest = latestExercises().map(exercise => ({ ...exercise }));
    if (!latest[index] || (!grouped && !latest[index - 1])) {
      setSaveFailed(true);
      return;
    }
    const nextLocal = changeSuperset(
      slotsRef.current.map(slot => ({ ...slot.exercise })),
      index,
      grouped,
    );
    const nextLatest = changeSuperset(latest, index, grouped);
    submitEx(nextLatest);
    setSlots(values => values.map((slot, at) => ({ ...slot, exercise: nextLocal[at] ?? slot.exercise })));
  }

  function moveEntry(index: number, direction: -1 | 1) {
    const nextLatest = moveRoutineEntry(latestExercises().map(exercise => ({ ...exercise })), index, direction);
    if (!nextLatest) return;
    cleanupSg(nextLatest);
    submitEx(nextLatest);
    setSlots(values => {
      const nextLocal = moveRoutineEntry(values.map(slot => ({ ...slot.exercise })), index, direction);
      if (!nextLocal) return values;
      cleanupSg(nextLocal);
      return values.map((slot, at) => ({ ...slot, exercise: nextLocal[at] ?? slot.exercise }));
    });
  }

  function unitKeyAt(unit: number[]) {
    return slotsRef.current[unit[0]]?.key;
  }

  function unitLayout(unit: number[]) {
    const key = unitKeyAt(unit);
    return key ? unitLayouts.current.get(key) : undefined;
  }

  function beginDrag(index: number) {
    const local = slotsRef.current;
    const groups = exerciseUnits(local.map(slot => slot.exercise));
    const position = groups.findIndex(group => group.includes(index));
    if (position < 0) return false;
    const unit = groups[position];
    const key = unitKeyAt(unit);
    const layout = key ? unitLayouts.current.get(key) : undefined;
    if (!key || !layout) return false;
    dragSource.current = {
      index,
      position,
      top: layout.y,
      height: layout.height,
      center: layout.y + layout.height / 2,
    };
    return true;
  }

  function slotAt(dy: number) {
    const source = dragSource.current;
    if (!source) return null;
    const groups = exerciseUnits(slotsRef.current.map(slot => slot.exercise));
    const remaining = groups.filter((_, position) => position !== source.position);
    const probe = source.center + dy;
    let slot = 0;
    for (const unit of remaining) {
      const layout = unitLayout(unit);
      if (layout && probe > layout.y + layout.height / 2) slot++;
    }
    return Math.max(0, Math.min(remaining.length, slot));
  }

  function indicatorTop(slot: number) {
    const source = dragSource.current;
    if (!source) return null;
    const groups = exerciseUnits(slotsRef.current.map(item => item.exercise));
    const remaining = groups.filter((_, position) => position !== source.position);
    if (slot === source.position) return source.top;
    if (slot <= 0) return remaining[0] ? unitLayout(remaining[0])?.y ?? source.top : source.top;
    if (slot >= remaining.length) {
      const last = remaining.length > 0 ? unitLayout(remaining[remaining.length - 1]) : undefined;
      return last ? last.y + last.height : source.top + source.height;
    }
    const before = unitLayout(remaining[slot - 1]);
    const after = unitLayout(remaining[slot]);
    if (!before || !after) return null;
    return (before.y + before.height + after.y) / 2;
  }

  function startDrag() {
    const source = dragSource.current;
    if (!source) return;
    setDrag({ position: source.position, dy: 0, indicatorTop: source.top });
  }

  function moveDrag(delta: number) {
    const source = dragSource.current;
    if (!source) return;
    const min = -source.top;
    const max = Math.max(min, boxHeight.current - source.top - source.height);
    const dy = Math.max(min, Math.min(max, delta));
    const slot = slotAt(dy) ?? source.position;
    setDrag({ position: source.position, dy, indicatorTop: indicatorTop(slot) });
  }

  function reorderUnit(sourceIndex: number, targetSlot: number) {
    const groups = exerciseUnits(slotsRef.current.map(slot => slot.exercise));
    const position = groups.findIndex(group => group.includes(sourceIndex));
    const order = position < 0 ? null : reorderRoutineUnitOrder(groups, position, targetSlot);
    const nextLatest = reorderRoutineUnits(latestExercises(), sourceIndex, targetSlot);
    if (nextLatest) submitEx(nextLatest);
    else setSaveFailed(true);
    if (!order) return;
    setSlots(values => {
      const reordered = order.map(index => values[index]).filter(Boolean);
      const bases = reordered.map(slot => ({ ...slot.exercise }));
      cleanupSg(bases);
      return reordered.map((slot, at) => ({ ...slot, exercise: bases[at] ?? slot.exercise }));
    });
  }

  function endDrag(delta: number) {
    const source = dragSource.current;
    const slot = source ? slotAt(delta) : null;
    dragSource.current = null;
    setDrag(null);
    if (!source || slot == null || slot === source.position) return;
    reorderUnit(source.index, slot);
  }

  function cancelDrag() {
    dragSource.current = null;
    setDrag(null);
  }

  function retrySave() {
    if (!routineId) return;
    const serialized = slotsRef.current.map(slot => serializeSlot(slot, profileRef.current));
    if (serialized.some(exercise => !exercise)) {
      Alert.alert('仍有无效输入', '请先修正组数、次数或重量，再重试保存。');
      return;
    }
    const ex = serialized.flatMap(exercise => exercise ? [{ ...exercise }] : []);
    cleanupSg(ex);
    const routineName = nameRef.current.trim() || DEFAULT_ROUTINE_NAME;
    const saved = onCommit([{
      kind: 'routine', create: false, routine: { id: routineId, name: routineName, ex },
    }]);
    if (saved) {
      savedNameRef.current = routineName;
      setSaveFailed(false);
    } else {
      setSaveFailed(true);
    }
  }

  function requestClose() {
    if (picking) {
      setPicking(false);
      return;
    }
    const invalidSlots = slots.filter(slot => slotInvalid(slot, profile));
    if (invalidSlots.length === 0 && !saveFailed) {
      onClose();
      return;
    }
    const parts: string[] = [];
    if (invalidSlots.length > 0) {
      const names = invalidSlots.map(slot => exerciseName(profile, slot.exercise.id)).join('、');
      parts.push(`以下动作有无效的组数、次数或重量，尚未保存：${names}。`);
    }
    if (saveFailed) parts.push('有改动未能写入本机，尚未保存。');
    Alert.alert('还有未提交的内容', `${parts.join('\n')}\n仍要离开吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '离开', style: 'destructive', onPress: onClose },
    ]);
  }

  closeRef.current = requestClose;

  useEffect(() => {
    if (routine || missingRef.current) return;
    missingRef.current = true;
    onMissing();
  }, [routine, onMissing]);

  useEffect(() => registerClose?.(() => closeRef.current()), [registerClose]);

  if (!routine) return null;

  function renderCard(index: number) {
    const slot = slots[index];
    if (!slot) return null;
    const unitPosition = units.findIndex(group => group.includes(index));
    const unit = unitPosition >= 0 ? units[unitPosition] : [index];
    const mode = exerciseMode(slot.exercise, profile);
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
    const canMoveUp = moveRoutineEntry(targets, index, -1) !== null;
    const canMoveDown = moveRoutineEntry(targets, index, 1) !== null;

    return (
      <Card key={slot.key}>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}>
          <PlanDragHandle
            accessibilityLabel={`拖动排序：${exerciseTitle}`}
            active={drag?.position === unitPosition}
            disabled={units.length < 2}
            index={index}
            onCancel={cancelDrag}
            onEnd={endDrag}
            onLift={beginDrag}
            onMove={moveDrag}
            onStart={startDrag}
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={2} variant="headline">{exerciseTitle}</Text>
            <Text style={{ marginTop: theme.space.xxs }} tone="secondary" variant="footnote">
              {summary}
            </Text>
          </View>
          <IconButton
            accessibilityLabel={`移除此动作：${exerciseTitle}`}
            name="trash"
            onPress={() => removeExercise(index)}
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
                applySlot(index, { ...makeSlot({ ...rest, mode: next }, profile), key: slot.key });
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
                  onChangeText={sets => applySlot(index, { ...slot, sets })}
                  value={slot.sets}
                />
              ) : null}
              <TextField
                containerStyle={{ flex: 1 }}
                keyboardType={mode === 'reps' ? 'default' : 'decimal-pad'}
                label={intensifier?.type === 'restpause' ? '热身次数' : amountLabel}
                onChangeText={amount => applySlot(index, { ...slot, amount })}
                value={slot.amount}
              />
              <TextField
                containerStyle={{ flex: 1 }}
                keyboardType="decimal-pad"
                label={loadLabel}
                onChangeText={load => applySlot(index, { ...slot, load })}
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
                    if (next) applySlot(index, { ...slot, exercise: { ...slot.exercise, intensifier: next } });
                    else {
                      const { intensifier: _intensifier, ...exercise } = slot.exercise;
                      applySlot(index, { ...slot, exercise });
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
                        if (value != null) applySlot(index, {
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
                        if (value != null) applySlot(index, {
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
                        if (value != null) applySlot(index, {
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
                        if (value != null) applySlot(index, {
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

            <View style={{ flexDirection: 'row', gap: theme.space.sm, marginTop: theme.space.sm }}>
              <Button
                accessibilityLabel={`上移 ${exerciseTitle}`}
                disabled={!canMoveUp}
                icon="chevronUp"
                onPress={() => moveEntry(index, -1)}
                size="sm"
                style={{ flex: 1 }}
                variant="secondary"
              >
                上移
              </Button>
              <Button
                accessibilityLabel={`下移 ${exerciseTitle}`}
                disabled={!canMoveDown}
                icon="chevronDown"
                onPress={() => moveEntry(index, 1)}
                size="sm"
                style={{ flex: 1 }}
                variant="secondary"
              >
                下移
              </Button>
            </View>

            {grouped || index > 0 ? (
              <Button onPress={() => toggleGroup(index)} size="sm" variant="secondary">
                {grouped ? '移出超级组' : '与上一动作组成超级组'}
              </Button>
            ) : null}
          </>
        ) : null}
      </Card>
    );
  }

  if (picking) {
    return (
      <ExerciseLibraryScreen
        connection={connection}
        onBack={() => setPicking(false)}
        onCustom={onCustom}
        onFavorite={onFavorite}
        onPick={(exercise: RoutineExercise) => {
          addExercise(exercise);
          setPicking(false);
        }}
        profile={profile}
        server={server}
      />
    );
  }

  return (
    <Screen testID="plan-editor-screen">
      <Header compact onBack={requestClose} title="编辑计划" />

      <TextField label="计划名称" maxLength={80} onChangeText={changeName} value={name} />
      <Text style={{ marginTop: theme.space.xs }} tone="secondary" variant="footnote">
        名称和动作修改会自动保存。组数、次数或重量无效时只留在表单，不会写入。
      </Text>
      <Text style={{ marginTop: theme.space.xxs }} tone="secondary" variant="footnote">
        长按动作左侧的手柄可拖动动作或整个超级组；展开动作后也可用上移、下移按钮。
      </Text>

      {saveFailed ? (
        <View style={{ gap: theme.space.sm, marginTop: theme.space.md }}>
          <Text tone="danger" variant="footnote">
            有改动尚未写入本机。检查存储空间后可以重试。
          </Text>
          <Button onPress={retrySave} size="sm" variant="danger">
            重试保存
          </Button>
        </View>
      ) : null}

      {slots.length === 0 ? (
        <View style={{ marginTop: theme.space.md }}>
          <EmptyState icon="dumbbell" text="从动作库选择动作，把它加入这个计划。" title="还没有动作" />
        </View>
      ) : (
        <View
          onLayout={event => { boxHeight.current = event.nativeEvent.layout.height; }}
          style={{ marginTop: theme.space.md, position: 'relative' }}
        >
          {units.map((unit, unitPosition) => {
            const unitKey = slots[unit[0]]?.key ?? String(unitPosition);
            const dragging = drag?.position === unitPosition;
            return (
              <View
                key={unitKey}
                onLayout={event => {
                  const { y, height } = event.nativeEvent.layout;
                  unitLayouts.current.set(unitKey, { y, height });
                }}
                style={dragging ? {
                  elevation: 4,
                  opacity: 0.96,
                  transform: [{ translateY: drag?.dy ?? 0 }],
                  zIndex: 4,
                } : undefined}
              >
                {unit.map(index => renderCard(index))}
              </View>
            );
          })}
          {drag?.indicatorTop != null ? (
            <View
              pointerEvents="none"
              style={{
                backgroundColor: theme.colors.accent,
                borderRadius: theme.radius.xs,
                height: 2,
                left: 0,
                position: 'absolute',
                right: 0,
                top: drag.indicatorTop - 1,
                zIndex: 5,
              }}
            />
          ) : null}
        </View>
      )}

      <Button icon="plus" onPress={() => setPicking(true)} style={{ marginTop: theme.space.md }} variant="tinted">
        添加计划动作
      </Button>

      <Button onPress={requestClose} style={{ marginTop: theme.space.md }} variant="primary">
        完成
      </Button>
    </Screen>
  );
}
