import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeProvider';
import { Text } from './Text';
import { useReducedMotion } from './PressableScale';

export type SheetProps = {
  visible: boolean;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  testID?: string;
};

const SHEET_TRAVEL = 400;
const DISMISS_DISTANCE = 90;
const DISMISS_VELOCITY = 0.8;

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  bottom: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  panel: {
    maxHeight: '90%',
    paddingTop: 8,
    paddingHorizontal: 18,
  },
  grabArea: {
    alignItems: 'stretch',
  },
  grab: {
    width: 36,
    height: 5,
    alignSelf: 'center',
    marginTop: 6,
    marginBottom: 14,
  },
  content: {
    flexGrow: 0,
    flexShrink: 1,
  },
  footer: {
    marginTop: 12,
  },
});

export function Sheet({
  visible,
  title,
  children,
  footer,
  onClose,
  dismissible = true,
  testID,
}: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(visible);
  const translateY = useRef(new Animated.Value(SHEET_TRAVEL)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const animateIn = useCallback(() => {
    translateY.setValue(reducedMotion ? 0 : SHEET_TRAVEL);
    backdropOpacity.setValue(reducedMotion ? 1 : 0);
    if (reducedMotion) return;
    Animated.parallel([
      Animated.timing(translateY, {
        toValue: 0,
        duration: theme.motion.sheet,
        easing: Easing.bezier(...theme.motion.ease),
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 1,
        duration: theme.motion.sheet,
        easing: Easing.bezier(...theme.motion.ease),
        useNativeDriver: true,
      }),
    ]).start();
  }, [backdropOpacity, reducedMotion, theme.motion, translateY]);

  useEffect(() => {
    if (!visible) return;
    if (!mounted) {
      setMounted(true);
      return;
    }
    animateIn();
  }, [animateIn, mounted, visible]);

  useEffect(() => {
    if (visible || !mounted) return;
    if (reducedMotion) {
      translateY.setValue(SHEET_TRAVEL);
      backdropOpacity.setValue(0);
      setMounted(false);
      return;
    }
    const animation = Animated.parallel([
      Animated.timing(translateY, {
        toValue: SHEET_TRAVEL,
        duration: theme.motion.sheet,
        easing: Easing.bezier(...theme.motion.ease),
        useNativeDriver: true,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 0,
        duration: theme.motion.sheet,
        easing: Easing.bezier(...theme.motion.ease),
        useNativeDriver: true,
      }),
    ]);
    animation.start(({ finished }) => {
      if (finished && !visibleRef.current) setMounted(false);
    });
    return () => animation.stop();
  }, [backdropOpacity, mounted, reducedMotion, theme.motion, translateY, visible]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          dismissible &&
          !reducedMotion &&
          gesture.dy > 4 &&
          Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderGrant: () => {
          translateY.stopAnimation();
        },
        onPanResponderMove: (_event, gesture) => {
          translateY.setValue(Math.max(0, gesture.dy));
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > DISMISS_DISTANCE || gesture.vy > DISMISS_VELOCITY) {
            onClose();
            return;
          }
          Animated.spring(translateY, {
            toValue: 0,
            speed: 20,
            bounciness: 0,
            useNativeDriver: true,
          }).start();
        },
        onPanResponderTerminate: () => {
          Animated.spring(translateY, {
            toValue: 0,
            speed: 20,
            bounciness: 0,
            useNativeDriver: true,
          }).start();
        },
      }),
    [dismissible, onClose, reducedMotion, translateY],
  );

  const requestClose = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  return (
    <Modal
      animationType="none"
      navigationBarTranslucent
      onRequestClose={requestClose}
      statusBarTranslucent
      transparent
      visible={mounted}
    >
      <View style={styles.root}>
        <Animated.View
          style={[
            styles.backdrop,
            { backgroundColor: theme.colors.overlay, opacity: backdropOpacity },
          ]}
        >
          <Pressable
            accessibilityLabel="关闭"
            accessibilityRole="button"
            disabled={!dismissible}
            onPress={requestClose}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          pointerEvents="box-none"
          style={styles.root}
        >
          <View pointerEvents="box-none" style={styles.bottom}>
            <Animated.View
              accessibilityViewIsModal
              style={[
                styles.panel,
                theme.shadows.sheet,
                {
                  backgroundColor: theme.colors.bgEl,
                  borderTopLeftRadius: theme.radius.xxl,
                  borderTopRightRadius: theme.radius.xxl,
                  paddingBottom: 20 + insets.bottom,
                  transform: [{ translateY }],
                },
              ]}
              testID={testID}
            >
              <View style={styles.grabArea} {...panResponder.panHandlers}>
                <View
                  style={[
                    styles.grab,
                    { backgroundColor: theme.colors.label4, borderRadius: theme.radius.pill },
                  ]}
                />
                {title ? (
                  <Text style={{ marginBottom: 14 }} variant="title3">
                    {title}
                  </Text>
                ) : null}
              </View>
              <ScrollView
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                style={styles.content}
              >
                {children}
              </ScrollView>
              {footer ? <View style={styles.footer}>{footer}</View> : null}
            </Animated.View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
