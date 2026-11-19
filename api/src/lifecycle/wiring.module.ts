import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { CoachModule } from '../coach/coach.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { MediaModule } from '../media/media.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { RuntimeWiringService } from './runtime-wiring.service.js';
import { AdminSocketService } from './admin-socket.service.js';

/* Imports the domains only to connect their start/stop and the Coach proposal
 * hook. None of them import this module, so the graph stays acyclic. */
@Module({
  imports: [
    PersistenceModule,
    AccountsModule,
    AuditModule,
    AuthModule,
    CoachModule,
    IntegrationsModule,
    MediaModule,
    NotificationsModule,
    PresenceModule,
  ],
  providers: [RuntimeWiringService, AdminSocketService],
})
export class WiringModule {}
