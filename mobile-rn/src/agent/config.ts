import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { AgentError, validateBaseUrl, phoneMayCall } from './shared';
import type {
  AgentCapabilities, AgentExecutionLocation, AgentProfileCapabilityInput, AgentProfileInput, AgentProfilePublic,
  AgentProfileRow, AgentProfileSummary, AgentProvider,
} from './types';
import type { AgentStore } from './store';

export const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

const KEY = (digest: string, profileId: string) => `agent_${digest}_${profileId}`;
const PROVIDERS: AgentProvider[] = ['fixture', 'openai', 'compatible', 'opencode'];

async function digestOf(scope: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, scope);
}

function providerLabel(provider: string): string {
  if (provider === 'fixture') return 'Fixture';
  if (provider === 'opencode') return 'OpenCode';
  if (provider === 'compatible') return '兼容端点';
  return 'OpenAI';
}

function capabilitiesOf(
  provider: AgentProfileRow['provider'],
  override?: AgentProfileCapabilityInput,
): AgentCapabilities {
  if (override?.image !== undefined && typeof override.image !== 'boolean') {
    throw new AgentError('invalid_request', 'capabilities.image must be a boolean');
  }
  const base: AgentCapabilities = provider === 'opencode'
    ? { text: true, image: false, tools: false }
    : { text: true, image: true, tools: true };
  return override?.image === undefined ? base : { ...base, image: override.image };
}

function labelOf(profile: Pick<AgentProfileRow, 'provider' | 'model' | 'label'>): string {
  return profile.label?.trim() || `${providerLabel(profile.provider)} · ${profile.model}`;
}

export function summaryOf(profile: AgentProfilePublic): AgentProfileSummary {
  return {
    id: profile.id,
    label: labelOf(profile),
    provider: profile.provider,
    model: profile.model,
    version: profile.version,
  };
}

function publicOf(profile: AgentProfileRow): AgentProfilePublic {
  return {
    ...profile,
    label: labelOf(profile),
    available: profile.provider === 'compatible'
      || profile.provider === 'fixture'
      || !!profile.keyHint,
  };
}

function needsKey(provider: AgentProvider): boolean {
  return provider === 'openai' || provider === 'opencode';
}

function assertProvider(value: string): asserts value is AgentProvider {
  if (!PROVIDERS.includes(value as AgentProvider)) {
    throw new AgentError('invalid_request', 'provider must be fixture, openai, compatible or opencode');
  }
}

export type AgentRemoteCatalog = {
  profiles: () => Promise<AgentProfilePublic[]>;
  status?: () => Promise<{ enabled: boolean }>;
};

export type AgentLaunch = {
  /** Where the run executes; only used internally, never shown as a concept. */
  location: AgentExecutionLocation;
  profile: AgentProfilePublic;
  summary: AgentProfileSummary;
};

export type AgentLaunchOptions = {
  connection: { server: string; user: { id: string } } | null;
  remote?: AgentRemoteCatalog | null;
  /** Require the image capability for this turn. */
  requireImage?: boolean;
  /** Pin follow-ups to the execution location fixed by the first turn. */
  prefer?: { location: AgentExecutionLocation; profileId?: string };
};

function imageCapable(profile: AgentProfilePublic, required: boolean): boolean {
  return !required || profile.capabilities?.image === true;
}

function pickProfile(
  profiles: AgentProfilePublic[],
  requireImage: boolean,
  preferredId?: string,
): AgentProfilePublic | null {
  const usable = profiles.filter(profile => profile.available !== false && imageCapable(profile, requireImage));
  const preferred = preferredId ? usable.find(profile => profile.id === preferredId) : null;
  return preferred || usable[0] || null;
}

export class AgentConfig {
  constructor(private readonly store: AgentStore) {}

  async list(scope: string): Promise<AgentProfilePublic[]> {
    return this.store
      .listProfiles(scope)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(publicOf);
  }

