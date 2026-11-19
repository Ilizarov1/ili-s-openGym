import { Global, Module } from '@nestjs/common';
import { PersistenceModule } from '../persistence/persistence.module.js';
import { RequestHook } from './request-hook.js';

/* The pre-routing hook is needed by the entry point and the shutdown
 * coordinator; one instance serves both. */
@Global()
@Module({
  imports: [PersistenceModule],
  providers: [RequestHook],
  exports: [RequestHook],
})
export class HttpModule {}
