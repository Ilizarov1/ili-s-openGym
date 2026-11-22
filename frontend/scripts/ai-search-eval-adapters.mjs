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

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const WEB_LOCALES = new Set(['en', 'zh'])

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

// id → equipment slug, from the Web CATALOGUE export. The catalogue adapter
// logic is never re-implemented or re-scanned anywhere else.
function equipmentById(catalogue) {
  const out = {}
  for (const exercise of Array.isArray(catalogue) ? catalogue : []) {
    if (!exercise || typeof exercise !== 'object' || typeof exercise.id !== 'string') continue
    out[exercise.id] = typeof exercise.eq === 'string' ? exercise.eq : ''
  }
  return out
}

/** Load the real Web and RN matchers through one SSR pass. */
export async function openEvaluationAdapters({ webLocale = 'zh' } = {}) {
  if (!WEB_LOCALES.has(webLocale)) {
    throw new Error('openEvaluationAdapters: webLocale must be "en" or "zh"')
  }
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
    return { web, rn, publicEquipmentById, close: () => server.close() }
  } catch (error) {
    await server.close()
    throw error
  }
}

/** Vision mode loads no matcher: the Web catalogue metadata is all it needs
 * to validate that positive sample ids map to catalogue entries. */
export async function openCatalogueMetadata() {
  const server = await createEvaluationServer()
  try {
    const exercises = await server.ssrLoadModule('/frontend/src/lib/exercises.js')
    return { publicEquipmentById: equipmentById(exercises.CATALOGUE), close: () => server.close() }
  } catch (error) {
    await server.close()
    throw error
  }
}
