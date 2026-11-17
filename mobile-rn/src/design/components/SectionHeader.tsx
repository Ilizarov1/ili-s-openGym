import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { Text } from './Text';

export type SectionHeaderProps = {
  title: string;
  action?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: {
    flexShrink: 1,
  },
  action: {
    flexShrink: 0,
  },
});

export function SectionHeader({ title, action, style, testID }: SectionHeaderProps) {
  const theme = useTheme();

  return (
    <View style={[styles.row, { marginBottom: theme.space.sm }, style]} testID={testID}>
      <Text accessibilityRole="header" style={styles.title} tone="secondary" variant="footnote">
        {title}
      </Text>
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}
