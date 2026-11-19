import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsModule } from './integrations.module.js';

/* The seven /api/integrations routes. */
@Module({
  imports: [IntegrationsModule, AuthModule, AuditModule],
  controllers: [IntegrationsController],
})
export class IntegrationsRoutesModule {}
