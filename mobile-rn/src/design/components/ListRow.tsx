import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import { Text } from './Text';
import type { TextTone } from './Text';

export type ListRowProps = {
  leading?: ReactNode;
  title: string;
  titleTone?: TextTone;
  subtitle?: string;
  trailing?: ReactNode;
  onPress?: () => void;
  /** When set, only the leading + text body is pressable; trailing stays a sibling. */
  onPressBody?: () => void;
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
  splitRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
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
  titleTone,
  subtitle,
  trailing,
  onPress,
  onPressBody,
  chevron = false,
  disabled = false,
  style,
  testID,
  accessibilityLabel,
}: ListRowProps) {
  const theme = useTheme();

  const body = (
    <>
      {leading}
      <View style={styles.textColumn}>
        <Text tone={titleTone} variant="body">{title}</Text>
        {subtitle ? (
          <Text style={{ marginTop: theme.space.xxs }} tone="secondary" variant="footnote">
            {subtitle}
          </Text>
        ) : null}
      </View>
    </>
  );

  if (onPressBody) {
    return (
      <View
        style={[
          styles.splitRow,
          {
            minHeight: theme.layout.listRowMinHeight,
            paddingRight: trailing != null || chevron ? theme.layout.listRowPaddingX : 0,
          },
          style,
        ]}
      >
        <Pressable
          accessibilityLabel={accessibilityLabel}
          accessibilityRole="button"
          accessibilityState={disabled ? { disabled: true } : undefined}
          disabled={disabled}
          onPress={onPressBody}
          style={({ pressed }) => [
            styles.body,
            {
              alignSelf: 'stretch',
              paddingVertical: theme.layout.listRowPaddingY,
              paddingHorizontal: theme.layout.listRowPaddingX,
              backgroundColor: pressed && !disabled ? theme.colors.surface2 : 'transparent',
              opacity: disabled ? 0.45 : 1,
            },
          ]}
          testID={testID}
        >
          {body}
        </Pressable>
        {trailing}
        {chevron ? (
          <Icon
            color={theme.colors.label3}
            name="chevronRight"
            size={18}
            style={{ marginLeft: trailing != null ? theme.space.md : 0 }}
          />
        ) : null}
      </View>
    );
  }

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
      {body}
      {trailing}
      {chevron ? <Icon color={theme.colors.label3} name="chevronRight" size={18} /> : null}
    </Pressable>
  );
}
