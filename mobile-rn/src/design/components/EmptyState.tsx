import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
import { Text } from './Text';

export type EmptyStateProps = {
  icon?: IconName;
  title: string;
  text?: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    alignSelf: 'stretch',
  },
});

export function EmptyState({ icon, title, text, children, style, testID }: EmptyStateProps) {
  const theme = useTheme();

  return (
    <View style={[styles.root, { padding: theme.space.xxxl }, style]} testID={testID}>
      {icon ? (
        <Icon
          color={theme.colors.label3}
          name={icon}
          size={40}
          style={{ marginBottom: theme.space.md }}
        />
      ) : null}
      <Text accessibilityRole="header" align="center" variant="title3">
        {title}
      </Text>
      {text ? (
        <Text
          align="center"
          style={{ marginTop: theme.space.xs }}
          tone="secondary"
          variant="subhead"
        >
          {text}
        </Text>
      ) : null}
      {children ? (
        <View style={[styles.actions, { marginTop: theme.space.lg, gap: theme.space.md }]}>
          {children}
        </View>
      ) : null}
    </View>
  );
}
