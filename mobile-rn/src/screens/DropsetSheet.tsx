import { useState } from 'react';
import { Alert, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Button, IconButton, Sheet, Text, TextField, useTheme } from '../design';
import { MAX_WEIGHT, validDropSegment, validSet, type DraftDrop } from '../training';

type StagedDrop = { key: string; w: string; r: string; at: number | null };

export type DropsetSheetProps = {
  visible: boolean;
  mode: 'create' | 'edit';
  title: string;
  unit: string;
  mainWeight: string;
  mainReps: string;
  /** The main segment already carries a completion time; deleting down to no pending row would finish the set. */
  mainDone: boolean;
  initialDrops: DraftDrop[];
  seedDrop: (base: { w: string; r: string } | null) => DraftDrop | null;
  onClose: () => void;
  onSave: (drops: DraftDrop[]) => void;
};

function weightErrorOf(value: string) {
  const weight = Number(value.replace(',', '.'));
  if (value.trim() === '' || !Number.isFinite(weight) || weight < 0) return '请输入有效重量';
  if (weight > MAX_WEIGHT) return '重量超出允许范围';
  return undefined;
}

function repsErrorOf(value: string) {
  const reps = Number(value);
  if (value.trim() === '' || !Number.isFinite(reps) || !Number.isInteger(reps) || reps <= 0) {
    return '请输入正整数次数';
  }
  if (reps > 500) return '次数不能超过 500';
  return undefined;
}

function dropErrors(row: StagedDrop) {
  const weight = weightErrorOf(row.w);
  const reps = repsErrorOf(row.r);
  const valid = validDropSegment(row);
  return {
    reps,
    // A value above the shared weight ceiling is not caught by the local field
    // checks; leave the weight field to explain the rejected row.
    weight: weight ?? (!valid && reps == null ? '重量超出允许范围' : undefined),
    valid: valid && weight == null && reps == null,
  };
}

/**
 * Staged editor for a dropset's structure. Nothing touches the draft until Save;
 * Cancel, the backdrop and Android back all close through `onClose` and discard the
 * local rows. Existing drops keep their keys (and therefore their tick state) and
 * are only removed after the caller confirms a ticked row.
 */
export function DropsetSheet({
  visible,
  mode,
  title,
  unit,
  mainWeight,
  mainReps,
  mainDone,
  initialDrops,
  seedDrop,
  onClose,
  onSave,
}: DropsetSheetProps) {
  const theme = useTheme();
  const [rows, setRows] = useState<StagedDrop[]>(() => initialDrops.map((drop, index) => ({
    key: drop.key ?? `d${index}`,
    w: drop.w,
    r: drop.r,
    at: drop.at ?? null,
  })));
  const [attempted, setAttempted] = useState(false);

  const mainValid = validSet({ weight: mainWeight, reps: mainReps, at: null }, 'reps');
  const mainError = mainValid ? undefined : '主段的重量或次数无效，请先在卡片主行更正。';
  const errors = rows.map(dropErrors);
  const rowsError = rows.length === 0 ? '至少保留一个降重段。' : undefined;

  const addRow = () => {
    const last = rows[rows.length - 1];
    const seed = seedDrop(last ? { w: last.w, r: last.r } : null);
    if (!seed) {
      Alert.alert('无法添加降重段', '当前这一组不能继续增加降重段。');
      return;
    }
    setRows(previous => [...previous, {
      key: randomUUID(),
      w: seed.w,
      r: seed.r,
      at: null,
    }]);
  };

  const removeRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    const remaining = rows.filter((_, rowIndex) => rowIndex !== index);
    const apply = () => {
      if (mainDone && remaining.every(entry => entry.at != null)) {
        Alert.alert(
          '至少保留一个待完成段',
          '主段已完成，删除最后一个待完成段会直接完成整组。请先取消最后一段的勾选，或保留一个待完成段。',
        );
        return;
      }
      setRows(remaining);
    };
    if (row.at != null) {
      Alert.alert(
        '删除已勾选的分段？',
        '这一段的完成进度会被丢弃。',
        [
          { text: '取消', style: 'cancel' },
          { text: '删除', style: 'destructive', onPress: apply },
        ],
      );
      return;
    }
    apply();
  };

  const save = () => {
    setAttempted(true);
    if (!mainValid || rows.length === 0 || errors.some(error => !error.valid)) return;
    onSave(rows.map(row => ({ key: row.key, w: row.w, r: row.r, at: row.at })));
  };

  return (
    <Sheet
      footer={(
        <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
          <Button
            onPress={onClose}
            size="sm"
            style={{ flex: 1 }}
            testID="dropset-sheet-cancel"
            variant="secondary"
          >
            取消
          </Button>
          <Button
            onPress={save}
            size="sm"
            style={{ flex: 1 }}
            testID="dropset-sheet-save"
            variant="primary"
          >
            保存
          </Button>
        </View>
      )}
      onClose={onClose}
      testID="dropset-sheet"
      title={title}
      visible={visible}
    >
      <View style={{ gap: theme.space.md }}>
        <View style={{ gap: theme.space.xxs }}>
          <Text tone="secondary" variant="footnote">
            {mode === 'create' ? '主段（沿用当前组）' : '主段'}
          </Text>
          <Text variant="body">{`${mainWeight} ${unit} × ${mainReps} 次`}</Text>
          {attempted && mainError ? (
            <Text tone="danger" variant="footnote">{mainError}</Text>
          ) : null}
        </View>

        {rows.map((row, index) => {
          const error = errors[index];
          return (
            <View key={row.key} style={{ gap: theme.space.xs }}>
              <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm, justifyContent: 'space-between' }}>
                <Text tone="secondary" variant="footnote">{`降重 ${index + 1}`}</Text>
                <IconButton
                  accessibilityLabel={`删除降重${index + 1}`}
                  name="xmark"
                  onPress={() => removeRow(index)}
                  size="sm"
                />
              </View>
              <View style={{ flexDirection: 'row', gap: theme.space.sm }}>
                <View style={{ flex: 1 }}>
                  <TextField
                    error={attempted ? error.weight : undefined}
                    keyboardType="decimal-pad"
                    label={`重量（${unit}）`}
                    maxLength={8}
                    onChangeText={weight => setRows(previous => previous.map((entry, rowIndex) =>
                      rowIndex === index ? { ...entry, w: weight } : entry))}
                    selectTextOnFocus
                    testID={`dropset-sheet-weight-${index}`}
                    value={row.w}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <TextField
                    error={attempted ? error.reps : undefined}
                    keyboardType="number-pad"
                    label="次数"
                    maxLength={4}
                    onChangeText={reps => setRows(previous => previous.map((entry, rowIndex) =>
                      rowIndex === index ? { ...entry, r: reps } : entry))}
                    selectTextOnFocus
                    testID={`dropset-sheet-reps-${index}`}
                    value={row.r}
                  />
                </View>
              </View>
            </View>
          );
        })}

        <Button
          icon="plus"
          onPress={addRow}
          size="sm"
          testID="dropset-sheet-add"
          variant="secondary"
        >
          添加降重段
        </Button>
        {attempted && rowsError ? (
          <Text tone="danger" variant="footnote">{rowsError}</Text>
        ) : null}
      </View>
    </Sheet>
  );
}

export default DropsetSheet;
