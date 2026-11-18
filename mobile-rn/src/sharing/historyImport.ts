/**
 * Third-party workout-history import for the RN client.
 *
 * Parsing, matching and unit conversion stay in the upstream Web parser
 * (`frontend/src/lib/import-apps.js` + `import-csv.js`). This module only turns a
 * picked file into a reviewable intent and, when the person confirms, into a stable
 * result the App can write to the local profile (practice mode) or to the sync queue
 * (paired mode).
 *
 * The upstream merge is run against a throwaway copy of the profile so the preview
 * and the result use exactly the same day-level de-duplication and unknown-exercise
 * rules: days already present are skipped whole, an empty day keeps every session in
 * the file, and only exercises used by sessions that survive become new custom
 * exercises.
 */

import { importId, mergeImport } from '../../../frontend/src/lib/import-csv.js';
import { parseImportFile } from '../../../frontend/src/lib/import-apps.js';
import type { ProfileChange } from '../profileChanges';
import {
  unitOf,
  workoutKey,
  type CustomExercise,
  type Profile,
  type QueuedWorkout,
  type Unit,
  type Workout,
} from '../training';

/** Same cap as the RN backup reader (`src/backups.ts`). */
export const HISTORY_IMPORT_MAX_BYTES = 20 * 1024 * 1024;

type SharedCustomExercise = CustomExercise & { custom?: boolean; [key: string]: unknown };
type SharedWorkout = Workout & { [key: string]: unknown };

type ParsedHistory = {
  kind: 'workouts';
  source?: string | null;
  workouts: SharedWorkout[];
  customEx: SharedCustomExercise[];
  matched?: number;
  matchedIds?: string[];
  unmatchedNames?: string[];
  sets?: number;
  skipped?: number;
  warmups?: number;
  fileUnit?: string;
  mixedUnits?: boolean;
  converted?: boolean;
  rpeSets?: number;
  rirSets?: number;
  from?: string | null;
  to?: string | null;
  routines?: { routines?: unknown[] } | null;
};

type ParsedBodyweight = {
  kind: 'bodyweight';
  bodyweight?: unknown[];
  measurements?: unknown[];
};

type ParsedError =
  | { error: 'empty' | 'unrecognised' }
  | { error: 'format'; app: string }
  | { error: 'opengym' };

type ParsedImport = ParsedHistory | ParsedBodyweight | ParsedError;

type MergeState = {
  workouts: SharedWorkout[];
  customEx: SharedCustomExercise[];
  exWeights: Record<string, { w: number; d: string }>;
};

export type HistoryImportPreview = {
  source: string;
  from: string | null;
  to: string | null;
  /** Workouts in the file. */
  fileWorkoutCount: number;
  /** Workouts that will actually be added. */
  workoutCount: number;
  /** Completed sets in the workouts that will be added. */
  setCount: number;
  /** Sets in the whole file, including skipped days and rows. */
  fileSetCount: number;
  fileUnit: Unit | null;
  profileUnit: Unit;
  mixedUnits: boolean;
  converted: boolean;
  /** Distinct library exercises used by the workouts that will be added. */
  matched: number;
  newExerciseCount: number;
  reusedExerciseCount: number;
  newExerciseNames: string[];
  reusedExerciseNames: string[];
  unmatchedNames: string[];
  skippedWorkouts: number;
  skippedDays: number;
  skippedRows: number;
  rpeSets: number;
  rirSets: number;
  /** Routines carried by a Liftosaur/Liftoff JSON; history import leaves them for the plan file flow. */
  extraPlanCount: number;
};

export type HistoryImportResult = {
  /**
   * Deterministic id for this confirmation. A retry of the same file against the same
   * profile produces the same value; the workout ids themselves also come from the
   * upstream parser and never change between retries.
   */
  intentId: string;
  source: string;
  workouts: Workout[];
  /** Unit of the returned workouts: the profile's unit, after upstream conversion. */
  unit: Unit;
  newExercises: CustomExercise[];
  reusedExercises: CustomExercise[];
  imported: number;
  skipped: number;
  skippedRows: number;
  fileUnit: Unit | null;
  mixedUnits: boolean;
  converted: boolean;
  from: string | null;
  to: string | null;
};

export type HistoryImportRecheck = {
  workouts: Workout[];
  newExercises: CustomExercise[];
  skipped: number;
};

export type HistoryImportAnalysis =
  | {
      kind: 'history';
      text: string;
      preview: HistoryImportPreview;
      result: HistoryImportResult;
    }
  | { kind: 'bodyweight'; message: string }
  | { kind: 'plan'; message: string }
  | { kind: 'backup'; message: string }
  | { kind: 'error'; message: string };

