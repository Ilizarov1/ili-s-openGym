import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type ChipProps = {
  children: ReactNode;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  size?: 'md' | 'sm';
  tone?: 'accent' | 'neutral';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
  },
});

export function Chip({
  children,
  selected = false,
  onPress,
  icon,
  size = 'md',
  tone = 'accent',
  disabled = false,
  style,
  testID,
}: ChipProps) {
  const theme = useTheme();
  const small = size === 'sm';
  const accentSelected = selected && tone === 'accent';

  const background = selected
    ? tone === 'neutral'
      ? theme.colors.surface3
      : theme.colors.accent
    : theme.colors.surface;
  const foreground = accentSelected ? theme.colors.onAccent : theme.colors.label;

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      hitSlop={small ? 11 : 6}
      onPress={onPress}
      scaleTo={theme.motion.pressScale}
      style={[
        styles.base,
        {
          paddingVertical: small ? 3 : 6,
          paddingHorizontal: small ? 10 : 13,
          borderRadius: theme.radius.pill,
          backgroundColor: background,
          gap: small ? theme.space.xs : 6,
        },
        style,
      ]}
      testID={testID}
    >
      {icon ? <Icon color={foreground} name={icon} size={small ? 12 : 14} /> : null}
      <Text
        numberOfLines={1}
        tone={accentSelected ? 'onAccent' : 'label'}
        variant={small ? 'caption' : 'chip'}
        weight={selected ? '500' : '400'}
      >
        {children}
      </Text>
    </PressableScale>
  );
}
