/**
 * Settings → 数据与备份 → 导入训练历史.
 *
 * The screen only picks a file, shows the upstream parser's summary and hands a
 * confirmed intent to the App. It never writes the profile, the queue or the sync
 * changes itself.
 */

import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import {
  Badge,
  Button,
  Card,
  Divider,
  Header,
  Icon,
  IconTile,
  ListRow,
  Screen,
  SectionHeader,
  StatTile,
  Text,
  useTheme,
} from '../design';
import type { Connection } from '../server';
import type { Profile } from '../training';
import {
  HISTORY_IMPORT_MAX_BYTES,
  prepareHistoryImport,
  type HistoryImportAnalysis,
  type HistoryImportPreview,
  type HistoryImportResult,
} from '../sharing/historyImport';

export type HistoryImportScreenProps = {
  connection: Connection | null;
  profile: Profile;
  onClose: () => void;
  onImport: (result: HistoryImportResult) => void;
};

type Notice = {
  text: string;
  danger?: boolean;
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  centerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
});

function formatDay(day: string | null): string {
  if (!day) return '未知日期';
  const [year, month, date] = day.split('-');
  if (!year || !month || !date) return day;
  return `${year}年${Number(month)}月${Number(date)}日`;
}

function formatRange(preview: HistoryImportPreview): string {
  if (!preview.from && !preview.to) return '日期未知';
  if (!preview.from || !preview.to || preview.from === preview.to) {
    return formatDay(preview.from ?? preview.to);
  }
  return `${formatDay(preview.from)} – ${formatDay(preview.to)}`;
}

function unitSummary(preview: HistoryImportPreview): string {
  if (preview.mixedUnits) {
    return `文件混用 kg 和 lb，已逐组换算为 ${preview.profileUnit}。`;
  }
  if (preview.converted && preview.fileUnit) {
    return `文件使用 ${preview.fileUnit}，已换算为 ${preview.profileUnit}。`;
  }
  if (preview.fileUnit) {
    return `文件单位 ${preview.fileUnit}，与账号一致。`;
  }
  return `文件没有标注单位，重量按 ${preview.profileUnit} 原样导入。`;
}

function sourceLabel(source: string): string {
  return source || '通用 CSV';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '无法读取这个文件。';
}

