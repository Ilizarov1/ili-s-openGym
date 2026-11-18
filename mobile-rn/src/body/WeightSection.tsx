import { useMemo, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  IconButton,
  ListRow,
  SectionHeader,
  Sheet,
  Text,
  TextField,
  useTheme,
} from '../design';
import type { ProfileChange } from '../profileChanges';
import { localDate, type Profile } from '../training';
import {
  DAILY_MODE_LABEL,
  addWeighInChange,
  defaultWeightTime,
  editWeighInChange,
  removeWeighInChange,
  weightDayValue,
  weightDays,
  weightReadings,
  weightSummary,
  weightTimestampLabel,
  weightTimeLabel,
  weightUnit,
  weightValueLabel,
  weightWeeks,
  type WeightReading,
} from './weight';

export type WeightSectionProps = {
  profile: Profile;
  onCommit: (changes: ProfileChange[]) => void;
};

type WeightForm = {
  mode: 'add' | 'edit';
  id?: string;
  from?: string;
  d: string;
  at: string;
  w: string;
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  hero: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  form: {
    flexDirection: 'column',
  },
});

function groupReadings(readings: WeightReading[]) {
  const map = new Map<string, WeightReading[]>();
  for (const reading of readings) {
    const list = map.get(reading.d) ?? [];
    list.push(reading);
    map.set(reading.d, list);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)
    .map(([d, list]) => ({ d, readings: [...list].sort((a, b) => (a.at ?? '') < (b.at ?? '') ? -1 : (a.at ?? '') > (b.at ?? '') ? 1 : a.t - b.t) }));
}

