import { useEffect, useMemo, useState } from 'react';
import { Alert, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';
import {
  Badge,
  Button,
  Card,
  Chip,
  Divider,
  EmptyState,
  IconButton,
  ListRow,
  SectionHeader,
  Text,
  TextField,
  useTheme,
} from '../design';
import type { ProfileChange } from '../profileChanges';
import { localDate, type Profile, type MeasurementEntry } from '../training';
import {
  customMeasurementRows,
  measurementDeleteChange,
  measurementDisplay,
  measurementDraft,
  measurementEntries,
  measurementEntryFor,
  measurementFields,
  measurementSaveChange,
  measurementSeriesFor,
  measurementSummary,
  measurementValueText,
  type MeasurementDraft,
} from './measurements';

export type MeasurementSectionProps = {
  profile: Profile;
  onCommit: (changes: ProfileChange[]) => void;
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  chart: {
    width: '100%',
  },
});

function validDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const noon = new Date(`${day}T12:00:00`).getTime();
  return Number.isFinite(noon) && localDate(noon) === day && day <= localDate(Date.now());
}

function MeasurementChart({ points, unit }: { points: { d: string; t: number; y: number }[]; unit: string }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const height = 150;
  const padding = theme.space.lg;

  if (points.length === 0) {
    return <Text tone="secondary" variant="subhead">这个部位还没有历史数据。</Text>;
  }
  const minY = Math.min(...points.map(point => point.y));
  const maxY = Math.max(...points.map(point => point.y));
  const minT = Math.min(...points.map(point => point.t));
  const maxT = Math.max(...points.map(point => point.t));
  const span = maxT - minT;
  const valueSpan = maxY - minY;
  const xOf = (point: { t: number }) => span === 0 ? width / 2 : padding + ((point.t - minT) / span) * Math.max(1, width - padding * 2);
  const yOf = (point: { y: number }) => valueSpan === 0 ? height / 2 : padding + ((maxY - point.y) / valueSpan) * Math.max(1, height - padding * 2);
  const coords = points.map(point => `${xOf(point)},${yOf(point)}`).join(' ');
  const first = points[0];
  const last = points.at(-1) as { d: string; t: number; y: number };

  return (
    <View style={{ gap: theme.space.sm }}>
      <View
        onLayout={(event: LayoutChangeEvent) => {
          const next = event.nativeEvent.layout.width;
          setWidth(current => current === next ? current : next);
        }}
        style={styles.chart}
      >
        {width > 0 ? (
          <Svg height={height} width={width}>
            <Line
              stroke={theme.colors.sep}
              strokeWidth={1}
              x1={padding}
              x2={Math.max(padding, width - padding)}
              y1={height - padding}
              y2={height - padding}
            />
            <Polyline
              fill="none"
              points={coords}
              stroke={theme.colors.accent}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
            />
            {points.map(point => (
              <Circle
                cx={xOf(point)}
                cy={yOf(point)}
                fill={theme.colors.accent}
                key={`${point.d}:${point.t}`}
                r={3}
              />
            ))}
          </Svg>
        ) : null}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.sm }}>
        <Text tone="secondary" variant="caption">{`${maxY}${unit ? ` ${unit}` : ''}`}</Text>
        <Text tone="secondary" variant="caption">{`${minY}${unit ? ` ${unit}` : ''}`}</Text>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.sm }}>
        <Text tone="secondary" variant="caption">{first.d}</Text>
        <Text tone="secondary" variant="caption">{last.d}</Text>
      </View>
    </View>
  );
}

