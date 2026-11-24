/* LangChain BaseChatModel adapter for the in-repo deterministic fixture provider.
 *
 * Keeps all existing fixture test paths ('text', 'tool', 'proposal', 'error',
 * 'late', 'candidates', 'fallback-only') running identically through LangGraph
 * without touching the network, and supports prompt AbortSignal cancellation
 * during the 'late' delay.
 */
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BaseChatModelParams,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { ChatResult } from '@langchain/core/outputs';
import type { ModelInput } from '../../../agent-runtime/contracts.js';
import { AgentError } from '../../../agent-runtime/errors.js';
import { createFixtureProvider } from '../../../agent-runtime/providers/fixture.js';

export interface FixtureChatModelCallOptions extends BaseChatModelCallOptions {
  fixtureInput?: ModelInput;
}

export interface FixtureChatModelParams extends BaseChatModelParams {
  profile?: Record<string, unknown>;
  fixtureInput?: ModelInput;
  fixtureCase?: string;
  lateDelayMs?: number;
  toolName?: string;
  arguments?: Record<string, unknown>;
  targetId?: string;
  value?: string;
  errorMessage?: string;
  sequence?: Array<string | Record<string, unknown>>;
}

function readMessageText(message: BaseMessage | undefined): string {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(part => (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part
        ? String(part.text || '')
        : ''))
      .join('');
  }
  return '';
}

function fallbackModelInput(messages: BaseMessage[]): ModelInput {
  const lastHuman = [...messages].reverse().find(msg => msg.getType() === 'human');
  return {
    instructions: '',
    user: { text: readMessageText(lastHuman) },
    facts: [],
    memories: [],
    history: [],
    tools: [],
    toolResults: [],
  };
}

function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new AgentError('run_cancelled', 'the run was cancelled'));
  }
  const delay = Math.max(0, Number(ms) || 0);
  if (delay === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgentError('run_cancelled', 'the run was cancelled'));
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class FixtureChatModel extends BaseChatModel<FixtureChatModelCallOptions> {
  private readonly fixtureProfile: Record<string, unknown>;
  private readonly fixtureInput?: ModelInput;
  private readonly fixtureOptions: Omit<FixtureChatModelParams, keyof BaseChatModelParams | 'profile' | 'fixtureInput'>;
  private readonly provider: ReturnType<typeof createFixtureProvider>;

  constructor(fields: FixtureChatModelParams = {}) {
    const {
      profile = {},
      fixtureInput,
      fixtureCase,
      lateDelayMs,
      toolName,
      arguments: toolArgs,
      targetId,
      value,
      errorMessage,
      sequence,
      ...baseParams
    } = fields;
    super({
      ...baseParams,
      disableStreaming: true,
      verbose: false,
    });
    this.fixtureProfile = profile;
    this.fixtureInput = fixtureInput;
    this.fixtureOptions = {
      ...(fixtureCase !== undefined ? { fixtureCase } : {}),
      ...(lateDelayMs !== undefined ? { lateDelayMs } : {}),
      ...(toolName !== undefined ? { toolName } : {}),
      ...(toolArgs !== undefined ? { arguments: toolArgs } : {}),
      ...(targetId !== undefined ? { targetId } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
    };
    this.provider = createFixtureProvider({
      ...this.fixtureOptions,
      lateDelayMs: 0,
    });
  }

  override get callKeys(): string[] {
    return [...super.callKeys, 'fixtureInput'];
  }

  _llmType(): string {
    return 'open-gym-fixture';
  }

  override bindTools(_tools: BindToolsInput[], _kwargs?: Partial<FixtureChatModelCallOptions>) {
    return this;
  }

  async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    if (options.signal?.aborted) {
      throw new AgentError('run_cancelled', 'the run was cancelled');
    }
    const modelInput = options.fixtureInput ?? this.fixtureInput ?? fallbackModelInput(messages);
    const activeCase = this.fixtureOptions.fixtureCase
      ?? (this.fixtureProfile.fixtureCase as string | undefined)
      ?? modelInput.user?.fixtureCase;
    if (activeCase === 'late') {
      await waitAbortable(this.fixtureOptions.lateDelayMs ?? 250, options.signal);
    }

    const raw = await this.provider.invoke({
      profile: this.fixtureProfile,
      modelInput,
      signal: options.signal,
    });

    if (options.signal?.aborted) {
      throw new AgentError('run_cancelled', 'the run was cancelled');
    }

    if (raw && typeof raw === 'object' && 'error' in raw && raw.error) {
      const errObj = raw.error as { code?: unknown; message?: unknown };
      const code = errObj.code === 'model_timeout' ? 'model_timeout' : 'model_unavailable';
      const msg = typeof errObj.message === 'string' ? errObj.message : undefined;
      throw new AgentError(code, msg);
    }

    const rawRecord = (raw && typeof raw === 'object' ? raw : {}) as {
      text?: unknown;
      structured?: unknown;
      toolCalls?: Array<{ id?: unknown; name?: unknown; arguments?: unknown }>;
    };
    const text = typeof rawRecord.text === 'string' ? rawRecord.text : '';
    const toolCalls = Array.isArray(rawRecord.toolCalls)
      ? rawRecord.toolCalls.map((call, index) => ({
          id: typeof call.id === 'string' && call.id ? call.id : `call_${index + 1}`,
          name: String(call.name || ''),
          args: (call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
            ? call.arguments
            : {}) as Record<string, unknown>,
          type: 'tool_call' as const,
        }))
      : [];

    const aiMessage = new AIMessage({
      content: text,
      tool_calls: toolCalls,
      ...(rawRecord.structured !== undefined && rawRecord.structured !== null
        ? { additional_kwargs: { __openGymStructured: rawRecord.structured } }
        : {}),
    });

    return {
      generations: [{
        text,
        message: aiMessage,
      }],
    };
  }
}
