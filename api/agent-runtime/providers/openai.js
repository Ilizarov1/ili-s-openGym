/* OpenAI Chat Completions and OpenAI-compatible providers.
 *
 * One request shape, bounded by the shared HTTP client. Images travel as data
 * URLs; tool definitions use the function-calling shape. The provider returns
 * the raw shared model output and lets normalizeModelOutput validate it.
 */
import { AgentError } from '../errors.js';
import { createHttpClient } from './http.js';
import { validateBaseUrl } from './endpoint.js';

export const DEFAULT_MAX_TOKENS = 4096;

function textContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part && part.type === 'text') return part.text || '';
      return '';
    }).join('');
  }
  return '';
}

function userContent(modelInput) {
  const attachments = Array.isArray(modelInput?.user?.attachments) ? modelInput.user.attachments : [];
  if (!attachments.length) return String(modelInput?.user?.text || '');
  const parts = [];
  if (modelInput.user.text) parts.push({ type: 'text', text: String(modelInput.user.text) });
  for (const attachment of attachments) {
    if (!attachment || !attachment.dataUrl) continue;
    if (attachment.label) parts.push({ type: 'text', text: `[${attachment.label}]` });
    parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
  }
  return parts.length ? parts : '';
}

function promptBlock(label, value) {
  return `## ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`;
}

export function buildOpenAIRequest({ model, modelInput, maxTokens = DEFAULT_MAX_TOKENS }) {
  const messages = [
    { role: 'system', content: String(modelInput?.instructions || '') },
  ];
  const blocks = [userContent(modelInput)];
  if (Array.isArray(modelInput?.facts) && modelInput.facts.length) {
    blocks.push(promptBlock('Facts', modelInput.facts.map(fact => ({ id: fact.evidenceId, content: fact.content }))));
  }
  if (Array.isArray(modelInput?.memories) && modelInput.memories.length) {
    blocks.push(promptBlock('Confirmed memories', modelInput.memories));
  }
  if (Array.isArray(modelInput?.history) && modelInput.history.length) {
    blocks.push(promptBlock('Recent conversation', modelInput.history));
  }
  if (Array.isArray(modelInput?.toolResults) && modelInput.toolResults.length) {
    blocks.push(promptBlock('Tool results', modelInput.toolResults));
  }
  const content = blocks.length === 1 ? blocks[0] : (typeof blocks[0] === 'string'
    ? blocks.join('\n\n')
    : [...blocks[0], { type: 'text', text: blocks.slice(1).join('\n\n') }]);
  messages.push({ role: 'user', content });
  const body = { model, messages, max_tokens: maxTokens };
  if (modelInput?.responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }
  const tools = Array.isArray(modelInput?.tools) ? modelInput.tools : [];
  if (tools.length) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

/**
 * @param {{
 *   id?: string,
 *   baseUrl: string,
 *   apiKey?: string | null,
 *   model: string,
 *   headers?: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 *   AbortControllerImpl?: typeof AbortController,
 *   timeoutMs?: number,
 *   maxTokens?: number,
 * }} config
 */
export function createOpenAIProvider(config = {}) {
  const id = config.id === 'compatible' || config.id === 'opencode' ? config.id : 'openai';
  const baseUrl = validateBaseUrl(config.baseUrl);
  if (!baseUrl.ok) throw new AgentError('invalid_request', baseUrl.error);
  if (!baseUrl.value) throw new AgentError('invalid_request', 'an OpenAI endpoint needs a base URL');
  if (!config.model) throw new AgentError('invalid_request', 'an OpenAI endpoint needs a model');
  const endpoint = `${baseUrl.value.replace(/\/+$/, '')}/chat/completions`;
  const request = createHttpClient(config);
  const timeoutMs = Math.max(1, Number(config.timeoutMs) || 60000);
  const maxTokens = Math.max(1, Number(config.maxTokens) || DEFAULT_MAX_TOKENS);

  return {
    id,
    capabilities: { text: true, image: true, tools: true },
    async invoke(input = {}) {
      const body = buildOpenAIRequest({
        model: config.model,
        modelInput: input.modelInput,
        maxTokens,
      });
      const headers = {
        'content-type': 'application/json',
        ...(config.headers || {}),
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        ...(id === 'opencode' ? {
          'x-opencode-session': String(
            input.modelInput?.sessionId
            || input.sessionId
            || `opengym-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
          ).slice(0, 128),
        } : {}),
      };
      const response = await request(endpoint, { method: 'POST', headers, body: JSON.stringify(body) }, {
        timeoutMs,
        signal: input.signal,
      });
      if (!response.ok) {
        const message = response.data?.error?.message;
        throw new AgentError('model_unavailable', `provider answered HTTP ${response.status}`, {
          details: {
            status: response.status,
            ...(typeof message === 'string' ? { providerMessage: message.slice(0, 300) } : {}),
          },
        });
      }
      const choice = response.data?.choices?.[0];
      if (!choice || !choice.message) {
        throw new AgentError('model_unavailable', 'provider answered without a message');
      }
      const message = choice.message;
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls.map(call => ({
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments,
      })) : [];
      return {
        text: textContent(message.content),
        structured: null,
        toolCalls: calls,
      };
    },
  };
}
