import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import type { StyleProp, TextInputProps, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import { Text } from './Text';

export type SearchFieldProps = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onClear?: () => void;
  resultCount?: number;
  autoFocus?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  returnKeyType?: TextInputProps['returnKeyType'];
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  input: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  clear: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -12,
  },
  clearDisc: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export function SearchField({
  value,
  onChangeText,
  placeholder,
  onClear,
  resultCount,
  autoFocus = false,
  style,
  testID,
  returnKeyType,
}: SearchFieldProps) {
  const theme = useTheme();

  const clear = () => {
    if (onClear) onClear();
    else onChangeText('');
  };

  return (
    <View
      style={[
        styles.container,
        {
          minHeight: theme.sizes.input,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surface,
        },
        style,
      ]}
      testID={testID}
    >
      <Icon color={theme.colors.label2} name="magnifier" size={19} />
      <TextInput
        accessibilityLabel={placeholder ?? '搜索'}
        autoCorrect={false}
        autoFocus={autoFocus}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.label3}
        returnKeyType={returnKeyType}
        style={[theme.type.body, styles.input, { color: theme.colors.label }]}
        testID={testID ? `${testID}-input` : undefined}
        underlineColorAndroid="transparent"
        value={value}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityLabel="清除"
          accessibilityRole="button"
          hitSlop={12}
          onPress={clear}
          style={styles.clear}
        >
          <View
            style={[
              styles.clearDisc,
              { backgroundColor: theme.colors.surface2, borderRadius: theme.radius.pill },
            ]}
          >
            <Icon color={theme.colors.label2} name="xmark" size={16} />
          </View>
        </Pressable>
      ) : null}
      {typeof resultCount === 'number' ? (
        <Text tone="secondary" variant="footnote">
          {resultCount}
        </Text>
      ) : null}
    </View>
  );
}
