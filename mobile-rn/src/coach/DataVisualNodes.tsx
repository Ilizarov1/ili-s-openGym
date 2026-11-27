/**
 * Data and form GenUI nodes, rendered natively.
 *
 * Every number here is hydrated locally from the synced training log through
 * `../agent/coach-bridge` (the RN port of `coach-genui-hydration.js`): switching the trend
 * metric/period or the muscle-load window recomputes in memory and never issues a network
 * request. The card visuals follow the Web briefing (`frontend/src/components/CoachGenUI.jsx`)
 * with the RN design-system primitives and tokens.
 */

import { Fragment, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import {
  Badge,
  BodyMap,
  Button,
  Card,
  Chip,
  Divider,
  ExerciseMedia,
  Icon,
  LineChart,
  ProgressBar,
  Segmented,
  Text,
  useTheme,
} from '../design';
import type { SegmentedOption } from '../design';
import {
  hydrateCoachKpi,
  hydrateCoachMuscleLoad,
  hydrateCoachTrend,
  resolveExerciseName,
} from '../agent/coach-bridge';
import { builtinMedia } from '../exerciseMedia';
import type {
  CoachAlternativeItem,
  CoachComparisonCell,
  CoachComparisonTableNode,
  CoachExerciseAlternativesNode,
  CoachExerciseTrendNode,
  CoachFormField,
  CoachKpiItem,
  CoachKpiStripNode,
  CoachLoadWindow,
  CoachMuscleLoadNode,
  CoachQuickFormNode,
  CoachTrendMetric,
  Profile,
} from '../training';

/* ---------------------------------- shared ---------------------------------- */

const styles = StyleSheet.create({
  card: {
    marginBottom: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  numeric: {
    fontVariant: ['tabular-nums'],
  },
  emptyRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  kpiTile: {
    flexBasis: '47%',
    flexGrow: 1,
    minWidth: 0,
  },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  cell: {
    flex: 1,
    minWidth: 0,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  mediaBlock: {
    flexShrink: 0,
  },
});

function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return String(Math.round(value * 10) / 10);
}

function shortDate(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return match ? `${match[2]}/${match[3]}` : value;
}

/* ------------------------------ exercise trend ------------------------------ */

type TrendWeeks = '4' | '8' | '12' | '24';

const METRIC_OPTIONS: readonly SegmentedOption<CoachTrendMetric>[] = [
  { value: 'e1rm', label: '1RM' },
  { value: 'weight', label: '重量' },
  { value: 'volume', label: '总量' },
];

const WEEK_OPTIONS: readonly SegmentedOption<TrendWeeks>[] = [
  { value: '4', label: '4周' },
  { value: '8', label: '8周' },
  { value: '12', label: '12周' },
  { value: '24', label: '24周' },
];

const METRIC_LABELS: Readonly<Record<CoachTrendMetric, string>> = {
  e1rm: '估算 1RM',
  weight: '训练重量',
  volume: '训练总量',
};

function normalizeWeeks(weeks: number | undefined): TrendWeeks {
  if (weeks === 4 || weeks === 8 || weeks === 12 || weeks === 24) return String(weeks) as TrendWeeks;
  return '8';
}

export type ExerciseTrendNodeProps = {
  node: CoachExerciseTrendNode;
  profile: Profile;
  style?: StyleProp<ViewStyle>;
};

export function ExerciseTrendNode({ node, profile, style }: ExerciseTrendNodeProps) {
  const theme = useTheme();
  const [metric, setMetric] = useState<CoachTrendMetric>(() =>
    node.metric === 'weight' || node.metric === 'volume' ? node.metric : 'e1rm',
  );
  const [weeks, setWeeks] = useState<TrendWeeks>(() => normalizeWeeks(node.weeks));

  const data = useMemo(
    () => hydrateCoachTrend(profile, { exId: node.exId, metric, weeks: Number(weeks) }),
    [metric, node.exId, profile, weeks],
  );

  const chartPoints = useMemo(
    () =>
      data.points.map(point => {
        const label = shortDate(point.d);
        return label ? { x: point.t, y: point.y, label } : { x: point.t, y: point.y };
      }),
    [data.points],
  );

  const unit = profile.unit ?? 'kg';
  const delta = data.delta ?? 0;
  const deltaTone = delta > 0 ? 'accent' : delta < 0 ? 'danger' : 'neutral';

  return (
    <Card style={[styles.card, style]}>
      <View style={{ gap: theme.space.xxs }}>
        <Text tone="secondary" variant="caption">
          {METRIC_LABELS[metric]}
        </Text>
        <Text variant="headline">{node.title || data.name}</Text>
        {node.caption ? (
          <Text tone="secondary" variant="footnote">
            {node.caption}
          </Text>
        ) : null}
      </View>

      <Segmented onChange={setMetric} options={[...METRIC_OPTIONS]} value={metric} />
      <Segmented onChange={setWeeks} options={[...WEEK_OPTIONS]} value={weeks} />

      {data.sessions >= 2 ? (
        <>
          <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space.sm }]}>
            <Text tone="secondary" variant="caption">
              首末对比
            </Text>
            <Text style={styles.numeric} variant="footnote">
              {`${formatNumber(data.first)} → ${formatNumber(data.last)} ${unit}`}
            </Text>
            <Badge tone={deltaTone}>
              {`${delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} ${Math.abs(data.pct)}%`}
            </Badge>
            {data.stalled ? <Badge tone="orange">停滞</Badge> : null}
          </View>
          <LineChart
            accessibilityLabel={`${node.title || data.name}${METRIC_LABELS[metric]}曲线，共 ${data.sessions} 次训练`}
            height={theme.sizes.tabStart * 3}
            points={chartPoints}
            unit={unit}
          />
          <Text tone="secondary" variant="caption">
            {`共 ${data.sessions} 次训练 · 每点是一次训练记录`}
          </Text>
        </>
      ) : (
        <View style={[styles.emptyRow, { gap: theme.space.sm }]}>
          <Icon color={theme.colors.label3} name="chartLine" size={theme.sizes.buttonIcon} />
          <Text style={styles.grow} tone="secondary" variant="footnote">
            还没有足够的记录画出趋势，完成更多训练后再看。
          </Text>
        </View>
      )}
    </Card>
  );
}

