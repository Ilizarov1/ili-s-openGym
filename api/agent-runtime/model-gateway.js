/* The model gateway contract.
 *
 * A gateway resolves a profile reference inside the bound account/workspace,
 * checks the capabilities the task declared, and calls a provider. It owns no
 * network code; the server and RN host inject a provider.
 */
import { AgentError } from './errors.js';
import { DEEPSEEK_DEFAULT_MODEL, deepseekSupportsImages } from './providers/index.js';

const CAPS = ['text', 'image', 'tools'];

export function normalizeCapabilities(input) {
  const out = { text: input?.text !== false, image: input?.image === true, tools: input?.tools === true };
  for (const key of Object.keys(input || {})) {
    if (!CAPS.includes(key) && input[key] !== undefined) {
      throw new AgentError('invalid_request', `unknown model capability: ${key}`);
    }
  }
  return out;
}

/**
 * @param {{ capabilities?: Record<string, boolean> }} profile
 * @param {string[]} required
 */
export function assertCapabilities(profile, required = []) {
  const caps = profile?.capabilities || { text: true };
  for (const capability of required) {
    if (!CAPS.includes(capability)) throw new AgentError('invalid_request', `unknown capability: ${capability}`);
    if (!caps[capability]) {
      throw new AgentError('profile_capability_missing', `the selected profile cannot use ${capability}`, {
        details: { capability, profileId: profile?.profileId, capabilities: caps },
      });
    }
  }
  return caps;
}

export function requiredCapabilitiesFor(modelInput) {
  const required = ['text'];
  if (Array.isArray(modelInput?.user?.attachments) && modelInput.user.attachments.length) required.push('image');
  if (Array.isArray(modelInput?.tools) && modelInput.tools.length) required.push('tools');
  return required;
}

function parseArguments(value, index) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not an object');
      }
      return parsed;
    } catch {
      throw new AgentError('invalid_request', `model returned invalid arguments for tool call ${index}`);
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError('invalid_request', `model returned invalid arguments for tool call ${index}`);
  }
  return value;
}

/** Turn provider-specific text/tool payloads into the one shared shape. */
export function normalizeModelOutput(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new AgentError('model_unavailable', 'the model provider returned no answer');
  }
  if (raw.error) {
    const code = typeof raw.error.code === 'string' ? raw.error.code : 'model_unavailable';
    throw new AgentError(code === 'model_timeout' ? 'model_timeout' : 'model_unavailable',
      typeof raw.error.message === 'string' ? raw.error.message : undefined);
  }
  const text = raw.text == null ? '' : String(raw.text);
  const structured = raw.structured === undefined ? null : raw.structured;
  const calls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
  const toolCalls = calls.map((call, index) => {
    if (!call || typeof call !== 'object') {
      throw new AgentError('model_unavailable', 'the model provider returned an invalid tool call');
    }
    const name = String(call.name || call.toolId || '');
    if (!name || !/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) {
      throw new AgentError('model_unavailable', 'the model provider returned a tool call without a valid name');
    }
    return {
      id: typeof call.id === 'string' && call.id ? call.id : `call_${index + 1}`,
      name,
      arguments: parseArguments(call.arguments ?? call.args, index),
    };
  });
  return { text, structured, toolCalls };
}

/**
 * @param {{
 *   resolveProfile(profileRef: import('./contracts.js').ProfileReference, signal?: AbortSignal): Promise<{ profile: any, provider: any }>,
 * }} options
 */
export function createModelGateway(options) {
  const { resolveProfile } = options || {};
  if (typeof resolveProfile !== 'function') throw new Error('createModelGateway needs resolveProfile');
  return {
    async invoke(profileRef, modelInput, signal, required = requiredCapabilitiesFor(modelInput)) {
      const resolved = await resolveProfile(profileRef, signal);
      if (!resolved || !resolved.profile || !resolved.provider) {
        throw new AgentError('profile_not_found', undefined, { details: { profileId: profileRef?.profileId } });
      }
      assertCapabilities(resolved.profile, required);
      if (typeof resolved.provider.invoke !== 'function') {
        throw new AgentError('model_unavailable', 'the selected provider cannot be called');
      }
      const raw = await resolved.provider.invoke({
        profile: resolved.profile,
        modelInput,
        signal,
        timeoutMs: resolved.timeoutMs,
      });
      return normalizeModelOutput(raw);
    },
  };
}

/** The capabilities a provider table row advertises. */
export function providerCapabilities(provider, model = DEEPSEEK_DEFAULT_MODEL) {
  switch (provider) {
    case 'fixture':
      return { text: true, image: true, tools: true };
    case 'openai':
    case 'compatible':
      return { text: true, image: true, tools: true };
    case 'deepseek':
      return { text: true, image: deepseekSupportsImages(model), tools: true };
    default:
      return { text: true, image: false, tools: false };
  }
}
