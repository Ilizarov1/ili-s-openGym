import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { PersistenceModule } from '../common/persistence/persistence.module.js';
import { PresenceModule } from '../presence/presence.module.js';
import { AuthModule } from './auth.module.js';
import {
  AccountPasskeyController,
  DeviceLinkController,
  PasskeyAuthController,
  PasswordController,
  SessionController,
} from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { PasskeyService } from './passkey.service.js';
import { PasswordService } from './password.service.js';

/* The optional password set is a whole controller, not handlers answering 404:
 * with PASSWORD_LOGIN off these routes must look like they never existed. The
 * module decorator is evaluated after the process environment is in place. */
const PASSWORD_LOGIN = /^(1|true|yes|on)$/i.test(process.env.PASSWORD_LOGIN || '');

@Module({
  imports: [PersistenceModule, AuditModule, PresenceModule, AuthModule],
  providers: [PasswordService, PasskeyService, AuthService],
  controllers: [
    SessionController,
    PasskeyAuthController,
    AccountPasskeyController,
    DeviceLinkController,
    ...(PASSWORD_LOGIN ? [PasswordController] : []),
  ],
})
export class AuthRoutesModule {}
