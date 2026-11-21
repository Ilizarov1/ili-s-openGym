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
  /** Renders a 44×44 sparkles entry only when this callback is passed. */
  onAiPress?: () => void;
  editable?: boolean;
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
  ai: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
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
  onAiPress,
  editable = true,
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
        editable={editable}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.label3}
        returnKeyType={returnKeyType}
        style={[theme.type.body, styles.input, { color: theme.colors.label }]}
        testID={testID ? `${testID}-input` : undefined}
        underlineColorAndroid="transparent"
        value={value}
      />
      {onAiPress ? (
        <Pressable
          accessibilityLabel="AI 检索动作"
          accessibilityRole="button"
          hitSlop={4}
          onPress={onAiPress}
          style={styles.ai}
          testID={testID ? `${testID}-ai` : 'search-ai'}
        >
          <Icon color={theme.colors.accent} name="sparkles" size={22} />
        </Pressable>
      ) : null}
      {value.length > 0 && editable ? (
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
