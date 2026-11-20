/* Account-held model credentials.
 *
 * AES-256-GCM under a key derived from the instance `data/secret` with HKDF and
 * the fixed info string `opengym-agent-config-v1`. The account id, profile id
 * and version are authenticated, so a ciphertext cannot be moved to another
 * account or replayed under a later profile version.
 */
import { Inject, Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { AgentError } from '../../agent-runtime/errors.js';
import { RUNTIME_CONFIG, type RuntimeConfigShape } from '../config/runtime-config.js';
import type { EncryptedSecret } from './agent.types.js';

const INFO = 'opengym-agent-config-v1';

@Injectable()
export class AgentCrypto {
  constructor(@Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfigShape) {}

  get enabled(): boolean {
    return typeof this.config.secret === 'string' && this.config.secret.length >= 16;
  }

  private key(): Buffer {
    if (!this.enabled) {
      throw new AgentError('agent_config_disabled', 'this instance has no secret for agent credentials');
    }
    return Buffer.from(crypto.hkdfSync(
      'sha256',
      Buffer.from(this.config.secret, 'utf8'),
      Buffer.alloc(0),
      Buffer.from(INFO),
      32,
    ));
  }

  private aad(uid: string, profileId: string, version: number): Buffer {
    return Buffer.from(`${uid}|${profileId}|${version}`, 'utf8');
  }

  encrypt(uid: string, profileId: string, version: number, plaintext: string): EncryptedSecret {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(this.aad(uid, profileId, version));
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    };
  }

  decrypt(uid: string, profileId: string, version: number, secret: EncryptedSecret): string {
    if (!secret || secret.v !== 1) throw new AgentError('agent_config_disabled', 'unsupported credential envelope');
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), Buffer.from(secret.iv, 'base64'));
      decipher.setAAD(this.aad(uid, profileId, version));
      decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(secret.data, 'base64')), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new AgentError('agent_config_disabled', 'the stored credential could not be decrypted', { cause: error });
    }
  }
}
