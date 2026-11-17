import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { alpha } from '../color';
import { useTheme } from '../ThemeProvider';
import type { Theme, ThemeColors } from '../themes';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';
import type { TextTone, TextVariant } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'tinted' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm' | 'xs';

export type ButtonProps = {
  children: ReactNode;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconPosition?: 'left' | 'right';
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
};

type SizeSpec = {
  minHeight: number;
  paddingVertical: number;
  paddingHorizontal: number;
  borderRadius: number;
  iconSize: number;
  gap: number;
  textVariant: TextVariant;
  textWeight: '600' | undefined;
};

type VariantColors = {
  background: string;
  pressedBackground: string;
  foreground: string;
  tone: TextTone;
};

function sizeSpec(theme: Theme, size: ButtonSize): SizeSpec {
  if (size === 'sm') {
    return {
      minHeight: 34,
      paddingVertical: theme.space.sm,
      paddingHorizontal: 14,
      borderRadius: theme.radius.sm,
      iconSize: 16,
      gap: theme.space.xs,
      textVariant: 'subhead',
      textWeight: '600',
    };
  }
  if (size === 'xs') {
    return {
      minHeight: 28,
      paddingVertical: 5,
      paddingHorizontal: 10,
      borderRadius: theme.radius.xs,
      iconSize: 14,
      gap: theme.space.xxs,
      textVariant: 'footnote',
      textWeight: '600',
    };
  }
  return {
    minHeight: theme.sizes.button,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: theme.radius.lg,
    iconSize: theme.sizes.buttonIcon,
    gap: theme.space.sm,
    textVariant: 'button',
    textWeight: undefined,
  };
}

function variantColors(theme: Theme, variant: ButtonVariant): VariantColors {
  const colors: ThemeColors = theme.colors;
  switch (variant) {
    case 'primary':
      return {
        background: colors.accent,
        pressedBackground: colors.accentPressed,
        foreground: colors.onAccent,
        tone: 'onAccent',
      };
    case 'tinted':
      return {
        background: colors.accentSoft,
        pressedBackground: alpha(colors.accent, 0.24),
        foreground: colors.accentInk,
        tone: 'accent',
      };
    case 'ghost':
      return {
        background: 'transparent',
        pressedBackground: colors.surface2,
        foreground: colors.accentInk,
        tone: 'accent',
      };
    case 'danger':
      return {
        background: alpha(colors.danger, 0.15),
        pressedBackground: alpha(colors.danger, 0.24),
        foreground: colors.danger,
        tone: 'danger',
      };
    default:
      return {
        background: colors.surface2,
        pressedBackground: colors.surface3,
        foreground: colors.label,
        tone: 'label',
      };
  }
}

const styles = StyleSheet.create({
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export function Button({
  children,
  onPress,
  variant = 'secondary',
  size = 'md',
  icon,
  iconPosition = 'left',
  disabled = false,
  loading = false,
  fullWidth,
  style,
  testID,
  accessibilityLabel,
}: ButtonProps) {
  const theme = useTheme();
  const [pressed, setPressed] = useState(false);
  const spec = sizeSpec(theme, size);
  const colors = variantColors(theme, variant);
  const blocked = disabled || loading;
  const stretch = fullWidth ?? size === 'md';

  const handlePressIn = useCallback(() => setPressed(true), []);
  const handlePressOut = useCallback(() => setPressed(false), []);

  // sm/xs controls are shorter than the 44px touch target; grow only vertically so a row of
  // buttons keeps its own hit areas.
  const hitSlop = size === 'sm' ? 5 : size === 'xs' ? 8 : undefined;

  const background = pressed && !disabled ? colors.pressedBackground : colors.background;
  const iconNode =
    icon && !loading ? (
      <Icon name={icon} size={spec.iconSize} color={colors.foreground} />
    ) : null;

  return (
    <PressableScale
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: blocked, busy: loading }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={loading ? undefined : onPress}
      onPressIn={loading ? undefined : handlePressIn}
      onPressOut={loading ? undefined : handlePressOut}
      scaleTo={theme.motion.pressScale}
      style={[
        styles.content,
        {
          minHeight: spec.minHeight,
          paddingVertical: spec.paddingVertical,
          paddingHorizontal: spec.paddingHorizontal,
          borderRadius: spec.borderRadius,
          gap: spec.gap,
          backgroundColor: background,
          alignSelf: stretch ? 'stretch' : 'flex-start',
        },
        style,
      ]}
      testID={testID}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.foreground} />
      ) : iconPosition === 'left' ? (
        iconNode
      ) : null}
      <Text
        numberOfLines={1}
        style={{ flexShrink: 1 }}
        variant={spec.textVariant}
        weight={spec.textWeight}
        tone={colors.tone}
      >
        {children}
      </Text>
      {!loading && iconPosition === 'right' ? iconNode : null}
    </PressableScale>
  );
}
