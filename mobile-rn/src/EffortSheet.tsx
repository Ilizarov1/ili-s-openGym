/**
 * RPE / RIR picker shared by the workout and the history editor.
 *
 * Quick chips land on the same effort bands as the web app; the exact field keeps
 * the free value between them (RPE below 6 included). Save, clear and cancel are
 * explicit: opening or typing alone never writes to a set, and clearing removes
 * the field rather than storing null.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Button, Chip, Sheet, Stepper, Text, useTheme } from './design';
import { capEffortValue, effortPresets, formatEffort, scaleMax, scaleName, scaleStep } from './effort';
import type { RatingScale } from './training';

export type EffortSheetProps = {
  visible: boolean;
  scale: RatingScale;
  value: number | null;
  cardio?: boolean;
  onSave: (value: number) => void;
  onClear: () => void;
  onClose: () => void;
};

function parseEffort(text: string): number | null {
  if (text.trim() === '') return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

export function EffortSheet({
  visible,
  scale,
  value,
  cardio = false,
  onSave,
  onClear,
  onClose,
}: EffortSheetProps) {
  const theme = useTheme();
  const [text, setText] = useState(() => (value == null ? '' : formatEffort(value)));
  const presets = effortPresets(scale, cardio);
  const parsed = parseEffort(text);
  const valid = parsed != null && parsed >= 0 && parsed <= 10;
  const selected = valid ? presets.find(preset => preset.value === parsed) : undefined;
  const empty = text.trim() === '';
  // The first `+` on an unrated field lands on the scale's own floor: RIR 0 or
  // RPE 6. A value typed below 6 still steps evenly from where it is.
  const emptyValue = scale === 'rpe' ? 6 : 0;

  // Reset only when the sheet opens: a parent re-render must not overwrite typing.
  useEffect(() => {
    if (visible) setText(value == null ? '' : formatEffort(value));
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Sheet
      footer={(
        <View style={{ gap: theme.space.sm }}>
          <Button
            disabled={!valid}
            icon="check"
            onPress={() => parsed != null && onSave(capEffortValue(parsed))}
            testID="effort-save"
            variant="primary"
          >
            保存评分
          </Button>
          <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
            {value != null ? (
              <Button
                onPress={onClear}
                size="sm"
                style={{ flex: 1 }}
                testID="effort-clear"
                variant="danger"
              >
                清除评分
              </Button>
            ) : null}
            <Button onPress={onClose} size="sm" style={{ flex: 1 }} variant="secondary">
              取消
            </Button>
          </View>
        </View>
      )}
      onClose={onClose}
      testID="effort-sheet"
      title={`${cardio ? '有氧' : '力量'}评分 · ${scaleName(scale)}`}
      visible={visible}
    >
      <Text tone="secondary" variant="footnote">
        {cardio
          ? '选择这次有多累，或输入精确评分。'
          : scale === 'rir'
            ? '选择还能做几次（RIR），也可以输入精确评分。'
            : '选择这组有多难（RPE），也可以输入精确评分。'}
      </Text>

      <Text style={{ marginTop: theme.space.md }} tone="secondary" variant="footnote">快捷评分</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, marginTop: theme.space.sm }}>
        {presets.map(preset => (
          <Chip
            key={preset.value}
            onPress={() => setText(formatEffort(preset.value))}
            selected={valid && parsed === preset.value}
            size="sm"
            testID={`effort-preset-${formatEffort(preset.value)}`}
          >
            {`${formatEffort(preset.value)}${preset.tail ? '+' : ''}`}
          </Chip>
        ))}
      </View>
      {selected ? (
        <Text style={{ marginTop: theme.space.sm }} tone="secondary" variant="footnote">{selected.feel}</Text>
      ) : null}

      <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.md, marginTop: theme.space.lg }}>
        <Text style={{ flex: 1 }} variant="subhead">精确值</Text>
        <Stepper
          accessibilityLabel={`${scaleName(scale)} 精确值`}
          emptyValue={emptyValue}
          min={0}
          max={scaleMax(scale)}
          onChangeText={setText}
          precision={1}
          step={scaleStep(scale)}
          unit={scaleName(scale)}
          value={text}
        />
      </View>
      {!valid && !empty ? (
        <Text style={{ marginTop: theme.space.sm }} tone="danger" variant="footnote">
          请输入 0–10 之间的评分。
        </Text>
      ) : null}

      <Text style={{ marginTop: theme.space.md }} tone="secondary" variant="footnote">
        评分是可选信息，只保存难度，不会勾选这一组或启动休息计时。
      </Text>
    </Sheet>
  );
}
