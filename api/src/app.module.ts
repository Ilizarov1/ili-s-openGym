import { Module } from '@nestjs/common';
import { AccountsModule } from './accounts/accounts.module.js';
import { AgentModule } from './agent/agent.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuthRoutesModule } from './auth/auth-routes.module.js';
import { CoachModule } from './coach/coach.module.js';
import { HttpModule } from './common/http/http.module.js';
import { PersistenceModule } from './common/persistence/persistence.module.js';
import { IntegrationsRoutesModule } from './integrations/integrations.routes.module.js';
import { LifecycleModule } from './lifecycle/lifecycle.module.js';
import { WiringModule } from './lifecycle/wiring.module.js';
import { MediaModule } from './media/media.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { SyncModule } from './sync/sync.module.js';
import { SystemModule } from './system/system.module.js';
import { WatchModule } from './watch/watch.module.js';

@Module({
  imports: [
    PersistenceModule,
    HttpModule,
    LifecycleModule,
    SystemModule,
    AuthModule,
    AuthRoutesModule,
    AccountsModule,
    SyncModule,
    MediaModule,
    NotificationsModule,
    WatchModule,
    IntegrationsRoutesModule,
    CoachModule,
    AgentModule,
    WiringModule,
  ],
})
export class AppModule {}
