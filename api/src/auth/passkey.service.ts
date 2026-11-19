/* WebAuthn ceremonies, ported from the legacy entry.
 *
 * Challenges stay in the shared in-memory ChallengeStore (5 minutes, one kind
 * per ceremony). RP_ID/ORIGIN must match the deployment exactly; a verify error
 * is answered with the legacy message that names both values when the cause is
 * a misconfiguration. The routes own the account/bookkeeping decisions; this
 * service only runs the ceremony and turns the result into a credential row
 * shaped like the one api/passkeys-store.js expects.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isMisconfigured, verifyError } from '../../verify-error.js';
import { MAX_PASSKEYS } from '../../passkeys-store.js';
import { AuditService } from '../audit/audit.service.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import { AccountStore, type DbCred, type DbUser } from '../common/persistence/account-store.js';
import { b64uToBuf } from '../common/http/body-reader.js';
import { json } from '../common/http/reply.js';
import { ChallengeStore, type Challenge } from './challenge.store.js';

export interface PasskeyCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports: unknown;
  name: unknown;
}

@Injectable()
export class PasskeyService {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape,
    private readonly accounts: AccountStore,
    private readonly challenges: ChallengeStore,
    private readonly audit: AuditService,
  ) {}

  /** Step one of signing up: a challenge bound to a fresh profile id. */
  async registrationOptions(
    uid: string,
    name: string,
    excludeCredentials: Array<{ id: unknown; transports?: unknown }> = [],
  ): Promise<any> {
    return (generateRegistrationOptions as any)({
      rpName: this.config.rpName,
      rpID: this.config.rpId,
      userID: Buffer.from(uid),
      userName: name,
      userDisplayName: name,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials,
    });
  }

  /** Another passkey for a signed-in profile: its own passkeys are excluded. */
  async moreOptions(user: DbUser): Promise<any> {
    return this.registrationOptions(
      user.id,
      user.name,
      this.accounts.db.creds
        .filter(c => c.userId === user.id)
        .map(c => ({ id: (c as any).id, transports: (c as any).transports || [] })),
    );
  }

  /** Step one of signing in: no credentials are offered, so no profile is named. */
  async authenticationOptions(): Promise<any> {
    return (generateAuthenticationOptions as any)({
      rpID: this.config.rpId,
      userVerification: 'preferred',
      allowCredentials: [],
    });
  }

  verifyAnswer(e: unknown): Record<string, unknown> {
    return {
      error: verifyError(e, { rpId: this.config.rpId, origin: this.config.origin }),
      ...(isMisconfigured(e) ? { code: 'origin-mismatch', expected: this.config.origin } : {}),
    };
  }

  async verifyRegistration(body: Record<string, unknown>, challenge: string): Promise<any> {
    return (verifyRegistrationResponse as any)({
      response: body.credential,
      expectedChallenge: challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
      requireUserVerification: false,
    });
  }

  async verifyAuthentication(cred: DbCred, body: Record<string, unknown>, challenge: string): Promise<any> {
    return (verifyAuthenticationResponse as any)({
      response: body.credential,
      expectedChallenge: challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
      requireUserVerification: false,
      credential: {
        id: cred.id,
        publicKey: b64uToBuf(String(cred.publicKey)),
        counter: cred.counter,
        transports: cred.transports,
      },
    });
  }

  /* The second half of either registration ceremony: the new passkey as a
   * credential row, or null once the refusal has been answered and audited as
   * `ev`. `user` is what the audit row names. */
  async newPasskey(
    req: IncomingMessage,
    res: ServerResponse,
    c: Challenge,
    body: Record<string, unknown>,
    ev: string,
    user: DbUser | { id: string },
  ): Promise<PasskeyCredential | null> {
    let verification: any;
    try {
      verification = await this.verifyRegistration(body, c.challenge);
    } catch (e) {
      // e.message can echo attacker-supplied response fields, so only the reason code is kept.
      this.audit.audit(req, ev, { ok: false, user: user as DbUser, msg: 'verify-error' });
      json(res, 400, this.verifyAnswer(e));
      return null;
    }
    if (!verification.verified) {
      this.audit.audit(req, ev, { ok: false, user: user as DbUser, msg: 'not-verified' });
      json(res, 400, { error: 'not verified' });
      return null;
    }
    const credential = verification.registrationInfo.credential;
    const response = (body.credential as any)?.response;
    return {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter || 0,
      transports: response?.transports,
      name: body.name,
    };
  }

  /* A passkey assertion made just now by the signed-in account itself: the way
   * someone with no password proves it is them before setting one. Only a
   * `login` challenge from /api/login/options counts, and the credential has to
   * belong to this account. Mutates the row; the caller decides when to save. */
  async stepUp(user: DbUser, body: Record<string, unknown>): Promise<boolean> {
    const c = this.challenges.take(body.cid);
    if (!c || c.kind !== 'login') return false;
    const credentialId = (body.credential as any)?.id;
    const cred = this.accounts.db.creds.find(x => x.id === credentialId && x.userId === user.id);
    if (!cred) return false;
    try {
      const verification = await this.verifyAuthentication(cred, body, c.challenge);
      if (!verification.verified) return false;
      (cred as any).counter = verification.authenticationInfo.newCounter;
      (cred as any).lastUsed = new Date().toISOString();
      return true;
    } catch {
      return false;
    }
  }

  limitReached(user: DbUser): boolean {
    return this.accounts.db.creds.filter(c => c.userId === user.id).length >= MAX_PASSKEYS;
  }
}