/* ------------------------------- muscle load -------------------------------- */

/* The Web briefing runs each muscle name through `t()` (`frontend/src/locales/zh.js`); the RN
 * shell has no i18n runtime, so the same eighteen labels live here. Slugs are included because
 * a node may omit its label and the hydrator then falls back to the body-map key. Custom
 * exercise names never pass through here: they are resolved by `resolveExerciseName`. */
const MUSCLE_LABELS_ZH: Readonly<Record<string, string>> = {
  Traps: '斜方肌',
  Shoulders: '肩部',
  Chest: '胸部',
  'Lats & upper back': '背阔肌和上背部',
  Serratus: '前锯肌',
  Biceps: '肱二头肌',
  Triceps: '肱三头肌',
  Forearms: '前臂',
  Abs: '腹肌',
  Obliques: '腹斜肌',
  'Lower back': '下背部',
  Glutes: '臀部',
  Quads: '股四头肌',
  Hamstrings: '腘绳肌',
  Adductors: '内收肌',
  'Hip flexors': '髋屈肌',
  Calves: '小腿',
  Shins: '胫前肌',
  trapezius: '斜方肌',
  deltoids: '肩部',
  chest: '胸部',
  'upper-back': '背阔肌和上背部',
  serratus: '前锯肌',
  biceps: '肱二头肌',
  triceps: '肱三头肌',
  forearm: '前臂',
  abs: '腹肌',
  obliques: '腹斜肌',
  'lower-back': '下背部',
  gluteal: '臀部',
  quadriceps: '股四头肌',
  hamstring: '腘绳肌',
  adductors: '内收肌',
  'hip-flexors': '髋屈肌',
  calves: '小腿',
  tibialis: '胫前肌',
};

/** Chinese display name for a hydrated muscle item; unknown labels stay as sent. */
function muscleLabel(label: string | null | undefined): string {
  if (!label) return '';
  return MUSCLE_LABELS_ZH[label] ?? label;
}

const WINDOW_OPTIONS: readonly SegmentedOption<CoachLoadWindow>[] = [
  { value: '72h', label: '72小时' },
  { value: '7d', label: '7天' },
  { value: '28d', label: '28天' },
];

