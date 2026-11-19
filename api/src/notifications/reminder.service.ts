/* Workout-day reminders, the missed-workout nudge and the December wrapped
 * push — the legacy reminder tick, split out from the HTTP entry.
 *
 * One tick per REMINDER_TICK_MS reads every subscribed account's small state
 * summary (StateStore.summary), and only reads a whole state while one of that
 * user's windows is open and something could still be sent. Rules live in
 * api/nudge.js, api/queue.js and api/wrapped.js; nothing is copied here.
 *
 * The timer is registered with the LifecycleCoordinator and starts after
 * app.listen(); stop() clears it. A user's broken state file is logged and
 * skipped, never allowed to take the tick down for everyone else.
 */
import { Injectable } from '@nestjs/common';
import { excusedOn, nudgeFor, nudgeWindowOpen, toneOf } from '../../nudge.js';
import { dayReminderPush, nudgePush } from '../../push-messages.js';
import { effectiveRoutineId } from '../../queue.js';
import { wrappedPush, wrappedPushOwed, wrappedPushYear, wrappedSummary } from '../../wrapped.js';
import { HttpError } from '../common/http/http-error.js';
import { AccountStore, type DbUser } from '../common/persistence/account-store.js';
import { StateStore } from '../common/persistence/state-store.js';
import { LifecycleCoordinator } from '../lifecycle/lifecycle.coordinator.js';
import { PresenceService } from '../presence/presence.service.js';
import { NotificationsService } from './notifications.service.js';

// A reminder is owed for up to this many minutes after its time, once per local
// date: a restart or a stalled tick across the exact minute used to lose the
// whole day's reminder. Later than that it is skipped rather than delivered at
// a time nobody asked for.
const REMINDER_WINDOW_MIN = 15;
// How often the tick looks. 10 s keeps a reminder within ~9 s of its minute;
// the tests shorten it.
const REMINDER_TICK_MS = Math.max(50, +(process.env.REMINDER_TICK_MS || 10000));

export interface LocalNow {
  date: string;
  hhmm: string;
  weekday: number;
}

/* "Now" in an arbitrary IANA zone (e.g. "Europe/Lisbon") instead of the
 * server's own: each user's reminder fires by their own clock. */
export function userNow(tz: string): LocalNow | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date());
    const g = (type: string) => parts.find(p => p.type === type)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    // Weekday derived from the zone's own date, not the server's.
    return {
      date,
      hhmm: `${g('hour')}:${g('minute')}`,
      weekday: new Date(date + 'T12:00:00Z').getUTCDay(),
    };
  } catch {
    return null; // unknown/invalid tz — skip this user rather than guess
  }
}

