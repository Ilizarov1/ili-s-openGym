// The exercise detail's media stage: a video clip, an animated GIF, a still, or
// the neutral placeholder. It only renders URLs it is given; downloading,
// authentication and cache lifetime belong to the screen that owns the demo.
//
// The catalogue's clips are short MP4 loops. They play muted and looped with a
// play/pause control, start only while the detail is mounted, pause when the app
// goes to the background, and hand over to the still if the clip cannot load.
// Custom images/GIFs use expo-image; a GIF pauses by switching to its poster.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import type { ImageSource } from 'expo-image';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import { IconButton } from '../components/IconButton';
import { Text } from '../components/Text';

export type ExerciseMediaKind = 'video' | 'gif' | 'image' | 'none';
export type ExerciseMediaSource = string | number;

export type ExerciseMediaProps = {
  kind?: ExerciseMediaKind;
  /** A bundled require() id, a local URI or a remote URL. */
  uri?: ExerciseMediaSource | null;
  /** A still shown while a video loads, after an error, or while a GIF is paused. */
  posterUri?: ExerciseMediaSource | null;
  autoPlay?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
};

/** expo-image accepts a bundled asset id directly; URLs need the object form. */
function imageSource(value: ExerciseMediaSource): ImageSource | number {
  return typeof value === 'number' ? value : { uri: value };
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  poster: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  control: {
    position: 'absolute',
  },
});

export function ExerciseMedia({
  kind = 'none',
  uri,
  posterUri,
  autoPlay = true,
  loading = false,
  style,
  testID,
  accessibilityLabel,
}: ExerciseMediaProps): React.ReactElement {
  const theme = useTheme();
  const [playing, setPlaying] = useState(autoPlay);
  const [failedMain, setFailedMain] = useState<ExerciseMediaSource | null>(null);
  const [failedPoster, setFailedPoster] = useState<ExerciseMediaSource | null>(null);
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    setPlaying(autoPlay);
    setFailedMain(null);
    setFailedPoster(null);
    setVideoFailed(false);
  }, [kind, uri, posterUri, autoPlay]);

  const poster = posterUri && failedPoster !== posterUri ? posterUri : null;
  const mainAvailable = !!uri && failedMain !== uri;
  const videoReady = kind === 'video' && mainAvailable && !videoFailed;
  const gifReady = kind === 'gif' && mainAvailable;
  const imageReady = kind === 'image' && mainAvailable;

  // A GIF that is paused shows its poster; one without a poster has no still
  // to freeze on, so the neutral tile is the honest answer until Play.
  const stillUri = gifReady
    ? (kind === 'gif' && !playing ? poster : null)
    : (kind === 'video' || kind === 'gif' || kind === 'image' ? poster : null);
  const showMainImage = imageReady || (gifReady && playing);
  const showVideo = videoReady;
  const showPlaceholder = !showVideo && !showMainImage && !stillUri;

  const onMainError = useCallback(() => {
    if (uri) setFailedMain(uri);
  }, [uri]);
  const onPosterError = useCallback(() => {
    if (stillUri) setFailedPoster(stillUri);
  }, [stillUri]);
  const onVideoError = useCallback(() => {
    setVideoFailed(true);
    setPlaying(false);
  }, []);

  return (
    <View
      style={[
        styles.container,
        {
          aspectRatio: 4 / 3,
          borderRadius: theme.radius.card,
          backgroundColor: theme.colors.surface2,
        },
        style,
      ]}
      testID={testID}
      accessible={false}
    >
      {showVideo && uri ? (
        <VideoStage
          key={uri}
          accessibilityLabel={accessibilityLabel}
          onError={onVideoError}
          onPlayingChange={setPlaying}
          playing={playing}
          posterUri={poster}
          uri={uri}
        />
      ) : null}

      {!showVideo && showMainImage && uri ? (
        <Image
          accessibilityLabel={accessibilityLabel}
          cachePolicy="memory-disk"
          contentFit="contain"
          onError={onMainError}
          source={imageSource(uri)}
          style={styles.fill}
        />
      ) : null}

      {!showVideo && !showMainImage && stillUri ? (
        <Image
          accessibilityLabel={accessibilityLabel}
          cachePolicy="memory-disk"
          contentFit="contain"
          onError={onPosterError}
          source={imageSource(stillUri)}
          style={[styles.fill, styles.poster]}
        />
      ) : null}

      {showPlaceholder ? (
        <View style={styles.placeholder}>
          <Icon name="dumbbell" size={theme.sizes.tileLg} color={theme.colors.label3} />
          {loading ? (
            <Text style={{ marginTop: theme.space.sm }} tone="tertiary" variant="caption">
              正在加载演示…
            </Text>
          ) : null}
        </View>
      ) : null}

      {(showVideo || (kind === 'gif' && mainAvailable)) ? (
        <View style={[styles.control, { right: theme.space.sm, bottom: theme.space.sm }]}>
          <IconButton
            accessibilityLabel={playing ? '暂停演示' : '播放演示'}
            name={playing ? 'pause' : 'play'}
            onPress={() => setPlaying(value => !value)}
            size="sm"
            testID="exercise-media-toggle"
          />
        </View>
      ) : null}
    </View>
  );
}

