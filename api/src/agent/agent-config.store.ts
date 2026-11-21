/* Model configuration: the instance default and per-account BYOK profiles.
 *
 * The default profile mirrors the Coach admin configuration, but only in
 * instance auth mode and only for the fixture or an administrator-configured
 * HTTP endpoint. A server account may add its own fixture/OpenAI profile; it
 * never supplies a custom endpoint, because outbound targets are the server's
 * decision, not an account's.
 */
import { Injectable } from '@nestjs/common';
import * as coachConfig from '../../coach/config.js';
import { baseUrlFor } from '../../coach/core/providers.js';
import { AgentError } from '../../agent-runtime/errors.js';
import { providerCapabilities } from '../../agent-runtime/model-gateway.js';
import type { AgentAccountData, AgentProfilePublic, AgentStoredProfile } from './agent.types.js';
import { AgentCrypto } from './agent-crypto.js';
import { agentVision, fixtureAllowed } from './agent.flags.js';
import { OPENCODE_BASE_URL } from '../../agent-runtime/providers/index.js';
import { AgentStore } from './agent.store.js';

const SERVER_PROVIDERS = new Set(['fixture', 'openai', 'opencode']);
const DEFAULT_ID = 'default';
const DEFAULT_OPENCODE_MODEL = 'deepseek-v4.1-flash';

export interface ResolvedAgentProfile {
  profile: AgentProfilePublic & { capabilities: { text: boolean; image: boolean; tools: boolean } };
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string | null;
}

function keyHintOf(key: string): string {
  const clean = String(key || '');
  return clean.length > 4 ? clean.slice(-4) : '****';
}

function labelOf(provider: string): string {
  if (provider === 'fixture') return 'Fixture';
  if (provider === 'opencode') return 'OpenCode';
  return 'OpenAI';
}

function capabilitiesFor(provider: string, override?: unknown): { text: boolean; image: boolean; tools: boolean } {
  const base = providerCapabilities(provider);
  const caps = override && typeof override === 'object' && !Array.isArray(override)
    ? override as Record<string, unknown>
    : null;
  if (caps && caps.image !== undefined) {
    if (typeof caps.image !== 'boolean') throw new AgentError('invalid_request', 'capabilities.image must be a boolean');
    base.image = caps.image;
  }
  return base;
}

function providerOf(value: unknown): 'fixture' | 'openai' | 'opencode' {
  const provider = String(value || '');
  if (!SERVER_PROVIDERS.has(provider)) {
    throw new AgentError('invalid_request', 'provider must be fixture, openai or opencode');
  }
  return provider as 'fixture' | 'openai' | 'opencode';
}

function needsKey(provider: string): boolean {
  return provider === 'openai' || provider === 'opencode';
}

@Injectable()
export class AgentConfigStore {
  constructor(
    private readonly store: AgentStore,
    private readonly crypto: AgentCrypto,
  ) {}

  private defaultProfile(uid: string): ResolvedAgentProfile | null {
    const opencodeKey = String(process.env.OPENCODE_API_KEY || '').trim();
    if (opencodeKey) {
      const model = String(process.env.OPENCODE_MODEL || DEFAULT_OPENCODE_MODEL).trim() || DEFAULT_OPENCODE_MODEL;
      return {
        profile: {
          id: DEFAULT_ID,
          source: 'default',
          provider: 'opencode',
          model,
          capabilities: { text: true, image: agentVision(), tools: true },
          version: 1,
          label: 'OpenCode (instance)',
          available: true,
        },
        provider: 'opencode',
        model,
        baseUrl: OPENCODE_BASE_URL,
        apiKey: opencodeKey,
      };
    }
    if (!coachConfig.isEnabled() || !coachConfig.isConnected()) return null;
    const cfg = coachConfig.load();
    if (cfg.authMode !== 'instance') return null;
    if (!(coachConfig.PROVIDERS as Record<string, unknown>)[cfg.provider]) return null;
    const provider = cfg.provider === 'fixture' ? 'fixture' : cfg.provider === 'openai' || cfg.provider === 'compatible' ? 'openai' : null;
    if (!provider) return null;
    if (provider === 'fixture' && !fixtureAllowed()) return null;
    const credential = provider === 'fixture' ? { ok: true, auth: null } : coachConfig.credentialFor(uid);
    if (!credential || !credential.ok) return null;
    const model = provider === 'fixture' ? 'fixture' : coachConfig.modelFor(cfg, cfg.provider);
    if (!model) return null;
    return {
      profile: {
        id: DEFAULT_ID,
        source: 'default',
        provider,
        model,
        capabilities: { ...providerCapabilities(provider), image: agentVision() },
        version: 1,
        label: provider === 'fixture' ? 'Fixture (instance)' : 'Instance default',
        available: true,
      },
      provider,
      model,
      ...(provider === 'fixture' ? {} : { baseUrl: baseUrlFor(cfg.provider, cfg) }),
      apiKey: provider === 'fixture' ? null : credential.auth?.token || null,
    };
  }

