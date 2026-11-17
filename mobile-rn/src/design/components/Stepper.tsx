import { StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type StepperProps = {
  value: string;
  onChangeText: (value: string) => void;
  step: number;
  min?: number;
  max?: number;
  precision?: number;
  keyboardType?: 'decimal-pad' | 'number-pad';
  unit?: string;
  disabled?: boolean;
  /**
   * The value the first `+` writes when the field is empty (upstream stepEffort:
   * an unrated RIR starts at 0, an unrated RPE at 6). Without it, `+`/`-` keep
   * the old min-based behaviour.
   */
  emptyValue?: number;
  accessibilityLabel: string;
};

const DISABLED_OPACITY = 0.42;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    paddingVertical: 0,
    textAlign: 'center',
  },
});

/** Decimal places in a step such as 2.5 or 0.25; used when no precision is passed. */
function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  if (dot === -1) return 0;
  return Math.min(3, text.length - dot - 1);
}

function clamp(value: number, min?: number, max?: number): number {
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

/** Rounds button-produced values to the agreed precision without trailing zeros. */
function format(value: number, precision: number): string {
  const factor = 10 ** precision;
  return String(Math.round(value * factor) / factor);
}

/**
 * Tap-to-adjust numeric field for set rows. The text input stays a raw string
 * while the user types; only the +/- buttons parse, clamp and format it. That
 * keeps `validSet` validation and half-typed values untouched.
 */
export function Stepper({
  value,
  onChangeText,
  step,
  min,
  max,
  precision,
  keyboardType = 'decimal-pad',
  unit,
  disabled = false,
  emptyValue,
  accessibilityLabel,
}: StepperProps) {
  const theme = useTheme();
  const places = precision ?? decimalsOf(step);

  const parsed = value.trim() === '' ? Number.NaN : Number(value.replace(',', '.'));
  const current = Number.isFinite(parsed) ? parsed : undefined;

  const minusDisabled = disabled ||
    (emptyValue !== undefined && current === undefined) ||
    (current !== undefined && min !== undefined && current <= min);
  const plusDisabled = disabled || (current !== undefined && max !== undefined && current >= max);

  const adjust = (direction: 1 | -1) => {
    if (disabled) return;
    // An empty effort field is unrated, not zero: the first `+` writes the scale's
    // own floor (0 RIR / 6 RPE), and `-` leaves it empty.
    if (current === undefined && emptyValue !== undefined) {
      if (direction < 0) return;
      onChangeText(format(clamp(emptyValue, min, max), places));
      return;
    }
    const base = current ?? clamp(min ?? 0, min, max);
    const next = clamp(base + step * direction, min, max);
    onChangeText(format(next, places));
  };

  const buttonSize = theme.sizes.tileSm;
  const hitSlop = (theme.sizes.touch - buttonSize) / 2;

  return (
    <View style={[styles.row, { gap: theme.space.xs, opacity: disabled ? DISABLED_OPACITY : 1 }]}>
      <PressableScale
        accessibilityLabel={`${accessibilityLabel} 减少`}
        accessibilityRole="button"
        accessibilityState={{ disabled: minusDisabled }}
        disabled={minusDisabled}
        hitSlop={hitSlop}
        onPress={() => adjust(-1)}
        scaleTo={theme.motion.pressScaleSmall}
        style={[
          styles.button,
          {
            width: buttonSize,
            height: buttonSize,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.surface2,
          },
        ]}
      >
        <Icon color={theme.colors.label} name="minus" size={16} />
      </PressableScale>
      <TextInput
        accessibilityLabel={accessibilityLabel}
        editable={!disabled}
        keyboardType={keyboardType}
        onChangeText={onChangeText}
        selectTextOnFocus
        style={[
          theme.type.body,
          styles.input,
          {
            width: theme.sizes.touch + theme.space.sm,
            height: theme.sizes.tileMd,
            borderRadius: theme.radius.sm,
            backgroundColor: theme.colors.surface2,
            color: theme.colors.label,
          },
        ]}
        value={value}
      />
      <PressableScale
        accessibilityLabel={`${accessibilityLabel} 增加`}
        accessibilityRole="button"
        accessibilityState={{ disabled: plusDisabled }}
        disabled={plusDisabled}
        hitSlop={hitSlop}
        onPress={() => adjust(1)}
        scaleTo={theme.motion.pressScaleSmall}
        style={[
          styles.button,
          {
            width: buttonSize,
            height: buttonSize,
            borderRadius: theme.radius.pill,
            backgroundColor: theme.colors.surface2,
          },
        ]}
      >
        <Icon color={theme.colors.label} name="plus" size={16} />
      </PressableScale>
      {unit ? (
        <Text tone="secondary" variant="footnote">
          {unit}
        </Text>
      ) : null}
    </View>
  );
}
