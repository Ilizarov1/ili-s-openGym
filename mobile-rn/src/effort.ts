/**
 * Shared effort (RPE / RIR) rules for the workout and history screens.
 *
 * A row stores one scale only. New ratings follow the profile setting, but an old
 * row is read back on its own scale: switching the preference never rewrites what
 * is already in history. Conversion is only used when a person explicitly saves a
 * row in the history editor.
 */
import { EFFORT } from '../../frontend/src/lib/history';
import { EFFORT_PRESETS, rirOf, toScale } from '../../frontend/src/lib/effort';
import { isFailureSet } from '../../frontend/src/lib/workout-model';
import {
  effortOf,
  type EffortScale,
  type LoggedSet,
  type Profile,
  type RatingScale,
} from './training';

export type EffortPreset = { value: number; tail: boolean; feel: string };

export function scaleName(scale: RatingScale): string {
  return EFFORT[scale]?.hd ?? scale.toUpperCase();
}

export function scaleStep(scale: RatingScale): number {
  return EFFORT[scale]?.step ?? 0.5;
}

export function scaleMax(scale: RatingScale): number {
  return EFFORT[scale]?.max ?? 10;
}

/** A number on screen: 8, 8.5, 0 — never 8.0, and never a long float. */
export function formatEffort(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Typed values are capped like upstream capEffort: 10 is the ceiling, 0 is a rating. */
export function capEffortValue(value: number): number {
  return Math.round(Math.min(scaleMax('rpe'), Math.max(0, value)) * 10) / 10;
}

/**
 * The one-tap presets, in the profile's own scale. Internally they are the same
 * colour bands as the web app (0, 0.5, 1, 2, 3, 4+ RIR), so RPE 10 and RIR 0 are
 * the same "nothing left" tap. Cardio uses the talk-test wording.
 */
export function effortPresets(scale: RatingScale, cardio = false): EffortPreset[] {
  return EFFORT_PRESETS.map(preset => ({
    value: toScale(scale, preset.rir) as number,
    tail: preset.tail,
    feel: cardio ? preset.cardioFeel : preset.feel,
  }));
}

/** The scale a row was actually saved in; RIR wins when an old row carries both. */
export function savedEffortOf(set: LoggedSet | null | undefined): { scale: RatingScale; value: number } | null {
  if (!set) return null;
  if (typeof set.rir === 'number' && Number.isFinite(set.rir)) return { scale: 'rir', value: set.rir };
  if (typeof set.rpe === 'number' && Number.isFinite(set.rpe)) return { scale: 'rpe', value: set.rpe };
  return null;
}

/** RIR 0 from the failure mark, only when nothing was rated by hand. */
export function derivedEffortOf(set: LoggedSet | null | undefined): number | null {
  return !savedEffortOf(set) && isFailureSet(set) ? 0 : null;
}

/** A saved/derived effort converted to `scale`, or null when there is nothing to convert. */
export function convertedEffortOf(
  set: LoggedSet | null | undefined,
  scale: RatingScale,
): number | null {
  const rir = rirOf(set);
  return rir == null ? null : toScale(scale, rir);
}

/** The row's own saved label, for history summaries; derived failure is marked as such. */
export function effortNoteOf(set: LoggedSet | null | undefined): string {
  const saved = savedEffortOf(set);
  if (saved) return `${scaleName(saved.scale)} ${formatEffort(saved.value)}`;
  if (derivedEffortOf(set) != null) return 'RIR 0（力竭）';
  return '';
}

export function isCardioEntry(
  entry: { target?: { mode?: string } | null } | null | undefined,
  set: LoggedSet | null | undefined,
): boolean {
  if (entry?.target?.mode === 'cardio') return true;
  if (entry?.target?.mode === 'reps' || entry?.target?.mode === 'time') return false;
  return set?.r == null && (set?.min != null || set?.speed != null);
}

/**
 * Which scale the history editor should show for one row. Strength rows follow the
 * profile setting; with effort off, an already-rated row keeps its saved scale so
 * it can still be corrected. Cardio is always RPE (a run has no reps left), and an
 * untouched cardio row gets no new rating while the setting is off.
 */
export function editorScaleFor(
  preference: EffortScale,
  cardio: boolean,
  set: LoggedSet | null | undefined,
): RatingScale | null {
  if (cardio) {
    if (preference !== 'none') return 'rpe';
    return savedEffortOf(set) ? 'rpe' : null;
  }
  if (preference === 'rpe' || preference === 'rir') return preference;
  return savedEffortOf(set)?.scale ?? null;
}

/** A draft row's effort converted to the scale currently being edited. */
export function draftEffortOf(
  set: { effortScale?: RatingScale; effort?: number } | null | undefined,
  scale: RatingScale,
): number | null {
  if (!set || set.effort == null || !set.effortScale) return null;
  const rir = set.effortScale === 'rpe' ? 10 - set.effort : set.effort;
  return toScale(scale, rir);
}

/** The profile's preference, with the legacy-boolean rules kept in training.ts. */
export const effortPreferenceOf = (profile: Profile): EffortScale => effortOf(profile);
