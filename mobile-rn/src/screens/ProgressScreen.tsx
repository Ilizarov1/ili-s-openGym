/**
 * Progress tab: strength trends and live muscle coverage.
 *
 * The screen is a pure consumer of `history`. It receives the same array StatsScreen
 * gets, derives everything with the pure `src/progress` projections, and reports a
 * source tap through `onOpenWorkout`. It does not touch App state or storage.
 */

import { Fragment, useMemo, useState } from 'react';
import { View } from 'react-native';
import {
  Badge,
  BarChart,
  BodyMap,
  Card,
  Divider,
  EmptyState,
  Header,
  IconTile,
  LineChart,
  ListRow,
  Screen,
  SectionHeader,
  Segmented,
  Sheet,
  StatTile,
  Text,
  mix,
  useTheme,
} from '../design';
import { unitOf, type Profile, type Unit, type Workout } from '../training';
import {
  candidateDetail,
  candidateValueText,
  exerciseChoices,
  exercisePerformance,
  formatDayLabel,
  formatMonthDay,
  formatSets,
  formatVolume,
  modeLabel,
  muscleBalance,
  MUSCLE_RANGE_OPTIONS,
  muscleRangeLabel,
  muscleRangeOf,
  rangeLabel,
  TREND_RANGE_OPTIONS,
  trendRangeOf,
  workoutTrends,
  type ExerciseChoice,
  type MuscleRangeKey,
  type ProgressHistoryItem,
  type TrendRangeKey,
} from '../progress';

export type ProgressScreenProps = {
  profile: Profile;
  history: readonly ProgressHistoryItem[];
  /** Opens the stored workout in the history editor / detail view. */
  onOpenWorkout?: (workout: Workout, unit: Unit) => void;
  /** Closes the full-screen panel; when omitted the screen is usable standalone. */
  onClose?: () => void;
  /** Injectable clock for deterministic range tests. */
  now?: number;
};

type ProgressTab = 'strength' | 'muscles';

const TAB_OPTIONS: { value: ProgressTab; label: string }[] = [
  { value: 'strength', label: '力量' },
  { value: 'muscles', label: '肌群' },
];

function MuscleLegend() {
  const theme = useTheme();
  const base = mix(theme.colors.label, theme.colors.surface, 0.11);
  const swatches = [
    base,
    mix(theme.colors.accent, base, 0.32),
    mix(theme.colors.accent, base, 0.56),
    mix(theme.colors.accent, base, 0.78),
    theme.colors.accent,
  ];
  return (
    <View
      accessibilityLabel="肌群颜色图例：颜色越深，有效组越多"
      accessibilityRole="image"
      accessible
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.space.xs,
        marginTop: theme.space.sm,
      }}
    >
      <Text tone="secondary" variant="caption">少</Text>
      {swatches.map(color => (
        <View
          key={color}
          style={{
            width: theme.space.lg,
            height: theme.space.md,
            borderRadius: theme.radius.xs,
            backgroundColor: color,
          }}
        />
      ))}
      <Text tone="secondary" variant="caption">多</Text>
    </View>
  );
}

function choiceSubtitle(choice: ExerciseChoice): string {
  return `${modeLabel(choice.mode, choice.metric)} · 最近 ${formatDayLabel(choice.lastDay)}`;
}