const hhmmToMin = (v: unknown): number => {
  const m = /^(\d{2}):(\d{2})$/.exec(typeof v === 'string' ? v : '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

/* Minutes since the reminder's time on the user's clock; negative before it,
 * NaN when either side does not parse. Same-day only — a 23:55 reminder is not
 * owed at 00:05 the next day. */
export const minutesLate = (time: unknown, now: LocalNow): number =>
  hhmmToMin(now.hhmm) - hhmmToMin(time);

@Injectable()
export class ReminderService {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly accounts: AccountStore,
    private readonly states: StateStore,
    private readonly presence: PresenceService,
    private readonly notifications: NotificationsService,
    private readonly lifecycle: LifecycleCoordinator,
  ) {
    this.lifecycle.register({
      name: 'reminders',
      order: 10,
      start: () => this.start(),
      stop: () => this.stop(),
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), REMINDER_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    // Server time, read through Date.now() so the tests' clock moves it too.
    const wrappedYear = wrappedPushYear(new Date(Date.now()));
    for (const user of this.accounts.db.users) {
      if (user.disabled) continue; // locked out everywhere, reminders included
      if (!this.accounts.db.subs.some(s => s.userId === user.id)) continue;
      // One user's state file is one user's problem: a shape this tick cannot
      // read is logged and skipped, not allowed to take everyone else down.
      try {
        const sum = this.states.summary(user.id);
        if (wrappedYear && sum && user.wrappedPush !== wrappedYear) this.wrappedTick(user, wrappedYear);
        if (!sum?.rem.on) continue;

        const now = userNow(String(sum.rem.tz || 'UTC'));
        if (!now) continue;
        const late = minutesLate(sum.rem.time, now);
        const reminderOpen =
          late >= 0 &&
          late <= REMINDER_WINDOW_MIN &&
          user.lastReminder !== now.date &&
          sum.settled !== now.date;
        const nudgeOpen = sum.rem.nudge && user.lastNudge !== now.date && nudgeWindowOpen(sum.rem.time, now.hhmm);
        if (!reminderOpen && !nudgeOpen) continue;

        const S = this.states.readCached(user.id);
        if (!S?.reminder?.on) continue;
        if (nudgeOpen) this.nudgeTick(user, S, now);
        if (!reminderOpen) continue;

        // Nothing below depends on anything but the file, so an answer of
        // "nothing owed today" holds until the file changes (which drops the
        // summary) or the date does.
        if ((S.workouts || []).some((w: any) => w?.d === now.date)) {
          sum.settled = now.date;
          continue;
        }
        if (excusedOn(S, now.date)) {
          sum.settled = now.date; // noted as sick, away, … (nudge.js excusedOn)
          continue;
        }
        const rid = effectiveRoutineId(S, now.date);
        if (!rid) {
          sum.settled = now.date; // rest day — nothing planned
          continue;
        }
        const routine = (S.routines || []).find((r: any) => r?.id === rid);
        console.log('reminder firing', user.id, rid);
        user.lastReminder = now.date;
        this.accounts.save();
        void this.notifications.sendPush(user.id, dayReminderPush(S.lang, routine));
      } catch (e) {
        console.error('reminder tick', user.id, e);
      }
    }
  }

  /* Missed-workout nudge (nudge.js): opt-in on top of the reminder. Owed from
   * 20:00 — or 2 h after the reminder — until 21:30 on the user's clock, once
   * per local date, never while a workout is on screen. */
  private nudgeTick(user: DbUser, S: any, now: LocalNow): void {
    if (!S.reminder.nudge || user.lastNudge === now.date) return;
    if (!nudgeWindowOpen(S.reminder.time, now.hhmm)) return;
    if (this.presence.getLive(user.id)) return; // a session is under way
    const rid = nudgeFor(S, now.date);
    if (!rid) return;
    const routine = (S.routines || []).find((r: any) => r?.id === rid);
    console.log('nudge firing', user.id, rid);
    user.lastNudge = now.date;
    this.accounts.save();
    void this.notifications.sendPush(user.id, nudgePush(S.lang, toneOf(S.reminder), routine, now.date));
  }

  /* "Your year in openGym" (wrapped.js): once per user and year, on Dec 1 from
   * 18:00 server time. The year it went out for is written to db.json before
   * the send, so a crash after it, a restart or the next tick cannot send it
   * twice. The summary is read from the state cache only when the window is
   * open, so no state is parsed on ordinary days for this. */
  private wrappedTick(user: DbUser, year: number): void {
    const summary = wrappedSummary(this.states.readCached(user.id));
    if (!wrappedPushOwed(user, summary, year)) return;
    console.log('wrapped push firing', user.id, year);
    user.wrappedPush = year;
    this.accounts.save();
    void this.notifications.sendPush(user.id, wrappedPush(summary.lang, year));
  }

  /* GET /api/nudge-check: what the phone app's background check asks before a
   * missed-day nudge or a workout-day reminder it scheduled on itself fires.
   * A few bytes instead of the whole document — `done` (a workout dated that
   * day, or a day note), `nudge` (whether api/nudge.js would still nudge it)
   * and the revision. Nothing of the workouts themselves. */
  checkNudge(user: DbUser, rawDate: string): { date: string; done: boolean; nudge: boolean; rev: number } {
    const date = rawDate || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) {
      throw new HttpError(400, 'date must be YYYY-MM-DD', { extra: { code: 'date-invalid' } });
    }
    const doc = this.states.readCached(user.id) || {};
    const workouts = Array.isArray(doc.workouts) ? doc.workouts : [];
    const done = workouts.some((w: any) => w && w.d === date) || excusedOn(doc, date);
    let nudge = false;
    try {
      nudge = !done && !!nudgeFor(doc, date);
    } catch {
      nudge = true; // unreadable: keep what the phone planned
    }
    return { date, done, nudge, rev: doc._rev || 0 };
  }
}
