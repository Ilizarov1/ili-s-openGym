import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { CoachController } from './coach.controller.js';
import { CoachService } from './coach.service.js';

/* Coach user and admin routes plus boot recovery, cadence and warmup.
 * Notifications are deliberately not imported: the app lifecycle connects
 * CoachService.setProposalHook to NotificationsService later. */
@Module({
  imports: [PersistenceModule, AuthModule, AuditModule],
  controllers: [CoachController],
  providers: [CoachService],
  exports: [CoachService],
})
export class CoachModule {}
