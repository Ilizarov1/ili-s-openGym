import { Global, Module } from '@nestjs/common';
import { HttpModule } from '../common/http/http.module.js';
import { LifecycleCoordinator } from './lifecycle.coordinator.js';

@Global()
@Module({
  imports: [HttpModule],
  providers: [LifecycleCoordinator],
  exports: [LifecycleCoordinator],
})
export class LifecycleModule {}
