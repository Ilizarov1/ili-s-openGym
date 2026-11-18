import { useEffect, useMemo, useState } from 'react';
import { Alert, Modal, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Header,
  IconButton,
  PressableScale,
  Screen,
  SectionHeader,
  Sheet,
  Text,
  TextField,
  useTheme,
} from '../design';
import type { ProfileChange } from '../profileChanges';
import type { Connection } from '../server';
import type { LocalState, PhotoUpload } from '../storage';
import { localDate, type Profile } from '../training';
import {
  PhotoError,
  addPhotoChanges,
  discardPickedPhoto,
  groupProgressPhotos,
  photoCapabilities,
  photoIsPending,
  photoUploadFor,
  pickProgressPhoto,
  progressPhotoTarget,
  progressPhotos,
  removePhotoChange,
  uploadPendingPhotos,
  uploadPhotoFile,
  validPhotoDay,
  type PhotoCapabilities,
  type PickedPhoto,
  type ProgressPhoto,
} from './photos';
import { usePhotoUri } from './usePhotoUri';

export type PhotoSectionProps = {
  profile: Profile;
  connection: Connection | null;
  uploads: PhotoUpload[];
  onCommit: (changes: ProfileChange[]) => void;
  onChangeLocal: (update: (data: LocalState) => LocalState) => void;
};

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  thumb: {
    aspectRatio: 1,
    overflow: 'hidden',
  },
  fill: {
    width: '100%',
    height: '100%',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerBody: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
});

function PhotoThumb({
  photo,
  connection,
  pending,
  onPress,
}: {
  photo: ProgressPhoto;
  connection: Connection | null;
  pending: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const { uri, loading, failed } = usePhotoUri(photo.ref, connection);
  return (
    <PressableScale
      accessibilityLabel={`${photo.d} 的照片${pending ? '，待同步' : ''}`}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.thumb, {
        width: '31%',
        borderRadius: theme.radius.lg,
        backgroundColor: theme.colors.surface2,
      }]}
    >
      {uri ? (
        <Image cachePolicy="memory" contentFit="cover" source={{ uri }} style={styles.fill} />
      ) : (
        <View style={[styles.center, { padding: theme.space.xs }]}>
          <Text align="center" tone="secondary" variant="caption">
            {loading ? '载入中' : failed ? '无法显示' : '照片'}
          </Text>
        </View>
      )}
      {pending ? (
        <View style={{ position: 'absolute', left: theme.space.xs, bottom: theme.space.xs }}>
          <Badge tone="orange">待同步</Badge>
        </View>
      ) : null}
    </PressableScale>
  );
}