type VideoStageProps = {
  uri: ExerciseMediaSource;
  posterUri: ExerciseMediaSource | null;
  playing: boolean;
  onPlayingChange: (playing: boolean) => void;
  onError: () => void;
  accessibilityLabel?: string;
};

function VideoStage({
  uri,
  posterUri,
  playing,
  onPlayingChange,
  onError,
  accessibilityLabel,
}: VideoStageProps): React.ReactElement {
  const theme = useTheme();
  const [firstFrame, setFirstFrame] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const posterRef = useRef(posterUri);
  posterRef.current = posterUri;

  const player = useVideoPlayer(uri, instance => {
    instance.loop = true;
    instance.muted = true;
  });

  useEffect(() => {
    try {
      if (playing) player.play();
      else player.pause();
    } catch {
      // The native player can already be released when a broken clip unmounts.
    }
  }, [player, playing]);

  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status }) => {
      if (status === 'error') onError();
    });
    return () => subscription.remove();
  }, [player, onError]);

  useEffect(() => {
    const subscription = player.addListener('playingChange', ({ isPlaying }) => {
      if (isPlaying) setFirstFrame(true);
      onPlayingChange(isPlaying);
    });
    return () => subscription.remove();
  }, [player, onPlayingChange]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        player.pause();
        onPlayingChange(false);
      }
    });
    return () => subscription.remove();
  }, [player, onPlayingChange]);

  useEffect(() => () => {
    // The hook releases the native player when this unmounts; pausing first
    // makes the hand-off to the still deterministic. A missing/corrupt clip can
    // release the player before this cleanup runs, so never let that throw.
    try { player.pause(); } catch { /* already released */ }
  }, [player]);

  return (
    <View style={styles.fill}>
      <VideoView
        accessibilityLabel={accessibilityLabel}
        contentFit="contain"
        nativeControls={false}
        onFirstFrameRender={() => setFirstFrame(true)}
        player={player}
        style={[
          styles.fill,
          { backgroundColor: theme.colors.surface2 },
        ]}
        surfaceType="textureView"
      />
      {posterRef.current && !posterFailed && !firstFrame ? (
        <Image
          cachePolicy="memory-disk"
          contentFit="contain"
          onError={() => setPosterFailed(true)}
          source={imageSource(posterRef.current)}
          style={styles.fill}
        />
      ) : null}
      {!firstFrame && (!posterRef.current || posterFailed) ? (
        <View style={styles.fill} pointerEvents="none">
          <View style={styles.placeholder}>
            <Icon name="dumbbell" size={theme.sizes.tileLg} color={theme.colors.label3} />
          </View>
        </View>
      ) : null}
    </View>
  );
}
