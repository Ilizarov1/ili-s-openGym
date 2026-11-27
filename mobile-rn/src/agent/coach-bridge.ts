// The RN ↔ Web bridge for the AI Coach.
//
// Everything here is a pure function over the synced profile. The apply/revert engine is a
// TypeScript port of `frontend/src/lib/coach.js`: that module pulls the browser-only i18n shell
// (`import.meta.glob`) into its import graph, which Metro would need shims for and plain Node
// cannot load at all. The data written here (`coach.log`, `coach.snapshots`, `routines`, `week`,
// `dayPlan`) matches it field for field.
//
// `frontend/src/lib/coach-genui-hydration.js` has the same browser-only dependency chain
// (`./i18n.js`), and Expo rewrites `import.meta` to a registry without `glob` — importing it
// would throw while the app boots. The trend/muscle/KPI maths below is therefore a line-for-line
// port of that file (same helpers, same windows, same empty-log behaviour), pinned by
// `scripts/coach-profile-changes.test.mjs`.

import { MAX_COACH_GENUI_TURNS } from '../../../api/agent-runtime/genui/protocol.js';
import { canonicalExId } from '../../../frontend/src/lib/exercises.js';
import { cleanupSg, workoutAt } from '../../../frontend/src/lib/history.js';
import { deleteRoutine } from '../../../frontend/src/lib/routines.js';
import { POLICIES } from '../../../frontend/src/lib/progression.js';
import {
  newProgramme,
  normalizeProgramme,
  programmeById,
  saveProgramme,
} from '../../../frontend/src/lib/programmes.js';
import { uid } from '../../../frontend/src/lib/format.js';
import { t } from '../../../frontend/src/lib/i18n-core.js';
import { snapshotKey } from '../../../frontend/src/lib/sync-merge.js';
import { bestSetOf } from '../../../frontend/src/lib/onerm.js';
import { completedVolumeOf, hasCompletedWork, isWarmupRow } from '../../../frontend/src/lib/workout-model.js';
import { MUSCLES, MUSCLE_NAME, loadOf, rankOf } from '../../../frontend/src/lib/muscles.js';
import { cleanOwnRow } from '../../../frontend/src/lib/warmup-ramp.js';
import { catalogueName } from '../catalogue.js';
import type {
  CoachChatMessage,
  CoachChangeDecision,
  CoachChangeValue,
  CoachGenUINode,
  CoachKpiItem,
  CoachLoadWindow,
  CoachMuscleLoadData,
  CoachProposalChange,
  CoachProseNode,
  CoachRoutineDraft,
  CoachSnapshot,
  CoachState,
  CoachTrendData,
  CoachTrendMetric,
  CoachWarmupRow,
  Profile,
  Routine,
  RoutineExercise,
} from '../training';

/** Bounds copied from `lib/coach.js`; `sync-merge.js` / `api/sync-stamps.js` use the same caps. */
export const COACH_CHAT_MAX = 40;
export const COACH_LOG_MAX = 50;
export const COACH_SNAPSHOT_MAX = 3;
const COACH_NAMESPACE_MAX = 256 * 1024;
const MAX_HISTORY_NDJSON_CHARS = 3600;
/** The shared AG-UI protocol constant (10), so the UI and the server cannot drift. */
export const MAX_GENUI_TURNS = MAX_COACH_GENUI_TURNS;

export type CoachHistoryTurn = { role: 'user' | 'assistant'; content: string };

/** Everything a proposal apply needs; `intentId` makes a sync replay a no-op. */
export type CoachApplyMeta = {
  proposalId?: string | null;
  summary?: string;
  evidence?: unknown;
  notes?: readonly string[];
  acceptedIds?: readonly string[];
  /** After a successful apply, mark this proposal_action node applied. */
  messageId?: string;
  nodeId?: string;
  label?: string;
  now?: number;
  /** `PendingChange.id`; a replay of the same intent is ignored. */
  intentId?: string;
};

export type CoachApplyResult = {
  profile: Profile;
  applied: number;
  rejected: number;
  logId?: string;
  /** The same intent id had already been applied (sync replay). */
  duplicate?: boolean;
};

export type CoachRevertMeta = { now?: number; intentId?: string };
export type CoachRevertResult = {
  profile: Profile;
  reverted: boolean;
  logId?: string;
  duplicate?: boolean;
};

export type CoachProposalRef = { messageId: string; nodeId: string };

export type CoachTrendOptions = { exId: string; metric?: CoachTrendMetric; weeks?: number };
export type CoachMuscleLoadOptions = { window?: CoachLoadWindow; focusMuscles?: string[] };
export type CoachKpiOptions = { items?: CoachKpiItem[] };

/* ============================ small typed readers ============================ */

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function stringOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : fallback;
}

