#!/usr/bin/env node
// Web and RN adapters for the AI exercise-search evaluation CLI (D09 of
// docs/ai-exercise-search/EVAL_CLI_EXECUTION.md).
//
//   openEvaluationAdapters({ webLocale }) -> { web, rn, publicEquipmentById, close }
//   openCatalogueMetadata()               -> { publicEquipmentById, close }
//
// The matchers are the real production modules, loaded through the frontend's
// own Vite in middleware mode: the server never listens, only ssrLoadModule
// is called, and the filesystem it may reach is the repository root only. The
// root is derived from this file's location, never from the process cwd, so
// the npm script and a direct `node frontend/scripts/...` behave identically.
//
// openCatalogueMetadata is the vision-mode shortcut: the Web catalogue export
// only, no matcher and no locale pack. A loading failure still closes the
// server, and the caller closes it through `close` in a finally.

import { fileURLToPath } from 'node:url'
import { AgentError } from '../../api/agent-runtime/index.js'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WEB_LOCALES = new Set(['en', 'zh'])
const SERVER_V2_MODES = new Set(['live', 'fixture'])

async function createEvaluationServer() {
  // Resolved from this file's location: the script lives in frontend/scripts,
  // so the frontend's installed Vite is the one that answers.
  const { createServer } = await import('vite')
  return createServer({
    root: REPO_ROOT,
    configFile: false,
    server: { middlewareMode: true, ws: false, fs: { allow: [REPO_ROOT] } },
    appType: 'custom',
    optimizeDeps: { noDiscovery: true },
  })
}

// id → equipment / bodyPart slug, from the Web CATALOGUE export. The catalogue
// adapter logic is never re-implemented or re-scanned anywhere else.
function equipmentById(catalogue) {
  const out = {}
  for (const exercise of Array.isArray(catalogue) ? catalogue : []) {
    if (!exercise || typeof exercise !== 'object' || typeof exercise.id !== 'string') continue
    out[exercise.id] = typeof exercise.eq === 'string' ? exercise.eq : ''
  }
  return out
}

function bodyPartById(catalogue) {
  const out = {}
  for (const exercise of Array.isArray(catalogue) ? catalogue : []) {
    if (!exercise || typeof exercise !== 'object' || typeof exercise.id !== 'string') continue
    out[exercise.id] = typeof exercise.bp === 'string' ? exercise.bp : ''
  }
  return out
}

async function openServerV2Adapter({ mode = 'live', env = process.env } = {}) {
  if (!SERVER_V2_MODES.has(mode)) {
    throw new Error('openServerV2Adapter: mode must be "live" or "fixture"')
  }
  const [
    { retrievalConfigured, safeRetrievalConfig },
    { createRetrievalPool },
    { embedText, rerank },
    { FixtureRetrievalAdapter },
    { RetrievalService },
  ] = await Promise.all([
    import('../../api/dist/src/agent/retrieval/config.js'),
    import('../../api/dist/src/agent/retrieval/database.js'),
    import('../../api/dist/src/agent/retrieval/models.js'),
    import('../../api/dist/src/agent/retrieval/fixture-retrieval.js'),
    import('../../api/dist/src/agent/retrieval/retrieval.service.js'),
  ])

  if (mode === 'fixture') {
    const fixtureAdapter = new FixtureRetrievalAdapter()
    const dummyPool = {
      connect: () => { throw new Error('fixture must not connect to PG') },
      end: async () => {},
    }
    const config = safeRetrievalConfig({
      ...env,
      EXERCISE_SEARCH_PG_URL: 'postgres://127.0.0.1:55432/fixture',
      EXERCISE_SEARCH_LOCAL_MODEL_URL: 'http://127.0.0.1:8765',
    })
    const service = new RetrievalService(dummyPool, config, fixtureAdapter)
    return {
      mode: 'fixture',
      match: async ({ structured }, { hintText, confirmedEquipment, diagnostic } = {}) => service.retrieve({
        input: {
          ...(typeof hintText === 'string' && hintText.trim() ? { hintText } : {}),
          ...(confirmedEquipment ? { confirmedEquipment } : {}),
        },
        recognition: structured,
        fixture: true,
        diagnostic,
      }),
      close: async () => service.onModuleDestroy(),
    }
  }

  if (!retrievalConfigured(env)) {
    const error = new AgentError('invalid_request', 'Retrieval configuration is incomplete for server_v2 live mode')
    error.phase = 'config'
    throw error
  }
  const config = safeRetrievalConfig(env)
  const pool = createRetrievalPool(config)
  const service = new RetrievalService(pool, config, undefined, {
    embedText: (text, signal) => embedText(config, text, signal),
    rerank: (query, docs, signal) => rerank(config, query, docs, signal),
  })
  return {
    mode: 'live',
    match: async ({ structured }, { hintText, confirmedEquipment, diagnostic } = {}) => service.retrieve({
      input: {
        ...(typeof hintText === 'string' && hintText.trim() ? { hintText } : {}),
        ...(confirmedEquipment ? { confirmedEquipment } : {}),
      },
      recognition: structured,
      fixture: false,
      diagnostic,
    }),
    close: async () => service.onModuleDestroy(),
  }
}

