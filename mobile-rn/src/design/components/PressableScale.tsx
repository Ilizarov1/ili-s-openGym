import { useCallback, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  type AccessibilityRole,
  type AccessibilityState,
  type Insets,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../ThemeProvider';

// A single process-wide subscription keeps the reduce-motion flag in sync without mounting one
// AccessibilityInfo listener per pressable control on screen.
let reduceMotionEnabled = false;
let reduceMotionStarted = false;
const reduceMotionListeners = new Set<() => void>();

function setReduceMotion(next: boolean): void {
  if (next === reduceMotionEnabled) return;
  reduceMotionEnabled = next;
  reduceMotionListeners.forEach((listener) => listener());
}

function startReduceMotionTracking(): void {
  if (reduceMotionStarted) return;
  reduceMotionStarted = true;
  AccessibilityInfo.isReduceMotionEnabled()
    .then(setReduceMotion)
    .catch(() => undefined);
  AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
}

function subscribeReduceMotion(listener: () => void): () => void {
  startReduceMotionTracking();
  reduceMotionListeners.add(listener);
  return () => {
    reduceMotionListeners.delete(listener);
  };
}

function getReduceMotionSnapshot(): boolean {
  return reduceMotionEnabled;
}

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduceMotion, getReduceMotionSnapshot, getReduceMotionSnapshot);
}

export type PressableScaleProps = {
  children: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  scaleTo?: number;
  style?: StyleProp<ViewStyle>;
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityState?: AccessibilityState;
  testID?: string;
  onPressIn?: () => void;
  onPressOut?: () => void;
  /** Expands the touch target without changing the painted box (44px minimum). */
  hitSlop?: number | Insets;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const DISABLED_OPACITY = 0.42;
const REDUCED_MOTION_OPACITY = 0.8;

export function PressableScale({
  children,
  onPress,
  disabled = false,
  scaleTo = 0.97,
  style,
  accessibilityRole,
  accessibilityLabel,
  accessibilityState,
  testID,
  onPressIn,
  onPressOut,
  hitSlop,
}: PressableScaleProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const fade = useRef(new Animated.Value(1)).current;

  const animateTo = useCallback(
    (pressed: boolean) => {
      const duration = theme.motion.fast;
      const easing = Easing.bezier(...theme.motion.ease);
      const scaleTarget = pressed && !reducedMotion ? scaleTo : 1;
      const fadeTarget = pressed && reducedMotion ? REDUCED_MOTION_OPACITY : 1;
      Animated.parallel([
        Animated.timing(scale, {
          toValue: scaleTarget,
          duration,
          easing,
          useNativeDriver: true,
        }),
        Animated.timing(fade, {
          toValue: fadeTarget,
          duration,
          easing,
          useNativeDriver: true,
        }),
      ]).start();
    },
    [fade, reducedMotion, scale, scaleTo, theme.motion],
  );

  const handlePressIn = useCallback(() => {
    animateTo(true);
    onPressIn?.();
  }, [animateTo, onPressIn]);

  const handlePressOut = useCallback(() => {
    animateTo(false);
    onPressOut?.();
  }, [animateTo, onPressOut]);

  const animatedStyle: Animated.WithAnimatedObject<ViewStyle> = {
    transform: [{ scale }],
    opacity: disabled ? DISABLED_OPACITY : fade,
  };

  return (
    <AnimatedPressable
      accessibilityRole={accessibilityRole ?? (onPress ? 'button' : undefined)}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={disabled ? { ...accessibilityState, disabled: true } : accessibilityState}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[style, animatedStyle]}
      testID={testID}
    >
      {children}
    </AnimatedPressable>
  );
}
