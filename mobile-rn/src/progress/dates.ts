/** Local-calendar helpers shared by the trend and muscle windows. */

import { isoOf, MONDAY, weekKey } from '../../../frontend/src/lib/format';
import { localDate } from '../training';

/** Today in the device's local calendar, with `now` injectable for tests. */
export function localDayOf(now: number): string {
  return localDate(now);
}

/** Move an ISO day by whole local days; noon avoids DST moving the calendar date. */
export function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00`);
  if (!Number.isFinite(date.getTime())) return day;
  date.setDate(date.getDate() + days);
  return isoOf(date) as string;
}

/** The Monday that starts the given local day's week. */
export function mondayOf(day: string): string {
  return weekKey(day, MONDAY) as string;
}

/** First day of a range. `0` means all time, from the earliest record (or today). */
export function rangeFromDay(range: number, today: string, earliest: string | null): string {
  if (range === 0) return earliest ?? today;
  return shiftDay(today, -(range - 1));
}

/** Inclusive local-day comparison; both ends are `YYYY-MM-DD`. */
export function inDayRange(day: string | null, from: string, to: string): day is string {
  return day != null && day >= from && day <= to;
}

/** Every Monday-start week start between two days, both ends included. */
export function weekStartsBetween(fromDay: string, toDay: string): string[] {
  const first = mondayOf(fromDay);
  const last = mondayOf(toDay);
  if (!first || !last || first > last) return [];
  const starts: string[] = [];
  let cursor = first;
  // A guard against a malformed date creating an endless loop; 300 years is far
  // beyond any plausible training history and still bounded.
  for (let index = 0; index < 15600 && cursor <= last; index++) {
    starts.push(cursor);
    cursor = shiftDay(cursor, 7);
  }
  return starts;
}

/** The Sunday that closes a Monday-start week. */
export function weekEndOf(weekStart: string): string {
  return shiftDay(weekStart, 6);
}

/** `MM/DD` for chart axes and compact week labels. */
export function shortDay(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  return `${day.slice(5, 7)}/${day.slice(8, 10)}`;
}

/** A local Date at noon, used only where a Date is easier than string arithmetic. */
export function noonOf(day: string): Date {
  return new Date(`${day}T12:00:00`);
}

/** Sunday-start display is deliberately not offered: the spec fixes Monday buckets. */
export const WEEK_START = MONDAY;