function PhotoViewer({
  photo,
  connection,
  onClose,
  onDelete,
}: {
  photo: ProgressPhoto;
  connection: Connection | null;
  onClose: () => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const { uri, loading, failed } = usePhotoUri(photo.ref, connection);
  return (
    <Screen edges={['top', 'bottom', 'left', 'right']} scroll={false} testID="body-photo-viewer">
      <Header
        compact
        onBack={onClose}
        right={<IconButton accessibilityLabel="删除照片" name="trash" onPress={onDelete} size="sm" tone="danger" />}
        subtitle={photo.source === 'workout' ? (photo.workoutName ?? '训练照片') : '当天照片'}
        title={photo.d}
      />
      <View style={[styles.viewerBody, { padding: theme.layout.pagePadding, paddingTop: 0, gap: theme.space.sm }]}>
        {uri ? (
          <Image cachePolicy="memory" contentFit="contain" source={{ uri }} style={styles.fill} />
        ) : (
          <View style={styles.center}>
            <Text align="center" tone="secondary" variant="subhead">
              {loading ? '正在读取照片…' : failed ? '本机文件缺失，服务器也没有可读取的副本。' : '没有可显示的照片。'}
            </Text>
          </View>
        )}
      </View>
    </Screen>
  );
}

/** 进度照片：按日期浏览、选图、上传、全屏查看和删除。 */
export function PhotoSection({ profile, connection, uploads, onCommit, onChangeLocal }: PhotoSectionProps) {
  const theme = useTheme();
  const [capability, setCapability] = useState<PhotoCapabilities | null>(null);
  const [picked, setPicked] = useState<PickedPhoto | null>(null);
  const [pickDate, setPickDate] = useState(localDate(Date.now()));
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [viewer, setViewer] = useState<ProgressPhoto | null>(null);

  useEffect(() => {
    let active = true;
    setCapability(null);
    photoCapabilities(connection).then(value => {
      if (active) setCapability(value);
    }).catch(() => {
      if (active) setCapability({ enabled: true, days: true, workouts: true, imageMB: 2, known: false });
    });
    return () => { active = false; };
  }, [connection]);

  const photos = useMemo(() => progressPhotos(profile), [profile]);
  const groups = useMemo(() => groupProgressPhotos(photos), [photos]);
  const pending = uploads.filter(upload => !upload.uploadedAt);
  const canDay = !connection || capability?.days !== false;
  const canWorkout = !connection || capability?.workouts !== false;
  const mediaEnabled = !connection || capability?.enabled !== false;
  const detecting = !!connection && capability == null;
  const target = picked ? progressPhotoTarget(profile, pickDate, canDay, canWorkout) : null;
  const dateOk = validPhotoDay(pickDate);

  const openPicker = async () => {
    if (busy) return;
    if (detecting) {
      Alert.alert('正在检测实例能力', '请稍等片刻再添加照片。');
      return;
    }
    if (!mediaEnabled) {
      Alert.alert('实例不支持照片', '当前配对实例没有开启媒体上传，照片不会保存到账号。');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      const next = await pickProgressPhoto(connection, capability?.imageMB);
      if (!next) return; // the system picker was cancelled
      setPicked(next);
      setPickDate(next.exifDay ?? localDate(Date.now()));
      setFormError('');
    } catch (error) {
      Alert.alert('无法添加照片', error instanceof PhotoError ? error.message : '照片读取失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  const cancelPick = () => {
    discardPickedPhoto(picked);
    setPicked(null);
    setFormError('');
  };

  const savePick = async () => {
    if (!picked) return;
    if (detecting) {
      setFormError('正在检测实例能力，请稍后重试。');
      return;
    }
    if (!mediaEnabled) {
      Alert.alert('实例不支持照片', '当前配对实例没有开启媒体上传，照片不会保存到账号。');
      return;
    }
    if (!dateOk) {
      setFormError('请选择有效日期，不能晚于今天。');
      return;
    }
    const destination = progressPhotoTarget(profile, pickDate, canDay, canWorkout);
    if (!destination) {
      Alert.alert(
        '实例不支持这天的照片',
        '当前实例只保存训练照片，而这一天没有训练或训练照片已满 6 张。照片没有保存，训练记录也没有改动。',
      );
      return;
    }
    if (photos.some(photo => photo.hash === picked.ref.hash)) {
      setFormError('这张照片已经保存过，不需要重复添加。');
      return;
    }

    setBusy(true);
    try {
      if (connection) {
        const upload = photoUploadFor(picked, pickDate);
        onChangeLocal(data => {
          const current = data.photoUploads ?? [];
          return {
            ...data,
            photoUploads: current.some(item => item.hash === upload.hash)
              ? current
              : [...current, upload],
          };
        });
        try {
          await uploadPhotoFile(connection, upload);
          onChangeLocal(data => ({
            ...data,
            photoUploads: (data.photoUploads ?? []).map(item => item.hash === upload.hash
              ? { ...item, uploadedAt: Date.now(), error: undefined }
              : item),
          }));
          setNotice('照片已上传，引用会随下一次同步写入账号。');
        } catch (error) {
          const message = error instanceof Error ? error.message : '照片上传失败，请稍后重试。';
          onChangeLocal(data => ({
            ...data,
            photoUploads: (data.photoUploads ?? []).map(item => item.hash === upload.hash
              ? { ...item, error: message }
              : item),
          }));
          setNotice('照片已保存在本机；联网后可在照片页重试上传。');
        }
      } else {
        setNotice('照片已保存到本机练习工作区。');
      }
      onCommit(addPhotoChanges(destination, pickDate, picked.ref));
      setPicked(null);
      setFormError('');
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!connection || retrying) return;
    setRetrying(true);
    try {
      const result = await uploadPendingPhotos(connection, { photoUploads: uploads });
      onChangeLocal(data => {
        const current = data.photoUploads ?? [];
        const updated = new Map(result.uploads.map(item => [item.hash, item]));
        return {
          ...data,
          photoUploads: current.map(item => updated.get(item.hash) ?? item),
        };
      });
      setNotice(result.failed
        ? `${result.failed} 张照片仍待上传，请检查网络后重试。`
        : result.uploaded
          ? `${result.uploaded} 张照片已上传。`
          : '没有需要重试的照片。');
    } finally {
      setRetrying(false);
    }
  };

  const confirmDelete = (photo: ProgressPhoto) => {
    Alert.alert(
      '删除这张照片？',
      photo.source === 'day'
        ? `${photo.d} 的这张当天照片会从账号移除。`
        : `这张照片会从「${photo.workoutName ?? '训练'}」移除，训练其他内容不变。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '删除', style: 'destructive', onPress: () => {
          onCommit([removePhotoChange(photo)]);
          onChangeLocal(data => ({
            ...data,
            photoUploads: (data.photoUploads ?? []).filter(item => item.hash !== photo.hash),
          }));
          setViewer(null);
        } },
      ],
    );
  };

  return (
    <>
      <SectionHeader
        action={(
          <Button
            disabled={!mediaEnabled || busy || detecting}
            icon="plus"
            loading={busy}
            onPress={() => { openPicker().catch(() => undefined); }}
            size="xs"
            variant="ghost"
          >
            添加照片
          </Button>
        )}
        title={photos.length > 0 ? `进度照片（${photos.length} 张）` : '进度照片'}
      />

      <Card>
        <Text variant="headline">{connection ? '同步与实例能力' : '本机练习'}</Text>
        <Text tone="secondary" style={{ marginTop: theme.space.xs }} variant="footnote">
          {!connection
            ? '照片保存在本机的练习工作区，不会上传，也不会出现在其他账号。'
            : capability == null
              ? '正在检测实例是否保存照片…'
              : !capability.enabled
                ? '当前实例没有开启媒体上传，无法添加照片。'
                : capability.known === false
                  ? '暂时无法连接实例确认能力；照片会先保存在本机，恢复网络后重试。'
                  : !capability.days
                    ? '当前实例只保存训练照片；没有训练或训练已满 6 张时，不能添加当天照片。'
                    : !capability.workouts
                      ? `实例不保存训练媒体；照片会按日期保存（上限 ${capability.imageMB} MB）。`
                      : `实例照片上限 ${capability.imageMB} MB；有训练空位时附到训练，否则按日期保存。`}
        </Text>
        {pending.length > 0 ? (
          <View style={{ marginTop: theme.space.sm, gap: theme.space.sm }}>
            <View style={[styles.row, { gap: theme.space.sm }]}>
              <View style={styles.grow}>
                <Text tone="secondary" variant="footnote">{`${pending.length} 张照片待上传${pending.some(item => item.error) ? '，有一次上传失败' : ''}`}</Text>
              </View>
              {connection ? (
                <Button loading={retrying} onPress={() => { retry().catch(() => undefined); }} size="sm" variant="secondary">
                  重试上传
                </Button>
              ) : null}
            </View>
            {pending.find(item => item.error)?.error ? (
              <Text tone="danger" variant="caption">{pending.find(item => item.error)?.error}</Text>
            ) : null}
          </View>
        ) : null}
        {notice ? <Text tone="secondary" style={{ marginTop: theme.space.sm }} variant="footnote">{notice}</Text> : null}
      </Card>

      {photos.length === 0 ? (
        <EmptyState
          icon="image"
          text={mediaEnabled
            ? '从系统照片选择器选一张图片，确认日期后会保存在当前工作区。'
            : '当前实例没有开启媒体上传，暂时不能添加照片。'}
          title="还没有进度照片"
        >
          {mediaEnabled ? (
            <Button disabled={detecting} icon="plus" loading={busy} onPress={() => { openPicker().catch(() => undefined); }} variant="primary">
              添加照片
            </Button>
          ) : null}
        </EmptyState>
      ) : groups.map(group => (
        <View key={group.d} style={{ gap: theme.space.sm, marginBottom: theme.space.lg }}>
          <SectionHeader title={group.d} />
          <View style={[styles.grid, { gap: theme.space.sm }]}>
            {group.photos.map(photo => (
              <PhotoThumb
                connection={connection}
                key={`${photo.source}:${photo.workoutKey ?? ''}:${photo.hash}`}
                onPress={() => setViewer(photo)}
                pending={photoIsPending(uploads, photo.hash)}
                photo={photo}
              />
            ))}
          </View>
        </View>
      ))}

      <Sheet
        footer={(
          <View style={{ gap: theme.space.sm }}>
            <Button disabled={busy || !target || !dateOk} loading={busy} onPress={() => { savePick().catch(() => undefined); }} variant="primary">
              保存照片
            </Button>
            <Button disabled={busy} onPress={cancelPick} variant="ghost">取消</Button>
          </View>
        )}
        onClose={cancelPick}
        title="确认照片日期"
        visible={picked != null}
      >
        {picked ? (
          <View style={{ gap: theme.space.md }}>
            <Image
              cachePolicy="memory"
              contentFit="cover"
              source={{ uri: picked.uri }}
              style={{ width: '100%', height: 180, borderRadius: theme.radius.lg, backgroundColor: theme.colors.surface2 }}
            />
            <TextField
              autoCapitalize="none"
              error={formError || (dateOk ? undefined : '请选择有效日期，不能晚于今天。')}
              keyboardType="numbers-and-punctuation"
              label="照片日期"
              onChangeText={setPickDate}
              placeholder="YYYY-MM-DD"
              value={pickDate}
            />
            <Text tone="secondary" variant="footnote">
              {target?.kind === 'workout'
                ? `会附到当天最近一次训练「${target.name}」的媒体列表（最多 6 个）。`
                : target?.kind === 'day'
                  ? '当天没有可用训练媒体位，会按日期保存为进度照片。'
                  : '当前实例不支持这天的照片，保存按钮不可用。'}
            </Text>
            {connection && capability && !capability.days ? (
              <Badge tone="orange">实例不保存按日照片</Badge>
            ) : null}
            {connection && capability?.known === false ? (
              <Badge tone="orange">实例能力未知</Badge>
            ) : null}
            <Text tone="secondary" variant="footnote">
              保存前会重新编码并校验文件；取消选图不会新增引用。
            </Text>
          </View>
        ) : null}
      </Sheet>

      <Modal onRequestClose={() => setViewer(null)} statusBarTranslucent visible={viewer != null}>
        {viewer ? (
          <PhotoViewer
            connection={connection}
            onClose={() => setViewer(null)}
            onDelete={() => confirmDelete(viewer)}
            photo={viewer}
          />
        ) : null}
      </Modal>
    </>
  );
}
