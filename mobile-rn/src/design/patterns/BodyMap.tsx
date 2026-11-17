// Front and back muscle maps, ported from frontend/src/components/BodyMap.jsx.
// Geometry and muscle semantics are reused from the upstream lib files instead of copied.

import React, { useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import bodyPathsRaw from '../../../../frontend/src/lib/body-paths.js';
import { INERT, MUSCLES, levelsOf } from '../../../../frontend/src/lib/muscles.js';
import { mix } from '../color';
import { useTheme } from '../ThemeProvider';

export type BodyKind = 'male' | 'female';
export type BodyLoad = Record<string, number>;
export type BodyMapVariant = 'full' | 'mini';

export type BodyMapProps = {
  /** Effective sets per muscle slug. */
  load?: BodyLoad;
  /** Ready-made 0..4 steps; takes precedence over load. */
  levels?: BodyLoad;
  body?: BodyKind;
  /** Height of each view. Defaults to min(340, window height * 0.46). */
  height?: number;
  /** Mini renders the 46px thumbnail treatment used by plan rows. */
  variant?: BodyMapVariant;
  style?: StyleProp<ViewStyle>;
};

type BodyViewData = {
  vb: string;
  p: Record<string, string[]>;
};

type BodyPaths = Record<BodyKind, { front: BodyViewData; back: BodyViewData }>;

// The upstream module is generated JSON exported from JS, so its path dictionary
// has no usable index signature. Pin the shape once here.
const bodyPaths = bodyPathsRaw as unknown as BodyPaths;

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
  },
  placeholder: {
    overflow: 'hidden',
  },
});

function parseViewBox(vb: string): { width: number; height: number } | null {
  const parts = vb.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4) return null;
  const [, , width, height] = parts;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function viewWidth(view: BodyViewData, height: number): number {
  const box = parseViewBox(view.vb);
  return box ? (height * box.width) / box.height : height * 0.56;
}

function MuscleView({
  view,
  height,
  levels,
  fills,
  silhouetteFill,
  stroke,
  strokeWidth,
}: {
  view: BodyViewData;
  height: number;
  levels: BodyLoad;
  fills: readonly string[];
  silhouetteFill: string;
  stroke: string;
  strokeWidth: number;
}): React.ReactElement {
  return (
    <Svg viewBox={view.vb} width={viewWidth(view, height)} height={height}>
      {INERT.map(slug =>
        (view.p[slug] ?? []).map((d, index) => (
          <Path
            key={`${slug}-${index}`}
            d={d}
            fill={silhouetteFill}
            stroke={stroke}
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
          />
        )),
      )}
      {MUSCLES.map(slug =>
        (view.p[slug] ?? []).map((d, index) => {
          const level = Math.max(0, Math.min(4, Math.round(levels[slug] ?? 0)));
          return (
            <Path
              key={`${slug}-${index}`}
              d={d}
              fill={fills[level] ?? fills[0]}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeLinejoin="round"
            />
          );
        }),
      )}
    </Svg>
  );
}

export function BodyMap({
  load = {},
  levels: givenLevels,
  body = 'male',
  height,
  variant = 'full',
  style,
}: BodyMapProps): React.ReactElement {
  const theme = useTheme();
  const window = useWindowDimensions();
  const mini = variant === 'mini';
  const viewHeight = height ?? (mini ? 46 : Math.min(340, window.height * 0.46));
  const levels = useMemo<BodyLoad>(
    () => givenLevels ?? (levelsOf(load) as BodyLoad),
    [givenLevels, load],
  );

  const { fills, silhouetteFill, stroke, strokeWidth } = useMemo(() => {
    const base = mix(theme.colors.label, theme.colors.surface, mini ? 0.26 : 0.11);
    return {
      fills: [
        base,
        mix(theme.colors.accent, base, 0.32),
        mix(theme.colors.accent, base, 0.56),
        mix(theme.colors.accent, base, 0.78),
        theme.colors.accent,
      ],
      silhouetteFill: mix(theme.colors.label, theme.colors.surface, mini ? 0.34 : 0.18),
      stroke: theme.colors.surface,
      strokeWidth: mini ? 3 : 2.5,
    };
  }, [mini, theme.colors.accent, theme.colors.label, theme.colors.surface]);

  const group = bodyPaths[body];

  if (!group?.front?.vb || !group.front.p || !group.back?.vb || !group.back.p) {
    return (
      <View
        style={[
          styles.placeholder,
          {
            height: viewHeight,
            width: Math.max(24, viewHeight * (mini ? 0.95 : 0.9)),
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surface2,
          },
          style,
        ]}
        accessibilityRole="image"
        accessibilityLabel="肌群负荷图"
      />
    );
  }

  return (
    <View
      style={[styles.container, { gap: theme.space.xxs }, style]}
      accessibilityRole="image"
      accessibilityLabel="肌群负荷图"
    >
      <MuscleView
        view={group.front}
        height={viewHeight}
        levels={levels}
        fills={fills}
        silhouetteFill={silhouetteFill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
      <MuscleView
        view={group.back}
        height={viewHeight}
        levels={levels}
        fills={fills}
        silhouetteFill={silhouetteFill}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    </View>
  );
}