function normalizeFileUnit(value: string | undefined): Unit | null {
  return value === 'kg' || value === 'lb' ? value : null;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function nameOf(exercise: SharedCustomExercise): string {
  return exercise.n ?? exercise.name ?? exercise.id;
}

function workoutSetCount(workout: SharedWorkout): number {
  return workout.entries.reduce((total, entry) => total + entry.sets.length, 0);
}

function isPlanJson(text: string): boolean {
  try {
    const data: unknown = JSON.parse(text);
    return !!data && typeof data === 'object' && !Array.isArray(data) &&
      Object.prototype.hasOwnProperty.call(data, 'opengym_plan');
  } catch {
    return false;
  }
}

function mergeIntoPreview(parsed: ParsedHistory, profile: Profile) {
  const beforeWorkouts = (profile.workouts ?? []).filter(Boolean) as SharedWorkout[];
  const beforeCustom = (profile.customEx ?? []).filter(Boolean) as SharedCustomExercise[];
  const beforeWorkoutSet = new Set(beforeWorkouts);
  const beforeCustomIds = new Set(beforeCustom.map(exercise => exercise.id));
  const beforeDays = new Set(beforeWorkouts.map(workout => workout.d));

  const state: MergeState = {
    workouts: beforeWorkouts,
    customEx: beforeCustom,
    exWeights: {},
  };
  mergeImport(state, parsed);

  const fresh = state.workouts.filter(workout => !beforeWorkoutSet.has(workout));
  const newExercises = state.customEx.filter(exercise => !beforeCustomIds.has(exercise.id));
  const usedIds = new Set(fresh.flatMap(workout => workout.entries.map(entry => entry.id)));
  const reusedExercises = state.customEx.filter(
    exercise => beforeCustomIds.has(exercise.id) && usedIds.has(exercise.id),
  );
  const skippedWorkouts = parsed.workouts.length - fresh.length;
  const skippedDays = new Set(
    parsed.workouts.filter(workout => beforeDays.has(workout.d)).map(workout => workout.d),
  ).size;
  const fileUnit = normalizeFileUnit(parsed.fileUnit);
  const matched = Array.isArray(parsed.matchedIds)
    ? new Set(parsed.matchedIds.filter(id => usedIds.has(id))).size
    : Math.min(parsed.matched ?? 0, usedIds.size);
  const newExerciseNames = uniqueSorted(newExercises.map(nameOf));
  const reusedExerciseNames = uniqueSorted(reusedExercises.map(nameOf));
  const newExerciseIds = new Set(newExercises.map(exercise => exercise.id));
  const extraPlanCount = parsed.routines?.routines?.length ?? 0;

  const preview: HistoryImportPreview = {
    source: parsed.source?.trim() || '通用 CSV',
    from: parsed.from ?? null,
    to: parsed.to ?? null,
    fileWorkoutCount: parsed.workouts.length,
    workoutCount: fresh.length,
    setCount: fresh.reduce((total, workout) => total + workoutSetCount(workout), 0),
    fileSetCount: parsed.sets ?? parsed.workouts.reduce((total, workout) => total + workoutSetCount(workout), 0),
    fileUnit,
    profileUnit: unitOf(profile),
    mixedUnits: parsed.mixedUnits === true,
    converted: parsed.converted === true,
    matched,
    newExerciseCount: newExerciseNames.length,
    reusedExerciseCount: reusedExerciseNames.length,
    newExerciseNames,
    reusedExerciseNames,
    unmatchedNames: uniqueSorted(parsed.unmatchedNames ?? []),
    skippedWorkouts,
    skippedDays,
    skippedRows: parsed.skipped ?? 0,
    rpeSets: parsed.rpeSets ?? 0,
    rirSets: parsed.rirSets ?? 0,
    extraPlanCount,
  };

  const intentId = importId('hi', JSON.stringify({
    source: preview.source,
    workouts: fresh.map(workout => [workoutKey(workout), workout.d, workout.start]),
    newExercises: [...newExerciseIds].sort(),
  }));

  const result: HistoryImportResult = {
    intentId,
    source: preview.source,
    workouts: fresh,
    unit: preview.profileUnit,
    newExercises,
    reusedExercises,
    imported: fresh.length,
    skipped: skippedWorkouts,
    skippedRows: preview.skippedRows,
    fileUnit,
    mixedUnits: preview.mixedUnits,
    converted: preview.converted,
    from: preview.from,
    to: preview.to,
  };

  return { preview, result };
}

/**
 * Parse a picked file and show exactly what confirming it would add. The returned
 * result is already a stable intent; if the profile changes before the person taps
 * confirm, call this again with the latest profile and use the new result.
 */
export function prepareHistoryImport(text: string, profile: Profile): HistoryImportAnalysis {
  let parsed: ParsedImport;
  try {
    parsed = parseImportFile(text, {
      unit: unitOf(profile),
      customEx: profile.customEx,
    }) as ParsedImport;
  } catch {
    return {
      kind: 'error',
      message: '无法读取这个文件。它可能已损坏，或不是受支持的训练历史导出。',
    };
  }

  if ('error' in parsed) {
    switch (parsed.error) {
      case 'empty':
        return { kind: 'error', message: '这个文件是空的。' };
      case 'format':
        return {
          kind: 'error',
          message: `这个文件看起来是 ${parsed.app} 导出，但无法读取。没有导入任何数据。`,
        };
      case 'opengym':
        return isPlanJson(text)
          ? {
              kind: 'plan',
              message: '这是 openGym 计划文件。请到「计划 → 分享计划 → 导入计划文件」使用它。',
            }
          : {
              kind: 'backup',
              message: '这是 openGym 完整备份。请到「设置 → 恢复备份」恢复它；本页只导入第三方训练历史。',
            };
      case 'unrecognised':
      default:
        return {
          kind: 'error',
          message: '无法识别这个文件的列。请选择受支持的训练历史导出（CSV 或 JSON）。',
        };
    }
  }

  if (parsed.kind === 'bodyweight') {
    return {
      kind: 'bodyweight',
      message: '这是体重记录文件。请到统计或身体数据中的体重导入入口使用它；本页只导入训练历史。',
    };
  }

  if (!Array.isArray(parsed.workouts)) {
    return { kind: 'error', message: '文件里没有可读取的训练记录。' };
  }

  if (parsed.workouts.length === 0) {
    return parsed.routines?.routines?.length
      ? {
          kind: 'plan',
          message: '这个文件只包含训练计划。请到「计划 → 分享计划 → 导入计划文件」使用它。',
        }
      : { kind: 'error', message: '文件里没有可导入的训练。' };
  }

  try {
    const merged = mergeIntoPreview(parsed, profile);
    return { kind: 'history', text, ...merged };
  } catch {
    return {
      kind: 'error',
      message: '无法合并这个文件，可能已损坏或包含无法识别的数据。',
    };
  }
}

/**
 * Re-check a confirmed intent against a newer history, e.g. after a 409 brought in
 * a workout on a day this file also has. Days already present are dropped whole, and
 * only custom exercises still referenced by the surviving workouts are returned.
 */
export function historyImportRecheck(result: HistoryImportResult, existingWorkouts: readonly Workout[]): HistoryImportRecheck {
  const days = new Set(existingWorkouts.filter(Boolean).map(workout => workout.d));
  const workouts = result.workouts.filter(workout => !days.has(workout.d));
  const used = new Set(workouts.flatMap(workout => workout.entries.map(entry => entry.id)));
  const newExercises = result.newExercises.filter(exercise => used.has(exercise.id));
  return {
    workouts,
    newExercises,
    skipped: result.workouts.length - workouts.length,
  };
}

/** Custom-exercise changes the App must commit with a paired import. */
export function historyImportChanges(
  result: HistoryImportResult,
  workouts: readonly Workout[] = result.workouts,
): ProfileChange[] {
  const used = new Set(workouts.flatMap(workout => workout.entries.map(entry => entry.id)));
  return result.newExercises
    .filter(exercise => used.has(exercise.id))
    .map(exercise => ({ kind: 'custom', exercise, create: true }));
}

/**
 * Queue records for a paired import. `at` is written to `_ts`; pass the moment the
 * person confirms, not a new value on every retry, so the sync keeps one record.
 * `existingWorkouts` (default empty) drops whole days that are no longer free.
 */
export function historyImportQueue(
  result: HistoryImportResult,
  at: number,
  existingWorkouts: readonly Workout[] = [],
): QueuedWorkout[] {
  const days = new Set(existingWorkouts.filter(Boolean).map(workout => workout.d));
  return result.workouts
    .filter(workout => !days.has(workout.d))
    .map(workout => ({
      unit: result.unit,
      workout: { ...workout, id: workoutKey(workout), _ts: at },
    }));
}
