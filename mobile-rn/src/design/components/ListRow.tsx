import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import { Text } from './Text';

export type ListRowProps = {
  leading?: ReactNode;
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  chevron?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
});

export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  onPress,
  chevron = false,
  disabled = false,
  style,
  testID,
  accessibilityLabel,
}: ListRowProps) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityState={disabled ? { disabled: true } : undefined}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: theme.layout.listRowMinHeight,
          paddingVertical: theme.layout.listRowPaddingY,
          paddingHorizontal: theme.layout.listRowPaddingX,
          backgroundColor: pressed && !disabled ? theme.colors.surface2 : 'transparent',
          opacity: disabled ? 0.45 : 1,
        },
        style,
      ]}
      testID={testID}
    >
      {leading}
      <View style={styles.textColumn}>
        <Text variant="body">{title}</Text>
        {subtitle ? (
          <Text style={{ marginTop: theme.space.xxs }} tone="secondary" variant="footnote">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Icon color={theme.colors.label3} name="chevronRight" size={18} /> : null}
    </Pressable>
  );
}
