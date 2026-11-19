import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { NudgeController } from './nudge.controller.js';
import { NotificationsService } from './notifications.service.js';
import { PushController } from './push.controller.js';
import { ReminderService } from './reminder.service.js';

/* Push subscriptions, rest timers, reminders, wrapped, nudge-check.
 *
 * NotificationsService is exported for the Coach proposal hook, which
 * AppModule wires later; this module never imports Coach. */
@Module({
  imports: [PersistenceModule, AuthModule, PresenceModule],
  controllers: [PushController, NudgeController],
  providers: [NotificationsService, ReminderService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
