/* Builds per-round LangChain BaseChatModel instances from ResolvedAgentProfile.
 *
 * Enforces validateBaseUrl(), DeepSeek non-thinking JSON kwargs, optional JSON
 * response_format, bounded fetch with 1 MiB / full-body timeout, maxRetries: 0,
 * verbose: false, and conditional bindTools (only when tools.length > 0).
 */
import { ChatOpenAI, type ChatOpenAICallOptions } from '@langchain/openai';
import type { BaseChatModel, BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import type { AIMessageChunk } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { ModelInput } from '../../../agent-runtime/contracts.js';
import { AgentError } from '../../../agent-runtime/errors.js';
import { validateBaseUrl } from '../../../agent-runtime/providers/endpoint.js';
import { DEEPSEEK_BASE_URL } from '../../../agent-runtime/providers/index.js';
import { DEFAULT_MAX_TOKENS } from '../../../agent-runtime/providers/openai.js';
import type { ResolvedAgentProfile } from '../agent-config.store.js';
import { createBoundedFetch } from './http-fetch.js';
import { FixtureChatModel } from './fixture-chat-model.js';

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export type ServerRunnableChatModel =
  | FixtureChatModel
  | BaseChatModel<BaseChatModelCallOptions>
  | Runnable<BaseLanguageModelInput, AIMessageChunk, ChatOpenAICallOptions>;

export interface CreateLangChainChatModelOptions {
  resolved: ResolvedAgentProfile;
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  responseFormat?: 'json';
  signal?: AbortSignal | null;
  timeoutMs?: number;
  maxBytes?: number;
  fixtureInput?: ModelInput;
  lateDelayMs?: number;
  fetchImpl?: typeof fetch;
  /** Stream provider tokens instead of buffering the whole completion. */
  streaming?: boolean;
}

export function resolveServerOpenAIBaseUrl(
  resolved: Pick<ResolvedAgentProfile, 'provider' | 'baseUrl'>,
): string {
  if (resolved.provider === 'deepseek') {
    const raw = resolved.baseUrl || DEEPSEEK_BASE_URL;
    const checked = validateBaseUrl(raw);
    if (!checked.ok) throw new AgentError('invalid_request', checked.error);
    if (!checked.value) throw new AgentError('invalid_request', 'a DeepSeek endpoint needs a base URL');
    return checked.value;
  }

  if (resolved.provider === 'openai' || resolved.provider === 'compatible') {
    const raw = resolved.baseUrl ? String(resolved.baseUrl).trim() : '';
    if (!raw) return OPENAI_DEFAULT_BASE_URL;
    const checked = validateBaseUrl(raw);
    if (!checked.ok) throw new AgentError('invalid_request', checked.error);
    if (!checked.value) return OPENAI_DEFAULT_BASE_URL;
    if (checked.value === 'https://api.openai.com') return OPENAI_DEFAULT_BASE_URL;
    return checked.value;
  }

  throw new AgentError('invalid_request', `unknown agent provider: ${String(resolved.provider)}`);
}

export function createLangChainChatModel(options: CreateLangChainChatModelOptions): ServerRunnableChatModel {
  const { resolved } = options;
  if (resolved.provider === 'fixture') {
    return new FixtureChatModel({
      profile: resolved.profile as unknown as Record<string, unknown>,
      fixtureInput: options.fixtureInput,
      ...(options.lateDelayMs !== undefined ? { lateDelayMs: options.lateDelayMs } : {}),
    });
  }

  if (!resolved.model) {
    throw new AgentError('invalid_request', 'an OpenAI endpoint needs a model');
  }

  const baseURL = resolveServerOpenAIBaseUrl(resolved);
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 60_000);
  const boundedFetch = createBoundedFetch({
    timeoutMs,
    maxBytes: options.maxBytes,
    signal: options.signal,
    omitAuthHeader: !resolved.apiKey,
    fetchImpl: options.fetchImpl,
    streaming: options.streaming === true,
  });

  const modelKwargs: Record<string, unknown> = {};
  if (resolved.provider === 'deepseek') {
    modelKwargs.thinking = { type: 'disabled' };
  }
  if (options.responseFormat === 'json') {
    modelKwargs.response_format = { type: 'json_object' };
  }

  const chatModel = new ChatOpenAI({
    model: resolved.model,
    apiKey: resolved.apiKey || 'no-key-required',
    maxTokens: DEFAULT_MAX_TOKENS,
    maxRetries: 0,
    timeout: timeoutMs,
    verbose: false,
    useResponsesApi: false,
    streaming: options.streaming === true,
    configuration: {
      baseURL,
      fetch: boundedFetch,
    },
    ...(Object.keys(modelKwargs).length ? { modelKwargs } : {}),
  });

  const tools = Array.isArray(options.tools) ? options.tools : [];
  if (tools.length > 0) {
    const openAiTools = tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    return chatModel.bindTools(openAiTools, { tool_choice: 'auto' });
  }

  return chatModel;
}