/** Load the real Web and RN matchers (and optional server v2 retrieval service)
 * through one SSR pass. */
export async function openEvaluationAdapters({
  webLocale = 'zh',
  includeServerV2 = false,
  serverV2Mode = 'live',
  env = process.env,
} = {}) {
  if (!WEB_LOCALES.has(webLocale)) {
    throw new Error('openEvaluationAdapters: webLocale must be "en" or "zh"')
  }
  let serverV2 = null
  const server = await createEvaluationServer()
  try {
    const load = id => server.ssrLoadModule(id)
    const i18nCore = await load('/frontend/src/lib/i18n-core.js')
    const exercises = await load('/frontend/src/lib/exercises.js')
    const librarySearch = await load('/mobile-rn/src/librarySearch.ts')
    // Created by D04; re-exports the RN matcher logic without Expo imports.
    const matcherModule = await load('/mobile-rn/src/agent/ai-search-matcher.ts')
    let dict = {}
    let names = null
    if (webLocale === 'zh') {
      const zhDict = await load('/frontend/src/locales/zh.js')
      const zhNames = await load('/frontend/src/exercise-names/zh.js')
      dict = zhDict.default || {}
      names = zhNames.default || null
    }
    // en: dict {} and names null; zh: the loaded pack and names.
    i18nCore._setLangState(webLocale, dict, null, names, true, false)
    const web = exercises.createWebAiSearch({})
    const rn = matcherModule.matcherFor(
      librarySearch.createLibrarySearch({ unit: 'kg', favEx: [] }),
    )
    const publicEquipmentById = equipmentById(exercises.CATALOGUE)
    const publicBodyPartById = bodyPartById(exercises.CATALOGUE)
    if (includeServerV2) {
      serverV2 = await openServerV2Adapter({ mode: serverV2Mode, env })
    }
    return {
      web,
      rn,
      serverV2,
      publicEquipmentById,
      publicBodyPartById,
      close: async () => {
        try {
          await serverV2?.close()
        } finally {
          await server.close()
        }
      },
    }
  } catch (error) {
    try {
      await serverV2?.close()
    } finally {
      await server.close()
    }
    throw error
  }
}

/** Vision mode loads no matcher: the Web catalogue metadata is all it needs
 * to validate that positive sample ids map to catalogue entries. */
export async function openCatalogueMetadata() {
  const server = await createEvaluationServer()
  try {
    const exercises = await server.ssrLoadModule('/frontend/src/lib/exercises.js')
    return {
      publicEquipmentById: equipmentById(exercises.CATALOGUE),
      publicBodyPartById: bodyPartById(exercises.CATALOGUE),
      close: () => server.close(),
    }
  } catch (error) {
    await server.close()
    throw error
  }
}
