import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as coachConfig from '../../coach/config.js';
import { mediaConfig, mediaLimits } from '../../media.js';
import { OptionalSession, Public } from '../auth/access.decorators.js';
import { SessionService } from '../auth/session.service.js';
import { AccountStore } from '../common/persistence/account-store.js';
import { json } from '../common/http/reply.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { IntegrationsService } from '../integrations/integrations.service.js';
import { agentPublicConfig } from '../agent/agent.flags.js';

const DATA_PROBE_MS = 5000;

@Controller()
export class SystemController {
  private probe = { at: 0, ok: false };

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly sessions: SessionService,
    private readonly integrations: IntegrationsService,
  ) {}

  private dataWritable(): boolean {
    const now = Date.now();
    if (this.probe.at && now - this.probe.at < DATA_PROBE_MS) return this.probe.ok;
    const probe = path.join(this.config.dataDir, '.health-' + process.pid);
    let ok: boolean;
    try {
      fs.writeFileSync(probe, '');
      ok = true;
    } catch (e) {
      console.error('health: cannot write to', this.config.dataDir + ':', (e as Error).message);
      ok = false;
    } finally {
      try {
        fs.unlinkSync(probe);
      } catch {
        /* never got created */
      }
    }
    this.probe = { at: now, ok };
    return ok;
  }

  @Public()
  @Get('health')
  health(@Res() res: ServerResponse): void {
    if (!this.dataWritable()) {
      json(res, 503, { ok: false, writable: false });
      return;
    }
    json(res, 200, { ok: true, users: this.accounts.db.users.length, writable: true });
  }

  @OptionalSession()
  @Get('config')
  configGet(@Req() req: IncomingMessage, @Res() res: ServerResponse): void {
    const signedIn = !!this.sessions.readSession(req);
    const limits = mediaLimits(process.env);
    json(res, 200, {
      invite_only: this.config.inviteOnly,
      allow_guest: this.config.allowGuest,
      ...(this.config.passwordLogin ? { password_login: true } : {}),
      ...(this.config.defaultLang ? { default_lang: this.config.defaultLang } : {}),
      ...(limits.enabled ? { media: mediaConfig(limits) } : {}),
      ...(signedIn ? { coach: coachConfig.publicConfig() } : {}),
      ...(signedIn ? { agent: agentPublicConfig() } : {}),
      ...(signedIn && this.integrations.publicConfig() ? { integrations: this.integrations.publicConfig() } : {}),
    });
  }
}
