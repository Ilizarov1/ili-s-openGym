/* Provider registration. Only these names are known to the runtime. */
import { createFixtureProvider } from './fixture.js';
import { createOpenAIProvider } from './openai.js';

/** The one OpenCode inference endpoint. It is fixed here, never supplied by
 *  an account, so "opencode" cannot become a custom-endpoint bypass. */
export const OPENCODE_BASE_URL = 'https://opencode.ai/inference/openai/v1';

export const PROVIDER_IDS = Object.freeze(['fixture', 'openai', 'compatible', 'opencode']);

export function createProvider(provider, config = {}) {
  switch (provider) {
    case 'fixture':
      return createFixtureProvider(config);
    case 'openai':
    case 'compatible':
      return createOpenAIProvider({ ...config, id: provider });
    case 'opencode':
      return createOpenAIProvider({
        ...config,
        id: 'opencode',
        baseUrl: OPENCODE_BASE_URL,
      });
    default:
      throw new Error(`unknown agent provider: ${String(provider)}`);
  }
}

export function isProviderId(value) {
  return PROVIDER_IDS.includes(value);
}
