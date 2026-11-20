import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { AgentError, validateBaseUrl, phoneMayCall } from './shared';
import type { AgentProfileInput, AgentProfilePublic, AgentProfileRow } from './types';
import type { AgentStore } from './store';

export const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

const KEY = (digest: string, profileId: string) => `agent_${digest}_${profileId}`;

async function digestOf(scope: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope);
}

function capabilitiesOf(provider: AgentProfileRow['provider']) {
  if (provider === 'fixture') return { text: true, image: true, tools: true };
  return { text: true, image: true, tools: true };
}

function publicOf(profile: AgentProfileRow): AgentProfilePublic {
  return {
    ...profile,
    available: profile.provider === 'compatible'
      || profile.provider === 'fixture'
      || !!profile.keyHint,
  };
}

export class AgentConfig {
  constructor(private readonly store: AgentStore) {}

  async list(scope: string): Promise<AgentProfilePublic[]> {
    return this.store.listProfiles(scope).map(publicOf);
  }

  async create(scope: string, input: AgentProfileInput): Promise<AgentProfilePublic> {
    const provider = input.provider;
    if (provider !== 'fixture' && provider !== 'openai' && provider !== 'compatible') {
      throw new AgentError('invalid_request', 'provider must be fixture, openai or compatible');
    }
    const model = String(input.model || (provider === 'fixture' ? 'fixture' : '')).trim();
    if (!model || model.length > 200) throw new AgentError('invalid_request', 'model is required');
    const endpoint = this.endpointOf(provider, input.baseUrl, true);
    const key = String(input.apiKey || '').trim();
    if (provider === 'openai' && key.length < 8) throw new AgentError('invalid_request', 'an API key is required');
    const now = Date.now();
    const id = this.store.newId('profile');
    const keyName = KEY(await digestOf(scope), id);
    if (key) await SecureStore.setItemAsync(keyName, key);
    try {
      const profile: AgentProfileRow = {
        scope,
        id,
        source: 'local',
        provider,
        model,
        capabilities: capabilitiesOf(provider),
        ...(key ? { keyHint: key.slice(-4) } : {}),
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.store.saveProfile(profile);
      this.store.writeKv(scope, `endpoint:${id}`, endpoint ?? '');
      return publicOf(profile);
    } catch (error) {
      this.store.deleteProfile(scope, id);
      await SecureStore.deleteItemAsync(keyName).catch(() => undefined);
      throw error;
    }
  }

  async update(scope: string, profileId: string, input: AgentProfileInput): Promise<AgentProfilePublic> {
    const current = this.store.getProfile(scope, profileId);
    if (!current) throw new AgentError('profile_not_found', undefined, { details: { profileId } });
    const provider = input.provider || current.provider;
    if (provider !== 'fixture' && provider !== 'openai' && provider !== 'compatible') {
      throw new AgentError('invalid_request', 'provider must be fixture, openai or compatible');
    }
    const model = String(input.model || current.model).trim();
    if (!model || model.length > 200) throw new AgentError('invalid_request', 'model is required');
    const endpoint = this.endpointOf(
      provider,
      input.baseUrl ?? this.store.readKv<string>(scope, `endpoint:${profileId}`),
      true,
    );
    const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const keyName = KEY(await digestOf(scope), profileId);
    const previous = await SecureStore.getItemAsync(keyName).catch(() => null);
    if (key) await SecureStore.setItemAsync(keyName, key);
    if (provider === 'openai' && !key && !previous) {
      throw new AgentError('invalid_request', 'an API key is required');
    }
    try {
      const version = current.version + 1;
      const next: AgentProfileRow = {
        ...current,
        provider,
        model,
        capabilities: capabilitiesOf(provider),
        ...(key ? { keyHint: key.slice(-4) } : {}),
        version,
        updatedAt: Date.now(),
      };
      if (provider === 'fixture') delete next.keyHint;
      this.store.saveProfile(next);
      this.store.writeKv(scope, `endpoint:${profileId}`, endpoint ?? '');
      return publicOf(next);
    } catch (error) {
      this.store.saveProfile(current);
      if (key) {
        if (previous) await SecureStore.setItemAsync(keyName, previous).catch(() => undefined);
        else await SecureStore.deleteItemAsync(keyName).catch(() => undefined);
      }
      throw error;
    }
  }

  async remove(scope: string, profileId: string): Promise<boolean> {
    const removed = this.store.deleteProfile(scope, profileId);
    if (removed) await SecureStore.deleteItemAsync(KEY(await digestOf(scope), profileId)).catch(() => undefined);
    return removed;
  }

  async resolve(scope: string, profileId: string): Promise<{
    profile: AgentProfilePublic;
    provider: AgentProfileRow['provider'];
    model: string;
    baseUrl?: string;
    apiKey?: string | null;
  }> {
    const profile = this.store.getProfile(scope, profileId);
    if (!profile) throw new AgentError('profile_not_found', undefined, { details: { profileId } });
    const key = profile.provider === 'fixture'
      ? null
      : await SecureStore.getItemAsync(KEY(await digestOf(scope), profileId)).catch(() => null);
    if (profile.provider === 'openai' && !key) {
      throw new AgentError('profile_not_found', 'this configuration has no credential');
    }
    const baseUrl = profile.provider === 'fixture'
      ? undefined
      : this.endpointOf(profile.provider, this.store.readKv<string>(scope, `endpoint:${profileId}`), false);
    return {
      profile: publicOf(profile),
      provider: profile.provider,
      model: profile.model,
      ...(baseUrl ? { baseUrl } : {}),
      apiKey: key,
    };
  }

  private endpointOf(provider: AgentProfileRow['provider'], raw: unknown, strict: boolean): string | undefined {
    if (provider === 'fixture') return undefined;
    const value = String(raw || '').trim() || (provider === 'openai' ? DEFAULT_OPENAI_BASE : '');
    if (!value && strict) throw new AgentError('invalid_request', 'an endpoint is required');
    if (!value) return undefined;
    const checked = validateBaseUrl(value);
    if (!checked.ok || !checked.value) throw new AgentError('invalid_request', checked.error || 'the endpoint is invalid');
    if (!phoneMayCall(checked.value)) {
      throw new AgentError('invalid_request', 'plain http:// only works for an address on your home network');
    }
    return checked.value;
  }
}
