/**
 * 体重页的数据层：复用上游 `weigh-ins.js` / `bodyweight.js` 的读数、日值和周趋势规则。
 *
 * 存储规则（与 Web 一致）：
 * - `Profile.bodyweight[]` 每天一项；有 `ins` 时每笔读数带稳定 id、`HH:MM` 和单位内的重量。
 * - 没有 `ins` 的旧记录仍按一笔读数（id `0`）读取，可继续更正。
 * - `w` 是按 `bwDaily`（首笔 / 均值 / 末笔，缺省首笔）算出的日值镜像。
 * - 删除一笔写 `gone`，删除当天最后一笔则删掉整日并记 `deleted.bodyweight[d]`。
 *
 * 待同步的 `ProfileChange` 只描述意图（日期、读数 id、输入单位、时间），重放时再应用到
 * 服务器最新状态上，因此不会整份覆盖 `bodyweight`，也不会丢掉同日其他设备新增的读数。
 */

import { randomUUID } from 'expo-crypto';
import {
  cleanTime,
  dailyModeOf,
  dailyValue,
  readingsOf,
  readingAt,
  settleDay,
  timeOf,
} from '../../../frontend/src/lib/weigh-ins.js';
import { weeklyWeights, weighInAt } from '../../../frontend/src/lib/bodyweight.js';
import type { ProfileChange } from '../profileChanges';
import {
  localDate,
  unitOf,
  type Profile,
  type Unit,
  type WeighInDay,
} from '../training';

export type WeightDailyMode = 'first' | 'avg' | 'last';

export type WeightReading = {
  d: string;
  id: string;
  at: string | null;
  w: number;
  t: number;
  src?: string;
};

export type WeightWeek = {
  key: string;
  n: number;
  avg: number;
  delta: number | null;
  entries: WeighInDay[];
};

export type WeightSummary = {
  latest: WeightReading | null;
  previous: WeightReading | null;
  delta: number | null;
  latestAt: number | null;
  dailyMode: WeightDailyMode;
  unit: Unit;
};

export const DAILY_MODE_LABEL: Record<WeightDailyMode, string> = {
  first: '首笔',
  avg: '均值',
  last: '末笔',
};

const MAX_RAW_WEIGHT = 2000;

const round1 = (value: number) => Math.round(value * 10) / 10;

const KG_PER_LB = 0.45359237;

/** A local `YYYY-MM-DD` that exists on this device's calendar and is not in the future. */
export function validWeightDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const noon = new Date(`${day}T12:00:00`).getTime();
  return Number.isFinite(noon) && localDate(noon) === day && day <= localDate(Date.now());
}

export function weightUnit(profile: Profile): Unit {
  return unitOf(profile);
}

export function dailyMode(profile: Profile): WeightDailyMode {
  const mode = dailyModeOf(profile);
  return mode === 'avg' || mode === 'last' ? mode : 'first';
}

/** Convert a weight between the two stored units, rounding the way a weigh-in is stored. */
export function convertWeight(value: number, from: Unit, to: Unit) {
  if (from === to) return round1(value);
  return round1(from === 'kg' ? value / KG_PER_LB : value * KG_PER_LB);
}

function cloneDay(day: WeighInDay): WeighInDay {
  return {
    ...day,
    ...(Array.isArray(day.ins) ? { ins: day.ins.map(reading => ({ ...reading })) } : {}),
    ...(day.gone ? { gone: { ...day.gone } } : {}),
  };
}

/**
 * The profile's days with each mirror brought up to date with its readings. A profile written
 * by another client can carry a `w` that predates a `bwDaily` change; settling it here keeps the
 * daily value, weekly mean and trend guardrail on the same number without writing to the profile.
 */
export function weightDays(profile: Profile): WeighInDay[] {
  const mode = dailyMode(profile);
  return (profile.bodyweight ?? [])
    .filter(day => day && typeof day.d === 'string')
    .map(cloneDay)
    .map(day => settleDay(day, mode) as WeighInDay | null)
    .filter((day): day is WeighInDay => day != null)
    .sort((a, b) => a.d.localeCompare(b.d));
}

/** Every reading of the profile, oldest first, including days stored before `ins` existed. */
export function weightReadings(profile: Profile): WeightReading[] {
  const out: WeightReading[] = [];
  for (const day of weightDays(profile)) {
    for (const reading of readingsOf(day) as WeightReading[]) {
      out.push({
        d: day.d,
        id: String(reading.id),
        at: cleanTime(reading.at),
        w: Number(reading.w),
        t: Number(reading.t) || 0,
        ...(reading.src ? { src: String(reading.src) } : {}),
      });
    }
  }
  return out.sort((a, b) => {
    if (a.d !== b.d) return a.d < b.d ? -1 : 1;
    if ((a.at ?? '') !== (b.at ?? '')) return (a.at ?? '') < (b.at ?? '') ? -1 : 1;
    return a.t - b.t;
  });
}

