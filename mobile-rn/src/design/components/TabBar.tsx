import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette } from '../tokens';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
import { PressableScale } from './PressableScale';
import { Text } from './Text';

export type TabItem = { key: string; label: string; icon: IconName };

export type TabBarProps = {
  tabs: [TabItem, TabItem, TabItem, TabItem];
  active: string;
  onSelect: (key: string) => void;
  onStart: () => void;
  startLabel?: string;
  runningLabel?: string;
  running?: boolean;
  testID?: string;
};

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-around',
    paddingTop: 7,
    paddingHorizontal: 6,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    paddingTop: 3,
  },
  start: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  startCircle: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -24,
  },
});

export function TabBar({
  tabs,
  active,
  onSelect,
  onStart,
  startLabel = '开始',
  runningLabel,
  running = false,
  testID,
}: TabBarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const startBackground = running ? theme.colors.warning : theme.colors.accent;
  const startForeground = running ? palette.black : theme.colors.onAccent;
  const startLabelColor = running ? theme.colors.warning : theme.colors.accentInk;

  const renderTab = (tab: TabItem) => {
    const selected = tab.key === active;
    return (
      <PressableScale
        accessibilityLabel={tab.label}
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        key={tab.key}
        onPress={() => onSelect(tab.key)}
        style={[styles.tab, { minHeight: theme.sizes.touch }]}
      >
        <Icon
          color={selected ? theme.colors.accent : theme.colors.label2}
          name={tab.icon}
          size={theme.sizes.tabIcon}
          strokeWidth={selected ? 2 : 1.7}
        />
        <Text numberOfLines={1} tone={selected ? 'accent' : 'secondary'} variant="tab">
          {tab.label}
        </Text>
      </PressableScale>
    );
  };

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.bgEl,
          borderTopColor: theme.colors.sepOp,
          borderTopWidth: theme.sizes.hairline,
          paddingBottom: 6 + insets.bottom,
        },
      ]}
      testID={testID}
    >
      {tabs.slice(0, 2).map(renderTab)}
      <PressableScale
        accessibilityLabel={running ? (runningLabel ?? startLabel) : startLabel}
        accessibilityRole="button"
        onPress={onStart}
        style={[styles.start, { minHeight: theme.sizes.touch }]}
      >
        <View
          style={[
            styles.startCircle,
            theme.shadows.tabStart,
            {
              width: theme.sizes.tabStart,
              height: theme.sizes.tabStart,
              borderRadius: theme.radius.pill,
              backgroundColor: startBackground,
              shadowColor: startBackground,
            },
          ]}
        >
          <Icon color={startForeground} name="play" size={26} strokeWidth={2} />
        </View>
        <Text
          numberOfLines={1}
          style={{ color: startLabelColor, fontVariant: ['tabular-nums'] }}
          variant="tab"
          weight="600"
        >
          {running ? (runningLabel ?? startLabel) : startLabel}
        </Text>
      </PressableScale>
      {tabs.slice(2).map(renderTab)}
    </View>
  );
}
