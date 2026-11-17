import { TextInput, View } from 'react-native';
import type { StyleProp, TextInputProps, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { Text } from './Text';

export type TextFieldProps = TextInputProps & {
  label: string;
  error?: string;
  helper?: string;
  containerStyle?: StyleProp<ViewStyle>;
};

/**
 * Labelled single-or-multi-line input. The label doubles as the default
 * accessibility label so ADB checks can target fields by their visible name.
 * The 46pt surface2 box matches the upstream input and the Sheet form rows.
 */
export function TextField({
  label,
  error,
  helper,
  containerStyle,
  style,
  accessibilityLabel,
  editable,
  multiline = false,
  ...rest
}: TextFieldProps) {
  const theme = useTheme();

  return (
    <View style={[{ gap: theme.space.xs }, containerStyle]}>
      <Text tone="secondary" variant="footnote">
        {label}
      </Text>
      <TextInput
        {...rest}
        accessibilityLabel={accessibilityLabel ?? label}
        editable={editable}
        multiline={multiline}
        placeholderTextColor={theme.colors.label3}
        style={[
          theme.type.body,
          {
            minHeight: theme.sizes.input,
            borderRadius: theme.radius.lg,
            backgroundColor: theme.colors.surface2,
            paddingHorizontal: theme.space.md,
            paddingVertical: multiline ? theme.space.sm : 0,
            textAlignVertical: multiline ? 'top' : 'center',
            color: theme.colors.label,
          },
          style,
        ]}
      />
      {error ? (
        <Text tone="danger" variant="footnote">
          {error}
        </Text>
      ) : helper ? (
        <Text tone="secondary" variant="footnote">
          {helper}
        </Text>
      ) : null}
    </View>
  );
}
