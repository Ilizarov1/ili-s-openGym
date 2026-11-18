/**
 * Plan sharing for the RN client.
 *
 * The file format, weight conversion and custom-exercise matching stay in the
 * upstream Web module (`frontend/src/lib/plan-share.js`). This module:
 *
 *  - builds the export bundle from a selection of routines, their week schedule and
 *    the custom exercises those routines reference;
 *  - validates an imported file and describes it for the confirmation screen;
 *  - turns a confirmed import into `ProfileChange[]` with deterministic plan/custom
 *    ids, so retrying the same confirmation never makes a second copy.
 *
 * `mergePlan` is run on a throwaway copy of the profile to get its exact matching and
 * schedule semantics; the resulting objects are then re-keyed to stable ids before
 * they are handed to the App.
 */

import './upstreamPolyfill';
import { importId } from '../../../frontend/src/lib/import-csv.js';
import { buildPlanBundle, mergePlan, parsePlan } from '../../../frontend/src/lib/plan-share.js';
import type { ProfileChange } from '../profileChanges';
import {
  unitOf,
  type CustomExercise,
  type Profile,
  type Routine,
  type Unit,
} from '../training';

/** Same cap as the RN backup reader (`src/backups.ts`). */
export const PLAN_SHARE_MAX_BYTES = 20 * 1024 * 1024;

type SharedCustomExercise = CustomExercise & Record<string, unknown>;
type SharedRoutine = Routine & Record<string, unknown>;

export type ParsedPlan = {
  name: string;
  routines: SharedRoutine[];
  week: Record<string, string | string[]>;
  exUnit?: Record<string, string>;
  customEx: SharedCustomExercise[];
  dropped: number;
  routineCount: number;
  exerciseCount: number;
  scheduledDays: number;
  programmes?: unknown[];
  unit: Unit;
  sourceUnit: Unit | null;
  destinationUnit: Unit;
};

export type PlanImportPreview = {
  name: string;
  routineCount: number;
  exerciseCount: number;
  scheduledDays: number;
  dropped: number;
  customCount: number;
  sourceUnit: Unit | null;
  destinationUnit: Unit;
  converted: boolean;
  routines: { id: string; name: string; exerciseCount: number }[];
};

export type PlanImportAnalysis =
  | {
      kind: 'plan';
      text: string;
      parsed: ParsedPlan;
      preview: PlanImportPreview;
      fingerprint: string;
    }
  | { kind: 'backup'; message: string }
  | { kind: 'history'; message: string }
  | { kind: 'error'; message: string };

export type PlanExportBundle = {
  bundle: unknown;
  routineCount: number;
  exerciseCount: number;
};

const WEEK_DAYS = ['0', '1', '2', '3', '4', '5', '6'];

function dayIds(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string');
  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '无法读取这个文件。';
}

function parsedUnit(value: unknown): Unit | null {
  return value === 'kg' || value === 'lb' ? value : null;
}

/**
 * The shareable bundle for the selected routines. `buildPlanBundle` filters the
 * referenced custom exercises itself; the week is filtered here so a schedule never
 * points at a routine that was not exported.
 */
export function buildPlanExport(profile: Profile, routineIds?: readonly string[]): PlanExportBundle {
  const routines = (profile.routines ?? []).filter(
    (routine): routine is Routine => !!routine && typeof routine.id === 'string',
  );
  const selected = new Set(routineIds ?? routines.map(routine => routine.id));
  const selectedRoutines = routines.filter(routine => selected.has(routine.id));
  if (selectedRoutines.length === 0) throw new Error('请至少选择一套计划。');

  const week: Record<string, string[]> = {};
  for (const day of WEEK_DAYS) {
    const ids = dayIds(profile.week?.[day]).filter(id => selected.has(id));
    if (ids.length) week[day] = ids;
  }

  const state = {
    ...profile,
    unit: unitOf(profile),
    routines: selectedRoutines,
    week,
    customEx: (profile.customEx ?? []).filter(Boolean),
    // Programmes are a Web-only grouping; exporting them from a subset would carry
    // references to routines the recipient does not get.
    programmes: {},
  };
  const bundle = buildPlanBundle(state, 'openGym 计划') as unknown;
  return {
    bundle,
    routineCount: selectedRoutines.length,
    exerciseCount: selectedRoutines.reduce(
      (total, routine) => total + (routine.ex ?? []).filter(Boolean).length,
      0,
    ),
  };
}

