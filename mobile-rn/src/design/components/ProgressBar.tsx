import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';

export type ProgressBarProps = {
  value: number;
  tone?: 'accent' | 'orange';
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function ProgressBar({
  value,
  tone = 'accent',
  height = 6,
  style,
  testID,
}: ProgressBarProps) {
  const theme = useTheme();
  const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
  const percentage = `${clamped * 100}%` as `${number}%`;

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      style={[
        {
          height,
          borderRadius: theme.radius.pill,
          backgroundColor: theme.colors.surface3,
          overflow: 'hidden',
        },
        style,
      ]}
      testID={testID}
    >
      <View
        style={{
          width: percentage,
          height: '100%',
          borderRadius: theme.radius.pill,
          backgroundColor: tone === 'orange' ? theme.colors.warning : theme.colors.accent,
        }}
      />
    </View>
  );
}