  private defaultPublic(uid: string): AgentProfilePublic {
    const resolved = this.defaultProfile(uid);
    if (resolved) return resolved.profile;
    let reason = 'The instance has no agent-capable default configuration.';
    if (!coachConfig.isEnabled()) reason = 'The instance model configuration is switched off.';
    else if (!coachConfig.isConnected()) reason = 'The instance model configuration is not connected.';
    else if (coachConfig.load().authMode !== 'instance') reason = 'The instance uses per-profile Coach credentials.';
    return {
      id: DEFAULT_ID,
      source: 'default',
      provider: 'none',
      model: '',
      capabilities: { text: false, image: false, tools: false },
      version: 0,
      label: 'Instance default',
      available: false,
      reason,
    };
  }

  private userPublic(profile: AgentStoredProfile): AgentProfilePublic {
    return {
      id: profile.id,
      source: 'user',
      provider: profile.provider,
      model: profile.model,
      capabilities: profile.capabilities,
      ...(profile.keyHint ? { keyHint: profile.keyHint } : {}),
      version: profile.version,
      label: labelOf(profile.provider),
      available: profile.provider !== 'fixture' || fixtureAllowed(),
      ...(profile.provider === 'fixture' && !fixtureAllowed() ? { reason: 'Fixture profiles are not available on this instance.' } : {}),
    };
  }

  async list(uid: string): Promise<AgentProfilePublic[]> {
    const data = this.store.read(uid);
    const profiles = Object.values(data.profiles).map(profile => this.userPublic(profile));
    return [this.defaultPublic(uid), ...profiles.sort((a, b) => a.id.localeCompare(b.id))];
  }