const WINDOW_LABELS: Readonly<Record<CoachLoadWindow, string>> = {
  '72h': '近 72 小时',
  '7d': '近 7 天',
  '28d': '近 28 天',
};

export type MuscleLoadNodeProps = {
  node: CoachMuscleLoadNode;
  profile: Profile;
  style?: StyleProp<ViewStyle>;
};

export function MuscleLoadNode({ node, profile, style }: MuscleLoadNodeProps) {
  const theme = useTheme();
  const [window, setWindow] = useState<CoachLoadWindow>(() =>
    node.window === '7d' || node.window === '28d' ? node.window : '72h',
  );

  const data = useMemo(
    () => hydrateCoachMuscleLoad(profile, { window, focusMuscles: node.focusMuscles }),
    [node.focusMuscles, profile, window],
  );

  const maxSets = data.focusSummary.reduce((max, item) => Math.max(max, item.sets), 0);

  return (
    <Card style={[styles.card, style]}>
      <View style={{ gap: theme.space.xxs }}>
        <Text tone="secondary" variant="caption">
          {WINDOW_LABELS[window]}
        </Text>
        <Text variant="headline">{node.title || '肌群负荷'}</Text>
        {node.caption ? (
          <Text tone="secondary" variant="footnote">
            {node.caption}
          </Text>
        ) : null}
      </View>

      <Segmented onChange={setWindow} options={[...WINDOW_OPTIONS]} value={window} />

      <View style={{ alignItems: 'center' }}>
        <BodyMap height={theme.sizes.tabStart * 3} load={data.load} />
      </View>

      {data.focusSummary.length > 0 ? (
        <View style={{ gap: theme.space.sm }}>
          <Text tone="secondary" variant="caption">
            重点肌群 · 有效组
          </Text>
          {data.focusSummary.map(item => (
            <View key={item.muscle} style={{ gap: theme.space.xxs }}>
              <View style={[styles.row, { justifyContent: 'space-between', gap: theme.space.sm }]}>
                <Text style={styles.grow} variant="footnote">
                  {muscleLabel(item.label)}
                </Text>
                <Text style={[styles.numeric, { flexShrink: 0 }]} tone="secondary" variant="footnote">
                  {`${formatNumber(item.sets)} 组`}
                </Text>
              </View>
              <ProgressBar value={maxSets > 0 ? item.sets / maxSets : 0} />
            </View>
          ))}
        </View>
      ) : (
        <Text tone="secondary" variant="footnote">
          这个时间窗口还没有完成的正式组。
        </Text>
      )}

      <Text tone="secondary" variant="caption">
        {`共 ${formatNumber(data.totalSets)} 组 · ${data.sessions} 场训练`}
      </Text>
    </Card>
  );
}

/* --------------------------------- kpi strip -------------------------------- */

function KpiTile({ item }: { item: CoachKpiItem }) {
  const theme = useTheme();
  // `StatTile` has no slot for a trend badge and its value cannot opt into `tabular-nums`,
  // both of which the Coach KPI strip requires; this tile mirrors its metrics with tokens.
  let label = '';
  let value = '—';
  let unit: string | null = null;
  let meta: ReactNode = null;

  if (item.kind === 'exercise_stat') {
    label = item.label || item.exId;
    value = item.hasData ? formatNumber(item.value) : '—';
    unit = item.hasData ? item.unit ?? null : null;
    if (item.hasData) {
      const delta = item.delta ?? 0;
      meta = (
        <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space.xxs }]}>
          <Badge tone={delta > 0 ? 'accent' : delta < 0 ? 'danger' : 'neutral'}>
            {`${delta > 0 ? '▲' : delta < 0 ? '▼' : '•'} ${Math.abs(Math.round(item.pct ?? 0))}%`}
          </Badge>
          {item.stalled ? <Badge tone="orange">停滞</Badge> : null}
        </View>
      );
    }
  } else if (item.kind === 'muscle_sets') {
    label = muscleLabel(item.label || item.muscle);
    value = item.hasData ? formatNumber(item.value) : '—';
    unit = item.hasData ? '组' : null;
    meta = (
      <Text tone="tertiary" variant="caption2">
        {WINDOW_LABELS[item.window ?? '72h']}
      </Text>
    );
  } else if (item.kind === 'session_count') {
    label = item.label || '训练次数';
    value = item.hasData ? formatNumber(item.value) : '—';
    meta = (
      <Text tone="tertiary" variant="caption2">
        {`近 ${item.weeks ?? 4} 周`}
      </Text>
    );
  } else {
    label = item.label;
    value = item.value || '—';
    unit = null;
  }

  return (
    <View
      style={[
        styles.kpiTile,
        {
          backgroundColor: theme.colors.surface2,
          borderRadius: theme.radius.lg,
          padding: theme.space.md,
          gap: theme.space.xxs,
        },
      ]}
    >
      <Text numberOfLines={2} tone="secondary" variant="caption">
        {label}
      </Text>
      <View style={[styles.row, { alignItems: 'baseline', gap: theme.space.xxs }]}>
        <Text numberOfLines={1} style={styles.numeric} variant="title3">
          {value}
        </Text>
        {unit ? (
          <Text tone="secondary" variant="caption">
            {unit}
          </Text>
        ) : null}
      </View>
      {meta}
    </View>
  );
}

