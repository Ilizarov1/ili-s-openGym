import { Module } from '@nestjs/common';
import { mediaLimits } from '../../media.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { MediaThrottle } from './media-throttle.js';

/* MEDIA_UPLOADS=0 takes the routes away, exactly as the legacy entry did. The
 * module decorator is evaluated after the process environment is in place, so
 * this is the same snapshot MediaService takes. The store stays available
 * either way: an admin deleting a profile must still remove files uploaded
 * while uploads were on. */
const MEDIA_ON = mediaLimits(process.env).enabled;

@Module({
  imports: [PersistenceModule, AuthModule, AuditModule],
  providers: [MediaService, MediaThrottle],
  exports: [MediaService],
  controllers: MEDIA_ON ? [MediaController] : [],
})
export class MediaModule {}
