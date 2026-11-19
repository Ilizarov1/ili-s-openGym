/* Coach background work: boot recovery, scheduled reviews and warmup.
 *
 * Everything here delegates to api/coach/jobs.js, cadence.js and warmup.js.
 * Timers start only after listen (LifecycleCoordinator startAll), never at
 * import time, and shutdown stops them without touching per-user job files —
 * interrupted jobs are ended by recoverOnBoot on the next boot instead.
 */
import { Injectable } from '@nestjs/common';
import * as coachJobs from '../../coach/jobs.js';
import { startCadence } from '../../coach/cadence.js';
import { warmOnce } from '../../coach/warmup.js';
import { AccountStore } from '../common/persistence/account-store.js';
import { StateStore } from '../common/persistence/state-store.js';
import { LifecycleCoordinator } from '../lifecycle/lifecycle.coordinator.js';

export interface CoachNow {
  date: string;
  hhmm: string;
  weekday: number;
}

export type ProposalHook = (uid: string, pending: { changes?: unknown[] } | null, job?: unknown) => void;

/* Same "now" contract as server.js: the user's own zone, and null for an
 * unusable tz so the cadence skips that profile rather than guessing. */
function userNow(tz: string): CoachNow | null {
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
    const g = (t: string): string | undefined => parts.find(p => p.type === t)?.value;
    const date = `${g('year')}-${g('month')}-${g('day')}`;
    return {
      date,
      hhmm: `${g('hour')}:${g('minute')}`,
      weekday: new Date(date + 'T12:00:00Z').getUTCDay(),
    };
  } catch {
    return null;
  }
}

/* warmup.js returns only its 30-minute interval; the 5-second first tick is a
 * bare timeout no caller can clear. Mirror those two timers with warmOnce so
 * shutdown owns both handles (the module's own startWarmup stays untouched). */
const WARMUP_BOOT_MS = 5000;
const WARMUP_INTERVAL_MS = 30 * 60000;

interface WarmupTimers {
  stop(): void;
}

function startWarmupTimers(lifecycle: LifecycleCoordinator): WarmupTimers {
  const tick = (): void => {
    void lifecycle.track(warmOnce({ signal: lifecycle.signal }).catch(() => {
      /* a missed warmup is only a missed optimisation */
    }));
  };
  const boot = setTimeout(tick, WARMUP_BOOT_MS);
  boot.unref();
  const timer = setInterval(tick, WARMUP_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearTimeout(boot);
      clearInterval(timer);
    },
  };
}

@Injectable()
export class CoachService {
  private cadence?: NodeJS.Timeout;
  private warmup?: WarmupTimers;
  private running = false;

  constructor(
    private readonly accounts: AccountStore,
    private readonly states: StateStore,
    private readonly lifecycle: LifecycleCoordinator,
  ) {
    lifecycle.register({
      name: 'coach',
      order: 30,
      start: () => this.start(),
      stop: () => this.stop(),
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // A job that was running when the process died is not coming back; mark it
    // failed with errorClass 'restart' and keep any pending proposal readable.
    coachJobs.recoverOnBoot();
    coachJobs.resumeJobs(this.lifecycle.signal);
    this.cadence = startCadence({
      users: () => this.accounts.db.users.filter(u => !u.disabled),
      userNow,
      skip: (uid: string) => !this.states.summary(uid)?.consent,
    });
    this.warmup = startWarmupTimers(this.lifecycle);
  }

  stop(): Promise<void> {
    this.running = false;
    if (this.cadence) clearInterval(this.cadence);
    this.cadence = undefined;
    this.warmup?.stop();
    this.warmup = undefined;
    return coachJobs.pauseJobs();
  }

  /** Set by the app lifecycle once NotificationsService is available. */
  setProposalHook(fn: ProposalHook): void {
    coachJobs.setProposalHook(fn);
  }
}
