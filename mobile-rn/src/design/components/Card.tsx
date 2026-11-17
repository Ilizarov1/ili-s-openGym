import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import { PressableScale } from './PressableScale';

export type CardProps = {
  children: ReactNode;
  onPress?: () => void;
  padded?: boolean;
  gap?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const styles = StyleSheet.create({
  base: {
    overflow: 'hidden',
  },
});

export function Card({ children, onPress, padded = true, gap = 10, style, testID }: CardProps) {
  const theme = useTheme();
  const cardStyle: StyleProp<ViewStyle> = [
    styles.base,
    {
      backgroundColor: theme.colors.surface,
      borderRadius: theme.radius.card,
      marginBottom: theme.layout.cardGap,
      padding: padded ? theme.layout.cardPadding : 0,
      gap,
    },
    style,
  ];

  if (!onPress) {
    return (
      <View style={cardStyle} testID={testID}>
        {children}
      </View>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      scaleTo={theme.motion.pressScaleCard}
      style={cardStyle}
      testID={testID}
    >
      {children}
    </PressableScale>
  );
}
