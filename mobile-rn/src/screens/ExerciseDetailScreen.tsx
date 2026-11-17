import { useEffect, useMemo, useRef } from 'react';
import { Alert, BackHandler, Linking, View } from 'react-native';
import {
  Badge,
  Button,
  Card,
  ExerciseMedia,
  Header,
  IconButton,
  IconTile,
  ListRow,
  MediaThumb,
  Screen,
  Text,
  useTheme,
} from '../design';
import { bodyPartName, catalogueContent, catalogueExercise, equipmentName } from '../catalogue';
import { customExerciseLink, useExerciseMedia } from '../exerciseMedia';
import type { Connection } from '../server';
import { exerciseName, type Profile } from '../training';

export type ExerciseDetailScreenProps = {
  profile: Profile;
  connection: Connection | null;
  server: string | null;
  exerciseId: string;
  custom: boolean;
  onBack: () => void;
  onPick: () => void;
  onFavorite: (id: string, favourite: boolean) => void;
};

function subtitleOf(bodyPart?: string, equipment?: string, fallback = '自建动作') {
  const parts: string[] = [];
  if (bodyPart) parts.push(bodyPartName(bodyPart));
  if (equipment) parts.push(equipmentName(equipment));
  return parts.length > 0 ? parts.join(' · ') : fallback;
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function ExerciseDetailScreen({
  profile,
  connection,
  server,
  exerciseId,
  custom,
  onBack,
  onPick,
  onFavorite,
}: ExerciseDetailScreenProps) {
  const theme = useTheme();
  const customExercise = custom
    ? (profile.customEx ?? []).find(exercise => exercise?.id === exerciseId)
    : undefined;
  const catalogue = custom ? null : catalogueExercise(exerciseId);
  const name = exerciseName(profile, exerciseId);
  const subtitle = custom
    ? subtitleOf(customExercise?.bp, customExercise?.eq)
    : subtitleOf(catalogue?.bp, catalogue?.eq, '内置动作');
  const favourite = (Array.isArray(profile.favEx) ? profile.favEx : []).includes(exerciseId);
  const link = custom ? customExerciseLink(customExercise) : null;
  const note = (customExercise?.desc ?? customExercise?.note ?? '').trim();
  const content = custom ? null : catalogueContent(exerciseId);
  const description = content?.description ?? '';
  const instructions = content?.instructions ?? [];
  const media = useExerciseMedia({ profile, connection, server, exerciseId, custom });
  const backRef = useRef(onBack);
  backRef.current = onBack;

  // Android's back button returns to the list (and stops the demo) before the
  // app-level panel/tab handler sees it.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      backRef.current();
      return true;
    });
    return () => subscription.remove();
  }, []);

  const message = useMemo(() => {
    if (media.loading) return '正在加载演示…';
    if (media.unavailable === 'practice') return '练习模式没有服务器，演示以占位显示；仍可选择这个动作。';
    if (media.unavailable === 'disabled') return '当前服务器未开启媒体功能或暂时无法访问，仍可选择这个动作。';
    if (media.unavailable === 'missing') return custom ? '这个动作还没有上传演示媒体。' : '服务器没有这个动作的演示素材。';
    if (media.unavailable === 'failed') return '演示加载失败，已按可用静图或占位显示；仍可选择这个动作。';
    if (!media.uri && media.posterUri) return '媒体未能加载，正在显示封面。';
    return null;
  }, [custom, media]);

  const toggleFavourite = () => onFavorite(exerciseId, !favourite);

  const openLink = () => {
    if (!link) return;
    void Linking.openURL(link).catch(() => {
      Alert.alert('无法打开链接', '请检查链接或网络后重试。');
    });
  };

  return (
    <Screen testID="exercise-detail-screen">
      <Header
        compact
        onBack={onBack}
        right={(
          <IconButton
            accessibilityLabel={favourite ? `取消收藏 ${name}` : `收藏 ${name}`}
            name={favourite ? 'starFill' : 'star'}
            onPress={toggleFavourite}
            testID="exercise-detail-favourite"
            tone={favourite ? 'accent' : 'neutral'}
          />
        )}
        title="动作详情"
      />

      <Card padded={false}>
        <ListRow
          leading={(
            <MediaThumb
              exerciseId={exerciseId}
              radius={theme.radius.lg}
              server={custom ? null : server}
              size={56}
            />
          )}
          subtitle={subtitle}
          testID="exercise-detail-row"
          title={name}
          trailing={<Badge tone={custom ? 'neutral' : 'accent'}>{custom ? '自建' : '内置'}</Badge>}
        />
      </Card>

      {description ? (
        <Card style={{ marginTop: theme.space.md }}>
          <Text variant="headline">动作介绍</Text>
          <Text style={{ marginTop: theme.space.xs }} tone="secondary" variant="subhead">
            {description}
          </Text>
          {content?.target ? (
            <Text style={{ marginTop: theme.space.sm }} tone="tertiary" variant="footnote">
              {`目标肌群：${content.target}${content.secondary?.length ? ` · 协同：${content.secondary.join('、')}` : ''}`}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {instructions.length > 0 ? (
        <Card style={{ marginTop: theme.space.md }}>
          <Text variant="headline">执行步骤</Text>
          {content?.instructionsSource === 'en' ? (
            <Text style={{ marginTop: theme.space.xs }} tone="tertiary" variant="footnote">
              该动作步骤暂无中文翻译，显示英文原文。
            </Text>
          ) : null}
          {instructions.map((step: string, index: number) => (
            <Text key={step} style={{ marginTop: theme.space.sm }} tone="secondary" variant="subhead">
              {`${index + 1}. ${step}`}
            </Text>
          ))}
        </Card>
      ) : null}

      <ExerciseMedia
        accessibilityLabel={`${name} 演示`}
        kind={media.kind}
        loading={media.loading}
        posterUri={media.posterUri}
        style={{ marginTop: theme.space.lg }}
        testID="exercise-detail-media"
        uri={media.uri}
      />

      {message ? (
        <Text style={{ marginTop: theme.space.sm }} tone="secondary" variant="footnote">
          {message}
        </Text>
      ) : null}

      {note ? (
        <Card style={{ marginTop: theme.space.md }}>
          <Text tone="secondary" variant="subhead">
            {note}
          </Text>
        </Card>
      ) : null}

      {link ? (
        <View style={{ marginTop: theme.space.md }}>
          <Card padded={false}>
            <ListRow
              chevron
              leading={<IconTile name="link" size="md" tone="blue" />}
              onPress={openLink}
              subtitle={hostOf(link)}
              testID="exercise-detail-link"
              title="打开外部链接"
            />
          </Card>
        </View>
      ) : null}

      <Button
        icon="plus"
        onPress={onPick}
        style={{ marginTop: theme.space.lg }}
        testID="exercise-detail-pick"
        variant="primary"
      >
        选择这个动作
      </Button>
    </Screen>
  );
}
