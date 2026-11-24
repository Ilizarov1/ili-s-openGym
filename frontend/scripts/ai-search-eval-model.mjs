#!/usr/bin/env node
// The evaluation model runner (D10 of docs/ai-exercise-search/EVAL_CLI_EXECUTION.md).
//
//   createEvaluationModelRunner(env, { provider?, gateway? }) -> { run(sampleInput, diagnostic) }
//
// Provider selection comes from the OPEN_GYM_EVAL_* variables:
//   OPEN_GYM_EVAL_PROVIDER  fixture | openai | compatible | deepseek
//   OPEN_GYM_EVAL_MODEL     required for the three real providers
//   OPEN_GYM_EVAL_BASE_URL  openai default / compatible required / deepseek fixed
//   OPEN_GYM_EVAL_API_KEY   required; deepseek can use DEEPSEEK_API_KEY
//
// Configuration problems throw before any sample request is sent, so the
// entry can exit 2 without touching the network. The profile lives only in
// memory for the duration of the run — it is never written to any account
// configuration. `overrides.provider` / `overrides.gateway` exist so tests can
// inject a counting fixture provider or gateway instead of the real one.

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  AgentError,
  DEEPSEEK_BASE_URL,
  PROVIDER_IDS,
  bindContext,
  createCatalogueSearchTool,
  createExerciseSearchTask,
  createId,
  createModelGateway,
  createProvider,
  runAgent,
} from '../../api/agent-runtime/index.js'

const CATALOGUE_PATH = new URL('../../api/agent-runtime/tasks/exercise-search-catalogue.json', import.meta.url)
let cachedCatalogueEntries = null
function loadCatalogueEntries() {
  if (!cachedCatalogueEntries) {
    cachedCatalogueEntries = JSON.parse(readFileSync(CATALOGUE_PATH, 'utf8'))
  }
  return cachedCatalogueEntries
}

// 固定本地评估 scope 与 profileId；execution 固定 local。
export const EVALUATION_SCOPE = 'ai-search-eval'
const EVALUATION_PROFILE_ID = 'eval'
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

const clean = value => (typeof value === 'string' ? value.trim() : '')

function configError(message) {
  const error = new AgentError('invalid_request', message)
  error.phase = 'config'
  return error
}

function resolveProviderConfig(env) {
  const provider = clean(env.OPEN_GYM_EVAL_PROVIDER)
  if (!PROVIDER_IDS.includes(provider)) {
    throw configError('OPEN_GYM_EVAL_PROVIDER must be one of fixture, openai, compatible, deepseek')
  }
  if (provider === 'fixture') {
    // fixture 不读密钥、不访问网络；默认走任务自带的 candidates fixture case。
    return { provider, providerOptions: {} }
  }
  const model = clean(env.OPEN_GYM_EVAL_MODEL)
  if (!model) throw configError(`OPEN_GYM_EVAL_MODEL is required for the ${provider} provider`)
  const apiKey = clean(provider === 'deepseek'
    ? (env.OPEN_GYM_EVAL_API_KEY || env.DEEPSEEK_API_KEY)
    : env.OPEN_GYM_EVAL_API_KEY)
  if (!apiKey) throw configError(`an API key is required for the ${provider} provider`)
  let baseUrl
  if (provider === 'deepseek') {
    baseUrl = DEEPSEEK_BASE_URL
  } else if (provider === 'openai') {
    baseUrl = clean(env.OPEN_GYM_EVAL_BASE_URL) || OPENAI_DEFAULT_BASE_URL
  } else {
    baseUrl = clean(env.OPEN_GYM_EVAL_BASE_URL)
    if (!baseUrl) throw configError('OPEN_GYM_EVAL_BASE_URL is required for the compatible provider')
  }
  return { provider, providerOptions: { baseUrl, apiKey, model } }
}

/** Build the in-memory evaluation model runner. Throws an AgentError with
 * phase 'config' (the entry exits 2) when the provider configuration is
 * missing or invalid — before any request can be sent. */
export function createEvaluationModelRunner(env = process.env, overrides = {}) {
  const config = resolveProviderConfig(env ?? {})
  // The provider's own timeout applies: nothing is overridden here.
  const provider = overrides.provider ?? createProvider(config.provider, config.providerOptions)
  const profile = {
    profileId: EVALUATION_PROFILE_ID,
    version: 1,
    provider: config.provider,
    capabilities: { text: true, image: provider.capabilities?.image !== false, tools: false },
    ...(config.providerOptions.model ? { model: config.providerOptions.model } : {}),
  }
  const gateway = overrides.gateway ?? createModelGateway({
    resolveProfile: async () => ({ profile, provider }),
  })
  const task = createExerciseSearchTask()
  const tools = overrides.tools ?? [createCatalogueSearchTool({ entries: loadCatalogueEntries() })]
  return {
    /** Run the shared task once. `diagnostic` is passed through
     * bindContext.meta.exerciseSearchDiagnostic so the model-stage events are
     * collected in memory; it never reaches the prompt or any store. */
    async run(sampleInput, diagnostic) {
      const request = {
        taskId: task.id,
        requestId: createId('req', randomUUID),
        profileId: EVALUATION_PROFILE_ID,
        input: sampleInput,
      }
      const context = bindContext({
        scope: EVALUATION_SCOPE,
        runId: createId('run', randomUUID),
        request,
        execution: 'local',
        profileRef: profile,
        targetScope: [],
        meta: diagnostic ? { exerciseSearchDiagnostic: diagnostic } : {},
      })
      return runAgent({ task, request, context, gateway, tools })
    },
  }
}
