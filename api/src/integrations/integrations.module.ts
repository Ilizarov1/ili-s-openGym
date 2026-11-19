import { Module } from '@nestjs/common';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { IntegrationsService } from './integrations.service.js';

@Module({
  imports: [PersistenceModule],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
