/**
 * 围度页的数据层：字段、单位换算和同日合并都复用上游 `measurements.js`。
 *
 * 存储：`Profile.measurements[]` 每个本地日期最多一项；长度一律 cm，体脂为百分比，
 * 自定义指标留在 `entry.other[]` 中（RN 只读展示，不删除、不覆盖）。
 *
 * 写入：`ProfileChange` 携带日期、字段级新值和意图发生时的基准值。重放时只覆盖仍然等于
 * 基准值的字段，因此 Web 同时修改胸围、RN 离线修改腰围时，两边字段都能保留。
 */

import {
  MEASUREMENT_FIELDS,
  emptyMeasurement,
  fromMeasurementDisplay,
  measurementEntryHasValues,
  measurementSeries,
  measurementUnit,
  measurementValue,
  normalizeMeasurementsState,
  toMeasurementDisplay,
  zeroIsReading,
} from '../../../frontend/src/lib/measurements.js';
import type { ProfileChange } from '../profileChanges';
import { localDate, unitOf, type MeasurementEntry, type MeasurementOther, type Profile } from '../training';

export type MeasurementField = {
  key: string;
  label: string;
  group: string;
  unit: string;
  percent: boolean;
  optional?: boolean;
  custom?: boolean;
};

export type MeasurementPoint = { d: string; t: number; y: number };

export type MeasurementValue = number | null;

const FIELD_LABEL: Record<string, string> = {
  neck: '颈围',
  shoulders: '肩围',
  chest: '胸围',
  waist: '腰围',
  hips: '臀围',
  abdomen: '腹部',
  upperArmLeft: '左上臂',
  upperArmRight: '右上臂',
  forearmLeft: '左前臂',
  forearmRight: '右前臂',
  wristLeft: '左腕',
  wristRight: '右腕',
  thighLeft: '左大腿',
  thighRight: '右大腿',
  calfLeft: '左小腿',
  calfRight: '右小腿',
  ankleLeft: '左踝',
  ankleRight: '右踝',
  bodyFat: '体脂率',
};

const GROUP_LABEL: Record<string, string> = {
  Torso: '躯干',
  Arms: '手臂',
  Legs: '腿部',
  Other: '其他',
};

export function measurementFieldLabel(key: string, fallback?: string) {
  return FIELD_LABEL[key] ?? fallback ?? key;
}

export function measurementGroupLabel(group: string) {
  return GROUP_LABEL[group] ?? group;
}

function fieldOf(raw: {
  key: string;
  label: string;
  group: string;
  optional?: boolean;
  custom?: boolean;
}, profile: Profile): MeasurementField {
  const unit = measurementUnit(unitOf(profile), raw) as string;
  return {
    key: raw.key,
    label: measurementFieldLabel(raw.key, raw.label),
    group: measurementGroupLabel(raw.group),
    unit: unit === 'none' ? '' : unit,
    percent: unit === '%',
    optional: raw.optional,
    custom: raw.custom,
  };
}

/** The profile with measurements normalised without mutating the prop. */
export function normalizedMeasurements(profile: Profile): Profile {
  const copy: Profile = {
    ...profile,
    measurements: (profile.measurements ?? []).filter(Boolean).map(entry => ({
      ...entry,
      other: Array.isArray(entry.other) ? entry.other.map(row => ({ ...row })) : entry.other,
    })),
    customMeasurements: (profile.customMeasurements ?? []).filter(Boolean).map(item => ({ ...item })),
    measurementEnabled: Array.isArray(profile.measurementEnabled) ? [...profile.measurementEnabled] : profile.measurementEnabled,
  };
  return normalizeMeasurementsState(copy) as Profile;
}

export function measurementEntries(profile: Profile): MeasurementEntry[] {
  return [...(normalizedMeasurements(profile).measurements ?? [])].sort((a, b) =>
    a.d === b.d ? (a.t ?? 0) - (b.t ?? 0) : a.d.localeCompare(b.d));
}

export function measurementEntryFor(profile: Profile, day: string): MeasurementEntry | null {
  return measurementEntries(profile).find(entry => entry.d === day) ?? null;
}

/**
 * Every field the editing panel offers: the account's enabled built-ins, every populated
 * built-in (so a field disabled after it was logged is still editable), body fat, and Web's
 * custom `other` readings as read-only rows.
 */
