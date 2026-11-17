import { StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '../ThemeProvider';
import type { IconName } from '../icons/Icon';
import { IconTile } from './IconTile';
import { Text } from './Text';

export type StatTileProps = {
  icon?: IconName;
  label: string;
  value: string;
  detail?: string;
  tone?: 'accent' | 'orange' | 'blue' | 'neutral';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  textColumn: {
    flex: 1,
    minWidth: 0,
  },
});

export function StatTile({ icon, label, value, detail, tone = 'accent', style, testID }: StatTileProps) {
  const theme = useTheme();

  return (
    <View style={[styles.row, { gap: theme.space.md }, style]} testID={testID}>
      {icon ? <IconTile name={icon} size="md" tone={tone} /> : null}
      <View style={styles.textColumn}>
        <Text tone="secondary" variant="caption">
          {label}
        </Text>
        <Text variant="title2">{value}</Text>
        {detail ? (
          <Text style={{ marginTop: theme.space.xxs }} tone="secondary" variant="footnote">
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
