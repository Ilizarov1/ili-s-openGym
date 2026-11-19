/* Connects timers and cross-domain callbacks that used to start at import time.
 *
 * Only services that do NOT register themselves with the coordinator are
 * listed here; Notifications, Reminders, Coach and Watch already do. The Coach
 * proposal hook is wired here so Coach never imports Notifications.
 */
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { ChallengeStore } from '../auth/challenge.store.js';
import { ThrottleService } from '../auth/throttle.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PresenceService } from '../presence/presence.service.js';
import { CoachService } from '../coach/coach.service.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { MediaService } from '../media/media.service.js';
import { PairingStore } from '../accounts/pairing.store.js';
import { LifecycleCoordinator } from './lifecycle.coordinator.js';

@Injectable()
export class RuntimeWiringService {
  constructor(
    private readonly coordinator: LifecycleCoordinator,
    private readonly integrations: IntegrationsService,
    private readonly media: MediaService,
    private readonly presence: PresenceService,
    private readonly audit: AuditService,
    private readonly throttle: ThrottleService,
    private readonly challenges: ChallengeStore,
    private readonly pairings: PairingStore,
    private readonly notifications: NotificationsService,
    private readonly coach: CoachService,
  ) {
    this.coordinator.register({
      name: 'integrations',
      order: 20,
      start: () => this.integrations.start(),
      stop: () => this.integrations.stop(),
    });
    this.coordinator.register({
      name: 'media',
      order: 60,
      start: () => this.media.start(),
      stop: () => this.media.stop(),
    });
    this.coordinator.register({
      name: 'pairing-codes',
      order: 80,
      start: () => this.pairings.start(),
      stop: () => this.pairings.stop(),
    });
    this.coordinator.register({
      name: 'presence',
      order: 85,
      start: () => this.presence.start(),
      stop: () => this.presence.stop(),
    });
    this.coordinator.register({
      name: 'audit',
      order: 90,
      start: () => this.audit.start(),
      stop: () => this.audit.stop(),
    });
    this.coordinator.register({
      name: 'throttle',
      order: 95,
      start: () => this.throttle.start(),
      stop: () => this.throttle.stop(),
    });
    this.coordinator.register({
      name: 'challenges',
      order: 95,
      start: () => this.challenges.start(),
      stop: () => this.challenges.stop(),
    });

    // The Coach event worth a notification: a ready proposal with changes.
    // Failures and "nothing to change" stay silent (FR-38/E4).
    this.coach.setProposalHook((uid, pending) => {
      const count = (pending?.changes || []).length;
      if (!count) return;
      void this.notifications.sendPush(uid, {
        title: 'Your Coach has been reading',
        body: count === 1 ? '1 suggestion after this week' : `${count} suggestions after this week`,
        tag: 'coach-proposal',
        url: '#/coach',
      });
    });
  }
}
