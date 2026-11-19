import { Inject, Injectable } from '@nestjs/common';
import { createIntegrations } from '../../integrations/index.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { LifecycleCoordinator } from '../lifecycle/lifecycle.coordinator.js';

/* One integrations hub per process: connection records, sealed secrets and the
 * persistent outbox all live behind it. */
@Injectable()
export class IntegrationsService {
  readonly hub: any;

  constructor(@Inject(RUNTIME_CONFIG) config: RuntimeConfigShape, lifecycle: LifecycleCoordinator) {
    this.hub = createIntegrations({
      dataDir: config.dataDir, secret: config.secret, version: '1', signal: lifecycle.signal,
    });
  }

  start(): void {
    this.hub.start();
  }

  stop(): void | Promise<void> {
    return this.hub.stop();
  }

  publicConfig(): Record<string, unknown> | null {
    return this.hub.publicConfig();
  }

  get active(): boolean {
    return !!this.hub.active;
  }
}
