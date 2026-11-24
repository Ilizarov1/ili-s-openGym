/* Provider registration. Only these names are known to the runtime. */
import { createFixtureProvider } from './fixture.js';
import { createOpenAIProvider } from './openai.js';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-flash';

export const PROVIDER_IDS = Object.freeze(['fixture', 'openai', 'compatible', 'deepseek']);

export function deepseekSupportsImages(model) {
  return model === DEEPSEEK_DEFAULT_MODEL
    || model === 'deepseek-v4-flash'
    || model === 'deepseek-v4-flash-vision-exp';
}

export function createProvider(provider, config = {}) {
  switch (provider) {
    case 'fixture':
      return createFixtureProvider(config);
    case 'openai':
    case 'compatible':
      return createOpenAIProvider({ ...config, id: provider });
    case 'deepseek':
      return createOpenAIProvider({
        ...config,
        id: 'deepseek',
        baseUrl: DEEPSEEK_BASE_URL,
        imageCapable: deepseekSupportsImages(config.model),
      });
    default:
      throw new Error(`unknown agent provider: ${String(provider)}`);
  }
}

export function isProviderId(value) {
  return PROVIDER_IDS.includes(value);
}
