/* Filesystem layout of a DATA_DIR, matching the legacy entry exactly. */
import { Injectable, Inject } from '@nestjs/common';
import path from 'node:path';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../../config/runtime-config.js';

const safeUid = (uid: string) => uid.replace(/[^a-zA-Z0-9_-]/g, '');

@Injectable()
export class Paths {
  constructor(@Inject(RUNTIME_CONFIG) readonly config: RuntimeConfigShape) {}

  get dataDir(): string {
    return this.config.dataDir;
  }

  get dbFile(): string {
    return path.join(this.config.dataDir, 'db.json');
  }

  get auditFile(): string {
    return path.join(this.config.dataDir, 'audit.log');
  }

  get vapidFile(): string {
    return path.join(this.config.dataDir, 'vapid.json');
  }

  get uploadsDir(): string {
    return path.join(this.config.dataDir, 'uploads');
  }

  get integrationsDir(): string {
    return path.join(this.config.dataDir, 'integrations');
  }

  get coachFile(): string {
    return path.join(this.config.dataDir, 'coach.json');
  }

  stateFile(uid: string): string {
    return path.join(this.config.dataDir, 'state-' + safeUid(uid) + '.json');
  }

  agentFile(uid: string): string {
    return path.join(this.config.dataDir, 'agent-' + safeUid(uid) + '.json');
  }

  watchFile(uid: string): string {
    return path.join(this.config.dataDir, 'watch-' + safeUid(uid) + '.json');
  }
}
