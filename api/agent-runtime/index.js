/* Public surface of the shared agent runtime.
 *
 * Both hosts import from here; the module has no Node built-in imports so Metro
 * can bundle it.
 */
export * from './contracts.js';
export * from './errors.js';
export { createId, createIds } from './ids.js';
export { validate, assertValid, isValid, describeSchema } from './schema.js';
export {
  bindContext,
  addEvidence,
  resolveEvidence,
  evidenceList,
  trimContext,
  contextChars,
  inTargetScope,
} from './context.js';
export { createToolRegistry, createDispatcher, checkToolArgs } from './tools.js';
export { createProposalService, createMemoryProposalStore } from './proposals.js';
export { createRunState } from './state.js';
export {
  selectMemories,
  projectMemories,
  createMemoryProposal,
  createMemoryProposalAdapter,
  createMemoryStore,
} from './memory.js';
export {
  createModelGateway,
  assertCapabilities,
  normalizeCapabilities,
  normalizeModelOutput,
  requiredCapabilitiesFor,
  providerCapabilities,
} from './model-gateway.js';
export { runAgent } from './run.js';
export { createProvider, isProviderId, PROVIDER_IDS } from './providers/index.js';
export { createFixtureProvider } from './providers/fixture.js';
export { createOpenAIProvider, buildOpenAIRequest } from './providers/openai.js';
export { createHttpClient } from './providers/http.js';
export { validateBaseUrl, phoneMayCall, isPrivateHost } from './providers/endpoint.js';
