import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';

export type DividerProps = {
  inset?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

export function Divider({ inset = 0, style, testID }: DividerProps) {
  const theme = useTheme();

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          height: theme.sizes.hairline,
          marginLeft: inset,
          backgroundColor: theme.colors.sep,
        },
        style,
      ]}
      testID={testID}
    />
  );
}
