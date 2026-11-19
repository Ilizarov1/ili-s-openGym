import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { SystemController } from './system.controller.js';

@Module({
  imports: [PersistenceModule, AuthModule, IntegrationsModule],
  controllers: [SystemController],
})
export class SystemModule {}