/** Validate a picked plan file and describe what it would add. Nothing is written. */
export function preparePlanImport(text: string, profile: Profile): PlanImportAnalysis {
  if (!text.trim()) return { kind: 'error', message: '这个文件是空的。' };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return text.trimStart().startsWith('{')
      ? { kind: 'error', message: '这个 JSON 文件已损坏，无法读取。' }
      : {
          kind: 'history',
          message: '这是训练历史或 CSV 文件。请到「设置 → 导入训练历史」使用它；本页只导入 openGym 计划。',
        };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { kind: 'error', message: '这不是 openGym 计划文件。' };
  }

  if (!Object.prototype.hasOwnProperty.call(data, 'opengym_plan')) {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.workouts) || Array.isArray(record.routines) || Array.isArray(record.customEx)) {
      return {
        kind: 'backup',
        message: '这个文件不是 openGym 计划。若它是完整备份，请到「设置 → 恢复备份」；若包含训练历史，请到「设置 → 导入训练历史」。',
      };
    }
    return {
      kind: 'error',
      message: '这不是 openGym 计划文件。计划文件应包含 opengym_plan 字段。',
    };
  }

  let parsed: ParsedPlan;
  try {
    parsed = parsePlan(text, unitOf(profile)) as ParsedPlan;
  } catch (error) {
    return { kind: 'error', message: `计划文件格式不正确：${errorMessage(error)}` };
  }

  if (!Array.isArray(parsed.routines) || parsed.routines.length === 0) {
    return { kind: 'error', message: '计划文件里没有可导入的训练计划。' };
  }

  const sourceUnit = parsedUnit(parsed.sourceUnit);
  const destinationUnit = unitOf(profile);
  const preview: PlanImportPreview = {
    name: parsed.name?.trim() || '分享的计划',
    routineCount: parsed.routineCount,
    exerciseCount: parsed.exerciseCount,
    scheduledDays: parsed.scheduledDays,
    dropped: parsed.dropped,
    customCount: Array.isArray(parsed.customEx) ? parsed.customEx.length : 0,
    sourceUnit,
    destinationUnit,
    converted: sourceUnit !== null && sourceUnit !== destinationUnit,
    routines: parsed.routines.map(routine => ({
      id: routine.id,
      name: routine.name?.trim() || '未命名计划',
      exerciseCount: Array.isArray(routine.ex) ? routine.ex.filter(Boolean).length : 0,
    })),
  };

  return {
    kind: 'plan',
    text,
    parsed,
    preview,
    fingerprint: importId('pf', text),
  };
}

/**
 * The changes for one confirmed import. Runs upstream `mergePlan` on a copy to reuse
 * its same-name/same-body-part custom matching and schedule replacement, then keys
 * every new object with an id derived from the file and the current profile. The same
 * confirmation (same file, same profile) therefore yields the same ids; a later,
 * separate import sees the previous routines in the profile and gets fresh ids.
 */
export function planImportChanges(
  profile: Profile,
  parsed: ParsedPlan,
  schedule: boolean,
  fingerprint: string,
): ProfileChange[] {
  const beforeRoutines = (profile.routines ?? []).filter(
    (routine): routine is Routine => !!routine && typeof routine.id === 'string',
  );
  const beforeCustom = (profile.customEx ?? []).filter(
    (exercise): exercise is CustomExercise => !!exercise && typeof exercise.id === 'string',
  );
  const beforeRoutineIds = new Set(beforeRoutines.map(routine => routine.id));
  const beforeCustomIds = new Set(beforeCustom.map(exercise => exercise.id));
  const existingRoutineKey = [...beforeRoutineIds].sort().join(',');
  const existingCustomKey = [...beforeCustomIds].sort().join(',');

  const clone: Profile = {
    ...profile,
    unit: unitOf(profile),
    routines: beforeRoutines.map(routine => ({
      ...routine,
      ex: routine.ex?.map(exercise => ({ ...exercise })),
    })),
    customEx: beforeCustom.map(exercise => ({ ...exercise })),
    week: { ...(profile.week ?? {}) },
  };
  mergePlan(clone, parsed, { schedule });

  const newCustom = (clone.customEx ?? []).filter(
    (exercise): exercise is SharedCustomExercise =>
      !!exercise && typeof exercise.id === 'string' && !beforeCustomIds.has(exercise.id),
  );
  const newRoutines = (clone.routines ?? []).filter(
    (routine): routine is SharedRoutine =>
      !!routine && typeof routine.id === 'string' && !beforeRoutineIds.has(routine.id),
  );

  const customMap = new Map<string, string>();
  newCustom.forEach((exercise, index) => {
    customMap.set(exercise.id, importId(
      'ic',
      `${fingerprint}|${exercise.id}|${index}|${existingCustomKey}`,
    ));
  });

  const routineMap = new Map<string, string>();
  newRoutines.forEach((routine, index) => {
    routineMap.set(routine.id, importId(
      'ir',
      `${fingerprint}|${index}|${routine.name ?? ''}|${existingRoutineKey}`,
    ));
  });

  const changes: ProfileChange[] = [];
  for (const exercise of newCustom) {
    changes.push({
      kind: 'custom',
      exercise: {
        ...exercise,
        id: customMap.get(exercise.id) ?? exercise.id,
      },
      create: true,
    });
  }
  for (const routine of newRoutines) {
    changes.push({
      kind: 'routine',
      create: true,
      routine: {
        ...routine,
        id: routineMap.get(routine.id) ?? routine.id,
        ex: (routine.ex ?? []).map(exercise => ({
          ...exercise,
          id: customMap.get(exercise.id) ?? exercise.id,
        })),
      },
    });
  }

  if (schedule) {
    // A rotation profile would keep showing its rotation after the week was
    // replaced. Adopting the shared schedule is an explicit choice, so switch to the
    // fixed week it describes (and drop the rotation queue).
    if (profile.scheduleMode === 'rotation' || profile.queue != null) {
      changes.push({
        kind: 'settings',
        values: { scheduleMode: 'week', rotation: null, queue: null },
      });
    }
    for (let day = 0; day < 7; day += 1) {
      const before = dayIds(profile.week?.[String(day)]);
      const after = dayIds(clone.week?.[String(day)])
        .map(id => routineMap.get(id))
        .filter((id): id is string => typeof id === 'string');
      if (before.join('|') === after.join('|')) continue;
      changes.push({ kind: 'week', day, ids: after });
    }
  }

  return changes;
}