function StrengthPanel({
  profile,
  history,
  range,
  onOpenWorkout,
  now,
}: {
  profile: Profile;
  history: readonly ProgressHistoryItem[];
  range: TrendRangeKey;
  onOpenWorkout?: (workout: Workout, unit: Unit) => void;
  now: number;
}) {
  const theme = useTheme();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const choices = useMemo(() => exerciseChoices(profile, history), [profile, history]);
  const activeId = selectedId && choices.some(choice => choice.id === selectedId)
    ? selectedId
    : choices[0]?.id ?? null;
  const active = choices.find(choice => choice.id === activeId) ?? null;
  const days = trendRangeOf(range);

  const trend = useMemo(
    () => workoutTrends(profile, history, days, now),
    [days, history, now, profile],
  );
  const performance = useMemo(
    () => (activeId ? exercisePerformance(profile, history, activeId, days, now) : null),
    [activeId, days, history, now, profile],
  );
  const unit = unitOf(profile);

  const chartPairs = (performance?.points ?? [])
    .filter(point => Number.isFinite(point.source.at))
    .map(point => ({
      point,
      chart: {
        x: point.source.at,
        y: point.value,
        label: point.source.date ? formatMonthDay(point.source.date) : undefined,
      },
    }));
  const chartPoints = chartPairs.map(pair => pair.chart);
  const recent = (performance?.points ?? []).slice(-5).reverse();

  return (
    <View style={{ gap: theme.space.md }}>
      <Card>
        <StatTile
          detail={trend.thisWeek.pending > 0 ? `${trend.thisWeek.pending} 场待同步` : '按场统计'}
          icon="calendar"
          label="本周训练"
          tone="blue"
          value={`${trend.thisWeek.workouts} 次`}
        />
        <Divider />
        <StatTile
          detail={rangeLabel(days)}
          icon="dumbbell"
          label="范围内训练"
          tone="accent"
          value={`${trend.workouts} 次`}
        />
        <Divider />
        <StatTile
          detail={profile.volumeWarmups === true ? '含热身组' : '仅正式组'}
          icon="chart"
          label="本周训练量"
          tone="neutral"
          value={formatVolume(trend.thisWeek.volume, unit)}
        />
        <Divider />
        <StatTile
          detail={`${rangeLabel(days)} · ${profile.volumeWarmups === true ? '含热身组' : '仅正式组'}`}
          icon="chart"
          label="范围内训练量"
          tone="orange"
          value={formatVolume(trend.volume, unit)}
        />
      </Card>

      <SectionHeader
        action={<Text tone="secondary" variant="caption">{`${trend.weeks.length} 周 · 周一开头`}</Text>}
        title="每周训练量"
      />
      <Card>
        {trend.workouts > 0 ? (
          <>
            <BarChart
              accessibilityLabel={`每周训练量，共 ${trend.weeks.length} 周，合计 ${formatVolume(trend.volume, unit)}`}
              data={trend.weeks.map(week => ({ label: week.label, value: week.volume }))}
              emptyLabel="这个范围没有可计入的训练量"
              unit={unit}
            />
            <Divider />
            {(trend.weeks.length <= 8 ? [...trend.weeks].reverse() : trend.weeks.slice(-8).reverse()).map(week => (
              <ListRow
                key={week.start}
                subtitle={`${week.workouts} 次 · ${formatVolume(week.volume, unit)}`}
                title={`${formatMonthDay(week.start)} – ${formatMonthDay(week.end)}`}
                titleTone={week.workouts > 0 ? undefined : 'secondary'}
              />
            ))}
            {trend.weeks.length > 8 ? (
              <Text tone="secondary" variant="caption">
                列表显示最近 8 周，曲线包含范围内全部周桶。
              </Text>
            ) : null}
          </>
        ) : (
          <EmptyState
            icon="chart"
            text="切换范围，或完成一次训练后再看每周训练量。"
            title="这个范围还没有训练"
          />
        )}
      </Card>

      <SectionHeader title="动作表现" />
      {active ? (
        <Card padded={false}>
          <ListRow
            accessibilityLabel={`选择动作，当前 ${active.name}`}
            chevron
            leading={<IconTile name="dumbbell" size="sm" tone="neutral" />}
            onPress={() => setPickerOpen(true)}
            subtitle={choiceSubtitle(active)}
            title={active.name}
          />
        </Card>
      ) : (
        <Card padded={false}>
          <EmptyState
            icon="dumbbell"
            text="完成包含动作的训练后，这里会按训练显示最佳完成组。"
            title="还没有动作记录"
          />
        </Card>
      )}

      {performance && performance.points.length > 0 ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <Text variant="headline">最佳表现</Text>
            <Text variant="title3">
              {performance.best ? candidateValueText(performance.best) : '暂无'}
            </Text>
          </View>
          {performance.best ? (
            <Text tone="secondary" variant="footnote">
              {`${formatDayLabel(performance.best.source.date)} · ${candidateDetail(performance.best)} · 共 ${performance.total} 场`}
            </Text>
          ) : null}
          <LineChart
            accessibilityLabel={`${active?.name ?? '动作'}表现曲线，共 ${performance.points.length} 个训练点`}
            emptyLabel="暂时没有可绘制的日期"
            onPointPress={onOpenWorkout
              ? index => {
                  const pair = chartPairs[index];
                  if (pair) onOpenWorkout(pair.point.source.workout, pair.point.source.unit);
                }
              : undefined}
            points={chartPoints}
            unit={performance.unitLabel}
          />
          {onOpenWorkout ? (
            <Text tone="secondary" variant="caption">
              点按曲线上的点或下方来源，查看原训练。
            </Text>
          ) : null}
          <Divider />
          {recent.map(point => (
            <ListRow
              accessibilityLabel={`${formatDayLabel(point.source.date)}，${candidateValueText(point)}，查看原训练`}
              chevron={onOpenWorkout != null}
              key={`${point.source.key}-${point.entryIndex}-${point.setIndex ?? 'top'}`}
              onPress={onOpenWorkout
                ? () => onOpenWorkout(point.source.workout, point.source.unit)
                : undefined}
              subtitle={candidateDetail(point)}
              title={`${formatMonthDay(point.source.date) || '训练'} · ${candidateValueText(point)}`}
              trailing={point.source.pending ? <Badge tone="orange">待同步</Badge> : undefined}
            />
          ))}
        </Card>
      ) : active ? (
        <Card>
          <Text tone="secondary" variant="subhead">
            这个动作在所选范围内没有可比较的完成正式组。
          </Text>
        </Card>
      ) : null}

      <Sheet
        onClose={() => setPickerOpen(false)}
        title="选择动作"
        visible={pickerOpen}
      >
        {choices.map(choice => (
          <ListRow
            key={choice.id}
            onPress={() => {
              setSelectedId(choice.id);
              setPickerOpen(false);
            }}
            subtitle={choiceSubtitle(choice)}
            title={choice.name}
            trailing={choice.id === activeId ? <Badge tone="accent">当前</Badge> : undefined}
          />
        ))}
      </Sheet>

      <Text tone="secondary" variant="footnote">
        训练量按完成正式组计算；开启“热身计入训练量”后会按实际热身量增加。
      </Text>
    </View>
  );
}

