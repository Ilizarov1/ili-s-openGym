/* Server model gateway: resolves the account's profile afresh for every model
 * round, asserts the current capabilities and calls the shared provider. */
import { Injectable } from '@nestjs/common';
import { AgentError } from '../../agent-runtime/errors.js';
import {
  assertCapabilities,
  normalizeModelOutput,
  requiredCapabilitiesFor,
} from '../../agent-runtime/model-gateway.js';
import { createProvider } from '../../agent-runtime/providers/index.js';
import type { ModelInput, ProfileReference } from '../../agent-runtime/contracts.js';
import { AgentConfigStore } from './agent-config.store.js';

@Injectable()
export class AgentGateway {
  constructor(private readonly configs: AgentConfigStore) {}

  forAccount(uid: string) {
    return {
      invoke: (profileRef: ProfileReference, modelInput: ModelInput, signal?: AbortSignal) =>
        this.invoke(uid, profileRef, modelInput, signal),
    };
  }

  async invoke(
    uid: string,
    profileRef: ProfileReference,
    modelInput: ModelInput,
    signal?: AbortSignal,
  ) {
    const reference = profileRef as ProfileReference & { id?: string };
    const profileId = reference.profileId || reference.id || '';
    const resolved = await this.configs.resolve(uid, profileId);
    if (reference.version !== undefined && resolved.profile.version !== reference.version) {
      throw new AgentError('profile_not_found', 'the model configuration changed before this call', {
        details: { profileId },
      });
    }
    const required = requiredCapabilitiesFor(modelInput);
    assertCapabilities(
      resolved.profile as unknown as { capabilities?: Record<string, boolean> },
      required,
    );
    const provider = createProvider(resolved.provider, {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      timeoutMs: 60_000,
    });
    const raw = await provider.invoke({ profile: resolved.profile, modelInput, signal, timeoutMs: 60_000 });
    return normalizeModelOutput(raw);
  }
}
