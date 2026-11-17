import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { alpha } from '../color';
import { useTheme } from '../ThemeProvider';
import { Text } from './Text';

export type BadgeProps = {
  children: ReactNode;
  tone?: 'accent' | 'neutral' | 'orange' | 'danger';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
});

export function Badge({ children, tone = 'accent', style, testID }: BadgeProps) {
  const theme = useTheme();

  const background =
    tone === 'accent'
      ? theme.colors.accentSoft
      : tone === 'orange'
        ? alpha(theme.colors.warning, 0.16)
        : tone === 'danger'
          ? alpha(theme.colors.danger, 0.15)
          : theme.colors.surface2;
  const foreground =
    tone === 'accent'
      ? theme.colors.accentInk
      : tone === 'orange'
        ? theme.colors.warning
        : tone === 'danger'
          ? theme.colors.danger
          : theme.colors.label2;

  return (
    <View
      style={[
        styles.badge,
        {
          backgroundColor: background,
          borderRadius: theme.radius.xs,
        },
        style,
      ]}
      testID={testID}
    >
      <Text style={{ color: foreground }} variant="caption2">
        {children}
      </Text>
    </View>
  );
}