function isPolicy(value: unknown): value is string {
  return typeof value === 'string' && POLICIES.includes(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ============================ chat watermark (L-010) ============================ */

/**
 * Chat lines strictly newer than `chatClearedAt`, trimmed to the synced cap. This is the RN
 * mirror of `lib/coach.js pruneClearedChat`; it is the only read path the UI and the history
 * builder should use, so a cleared thread cannot come back from an older copy.
 */
export function pruneClearedChat(
  chat: readonly CoachChatMessage[] | null | undefined,
  chatClearedAt?: number | null,
): CoachChatMessage[] {
  const list = Array.isArray(chat) ? chat.filter(Boolean) : [];
  const clearedAt = Number(chatClearedAt) || 0;
  const kept = clearedAt > 0 ? list.filter(message => (Number(message?.at) || 0) > clearedAt) : list;
  return kept.length > COACH_CHAT_MAX ? kept.slice(-COACH_CHAT_MAX) : kept;
}

/** How many free-form questions this conversation has used (the 10-turn limit). */
export function countGenUITurns(
  chat: readonly CoachChatMessage[] | null | undefined,
  chatClearedAt?: number | null,
): number {
  return pruneClearedChat(chat, chatClearedAt)
    .filter(message => message.role === 'user' && (message.kind == null || message.kind === 'text'))
    .length;
}

/**
 * Raise the watermark to at least `floorClearedAt`, prune anything at or below the result and
 * cap the list. Used on every local update, on adopting a server copy and when reading SQLite,
 * so "New conversation" can never be undone by an older snapshot.
 */
export function guardClearedChat(profile: Profile, floorClearedAt = 0): Profile {
  const coach = profile.coach;
  const own = Number(coach?.chatClearedAt) || 0;
  const floor = Number(floorClearedAt) || 0;
  const clearedAt = Math.max(own, floor);
  const list = Array.isArray(coach?.chat) ? coach.chat.filter(Boolean) : [];
  const kept = clearedAt > 0 ? list.filter(message => (Number(message?.at) || 0) > clearedAt) : list;
  const capped = kept.length > COACH_CHAT_MAX ? kept.slice(-COACH_CHAT_MAX) : kept;

  if (!coach) {
    return clearedAt > 0
      ? { ...profile, coach: { chatClearedAt: clearedAt, chat: [] } }
      : profile;
  }
  const unchanged = own === clearedAt && (!Array.isArray(coach.chat) || capped.length === list.length);
  if (unchanged) return profile;
  return {
    ...profile,
    coach: {
      ...coach,
      ...(clearedAt > 0 ? { chatClearedAt: clearedAt } : {}),
      chat: capped,
    },
  };
}

/** Append one message idempotently. A message from before the watermark is dropped, never revived. */
export function applyCoachChatAppend(profile: Profile, message: CoachChatMessage): Profile {
  if (!message || typeof message.id !== 'string' || message.id === '') return profile;
  const coach = profile.coach ?? {};
  const clearedAt = Number(coach.chatClearedAt) || 0;
  const list = Array.isArray(coach.chat) ? coach.chat.filter(Boolean) : [];
  if (list.some(existing => existing?.id === message.id)) return profile;
  const at = Number(message.at) || 0;
  // A queued append that predates "New conversation" must not resurrect what was cleared.
  if (clearedAt > 0 && at > 0 && at <= clearedAt) return profile;
  const nextAt = at > 0 ? at : Math.max(Date.now(), clearedAt + 1);
  const base = pruneClearedChat(list, clearedAt);
  // Web persists the assistant as `role: 'coach'` and keys rendering off `kind`; normalise the
  // phone's friendlier input once, here, so a chat started in RN renders in the browser.
  const role = message.role === 'assistant' ? 'coach' : message.role;
  const kind = message.kind ?? (role === 'user'
    ? 'text'
    : (Array.isArray(message.nodes) && message.nodes.length) || (Array.isArray(message.blocks) && message.blocks.length)
      ? 'genui'
      : 'text');
  const chat = [...base, { ...message, role, kind, at: nextAt }].slice(-COACH_CHAT_MAX);
  return {
    ...profile,
    coach: {
      ...coach,
      ...(clearedAt > 0 ? { chatClearedAt: clearedAt } : {}),
      chat,
    },
  };
}

/**
 * Start a new conversation: monotonically advance `chatClearedAt` to at least the requested
 * instant and the newest stored line, then empty the list. Plan, log, snapshots and consent are
 * untouched, exactly like Web `clearChat`.
 */
export function applyCoachChatClear(profile: Profile, at?: number): Profile {
  const coach = profile.coach ?? {};
  const requested = Number(at);
  const prev = Number(coach.chatClearedAt) || 0;
  const latest = (coach.chat ?? []).reduce(
    (max, message) => Math.max(max, Number(message?.at) || 0),
    0,
  );
  const clearedAt = Math.max(prev, Number.isFinite(requested) ? requested : Date.now(), latest);
  if (clearedAt === prev && (coach.chat?.length ?? 0) === 0) return profile;
  return { ...profile, coach: { ...coach, chatClearedAt: clearedAt, chat: [] } };
}

/** Mark one `proposal_action` node as applied; idempotent by message + node id. */
export function applyCoachProposalApplied(profile: Profile, ref: CoachProposalRef): Profile {
  const coach = profile.coach;
  if (!coach || !Array.isArray(coach.chat)) return profile;
  const messageIndex = coach.chat.findIndex(message => message?.id === ref.messageId);
  if (messageIndex < 0) return profile;
  const message = coach.chat[messageIndex];
  const nodes = Array.isArray(message?.nodes) ? message.nodes : [];
  const nodeIndex = nodes.findIndex(node => node?.id === ref.nodeId && node.type === 'proposal_action');
  if (nodeIndex < 0) return profile;
  const node = nodes[nodeIndex];
  if (node.type !== 'proposal_action' || node.applied === true) return profile;

  const nextNodes = nodes.map((item, index) => index === nodeIndex
    ? { ...item, applied: true }
    : item);
  const nextChat = coach.chat.map((item, index) => index === messageIndex
    ? { ...message, nodes: nextNodes }
    : item);
  return { ...profile, coach: { ...coach, chat: nextChat } };
}

/* ============================ GenUI history (NDJSON, L-009) ============================ */

function messageNodes(message: CoachChatMessage): CoachGenUINode[] {
  if (Array.isArray(message.nodes) && message.nodes.length) return message.nodes;
  if (Array.isArray(message.blocks) && message.blocks.length) return message.blocks;
  return [];
}

function compactChangeAfter(change: CoachProposalChange): CoachChangeValue | undefined {
  const after = change.after;
  if (change.type !== 'add-routine' || !after || typeof after !== 'object' || Array.isArray(after)) {
    return after;
  }
  const draft = after as CoachRoutineDraft;
  const exercises = Array.isArray(draft.ex) ? draft.ex : [];
  return {
    name: draft.name,
    ...(draft.emoji ? { emoji: draft.emoji } : {}),
    ...(Array.isArray(draft.weekdays) && draft.weekdays.length ? { weekdays: draft.weekdays } : {}),
    ex: exercises
      .filter(exercise => exercise && typeof exercise === 'object')
      .map(exercise => ({
        id: exercise.id,
        ...(exercise.sets != null ? { sets: exercise.sets } : {}),
        ...(exercise.mode ? { mode: exercise.mode } : {}),
        ...(exercise.reps != null ? { reps: exercise.reps } : {}),
        ...(exercise.repsMin != null ? { repsMin: exercise.repsMin } : {}),
        ...(exercise.repsMax != null ? { repsMax: exercise.repsMax } : {}),
        ...(exercise.sec != null ? { sec: exercise.sec } : {}),
        ...(exercise.min != null ? { min: exercise.min } : {}),
      })),
  };
}

/** Compact one node to the model's own output schema; never a bracketed human summary. */
function compactHistoryNode(node: CoachGenUINode, index: number): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || !node.type) return null;
  const id = String(node.id || `n_${index + 1}`);
  switch (node.type) {
    case 'prose': {
      const text = String(node.text || '').trim();
      return text ? { id, type: 'prose', ...(node.tone ? { tone: node.tone } : {}), text } : null;
    }
    case 'proposal_action':
      return {
        id,
        type: 'proposal_action',
        title: String(node.title || ''),
        ...(node.summary ? { summary: String(node.summary) } : {}),
        ...(node.routineId ? { routineId: String(node.routineId) } : {}),
        ...(node.applied ? { applied: true } : {}),
        changes: (Array.isArray(node.changes) ? node.changes : []).map(change => ({
          id: change.id,
          type: change.type,
          target: change.target,
          ...(change.before !== undefined ? { before: change.before } : {}),
          ...(change.after !== undefined ? { after: compactChangeAfter(change) } : {}),
          ...(change.why ? { why: change.why } : {}),
        })),
      };
    case 'exercise_trend':
      return {
        id,
        type: 'exercise_trend',
        exId: node.exId,
        metric: node.metric || 'e1rm',
        weeks: node.weeks || 8,
      };
    case 'muscle_load':
      return {
        id,
        type: 'muscle_load',
        window: node.window || '72h',
        ...(Array.isArray(node.focusMuscles) && node.focusMuscles.length
          ? { focusMuscles: node.focusMuscles }
          : {}),
      };
    case 'kpi_strip':
      return { id, type: 'kpi_strip', items: Array.isArray(node.items) ? node.items : [] };
    case 'comparison_table':
      return {
        id,
        type: 'comparison_table',
        ...(node.title ? { title: node.title } : {}),
        columns: Array.isArray(node.columns) ? node.columns : [],
        rows: Array.isArray(node.rows) ? node.rows : [],
      };
    case 'callout':
      return {
        id,
        type: 'callout',
        variant: node.variant || 'info',
        ...(node.title ? { title: node.title } : {}),
        text: String(node.text || ''),
      };
    case 'exercise_alternatives':
      return {
        id,
        type: 'exercise_alternatives',
        ...(node.forExId ? { forExId: node.forExId } : {}),
        ...(node.routineId ? { routineId: node.routineId } : {}),
        items: (Array.isArray(node.items) ? node.items : [])
          .filter(item => item && item.exId)
          .map(item => ({ exId: item.exId, ...(item.reason ? { reason: item.reason } : {}) })),
      };
    case 'quick_form':
      return {
        id,
        type: 'quick_form',
        formId: node.formId,
        title: node.title,
        fields: node.fields || [],
      };
    case 'fallback_notice':
      return node.text ? { id, type: 'fallback_notice', text: String(node.text) } : null;
    case 'checklist':
      // v2.1 read-only legacy; the live schema has no checklist node.
      return null;
  }
}