export type KpiStripNodeProps = {
  node: CoachKpiStripNode;
  profile: Profile;
  style?: StyleProp<ViewStyle>;
};

export function KpiStripNode({ node, profile, style }: KpiStripNodeProps) {
  const theme = useTheme();
  const { items } = useMemo(
    () => hydrateCoachKpi(profile, { items: node.items }),
    [node.items, profile],
  );

  if (items.length === 0) return null;

  return (
    <Card style={[styles.card, style]}>
      <View style={[styles.kpiGrid, { gap: theme.space.sm }]}>
        {items.map((item, index) => (
          <KpiTile item={item} key={`${item.kind}_${index}`} />
        ))}
      </View>
    </Card>
  );
}

/* ----------------------------- comparison table ----------------------------- */

function TableCellText({
  cell,
  profile,
}: {
  cell: CoachComparisonCell | undefined;
  profile: Profile;
}) {
  const theme = useTheme();
  if (cell && typeof cell === 'object') {
    return (
      <View style={{ gap: theme.space.xxs }}>
        <Text style={{ flexShrink: 1 }} variant="footnote">
          {resolveExerciseName(cell.exId, profile)}
        </Text>
        {cell.note ? (
          <Text tone="secondary" variant="caption">
            {cell.note}
          </Text>
        ) : null}
      </View>
    );
  }
  return <Text variant="footnote">{cell == null || cell === '' ? '—' : cell}</Text>;
}

export type ComparisonTableNodeProps = {
  node: CoachComparisonTableNode;
  profile: Profile;
  style?: StyleProp<ViewStyle>;
};

export function ComparisonTableNode({ node, profile, style }: ComparisonTableNodeProps) {
  const theme = useTheme();
  const columns = node.columns;
  const rows = node.rows;
  if (columns.length === 0 || rows.length === 0) return null;

  return (
    <Card style={[styles.card, style]}>
      <Text variant="headline">{node.title || '对比'}</Text>
      <View style={[styles.tableRow, { gap: theme.space.sm }]}>
        {columns.map((column, index) => (
          <Text
            key={`column_${column}_${index}`}
            numberOfLines={2}
            style={styles.cell}
            tone="secondary"
            variant="caption"
            weight="600"
          >
            {String(column ?? '')}
          </Text>
        ))}
      </View>
      <Divider />
      {rows.map((row, rowIndex) => (
        <Fragment key={`row_${rowIndex}`}>
          <View style={[styles.tableRow, { gap: theme.space.sm }]}>
            {columns.map((_, columnIndex) => (
              <View key={`cell_${rowIndex}_${columnIndex}`} style={styles.cell}>
                <TableCellText cell={row[columnIndex]} profile={profile} />
              </View>
            ))}
          </View>
          {rowIndex < rows.length - 1 ? <Divider /> : null}
        </Fragment>
      ))}
    </Card>
  );
}

/* -------------------------------- alternatives ------------------------------- */

const EQUIPMENT_LABELS: Readonly<Record<string, string>> = {
  dumbbell: '哑铃',
  barbell: '杠铃',
  cable: '绳索',
  'body weight': '自重',
  kettlebell: '壶铃',
  band: '弹力带',
  'leverage machine': '器械',
  'smith machine': '史密斯机',
};