/** 体重：日值、周趋势、读数列表和新增/更正/删除表单。 */
export function WeightSection({ profile, onCommit }: WeightSectionProps) {
  const theme = useTheme();
  const summary = useMemo(() => weightSummary(profile), [profile]);
  const readings = useMemo(() => weightReadings(profile), [profile]);
  const days = useMemo(() => weightDays(profile), [profile]);
  const weeks = useMemo(() => weightWeeks(profile, 8), [profile]);
  const groups = useMemo(() => groupReadings(readings), [readings]);
  const unit = weightUnit(profile);
  const [form, setForm] = useState<WeightForm | null>(null);
  const [formError, setFormError] = useState('');

  const dayValues = useMemo(() => new Map(days.map(day => [day.d, weightDayValue(day, summary.dailyMode)])), [days, summary.dailyMode]);
  const minAvg = weeks.length ? Math.min(...weeks.map(week => week.avg)) : 0;
  const maxAvg = weeks.length ? Math.max(...weeks.map(week => week.avg)) : 0;

  const openAdd = () => {
    const day = localDate(Date.now());
    setFormError('');
    setForm({ mode: 'add', d: day, at: defaultWeightTime(profile, day), w: '' });
  };

  const openEdit = (reading: WeightReading) => {
    setFormError('');
    setForm({ mode: 'edit', id: reading.id, from: reading.d, d: reading.d, at: reading.at ?? '', w: String(reading.w) });
  };

  const close = () => {
    setForm(null);
    setFormError('');
  };

  const save = () => {
    if (!form) return;
    const draft = { d: form.d, at: form.at, w: form.w };
    const result = form.mode === 'add'
      ? addWeighInChange(profile, draft)
      : (() => {
        const reading = readings.find(item => item.d === form.from && item.id === form.id);
        if (!reading) return { error: '这笔读数已不存在，请重新打开列表。' };
        return editWeighInChange(profile, reading, draft);
      })();
    if ('error' in result) {
      setFormError(result.error);
      return;
    }
    onCommit([result.change]);
    close();
  };

  const confirmDelete = (reading: WeightReading) => {
    const count = readings.filter(item => item.d === reading.d).length;
    Alert.alert(
      '删除这笔称重？',
      count <= 1
        ? `${reading.d} 只有这一笔读数，删除后这一天的日值也会移除。`
        : `${reading.d} ${weightTimeLabel(reading)} 的 ${weightValueLabel(reading.w, unit)} 会从当天移除，其他读数保留。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => onCommit([removeWeighInChange(reading)]) },
      ],
    );
  };

  return (
    <>
      {summary.latest ? (
        <Card>
          <View style={styles.hero}>
            <View style={styles.grow}>
              <Text tone="secondary" variant="footnote">最近体重</Text>
              <Text style={{ marginTop: theme.space.xs }} variant="pageTitle">
                {weightValueLabel(summary.latest.w, unit)}
              </Text>
              <Text tone="secondary" style={{ marginTop: theme.space.xs }} variant="footnote">
                {`${summary.latest.d} ${weightTimeLabel(summary.latest)} · 日值 ${dayValues.get(summary.latest.d) != null ? weightValueLabel(dayValues.get(summary.latest.d) as number, unit) : '—'}`}
              </Text>
            </View>
            {summary.delta != null ? (
              <Badge tone={summary.delta > 0 ? 'orange' : 'neutral'}>
                {`${summary.delta > 0 ? '+' : ''}${summary.delta.toFixed(1)} ${unit}`}
              </Badge>
            ) : null}
          </View>
          {summary.latestAt != null ? (
            <Text tone="secondary" style={{ marginTop: theme.space.sm }} variant="caption">
              {`最近称重时间 ${weightTimestampLabel(summary.latestAt)}`}
            </Text>
          ) : null}
        </Card>
      ) : (
        <EmptyState
          icon="chart"
          text="记录第一次称重后，这里会显示日值、与上一笔的差值和最近几周的周均。"
          title="还没有体重记录"
        >
          <Button icon="plus" onPress={openAdd} variant="primary">添加称重</Button>
        </EmptyState>
      )}

      <Card>
        <Text variant="headline">{`每日取值：${DAILY_MODE_LABEL[summary.dailyMode]}`}</Text>
        <Text tone="secondary" style={{ marginTop: theme.space.xs }} variant="footnote">
          {summary.dailyMode === 'first'
            ? '同一天多次称重时，日值取最早的一笔；周趋势先算每天日值，再按周取平均。'
            : summary.dailyMode === 'last'
              ? '同一天多次称重时，日值取最晚的一笔；周趋势先算每天日值，再按周取平均。'
              : '同一天多次称重时，日值取所有读数的平均值；周趋势再按周取平均。'}
          {' '}该设置跟随账号，可在网页端修改。
        </Text>
      </Card>

      {weeks.length > 0 ? (
        <>
          <SectionHeader action={<Button icon="plus" onPress={openAdd} size="xs" variant="ghost">添加</Button>} title="周趋势（周一开头）" />
          <Card>
            {weeks.map(week => {
              const ratio = maxAvg === minAvg ? 0.5 : (week.avg - minAvg) / (maxAvg - minAvg);
              return (
                <View key={week.key} style={[styles.trendRow, { gap: theme.space.sm, paddingVertical: theme.space.xs }]}>
                  <View style={{ width: 48 }}>
                    <Text tone="secondary" variant="caption">{week.key.slice(5)}</Text>
                  </View>
                  <View
                    style={{
                      flex: 1,
                      height: theme.space.sm,
                      backgroundColor: theme.colors.surface2,
                      borderRadius: theme.radius.pill,
                      overflow: 'hidden',
                    }}
                  >
                    <View
                      style={{
                        width: `${Math.max(6, Math.round(ratio * 100))}%`,
                        height: '100%',
                        backgroundColor: theme.colors.accent,
                        borderRadius: theme.radius.pill,
                      }}
                    />
                  </View>
                  <View style={{ width: 92, alignItems: 'flex-end' }}>
                    <Text variant="subhead">{weightValueLabel(week.avg, unit)}</Text>
                    <Text tone="secondary" variant="caption">
                      {`${week.n} 天${week.delta == null ? '' : ` · ${week.delta > 0 ? '+' : ''}${week.delta.toFixed(1)}`}`}
                    </Text>
                  </View>
                </View>
              );
            })}
          </Card>
        </>
      ) : null}

      <SectionHeader
        action={<Button icon="plus" onPress={openAdd} size="xs" variant="ghost">添加称重</Button>}
        title="读数"
      />

      {groups.length === 0 ? (
        <Card>
          <Text tone="secondary" variant="subhead">还没有读数。添加时可以补记以前的日期。</Text>
        </Card>
      ) : groups.map(group => {
        const day = days.find(item => item.d === group.d);
        const value = day ? weightDayValue(day, summary.dailyMode) : null;
        return (
          <Card gap={0} key={group.d} padded={false}>
            <View style={{ paddingHorizontal: theme.layout.listRowPaddingX, paddingTop: theme.layout.listRowPaddingY }}>
              <View style={[styles.row, { gap: theme.space.sm }]}>
                <Text style={styles.grow} variant="headline">{group.d}</Text>
                {value != null ? <Badge tone="neutral">{`日值 ${weightValueLabel(value, unit)}`}</Badge> : null}
              </View>
            </View>
            <Divider />
            {group.readings.map((reading, index) => (
              <View key={`${reading.d}:${reading.id}`}>
                {index > 0 ? <Divider inset={theme.layout.listRowPaddingX} /> : null}
                <ListRow
                  accessibilityLabel={`${group.d} ${weightTimeLabel(reading)} ${weightValueLabel(reading.w, unit)}，编辑`}
                  onPress={() => openEdit(reading)}
                  subtitle={`${weightTimeLabel(reading)}${reading.src ? ' · 导入' : ''}`}
                  title={weightValueLabel(reading.w, unit)}
                  trailing={(
                    <IconButton
                      accessibilityLabel="删除这笔称重"
                      name="trash"
                      onPress={() => confirmDelete(reading)}
                      size="sm"
                      tone="danger"
                    />
                  )}
                />
              </View>
            ))}
          </Card>
        );
      })}

      <Sheet
        footer={<Button onPress={save} variant="primary">保存</Button>}
        onClose={close}
        title={form?.mode === 'edit' ? '更正称重' : '添加称重'}
        visible={form != null}
      >
        {form ? (
          <View style={[styles.form, { gap: theme.space.md }]}>
            <TextField
              autoCapitalize="none"
              keyboardType="numbers-and-punctuation"
              label="日期"
              onChangeText={d => setForm(current => current ? { ...current, d } : current)}
              placeholder="YYYY-MM-DD"
              value={form.d}
            />
            <TextField
              autoCapitalize="none"
              keyboardType="numbers-and-punctuation"
              label="时间（可留空）"
              onChangeText={at => setForm(current => current ? { ...current, at } : current)}
              placeholder="HH:MM"
              value={form.at}
            />
            <TextField
              keyboardType="decimal-pad"
              label={`体重（${unit}）`}
              onChangeText={w => setForm(current => current ? { ...current, w } : current)}
              placeholder="例如 70.5"
              value={form.w}
            />
            {formError ? <Text tone="danger" variant="footnote">{formError}</Text> : null}
            <Text tone="secondary" variant="footnote">
              同一天同一分钟再次保存会视为更正那一笔；时间留空时不会自动合并到其他读数。
            </Text>
          </View>
        ) : null}
      </Sheet>
    </>
  );
}
