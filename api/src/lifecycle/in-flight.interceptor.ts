import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { defer, finalize, type Observable } from 'rxjs';
import { LifecycleCoordinator } from './lifecycle.coordinator.js';

export class InFlightInterceptor implements NestInterceptor {
  constructor(private readonly lifecycle: LifecycleCoordinator) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // A disconnected client can close its response before the handler finishes
    // unwinding, for example while an upload is removing its temporary file.
    return defer(() => {
      let finish!: () => void;
      this.lifecycle.track(new Promise<void>(resolve => { finish = resolve; }));
      return defer(() => next.handle()).pipe(finalize(finish));
    });
  }
}