/** The one value of a day, following the profile's `bwDaily` choice. */
export function weightDayValue(day: WeighInDay, mode: WeightDailyMode) {
  return dailyValue(readingsOf(day), mode) as number | null;
}

/** Weekly means, newest week first, Monday-based even when the profile's week starts on Sunday. */
export function weightWeeks(profile: Profile, count = 8): WeightWeek[] {
  const weeks = weeklyWeights(weightDays(profile), 1) as WeightWeek[];
  return weeks.slice(0, Math.max(1, count));
}

/** The latest reading and the change from the reading before it, in profile units. */
export function weightSummary(profile: Profile): WeightSummary {
  const readings = weightReadings(profile);
  const latest = readings.at(-1) ?? null;
  const previous = readings.length > 1 ? readings.at(-2) ?? null : null;
  const day = latest ? weightDays(profile).find(item => item.d === latest.d) : undefined;
  return {
    latest,
    previous,
    delta: latest && previous ? round1(latest.w - previous.w) : null,
    latestAt: latest
      ? (latest.at
        ? readingAt(latest.d, latest.at)
        : (day ? (weighInAt(day) as number) : readingAt(latest.d, null)))
      : null,
    dailyMode: dailyMode(profile),
    unit: weightUnit(profile),
  };
}

/** The default time for a new reading: now for today, the day's first time otherwise. */
export function defaultWeightTime(profile: Profile, day: string, now = Date.now()) {
  if (day === localDate(now)) return timeOf(now) as string;
  const entry = weightDays(profile).find(item => item.d === day);
  const first = entry ? (readingsOf(entry) as WeightReading[])[0] : null;
  return cleanTime(first?.at) ?? '08:00';
}

export type WeighInDraft = { d: string; at: string; w: string };

export type WeighInValidation =
  | { ok: true; d: string; at: string | null; w: number; unit: Unit; t: number }
  | { ok: false; error: string };

/** Validate a manually typed weigh-in. Empty time means "unknown" (as in an old record). */
export function validateWeighIn(profile: Profile, draft: WeighInDraft, now = Date.now()): WeighInValidation {
  const d = draft.d.trim();
  if (!validWeightDay(d)) return { ok: false, error: '请选择有效日期，不能晚于今天。' };
  const atText = draft.at.trim();
  const at = atText ? cleanTime(atText) : null;
  if (atText && !at) return { ok: false, error: '时间请使用 HH:MM，例如 08:00。' };
  const raw = draft.w.trim().replace(',', '.');
  if (!raw) return { ok: false, error: '请输入体重。' };
  const w = Number(raw);
  if (!Number.isFinite(w) || w <= 0) return { ok: false, error: '体重必须是大于 0 的数字。' };
  if (w > MAX_RAW_WEIGHT) return { ok: false, error: '体重数值过大，请检查单位和输入。' };
  return { ok: true, d, at, w: round1(w), unit: weightUnit(profile), t: now };
}

export type WeighInChangeResult = { change: ProfileChange } | { error: string };

/** A new reading; the same day and minute is a correction, which upstream `addWeighIn` applies. */
export function addWeighInChange(profile: Profile, draft: WeighInDraft, now = Date.now()): WeighInChangeResult {
  const checked = validateWeighIn(profile, draft, now);
  if (!checked.ok) return { error: checked.error };
  return {
    change: {
      kind: 'weighIn',
      action: 'add',
      d: checked.d,
      at: checked.at,
      w: checked.w,
      id: randomUUID(),
      t: checked.t,
      unit: checked.unit,
    },
  };
}

export function editWeighInChange(
  profile: Profile,
  reading: WeightReading,
  draft: WeighInDraft,
  now = Date.now(),
): WeighInChangeResult {
  const checked = validateWeighIn(profile, draft, now);
  if (!checked.ok) return { error: checked.error };
  if (checked.d === reading.d && checked.at === cleanTime(reading.at) && checked.w === reading.w) {
    return { error: '没有需要保存的改动。' };
  }
  return {
    change: {
      kind: 'weighIn',
      action: 'edit',
      d: reading.d,
      id: reading.id,
      to: checked.d,
      at: checked.at,
      w: checked.w,
      t: checked.t,
      unit: checked.unit,
    },
  };
}

export function removeWeighInChange(reading: WeightReading, now = Date.now()): ProfileChange {
  return { kind: 'weighIn', action: 'remove', d: reading.d, id: reading.id, t: now };
}

/** `08:00`, or `未记录时间` for a record saved before times existed. */
export function weightTimeLabel(reading: WeightReading) {
  return reading.at ?? '未记录时间';
}

export function weightTimestampLabel(ms: number | null) {
  if (ms == null) return '';
  const date = new Date(ms);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return `${localDate(ms)} ${time}`;
}

export function weightValueLabel(value: number, unit: Unit, signed = false) {
  const rounded = round1(value);
  const sign = signed && rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(1)} ${unit}`;
}
