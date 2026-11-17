/**
 * 设置面板：服务器连接、配对、同步、备份、休息通知和开发入口。
 *
 * 页面只负责布局和本地表单状态；配对、同步、断开、备份、合并、通知权限都由 App
 * 通过回调执行，本页不直接调用 `useGym`、`server.ts` 或存储层。
 */

import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
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
  SwitchRow,
  Text,
  TextField,
  useTheme,
} from '../design';
import type { Connection } from '../server';

export type SettingsOperation = 'pair' | 'sync' | 'disconnect' | null;

export type SettingsScreenProps = {
  connection: Connection | null;
  pending: number;
  lastSync: number | null;
  operation: SettingsOperation;
  restAlerts: boolean;
  onClose: () => void;
  onConnect: (address: string, code: string) => void;
  onSync: () => void;
  onDisconnect: () => void;
  onExport: () => void;
  onRestore: () => void;
  onMergePractice: () => void;
  onToggleRestAlerts: () => void;
  onOpenAlarmSettings: () => void;
  onOpenGallery: () => void;
  /** 来自 `useGym` 的错误提示，例如同步失败。 */
  notice?: string;
  /** 休息通知权限或调度错误。 */
  restAlertError?: string;
  /** App 正在执行备份/恢复等数据操作，期间禁用这些行。 */
  busy?: boolean;
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  warning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
});

