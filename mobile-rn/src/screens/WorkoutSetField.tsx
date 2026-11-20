import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { View } from 'react-native';
import { InlineNumberField, Stepper } from '../design';

const MAX_FIELD_WEIGHT = 5000;

function weightTextValid(text: string) {
  const value = Number(text.replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && value >= 0 && value <= MAX_FIELD_WEIGHT;
}

function repsTextValid(text: string, mode: string) {
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || value <= 0) return false;
  if (mode === 'cardio') return value <= 1440;
  return Number.isInteger(value) && value <= (mode === 'time' ? 86400 : 500);
}

type StepperProps = ComponentProps<typeof Stepper>;

export type SetFieldProps = {
  value: string;
  mode: string;
  field: 'weight' | 'reps';
  onChangeText: (value: string) => void;
  /** `inline` is the table-style tap-to-type field; `stepper` keeps the +/- row. */
  presentation?: 'stepper' | 'inline';
  testID?: string;
} & Pick<StepperProps, 'accessibilityLabel' | 'disabled' | 'keyboardType' | 'max' | 'min' | 'step'>;

/**
 * A set row field keeps half-typed text locally and only writes a legal number
 * to the draft. Blurring invalid text (an empty field included) restores the last
 * committed value, so the draft never holds a value `finishWorkout` would reject.
 * Shared by the cards, list and compact layouts and by the focus view, so every
 * layout commits through the same legal-number rule.
 */
export function SetField({
  value,
  mode,
  field,
  onChangeText,
  presentation = 'stepper',
  testID,
  ...rest
}: SetFieldProps) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const valid = field === 'weight' ? weightTextValid : (next: string) => repsTextValid(next, mode);
  useEffect(() => {
    if (!focused) setText(value);
  }, [focused, value]);

  const changeText = (next: string) => {
    setText(next);
    if (valid(next)) onChangeText(next);
  };
  const focus = () => setFocused(true);
  const blur = () => {
    setFocused(false);
    if (!valid(text)) setText(value);
  };

  if (presentation === 'inline') {
    return (
      <InlineNumberField
        accessibilityLabel={rest.accessibilityLabel}
        disabled={rest.disabled}
        keyboardType={rest.keyboardType}
        onBlur={blur}
        onChangeText={changeText}
        onFocus={focus}
        testID={testID}
        value={text}
      />
    );
  }

  const stepper = (
    <Stepper
      {...rest}
      onBlur={blur}
      onChangeText={changeText}
      onFocus={focus}
      value={text}
    />
  );
  return testID ? <View testID={testID}>{stepper}</View> : stepper;
}

export default SetField;