  async create(uid: string, body: Record<string, unknown>, id: string): Promise<AgentProfilePublic> {
    const provider = providerOf(body.provider);
    if (body.baseUrl !== undefined && body.baseUrl !== null && String(body.baseUrl).trim() !== '') {
      throw new AgentError('invalid_request', 'server profiles do not accept a custom endpoint');
    }
    if (provider === 'fixture' && !fixtureAllowed()) {
      throw new AgentError('invalid_request', 'fixture profiles are not available on this instance');
    }
    const model = String(body.model || (provider === 'fixture' ? 'fixture' : '')).trim();
    if (!model || model.length > 200) throw new AgentError('invalid_request', 'model is required');
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (needsKey(provider) && apiKey.length < 8) {
      throw new AgentError('invalid_request', 'an API key is required');
    }
    if (needsKey(provider) && !this.crypto.enabled) {
      throw new AgentError('agent_config_disabled');
    }
    const now = Date.now();
    const profile: AgentStoredProfile = {
      id,
      provider,
      model,
      capabilities: capabilitiesFor(provider, body.capabilities),
      ...(needsKey(provider) ? {
        secret: this.crypto.encrypt(uid, id, 1, apiKey),
        keyHint: keyHintOf(apiKey),
      } : {}),
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.update(uid, data => {
      if (data.profiles[id]) throw new AgentError('invalid_request', 'profile id already exists');
      data.profiles[id] = profile;
    });
    return this.userPublic(profile);
  }

  async update(uid: string, profileId: string, body: Record<string, unknown>): Promise<AgentProfilePublic> {
    if (!profileId || profileId === DEFAULT_ID) {
      throw new AgentError('invalid_request', 'the default profile is read-only');
    }
    if (body.baseUrl !== undefined && body.baseUrl !== null && String(body.baseUrl).trim() !== '') {
      throw new AgentError('invalid_request', 'server profiles do not accept a custom endpoint');
    }
    let updated: AgentStoredProfile | null = null;
    await this.store.update(uid, data => {
      const current = data.profiles[profileId];
      if (!current) throw new AgentError('profile_not_found');
      const provider = body.provider === undefined ? current.provider : providerOf(body.provider);
      if (provider === 'fixture' && !fixtureAllowed()) {
        throw new AgentError('invalid_request', 'fixture profiles are not available on this instance');
      }
      const model = body.model === undefined ? current.model : String(body.model).trim();
      if (!model || model.length > 200) throw new AgentError('invalid_request', 'model is required');
      const suppliedKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      const version = (current.version || 0) + 1;
      let secret = current.secret;
      let keyHint = current.keyHint;
      if (needsKey(provider)) {
        if (suppliedKey) {
          if (suppliedKey.length < 8) throw new AgentError('invalid_request', 'an API key is required');
          if (!this.crypto.enabled) throw new AgentError('agent_config_disabled');
          secret = this.crypto.encrypt(uid, profileId, version, suppliedKey);
          keyHint = keyHintOf(suppliedKey);
        } else if (current.secret) {
          if (!this.crypto.enabled) throw new AgentError('agent_config_disabled');
          const plaintext = this.crypto.decrypt(uid, profileId, current.version, current.secret);
          secret = this.crypto.encrypt(uid, profileId, version, plaintext);
        } else {
          throw new AgentError('invalid_request', 'an API key is required');
        }
      } else {
        secret = undefined;
        keyHint = undefined;
      }
      updated = {
        ...current,
        provider,
        model,
        capabilities: capabilitiesFor(provider, body.capabilities === undefined ? current.capabilities : body.capabilities),
        ...(secret ? { secret } : {}),
        ...(keyHint ? { keyHint } : {}),
        version,
        updatedAt: Date.now(),
      };
      if (!secret) delete updated.secret;
      if (!keyHint) delete updated.keyHint;
      data.profiles[profileId] = updated;
    });
    if (!updated) throw new AgentError('profile_not_found');
    return this.userPublic(updated);
  }

  async remove(uid: string, profileId: string): Promise<boolean> {
    if (!profileId || profileId === DEFAULT_ID) {
      throw new AgentError('invalid_request', 'the default profile is read-only');
    }
    return this.store.update(uid, data => {
      if (!data.profiles[profileId]) return false;
      delete data.profiles[profileId];
      return true;
    });
  }

  async resolve(uid: string, profileId: string): Promise<ResolvedAgentProfile> {
    if (profileId === DEFAULT_ID) {
      const resolved = this.defaultProfile(uid);
      if (!resolved) throw new AgentError('profile_not_found', 'the instance default profile is not available', {
        details: { profileId },
      });
      return resolved;
    }
    const data = this.store.read(uid);
    const profile = data.profiles[profileId];
    if (!profile) throw new AgentError('profile_not_found', undefined, { details: { profileId } });
    if (profile.provider === 'fixture' && !fixtureAllowed()) {
      throw new AgentError('profile_not_found', 'fixture profiles are not available on this instance');
    }
    let apiKey: string | null = null;
    if (needsKey(profile.provider)) {
      if (!profile.secret) throw new AgentError('agent_config_disabled', 'this profile has no credential');
      apiKey = this.crypto.decrypt(uid, profile.id, profile.version, profile.secret);
    }
    const publicProfile = this.userPublic(profile);
    if (!publicProfile.available) throw new AgentError('profile_not_found', publicProfile.reason);
    return {
      profile: publicProfile,
      provider: profile.provider,
      model: profile.model,
      apiKey,
    };
  }

  /** The account's stored profile, for a version check before credentials are read. */
  stored(uid: string, profileId: string): AgentStoredProfile | null {
    return this.store.read(uid).profiles[profileId] || null;
  }

  data(uid: string): AgentAccountData {
    return this.store.read(uid);
  }
}