const BODY_PART_LABELS: Readonly<Record<string, string>> = {
  back: '背部',
  cardio: '有氧',
  chest: '胸部',
  'lower arms': '前臂',
  'lower legs': '小腿',
  neck: '颈部',
  shoulders: '肩部',
  'upper arms': '手臂',
  'upper legs': '腿部',
  waist: '核心',
  other: '其他',
};

export type AlternativesNodeProps = {
  node: CoachExerciseAlternativesNode;
  profile: Profile;
  /** Paired server base URL, used to resolve catalogue stills when they are not bundled. */
  server?: string | null;
  onApplyAlternative?: (item: CoachAlternativeItem, node: CoachExerciseAlternativesNode) => void;
  style?: StyleProp<ViewStyle>;
};

export function AlternativesNode({
  node,
  profile,
  server = null,
  onApplyAlternative,
  style,
}: AlternativesNodeProps) {
  const theme = useTheme();

  return (
    <Card style={[styles.card, style]}>
      <View style={{ gap: theme.space.xxs }}>
        <Text tone="secondary" variant="caption">
          建议替换
        </Text>
        <Text variant="headline">{node.title || '建议替换'}</Text>
      </View>

      {node.items.length === 0 ? (
        <Text tone="secondary" variant="footnote">
          暂时没有可用的替换动作。
        </Text>
      ) : null}

      {node.items.map((item, index) => {
        const name = item.name || resolveExerciseName(item.exId, profile);
        const media = builtinMedia(server, item.exId);
        const still = media.kind === 'image' ? media.uri : media.posterUri ?? media.uri;
        return (
          <View
            key={`${item.exId}_${index}`}
            style={[styles.row, { alignItems: 'flex-start', gap: theme.space.md }]}
          >
            <ExerciseMedia
              accessibilityLabel={`${name}演示`}
              autoPlay={false}
              kind={still ? 'image' : 'none'}
              style={[styles.mediaBlock, { width: theme.sizes.touch * 2 }]}
              uri={still}
            />
            <View style={[styles.grow, { gap: theme.space.xxs }]}>
              <Text variant="headline">{name}</Text>
              <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space.xxs }]}>
                {item.tag ? (
                  <Badge tone="neutral">
                    {EQUIPMENT_LABELS[item.tag.toLowerCase()] ?? item.tag}
                  </Badge>
                ) : null}
                {item.bp ? <Badge tone="neutral">{BODY_PART_LABELS[item.bp] ?? item.bp}</Badge> : null}
              </View>
              {item.reason ? (
                <Text tone="secondary" variant="footnote">
                  {item.reason}
                </Text>
              ) : null}
              {onApplyAlternative ? (
                <Button
                  onPress={() => onApplyAlternative(item, node)}
                  size="sm"
                  style={{ alignSelf: 'flex-start', minHeight: theme.sizes.touch }}
                  variant="tinted"
                >
                  换成这个
                </Button>
              ) : null}
            </View>
          </View>
        );
      })}
    </Card>
  );
}

/* --------------------------------- quick form ------------------------------- */

type FormValue = string | number | string[];

export type CoachFormSubmission = {
  formId: string;
  title: string;
  values: Record<string, FormValue>;
  summaryText: string;
};

export type QuickFormNodeProps = {
  node: CoachQuickFormNode;
  onSubmitForm: (submission: CoachFormSubmission, node: CoachQuickFormNode) => void;
  style?: StyleProp<ViewStyle>;
};

function optionLabel(field: CoachFormField, value: string): string {
  return (field.options ?? []).find(option => option.value === value)?.label ?? value;
}

function displayValue(field: CoachFormField, value: FormValue): string {
  if (Array.isArray(value)) return value.map(item => optionLabel(field, item)).join('、');
  if (typeof value === 'number') return `${value}${field.unit ?? ''}`;
  return optionLabel(field, value);
}

function scaleSteps(field: CoachFormField): number[] {
  const min = typeof field.min === 'number' && Number.isFinite(field.min) ? field.min : 1;
  const max = typeof field.max === 'number' && Number.isFinite(field.max) ? field.max : 10;
  const capped = Math.min(max, min + 11);
  const steps: number[] = [];
  for (let value = min; value <= capped; value += 1) steps.push(value);
  return steps;
}

