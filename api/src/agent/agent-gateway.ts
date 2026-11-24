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
import {
  createLangChainChatModel,
  extractModelOutput,
  extractTokenUsage,
  mapLangChainError,
  type LangChainGateway,
  type LangChainGatewayInvokeOptions,
  type LangChainGatewayInvokeResult,
} from './langchain/index.js';

function defaultModelTimeoutMs(): number {
  const configured = Number(process.env.AGENT_MODEL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 60_000;
}

@Injectable()
export class AgentGateway {
  constructor(private readonly configs: AgentConfigStore) {}

  forAccount(uid: string) {
    return {
      invoke: (profileRef: ProfileReference, modelInput: ModelInput, signal?: AbortSignal) =>
        this.invoke(uid, profileRef, modelInput, signal),
    };
  }

  forAccountLangChain(uid: string): LangChainGateway {
    return {
      invokeMessages: (profileRef: ProfileReference, options: LangChainGatewayInvokeOptions) =>
        this.invokeLangChain(uid, profileRef, options),
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
    const timeoutMs = defaultModelTimeoutMs();
    const provider = createProvider(resolved.provider, {
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      model: resolved.model,
      timeoutMs,
    });
    const raw = await provider.invoke({ profile: resolved.profile, modelInput, signal, timeoutMs });
    return normalizeModelOutput(raw);
  }

  async invokeLangChain(
    uid: string,
    profileRef: ProfileReference,
    options: LangChainGatewayInvokeOptions,
  ): Promise<LangChainGatewayInvokeResult> {
    const reference = profileRef as ProfileReference & { id?: string };
    const profileId = reference.profileId || reference.id || '';
    const resolved = await this.configs.resolve(uid, profileId);
    if (reference.version !== undefined && resolved.profile.version !== reference.version) {
      throw new AgentError('profile_not_found', 'the model configuration changed before this call', {
        details: { profileId },
      });
    }
    assertCapabilities(
      resolved.profile as unknown as { capabilities?: Record<string, boolean> },
      options.requiredCapabilities,
    );
    const timeoutMs = options.timeoutMs ?? defaultModelTimeoutMs();
    const model = createLangChainChatModel({
      resolved,
      tools: options.tools,
      responseFormat: options.responseFormat,
      signal: options.signal,
      timeoutMs,
      fixtureInput: options.fixtureInput,
    });
    try {
      const message = await model.invoke(options.messages, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.callbacks?.length ? { callbacks: options.callbacks } : {}),
      });
      const output = extractModelOutput(message);
      const usage = extractTokenUsage(message);
      return { message, output, usage };
    } catch (error) {
      throw mapLangChainError(error, options.signal);
    }
  }
}
