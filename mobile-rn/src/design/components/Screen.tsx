import type { ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Edge } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeProvider';

export type ScreenProps = {
  children: ReactNode;
  scroll?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
  style?: StyleProp<ViewStyle>;
  edges?: Edge[];
  testID?: string;
};

const styles = StyleSheet.create({
  base: {
    flex: 1,
  },
  fill: {
    flex: 1,
  },
});

export function Screen({
  children,
  scroll = true,
  contentContainerStyle,
  style,
  edges = ['top', 'left', 'right'],
  testID,
}: ScreenProps) {
  const theme = useTheme();

  return (
    <SafeAreaView
      edges={edges}
      style={[styles.base, { backgroundColor: theme.colors.bg }, style]}
      testID={testID}
    >
      {scroll ? (
        <ScrollView
          contentContainerStyle={[
            { padding: theme.layout.pagePadding, paddingBottom: 28 },
            contentContainerStyle,
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
      ) : (
        <View style={styles.fill}>{children}</View>
      )}
    </SafeAreaView>
  );
}
