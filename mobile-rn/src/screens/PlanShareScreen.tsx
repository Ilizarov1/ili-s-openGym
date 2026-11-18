/**
 * Plan tab → share → 导出 / 导入 openGym 计划文件.
 *
 * Export writes a temporary JSON file and hands it to the Android share sheet.
 * Import only previews the upstream parser's result and, after confirmation, gives
 * the App a stable list of profile changes (new routines, custom exercises and,
 * optionally, the shared weekly schedule).
 */

import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import { shareAsync } from 'expo-sharing';
import {
  Badge,
  Button,
  Card,
  Divider,
  EmptyState,
  Header,
  Icon,
  IconTile,
  ListRow,
  Screen,
  SectionHeader,
  Segmented,
  StatTile,
  SwitchRow,
  Text,
  useTheme,
} from '../design';
import type { ProfileChange } from '../profileChanges';
import type { Profile } from '../training';
import { localDate } from '../training';
import {
  PLAN_SHARE_MAX_BYTES,
  buildPlanExport,
  planImportChanges,
  preparePlanImport,
  type PlanImportAnalysis,
  type PlanImportPreview,
} from '../sharing/planShare';

export type PlanShareMode = 'export' | 'import';

export type PlanShareScreenProps = {
  profile: Profile;
  onClose: () => void;
  onChange: (changes: ProfileChange[]) => void;
  initialMode?: PlanShareMode;
};

type Notice = {
  text: string;
  danger?: boolean;
};

const MODE_OPTIONS: { value: PlanShareMode; label: string }[] = [
  { value: 'export', label: '导出' },
  { value: 'import', label: '导入' },
];

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

function unitText(preview: PlanImportPreview): string {
  if (preview.converted && preview.sourceUnit) {
    return `文件使用 ${preview.sourceUnit}，导入时换算为 ${preview.destinationUnit}。`;
  }
  if (preview.sourceUnit) {
    return `文件单位 ${preview.sourceUnit}，与当前账号一致。`;
  }
  return `文件没有标注单位，重量按 ${preview.destinationUnit} 原样保留。`;
}

