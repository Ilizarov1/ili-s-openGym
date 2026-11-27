/**
 * `proposal_action` — the one GenUI node that writes to the plan.
 *
 * Everything here is a proposal, never an automatic edit: each change is a checkbox row the user
 * can deselect, the primary button applies the selected subset through `onApply`, and an already
 * applied node locks into a read-only "已采纳" state with the menu undo hint. `add-routine`
 * changes get the richer preview from the Web client: weekday pills plus every exercise with its
 * prescription (name wraps, the `tabular-nums` prescription never does).
 */

import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { resolveExerciseName } from '../agent/coach-bridge';
import { Badge, Button, Card, Icon, PressableScale, Text, useTheme } from '../design';
import type {
  CoachChangeType,
  CoachChangeValue,
  CoachPlannedExercise,
  CoachProposalActionNode,
  CoachProposalChange,
  Profile,
} from '../training';

export type ProposalActionNodeProps = {
  node: CoachProposalActionNode;
  profile: Profile;
  /** A write for this node is in flight; keeps the button from firing twice. */
  applying?: boolean;
  onApply: (changes: CoachProposalChange[], node: CoachProposalActionNode) => void;
  style?: StyleProp<ViewStyle>;
};

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const MAX_DIFF_CHARS = 32;

const STRUCTURAL_TYPES: ReadonlySet<CoachChangeType> = new Set<CoachChangeType>([
  'add-exercise',
  'add-routine',
  'remove-exercise',
  'remove-routine',
  'reorder',
]);

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function idOf(value: unknown): string {
  const record = recordOf(value);
  const id = record?.id;
  return typeof id === 'string' ? id : '';
}

