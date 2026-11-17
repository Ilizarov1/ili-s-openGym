// Exercise still thumbnail, ported from frontend/src/components/Media.jsx.
// Images are not bundled; they come from the paired server and stay in expo-image's cache.

import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { EXALIAS } from '../../../../frontend/src/lib/exercises-data.js';
import { Icon } from '../icons/Icon';
import { useTheme } from '../ThemeProvider';

export type MediaThumbProps = {
  exerciseId: string;
  /** Paired server base URL; when absent the neutral placeholder is shown. */
  server?: string | null;
  size?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

// Upstream exports this alias table as JSON.parse output, so its type is unknown.
const exerciseAliases = EXALIAS as Record<string, string>;

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
});

export function MediaThumb({
  exerciseId,
  server,
  size = 56,
  radius = 10,
  style,
  testID,
}: MediaThumbProps): React.ReactElement {
  const theme = useTheme();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [exerciseId, server]);

  const url = useMemo(() => {
    const base = server?.trim().replace(/\/+$/, '') ?? '';
    if (!base || !exerciseId) return null;
    const canonicalId = exerciseAliases[exerciseId] ?? exerciseId;
    return `${base}/exercise-media/still/${canonicalId}.webp`;
  }, [exerciseId, server]);

  const showPlaceholder = url === null || failed;

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          width: size,
          height: size,
          borderRadius: radius,
          backgroundColor: theme.colors.surface2,
        },
        style,
      ]}
      accessible={false}
    >
      {showPlaceholder ? (
        <Icon
          name="dumbbell"
          size={Math.max(16, Math.round(size * 0.38))}
          color={theme.colors.label3}
        />
      ) : (
        <Image
          source={{ uri: url }}
          style={[styles.image, { borderRadius: radius }]}
          contentFit="cover"
          cachePolicy="memory-disk"
          onError={() => setFailed(true)}
          accessible={false}
        />
      )}
    </View>
  );
}
