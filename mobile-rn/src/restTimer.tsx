import { useEffect, useState } from 'react';
import { AppState, Pressable, View } from 'react-native';
import { ownExerciseRest } from '../../frontend/src/lib/supersetFlow.js';
import { Button, IconButton, Sheet, Stepper, Text, useTheme } from './design';
import {
  REST_MAX_SEC,
  nudgeDraftRest,
  pauseDraftRest,
  restReady,
  restRemaining,
  resumeDraftRest,
  setDraftRestSeconds,
  type DraftRest,
} from './training';

const DEFAULT_REST_SECONDS = 90;

export function resolveRestSeconds(
  exercise: { restSec?: number; restOff?: boolean } | null | undefined,
  profileRestSec?: unknown,
): number {
  const own = ownExerciseRest(exercise);
  if (own !== null && Number.isFinite(own)) return own;
  if (exercise?.restOff === true) return 0;
  return typeof profileRestSec === 'number' && Number.isFinite(profileRestSec)
    ? Math.max(0, Math.round(profileRestSec))
    : DEFAULT_REST_SECONDS;
}

export function formatRest(seconds: number) {
  const safe = Math.max(0, Math.round(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export type RestDockProps = {
  rest: DraftRest | null | undefined;
  frozen?: boolean;
  onChange: (rest: DraftRest | null) => void;
};

/**
 * The running rest bar: ±15 s, pause/resume, a duration sheet on the clock and
 * skip, all against the draft's own rest state. A rest that reaches its deadline
 * reads as "就绪" without rewriting the draft; closing it clears the rest.
 */
export function RestTimer({ rest, frozen = false, onChange }: RestDockProps) {
  const theme = useTheme();
  const [now, setNow] = useState(Date.now);
  const [editing, setEditing] = useState<number | null>(null);

  useEffect(() => {
    if (frozen) return;
    let tick: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(tick);
      const current = Date.now();
      setNow(current);
      const running = typeof rest?.endsAt === 'number' && rest.endsAt > current;
      if (running && AppState.currentState === 'active') {
        tick = setTimeout(refresh, (rest.endsAt! - current) % 1000 || 1000);
      }
    };
    const subscription = AppState.addEventListener('change', refresh);
    refresh();
    return () => {
      clearTimeout(tick);
      subscription.remove();
    };
  }, [frozen, rest?.endsAt]);

  if (!rest) return null;

  const remaining = frozen ? 90 : restRemaining(rest, now);
  const paused = typeof rest.remainingSec === 'number';
  const ready = !frozen && !paused && restReady(rest, now);
  const label = ready ? '休息就绪' : paused ? '组间休息 · 已暂停' : '组间休息';
  const value = ready ? '就绪' : formatRest(remaining);

  return (
    <>
      <View
        style={{
          backgroundColor: theme.colors.bgEl,
          borderTopColor: theme.colors.sepOp,
          borderTopWidth: theme.sizes.hairline,
          paddingHorizontal: theme.layout.pagePadding,
          paddingVertical: theme.space.sm,
        }}
        testID="rest-dock"
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}>
          <Pressable
            accessibilityLabel={ready ? '休息就绪' : `剩余 ${value}，点按调整`}
            accessibilityRole="button"
            onPress={() => setEditing(restRemaining(rest, Date.now()))}
            style={{ flex: 1, minWidth: 0 }}
          >
            <Text tone="secondary" variant="caption">{label}</Text>
            <Text accessibilityRole="timer" variant="title3">{value}</Text>
          </Pressable>
          {ready ? (
            <>
              <Button
                onPress={() => onChange(nudgeDraftRest(rest, 15))}
                size="sm"
                testID="rest-add"
                variant="secondary"
              >
                +15 秒
              </Button>
              <Button onPress={() => onChange(null)} size="sm" testID="rest-close" variant="primary">
                关闭
              </Button>
            </>
          ) : (
            <>
              <IconButton
                accessibilityLabel="减少 15 秒"
                disabled={remaining <= 0}
                name="minus"
                onPress={() => onChange(nudgeDraftRest(rest, -15))}
                size="sm"
                testID="rest-minus"
              />
              <IconButton
                accessibilityLabel="增加 15 秒"
                disabled={remaining >= REST_MAX_SEC}
                name="plus"
                onPress={() => onChange(nudgeDraftRest(rest, 15))}
                size="sm"
                testID="rest-plus"
              />
              <IconButton
                accessibilityLabel={paused ? '继续休息' : '暂停休息'}
                name={paused ? 'play' : 'pause'}
                onPress={() => onChange(paused ? resumeDraftRest(rest) : pauseDraftRest(rest))}
                size="sm"
                testID="rest-toggle"
              />
              <IconButton
                accessibilityLabel="跳过休息"
                name="skipForward"
                onPress={() => onChange(null)}
                size="sm"
                testID="rest-skip"
              />
            </>
          )}
        </View>
      </View>
      <RestDurationSheet
        rest={rest}
        initial={editing ?? 0}
        onClose={() => setEditing(null)}
        onChange={onChange}
        visible={editing != null}
      />
    </>
  );
}

function RestDurationSheet({ rest, initial, visible, onChange, onClose }: {
  rest: DraftRest;
  initial: number;
  visible: boolean;
  onChange: (rest: DraftRest | null) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [minutes, setMinutes] = useState(String(Math.floor(initial / 60)));
  const [seconds, setSeconds] = useState(String(initial % 60));

  useEffect(() => {
    if (!visible) return;
    setMinutes(String(Math.floor(initial / 60)));
    setSeconds(String(initial % 60));
  }, [initial, visible]);

  const total = Math.min(
    REST_MAX_SEC,
    Math.max(0, (Number(minutes) || 0) * 60 + (Number(seconds) || 0)),
  );

  const confirm = () => {
    // Confirming the untouched value keeps whatever the rest is doing right now,
    // including a running deadline that kept moving while the sheet was open.
    if (Math.round(total) !== Math.round(initial)) onChange(setDraftRestSeconds(rest, total));
    onClose();
  };

  return (
    <Sheet
      footer={
        <View style={{ gap: theme.space.sm }}>
          <Button onPress={confirm} variant="primary">确定</Button>
          <Button onPress={onClose} variant="secondary">取消</Button>
        </View>
      }
      onClose={onClose}
      testID="rest-duration-sheet"
      title="调整本次休息"
      visible={visible}
    >
      <View style={{ flexDirection: 'row', gap: theme.space.md, marginBottom: theme.space.md }}>
        <View style={{ flex: 1 }}>
          <Stepper
            accessibilityLabel="休息分钟"
            keyboardType="number-pad"
            max={15}
            min={0}
            onChangeText={text => { if (/^\d*$/.test(text)) setMinutes(text); }}
            step={1}
            unit="分"
            value={minutes}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Stepper
            accessibilityLabel="休息秒数"
            keyboardType="number-pad"
            max={59}
            min={0}
            onChangeText={text => { if (/^\d*$/.test(text)) setSeconds(text); }}
            step={15}
            unit="秒"
            value={seconds}
          />
        </View>
      </View>
      <Text tone="secondary" variant="footnote">
        最长 15 分钟；设为 0 与跳过相同，会关闭休息计时。
      </Text>
    </Sheet>
  );
}

export default RestTimer;