function nameOf(value: unknown): string {
  const record = recordOf(value);
  if (!record) return '';
  for (const key of ['name', 'label', 'title']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return '';
}

function shorten(value: string): string {
  return value.length > MAX_DIFF_CHARS ? `${value.slice(0, MAX_DIFF_CHARS)}…` : value;
}

function exerciseLabel(exId: string, profile: Profile): string {
  return exId ? resolveExerciseName(exId, profile) : '';
}

function routineLabel(routineId: string, profile: Profile): string {
  return (profile.routines ?? []).find(routine => routine?.id === routineId)?.name ?? routineId;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : nameOf(value);
}

function changeTitle(change: CoachProposalChange, profile: Profile): string {
  const ex = exerciseLabel(change.target.exId ?? '', profile);
  const quote = (value: string, fallback: string): string => (value ? `「${value}」` : fallback);
  switch (change.type) {
    case 'add-exercise':
      return `添加${quote(exerciseLabel(idOf(change.after), profile), '动作')}`;
    case 'remove-exercise':
      return `移除${quote(ex, '动作')}`;
    case 'swap-exercise':
      return `${quote(ex, '动作')}换成${quote(exerciseLabel(idOf(change.after), profile), '动作')}`;
    case 'sets':
      return `${quote(ex, '动作')}：组数`;
    case 'reps':
      return `${quote(ex, '动作')}：次数`;
    case 'repsMin':
      return `${quote(ex, '动作')}：次数下限`;
    case 'repsMax':
      return `${quote(ex, '动作')}：次数上限`;
    case 'sec':
      return `${quote(ex, '动作')}：保持时间`;
    case 'cardio':
      return `${quote(ex, '动作')}：时长与配速`;
    case 'inc':
      return `${quote(ex, '动作')}：加重步进`;
    case 'exercise-prog':
      return `${quote(ex, '动作')}：进阶方式`;
    case 'routine-prog':
      return '计划进阶方式';
    case 'reorder':
      return '调整动作顺序';
    case 'superset': {
      const after = recordOf(change.after);
      const link = after?.link === true;
      return link
        ? `${quote(ex, '动作')}与${quote(exerciseLabel(typeof after?.with === 'string' ? after.with : '', profile), '动作')}组成超级组`
        : `取消${quote(ex, '动作')}的超级组`;
    }
    case 'add-routine':
      return `新建计划${quote(stringValue(change.after), '计划')}`;
    case 'remove-routine':
      return '移除计划';
    case 'rename-routine':
      return `计划重命名为${quote(stringValue(change.after), '新名称')}`;
    case 'week': {
      const day = change.target.weekday;
      if (typeof day === 'number' && WEEKDAY_NAMES[day]) return `${WEEKDAY_NAMES[day]}：训练安排`;
      return '调整某天的训练安排';
    }
    case 'warmup':
      return `${quote(ex, '动作')}：热身`;
    case 'programme': {
      const name = stringValue(change.after);
      return change.target.programmeId
        ? `修订计划模板${quote(name, '模板')}`
        : `新建计划模板${quote(name, '模板')}`;
    }
    default:
      return change.type;
  }
}

function warmupLabel(value: CoachChangeValue | undefined): string {
  const record = recordOf(value);
  const mode = typeof record?.mode === 'string' ? record.mode : '';
  if (mode === 'auto') return '自动';
  if (mode === 'none') return '不做';
  if (mode === 'own') {
    const rows = Array.isArray(record?.rows) ? record.rows.length : 0;
    return rows > 0 ? `自定义 ${rows} 组` : '自定义';
  }
  return '默认';
}

function programmeLabel(value: CoachChangeValue | undefined): string {
  const record = recordOf(value);
  const weeks = Array.isArray(record?.weeks) ? record.weeks : [];
  const deload = weeks.some(week => recordOf(week)?.deload === true);
  return `${weeks.length} 周${deload ? ' · 含减载' : ''}`;
}

function diffText(value: CoachChangeValue | undefined, change: CoachProposalChange, profile: Profile): string {
  if (change.type === 'week') {
    const raw = Array.isArray(value) ? value : value == null ? [] : [value];
    const ids = raw.filter((item): item is string => typeof item === 'string' && item !== '' && item !== 'rest');
    return ids.length > 0 ? ids.map(id => routineLabel(id, profile)).join(' + ') : '休息';
  }
  if (value == null) return '—';
  if (Array.isArray(value)) return String(value.length);
  if (typeof value === 'object') {
    const id = idOf(value);
    if (id) return exerciseLabel(id, profile);
    const name = nameOf(value);
    return name || '—';
  }
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

type ChangeDiff = { before: string; after: string };

function changeDiff(change: CoachProposalChange, profile: Profile): ChangeDiff | null {
  if (change.type === 'warmup') {
    return { before: warmupLabel(change.before), after: warmupLabel(change.after) };
  }
  if (change.type === 'programme') {
    return {
      before: change.before == null ? '—' : programmeLabel(change.before),
      after: programmeLabel(change.after),
    };
  }
  if (STRUCTURAL_TYPES.has(change.type)) return null;
  return {
    before: shorten(diffText(change.before, change, profile)),
    after: shorten(diffText(change.after, change, profile)),
  };
}

/** The app's own notation for one prescribed exercise (the Web `formatRx`). */
function formatPrescription(exercise: CoachPlannedExercise): string {
  if (exercise.mode === 'cardio') {
    return exercise.speed != null
      ? `${exercise.min ?? 20} 分钟 · ${exercise.speed}`
      : `${exercise.min ?? 20} 分钟`;
  }
  if (exercise.mode === 'time') return `${exercise.sets ?? 3}×${exercise.sec ?? 45}秒`;
  return Number.isInteger(exercise.repsMin) && Number.isInteger(exercise.repsMax)
    ? `${exercise.sets ?? 3}×${exercise.repsMin}-${exercise.repsMax}`
    : `${exercise.sets ?? 3}×${exercise.reps ?? 10}`;
}

function routinePreview(after: CoachChangeValue | undefined): {
  days: number[];
  exercises: CoachPlannedExercise[];
} {
  const record = recordOf(after);
  const rawDays = record && Array.isArray(record.weekdays) ? record.weekdays : [];
  const days = [
    ...new Set(
      rawDays.filter(
        (day: unknown): day is number =>
          typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6,
      ),
    ),
  ];
  const rawExercises = record && Array.isArray(record.ex) ? record.ex : [];
  const exercises = rawExercises.filter(
    (exercise): exercise is CoachPlannedExercise =>
      Boolean(exercise) &&
      typeof exercise === 'object' &&
      typeof (exercise as { id?: unknown }).id === 'string',
  );
  return { days, exercises };
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  checkbox: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  box: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  numeric: {
    fontVariant: ['tabular-nums'],
  },
  diffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  prescriptionRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

/** A checkbox row: the entire row is the hit target, announced as a checkbox. */
function ChangeRow({
  change,
  checked,
  disabled,
  disabledHint,
  profile,
  onToggle,
}: {
  change: CoachProposalChange;
  checked: boolean;
  disabled: boolean;
  disabledHint: string;
  profile: Profile;
  onToggle: () => void;
}) {
  const theme = useTheme();
  const diff = changeDiff(change, profile);
  const preview = change.type === 'add-routine' ? routinePreview(change.after) : null;

  const body = (
    <>
      <View
        style={[
          styles.checkbox,
          {
            width: theme.sizes.touch,
            height: theme.sizes.touch,
          },
        ]}
      >
        <View
          style={[
            styles.box,
            {
              width: theme.sizes.icon,
              height: theme.sizes.icon,
              borderRadius: theme.radius.xs,
              borderColor: checked ? theme.colors.accent : theme.colors.label4,
              backgroundColor: checked ? theme.colors.accent : 'transparent',
            },
          ]}
        >
          {checked ? (
            <Icon
              color={theme.colors.onAccent}
              name="check"
              size={theme.sizes.buttonIcon - theme.space.xs}
            />
          ) : null}
        </View>
      </View>
      <View style={[styles.grow, { gap: theme.space.xxs }]}>
        <Text variant="subhead" weight="600">
          {changeTitle(change, profile)}
        </Text>
        {diff ? (
          <View style={[styles.diffRow, { gap: theme.space.xs }]}>
            <Badge style={{ maxWidth: '100%' }} tone="neutral">{diff.before}</Badge>
            <Icon color={theme.colors.label3} name="chevronRight" size={theme.sizes.icon / 2} />
            <Badge style={{ maxWidth: '100%' }} tone="accent">{diff.after}</Badge>
          </View>
        ) : null}
        {preview ? <RoutinePreview days={preview.days} exercises={preview.exercises} profile={profile} /> : null}
        {change.why ? (
          <Text tone="secondary" variant="caption">
            {change.why}
          </Text>
        ) : null}
      </View>
    </>
  );

  if (disabled) {
    return (
      <View
        accessibilityLabel={`${changeTitle(change, profile)}，${disabledHint}`}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: true }}
        style={[styles.row, { gap: theme.space.xs }]}
      >
        {body}
      </View>
    );
  }

  return (
    <PressableScale
      accessibilityLabel={changeTitle(change, profile)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onToggle}
      scaleTo={theme.motion.pressScaleCard}
      style={[styles.row, { gap: theme.space.xs }]}
    >
      {body}
    </PressableScale>
  );
}

function RoutinePreview({
  days,
  exercises,
  profile,
}: {
  days: number[];
  exercises: CoachPlannedExercise[];
  profile: Profile;
}) {
  const theme = useTheme();
  if (days.length === 0 && exercises.length === 0) return null;

  return (
    <View
      style={{
        backgroundColor: theme.colors.surface2,
        borderRadius: theme.radius.md,
        padding: theme.space.sm,
        gap: theme.space.xs,
      }}
    >
      {days.length > 0 ? (
        <View style={[styles.diffRow, { gap: theme.space.xs }]}>
          {days.map(day => (
            <View
              key={`weekday_${day}`}
              style={[
                styles.pill,
                {
                  backgroundColor: theme.colors.accentSoft,
                  borderRadius: theme.radius.pill,
                  paddingVertical: theme.space.xxs,
                  paddingHorizontal: theme.space.sm,
                },
              ]}
            >
              <Text tone="accent" variant="caption2">
                {WEEKDAY_NAMES[day]}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {exercises.map((exercise, index) => (
        <View
          key={`${exercise.id}_${index}`}
          style={[styles.prescriptionRow, { gap: theme.space.sm }]}
        >
          <Text style={styles.grow} variant="footnote">
            {exerciseLabel(exercise.id, profile)}
          </Text>
          <Text style={[styles.numeric, { flexShrink: 0 }]} tone="secondary" variant="footnote">
            {formatPrescription(exercise)}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ProposalActionNode({
  node,
  profile,
  applying = false,
  onApply,
  style,
}: ProposalActionNodeProps) {
  const theme = useTheme();
  const usable = useMemo(
    () => node.changes.filter(change => change.status !== 'stale'),
    [node.changes],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(usable.map(change => change.id)),
  );

  const applied = node.applied === true;
  const selectedChanges = usable.filter(change => selected.has(change.id));
  const count = selectedChanges.length;

  const toggle = (id: string): void => {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleApply = (): void => {
    if (applied || applying || selectedChanges.length === 0) return;
    onApply(selectedChanges, node);
  };

  return (
    <Card style={[styles.card, style]}>
      <View style={{ gap: theme.space.xxs }}>
        <Text tone="secondary" variant="caption">
          建议
        </Text>
        <Text variant="headline">{node.title || '建议调整'}</Text>
        {node.summary ? (
          <Text tone="secondary" variant="footnote">
            {node.summary}
          </Text>
        ) : null}
      </View>

      <View style={{ gap: theme.space.md }}>
        {node.changes.map(change => {
          const stale = change.status === 'stale';
          const checked = !stale && selected.has(change.id);
          return (
            <View key={change.id} style={{ opacity: stale ? 0.45 : 1 }}>
              <ChangeRow
                change={change}
                checked={stale ? false : applied ? true : checked}
                disabled={applied || stale}
                disabledHint={applied ? '已采纳' : '当前计划已变化'}
                onToggle={() => toggle(change.id)}
                profile={profile}
              />
            </View>
          );
        })}
      </View>

      <View style={{ gap: theme.space.xs }}>
        {applied ? (
          <View style={[styles.row, { alignItems: 'center', gap: theme.space.sm }]}>
            <Badge tone="accent">已采纳</Badge>
            <Text style={styles.grow} tone="secondary" variant="footnote">
              这些更改已经写入你的计划。
            </Text>
          </View>
        ) : (
          <Button
            disabled={count === 0 || applying}
            fullWidth
            icon="check"
            loading={applying}
            onPress={handleApply}
            variant="primary"
          >
            {count === 0 ? '未选择更改' : `应用 ${count} 项更改`}
          </Button>
        )}
        {applied ? (
          <Text tone="tertiary" variant="caption">
            可在右上角菜单撤销上次更改
          </Text>
        ) : null}
      </View>
    </Card>
  );
}
