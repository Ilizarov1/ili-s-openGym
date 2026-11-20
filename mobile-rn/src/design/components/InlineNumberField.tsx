import { StyleSheet, TextInput, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';

export type InlineNumberFieldProps = {
  value: string;
  onChangeText: (value: string) => void;
  accessibilityLabel: string;
  keyboardType?: 'decimal-pad' | 'number-pad';
  disabled?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/** Matches Stepper's disabled treatment so both set-row fields fade alike. */
const DISABLED_OPACITY = 0.42;

const styles = StyleSheet.create({
  container: {
    width: '100%',
    justifyContent: 'center',
  },
  input: {
    width: '100%',
    paddingVertical: 0,
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
});

/**
 * A single numeric field for table-like set rows. It has no stepper buttons, so
 * the whole 44pt surface is the input target. Validation and blur reversion stay
 * with the caller (`SetField`), exactly as they do for the stepper presentation.
 */
export function InlineNumberField({
  value,
  onChangeText,
  accessibilityLabel,
  keyboardType = 'decimal-pad',
  disabled = false,
  onFocus,
  onBlur,
  testID,
  style,
}: InlineNumberFieldProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.container,
        {
          minHeight: theme.sizes.touch,
          backgroundColor: theme.colors.surface2,
          borderRadius: theme.radius.sm,
          opacity: disabled ? DISABLED_OPACITY : 1,
        },
        style,
      ]}
      testID={testID}
    >
      <TextInput
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled }}
        editable={!disabled}
        keyboardType={keyboardType}
        onBlur={onBlur}
        onChangeText={onChangeText}
        onFocus={onFocus}
        selectTextOnFocus
        style={[
          theme.type.subhead,
          styles.input,
          {
            minHeight: theme.sizes.touch,
            color: theme.colors.label,
          },
        ]}
        testID={testID ? `${testID}-input` : undefined}
        underlineColorAndroid="transparent"
        value={value}
      />
    </View>
  );
}
