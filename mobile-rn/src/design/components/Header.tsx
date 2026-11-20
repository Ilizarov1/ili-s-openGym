import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { IconButton } from './IconButton';
import { Text } from './Text';

export type HeaderProps = {
  title: string;
  subtitle?: string;
  right?: ReactNode;
  onBack?: () => void;
  /** Screen-reader label for the back button; defaults to 返回. */
  backLabel?: string;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 12,
  },
  titleColumn: {
    flex: 1,
    minWidth: 0,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexShrink: 0,
  },
});

export function Header({
  title,
  subtitle,
  right,
  onBack,
  backLabel = '返回',
  compact = false,
  style,
  testID,
}: HeaderProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.row,
        { marginTop: theme.space.sm, marginBottom: theme.layout.headerBottom },
        style,
      ]}
      testID={testID}
    >
      {onBack ? (
        <IconButton
          accessibilityLabel={backLabel}
          name="chevronLeft"
          onPress={onBack}
          size="sm"
        />
      ) : null}
      <View style={styles.titleColumn}>
        <Text
          accessibilityRole="header"
          numberOfLines={compact ? 1 : undefined}
          variant={compact ? 'title3' : 'pageTitle'}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ marginTop: theme.space.xs }} tone="secondary" variant="subhead">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}
