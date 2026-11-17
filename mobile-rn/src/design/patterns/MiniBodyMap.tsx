// A thumbnail of the muscles one or more routines would train, ported from
// frontend/src/components/MiniBodyMap.jsx.

import React, { useMemo } from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { loadOfRoutine } from '../../../../frontend/src/lib/muscles.js';
import { BodyMap } from './BodyMap';
import type { BodyKind, BodyLoad } from './BodyMap';

export type RoutineExercise = { id: string; sets?: number };
export type RoutineWithExercises = { ex?: RoutineExercise[] };

export type MiniBodyMapProps = {
  routines: RoutineWithExercises[];
  body?: BodyKind;
  /** Height of each view; defaults to 46. */
  height?: number;
  style?: StyleProp<ViewStyle>;
};

export function MiniBodyMap({ routines, body, height = 46, style }: MiniBodyMapProps): React.ReactElement | null {
  const load = useMemo<BodyLoad>(
    () => loadOfRoutine({ ex: routines.flatMap(routine => routine.ex ?? []) }) as BodyLoad,
    [routines],
  );

  if (!Object.values(load).some(value => value > 0)) return null;

  // The row itself is the control; the thumbnail is decoration, as upstream.
  return (
    <View
      style={style}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <BodyMap variant="mini" load={load} body={body} height={height} />
    </View>
  );
}
