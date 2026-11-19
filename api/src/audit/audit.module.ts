import { Module } from '@nestjs/common';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { AuditService } from './audit.service.js';

@Module({
  imports: [PersistenceModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