export function PlanShareScreen({
  profile,
  onClose,
  onChange,
  initialMode = 'export',
}: PlanShareScreenProps) {
  const theme = useTheme();
  const routines = (profile.routines ?? []).filter(Boolean);
  const [mode, setMode] = useState<PlanShareMode>(initialMode);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(routines.map(routine => routine.id)),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [exported, setExported] = useState<{ routines: number; exercises: number } | null>(null);
  const [importFile, setImportFile] = useState<Extract<PlanImportAnalysis, { kind: 'plan' }> | null>(null);
  const [adoptSchedule, setAdoptSchedule] = useState(false);
  const [importDone, setImportDone] = useState<{ routines: number; schedule: boolean } | null>(null);
  const confirming = useRef(false);

  const toggleRoutine = (id: string) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setExported(null);
  };

  const selectAll = () => {
    setSelected(new Set(routines.map(routine => routine.id)));
    setExported(null);
  };

  const selectNone = () => {
    setSelected(new Set());
    setExported(null);
  };

  const exportFile = async () => {
    if (busy) return;
    const ids = routines.filter(routine => selected.has(routine.id)).map(routine => routine.id);
    if (ids.length === 0) {
      setNotice({ danger: true, text: '请至少勾选一套计划。' });
      return;
    }
    setBusy(true);
    setNotice(null);
    setExported(null);
    try {
      const bundle = buildPlanExport(profile, ids);
      const file = new File(
        Paths.cache,
        `opengym-plan-${localDate(Date.now())}-${randomUUID().slice(0, 8)}.json`,
      );
      file.write(JSON.stringify(bundle.bundle, null, 2));
      await shareAsync(file.uri, {
        mimeType: 'application/json',
        dialogTitle: '分享训练计划',
      });
      setExported({ routines: bundle.routineCount, exercises: bundle.exerciseCount });
    } catch (error) {
      setNotice({ danger: true, text: `导出失败：${errorText(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const pickPlan = async () => {
    if (busy) return;
    confirming.current = false;
    setBusy(true);
    setNotice(null);
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'text/plain', 'application/octet-stream'],
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      setImportFile(null);
      setImportDone(null);
      setAdoptSchedule(false);
      const asset = picked.assets[0];
      const file = new File(asset.uri);
      try {
        if (file.size > PLAN_SHARE_MAX_BYTES) {
          setNotice({ danger: true, text: '计划文件超过 20 MB。请选择 openGym 导出的计划 JSON。' });
          return;
        }
        const text = await file.text();
        const analysis = preparePlanImport(text, profile);
        if (analysis.kind === 'plan') setImportFile(analysis);
        else setNotice({ danger: analysis.kind === 'error', text: analysis.message });
      } finally {
        try {
          if (file.exists) file.delete();
        } catch {
          // Best-effort cache cleanup.
        }
      }
    } catch (error) {
      setNotice({ danger: true, text: `无法读取文件：${errorText(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = () => {
    if (!importFile || busy || importDone || confirming.current) return;
    confirming.current = true;
    try {
      const latest = preparePlanImport(importFile.text, profile);
      if (latest.kind !== 'plan') {
        setNotice({ danger: true, text: latest.message });
        setImportFile(null);
        confirming.current = false;
        return;
      }
      const changes = planImportChanges(profile, latest.parsed, adoptSchedule, latest.fingerprint);
      if (changes.length === 0) {
        setNotice({ text: '这次导入没有生成任何变更。' });
        setImportFile(latest);
        confirming.current = false;
        return;
      }
      setImportFile(latest);
      onChange(changes);
      setImportDone({ routines: latest.preview.routineCount, schedule: adoptSchedule });
      setNotice(null);
    } catch (error) {
      setNotice({ danger: true, text: `导入失败：${errorText(error)}` });
      confirming.current = false;
    }
  };

  const cancelImport = () => {
    confirming.current = false;
    setImportFile(null);
    setImportDone(null);
    setAdoptSchedule(false);
    setNotice(null);
  };

  const preview = importFile?.preview ?? null;
  const selectedCount = routines.filter(routine => selected.has(routine.id)).length;

  return (
    <Screen testID="plan-share-screen">
      <Header
        compact
        onBack={onClose}
        subtitle="把计划发给别人，或导入一份计划文件"
        title="分享计划"
      />

      <Segmented
        onChange={value => {
          setMode(value);
          setNotice(null);
        }}
        options={MODE_OPTIONS}
        style={{ marginBottom: theme.space.lg }}
        testID="plan-share-mode"
        value={mode}
      />

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

      {mode === 'export' ? (
        routines.length === 0 ? (
          <EmptyState
            icon="calendar"
            text="先创建或导入一套计划，再把它发给别人。"
            title="还没有可以分享的计划"
          >
            <Button onPress={() => setMode('import')} variant="primary">导入计划文件</Button>
          </EmptyState>
        ) : (
          <>
            <Card gap={theme.space.sm}>
              <View style={[styles.centerRow, { justifyContent: 'space-between', gap: theme.space.sm }]}>
                <View style={styles.grow}>
                  <Text variant="headline">选择要导出的计划</Text>
                  <Text tone="secondary" variant="footnote">
                    文件还包含所选计划的周排程和被引用的自定义动作。
                  </Text>
                </View>
                <Badge tone="neutral">{selectedCount} / {routines.length}</Badge>
              </View>
              <View style={[styles.wrap, { gap: theme.space.sm }]}>
                <Button onPress={selectAll} size="xs" variant="tinted">全选</Button>
                <Button disabled={selectedCount === 0} onPress={selectNone} size="xs" variant="secondary">
                  全不选
                </Button>
              </View>
            </Card>

            <Card padded={false}>
              {routines.map((routine, index) => (
                <View key={routine.id}>
                  {index > 0 ? (
                    <Divider inset={theme.layout.listRowPaddingX} />
                  ) : null}
                  <SwitchRow
                    onValueChange={() => toggleRoutine(routine.id)}
                    subtitle={`${(routine.ex ?? []).filter(Boolean).length} 个动作`}
                    title={routine.name}
                    value={selected.has(routine.id)}
                  />
                </View>
              ))}
            </Card>

            <Button
              disabled={selectedCount === 0 || busy}
              icon="share"
              loading={busy}
              onPress={() => { exportFile().catch(() => undefined); }}
              testID="plan-share-export"
              variant="primary"
            >
              导出并分享
            </Button>
            <Text style={{ marginTop: theme.space.sm }} tone="secondary" variant="caption">
              文件不含训练历史、体重或配对凭据。导出后使用系统分享发送 JSON 文件。
            </Text>

            {exported ? (
              <Card>
                <View style={[styles.row, { gap: theme.space.sm }]}>
                  <Icon color={theme.colors.accentInk} name="checkCircle" size={20} />
                  <Text style={styles.grow} tone="secondary" variant="footnote">
                    已生成 {exported.routines} 套计划、{exported.exercises} 个动作的 JSON，并打开系统分享。
                  </Text>
                </View>
              </Card>
            ) : null}
          </>
        )
      ) : (
        <>
          <Card gap={theme.space.sm}>
            <View style={[styles.row, { gap: theme.space.md }]}>
              <IconTile name="folder" size="md" tone="soft" />
              <View style={styles.grow}>
                <Text variant="headline">选择计划文件</Text>
                <Text tone="secondary" variant="footnote">
                  使用来自 Web 或其他 RN 客户端的 openGym 计划 JSON。
                </Text>
              </View>
            </View>
            <Button
              disabled={busy}
              icon="download"
              loading={busy}
              onPress={() => { pickPlan().catch(() => undefined); }}
              testID="plan-share-pick"
              variant="primary"
            >
              选择文件
            </Button>
            <Text tone="secondary" variant="caption">
              只预览，确认后才写入。单个文件最大 20 MB。
            </Text>
          </Card>

          {preview && importFile ? (
            <>
              <SectionHeader
                action={<Badge tone="neutral">{preview.routineCount} 套</Badge>}
                title="导入预览"
              />
              <Card gap={theme.space.sm}>
                <Text variant="headline">{preview.name}</Text>
                <Text tone="secondary" variant="subhead">
                  将新增 {preview.routineCount} 套计划、{preview.exerciseCount} 个动作
                  {preview.scheduledDays > 0 ? `，文件排了 ${preview.scheduledDays} 天` : ''}。
                </Text>
                <View style={[styles.wrap, { gap: theme.space.md }]}>
                  <StatTile
                    detail={preview.customCount > 0 ? `${preview.customCount} 个自定义动作` : '没有自定义动作'}
                    icon="calendar"
                    label="计划"
                    style={{ flexBasis: '45%', flexGrow: 1 }}
                    value={String(preview.routineCount)}
                  />
                  <StatTile
                    detail="含热身、超级组和高级组设置"
                    icon="dumbbell"
                    label="动作"
                    style={{ flexBasis: '45%', flexGrow: 1 }}
                    tone="blue"
                    value={String(preview.exerciseCount)}
                  />
                </View>
                <Divider />
                <ListRow
                  leading={<IconTile name="scale" size="sm" tone="neutral" />}
                  subtitle={unitText(preview)}
                  title="单位"
                  trailing={<Badge tone="neutral">{preview.destinationUnit}</Badge>}
                />
                <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
                <ListRow
                  leading={<IconTile name="calendar" size="sm" tone="neutral" />}
                  subtitle={preview.scheduledDays > 0 ? `文件安排了 ${preview.scheduledDays} 天` : '文件没有周排程'}
                  title="周排程"
                  trailing={<Badge tone={preview.scheduledDays > 0 ? 'accent' : 'neutral'}>
                    {preview.scheduledDays} 天
                  </Badge>}
                />
                <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
                <ListRow
                  leading={<IconTile name="warning" size="sm" tone="orange" />}
                  subtitle="不在动作库、也没有随文件带来的动作会从副本中移除"
                  title="找不到的动作"
                  trailing={<Text variant="headline">{preview.dropped}</Text>}
                />
              </Card>

              {preview.dropped > 0 ? (
                <Card>
                  <View style={[styles.row, { gap: theme.space.sm }]}>
                    <Icon color={theme.colors.warning} name="warning" size={18} />
                    <Text style={styles.grow} tone="secondary" variant="footnote">
                      文件中有 {preview.dropped} 个动作不在当前动作库，也不会随文件带来；导入时会跳过它们。
                    </Text>
                  </View>
                </Card>
              ) : null}

              <SectionHeader title="文件中的计划" />
              <Card padded={false}>
                {preview.routines.map((routine, index) => (
                  <View key={routine.id}>
                    {index > 0 ? (
                      <Divider inset={theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md} />
                    ) : null}
                    <ListRow
                      leading={<IconTile name="dumbbell" size="sm" tone="soft" />}
                      subtitle={`${routine.exerciseCount} 个动作`}
                      title={routine.name}
                    />
                  </View>
                ))}
              </Card>

              {preview.scheduledDays > 0 ? (
                <Card padded={false}>
                  <SwitchRow
                    onValueChange={setAdoptSchedule}
                    subtitle="会替换当前周一至周日安排，文件空白日变成休息日"
                    title="采用文件中的周排程"
                    value={adoptSchedule}
                  />
                </Card>
              ) : null}

              {importDone ? (
                <Card>
                  <View style={[styles.row, { gap: theme.space.sm }]}>
                    <Icon color={theme.colors.accentInk} name="checkCircle" size={20} />
                    <Text style={styles.grow} tone="secondary" variant="footnote">
                      导入已确认：{importDone.routines} 套计划
                      {importDone.schedule ? '，并采用文件周排程' : '，未改动当前周排程'}。
                    </Text>
                  </View>
                  <Button onPress={onClose} variant="primary">完成</Button>
                </Card>
              ) : (
                <>
                  <Button
                    disabled={busy}
                    icon="check"
                    onPress={confirmImport}
                    testID="plan-share-confirm"
                    variant="primary"
                  >
                    {adoptSchedule ? '导入并采用周排程' : '仅导入训练计划'}
                  </Button>
                  <Button onPress={cancelImport} variant="ghost">取消这次导入</Button>
                </>
              )}
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}