/** 围度：按日期编辑内置部位和体脂，保留网页端 `other` 字段，并提供单部位曲线。 */
export function MeasurementSection({ profile, onCommit }: MeasurementSectionProps) {
  const theme = useTheme();
  const today = localDate(Date.now());
  const [dayInput, setDayInput] = useState(today);
  const [day, setDay] = useState(today);
  const [dateError, setDateError] = useState('');
  const [draft, setDraft] = useState<MeasurementDraft>(() => measurementDraft(profile, measurementEntryFor(profile, today)));
  const [saveError, setSaveError] = useState('');
  const [selectedKey, setSelectedKey] = useState('waist');

  const entries = useMemo(() => measurementEntries(profile), [profile]);
  const entry = useMemo(() => measurementEntryFor(profile, day), [profile, day]);
  const fields = useMemo(() => measurementFields(profile, entry).filter(field => !field.custom), [profile, entry]);
  const groups = useMemo(() => [...new Set(fields.map(field => field.group))], [fields]);
  const customRows = customMeasurementRows(entry);
  const availableKeys = useMemo(() => {
    const keys: string[] = [];
    const latest = entries.at(-1) ?? null;
    for (const field of measurementFields(profile, latest)) {
      if (field.custom) continue;
      if (measurementSeriesFor(profile, field.key).length > 0) keys.push(field.key);
    }
    return keys;
  }, [entries, profile]);
  const activeKey = availableKeys.includes(selectedKey) ? selectedKey : availableKeys[0] ?? null;
  const activeField = fields.find(field => field.key === activeKey) ?? measurementFields(profile, entries.at(-1) ?? null).find(field => field.key === activeKey);
  const points = activeKey ? measurementSeriesFor(profile, activeKey) : [];
  const datePending = !validDay(dayInput.trim()) || dayInput.trim() !== day;

  useEffect(() => {
    setDraft(measurementDraft(profile, measurementEntryFor(profile, day)));
    setSaveError('');
    // Only the selected day loads a form. A background sync must not wipe what is being typed;
    // the change's field-level base values protect concurrent edits on save.
  }, [day]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadDay = () => {
    if (!validDay(dayInput.trim())) {
      setDateError('请选择有效日期，不能晚于今天。');
      return;
    }
    setDateError('');
    setDay(dayInput.trim());
  };

  const save = () => {
    if (datePending) {
      setSaveError('修改日期后请先点“查看”，再保存围度。');
      return;
    }
    const result = measurementSaveChange(profile, day, entry, draft);
    if ('error' in result) {
      setSaveError(result.error);
      return;
    }
    onCommit([result.change]);
    setSaveError('');
  };

  const clearField = (key: string) => {
    setDraft(current => ({ ...current, [key]: '' }));
  };

  const confirmDelete = (target: MeasurementEntry) => {
    Alert.alert(
      '删除这天的围度？',
      `${target.d} 的所有内置围度、体脂和网页端自定义指标都会移除。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => {
          onCommit([measurementDeleteChange(target.d)]);
          if (target.d === day) setDraft(measurementDraft(profile, null));
        } },
      ],
    );
  };

  return (
    <>
      <Card>
        <View style={[styles.row, { gap: theme.space.sm }]}>
          <View style={styles.grow}>
            <TextField
              autoCapitalize="none"
              error={dateError}
              helper={datePending ? '修改日期后请先点“查看”' : undefined}
              keyboardType="numbers-and-punctuation"
              label="日期"
              onChangeText={value => { setDayInput(value); if (dateError) setDateError(''); }}
              placeholder="YYYY-MM-DD"
              value={dayInput}
            />
          </View>
          <Button onPress={loadDay} size="sm" variant="secondary">查看</Button>
          <Button
            onPress={() => { setDayInput(today); setDay(today); setDateError(''); }}
            size="sm"
            variant="ghost"
          >
            今天
          </Button>
        </View>
        <Text tone="secondary" style={{ marginTop: theme.space.sm }} variant="footnote">
          {`每天最多一项记录；可以先填部分部位，之后回来继续补。长度按${profile.unit === 'lb' ? '英寸输入、厘米保存' : '厘米保存'}。`}
        </Text>
      </Card>

      <SectionHeader
        action={entry ? (
          <Button icon="trash" onPress={() => confirmDelete(entry)} size="xs" variant="ghost">删除整天</Button>
        ) : undefined}
        title={entry ? `编辑 ${day} 的记录` : `记录 ${day}`}
      />

      {groups.map(group => (
        <Card gap={theme.space.md} key={group}>
          <Text variant="headline">{group}</Text>
          {fields.filter(field => field.group === group).map(field => (
            <View key={field.key} style={[styles.row, { gap: theme.space.sm }]}>
              <View style={styles.grow}>
                <TextField
                  keyboardType="decimal-pad"
                  label={`${field.label}${field.unit ? `（${field.unit}）` : ''}`}
                  onChangeText={value => setDraft(current => ({ ...current, [field.key]: value }))}
                  placeholder={entry ? '留空表示没有或清除' : '可留空'}
                  value={draft[field.key] ?? measurementValueText(profile, entry, field)}
                />
              </View>
              {(draft[field.key] ?? '').trim() !== '' ? (
                <IconButton
                  accessibilityLabel={`清除${field.label}`}
                  name="xmark"
                  onPress={() => clearField(field.key)}
                  size="sm"
                />
              ) : null}
            </View>
          ))}
        </Card>
      ))}

      {customRows.length > 0 ? (
        <Card>
          <Text variant="headline">网页端自定义指标</Text>
          <Text tone="secondary" style={{ marginTop: theme.space.xs }} variant="footnote">
            这些字段由网页端创建，RN 会原样保留；编辑面板只修改内置部位和体脂。
          </Text>
          {customRows.map(row => {
            const value = measurementDisplay(profile, entry, `other:${row.id}`);
            return (
              <View key={row.id} style={{ marginTop: theme.space.sm }}>
                <Text variant="subhead">{`${row.name || '自定义指标'}${value == null ? '' : ` · ${value}${row.unit && row.unit !== 'none' ? ` ${row.unit}` : ''}`}`}</Text>
              </View>
            );
          })}
        </Card>
      ) : null}

      {saveError ? <Text tone="danger" style={{ marginBottom: theme.space.sm }} variant="footnote">{saveError}</Text> : null}
      <Button disabled={datePending} icon="check" onPress={save} variant="primary">
        {entry ? '保存围度' : '创建围度记录'}
      </Button>

      <SectionHeader style={{ marginTop: theme.space.xl }} title="单部位曲线" />
      {availableKeys.length > 0 ? (
        <>
          <View style={[styles.chips, { gap: theme.space.sm, marginBottom: theme.space.sm }]}>
            {availableKeys.map(key => {
              const field = measurementFields(profile, entries.at(-1) ?? null).find(item => item.key === key);
              return (
                <Chip key={key} onPress={() => setSelectedKey(key)} selected={activeKey === key} size="sm">
                  {field?.label ?? key}
                </Chip>
              );
            })}
          </View>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: theme.space.sm }}>
              <Text variant="headline">{activeField?.label ?? activeKey ?? '部位'}</Text>
              {activeField?.unit ? <Badge tone="neutral">{activeField.unit}</Badge> : null}
            </View>
            <MeasurementChart points={points} unit={activeField?.unit ?? ''} />
            <Text tone="secondary" style={{ marginTop: theme.space.sm }} variant="footnote">
              缺失该部位数值的日期会跳过，曲线只连接实际记录过的点。
            </Text>
          </Card>
        </>
      ) : (
        <Card>
          <Text tone="secondary" variant="subhead">至少保存一次围度后，这里会显示按日期排列的单部位曲线。</Text>
        </Card>
      )}

      <SectionHeader
        action={entries.length > 0 ? <Badge tone="neutral">{`${entries.length} 天`}</Badge> : undefined}
        style={{ marginTop: theme.space.xl }}
        title="历史记录"
      />
      {entries.length === 0 ? (
        <EmptyState
          icon="chart"
          text="选择日期并至少填写一个部位，就能开始记录围度。"
          title="还没有围度记录"
        />
      ) : [...entries].reverse().map(item => (
        <Card gap={0} key={item.d} padded={false}>
          <ListRow
            accessibilityLabel={`${item.d} 围度，编辑`}
            onPress={() => { setDayInput(item.d); setDay(item.d); setDateError(''); }}
            subtitle={measurementSummary(profile, item) || '没有数值'}
            title={item.d}
            trailing={(
              <IconButton
                accessibilityLabel={`删除 ${item.d} 的围度`}
                name="trash"
                onPress={() => confirmDelete(item)}
                size="sm"
                tone="danger"
              />
            )}
          />
          <Divider />
        </Card>
      ))}
    </>
  );
}
