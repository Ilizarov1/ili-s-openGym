import { useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { Alert, BackHandler, PanResponder, ScrollView, useWindowDimensions, View } from 'react-native';
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
import { DropsetSheet } from './DropsetSheet';
import {
  MAX_WORK_SETS,
  REST_PAUSE_MAX,
  REST_PAUSE_MIN,
  WORKOUT_VIEWS,
  WORKOUT_VIEW_LABELS,
  addWorkSet,
  applyDraftDrops,
  convertDraftSetWarmup,
  copyDraftSet,
  draftClusterTotal,
  draftSegmentDone,
  draftSetHasProgress,
  dropSetProgress,
  editDraftSet,
  exerciseMode,
  exerciseName,
  nextDraftSegment,
  removeClusterSegment,
  removeSet,
  revertDraftDropset,
  seedDropSegment,
  setDraftEffort,
  setClusterSegment,
  setDropSegment,
  startDraftRest,
  toggleDraftSegment,
  updateSet,
  updateSetReps,
  validSet,
  validSetSegments,
  validWorkoutDay,
  workoutViewOf,
  type Draft,
  type DraftDrop,
  type DraftSet,
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
type SetMenu = { exerciseIndex: number; setIndex: number; setKey?: string };
type DropsetSheetState = {
  exerciseIndex: number;
  setIndex: number;
  mode: 'create' | 'edit';
  setKey?: string;
  title: string;
  drops: DraftDrop[];
};
type RatingSheet = {
  exerciseIndex: number;
  setIndex: number;
  scale: RatingScale;
  value: number | null;
  cardio: boolean;
};

function setNumberAt(sets: DraftSet[], index: number) {
  const set = sets[index];
  return sets.slice(0, index + 1).filter(row => !!row.warmup === !!set?.warmup).length;
}

function setRowKey(exerciseIndex: number, setIndex: number, set: { key?: string }) {
  return `${exerciseIndex}:${set.key ?? setIndex}`;
}

function dropSegmentKey(drop: DraftDrop, index: number) {
  return typeof drop.key === 'string' && drop.key !== '' ? drop.key : `d${index}`;
}

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

export function WorkoutScreen({ profile, draft, e2e = false, onChange, onFinish, onDiscard, onCollapse, onPick }: WorkoutScreenProps) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const list = useRef<ScrollView>(null);
  const unitTops = useRef(new Map<number, number>());
  const memberOffsets = useRef(new Map<number, number>());
  const highWater = useRef<number[]>([]);
  const setCounts = useRef<number[]>([]);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const [menu, setMenu] = useState<Menu>(null);
  const [rowMenu, setRowMenu] = useState<SetMenu | null>(null);
  const [dropsetSheet, setDropsetSheet] = useState<DropsetSheetState | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const [jump, setJump] = useState(false);
  const [rating, setRating] = useState<RatingSheet | null>(null);
  const [finishOpen, setFinishOpen] = useState(false);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [openedState, setOpenedState] = useState(() => ({
    length: draft.exercises.length,
    keys: new Set<string>(),
  }));
  const effort = effortPreferenceOf(profile);
  // A 320dp window only fits six columns when the page and card each use 8dp.
  const narrow = width <= 360;
  const pagePadding = narrow ? theme.space.sm : theme.layout.pagePadding;
  const cardPadding = narrow ? theme.space.sm : theme.layout.cardPadding;
  const column = theme.sizes.touch;
  const cellGap = theme.space.xxs;

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
  const sheetSet = dropsetSheet
    ? draft.exercises[dropsetSheet.exerciseIndex]?.sets[dropsetSheet.setIndex]
    : undefined;
  const sheetMatches = !!sheetSet &&
    (dropsetSheet?.setKey == null || sheetSet.key == null || sheetSet.key === dropsetSheet.setKey);

  // Android Back closes this screen's own sheets first; App's handler only sees the
  // next press and puts the workout aside.
  useEffect(() => {
    if (!menu && !rowMenu && !dropsetSheet && !jump && !rating && !finishOpen && !completeOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (dropsetSheet) setDropsetSheet(null);
      else if (rowMenu) setRowMenu(null);
      else if (rating) setRating(null);
      else if (menu) setMenu(null);
      else if (jump) setJump(false);
      else if (completeOpen) setCompleteOpen(false);
      else if (finishOpen) setFinishOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [completeOpen, dropsetSheet, finishOpen, jump, menu, rating, rowMenu]);

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

  function commit(next: Draft) {
    const saved = onChange(next);
    if (saved) latestDraft.current = next;
    return saved;
  }

  function exerciseMenuItems(index: number): MenuItem[] {
    const exercise = draft.exercises[index];
    if (!exercise) return [];
    const { unit } = groups[index];
    const grouped = unit.length > 1;
    const affected = grouped ? unit : [...(groups[index - 1]?.unit ?? []), index];
    // Partial dropset ticks are recorded work too: they lock replacement and grouping.
    const canGroup = affected.every(row => draft.exercises[row].sets.every(set => !draftSetHasProgress(set)));
    const locked = exercise.sets.some(draftSetHasProgress);
    const items: MenuItem[] = [];
    if (!locked) {
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

  function openDropsetSheet(exerciseIndex: number, setIndex: number, mode: 'create' | 'edit', expectedKey?: string) {
    const current = latestDraft.current;
    const set = current.exercises[exerciseIndex]?.sets[setIndex];
    if (!set || set.at !== null || set.warmup) return;
    if (expectedKey != null && set.key != null && set.key !== expectedKey) return;
    if (mode === 'create') {
      const seed = seedDropSegment(current, exerciseIndex, setIndex, profile);
      if (!seed) {
        Alert.alert('无法改为递减组', '这一组当前不能设置降重分段。');
        return;
      }
      setDropsetSheet({
        exerciseIndex,
        setIndex,
        mode,
        setKey: set.key,
        title: `第 ${setNumberAt(current.exercises[exerciseIndex].sets, setIndex)} 组 · 改为递减组`,
        drops: [seed],
      });
      return;
    }
    setDropsetSheet({
      exerciseIndex,
      setIndex,
      mode,
      setKey: set.key,
      title: `第 ${setNumberAt(current.exercises[exerciseIndex].sets, setIndex)} 组 · 编辑递减段`,
      drops: (set.drops ?? []).map(drop => ({ ...drop })),
    });
  }

  function saveDropset(drops: DraftDrop[]) {
    if (!dropsetSheet) return;
    const { exerciseIndex, setIndex, setKey } = dropsetSheet;
    const current = latestDraft.current;
    const set = current.exercises[exerciseIndex]?.sets[setIndex];
    if (!set || (setKey != null && set.key != null && set.key !== setKey)) {
      setDropsetSheet(null);
      return;
    }
    const next = applyDraftDrops(current, exerciseIndex, setIndex, drops);
    if (!next) {
      Alert.alert('无法保存递减组', '这一组当前不能设置降重分段。');
      return;
    }
    const savedSet = next.exercises[exerciseIndex]?.sets[setIndex];
    if (!commit(next)) return;
    if (savedSet) setRowOpen(setRowKey(exerciseIndex, setIndex, savedSet), true);
    setDropsetSheet(null);
  }

  function quickAddDrop(exerciseIndex: number, setIndex: number) {
    const current = latestDraft.current;
    const set = current.exercises[exerciseIndex]?.sets[setIndex];
    if (!set || set.at !== null || set.type !== 'dropset') return;
    const seed = seedDropSegment(current, exerciseIndex, setIndex, profile);
    if (!seed) return;
    const next = applyDraftDrops(current, exerciseIndex, setIndex, [...(set.drops ?? []), seed]);
    if (next) commit(next);
  }

  /** Last drop's segment id, the only segment that may be unticked after whole completion. */
  function lastDropSegment(set: DraftSet) {
    const drops = set.drops ?? [];
    const last = drops[drops.length - 1];
    return last ? dropSegmentKey(last, drops.length - 1) : null;
  }

  /** The last ticked segment in display order; only this one can be undone. */
  function lastDoneDropSegment(set: DraftSet) {
    const drops = set.drops ?? [];
    for (let index = drops.length - 1; index >= 0; index--) {
      if (drops[index].at != null) return dropSegmentKey(drops[index], index);
    }
    return set.mainAt != null ? 'main' : null;
  }

  function toggleDropsetSegment(
    exerciseIndex: number,
    setIndex: number,
    segment: string,
    expectedDone: boolean,
    options?: FocusToggleOptions,
  ) {
    const current = latestDraft.current;
    const exercise = current.exercises[exerciseIndex];
    const set = exercise?.sets[setIndex];
    if (!exercise || !set || set.type !== 'dropset') return;
    const complete = set.at !== null;
    if (complete) {
      // Completed structures are locked: only the final drop can go back to work.
      if (segment !== lastDropSegment(set)) return;
    } else {
      const next = nextDraftSegment(set);
      const lastDone = lastDoneDropSegment(set);
      if (segment !== next && segment !== lastDone) return;
      // Undoing the last ticked segment is always allowed; completing the next
      // segment still needs valid values and the superset turn.
      if (!expectedDone) {
        if (!validSet(set, exerciseMode(exercise.target, profile)) || !validSetSegments(set)) return;
        const { unit, nextSet } = groups[exerciseIndex];
        const grouped = unit.length > 1;
        const turn = !grouped || (nextSet?.exerciseIndex === exerciseIndex && nextSet.setIndex === setIndex);
        if (!turn) return;
      }
    }
    const at = Date.now();
    // The expectation comes from the pressed control's rendered state, not from the
    // newest draft: a doubled tap then carries the same old state and is a no-op
    // instead of undoing the completion the first tap just committed.
    const result = toggleDraftSegment(current, exerciseIndex, setIndex, segment, expectedDone, at);
    if (!result.changed) return;
    if (result.completed) {
      finishSetCompletion(result.draft, exerciseIndex, setIndex, at, options);
      return;
    }
    if (result.undone) {
      const controlsRest = current.rest?.exerciseIndex === exerciseIndex && current.rest.setIndex === setIndex;
      commit(controlsRest ? { ...result.draft, rest: null } : result.draft);
      return;
    }
    commit(result.draft);
  }

  /**
   * The one completion path for every layout. Segment completion reaches it with
   * the draft that already carries `at`; a plain checkbox reaches it with the same
   * shape. Rest, superset flow, folding, focus movement and the finish prompt are
   * never computed anywhere else.
   */
  function finishSetCompletion(
    nextDraft: Draft,
    exerciseIndex: number,
    setIndex: number,
    at: number,
    options?: FocusToggleOptions,
  ) {
    let next = nextDraft;
    let scrollTarget: number | null = null;
    const exercise = next.exercises[exerciseIndex];
    if (!exercise) return;
    const doneCount = exercise.sets.filter(row => row.at !== null).length;
    const previous = highWater.current[exerciseIndex] ?? 0;
    const isNew = doneCount > previous;

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
          scrollTarget = upcoming[0];
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
    const finalDraft = { ...next, rest };
    if (!commit(finalDraft)) return;
    highWater.current[exerciseIndex] = Math.max(previous, doneCount);
    if (scrollTarget != null) scrollToExercise(scrollTarget);
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

  function toggleSet(exerciseIndex: number, setIndex: number, options?: FocusToggleOptions) {
    const current = latestDraft.current;
    const exercise = current.exercises[exerciseIndex];
    const set = exercise?.sets[setIndex];
    if (!exercise || !set) return;
    // No layout may tick a whole dropset directly; focus and older callers advance
    // one segment at a time until the final drop commits the set. A completed
    // dropset is undone only through its last segment checkbox.
    if (set.type === 'dropset') {
      if (set.at === null) {
        const segment = nextDraftSegment(set);
        if (segment) {
          toggleDropsetSegment(exerciseIndex, setIndex, segment, draftSegmentDone(set, segment), options);
        }
      }
      return;
    }
    const complete = set.at !== null;
    const at = complete ? null : Date.now();
    const next = updateSet(current, exerciseIndex, setIndex, { at });
    if (at === null) {
      const controlsRest = current.rest?.exerciseIndex === exerciseIndex && current.rest.setIndex === setIndex;
      commit(controlsRest ? { ...next, rest: null } : next);
      return;
    }
    finishSetCompletion(next, exerciseIndex, setIndex, at, options);
  }

  function requestRevertDropset(exerciseIndex: number, setIndex: number, expectedKey?: string) {
    const current = latestDraft.current;
    const set = current.exercises[exerciseIndex]?.sets[setIndex];
    if (!set || set.at !== null) return;
    if (expectedKey != null && set.key != null && set.key !== expectedKey) return;
    const key = expectedKey ?? set.key;
    const apply = () => {
      const latest = latestDraft.current;
      const target = latest.exercises[exerciseIndex]?.sets[setIndex];
      if (!target || (key != null && target.key != null && target.key !== key)) return;
      commit(revertDraftDropset(latest, exerciseIndex, setIndex));
    };
    if (draftSetHasProgress(set)) {
      Alert.alert(
        '改为普通组？',
        '已勾选的分段进度会被清除。主段的重量、次数和评分保留，这一组不会开始或重置休息。',
        [
          { text: '取消', style: 'cancel' },
          { text: '改为普通组', style: 'destructive', onPress: apply },
        ],
      );
      return;
    }
    apply();
  }

  function requestDeleteSet(exerciseIndex: number, setIndex: number, expectedKey?: string) {
    const current = latestDraft.current;
    const set = current.exercises[exerciseIndex]?.sets[setIndex];
    if (!set || set.at !== null) return;
    if (expectedKey != null && set.key != null && set.key !== expectedKey) return;
    const key = expectedKey ?? set.key;
    const apply = () => {
      const latest = latestDraft.current;
      const target = latest.exercises[exerciseIndex]?.sets[setIndex];
      if (!target || (key != null && target.key != null && target.key !== key)) return;
      commit(removeSet(latest, exerciseIndex, setIndex));
    };
    if (draftSetHasProgress(set)) {
      Alert.alert(
        '删除有进度的组？',
        '这一组已勾选的分段进度会丢失。',
        [
          { text: '取消', style: 'cancel' },
          { text: '删除', style: 'destructive', onPress: apply },
        ],
      );
      return;
    }
    apply();
  }

  function setMenuItems(exerciseIndex: number, setIndex: number, expectedKey?: string): MenuItem[] {
    const exercise = draft.exercises[exerciseIndex];
    const set = exercise?.sets[setIndex];
    if (!exercise || !set) return [];
    if (expectedKey != null && set.key != null && set.key !== expectedKey) return [];
    const mode = exerciseMode(exercise.target, profile);
    const complete = set.at !== null;
    const items: MenuItem[] = [];
    const workSets = exercise.sets.filter(row => !row.warmup).length;
    const canCopy = set.warmup || workSets < MAX_WORK_SETS;
    const copyItem: MenuItem = {
      label: '复制这一组',
      icon: 'copy',
      onPress: () => {
        const latest = latestDraft.current;
        const target = latest.exercises[exerciseIndex]?.sets[setIndex];
        if (!target || (expectedKey != null && target.key != null && target.key !== expectedKey)) return;
        commit(copyDraftSet(latest, exerciseIndex, setIndex));
      },
    };
    const deleteItem: MenuItem = {
      label: '删除这一组',
      icon: 'trash',
      tone: 'danger',
      onPress: () => requestDeleteSet(exerciseIndex, setIndex, expectedKey),
    };
    const warmupItem = (warmup: boolean): MenuItem => ({
      label: warmup ? '设为热身组' : '改为正式组',
      icon: 'sun',
      onPress: () => {
        const latest = latestDraft.current;
        const target = latest.exercises[exerciseIndex]?.sets[setIndex];
        if (!target) return;
        if (expectedKey != null && target.key != null && target.key !== expectedKey) return;
        commit(convertDraftSetWarmup(latest, exerciseIndex, setIndex, warmup));
      },
    });

    if (set.type === 'restpause') {
      // Legacy rest-pause keeps copy/delete only; no conversion or add entry.
      if (canCopy) items.push(copyItem);
      if (!complete) items.push(deleteItem);
      return items;
    }
    if (set.type === 'dropset') {
      if (!complete) {
        items.push(
          { label: '编辑分段', icon: 'pencil', onPress: () => openDropsetSheet(exerciseIndex, setIndex, 'edit', expectedKey) },
          { label: '改为普通组', icon: 'undo', onPress: () => requestRevertDropset(exerciseIndex, setIndex, expectedKey) },
        );
      }
      if (canCopy) items.push(copyItem);
      if (!complete) items.push(deleteItem);
      return items;
    }
    if (set.warmup) {
      items.push(warmupItem(false));
      if (canCopy) items.push(copyItem);
      if (!complete) items.push(deleteItem);
      return items;
    }
    if (mode === 'reps') {
      items.push(warmupItem(true));
      if (!complete) {
        items.push(
          { label: '改为递减组', icon: 'arrowDown', onPress: () => openDropsetSheet(exerciseIndex, setIndex, 'create', expectedKey) },
        );
      }
      if (canCopy) items.push(copyItem);
      if (!complete) items.push(deleteItem);
      return items;
    }
    if (canCopy) items.push(copyItem);
    if (!complete) items.push(deleteItem);
    return items;
  }

  function setMenuTitle(target: SetMenu | null) {
    if (!target) return undefined;
    const sets = draft.exercises[target.exerciseIndex]?.sets;
    const set = sets?.[target.setIndex];
    if (!sets || !set) return undefined;
    if (target.setKey != null && set.key != null && set.key !== target.setKey) return undefined;
    const label = set.warmup
      ? `热身第 ${setNumberAt(sets, target.setIndex)} 组`
      : `第 ${setNumberAt(sets, target.setIndex)} 组`;
    return set.type === 'dropset' ? `${label} · 递减组` : label;
  }

  function setRowOpen(key: string, open: boolean) {
    setExpandedRows(previous => {
      const next = new Set(previous);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleRowOpen(key: string) {
    setExpandedRows(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
    const canGroup = affected.every(index =>
      draft.exercises[index].sets.every(set => !draftSetHasProgress(set)));
    const mode = exerciseMode(exercise.target, profile);
    const weightLabel = mode === 'cardio' ? '速度' : '重量';
    const amountLabel = mode === 'cardio' ? '分钟' : mode === 'time' ? '秒' : '次数';
    const actions = exerciseMenuItems(exerciseIndex);
    // Strength work sets follow the profile scale. Cardio always asks for RPE
    // (a run has no reps left); timed holds keep their own entry points.
    const ratingScale: RatingScale | null = effort === 'none'
      ? null
      : mode === 'cardio' ? 'rpe' : mode === 'reps' ? effort : null;
    // A saved per-set scale outlives a later profile change, so the header reads
    // the scales actually on the card rather than the current setting alone.
    const cardScales = new Set<RatingScale>();
    for (const row of exercise.sets) {
      if (row.warmup) continue;
      const scale = row.effortScale ?? ratingScale;
      if (scale) cardScales.add(scale);
    }
    const showRating = cardScales.size > 0;
    const showRowScale = cardScales.size > 1;
    const ratingHeader = cardScales.size === 1 ? scaleName([...cardScales][0]) : '评分';

    return (
      <View
        key={exerciseIndex}
        onLayout={event => memberOffsets.current.set(exerciseIndex, event.nativeEvent.layout.y)}
      >
        <Card gap={theme.space.sm} style={{ marginBottom: 0, padding: cardPadding }}>
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

          <View style={{ alignItems: 'center', flexDirection: 'row', gap: cellGap }}>
            <Text style={{ textAlign: 'center', width: column }} tone="tertiary" variant="caption">组</Text>
            <Text style={{ flex: 1, minWidth: column, textAlign: 'center' }} tone="tertiary" variant="caption">
              {weightLabel === '重量' ? `重量·${draft.unit}` : weightLabel}
            </Text>
            <Text style={{ flex: 1, minWidth: column, textAlign: 'center' }} tone="tertiary" variant="caption">
              {amountLabel}
            </Text>
            {showRating ? (
              <Text style={{ textAlign: 'center', width: column }} tone="tertiary" variant="caption">
                {ratingHeader}
              </Text>
            ) : null}
            <Text style={{ textAlign: 'center', width: column }} tone="tertiary" variant="caption">完成</Text>
            <View style={{ width: column }} />
          </View>

          {exercise.sets.map((set, setIndex) => {
            const complete = set.at !== null;
            const isDropset = set.type === 'dropset';
            const isRestpause = set.type === 'restpause';
            const drops = isDropset ? set.drops ?? [] : [];
            const clusters = isRestpause ? set.clusters ?? [] : [];
            const progress = dropSetProgress(set);
            const segmentsValid = validSetSegments(set);
            const valid = validSet(set, mode) && segmentsValid;
            const available = (complete || valid) && (!grouped || complete ||
              (nextSet?.exerciseIndex === exerciseIndex && nextSet.setIndex === setIndex));
            const number = setNumberAt(exercise.sets, setIndex);
            const label = set.warmup ? `热身第 ${number} 组` : `第 ${number} 组`;
            const controlLabel = grouped ? `${name} ${label}` : label;
            const rowKey = setRowKey(exerciseIndex, setIndex, set);
            const expanded = expandedRows.has(rowKey);
            // A row already rated in this draft keeps its own scale, exactly like
            // history: changing the setting later relabels only unrated rows.
            const setScale = set.warmup ? null : set.effortScale ?? ratingScale;
            const ratingValue = setScale ? draftEffortOf(set, setScale) : null;
            const ratingLabel = setScale
              ? ratingValue == null
                ? `${scaleName(setScale)} 未评分`
                : `${scaleName(setScale)} ${formatEffort(ratingValue)}`
              : '';
            const lastSegment = lastDropSegment(set);
            const nextSegment = nextDraftSegment(set);
            const lastDoneSegment = lastDoneDropSegment(set);
            const editWeight = (weight: string) => commit(
              editDraftSet(latestDraft.current, exerciseIndex, setIndex, 'weight', weight, profile),
            );
            const editReps = (reps: string) => {
              const retotaled = set.type === 'restpause'
                ? updateSetReps(latestDraft.current, exerciseIndex, setIndex, reps)
                : latestDraft.current;
              commit(editDraftSet(retotaled, exerciseIndex, setIndex, 'reps', reps, profile));
            };
            const dropsSummary = [
              `${set.weight} ${draft.unit} × ${set.reps}`,
              ...drops.map(drop => `${drop.w} ${draft.unit} × ${drop.r}`),
            ].join(' → ');

            const segmentCheckbox = (segment: string, segmentLabel: string, checked: boolean, enabled: boolean, testID: string) => (
              <PressableScale
                accessibilityLabel={`${controlLabel}${segmentLabel}${checked ? '已完成' : '未完成'}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked, disabled: !enabled }}
                disabled={!enabled}
                onPress={() => toggleDropsetSegment(exerciseIndex, setIndex, segment, checked)}
                scaleTo={theme.motion.pressScaleSmall}
                style={{ alignItems: 'center', height: column, justifyContent: 'center', width: column }}
                testID={testID}
              >
                <View
                  style={{
                    alignItems: 'center',
                    backgroundColor: checked
                      ? theme.colors.accent
                      : enabled ? theme.colors.surface3 : theme.colors.surface2,
                    borderRadius: theme.radius.sm,
                    height: theme.sizes.tileMd,
                    justifyContent: 'center',
                    opacity: checked || enabled ? 1 : 0.55,
                    width: theme.sizes.tileMd,
                  }}
                >
                  <Icon
                    color={checked
                      ? theme.colors.onAccent
                      : enabled ? theme.colors.label : theme.colors.label4}
                    name="check"
                    size={theme.sizes.buttonIcon}
                  />
                </View>
              </PressableScale>
            );

            return (
              <View
                key={set.key ?? String(setIndex)}
                style={{ gap: theme.space.xs }}
                testID={`workout-row-${exerciseIndex}-${setIndex}`}
              >
                <View style={{ alignItems: 'center', flexDirection: 'row', gap: cellGap }}>
                  <View style={{ alignItems: 'center', justifyContent: 'center', minHeight: column, width: column }}>
                    {isDropset ? (
                      <PressableScale
                        accessibilityLabel={`${controlLabel}递减段${expanded ? '已展开' : '已收起'}`}
                        accessibilityRole="button"
                        accessibilityState={{ expanded }}
                        onPress={() => toggleRowOpen(rowKey)}
                        scaleTo={theme.motion.pressScaleSmall}
                        style={{ alignItems: 'center', height: column, justifyContent: 'center', width: column }}
                        testID={`set-expand-${exerciseIndex}-${setIndex}`}
                      >
                        <Text numberOfLines={1} tone={complete ? 'tertiary' : 'secondary'} variant="footnote">
                          {`${number} ${expanded ? '▾' : '▸'}`}
                        </Text>
                      </PressableScale>
                    ) : (
                      <Text style={{ textAlign: 'center' }} tone={complete ? 'tertiary' : 'secondary'} variant="footnote">
                        {set.warmup ? `热身${number}` : number}
                      </Text>
                    )}
                  </View>
                  <View style={{ flex: 1, minWidth: column }}>
                    <SetField
                      accessibilityLabel={`${controlLabel}${weightLabel}`}
                      field="weight"
                      keyboardType="decimal-pad"
                      min={0}
                      mode={mode}
                      onChangeText={editWeight}
                      presentation="inline"
                      step={mode === 'cardio' ? 0.5 : 2.5}
                      testID={`set-weight-${exerciseIndex}-${setIndex}`}
                      value={set.weight}
                    />
                  </View>
                  <View style={{ flex: 1, minWidth: column }}>
                    <SetField
                      accessibilityLabel={`${controlLabel}${isRestpause ? '总次数' : amountLabel}`}
                      field="reps"
                      keyboardType={mode === 'cardio' ? 'decimal-pad' : 'number-pad'}
                      min={0}
                      mode={mode}
                      onChangeText={editReps}
                      presentation="inline"
                      step={mode === 'time' ? 5 : 1}
                      testID={`set-reps-${exerciseIndex}-${setIndex}`}
                      value={set.reps}
                    />
                  </View>
                  {showRating ? (
                    setScale != null ? (
                      <PressableScale
                        accessibilityLabel={`${controlLabel}${ratingLabel}`}
                        accessibilityRole="button"
                        onPress={() => setRating({
                          exerciseIndex,
                          setIndex,
                          scale: setScale,
                          value: ratingValue,
                          cardio: mode === 'cardio',
                        })}
                        scaleTo={theme.motion.pressScaleSmall}
                        style={{ alignItems: 'center', height: column, justifyContent: 'center', width: column }}
                        testID={`set-rating-${exerciseIndex}-${setIndex}`}
                      >
                        <View style={{ alignItems: 'center', justifyContent: 'center' }}>
                          {showRowScale ? (
                            <Text tone="tertiary" variant="caption2">
                              {scaleName(setScale)}
                            </Text>
                          ) : null}
                          <Text
                            tone={ratingValue == null ? 'tertiary' : 'accent'}
                            variant="footnote"
                            weight={ratingValue == null ? undefined : '600'}
                          >
                            {ratingValue == null ? '—' : formatEffort(ratingValue)}
                          </Text>
                        </View>
                      </PressableScale>
                    ) : (
                      <View
                        accessibilityLabel={`${controlLabel}评分不可用`}
                        accessibilityState={{ disabled: true }}
                        accessible
                        style={{ height: column, width: column }}
                      />
                    )
                  ) : null}
                  {isDropset ? (
                    <PressableScale
                      accessibilityLabel={`${controlLabel}递减组 ${progress.done}/${progress.total} 段${expanded ? '已展开' : '已收起'}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                      onPress={() => toggleRowOpen(rowKey)}
                      scaleTo={theme.motion.pressScaleSmall}
                      style={{ alignItems: 'center', height: column, justifyContent: 'center', width: column }}
                      testID={`set-done-${exerciseIndex}-${setIndex}`}
                    >
                      {progress.complete ? (
                        <View
                          style={{
                            alignItems: 'center',
                            backgroundColor: theme.colors.accent,
                            borderRadius: theme.radius.sm,
                            height: theme.sizes.tileMd,
                            justifyContent: 'center',
                            width: theme.sizes.tileMd,
                          }}
                        >
                          <Icon color={theme.colors.onAccent} name="check" size={theme.sizes.buttonIcon} />
                        </View>
                      ) : (
                        <Text
                          numberOfLines={1}
                          tone={progress.done > 0 ? 'accent' : 'secondary'}
                          variant="caption"
                        >
                          {`${progress.done}/${progress.total}`}
                        </Text>
                      )}
                    </PressableScale>
                  ) : (
                    <PressableScale
                      accessibilityLabel={`${controlLabel}完成`}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: complete, disabled: !available }}
                      disabled={!available}
                      onPress={() => toggleSet(exerciseIndex, setIndex)}
                      scaleTo={theme.motion.pressScaleSmall}
                      style={{ alignItems: 'center', height: column, justifyContent: 'center', width: column }}
                      testID={`set-done-${exerciseIndex}-${setIndex}`}
                    >
                      <View
                        style={{
                          alignItems: 'center',
                          backgroundColor: complete ? theme.colors.accent : theme.colors.surface2,
                          borderRadius: theme.radius.sm,
                          height: theme.sizes.tileMd,
                          justifyContent: 'center',
                          width: theme.sizes.tileMd,
                        }}
                      >
                        <Icon
                          color={complete ? theme.colors.onAccent : theme.colors.label3}
                          name="check"
                          size={theme.sizes.buttonIcon}
                        />
                      </View>
                    </PressableScale>
                  )}
                  <View style={{ alignItems: 'center', justifyContent: 'center', width: column }}>
                    <IconButton
                      accessibilityLabel={`${controlLabel}菜单`}
                      name="more"
                      onPress={() => setRowMenu({ exerciseIndex, setIndex, setKey: set.key })}
                      size="sm"
                      testID={`set-menu-${exerciseIndex}-${setIndex}`}
                    />
                  </View>
                </View>

                {isDropset && !expanded ? (
                  <Text style={{ paddingLeft: column }} tone="secondary" variant="caption">
                    {`递减组 · ${dropsSummary}`}
                  </Text>
                ) : null}

                {isDropset && expanded ? (
                  <View style={{ gap: theme.space.xs }}>
                    <View style={{ alignItems: 'center', flexDirection: 'row', gap: cellGap }}>
                      <Text style={{ textAlign: 'center', width: column }} tone="secondary" variant="caption">
                        主段
                      </Text>
                      <Text style={{ flex: 1, minWidth: column }} tone="secondary" variant="footnote">
                        {`${set.weight} ${draft.unit} × ${set.reps} 次`}
                      </Text>
                      {showRating ? <View style={{ width: column }} /> : null}
                      {segmentCheckbox(
                        'main',
                        '主段',
                        draftSegmentDone(set, 'main'),
                        complete
                          ? false
                          : (nextSegment === 'main' || lastDoneSegment === 'main') && available,
                        `set-main-done-${exerciseIndex}-${setIndex}`,
                      )}
                      <View style={{ width: column }} />
                    </View>

                    {drops.map((drop, dropIndex) => {
                      const segment = dropSegmentKey(drop, dropIndex);
                      const checked = draftSegmentDone(set, segment);
                      const enabled = complete
                        ? segment === lastSegment
                        : (segment === nextSegment || segment === lastDoneSegment) && available;
                      return (
                        <View
                          key={drop.key ?? `d${dropIndex}`}
                          style={{ alignItems: 'center', flexDirection: 'row', gap: cellGap }}
                        >
                          <Text style={{ textAlign: 'center', width: column }} tone="secondary" variant="caption">
                            {`降重 ${dropIndex + 1}`}
                          </Text>
                          <View style={{ flex: 1, minWidth: column }}>
                            <SetField
                              accessibilityLabel={`${controlLabel}降重${dropIndex + 1}${weightLabel}`}
                              field="weight"
                              keyboardType="decimal-pad"
                              min={0}
                              mode="reps"
                              onChangeText={weight => commit(setDropSegment(latestDraft.current, exerciseIndex, setIndex, dropIndex, { w: weight }))}
                              presentation="inline"
                              step={2.5}
                              testID={`drop-weight-${exerciseIndex}-${setIndex}-${dropIndex}`}
                              value={drop.w}
                            />
                          </View>
                          <View style={{ flex: 1, minWidth: column }}>
                            <SetField
                              accessibilityLabel={`${controlLabel}降重${dropIndex + 1}次数`}
                              field="reps"
                              keyboardType="number-pad"
                              min={1}
                              mode="reps"
                              onChangeText={reps => commit(setDropSegment(latestDraft.current, exerciseIndex, setIndex, dropIndex, { r: reps }))}
                              presentation="inline"
                              step={1}
                              testID={`drop-reps-${exerciseIndex}-${setIndex}-${dropIndex}`}
                              value={drop.r}
                            />
                          </View>
                          {showRating ? <View style={{ width: column }} /> : null}
                          {segmentCheckbox(
                            segment,
                            `降重${dropIndex + 1}`,
                            checked,
                            enabled,
                            `drop-done-${exerciseIndex}-${setIndex}-${dropIndex}`,
                          )}
                          <View style={{ width: column }} />
                        </View>
                      );
                    })}

                    {!complete ? (
                      <View style={{ flexDirection: 'row' }}>
                        <Button
                          icon="arrowDown"
                          onPress={() => quickAddDrop(exerciseIndex, setIndex)}
                          size="xs"
                          testID={`drop-add-${exerciseIndex}-${setIndex}`}
                          variant="ghost"
                        >
                          添加降重段
                        </Button>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {isRestpause && !set.warmup && mode === 'reps' ? (
                  <View style={{ gap: theme.space.xs }}>
                    <PressableScale
                      accessibilityLabel={`${controlLabel}休息暂停组，${clusters.length} 段，总 ${draftClusterTotal(set)} 次${expanded ? '，已展开' : '，已收起'}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                      onPress={() => toggleRowOpen(rowKey)}
                      scaleTo={theme.motion.pressScaleSmall}
                      style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm, minHeight: column }}
                      testID={`set-expand-${exerciseIndex}-${setIndex}`}
                    >
                      <Text style={{ flex: 1 }} tone="secondary" variant="footnote">
                        {`休息暂停组 · ${clusters.length} 段 · 总 ${draftClusterTotal(set)} 次`}
                      </Text>
                      <Icon
                        color={theme.colors.label3}
                        name={expanded ? 'chevronUp' : 'chevronDown'}
                        size={theme.sizes.buttonIcon}
                      />
                    </PressableScale>
                    {expanded ? clusters.map((cluster, clusterIndex) => (
                      <View
                        key={cluster.key ?? `c${clusterIndex}`}
                        style={{ alignItems: 'center', flexDirection: 'row', gap: cellGap }}
                      >
                        <Text style={{ textAlign: 'center', width: column }} tone="secondary" variant="caption">
                          {`分段${clusterIndex + 1}`}
                        </Text>
                        <View style={{ flex: 1, minWidth: column }}>
                          <Stepper
                            accessibilityLabel={`${controlLabel}分段${clusterIndex + 1}次数`}
                            keyboardType="number-pad"
                            min={1}
                            onChangeText={reps => commit(setClusterSegment(latestDraft.current, exerciseIndex, setIndex, clusterIndex, { r: reps }))}
                            step={1}
                            value={cluster.r}
                          />
                        </View>
                        <View style={{ flex: 1, minWidth: column }}>
                          <Stepper
                            accessibilityLabel={`${controlLabel}分段${clusterIndex + 1}短休秒数`}
                            keyboardType="number-pad"
                            max={REST_PAUSE_MAX}
                            min={REST_PAUSE_MIN}
                            onChangeText={restSec => commit(setClusterSegment(latestDraft.current, exerciseIndex, setIndex, clusterIndex, { restSec }))}
                            step={5}
                            value={cluster.restSec}
                          />
                        </View>
                        <IconButton
                          accessibilityLabel={`删除${controlLabel}分段${clusterIndex + 1}`}
                          name="xmark"
                          onPress={() => commit(removeClusterSegment(latestDraft.current, exerciseIndex, setIndex, clusterIndex))}
                          size="sm"
                        />
                      </View>
                    )) : null}
                  </View>
                ) : null}

                {!segmentsValid && (isDropset || isRestpause) ? (
                  <Text tone="danger" variant="caption">
                    {isRestpause
                      ? '分段的数据无效，补全次数和短休后才能完成这一组。'
                      : '递减段的数据无效，补全重量和次数后才能完成这一组。'}
                  </Text>
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

          {!denseCard && (grouped || exerciseIndex > 0) ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
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
            </View>
          ) : null}
        </Card>
      </View>
    );
  }

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']} scroll={false} testID="workout-screen">
      <View style={{ paddingHorizontal: pagePadding }}>
        <Header
          backLabel="收起"
          compact
          onBack={backfill ? undefined : onCollapse}
          right={(
            <>
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
          paddingHorizontal: pagePadding,
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
          <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm }}>
            <Elapsed start={draft.start} frozen={e2e} />
            {listMode && units.length > 0 ? (
              <Button icon="list" onPress={() => setJump(true)} size="xs" variant="secondary">
                跳转动作
              </Button>
            ) : null}
          </View>
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
        items={rowMenu ? setMenuItems(rowMenu.exerciseIndex, rowMenu.setIndex, rowMenu.setKey) : []}
        onClose={() => setRowMenu(null)}
        title={setMenuTitle(rowMenu)}
        visible={rowMenu != null}
      />
      {dropsetSheet && sheetSet && sheetMatches ? (
        <DropsetSheet
          initialDrops={dropsetSheet.drops}
          mainDone={sheetSet.mainAt != null}
          mainReps={sheetSet.reps}
          mainWeight={sheetSet.weight}
          mode={dropsetSheet.mode}
          onClose={() => setDropsetSheet(null)}
          onSave={saveDropset}
          seedDrop={base => seedDropSegment(
            latestDraft.current,
            dropsetSheet.exerciseIndex,
            dropsetSheet.setIndex,
            profile,
            base ?? undefined,
          )}
          title={dropsetSheet.title}
          unit={draft.unit}
          visible
        />
      ) : null}
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
            onChange(setDraftEffort(latestDraft.current, rating.exerciseIndex, rating.setIndex, null, null));
            setRating(null);
          }}
          onClose={() => setRating(null)}
          onSave={value => {
            onChange(setDraftEffort(latestDraft.current, rating.exerciseIndex, rating.setIndex, rating.scale, value));
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
        partial={draft.exercises.reduce((count, exercise) => count +
          exercise.sets.filter(set => set.type === 'dropset' && set.at === null && draftSetHasProgress(set)).length, 0)}
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