  async create(scope: string, input: AgentProfileInput): Promise<AgentProfilePublic> {
    const provider = input.provider;
    assertProvider(provider);
    const model = String(input.model || (provider === 'fixture' ? 'fixture' : '')).trim();
    if (!model || model.length > 200) throw new AgentError('invalid_request', 'model is required');
    const endpoint = this.endpointOf(provider, input.baseUrl, true);
    const key = String(input.apiKey || '').trim();
    if (needsKey(provider) && key.length < 8) throw new AgentError('invalid_request', 'an API key is required');
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
        capabilities: capabilitiesOf(provider, input.capabilities),
        label: `${providerLabel(provider)} · ${model}`,
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
    assertProvider(provider);
    const model = String(input.model || current.model).trim();
    if (!model || model.length > 200) throw new AgentError('invalid_request', 'model is required');
    const endpoint = this.endpointOf(
      provider,
      provider === 'opencode' ? input.baseUrl : (input.baseUrl ?? this.store.readKv<string>(scope, `endpoint:${profileId}`)),
      true,
    );
    const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const keyName = KEY(await digestOf(scope), profileId);
    const previous = await SecureStore.getItemAsync(keyName).catch(() => null);
    if (key) await SecureStore.setItemAsync(keyName, key);
    if (needsKey(provider) && !key && !previous) {
      throw new AgentError('invalid_request', 'an API key is required');
    }
    try {
      const version = current.version + 1;
      const capabilities = input.capabilities?.image !== undefined
        ? capabilitiesOf(provider, input.capabilities)
        : provider === current.provider
          ? current.capabilities
          : capabilitiesOf(provider);
      const next: AgentProfileRow = {
        ...current,
        provider,
        model,
        capabilities,
        label: `${providerLabel(provider)} · ${model}`,
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

  /**
   * Silent first-turn resolution:
   * - paired: local profiles by id, then server user profiles, then the server default;
   * - practice: local profiles only.
   *
   * Follow-ups pass `prefer` and stay in the fixed execution location. A missing
   * image capability there is an error, never an automatic switch of location.
   */
  async resolveLaunch(scope: string, options: AgentLaunchOptions): Promise<AgentLaunch> {
    const requireImage = options.requireImage === true;
    if (options.prefer) {
      const found = await this.inLocation(scope, options.prefer.location, options, requireImage, options.prefer.profileId);
      if (found) return found;
      if (requireImage) {
        throw new AgentError('profile_capability_missing', 'no image-capable model is available here', {
          details: { location: options.prefer.location },
        });
      }
      throw new AgentError('profile_not_found', 'no model configuration is available');
    }

    const local = await this.list(scope);
    const localPick = pickProfile(local, requireImage);
    if (localPick) {
      return { location: 'local', profile: localPick, summary: summaryOf(localPick) };
    }

    if (!options.connection || !options.remote) {
      throw this.missing(requireImage);
    }
    const enabled = options.remote.status
      ? await options.remote.status().then(status => status.enabled !== false).catch(() => true)
      : true;
    if (!enabled) throw this.missing(requireImage);

    let remote: AgentProfilePublic[];
    try {
      remote = await options.remote.profiles();
    } catch {
      throw this.missing(requireImage);
    }
    const serverPick = pickServer(remote, requireImage);
    if (serverPick) {
      return { location: 'server', profile: serverPick, summary: summaryOf(serverPick) };
    }
    throw this.missing(requireImage);
  }

  private async inLocation(
    scope: string,
    location: AgentExecutionLocation,
    options: AgentLaunchOptions,
    requireImage: boolean,
    preferredId?: string,
  ): Promise<AgentLaunch | null> {
    if (location === 'local') {
      const profile = pickProfile(await this.list(scope), requireImage, preferredId);
      return profile ? { location, profile, summary: summaryOf(profile) } : null;
    }
    if (!options.connection || !options.remote) return null;
    const enabled = options.remote.status
      ? await options.remote.status().then(status => status.enabled !== false).catch(() => true)
      : true;
    if (!enabled) return null;
    try {
      const profile = pickServer(await options.remote.profiles(), requireImage, preferredId);
      return profile ? { location, profile, summary: summaryOf(profile) } : null;
    } catch {
      return null;
    }
  }

  private missing(requireImage: boolean): AgentError {
    return new AgentError(
      requireImage ? 'profile_capability_missing' : 'profile_not_found',
      requireImage ? 'no image-capable model configuration is available' : 'no model configuration is available',
    );
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
    if (needsKey(profile.provider) && !key) {
      throw new AgentError('profile_not_found', 'this configuration has no credential');
    }
    const baseUrl = profile.provider === 'fixture' || profile.provider === 'opencode'
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
    // OpenCode has one fixed endpoint inside the shared provider; accepting an
    // account-supplied URL here would turn the preset into a custom endpoint.
    if (provider === 'opencode') {
      if (String(raw || '').trim()) {
        throw new AgentError('invalid_request', 'opencode uses a fixed endpoint');
      }
      return undefined;
    }
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

function pickServer(
  profiles: AgentProfilePublic[],
  requireImage: boolean,
  preferredId?: string,
): AgentProfilePublic | null {
  const usable = profiles.filter(profile => profile.available !== false && imageCapable(profile, requireImage));
  const preferred = preferredId ? usable.find(profile => profile.id === preferredId) : null;
  if (preferred) return preferred;
  const users = usable
    .filter(profile => profile.source === 'user' || profile.source === 'server')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (users.length) return users[0];
  const defaults = usable
    .filter(profile => profile.source === 'default')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return defaults[0] || null;
}