function MusclePanel({
  profile,
  history,
  range,
  now,
}: {
  profile: Profile;
  history: readonly ProgressHistoryItem[];
  range: MuscleRangeKey;
  now: number;
}) {
  const theme = useTheme();
  const balance = useMemo(
    () => muscleBalance(profile, history, muscleRangeOf(range), now),
    [history, now, profile, range],
  );
  const emptyText = balance.completedSets > 0
    ? '这些动作还没有可识别的肌群信息；记录自定义动作的肌群或使用目录动作后会显示。'
    : '这个范围没有完成的正式组，切换范围后再看。';

  return (
    <View style={{ gap: theme.space.md }}>
      <Text tone="secondary" variant="footnote">
        {`${muscleRangeLabel(balance.range)} · ${balance.workouts} 场训练 · ${balance.completedSets} 个完成正式组`}
      </Text>

      <Card>
        {balance.hasData ? <BodyMap levels={balance.levels} /> : <BodyMap load={{}} />}
        {balance.hasData ? <MuscleLegend /> : null}
      </Card>

      {balance.hasData ? (
        <>
          <SectionHeader
            action={<Text tone="secondary" variant="caption">按完成正式组计</Text>}
            title="肌群有效组"
          />
          <Card padded={false}>
            {balance.rows.map((row, index) => (
              <Fragment key={row.slug}>
                <ListRow
                  accessibilityLabel={`${row.name}，${formatSets(row.sets)} 个有效组`}
                  subtitle={row.trained ? '有效组' : '未训练'}
                  title={row.name}
                  titleTone={row.trained ? undefined : 'secondary'}
                  trailing={(
                    <Text tone={row.trained ? 'label' : 'secondary'} variant="headline">
                      {formatSets(row.sets)}
                    </Text>
                  )}
                />
                {index < balance.rows.length - 1 ? (
                  <Divider inset={theme.layout.listRowPaddingX} />
                ) : null}
              </Fragment>
            ))}
          </Card>
          <Text tone="secondary" variant="footnote">
            主动肌按 1、辅助肌按 0.4 权重；递减组和休息暂停组按一个完成正式组计，不会重复累计。
          </Text>
        </>
      ) : (
        <Card>
          <EmptyState
            icon="person"
            text={emptyText}
            title="这个范围没有肌群数据"
          />
        </Card>
      )}
    </View>
  );
}

export function ProgressScreen({
  profile,
  history,
  onOpenWorkout,
  onClose,
  now: injectedNow,
}: ProgressScreenProps) {
  const theme = useTheme();
  // Freeze the clock for this mount unless a caller injects one, so switching
  // tabs or opening the exercise sheet does not rebuild every projection.
  const now = useMemo(() => injectedNow ?? Date.now(), [injectedNow]);
  const [tab, setTab] = useState<ProgressTab>('strength');
  const [trendRange, setTrendRange] = useState<TrendRangeKey>('30');
  const [muscleRange, setMuscleRange] = useState<MuscleRangeKey>('week');

  return (
    <Screen testID="progress-screen">
      <Header
        compact
        onBack={onClose}
        subtitle="训练趋势与肌群覆盖"
        title="进度"
      />
      <Segmented onChange={setTab} options={TAB_OPTIONS} value={tab} />
      <View style={{ marginTop: theme.space.lg }}>
        {tab === 'strength' ? (
          <View style={{ gap: theme.space.md }}>
            <StrengthRangePicker value={trendRange} onChange={setTrendRange} />
            <StrengthPanel
              history={history}
              now={now}
              onOpenWorkout={onOpenWorkout}
              profile={profile}
              range={trendRange}
            />
          </View>
        ) : (
          <View style={{ gap: theme.space.md }}>
            <MuscleRangePicker value={muscleRange} onChange={setMuscleRange} />
            <MusclePanel
              history={history}
              now={now}
              profile={profile}
              range={muscleRange}
            />
          </View>
        )}
      </View>
    </Screen>
  );
}

/** The range strip lives above the panel so the panel can stay memo-friendly. */
function StrengthRangePicker({
  value,
  onChange,
}: {
  value: TrendRangeKey;
  onChange: (value: TrendRangeKey) => void;
}) {
  return <Segmented onChange={onChange} options={TREND_RANGE_OPTIONS} value={value} />;
}

function MuscleRangePicker({
  value,
  onChange,
}: {
  value: MuscleRangeKey;
  onChange: (value: MuscleRangeKey) => void;
}) {
  return <Segmented onChange={onChange} options={MUSCLE_RANGE_OPTIONS} value={value} />;
}
