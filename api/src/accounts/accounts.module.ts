import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { MediaModule } from '../media/media.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { WatchModule } from '../watch/watch.module.js';
import { AccountDeletionService } from './account-deletion.service.js';
import { AccountController } from './account.controller.js';
import { ActivityController } from './activity.controller.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { InviteService } from './invite.service.js';
import { OwnerProofService } from './owner-proof.service.js';
import { PairingController } from './pairing.controller.js';
import { PairingStore } from './pairing.store.js';
import { RecoveryService } from './recovery.service.js';

/* Accounts, invites, admin dashboard, activity heartbeat, audit endpoints and
 * phone pairing. The pairing Map and recovery codes share this module's single
 * instances; the audit and presence services come from their own modules. */
@Module({
  imports: [
    PersistenceModule,
    AuthModule,
    AuditModule,
    PresenceModule,
    MediaModule,
    IntegrationsModule,
    WatchModule,
  ],
  providers: [
    AccountDeletionService,
    PairingStore,
    OwnerProofService,
    RecoveryService,
    InviteService,
    AdminService,
  ],
  exports: [AccountDeletionService, PairingStore, RecoveryService],
  controllers: [AccountController, PairingController, ActivityController, AdminController],
})
export class AccountsModule {}
