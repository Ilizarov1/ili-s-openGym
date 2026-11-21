/* Provider registration. Only these names are known to the runtime. */
import { createFixtureProvider } from './fixture.js';
import { createOpenAIProvider } from './openai.js';

/** The one OpenCode Go inference endpoint. It is fixed here, never supplied by
 *  an account, so "opencode" cannot become a custom-endpoint bypass. The
 *  credit-billed Console endpoint is a different product and returns 402 when
 *  the account only has a Go subscription. */
export const OPENCODE_BASE_URL = 'https://opencode.ai/inference/go/v1';
export const OPENCODE_CREDITS_BASE_URL = 'https://opencode.ai/inference/openai/v1';

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
