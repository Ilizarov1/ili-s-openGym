import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from '../audit/audit.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { AccessGuard } from './access.guard.js';
import { ChallengeStore } from './challenge.store.js';
import { CsrfService } from './csrf.service.js';
import { SessionService } from './session.service.js';
import { ThrottleService } from './throttle.service.js';

@Module({
  imports: [PersistenceModule, AuditModule, PresenceModule],
  providers: [
    SessionService,
    CsrfService,
    ThrottleService,
    ChallengeStore,
    AccessGuard,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [SessionService, CsrfService, ThrottleService, ChallengeStore, AccessGuard],
})
export class AuthModule {}
