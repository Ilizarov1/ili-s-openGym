import { useCallback } from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { alpha } from '../color';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
import { PressableScale } from './PressableScale';

export type IconButtonProps = {
  name: IconName;
  onPress?: () => void;
  size?: 'sm' | 'md';
  tone?: 'neutral' | 'accent' | 'danger';
  disabled?: boolean;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export function IconButton({
  name,
  onPress,
  size = 'md',
  tone = 'neutral',
  disabled = false,
  accessibilityLabel,
  style,
  testID,
}: IconButtonProps) {
  const theme = useTheme();
  const diameter = size === 'sm' ? theme.sizes.tileMd : theme.sizes.touch;
  // sm is 36px, so it needs 4px of slop on each side to reach the 44px touch target.
  const hitSlop =
    size === 'sm' ? (theme.sizes.touch - theme.sizes.tileMd) / 2 : undefined;

  const background =
    tone === 'accent'
      ? theme.colors.accentSoft
      : tone === 'danger'
        ? alpha(theme.colors.danger, 0.15)
        : theme.colors.surface2;
  const iconColor =
    tone === 'accent'
      ? theme.colors.accentInk
      : tone === 'danger'
        ? theme.colors.danger
        : theme.colors.label;

  const handlePress = useCallback(() => {
    if (!disabled) onPress?.();
  }, [disabled, onPress]);

  return (
    <PressableScale
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={handlePress}
      scaleTo={theme.motion.pressScaleSmall}
      style={[
        styles.base,
        {
          width: diameter,
          height: diameter,
          borderRadius: theme.radius.pill,
          backgroundColor: background,
        },
        style,
      ]}
      testID={testID}
    >
      <Icon name={name} size={20} color={iconColor} />
    </PressableScale>
  );
}
