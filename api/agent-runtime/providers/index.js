/* Provider registration. Only these three names are known to the runtime. */
import { createFixtureProvider } from './fixture.js';
import { createOpenAIProvider } from './openai.js';

export const PROVIDER_IDS = Object.freeze(['fixture', 'openai', 'compatible']);

export function createProvider(provider, config = {}) {
  switch (provider) {
    case 'fixture':
      return createFixtureProvider(config);
    case 'openai':
    case 'compatible':
      return createOpenAIProvider({ ...config, id: provider });
    default:
      throw new Error(`unknown agent provider: ${String(provider)}`);
  }
}

export function isProviderId(value) {
  return PROVIDER_IDS.includes(value);
}