export function HistoryImportScreen({
  connection,
  profile,
  onClose,
  onImport,
}: HistoryImportScreenProps) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<HistoryImportAnalysis | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [submitted, setSubmitted] = useState<HistoryImportResult | null>(null);
  const confirming = useRef(false);

  const pickFile = async () => {
    if (busy) return;
    confirming.current = false;
    setBusy(true);
    setNotice(null);
    setSubmitted(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      setAnalysis(null);
      const asset = picked.assets[0];
      const file = new File(asset.uri);
      try {
        if (file.size > HISTORY_IMPORT_MAX_BYTES) {
          setNotice({ danger: true, text: '文件超过 20 MB。请选择较小的训练历史导出。' });
          return;
        }
        const text = await file.text();
        setAnalysis(prepareHistoryImport(text, profile));
      } finally {
        try {
          if (file.exists) file.delete();
        } catch {
          // The cache copy is best-effort; the imported text is already in memory.
        }
      }
    } catch (error) {
      setNotice({ danger: true, text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (!analysis || analysis.kind !== 'history' || busy || submitted || confirming.current) return;
    confirming.current = true;
    try {
      // Re-read against the latest profile: a sync between preview and confirm may
      // have brought in a day this file also contains.
      const latest = prepareHistoryImport(analysis.text, profile);
      setAnalysis(latest);
      if (latest.kind !== 'history') {
        setNotice({ danger: true, text: latest.message });
        confirming.current = false;
        return;
      }
      if (latest.result.imported === 0) {
        setNotice({ text: '没有可导入的新训练：文件中的日期都已有记录。' });
        confirming.current = false;
        return;
      }
      onImport(latest.result);
      setSubmitted(latest.result);
      setNotice(null);
    } catch (error) {
      confirming.current = false;
      setNotice({ danger: true, text: errorText(error) });
    }
  };

  const cancelPreview = () => {
    confirming.current = false;
    setAnalysis(null);
    setSubmitted(null);
    setNotice(null);
  };

  const preview = analysis?.kind === 'history' ? analysis.preview : null;
  const result = analysis?.kind === 'history' ? analysis.result : null;
  const guidance = analysis && analysis.kind !== 'history' ? analysis : null;
  const hasNew = (result?.imported ?? 0) > 0;

  return (
    <Screen testID="history-import-screen">
      <Header
        compact
        onBack={onClose}
        subtitle="从其他应用带入已完成训练"
        title="导入训练历史"
      />

      <Card gap={theme.space.sm}>
        <View style={[styles.row, { gap: theme.space.md }]}>
          <IconTile name="download" size="md" tone="soft" />
          <View style={styles.grow}>
            <Text variant="headline">选择导出文件</Text>
            <Text tone="secondary" variant="footnote">
              FitNotes、Strong、Hevy、Gravl、Liftosaur、Liftoff、StrongLifts、Fitbod、JEFIT
              或通用 CSV / JSON。
            </Text>
          </View>
          <Badge tone={connection ? 'accent' : 'neutral'}>
            {connection ? '已连接' : '本机练习'}
          </Badge>
        </View>
        <Button
          disabled={busy}
          icon="folder"
          loading={busy}
          onPress={() => { pickFile().catch(() => undefined); }}
          testID="history-import-pick"
          variant="primary"
        >
          选择文件
        </Button>
        <Text tone="secondary" variant="caption">
          只在这里预览，确认后才写入。单个文件最大 20 MB；文件不会上传。
        </Text>
      </Card>

      {notice ? (
        <Card>
          <View style={[styles.row, { gap: theme.space.sm }]}>
            <Icon
              color={notice.danger ? theme.colors.danger : theme.colors.warning}
              name={notice.danger ? 'warning' : 'info'}
              size={18}
            />
            <Text
              accessibilityLiveRegion="polite"
              style={styles.grow}
              tone={notice.danger ? 'danger' : 'secondary'}
              variant="footnote"
            >
              {notice.text}
            </Text>
          </View>
        </Card>
      ) : null}

      {guidance ? (
        <Card>
          <View style={[styles.row, { gap: theme.space.sm }]}>
            <Icon
              color={guidance.kind === 'error' ? theme.colors.danger : theme.colors.warning}
              name={guidance.kind === 'error' ? 'warning' : 'info'}
              size={18}
            />
            <Text
              style={styles.grow}
              tone={guidance.kind === 'error' ? 'danger' : 'secondary'}
              variant="subhead"
            >
              {guidance.message}
            </Text>
          </View>
        </Card>
      ) : null}

      {preview && result ? (
        <>
          <SectionHeader
            action={<Badge tone="neutral">{sourceLabel(preview.source)}</Badge>}
            title="导入预览"
          />
          <Card gap={theme.space.sm}>
            <View style={[styles.centerRow, { justifyContent: 'space-between', gap: theme.space.sm }]}>
              <Text variant="headline">将导入 {preview.workoutCount} 场训练</Text>
              <Text tone="secondary" variant="footnote">{formatRange(preview)}</Text>
            </View>
            <Text tone="secondary" variant="subhead">
              文件共 {preview.fileWorkoutCount} 场、{preview.fileSetCount} 组；确认后只写入空白日期。
            </Text>
            <View style={[styles.wrap, { gap: theme.space.md }]}>
              <StatTile
                detail={`文件共 ${preview.fileWorkoutCount} 场`}
                icon="dumbbell"
                label="训练"
                style={{ flexBasis: '45%', flexGrow: 1 }}
                value={String(preview.workoutCount)}
              />
              <StatTile
                detail={`文件共 ${preview.fileSetCount} 组`}
                icon="list"
                label="完成组"
                style={{ flexBasis: '45%', flexGrow: 1 }}
                tone="blue"
                value={String(preview.setCount)}
              />
            </View>
            <Divider />
            <ListRow
              leading={<IconTile name="calendar" size="sm" tone="neutral" />}
              subtitle={formatRange(preview)}
              title="日期"
              trailing={<Badge tone="neutral">{preview.workoutCount} 场</Badge>}
            />
            <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
            <ListRow
              leading={<IconTile name="scale" size="sm" tone="neutral" />}
              subtitle={unitSummary(preview)}
              title="单位"
              trailing={<Badge tone="neutral">{preview.profileUnit}</Badge>}
            />
            <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
            <ListRow
              leading={<IconTile name="checkCircle" size="sm" tone="soft" />}
              subtitle="已在动作库中找到"
              title="自动匹配"
              trailing={<Text variant="headline">{preview.matched}</Text>}
            />
            <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
            <ListRow
              leading={<IconTile name="plusCircle" size="sm" tone="orange" />}
              subtitle="会创建为你自己的动作"
              title="新建动作"
              trailing={<Text variant="headline">{preview.newExerciseCount}</Text>}
            />
            <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
            <ListRow
              leading={<IconTile name="repeat" size="sm" tone="neutral" />}
              subtitle="复用已有的同名自定义动作"
              title="复用动作"
              trailing={<Text variant="headline">{preview.reusedExerciseCount}</Text>}
            />
            <Divider />
            <ListRow
              leading={<IconTile name="xmark" size="sm" tone="neutral" />}
              subtitle={`${preview.skippedWorkouts} 场（${preview.skippedDays} 天）因日期已有记录而跳过 · ${preview.skippedRows} 行无法读取`}
              title="跳过"
              trailing={<Badge tone={preview.skippedWorkouts > 0 || preview.skippedRows > 0 ? 'orange' : 'neutral'}>
                {preview.skippedWorkouts + preview.skippedRows}
              </Badge>}
            />
          </Card>

          {preview.rpeSets + preview.rirSets > 0 ? (
            <Card>
              <View style={[styles.row, { gap: theme.space.sm }]}>
                <Icon color={theme.colors.accentInk} name="gauge" size={18} />
                <Text style={styles.grow} tone="secondary" variant="footnote">
                  文件中有 {preview.rpeSets + preview.rirSets} 组带 RPE/RIR 评分，已随组保留。
                </Text>
              </View>
            </Card>
          ) : null}

          {preview.extraPlanCount > 0 ? (
            <Card>
              <View style={[styles.row, { gap: theme.space.sm }]}>
                <Icon color={theme.colors.warning} name="info" size={18} />
                <Text style={styles.grow} tone="secondary" variant="footnote">
                  文件还包含 {preview.extraPlanCount} 套计划。本页只导入训练历史，计划请到「计划 → 分享计划」导入。
                </Text>
              </View>
            </Card>
          ) : null}

          {preview.newExerciseNames.length > 0 ? (
            <>
              <SectionHeader title="将新建的动作" />
              <Card gap={theme.space.sm}>
                <Text tone="secondary" variant="footnote">
                  这些名字不在动作库，也没有可复用的自定义动作。被跳过的训练不会创建动作。
                </Text>
                <View style={[styles.wrap, { gap: theme.space.xs }]}>
                  {preview.newExerciseNames.map(name => (
                    <Badge key={name} tone="neutral">{name}</Badge>
                  ))}
                </View>
              </Card>
            </>
          ) : null}

          {preview.reusedExerciseNames.length > 0 ? (
            <>
              <SectionHeader title="将复用的动作" />
              <Card gap={theme.space.sm}>
                <View style={[styles.wrap, { gap: theme.space.xs }]}>
                  {preview.reusedExerciseNames.map(name => (
                    <Badge key={name} tone="accent">{name}</Badge>
                  ))}
                </View>
              </Card>
            </>
          ) : null}

          {submitted ? (
            <Card>
              <View style={[styles.row, { gap: theme.space.sm }]}>
                <Icon color={theme.colors.accentInk} name="checkCircle" size={20} />
                <View style={styles.grow}>
                  <Text variant="headline">导入已确认</Text>
                  <Text tone="secondary" variant="footnote">
                    本次导入 {submitted.imported} 场，跳过 {submitted.skipped} 场；新建动作{' '}
                    {submitted.newExercises.length} 个。
                  </Text>
                </View>
              </View>
              <Button onPress={onClose} variant="primary">完成</Button>
            </Card>
          ) : (
            <>
              <Button
                disabled={!hasNew || busy}
                icon="check"
                onPress={confirm}
                testID="history-import-confirm"
                variant="primary"
              >
                {hasNew ? `导入 ${result.imported} 场训练` : '没有可导入的新训练'}
              </Button>
              <Button onPress={cancelPreview} variant="ghost">取消这次导入</Button>
            </>
          )}
        </>
      ) : null}
    </Screen>
  );
}