function clockOf(time: number) {
  const date = new Date(time);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function SettingsScreen({
  connection,
  pending,
  lastSync,
  operation,
  restAlerts,
  onClose,
  onConnect,
  onSync,
  onDisconnect,
  onExport,
  onRestore,
  onMergePractice,
  onToggleRestAlerts,
  onOpenAlarmSettings,
  onOpenGallery,
  notice,
  restAlertError,
  busy = false,
}: SettingsScreenProps) {
  const theme = useTheme();
  const [address, setAddress] = useState(connection?.server ?? '');
  const [code, setCode] = useState('');
  const [reconnecting, setReconnecting] = useState(false);

  // 配对成功后收起表单，并换上服务器地址；断开时保留地址方便重新连接。
  useEffect(() => {
    if (!connection) return;
    setAddress(connection.server);
    setCode('');
    setReconnecting(false);
  }, [connection]);

  const working = busy || operation !== null;
  const pairing = connection == null || reconnecting;
  const insecure = address.trim().toLowerCase().startsWith('http://');
  const pendingLabel = `${pending} 条待同步`;
  const syncLabel = operation === 'sync' ? '正在同步…' : '立即同步';
  const message = notice || restAlertError || '';
  const dividerInset = theme.layout.listRowPaddingX + theme.sizes.tileSm + theme.space.md;

  return (
    <Screen testID="settings-screen">
      <Header compact onBack={onClose} title="设置" />
      {message ? (
        <Text
          accessibilityLiveRegion="polite"
          style={{ marginBottom: theme.space.md }}
          tone="danger"
          variant="footnote"
        >
          {message}
        </Text>
      ) : null}

      <Card>
        <View style={[styles.row, { gap: theme.space.md }]}>
          <IconTile name={connection ? 'cloud' : 'cloudSlash'} size="md" tone={connection ? 'soft' : 'neutral'} />
          <View style={styles.grow}>
            <Text numberOfLines={1} variant="headline">
              {connection ? connection.user.name : '本机练习'}
            </Text>
            <Text numberOfLines={1} tone="secondary" variant="footnote">
              {connection ? connection.server : '未连接服务器，训练只保存在本机。'}
            </Text>
          </View>
          <Badge tone={connection ? 'accent' : 'neutral'}>{connection ? '已连接' : '本机'}</Badge>
        </View>
        {connection ? (
          <>
            <Divider />
            <View style={[styles.row, { justifyContent: 'space-between', gap: theme.space.sm }]}>
              <Text tone="secondary" variant="footnote">待同步</Text>
              <Text tone={pending > 0 ? 'label' : 'secondary'} variant="footnote">{pendingLabel}</Text>
            </View>
            <View style={[styles.row, { justifyContent: 'space-between', gap: theme.space.sm }]}>
              <Text tone="secondary" variant="footnote">上次同步</Text>
              <Text tone="secondary" variant="footnote">{lastSync ? clockOf(lastSync) : '尚未同步'}</Text>
            </View>
          </>
        ) : null}
      </Card>

      {connection ? (
        <Card padded={false}>
          <ListRow
            chevron
            disabled={working}
            leading={<IconTile name="repeat" size="sm" tone="soft" />}
            onPress={onSync}
            subtitle={operation === 'sync' ? '正在把本机记录同步到服务器' : '把本机记录同步到服务器'}
            title={syncLabel}
            trailing={operation === 'sync' ? <ActivityIndicator color={theme.colors.accent} /> : undefined}
          />
          <Divider inset={dividerInset} />
          <ListRow
            chevron
            disabled={working}
            leading={<IconTile name="qr" size="sm" tone="neutral" />}
            onPress={() => setReconnecting(!reconnecting)}
            subtitle={reconnecting ? '收起配对表单' : '用新的配对码连接同一个账号'}
            title={reconnecting ? '取消重新配对' : '重新配对'}
          />
          <Divider inset={dividerInset} />
          <ListRow
            chevron
            disabled={working}
            leading={<IconTile name="signOut" size="sm" tone="neutral" />}
            onPress={onDisconnect}
            subtitle="本机保留这个账号的数据"
            title="断开连接"
          />
        </Card>
      ) : null}

      {pairing ? (
        <Card>
          <Text variant="headline">配对自托管实例</Text>
          <Text tone="secondary" variant="subhead">
            在已登录的网页端打开账号设置，生成移动端配对码。
          </Text>
          <TextField
            autoCapitalize="none"
            autoCorrect={false}
            editable={!working}
            keyboardType="url"
            label="服务器地址"
            onChangeText={setAddress}
            placeholder="https://gym.example.com"
            value={address}
          />
          {insecure ? (
            <View style={[styles.warning, { gap: theme.space.xs }]}>
              <Icon color={theme.colors.warning} name="warning" size={16} />
              <Text style={styles.grow} tone="secondary" variant="footnote">
                当前使用局域网 HTTP，配对码和连接令牌将以明文传输。
              </Text>
            </View>
          ) : null}
          <TextField
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!working}
            label="配对码"
            onChangeText={setCode}
            value={code}
          />
          <Button
            disabled={working || !address.trim() || !code.trim()}
            icon="plug"
            loading={operation === 'pair'}
            onPress={() => onConnect(address, code)}
            variant="primary"
          >
            连接服务器
          </Button>
          {connection && reconnecting ? (
            <Button onPress={() => setReconnecting(false)} variant="ghost">取消</Button>
          ) : null}
        </Card>
      ) : null}

      <SectionHeader style={{ marginTop: theme.space.sm }} title="备份与数据" />
      <Card padded={false}>
        <ListRow
          chevron
          disabled={working}
          leading={<IconTile name="share" size="sm" tone="soft" />}
          onPress={onExport}
          subtitle="保存一份可恢复的 JSON 备份"
          title="导出备份"
        />
        <Divider inset={dividerInset} />
        <ListRow
          chevron
          disabled={working}
          leading={<IconTile name="download" size="sm" tone="neutral" />}
          onPress={onRestore}
          subtitle="从备份文件合并训练和计划"
          title="恢复备份"
        />
        {connection ? (
          <>
            <Divider inset={dividerInset} />
            <ListRow
              chevron
              disabled={working}
              leading={<IconTile name="merge" size="sm" tone="neutral" />}
              onPress={onMergePractice}
              subtitle="把未配对的训练合并到当前账号"
              title="合并本机练习"
            />
          </>
        ) : null}
      </Card>

      <SectionHeader style={{ marginTop: theme.space.sm }} title="通知" />
      <Card padded={false}>
        <SwitchRow
          disabled={working}
          onValueChange={() => onToggleRestAlerts()}
          subtitle="每组休息结束时提醒"
          title="组间休息通知"
          value={restAlerts}
        />
        {restAlerts ? (
          <>
            <Divider inset={theme.layout.listRowPaddingX} />
            <ListRow
              chevron
              disabled={working}
              leading={<IconTile name="timer" size="sm" tone="orange" />}
              onPress={onOpenAlarmSettings}
              subtitle="允许精确闹钟，提醒才能准时"
              title="闹钟与提醒设置"
            />
          </>
        ) : null}
      </Card>

      {__DEV__ ? (
        <>
          <SectionHeader style={{ marginTop: theme.space.sm }} title="开发" />
          <Card padded={false}>
            <ListRow
              chevron
              leading={<IconTile name="palette" size="sm" tone="neutral" />}
              onPress={onOpenGallery}
              subtitle="组件、token 与主题预览"
              title="设计系统预览"
            />
          </Card>
        </>
      ) : null}
    </Screen>
  );
}
