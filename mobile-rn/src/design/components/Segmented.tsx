import { useLayoutEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { alpha } from '../color';
import { palette } from '../tokens';
import { useTheme } from '../ThemeProvider';
import { Icon } from '../icons/Icon';
import type { IconName } from '../icons/Icon';
import { Text } from './Text';
import { useReducedMotion } from './PressableScale';

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  icon?: IconName;
};

export type SegmentedProps<T extends string> = {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const THUMB_INSET = 2;

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    alignItems: 'stretch',
    height: 32,
    padding: THUMB_INSET,
    position: 'relative',
  },
  thumb: {
    position: 'absolute',
    top: THUMB_INSET,
    bottom: THUMB_INSET,
    left: THUMB_INSET,
  },
  option: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 8,
  },
});

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  style,
  testID,
}: SegmentedProps<T>) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const translateX = useRef(new Animated.Value(0)).current;
  const measured = useRef(false);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const thumbWidth =
    trackWidth > 0 && options.length > 0
      ? (trackWidth - THUMB_INSET * 2) / options.length
      : 0;

  useLayoutEffect(() => {
    if (thumbWidth <= 0) return;
    const target = thumbWidth * selectedIndex;
    if (!measured.current || reducedMotion) {
      translateX.setValue(target);
      measured.current = true;
      return;
    }
    Animated.timing(translateX, {
      toValue: target,
      duration: theme.motion.med,
      easing: Easing.bezier(...theme.motion.ease),
      useNativeDriver: true,
    }).start();
  }, [reducedMotion, selectedIndex, theme.motion, thumbWidth, translateX]);

  const handleLayout = (event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setTrackWidth((current) => (current === nextWidth ? current : nextWidth));
  };

  return (
    <View
      onLayout={handleLayout}
      style={[
        styles.track,
        {
          backgroundColor: alpha(palette.gray4, 0.24),
          borderRadius: theme.radius.md,
        },
        style,
      ]}
      testID={testID}
    >
      {thumbWidth > 0 ? (
        <Animated.View
          style={[
            styles.thumb,
            theme.shadows.segThumb,
            {
              width: thumbWidth,
              borderRadius: theme.radius.xs,
              backgroundColor: theme.mode === 'dark' ? palette.gray4 : theme.colors.surface,
              transform: [{ translateX }],
            },
          ]}
        />
      ) : null}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected }}
            hitSlop={{ top: 6, bottom: 6 }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={styles.option}
          >
            {option.icon ? (
              <Icon
                color={selected ? theme.colors.label : theme.colors.label2}
                name={option.icon}
                size={15}
              />
            ) : null}
            <Text
              numberOfLines={1}
              tone={selected ? 'label' : 'secondary'}
              variant="segment"
              weight={selected ? '500' : '400'}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