export function measurementFields(profile: Profile, entry: MeasurementEntry | null): MeasurementField[] {
  const out: MeasurementField[] = [];
  const seen = new Set<string>();
  const add = (field: { key: string; label: string; group: string; optional?: boolean; custom?: boolean }) => {
    if (seen.has(field.key) || field.key.startsWith('other:')) return;
    seen.add(field.key);
    out.push(fieldOf(field, profile));
  };
  for (const field of MEASUREMENT_FIELDS as {
    key: string;
    label: string;
    group: string;
    optional?: boolean;
  }[]) {
    add(field);
  }
  for (const row of entry?.other ?? []) {
    const key = `other:${row.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: row.name || '自定义指标',
      group: measurementGroupLabel('Other'),
      unit: row.unit && row.unit !== 'none' ? row.unit : '',
      percent: row.unit === '%',
      custom: true,
    });
  }
  return out;
}

/** The value a field shows, already converted to cm/in or percent. */
export function measurementDisplay(profile: Profile, entry: MeasurementEntry | null, key: string) {
  const field = measurementFields(profile, entry).find(item => item.key === key);
  if (!field || !entry) return null;
  const raw = measurementValue(entry, key);
  if (raw == null) return null;
  if (key.startsWith('other:')) {
    const row = entry.other?.find(item => `other:${item.id}` === key);
    const displayUnit = row?.unit && row.unit !== 'none' ? row.unit : unitOf(profile) === 'lb' ? 'in' : 'cm';
    return toMeasurementDisplay(raw, unitOf(profile), { key, unit: displayUnit }) as number;
  }
  return toMeasurementDisplay(raw, unitOf(profile), { key }) as number;
}

export function measurementValueText(profile: Profile, entry: MeasurementEntry | null, field: MeasurementField) {
  const shown = measurementDisplay(profile, entry, field.key);
  if (shown == null) return '';
  return String(shown);
}

/** Parse one typed value: `null` clears, a number is stored in canonical cm/percent. */
export function parseMeasurementInput(
  profile: Profile,
  field: MeasurementField,
  text: string,
): { ok: true; value: MeasurementValue } | { ok: false; error: string } {
  const raw = text.trim().replace(',', '.');
  if (!raw) return { ok: true, value: null };
  const shown = Number(raw);
  if (!Number.isFinite(shown)) return { ok: false, error: `${field.label}必须是数字。` };
  if (field.percent) {
    if (shown < 0 || shown > 100) return { ok: false, error: `${field.label}必须在 0 到 100 之间。` };
    return { ok: true, value: Math.round(shown * 10) / 10 };
  }
  if (shown < 0 || (!zeroIsReading(field.unit) && !(shown > 0))) {
    return { ok: false, error: `${field.label}必须大于 0。` };
  }
  const stored = fromMeasurementDisplay(shown, unitOf(profile), { key: field.key, unit: field.unit }) as number | null;
  if (stored == null) return { ok: false, error: `${field.label}必须是有效的数字。` };
  return { ok: true, value: stored };
}

export function measurementSeriesFor(profile: Profile, key: string): MeasurementPoint[] {
  return (measurementSeries(normalizedMeasurements(profile), key) as MeasurementPoint[])
    .filter(point => point && Number.isFinite(point.y));
}

export type MeasurementDraft = Record<string, string>;

export function measurementDraft(profile: Profile, entry: MeasurementEntry | null): MeasurementDraft {
  const out: MeasurementDraft = {};
  for (const field of measurementFields(profile, entry)) {
    if (field.custom) continue;
    out[field.key] = measurementValueText(profile, entry, field);
  }
  return out;
}

export type MeasurementChangeResult = { change: ProfileChange } | { error: string };

/**
 * One save of the selected day. Only fields whose typed value differs from the stored day are
 * included; `base` records what the user saw so a later replay can leave a concurrently edited
 * field alone.
 */
export function measurementSaveChange(
  profile: Profile,
  day: string,
  entry: MeasurementEntry | null,
  draft: MeasurementDraft,
  now = Date.now(),
): MeasurementChangeResult {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || localDate(new Date(`${day}T12:00:00`).getTime()) !== day) {
    return { error: '请选择有效日期。' };
  }
  if (day > localDate(now)) return { error: '日期不能晚于今天。' };
  const values: Record<string, number | null> = {};
  const base: Record<string, number | null> = {};
  for (const field of measurementFields(profile, entry)) {
    if (field.custom) continue;
    const parsed = parseMeasurementInput(profile, field, draft[field.key] ?? '');
    if (!parsed.ok) return { error: parsed.error };
    const current = entry ? measurementValue(entry, field.key) as number | null : null;
    if (parsed.value === current) continue;
    if (parsed.value == null && current == null) continue;
    values[field.key] = parsed.value;
    base[field.key] = current;
  }
  if (Object.keys(values).length === 0) {
    return { error: entry ? '没有需要保存的改动。' : '请至少填写一项围度。' };
  }
  if (entry) {
    const preview: MeasurementEntry = {
      ...entry,
      ...(Array.isArray(entry.other) ? { other: entry.other.map(row => ({ ...row })) } : {}),
    };
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith('other:')) {
        const id = key.slice(6);
        preview.other = (preview.other ?? []).map(row => row.id === id ? { ...row, value } : row);
      } else if (value == null) {
        delete preview[key];
      } else {
        preview[key] = value;
      }
    }
    if (!measurementEntryHasValues(preview)) {
      return { error: '至少保留一项围度或体脂；要移除整天请用“删除整天”。' };
    }
  }
  return {
    change: {
      kind: 'measurement',
      d: day,
      values,
      base,
      t: now,
    },
  };
}

export function measurementDeleteChange(day: string, now = Date.now()): ProfileChange {
  return { kind: 'measurement', d: day, remove: true, t: now };
}

/** A one-line summary for the history list; skips empty fields and keeps Web's custom rows. */
export function measurementSummary(profile: Profile, entry: MeasurementEntry) {
  const parts: string[] = [];
  for (const field of measurementFields(profile, entry)) {
    if (field.custom) continue;
    const value = measurementDisplay(profile, entry, field.key);
    if (value == null) continue;
    parts.push(`${field.label} ${value}${field.unit ? ` ${field.unit}` : ''}`);
  }
  for (const row of entry.other ?? []) {
    if (row.value == null) continue;
    const value = measurementDisplay(profile, entry, `other:${row.id}`);
    if (value == null) continue;
    const unit = row.unit && row.unit !== 'none' ? ` ${row.unit}` : '';
    parts.push(`${row.name || '自定义'} ${value}${unit}`);
  }
  return parts.join(' · ');
}

export function measurementHasValues(entry: MeasurementEntry | null) {
  return entry != null && measurementEntryHasValues(entry);
}

/** New empty entry used only for previews; not written to the profile. */
export function emptyMeasurementDay(day: string) {
  return emptyMeasurement(day) as MeasurementEntry;
}

export function customMeasurementRows(entry: MeasurementEntry | null): MeasurementOther[] {
  return (entry?.other ?? []).filter(row => row && row.value != null);
}
