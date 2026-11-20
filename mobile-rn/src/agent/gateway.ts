// RN model gateway. The shared provider talks to the endpoint directly with
// React Native's fetch; this file only resolves the selected local profile and
// enforces the capability contract.
import { createProvider, assertCapabilities, normalizeModelOutput, requiredCapabilitiesFor, AgentError } from './shared';
import type { AgentConfig } from './config';
import type { ModelInput, ModelOutput, ProfileReference } from './shared';

export class AgentGateway {
  constructor(private readonly config: AgentConfig) {}

  forScope(scope: string) {
    return {
      invoke: (profileRef: ProfileReference, modelInput: ModelInput, signal?: AbortSignal): Promise<ModelOutput> =>
        this.invoke(scope, profileRef, modelInput, signal),
    };
  }

  async invoke(
    scope: string,
    profileRef: ProfileReference,
    modelInput: ModelInput,
    signal?: AbortSignal,
  ): Promise<ModelOutput> {
    const resolved = await this.config.resolve(scope, profileRef.profileId || profileRef.id || '');
    if (profileRef.version !== undefined && resolved.profile.version !== profileRef.version) {
      throw new AgentError('profile_not_found', 'the model configuration changed before this call');
    }
    assertCapabilities(
      { capabilities: resolved.profile.capabilities },
      requiredCapabilitiesFor(modelInput),
    );
    const provider = createProvider(resolved.provider, {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      timeoutMs: 60_000,
      ...(resolved.provider === 'fixture' ? { lateDelayMs: 5000 } : {}),
    });
    const raw = await provider.invoke({ profile: resolved.profile, modelInput, signal });
    return normalizeModelOutput(raw);
  }
}
