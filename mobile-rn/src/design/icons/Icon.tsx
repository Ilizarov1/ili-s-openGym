/**
 * The one icon component. Every glyph comes from `icon-paths`, drawn on the same
 * 24×24 grid with the same round caps, so nothing looks foreign next to anything
 * else. Icons are decorative by default; pass `accessibilityLabel` only when the
 * icon is the whole control.
 */

import { memo, type ReactElement, type ReactNode } from 'react';
import { Svg } from 'react-native-svg';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { iconPaths, type IconName } from './icon-paths';

// Re-exported so the public surface is `Icon` + `IconName` + `ICON_NAMES`;
// `icon-paths` itself stays internal to the design system.
export { ICON_NAMES } from './icon-paths';
export type { IconName } from './icon-paths';

export type IconProps = {
  name: IconName;
  /** Edge length in points. Default 24. */
  size?: number;
  /** Defaults to the current theme's primary label colour. */
  color?: string;
  /** Default 1.7, matching upstream `--icon-stroke`. */
  strokeWidth?: number;
  style?: StyleProp<ViewStyle>;
  /** When set the icon becomes an image with a name; otherwise it is hidden from a11y. */
  accessibilityLabel?: string;
  testID?: string;
};

export const Icon = memo(function Icon({
  name,
  size = 24,
  color,
  strokeWidth = 1.7,
  style,
  accessibilityLabel,
  testID,
}: IconProps): ReactElement | null {
  const theme = useTheme();
  const tint = color ?? theme.colors.label;
  // A name can arrive from stored data or a server payload, so the guard stays
  // even though the prop type only admits known names.
  const node: ReactNode | undefined = (iconPaths as Record<string, ReactNode | undefined>)[name];
  if (!node) return null;

  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={tint}
      // Filled glyphs ask for `currentColor`; on RN SVG that resolves from `color`.
      color={tint}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      testID={testID}
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel !== undefined ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
    >
      {node}
    </Svg>
  );
});
