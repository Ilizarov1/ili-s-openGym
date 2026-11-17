/**
 * Typed text. Screens name a role (`body`, `title3`, `footnote`) and a tone;
 * they never write a size or a colour. Native props such as `numberOfLines`,
 * `ellipsizeMode` and `onPress` pass straight through, and `style` merges last
 * so a caller can add layout (margins) without redefining the type.
 */

import type { ComponentProps, ReactElement } from 'react';
import { Text as RNText, type TextStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { typography } from '../tokens';
import type { ThemeColors } from '../themes';

export type TextVariant = keyof typeof typography;

export type TextTone =
  | 'label'
  | 'secondary'
  | 'tertiary'
  | 'quaternary'
  | 'accent'
  | 'danger'
  | 'onAccent';

export type TextProps = ComponentProps<typeof RNText> & {
  /** Default `body`. */
  variant?: TextVariant;
  /** Default `label`. */
  tone?: TextTone;
  weight?: TextStyle['fontWeight'];
  align?: TextStyle['textAlign'];
};

const toneColors: Record<TextTone, keyof ThemeColors> = {
  label: 'label',
  secondary: 'label2',
  tertiary: 'label3',
  quaternary: 'label4',
  accent: 'accentInk',
  danger: 'danger',
  onAccent: 'onAccent',
};

export function Text({
  variant = 'body',
  tone = 'label',
  weight,
  align,
  style,
  ...rest
}: TextProps): ReactElement {
  const theme = useTheme();
  const typeStyle = theme.type[variant];

  return (
    <RNText
      {...rest}
      style={[
        {
          color: theme.colors[toneColors[tone]],
          fontSize: typeStyle.fontSize,
          lineHeight: typeStyle.lineHeight,
          fontWeight: typeStyle.fontWeight,
          letterSpacing: typeStyle.letterSpacing,
        },
        weight === undefined ? null : { fontWeight: weight },
        align === undefined ? null : { textAlign: align },
        style,
      ]}
    />
  );
}