function serializeGenUIMessageNdjson(message: CoachChatMessage): string {
  const lines: string[] = [];
  let total = 0;
  const nodes = messageNodes(message);
  if (!nodes.length && message.text) {
    const prose: CoachProseNode = { id: 'prose_1', type: 'prose', text: String(message.text) };
    const line = JSON.stringify(prose);
    return line;
  }
  for (let index = 0; index < nodes.length; index++) {
    const compact = compactHistoryNode(nodes[index], index);
    if (!compact) continue;
    const line = JSON.stringify(compact);
    if (lines.length && total + line.length + 1 > MAX_HISTORY_NDJSON_CHARS) break;
    lines.push(line);
    total += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * The conversation as `{ role, content }` turns, every assistant turn serialized as strict
 * NDJSON (one compact node per line). Sending prior replies any other way teaches the model to
 * imitate bracketed pseudo-text, which is exactly the L-009 regression.
 */
export function buildGenUIHistory(
  chat: readonly CoachChatMessage[] | null | undefined,
  chatClearedAt?: number | null,
): CoachHistoryTurn[] {
  const out: CoachHistoryTurn[] = [];
  for (const message of pruneClearedChat(chat, chatClearedAt)) {
    if (!message || typeof message !== 'object') continue;
    if (message.kind === 'error' || message.kind === 'intake') continue;
    const isCoach = message.role === 'coach' || message.role === 'assistant';
    if (message.role === 'user' && (message.kind == null || message.kind === 'text')) {
      const content = String(message.text || '').trim();
      if (content) out.push({ role: 'user', content });
      continue;
    }
    if (isCoach && (message.kind === 'genui' || messageNodes(message).length > 0)) {
      const content = serializeGenUIMessageNdjson(message);
      if (content) out.push({ role: 'assistant', content });
      continue;
    }
    if (isCoach && (message.kind == null || ['text', 'nochange', 'reverted', 'applied', 'dismissed', 'debrief'].includes(message.kind))) {
      const text = String(message.text || '').trim();
      if (text) {
        out.push({
          role: 'assistant',
          content: JSON.stringify({ id: 'prose_1', type: 'prose', text }),
        });
      }
    }
  }
  return out;
}

/* ============================ localized names ============================ */

/**
 * The name a card should print for an exercise id: the profile's own custom exercise first
 * (imported `xunji-ex-*` records carry their edited `n`/`name`), then the RN catalogue, then the
 * raw id so a card never renders blank.
 */
export function resolveExerciseName(
  exId: string,
  profile?: Pick<Profile, 'customEx'> | null,
): string {
  if (typeof exId !== 'string' || exId === '') return '';
  const custom = (profile?.customEx ?? []).find(exercise => exercise && exercise.id === exId);
  const customName = custom?.n ?? custom?.name;
  if (typeof customName === 'string' && customName.trim() !== '') return customName;
  const name = catalogueName(exId);
  return typeof name === 'string' && name !== '' ? name : exId;
}

/* ============================ hydration (pure port) ============================ */

const round1 = (value: unknown): number => Math.round(Number(value) * 10) / 10;

const WINDOW_DAYS: Record<CoachLoadWindow, number> = { '72h': 3, '7d': 7, '28d': 28 };

const muscleLabel = (muscle: string): string => {
  const names = MUSCLE_NAME as Record<string, string>;
  return names[muscle] || muscle;
};

function workoutsInWindow(profile: Profile, days: number) {
  const timed = (profile.workouts ?? [])
    .map(workout => ({ workout, at: workoutAt(workout) as number }))
    .filter(item => Number.isFinite(item.at));
  if (!timed.length) return [];
  const anchor = Math.max(...timed.map(item => item.at));
  const from = anchor - days * 86400000;
  return timed.filter(item => item.at >= from && item.at <= anchor);
}

function entriesOf(workout: { entries?: { id?: string }[] }, exId: string) {
  return (workout.entries ?? []).filter(entry => entry && entry.id === exId) as {
    id?: string;
    sets?: { w?: number; done?: boolean }[];
    [key: string]: unknown;
  }[];
}

/** Top completed work weight in one entry, warm-ups and unticked rows excluded. */
function topWeightOf(entry: { sets?: { w?: number; done?: boolean }[] }): number {
  let top = 0;
  for (const set of entry.sets ?? []) {
    if (!hasCompletedWork(set) || isWarmupRow(set)) continue;
    const weight = Number(set.w) || 0;
    if (weight > top) top = weight;
  }
  return top;
}

/**
 * One lift's trend from the real log. Ported from `coach-genui-hydration.js` so the RN bundle
 * never touches the browser-only i18n shell; names come from the RN catalogue instead.
 */
export function hydrateCoachTrend(profile: Profile, options: CoachTrendOptions): CoachTrendData {
  const exId = options.exId;
  const span = Number.isFinite(Number(options.weeks)) && Number(options.weeks) > 0
    ? Number(options.weeks)
    : 8;
  const metric: CoachTrendMetric = options.metric === 'weight' || options.metric === 'volume'
    ? options.metric
    : 'e1rm';
  const points = workoutsInWindow(profile, span * 7)
    .map(({ workout, at }) => {
      const entries = entriesOf(workout, exId);
      if (!entries.length) return null;
      let y: number | null = null;
      if (metric === 'e1rm') {
        for (const entry of entries) {
          const best = bestSetOf(entry) as { est: number } | null;
          if (best && (y == null || best.est > y)) y = best.est;
        }
      } else if (metric === 'weight') {
        for (const entry of entries) {
          const weight = topWeightOf(entry);
          if (weight > 0 && (y == null || weight > y)) y = weight;
        }
      } else {
        y = entries.reduce((sum, entry) => sum + (entry.sets ?? [])
          .reduce((count, set) => count + (isWarmupRow(set) ? 0 : Number(completedVolumeOf(set))), 0), 0);
        if (!(y > 0)) y = null;
      }
      return y == null ? null : { t: at, d: workout.d || null, y: round1(y) };
    })
    .filter((point): point is { t: number; d: string | null; y: number } => point != null)
    .sort((a, b) => a.t - b.t);

  const sessions = points.length;
  const first = sessions ? points[0].y : null;
  const last = sessions ? points[sessions - 1].y : null;
  const delta = sessions ? round1(last! - first!) : null;
  const pct = sessions && first ? Math.round((last! - first!) / first * 100) : 0;
  const stalled = sessions >= 3 &&
    !(points[sessions - 1].y > points[sessions - 2].y) &&
    !(points[sessions - 2].y > points[sessions - 3].y);

  return {
    exId,
    name: resolveExerciseName(exId, profile) || String(exId || ''),
    metric,
    weeks: span,
    points,
    sessions,
    first,
    last,
    delta,
    pct,
    stalled,
  };
}

/** Effective work-set load per muscle over a window, from finished workouts only. */
export function hydrateCoachMuscleLoad(
  profile: Profile,
  options: CoachMuscleLoadOptions = {},
): CoachMuscleLoadData {
  const key: CoachLoadWindow = options.window && WINDOW_DAYS[options.window] ? options.window : '72h';
  const timed = workoutsInWindow(profile, WINDOW_DAYS[key]);
  const load = loadOf(timed.flatMap(({ workout }) => (workout.entries ?? []).map(entry => ({
    id: entry.id,
    ex: (entry as { exercise?: unknown }).exercise ?? entry,
    sets: (entry.sets ?? []).filter(set => hasCompletedWork(set) && !isWarmupRow(set)).length,
  })))) as Record<string, number>;
  const totalSets = timed.reduce((sum, { workout }) => sum + (workout.entries ?? [])
    .reduce((count, entry) => count + (entry.sets ?? [])
      .filter(set => hasCompletedWork(set) && !isWarmupRow(set)).length, 0), 0);
  const asked = (options.focusMuscles ?? []).filter(muscle => MUSCLES.includes(muscle));
  const focus: string[] = asked.length
    ? asked
    : (((rankOf(load) as { worked?: string[] }).worked) ?? []).slice(0, 5);
  return {
    window: key,
    load,
    focusSummary: focus.map(muscle => ({
      muscle,
      label: muscleLabel(muscle),
      sets: round1(load[muscle] || 0),
    })),
    totalSets,
    sessions: timed.length,
  };
}

/** KPI strip values from the local log; nothing is ever named `NaN`. */
export function hydrateCoachKpi(profile: Profile, options: CoachKpiOptions = {}): { items: CoachKpiItem[] } {
  const items: CoachKpiItem[] = [];
  for (const item of Array.isArray(options.items) ? options.items : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.kind === 'exercise_stat') {
      const trend = hydrateCoachTrend(profile, {
        exId: item.exId,
        metric: item.metric ?? 'e1rm',
        weeks: item.weeks ?? 6,
      });
      items.push({
        kind: 'exercise_stat',
        exId: item.exId,
        metric: trend.metric,
        weeks: trend.weeks,
        label: item.label || trend.name || String(item.exId || ''),
        value: trend.last,
        unit: profile.unit ?? 'kg',
        delta: trend.delta,
        pct: trend.pct,
        stalled: trend.stalled,
        sessions: trend.sessions,
        hasData: trend.last != null,
      });
      continue;
    }
    if (item.kind === 'muscle_sets') {
      const hydrated = hydrateCoachMuscleLoad(profile, {
        window: item.window ?? '72h',
        focusMuscles: item.muscle ? [item.muscle] : [],
      });
      items.push({
        kind: 'muscle_sets',
        muscle: item.muscle,
        window: hydrated.window,
        label: item.label || muscleLabel(item.muscle) || '',
        value: round1(hydrated.load[item.muscle] || 0),
        sessions: hydrated.sessions,
        hasData: hydrated.sessions > 0,
      });
      continue;
    }
    if (item.kind === 'session_count') {
      const raw = Number(item.weeks);
      const span = Number.isFinite(raw) && raw > 0 ? raw : 4;
      const count = workoutsInWindow(profile, span * 7).length;
      items.push({
        kind: 'session_count',
        weeks: span,
        label: item.label || '',
        value: count,
        hasData: count > 0,
      });
      continue;
    }
    if (item.kind === 'prescription') {
      items.push({
        kind: 'prescription',
        label: String(item.label || ''),
        value: String(item.value ?? ''),
        hasData: Boolean(item.value != null && String(item.value).trim()),
      });
    }
  }
  return { items };
}

/** Hydrate one node in place (the Phase 2 renderer's single entry point). */
export function hydrateCoachNode(profile: Profile, node: CoachGenUINode): CoachGenUINode {
  if (node.type === 'exercise_trend') {
    return {
      ...node,
      data: hydrateCoachTrend(profile, {
        exId: node.exId,
        ...(node.metric ? { metric: node.metric } : {}),
        ...(node.weeks ? { weeks: node.weeks } : {}),
      }),
    };
  }
  if (node.type === 'muscle_load') {
    return {
      ...node,
      data: hydrateCoachMuscleLoad(profile, {
        ...(node.window ? { window: node.window } : {}),
        ...(node.focusMuscles ? { focusMuscles: node.focusMuscles } : {}),
      }),
    };
  }
  if (node.type === 'kpi_strip') {
    return { ...node, items: hydrateCoachKpi(profile, { items: node.items }).items };
  }
  return node;
}

/* ============================ the Coach namespace ============================ */

function coachOf(profile: Profile): CoachState {
  if (!profile.coach || typeof profile.coach !== 'object') profile.coach = {};
  return profile.coach;
}

function findRoutine(profile: Profile, id?: string): Routine | null {
  return (profile.routines ?? []).find(routine => routine?.id === id) ?? null;
}

function routineOf(profile: Profile, id?: string): Routine {
  const routine = findRoutine(profile, id);
  if (!routine) throw new Error('missing target');
  return routine;
}

function exercisesOf(routine: Routine): RoutineExercise[] {
  if (!Array.isArray(routine.ex)) routine.ex = [];
  return routine.ex;
}

function exerciseOf(profile: Profile, change: CoachProposalChange): RoutineExercise {
  const routine = routineOf(profile, change.target?.routineId);
  const exercise = exercisesOf(routine).find(item => item?.id === change.target?.exId);
  if (!exercise) throw new Error('missing target');
  return exercise;
}

function recordDayPlanDrops(profile: Profile, dropped: Record<string, string>): void {
  if (!Object.keys(dropped).length) return;
  const snapshots = profile.coach?.snapshots ?? [];
  const snapshot = snapshots[snapshots.length - 1];
  if (!snapshot) return;
  snapshot.dayPlanRestore = { ...dropped, ...(snapshot.dayPlanRestore ?? {}) };
}

function trim(profile: Profile): void {
  const coach = coachOf(profile);
  let guard = 0;
  while (JSON.stringify(coach).length > COACH_NAMESPACE_MAX && guard++ < 60) {
    if ((coach.chat ?? []).length > 8) coach.chat?.shift();
    else if ((coach.snapshots ?? []).length > 1) coach.snapshots?.shift();
    else if ((coach.log ?? []).length > 1) coach.log?.shift();
    else break;
  }
}

function pushSnapshot(
  profile: Profile,
  proposalId: string | null,
  label: string,
  now: number,
): void {
  const coach = coachOf(profile);
  const snapshot: CoachSnapshot = {
    at: now,
    proposalId: proposalId || null,
    label: label || '',
    routines: clone(profile.routines ?? []),
    week: clone(profile.week ?? {}),
  };
  coach.snapshots = [...(coach.snapshots ?? []), snapshot].slice(-COACH_SNAPSHOT_MAX);
  trim(profile);
}

function appendLog(
  profile: Profile,
  entry: Omit<CoachChangeLogInput, 'id'> & { id?: string },
): string {
  const coach = coachOf(profile);
  const id = entry.id ?? uid();
  coach.log = [...(coach.log ?? []), { ...entry, id } as CoachChangeLogInput].slice(-COACH_LOG_MAX);
  trim(profile);
  return id;
}

type CoachChangeLogInput = {
  id: string;
  kind: string;
  at: number;
  proposalId?: string | null;
  summary?: string;
  evidence?: unknown;
  notes?: string[];
  decisions?: CoachChangeDecision[];
  snap?: string | null;
  changeId?: string;
};

function decisionOf(change: CoachProposalChange, status: CoachChangeDecision['status']): CoachChangeDecision {
  return {
    id: change.id,
    type: change.type,
    target: change.target ?? null,
    before: change.before ?? null,
    after: change.after ?? null,
    why: change.why ?? '',
    routineName: change.routineName ?? null,
    status,
  };
}

/* ============================ applying a change-set ============================ */

function applyOneChange(profile: Profile, change: CoachProposalChange): void {
  const target = change.target ?? {};
  switch (change.type) {
    case 'add-exercise': {
      const routine = routineOf(profile, target.routineId);
      const after = recordOf(change.after);
      const mode = stringOf(after.mode, 'reps');
      const exercise: RoutineExercise = {
        id: canonicalExId(stringOf(after.id)),
        sets: numberOr(after.sets, 3),
        mode,
      };
      if (mode === 'cardio') {
        exercise.min = numberOr(after.min, 20);
        exercise.speed = numberOr(after.speed, 8);
      } else if (mode === 'time') {
        exercise.sec = numberOr(after.sec, 45);
      } else {
        exercise.reps = after.reps != null && after.reps !== '' ? after.reps as number | string : 10;
      }
      if (Number(after.weight) > 0) exercise.weight = Number(after.weight);
      if (isPolicy(after.prog)) exercise.prog = String(after.prog);
      if (Number.isInteger(after.repsMin)) exercise.repsMin = Number(after.repsMin);
      if (Number.isInteger(after.repsMax)) exercise.repsMax = Number(after.repsMax);
      if (Number.isInteger(after.setsMax)) exercise.setsMax = Number(after.setsMax);
      if (after.bodyweight != null) exercise.bodyweight = after.bodyweight === true;
      if (after.side === true) exercise.side = true;
      const list = exercisesOf(routine);
      const at = Number.isInteger(after.position) ? Math.min(Number(after.position), list.length) : list.length;
      list.splice(at, 0, exercise);
      cleanupSg(list);
      break;
    }
    case 'remove-exercise': {
      const routine = routineOf(profile, target.routineId);
      routine.ex = exercisesOf(routine).filter(exercise => exercise.id !== target.exId);
      cleanupSg(routine.ex);
      break;
    }
    case 'swap-exercise': {
      const routine = routineOf(profile, target.routineId);
      const list = exercisesOf(routine);
      const index = list.findIndex(exercise => exercise.id === target.exId);
      if (index < 0) throw new Error('missing exercise');
      const old = list[index];
      const after = recordOf(change.after);
      const { bodyweight: _bodyweight, side: _side, ...keep } = old;
      list[index] = {
        ...keep,
        id: canonicalExId(stringOf(after.id)),
        ...(after.sets ? { sets: Number(after.sets) } : {}),
        ...(after.reps ? { reps: after.reps as number | string } : {}),
        ...(Number(after.weight) > 0 ? { weight: Number(after.weight) } : {}),
      };
      break;
    }
    case 'sets':
      exerciseOf(profile, change).sets = change.after as number;
      break;
    case 'reps':
      exerciseOf(profile, change).reps = change.after as number | string;
      break;
    case 'repsMin':
      exerciseOf(profile, change).repsMin = change.after as number;
      break;
    case 'repsMax':
      exerciseOf(profile, change).repsMax = change.after as number;
      break;
    case 'sec':
      exerciseOf(profile, change).sec = change.after as number;
      break;
    case 'cardio': {
      const exercise = exerciseOf(profile, change);
      const after = recordOf(change.after);
      if (after.min != null) exercise.min = Number(after.min);
      if (after.speed != null) exercise.speed = Number(after.speed);
      break;
    }
    case 'inc':
      exerciseOf(profile, change).inc = change.after as number;
      break;
    case 'exercise-prog':
      exerciseOf(profile, change).prog = change.after as string;
      break;
    case 'routine-prog':
      routineOf(profile, target.routineId).prog = change.after as string;
      break;
    case 'reorder': {
      const routine = routineOf(profile, target.routineId);
      const list = exercisesOf(routine);
      const ids = change.after;
      if (!Array.isArray(ids)) throw new Error('incomplete reorder');
      const byId = new Map(list.map(exercise => [exercise.id, exercise]));
      const next = ids.map(id => byId.get(String(id))).filter((exercise): exercise is RoutineExercise => !!exercise);
      if (next.length !== list.length || new Set(next).size !== list.length) {
        throw new Error('incomplete reorder');
      }
      routine.ex = next;
      cleanupSg(routine.ex);
      break;
    }
    case 'superset': {
      const routine = routineOf(profile, target.routineId);
      const list = exercisesOf(routine);
      const index = list.findIndex(exercise => exercise.id === target.exId);
      if (index < 0) throw new Error('missing exercise');
      const after = recordOf(change.after);
      if (!after.link) {
        delete list[index].sg;
        cleanupSg(list);
        break;
      }
      if (after.with === target.exId) throw new Error('superset with itself');
      const partnerIndex = list.findIndex(exercise => exercise.id === after.with);
      if (partnerIndex < 0) throw new Error('missing partner');
      const [partner] = list.splice(partnerIndex, 1);
      const anchor = list.findIndex(exercise => exercise.id === target.exId);
      list.splice(anchor + 1, 0, partner);
      const tag = uid().slice(0, 6);
      list[anchor].sg = tag;
      list[anchor + 1].sg = tag;
      break;
    }
    case 'add-routine': {
      const after = recordOf(change.after);
      if (!Array.isArray(after.ex)) throw new Error('bad routine');
      const id = uid();
      const exercises = arrayOf<Record<string, unknown>>(after.ex).map(exercise => {
        const mode = stringOf(exercise.mode, 'reps');
        const planned: RoutineExercise = {
          id: canonicalExId(stringOf(exercise.id)),
          sets: numberOr(exercise.sets, 3),
          mode,
        };
        if (mode === 'cardio') {
          planned.min = numberOr(exercise.min, 20);
          planned.speed = numberOr(exercise.speed, 8);
        } else if (mode === 'time') {
          planned.sec = numberOr(exercise.sec, 45);
        } else {
          planned.reps = exercise.reps != null && exercise.reps !== ''
            ? exercise.reps as number | string
            : 10;
        }
        if (Number.isInteger(exercise.repsMin)) planned.repsMin = Number(exercise.repsMin);
        if (Number.isInteger(exercise.repsMax)) planned.repsMax = Number(exercise.repsMax);
        if (Number.isInteger(exercise.setsMax)) planned.setsMax = Number(exercise.setsMax);
        if (isPolicy(exercise.prog)) planned.prog = String(exercise.prog);
        if (exercise.bodyweight != null) planned.bodyweight = exercise.bodyweight === true;
        if (exercise.side === true) planned.side = true;
        return planned;
      });
      profile.routines = profile.routines ?? [];
      profile.routines.push({
        id,
        name: stringOf(after.name),
        emoji: stringOf(after.emoji) || '🏋️',
        ...(isPolicy(after.prog) ? { prog: String(after.prog) } : {}),
        ex: exercises,
      });
      const weekdays = arrayOf<unknown>(after.weekdays).map(Number)
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
      if (weekdays.length) {
        if (!profile.week || typeof profile.week !== 'object') profile.week = {};
        for (const day of weekdays) profile.week[String(day)] = [id];
      }
      break;
    }
    case 'remove-routine': {
      const dropped = deleteRoutine(profile, target.routineId) as Record<string, string>;
      recordDayPlanDrops(profile, dropped);
      break;
    }
    case 'rename-routine':
      routineOf(profile, target.routineId).name = typeof change.after === 'string'
        ? change.after
        : String(change.after ?? '');
      break;
    case 'week': {
      const day = target.weekday;
      if (!Number.isInteger(day)) throw new Error('bad weekday');
      if (!profile.week || typeof profile.week !== 'object') profile.week = {};
      const key = String(day);
      if (change.after == null || change.after === 'rest') delete profile.week[key];
      else profile.week[key] = [String(change.after)];
      break;
    }
    case 'warmup': {
      const exercise = exerciseOf(profile, change);
      const after = recordOf(change.after);
      const mode = stringOf(after.mode);
      if (mode !== 'auto' && mode !== 'own' && mode !== 'none') throw new Error('bad warm-up');
      const rows = mode === 'own'
        ? arrayOf<Record<string, unknown>>(after.rows)
          .map(row => cleanOwnRow(row) as CoachWarmupRow | null)
          .filter((row): row is CoachWarmupRow => row != null)
          .slice(0, 5)
        : [];
      if (mode === 'own' && !rows.length) throw new Error('bad warm-up');
      delete exercise.warmupSets;
      exercise.warmup = mode;
      if (rows.length) exercise.warmupRows = rows;
      else delete exercise.warmupRows;
      break;
    }
    case 'programme': {
      const after = recordOf(change.after);
      const weeks = arrayOf<Record<string, unknown>>(after.weeks);
      if (!weeks.length) throw new Error('bad programme');
      const id = target.programmeId;
      const was = id ? programmeById(profile, id) : null;
      if (id && !was) throw new Error('missing programme');
      const base = was ?? newProgramme(
        profile,
        String(after.name ?? t('Coach programme')).slice(0, 60),
        weeks.length,
      );
      const next = normalizeProgramme({
        ...base,
        ...(after.name ? { name: String(after.name).slice(0, 60) } : {}),
        weeks,
      });
      if (!next) throw new Error('bad programme');
      const snapshots = coachOf(profile).snapshots ?? [];
      const snapshot = snapshots[snapshots.length - 1];
      if (snapshot && !snapshot.programmeRestore) {
        const programmes = recordOf(profile['programmes']);
        snapshot.programmeRestore = {
          id: String(next.id),
          prev: was ? clone(programmes[String(next.id)] ?? null) : null,
        };
      }
      saveProgramme(profile, next);
      break;
    }
  }
}

/**
 * Apply the accepted subset atomically (the RN port of `applyChangeSet`). A failure anywhere
 * discards the whole draft, so a half-applied proposal never reaches SQLite or sync.
 */
export function applyCoachProposal(
  profile: Profile,
  changes: readonly CoachProposalChange[],
  meta: CoachApplyMeta = {},
): CoachApplyResult {
  const now = Number.isFinite(meta.now) ? Number(meta.now) : Date.now();
  if (meta.intentId && (profile.coach?.log ?? []).some(entry => entry?.changeId === meta.intentId)) {
    return { profile, applied: 0, rejected: 0, duplicate: true };
  }
  const acceptedIds = new Set(meta.acceptedIds ?? changes.map(change => change.id));
  const accepted = changes.filter(change => acceptedIds.has(change.id) && change.status !== 'stale');
  if (!accepted.length) return { profile, applied: 0, rejected: changes.length };

  try {
    const draft = clone(profile);
    pushSnapshot(
      draft,
      meta.proposalId ?? null,
      meta.label ?? t('Before the Coach’s changes'),
      now,
    );
    const decisions: CoachChangeDecision[] = [];
    for (const change of accepted) {
      applyOneChange(draft, change);
      decisions.push(decisionOf(change, 'accepted'));
    }
    const rejected = changes
      .filter(change => !acceptedIds.has(change.id) || change.status === 'stale')
      .map(change => decisionOf(change, change.status === 'stale' ? 'stale' : 'rejected'));
    const logId = appendLog(draft, {
      kind: 'review',
      at: now,
      ...(meta.intentId ? { changeId: meta.intentId } : {}),
      proposalId: meta.proposalId ?? null,
      summary: meta.summary ?? '',
      evidence: meta.evidence ?? null,
      notes: [...(meta.notes ?? [])],
      decisions: [...decisions, ...rejected],
    });
    coachOf(draft).lastReview = { at: now };
    const next = meta.messageId && meta.nodeId
      ? applyCoachProposalApplied(draft, { messageId: meta.messageId, nodeId: meta.nodeId })
      : draft;
    return { profile: next, applied: accepted.length, rejected: rejected.length, logId };
  } catch {
    // Atomic: the original profile was never touched.
    return { profile, applied: 0, rejected: changes.length };
  }
}

/** Put `routines` and `week` back from the newest undo snapshot (the port of `revertLast`). */
export function revertLastCoachChanges(profile: Profile, meta: CoachRevertMeta = {}): CoachRevertResult {
  const now = Number.isFinite(meta.now) ? Number(meta.now) : Date.now();
  if (meta.intentId && (profile.coach?.log ?? []).some(entry => entry?.changeId === meta.intentId)) {
    return { profile, reverted: false, duplicate: true };
  }
  if (!(profile.coach?.snapshots ?? []).length) return { profile, reverted: false };

  const draft = clone(profile);
  const coach = coachOf(draft);
  const snapshot = (coach.snapshots ?? []).pop();
  if (!snapshot) return { profile, reverted: false };

  draft.routines = clone(snapshot.routines ?? []);
  draft.week = clone(snapshot.week ?? {});
  if (snapshot.dayPlanRestore) {
    draft.dayPlan = { ...(draft.dayPlan ?? {}), ...clone(snapshot.dayPlanRestore) };
  }
  if (snapshot.rotationRestore) {
    draft.rotation = clone(snapshot.rotationRestore.rotation ?? null);
    draft.queue = clone(snapshot.rotationRestore.queue ?? null);
  }
  if (snapshot.programmeRestore?.id) {
    const programmeId = snapshot.programmeRestore.id;
    const all = { ...recordOf(draft['programmes']) };
    if (snapshot.programmeRestore.prev) all[programmeId] = clone(snapshot.programmeRestore.prev);
    else if (recordOf(draft['programme']).id !== programmeId) delete all[programmeId];
    draft['programmes'] = all;
  }
  const logId = appendLog(draft, {
    kind: 'revert',
    at: now,
    ...(meta.intentId ? { changeId: meta.intentId } : {}),
    proposalId: snapshot.proposalId ?? null,
    snap: snapshotKey(snapshot),
    summary: t('Reverted the last Coach changes.'),
  });
  return { profile: draft, reverted: true, logId };
}

/** Whether the menu's "Undo the Coach's last change" has anything to undo. */
export function canRevertCoach(profile: Profile): boolean {
  return (profile.coach?.snapshots ?? []).length > 0;
}
