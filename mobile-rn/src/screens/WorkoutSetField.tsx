import { useEffect, useState } from 'react';
import type { ComponentProps } from 'react';
import { Stepper } from '../design';

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
  ...rest
}: {
  value: string;
  mode: string;
  field: 'weight' | 'reps';
  onChangeText: (value: string) => void;
} & Pick<ComponentProps<typeof Stepper>, 'accessibilityLabel' | 'disabled' | 'keyboardType' | 'max' | 'min' | 'step'>) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const valid = field === 'weight' ? weightTextValid : (next: string) => repsTextValid(next, mode);
  useEffect(() => {
    if (!focused) setText(value);
  }, [focused, value]);
  return (
    <Stepper
      {...rest}
      onBlur={() => {
        setFocused(false);
        if (!valid(text)) setText(value);
      }}
      onChangeText={next => {
        setText(next);
        if (valid(next)) onChangeText(next);
      }}
      onFocus={() => setFocused(true)}
      value={text}
    />
  );
}

export default SetField;
