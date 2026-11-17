import { useEffect, useState } from 'react';
import { AppState, Text, View } from 'react-native';
import { ownExerciseRest } from '../../frontend/src/lib/supersetFlow.js';
import { Button, Card, styles } from './ui';

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

export function RestTimer({ endsAt, onCancel }: { endsAt: number | null; onCancel: () => void }) {
  if (endsAt === null) return null;
  return <RestCountdown key={endsAt} endsAt={endsAt} onCancel={onCancel} />;
}

function RestCountdown({ endsAt, onCancel }: { endsAt: number; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
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
  }, [endsAt]);

  const seconds = Math.ceil((endsAt - now) / 1000);
  if (seconds <= 0) return null;

  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return <Card>
    <View style={[styles.row, styles.between]}>
      <View style={styles.grow}>
        <Text style={styles.muted}>组间休息</Text>
        <Text accessibilityRole="timer" style={styles.title}>{time}</Text>
      </View>
      <Button label="取消休息" onPress={onCancel} secondary />
    </View>
  </Card>;
}
