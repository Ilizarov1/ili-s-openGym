/**
 * The compact live-progress strip that sits above a streaming Coach answer.
 *
 * It mirrors the Web `StreamStepsBar` (`frontend/src/components/CoachGenUI.jsx`): the current
 * AG-UI step label, an extra line while `search_catalogue` is running, and a stop control. Step
 * names come from the server's `STEP_STARTED` / `STEP_FINISHED` events, so unknown names fall
 * back to the server-supplied label and then to the raw name instead of rendering blank.
 */

import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { Badge, Button, Icon, Text, useReducedMotion, useTheme } from '../design';

/** One step of a live run, as emitted by `STEP_STARTED` / `STEP_FINISHED`. */
export type CoachStreamStep = {
  stepName: string;
  /** Overrides the built-in Chinese label; the server's own wording when present. */
  label?: string;
  done?: boolean;
};

export type StreamStepsBarProps = {
  steps?: readonly CoachStreamStep[];
  /** The AG-UI tool currently running, e.g. `search_catalogue`. */
  activeTool?: string | null;
  /** A tool that already finished in this run; the row stays visible so the call is perceivable. */
  completedTool?: string | null;
  /** The search query behind the tool call, when the caller knows it. */
  toolQuery?: string | null;
  /** `true` while the answer is still streaming; drives the pulse. */
  streaming?: boolean;
  onStop?: () => void;
  style?: StyleProp<ViewStyle>;
};

const STEP_LABELS: Readonly<Record<string, string>> = {
  prepare: '正在查看你的训练…',
  analyze: '正在分析你的训练记录',
  catalogue: '正在挑选合适的动作',
  compose: '正在整理回答…',
  validate: '正在核对建议…',
};

const SEARCH_LABEL = '正在检索动作库…';
const SEARCH_DONE_LABEL = '已检索动作库';
const THINKING_LABEL = '教练正在思考…';

function stepLabel(step: CoachStreamStep): string {
  return STEP_LABELS[step.stepName] ?? step.label ?? step.stepName;
}

function currentLabel(steps: readonly CoachStreamStep[], activeTool: string | null): string {
  if (activeTool === 'search_catalogue' && !steps.some(step => !step.done)) return SEARCH_LABEL;
  const live = [...steps].reverse().find(step => !step.done);
  if (live) return stepLabel(live);
  const last = steps[steps.length - 1];
  if (last) return stepLabel(last);
  return THINKING_LABEL;
}

function toolLabel(activeTool: string): string {
  return activeTool === 'search_catalogue' ? SEARCH_LABEL : activeTool;
}

function doneToolLabel(tool: string): string {
  return tool === 'search_catalogue' ? SEARCH_DONE_LABEL : tool;
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  dot: {
    flexShrink: 0,
  },
});

export function StreamStepsBar({
  steps = [],
  activeTool = null,
  completedTool = null,
  toolQuery = null,
  streaming = true,
  onStop,
  style,
}: StreamStepsBarProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;

  const visible = streaming || Boolean(activeTool);

  useEffect(() => {
    if (!visible || reducedMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.32,
          duration: theme.motion.med,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: theme.motion.med,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reducedMotion, theme.motion.med, visible]);

  if (!visible) return null;

  const label = currentLabel(steps, activeTool);
  const query = toolQuery && toolQuery.length > 18 ? `${toolQuery.slice(0, 18)}…` : toolQuery;

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.surface2,
          borderRadius: theme.radius.lg,
          paddingVertical: theme.space.sm,
          paddingHorizontal: theme.space.md,
          gap: theme.space.md,
        },
        style,
      ]}
    >
      <View style={[styles.body, { gap: theme.space.xxs }]}>
        <View style={[styles.row, { gap: theme.space.sm }]}>
          <Animated.View
            style={[
              styles.dot,
              {
                width: theme.space.sm,
                height: theme.space.sm,
                borderRadius: theme.radius.pill,
                backgroundColor: theme.colors.accent,
                opacity: pulse,
              },
            ]}
          />
          <Text numberOfLines={2} style={styles.grow} variant="footnote">
            {label}
          </Text>
        </View>
        {activeTool ? (
          <View style={[styles.row, { gap: theme.space.xs, paddingLeft: theme.space.lg }]}>
            <Icon
              color={theme.colors.accentInk}
              name={activeTool === 'search_catalogue' ? 'magnifier' : 'sparkles'}
              size={theme.sizes.buttonIcon - theme.space.xxs}
            />
            <Text numberOfLines={1} style={styles.grow} tone="accent" variant="caption">
              {toolLabel(activeTool)}
            </Text>
            {query ? <Badge tone="neutral">{query}</Badge> : null}
          </View>
        ) : completedTool ? (
          <View style={[styles.row, { gap: theme.space.xs, paddingLeft: theme.space.lg }]}>
            <Icon
              color={theme.colors.label3}
              name={completedTool === 'search_catalogue' ? 'magnifier' : 'sparkles'}
              size={theme.sizes.buttonIcon - theme.space.xxs}
            />
            <Text numberOfLines={1} style={styles.grow} tone="tertiary" variant="caption">
              {doneToolLabel(completedTool)}
            </Text>
            {query ? <Badge tone="neutral">{query}</Badge> : null}
          </View>
        ) : null}
      </View>
      {onStop ? (
        <Button
          accessibilityLabel="停止生成回答"
          icon="xmark"
          onPress={onStop}
          size="sm"
          style={{ minHeight: theme.sizes.touch }}
          variant="secondary"
        >
          停止
        </Button>
      ) : null}
    </View>
  );
}
