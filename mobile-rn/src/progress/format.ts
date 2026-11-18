/** Chinese display strings and numeric formatting shared by both progress surfaces. */

import type { Unit } from '../training';
import type { ExerciseCandidate, RecordMetric, RecordMode } from './types';

/** At most `digits` decimals, with no trailing `.0` and no `-0`. */
export function formatNumber(value: number, digits = 1): string {
  const factor = digits >= 2 ? 100 : digits === 1 ? 10 : 1;
  const safe = Number.isFinite(value) ? value : 0;
  return String(Math.round(safe * factor) / factor + 0);
}

export function formatCount(value: number): string {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatVolume(value: number, unit: Unit): string {
  return `${formatCount(value)} ${unit}`;
}

/** Muscle figures keep one decimal: 2.0, 0.8, 0.0. */
export function formatSets(value: number): string {
  const safe = Number.isFinite(value) ? Math.max(0, value) : 0;
  return safe.toFixed(1);
}

export function formatDurationSeconds(value: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export function formatDayLabel(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '未知日期';
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return `${year}年${month}月${date}日`;
}

export function formatMonthDay(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`;
}

export function modeLabel(mode: RecordMode, metric: RecordMetric): string {
  if (mode === 'time') return '计时';
  if (mode === 'cardio') return '有氧';
  return metric === 'reps' ? '自重次数' : '力量';
}

export function metricLabel(metric: RecordMetric): string {
  if (metric === 'weight') return '重量';
  if (metric === 'reps') return '次数';
  if (metric === 'sec') return '时长';
  return '速度';
}

/** The headline number of a record / performance point. */
export function candidateValueText(candidate: ExerciseCandidate): string {
  if (candidate.metric === 'reps') return `${formatCount(candidate.value)} 次`;
  if (candidate.metric === 'sec') return formatDurationSeconds(candidate.value);
  return `${formatNumber(candidate.value, 2)} ${candidate.unitLabel}`;
}

/** The source set behind a headline number. */
export function candidateDetail(candidate: ExerciseCandidate): string {
  if (candidate.metric === 'weight') {
    if (candidate.weight == null) return '次数未记录';
    if (candidate.topWOnly) return `${formatNumber(candidate.weight, 2)} ${candidate.weightUnit} · 次数未记录`;
    return candidate.reps == null
      ? `${formatNumber(candidate.weight, 2)} ${candidate.weightUnit}`
      : `${formatNumber(candidate.weight, 2)} ${candidate.weightUnit} × ${formatCount(candidate.reps)} 次`;
  }
  if (candidate.metric === 'reps') {
    if (candidate.weight != null && candidate.weight > 0) {
      return `${formatNumber(candidate.weight, 2)} ${candidate.weightUnit} × ${formatCount(candidate.value)} 次`;
    }
    return `${formatCount(candidate.value)} 次`;
  }
  if (candidate.metric === 'sec') {
    const load = candidate.weight != null && candidate.weight > 0
      ? ` · ${formatNumber(candidate.weight, 2)} ${candidate.weightUnit}`
      : '';
    return `${formatDurationSeconds(candidate.value)}${load}`;
  }
  const minutes = candidate.min != null ? ` · ${formatNumber(candidate.min, 0)} 分钟` : '';
  return `${formatNumber(candidate.value, 2)} ${candidate.unitLabel}${minutes}`;
}

export function sourceText(candidate: ExerciseCandidate, date: string | null): string {
  const day = formatDayLabel(date);
  return date ? `${day} · ${candidateDetail(candidate)}` : candidateDetail(candidate);
}
