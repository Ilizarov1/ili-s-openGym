import { useState } from 'react';
import { View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import {
  Button,
  Card,
  Chip,
  Divider,
  Header,
  Icon,
  ListRow,
  Screen,
  SectionHeader,
  Segmented,
  Text,
  useTheme,
  type SegmentedOption,
} from '../design';
import type { ProfileChange } from '../profileChanges';
import type { Profile } from '../training';

type ScheduleMode = 'week' | 'rotation';

const scheduleModes: SegmentedOption<ScheduleMode>[] = [
  { value: 'week', label: '每周' },
  { value: 'rotation', label: '轮换' },
];

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export type ScheduleEditorScreenProps = {
  profile: Profile;
  onSave: (value: ProfileChange) => void;
  onClose: () => void;
};

export function ScheduleEditorScreen({ profile, onSave, onClose }: ScheduleEditorScreenProps) {
  const theme = useTheme();
  const [mode, setMode] = useState<ScheduleMode>(profile.scheduleMode === 'rotation' ? 'rotation' : 'week');
  const [day, setDay] = useState(new Date().getDay());
  const [selection, setSelection] = useState<null | string[]>(null);

  const scheduled = profile.week?.[String(day)];
  const currentWeek = typeof scheduled === 'string' ? [scheduled] : scheduled ?? [];
  const initial = mode === 'week' ? currentWeek : profile.rotation?.sequence ?? [];
  const ids = selection ?? initial;
  const routines = (profile.routines ?? []).filter(Boolean);

  function selectMode(next: ScheduleMode) {
    setMode(next);
    setSelection(null);
  }

  function selectDay(next: number) {
    setDay(next);
    setSelection(null);
  }

  function toggleRoutine(id: string) {
    setSelection(ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  }

  function save() {
    if (mode === 'week') {
      onSave({ kind: 'week', day, ids });
      return;
    }
    onSave({ kind: 'rotation', key: profile.rotation?.id ?? randomUUID(), ids, at: Date.now() });
  }

  return (
    <Screen testID="schedule-editor-screen">
      <Header onBack={onClose} subtitle="安排每天或按顺序轮换的计划" title="训练排程" />

      <Segmented onChange={selectMode} options={scheduleModes} value={mode} />

      {mode === 'week' ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, marginTop: theme.space.md }}>
          {weekdays.map((label, index) => (
            <Chip
              key={label}
              onPress={() => selectDay(index)}
              selected={index === day}
            >
              {label}
            </Chip>
          ))}
        </View>
      ) : (
        <Text style={{ marginTop: theme.space.md }} tone="secondary" variant="footnote">
          按点击顺序轮换。取消一项再添加，可以把它移到末尾。
        </Text>
      )}

      {mode === 'rotation' && ids.length > 0 ? (
        <Card style={{ marginTop: theme.space.md }}>
          <Text variant="headline">轮换顺序</Text>
          <Text tone="secondary" variant="subhead">
            {ids.map(id => routines.find(routine => routine.id === id)?.name ?? id).join(' → ')}
          </Text>
        </Card>
      ) : null}

      <SectionHeader
        style={{ marginTop: theme.space.md }}
        title={mode === 'week' ? `${weekdays[day]}的计划` : '选择计划'}
      />

      {routines.length === 0 ? (
        <Text tone="secondary" variant="subhead">还没有计划。先在计划页新建一个训练日。</Text>
      ) : (
        <Card padded={false}>
          {routines.map((routine, index) => {
            const selected = ids.includes(routine.id);
            return (
              <View key={routine.id}>
                {index > 0 ? <Divider inset={theme.layout.listRowPaddingX} /> : null}
                <ListRow
                  accessibilityLabel={`${routine.name}${selected ? '，已选择' : ''}`}
                  onPress={() => toggleRoutine(routine.id)}
                  subtitle={`${(routine.ex ?? []).filter(Boolean).length} 个动作`}
                  title={routine.name}
                  trailing={selected ? <Icon color={theme.colors.accent} name="check" size={20} /> : null}
                />
              </View>
            );
          })}
        </Card>
      )}

      <Button disabled={mode === 'rotation' && ids.length === 0} onPress={save} variant="primary">
        {mode === 'week' ? '保存当天排程' : '保存轮换'}
      </Button>

      {profile.scheduleMode === 'rotation' ? (
        <Button
          onPress={() => onSave({ kind: 'rotation', key: profile.rotation?.id ?? '', ids: [], at: Date.now() })}
          style={{ marginTop: theme.space.sm }}
          variant="secondary"
        >
          启用每周排程
        </Button>
      ) : null}

      <Button onPress={onClose} style={{ marginTop: theme.space.sm }} variant="secondary">
        返回
      </Button>
    </Screen>
  );
}