export function QuickFormNode({ node, onSubmitForm, style }: QuickFormNodeProps) {
  const theme = useTheme();
  const [values, setValues] = useState<Record<string, FormValue>>({});
  const [sent, setSent] = useState<boolean>(() => node.submitted === true);

  const setOne = (name: string, value: FormValue): void => {
    setValues(previous => ({ ...previous, [name]: value }));
  };

  const toggleChoice = (name: string, value: string): void => {
    setValues(previous => {
      const current = Array.isArray(previous[name]) ? (previous[name] as string[]) : [];
      const next = current.includes(value)
        ? current.filter(item => item !== value)
        : [...current, value];
      return { ...previous, [name]: next };
    });
  };

  const answered = node.fields
    .map(field => {
      const value = values[field.name];
      if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) return null;
      return { name: field.name, label: field.label, text: displayValue(field, value) };
    })
    .filter(
      (entry): entry is { name: string; label: string; text: string } => entry !== null,
    );

  const handleSubmit = (): void => {
    if (sent) return;
    const summaryText = answered.length
      ? answered.map(entry => `${entry.label}: ${entry.text}`).join(' · ')
      : node.title;
    setSent(true);
    onSubmitForm({ formId: node.formId, title: node.title, values, summaryText }, node);
  };

  return (
    <Card style={[styles.card, style]}>
      <View style={{ gap: theme.space.xxs }}>
        <Text tone="secondary" variant="caption">
          快速确认
        </Text>
        <View style={[styles.row, { gap: theme.space.sm }]}>
          <Text style={styles.grow} variant="headline">
            {node.title || '快速确认'}
          </Text>
          {sent ? <Badge tone="accent">已提交</Badge> : null}
        </View>
      </View>

      {sent ? (
        <View style={{ gap: theme.space.xs }}>
          {answered.length > 0 ? (
            answered.map(entry => (
              <View key={entry.name} style={[styles.row, { gap: theme.space.sm }]}>
                <Text style={styles.grow} tone="secondary" variant="footnote">
                  {entry.label}
                </Text>
                <Text style={[styles.numeric, { flexShrink: 0 }]} variant="footnote">
                  {entry.text}
                </Text>
              </View>
            ))
          ) : (
            <Text tone="secondary" variant="footnote">
              答案已发送，教练会据此继续。
            </Text>
          )}
        </View>
      ) : (
        <View style={{ gap: theme.space.md }}>
          {node.fields.map(field => (
            <View key={field.name} style={{ gap: theme.space.xs }}>
              <Text variant="footnote" weight="600">
                {field.label}
              </Text>
              {field.kind === 'single_choice' ? (
                <View style={[styles.chipWrap, { gap: theme.space.xs }]}>
                  {(field.options ?? []).map(option => (
                    <Chip
                      key={option.value}
                      onPress={() => setOne(field.name, option.value)}
                      selected={values[field.name] === option.value}
                      style={{ minHeight: theme.sizes.touch }}
                    >
                      {option.label}
                    </Chip>
                  ))}
                </View>
              ) : field.kind === 'multi_choice' ? (
                <View style={[styles.chipWrap, { gap: theme.space.xs }]}>
                  {(field.options ?? []).map(option => {
                    const current = Array.isArray(values[field.name])
                      ? (values[field.name] as string[])
                      : [];
                    return (
                      <Chip
                        key={option.value}
                        onPress={() => toggleChoice(field.name, option.value)}
                        selected={current.includes(option.value)}
                        style={{ minHeight: theme.sizes.touch }}
                      >
                        {option.label}
                      </Chip>
                    );
                  })}
                </View>
              ) : (
                <View style={[styles.chipWrap, { gap: theme.space.xs }]}>
                  {scaleSteps(field).map(step => (
                    <Chip
                      key={`scale_${step}`}
                      onPress={() => setOne(field.name, step)}
                      selected={values[field.name] === step}
                      style={{ minHeight: theme.sizes.touch }}
                    >
                      {String(step)}
                    </Chip>
                  ))}
                </View>
              )}
            </View>
          ))}
        </View>
      )}

      {sent ? null : (
        <Button fullWidth icon="arrowUp" onPress={handleSubmit} variant="primary">
          {node.submitLabel || '提交'}
        </Button>
      )}
    </Card>
  );
}
