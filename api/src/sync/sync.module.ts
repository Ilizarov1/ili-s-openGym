import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { MediaModule } from '../media/media.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

/* GET/PUT /api/data and /api/data/rev. */
@Module({
  imports: [PersistenceModule, AuthModule, MediaModule, IntegrationsModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
