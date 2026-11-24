/* Message mapping, context budget enforcement, and output extraction.
 *
 * Converts openGym ModelInput into native LangChain SystemMessage / history /
 * multimodal HumanMessage sequences, and normalizes returned AIMessage objects
 * back to the shared ModelOutput + TokenUsage contract.
 */
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { Budgets, ModelInput, ModelOutput } from '../../../agent-runtime/contracts.js';
import { trimContext } from '../../../agent-runtime/context.js';
import { normalizeModelOutput } from '../../../agent-runtime/model-gateway.js';

export interface ExtractedTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

function promptBlock(label: string, value: unknown): string {
  return `## ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`;
}

function historyMessageOf(entry: { role: string; content: string }): BaseMessage {
  const text = String(entry?.content ?? '');
  if (entry?.role === 'assistant') return new AIMessage(text);
  if (entry?.role === 'system') return new SystemMessage(text);
  return new HumanMessage(text);
}

function buildCurrentUserMessage(trimmed: ModelInput): HumanMessage {
  const blocks: string[] = [];
  if (Array.isArray(trimmed.facts) && trimmed.facts.length) {
    blocks.push(
      promptBlock(
        'Facts',
        trimmed.facts.map(fact => ({ id: fact.evidenceId, content: fact.content })),
      ),
    );
  }
  if (Array.isArray(trimmed.memories) && trimmed.memories.length) {
    blocks.push(promptBlock('Confirmed memories', trimmed.memories));
  }
  if (Array.isArray(trimmed.toolResults) && trimmed.toolResults.length) {
    blocks.push(promptBlock('Tool results', trimmed.toolResults));
  }

  const attachments = Array.isArray(trimmed.user?.attachments)
    ? trimmed.user.attachments.filter(attachment => Boolean(attachment && attachment.dataUrl))
    : [];
  const userText = String(trimmed.user?.text || '');

  if (!attachments.length) {
    const combined = [userText, ...blocks].filter(part => part.length > 0).join('\n\n');
    return new HumanMessage(combined);
  }

  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [];
  if (userText) {
    parts.push({ type: 'text', text: userText });
  }
  for (const attachment of attachments) {
    if (!attachment.dataUrl) continue;
    if (attachment.label) {
      parts.push({ type: 'text', text: `[${attachment.label}]` });
    }
    parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl } });
  }
  if (blocks.length) {
    parts.push({ type: 'text', text: blocks.join('\n\n') });
  }
  return new HumanMessage({ content: parts });
}

export function buildInitialMessages(modelInput: ModelInput, budgets?: Budgets): BaseMessage[] {
  const trimmed = trimContext(modelInput, budgets) as ModelInput;
  const messages: BaseMessage[] = [new SystemMessage(String(trimmed.instructions || ''))];
  for (const item of Array.isArray(trimmed.history) ? trimmed.history : []) {
    if (!item || typeof item !== 'object') continue;
    messages.push(historyMessageOf(item));
  }
  messages.push(buildCurrentUserMessage(trimmed));
  return messages;
}

function readMessageText(message: BaseMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part) {
          return typeof part.text === 'string' ? part.text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function extractModelOutput(message: BaseMessage): ModelOutput {
  const structured = message.additional_kwargs?.__openGymStructured;
  const aiMessage = message as AIMessage;
  const validCalls = Array.isArray(aiMessage.tool_calls)
    ? aiMessage.tool_calls.map(call => ({
        id: call.id,
        name: call.name,
        arguments: call.args,
      }))
    : [];
  const invalidCalls = Array.isArray(aiMessage.invalid_tool_calls)
    ? aiMessage.invalid_tool_calls.map(call => ({
        id: call.id,
        name: call.name,
        arguments: call.args,
      }))
    : [];
  return normalizeModelOutput({
    text: readMessageText(message),
    ...(structured !== undefined ? { structured } : {}),
    toolCalls: [...validCalls, ...invalidCalls],
  });
}

function finiteNonNeg(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function extractTokenUsage(message: BaseMessage): ExtractedTokenUsage {
  const aiMessage = message as AIMessage;
  const meta = aiMessage.usage_metadata;
  const responseMeta = message.response_metadata as Record<string, unknown> | undefined;
  const responseUsage = (responseMeta?.usage ?? responseMeta?.tokenUsage) as
    | Record<string, unknown>
    | undefined;

  const inputTokens = finiteNonNeg(meta?.input_tokens)
    ?? finiteNonNeg(responseUsage?.prompt_tokens)
    ?? finiteNonNeg(responseUsage?.promptTokens);
  const outputTokens = finiteNonNeg(meta?.output_tokens)
    ?? finiteNonNeg(responseUsage?.completion_tokens)
    ?? finiteNonNeg(responseUsage?.completionTokens);
  const totalTokens = finiteNonNeg(meta?.total_tokens)
    ?? finiteNonNeg(responseUsage?.total_tokens)
    ?? finiteNonNeg(responseUsage?.totalTokens);

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}
