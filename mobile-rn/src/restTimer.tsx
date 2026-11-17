import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { ownExerciseRest } from '../../frontend/src/lib/supersetFlow.js';
import { IconButton, IconTile, Text, useTheme } from './design';

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

/**
 * Bottom rest dock for the running workout. It renders nothing without an active
 * rest, and the countdown keeps ticking against `endsAt` so backgrounding the app
 * or a restart cannot drift it.
 */
export function RestTimer({ endsAt, frozen = false, onCancel }: { endsAt: number | null; frozen?: boolean; onCancel: () => void }) {
  if (endsAt === null) return null;
  return <RestCountdown key={endsAt} endsAt={endsAt} frozen={frozen} onCancel={onCancel} />;
}

function RestCountdown({ endsAt, frozen, onCancel }: { endsAt: number; frozen: boolean; onCancel: () => void }) {
  const theme = useTheme();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (frozen) {
      setNow(endsAt - 90000);
      return;
    }
    let tick: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(tick);
      const current = Date.now();
      const left = endsAt - current;
      setNow(current);
      if (left > 0 && AppState.currentState === 'active') {
        tick = setTimeout(refresh, left % 1000 || 1000);
      }
    };
    const subscription = AppState.addEventListener('change', refresh);
    refresh();
    return () => {
      clearTimeout(tick);
      subscription.remove();
    };
  }, [endsAt, frozen]);

  const seconds = frozen ? 90 : Math.ceil((endsAt - now) / 1000);
  if (seconds <= 0) return null;

  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
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
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.md }}>
        <IconTile name="timer" size="sm" tone="soft" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text tone="secondary" variant="caption">组间休息</Text>
          <Text accessibilityRole="timer" variant="title3">{time}</Text>
        </View>
        <IconButton
          accessibilityLabel="取消休息"
          name="xmark"
          onPress={onCancel}
          size="sm"
        />
      </View>
    </View>
  );
}
