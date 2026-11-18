/**
 * Settings → 扫描配对二维码.
 *
 * The screen requests the camera only when it opens, scans QR codes only, and stops
 * scanning as soon as one is read. Nothing is redeemed until the person confirms;
 * cancelling leaves the one-time code unused. The actual connect (and its expired /
 * used / invalid-code errors) stays in the App and `useGym`.
 */

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  Badge,
  Button,
  Card,
  Header,
  Icon,
  IconTile,
  Screen,
  Text,
  useTheme,
} from '../design';
import { parsePairingUrl, type PairingTarget } from '../pairing/pairing';

export type QrPairScreenProps = {
  onClose: () => void;
  onConfirm: (address: string, code: string) => void;
  busy?: boolean;
  error?: string;
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
});

function addressIsLanHttp(address: string): boolean {
  return address.toLowerCase().startsWith('http://');
}

export function QrPairScreen({ onClose, onConfirm, busy = false, error }: QrPairScreenProps) {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [target, setTarget] = useState<PairingTarget | null>(null);
  const [scanError, setScanError] = useState('');
  const [cameraError, setCameraError] = useState('');
  const [scanning, setScanning] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [errorHidden, setErrorHidden] = useState(false);
  const scanLock = useRef(false);
  const confirmLock = useRef(false);

  // The permission prompt belongs to opening this screen, not to app start.
  useEffect(() => {
    if (permission?.status === 'undetermined' && permission.canAskAgain) {
      requestPermission().catch(() => undefined);
    }
  }, [permission, requestPermission]);

  // A failed connect leaves the one-shot confirmation spent: the next step is a
  // rescan, not another tap on the same code.
  useEffect(() => {
    if (error) setConfirming(false);
  }, [error]);

  const reset = () => {
    scanLock.current = false;
    confirmLock.current = false;
    setTarget(null);
    setScanError('');
    setCameraError('');
    setConfirming(false);
    setErrorHidden(true);
    setScanning(true);
  };

  const handleScan = (data: string) => {
    if (scanLock.current || target) return;
    scanLock.current = true;
    setScanning(false);
    const parsed = parsePairingUrl(data);
    if (parsed.ok) {
      setScanError('');
      setTarget(parsed.target);
    } else {
      setScanError(parsed.message);
    }
  };

  const confirm = () => {
    if (!target || busy || confirming || confirmLock.current) return;
    confirmLock.current = true;
    setConfirming(true);
    setErrorHidden(false);
    onConfirm(target.address, target.code);
  };

  const askAgain = () => {
    void requestPermission().catch(() => undefined);
  };

  const cameraVisible = permission?.granted === true && scanning && !target && !scanError && !cameraError;
  const message = error || '';

  return (
    <Screen testID="qr-pair-screen">
      <Header
        compact
        onBack={onClose}
        subtitle="扫描网页端生成的移动端配对二维码"
        title="扫描配对二维码"
      />

      {message && target && !errorHidden ? (
        <Card>
          <View style={[styles.row, { gap: theme.space.sm }]}>
            <Icon color={theme.colors.danger} name="warning" size={18} />
            <Text
              accessibilityLiveRegion="polite"
              style={styles.grow}
              tone="danger"
              variant="footnote"
            >
              {message}
            </Text>
          </View>
        </Card>
      ) : null}

      {permission === null ? (
        <Card gap={theme.space.md}>
          <View style={[styles.centerRow, { gap: theme.space.sm }]}>
            <ActivityIndicator color={theme.colors.accent} />
            <Text tone="secondary" variant="subhead">正在准备相机…</Text>
          </View>
        </Card>
      ) : null}

      {permission && !permission.granted ? (
        <Card gap={theme.space.md}>
          <View style={[styles.row, { gap: theme.space.md }]}>
            <IconTile name="camera" size="md" tone="neutral" />
            <View style={styles.grow}>
              <Text variant="headline">需要相机权限</Text>
              <Text tone="secondary" variant="subhead">
                只用于扫描二维码，不会拍照或上传。拒绝后仍可返回设置，手动输入服务器地址和配对码。
              </Text>
            </View>
          </View>
          {permission.canAskAgain ? (
            <Button icon="camera" onPress={askAgain} variant="primary">允许使用相机</Button>
          ) : (
            <Button
              icon="gear"
              onPress={() => { void Linking.openSettings().catch(() => undefined); }}
              variant="primary"
            >
              打开系统设置
            </Button>
          )}
          <Button onPress={onClose} variant="ghost">返回手动配对</Button>
        </Card>
      ) : null}

      {cameraVisible ? (
        <>
          <Card padded={false}>
            <CameraView
              active
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              facing="back"
              onBarcodeScanned={scanning ? result => handleScan(result.data) : undefined}
              onMountError={event => {
                setCameraError(event.message || '相机无法启动。');
                setScanning(false);
              }}
              style={{ width: '100%', aspectRatio: 1 }}
            />
          </Card>
          <Card>
            <View style={[styles.row, { gap: theme.space.md }]}>
              <IconTile name="qr" size="md" tone="soft" />
              <View style={styles.grow}>
                <Text variant="headline">把二维码放进取景框</Text>
                <Text tone="secondary" variant="footnote">
                  在已登录的网页端打开账号设置，选择「配对移动应用」并生成二维码。只扫描 openGym 配对码。
                </Text>
              </View>
            </View>
          </Card>
        </>
      ) : null}

      {cameraError ? (
        <Card gap={theme.space.md}>
          <View style={[styles.row, { gap: theme.space.sm }]}>
            <Icon color={theme.colors.danger} name="warning" size={18} />
            <Text style={styles.grow} tone="danger" variant="footnote">{cameraError}</Text>
          </View>
          <Button icon="reset" onPress={reset} variant="primary">重新打开相机</Button>
          <Button onPress={onClose} variant="ghost">返回手动配对</Button>
        </Card>
      ) : null}

      {scanError ? (
        <Card gap={theme.space.md}>
          <View style={[styles.row, { gap: theme.space.sm }]}>
            <Icon color={theme.colors.danger} name="warning" size={18} />
            <Text style={styles.grow} tone="danger" variant="footnote">{scanError}</Text>
          </View>
          <Button icon="qr" onPress={reset} variant="primary">重新扫描</Button>
          <Button onPress={onClose} variant="ghost">返回手动配对</Button>
        </Card>
      ) : null}

      {target ? (
        <>
          <Card gap={theme.space.sm}>
            <View style={[styles.centerRow, { justifyContent: 'space-between', gap: theme.space.sm }]}>
              <View style={[styles.centerRow, { gap: theme.space.sm }]}>
                <IconTile name="cloud" size="md" tone="soft" />
                <View>
                  <Text variant="headline">确认连接服务器</Text>
                  <Text tone="secondary" variant="footnote">确认前不会兑换配对码。</Text>
                </View>
              </View>
              <Badge tone={addressIsLanHttp(target.address) ? 'orange' : 'accent'}>
                {addressIsLanHttp(target.address) ? '局域网 HTTP' : 'HTTPS'}
              </Badge>
            </View>

            <Text selectable tone="secondary" variant="footnote">服务器地址</Text>
            <Text selectable variant="body">{target.address}</Text>
            <Text selectable tone="secondary" variant="footnote">配对码</Text>
            <Text selectable style={{ letterSpacing: 2 }} variant="title3">{target.code}</Text>

            {addressIsLanHttp(target.address) ? (
              <View style={[styles.row, { gap: theme.space.xs }]}>
                <Icon color={theme.colors.warning} name="warning" size={16} />
                <Text style={styles.grow} tone="secondary" variant="footnote">
                  当前使用局域网 HTTP，配对码和连接令牌将以明文传输。
                </Text>
              </View>
            ) : null}
          </Card>

          {confirming || busy ? (
            <Card>
              <View style={[styles.centerRow, { gap: theme.space.sm }]}>
                <ActivityIndicator color={theme.colors.accent} />
                <Text tone="secondary" variant="subhead">正在连接服务器…</Text>
              </View>
            </Card>
          ) : null}

          <Button
            disabled={busy || confirming || (!!message && !errorHidden)}
            icon="plug"
            loading={busy || confirming}
            onPress={confirm}
            testID="qr-pair-confirm"
            variant="primary"
          >
            {message && !errorHidden ? '连接失败，请重新扫描' : '确认连接'}
          </Button>
          <Button disabled={busy} onPress={reset} variant="secondary">重新扫描</Button>
          <Button disabled={busy} onPress={onClose} variant="ghost">取消</Button>
          <Text tone="secondary" variant="caption">
            确认后会立即使用这枚一次性配对码；取消不会消耗它。连接失败时可重新扫描或返回设置手动输入。
          </Text>
        </>
      ) : null}
    </Screen>
  );
}
