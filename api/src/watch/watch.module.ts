import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { WatchCodesStore } from './watch-codes.store.js';
import { WatchController } from './watch.controller.js';
import { WatchService } from './watch.service.js';

/* Zepp pairing, device tokens, snapshots and the event queue. The code store
 * is shared with account deletion; the controller owns the nine routes. */
@Module({
  imports: [PersistenceModule, AuthModule, AuditModule],
  providers: [WatchCodesStore, WatchService],
  exports: [WatchCodesStore, WatchService],
  controllers: [WatchController],
})
export class WatchModule {}
