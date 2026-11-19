/* Background work started after listen and the shutdown budget.
 *
 * Every timer-owning service registers itself here instead of starting work in
 * its constructor. Startup order is explicit; shutdown runs in reverse, waits
 * for in-flight work up to the budget, and never restarts scheduling once
 * closing has begun.
 */
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { RequestHook } from '../common/http/request-hook.js';

export interface LifecycleParticipant {
  name: string;
  order?: number;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}

const DEFAULT_BUDGET_MS = 8000;
const CLEANUP_BUDGET_MS = 1000;

@Injectable()
export class LifecycleCoordinator implements OnModuleDestroy {
  private readonly participants = new Map<string, LifecycleParticipant>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly abort = new AbortController();
  readonly signal = this.abort.signal;
  private started = false;
  private closingPromise?: Promise<void>;

  constructor(private readonly hook: RequestHook) {}

  register(participant: LifecycleParticipant): void {
    this.participants.set(participant.name, participant);
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    const done = () => this.inFlight.delete(work);
    work.then(done, done);
    return work;
  }

  get closing(): boolean {
    return this.hook.isClosing;
  }

  async startAll(): Promise<void> {
    if (this.started || this.hook.isClosing) return;
    this.started = true;
    const ordered = [...this.participants.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    for (const participant of ordered) {
      if (this.hook.isClosing) break;
      try {
        await participant.start?.();
      } catch (e) {
        console.error(`lifecycle: ${participant.name} failed to start`, (e as Error).message);
      }
    }
  }

  stop(budgetMs = +(process.env.SHUTDOWN_BUDGET_MS || DEFAULT_BUDGET_MS)): Promise<void> {
    this.closingPromise ??= this.doStop(Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : DEFAULT_BUDGET_MS);
    return this.closingPromise;
  }

  private async doStop(budgetMs: number): Promise<void> {
    this.hook.setClosing();

    const ordered = [...this.participants.values()]
      .sort((a, b) => (b.order ?? 100) - (a.order ?? 100));
    for (const participant of ordered) {
      try {
        const stopping = participant.stop?.();
        if (stopping) this.track(stopping.catch(e => this.logStopError(participant.name, e)));
      } catch (e) {
        this.logStopError(participant.name, e);
      }
    }

    const drained = this.drain();
    if (await this.within(drained, budgetMs)) return;

    this.abort.abort(new Error('shutdown budget exceeded'));
    this.hook.abortActive();
    if (!await this.within(drained, CLEANUP_BUDGET_MS)) {
      console.error('lifecycle: shutdown cleanup exceeded its budget');
    }
  }

  private logStopError(name: string, e: unknown): void {
    console.error(`lifecycle: ${name} failed to stop`, (e as Error).message);
  }

  private async drain(): Promise<void> {
    while (this.inFlight.size || this.hook.inFlight) {
      await Promise.all([Promise.allSettled([...this.inFlight]), this.hook.drain()]);
    }
  }

  private async within(work: Promise<void>, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>(resolve => {
      timer = setTimeout(resolve, ms, false);
    });
    try {
      return await Promise.race([work.then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  onModuleDestroy(): Promise<void> {
    return this.stop();
  }
}
