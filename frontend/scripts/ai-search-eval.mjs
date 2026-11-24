#!/usr/bin/env node
// The AI exercise-search evaluation CLI (D08/D10/D11 of
// docs/ai-exercise-search/EVAL_CLI_EXECUTION.md), extended for paired
// v1 (web/rn) vs v2 (server_v2) evaluation.
//
//   node frontend/scripts/ai-search-eval.mjs --mode replay|vision|e2e
//     --manifest <path> --out <path>
//     [--benchmark <path>] [--include-server-v2] [--server-v2-mode live|fixture]
//     [--sample <id>]... [--group <name>]...
//     [--web-locale en|zh] [--include-queries] [--save-replay <path>]

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  AgentError,
  BODY_PART_SLUGS,
  EQUIPMENT_SLUGS,
  ERROR_STATUS,
} from '../../api/agent-runtime/index.js'
import { openCatalogueMetadata, openEvaluationAdapters } from './ai-search-eval-adapters.mjs'
import {
  loadBenchmarkMetadata,
  loadEvaluationManifest,
  loadModelInput,
  loadReplay,
} from './ai-search-eval-input.mjs'
import { createEvaluationModelRunner } from './ai-search-eval-model.mjs'
import { evaluatePlatform, evaluateServerV2, summarizeEvaluation } from './ai-search-eval-report.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const REPORT_SCHEMA_VERSION = 1
const MODES = new Set(['replay', 'vision', 'e2e'])
const WEB_LOCALES = new Set(['en', 'zh'])
const SERVER_V2_MODES = new Set(['live', 'fixture'])
const PLATFORMS = ['web', 'rn']
const ALL_PLATFORMS = ['web', 'rn', 'server_v2']
const MEDIA_CODES = new Set(['agent_media_invalid', 'agent_media_too_large'])
const SAFE_CODES = new Set([...Object.keys(ERROR_STATUS), 'asset_missing', 'permission_denied'])

const USAGE = `Usage: node frontend/scripts/ai-search-eval.mjs --mode <replay|vision|e2e> --manifest <path> --out <path>

  --mode <name>            replay | vision | e2e (required)
  --manifest <path>        evaluation manifest, relative to the invocation directory
  --out <path>             JSON report destination
  --benchmark <path>       optional benchmark.json metadata for strictTop1/nDCG/slices
  --include-server-v2      also evaluate RetrievalService (server_v2) on the same output
  --server-v2-mode <mode>  live | fixture (default live)
  --sample <id>            select one sample by id (repeatable)
  --group <name>           select samples by group (repeatable)
  --web-locale <lang>      en | zh (default zh)
  --include-queries        include the matched query text in recall events
  --save-replay <path>     vision/e2e only: save { results: [{ id, structured }] }
  --help                   show this help

Repeated --sample values union, repeated --group values union, the two
intersect. Samples the mode does not apply to are skipped unless explicitly
selected (then it is a usage error). Exit codes: 0 success, 1 the report was
written but sample errors exist, 2 arguments/manifest/config/write failure.`

class UsageError extends Error {
  constructor() {
    super('invalid arguments')
    this.kind = 'usage'
  }
}

class OutputPathError extends Error {
  constructor() {
    super('invalid output path')
    this.kind = 'output'
  }
}

function safeCode(error) {
  const code = error?.code
  return typeof code === 'string' && SAFE_CODES.has(code) ? code : 'unknown'
}

function emitFailure(description, code) {
  console.error(`ai-search-eval: ${description}`)
  console.error(`code: ${code}`)
}

function failWith(error) {
  if (error instanceof UsageError) {
    emitFailure('invalid arguments (use --help for usage)', 'invalid_request')
    return
  }
  if (error?.phase === 'manifest') {
    emitFailure('the evaluation manifest is missing or invalid', safeCode(error))
    return
  }
  if (error?.phase === 'config') {
    emitFailure('the evaluation model configuration is missing or invalid', safeCode(error))
    return
  }
  if (error?.kind === 'output') {
    emitFailure('the evaluation output paths are invalid', 'invalid_request')
    return
  }
  if (error?.kind === 'adapters') {
    emitFailure('the evaluation adapters could not be loaded', safeCode(error.cause ?? error))
    return
  }
  if (error?.kind === 'write') {
    emitFailure('the evaluation output could not be written', safeCode(error.cause ?? error))
    return
  }
  emitFailure('the evaluation run failed', safeCode(error))
}

function printUsage() {
  console.log(USAGE)
}

function parseArguments(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        mode: { type: 'string' },
        manifest: { type: 'string' },
        out: { type: 'string' },
        benchmark: { type: 'string' },
        'include-server-v2': { type: 'boolean' },
        'server-v2-mode': { type: 'string' },
        sample: { type: 'string', multiple: true },
        group: { type: 'string', multiple: true },
        'web-locale': { type: 'string' },
        'include-queries': { type: 'boolean' },
        'save-replay': { type: 'string' },
        help: { type: 'boolean' },
      },
    })
  } catch {
    throw new UsageError()
  }
  const values = parsed.values
  if (values.help === true) return { help: true }
  const mode = typeof values.mode === 'string' ? values.mode : ''
  if (!MODES.has(mode)) throw new UsageError()
  if (typeof values.manifest !== 'string' || !values.manifest) throw new UsageError()
  if (typeof values.out !== 'string' || !values.out) throw new UsageError()
  const webLocale = values['web-locale'] === undefined ? 'zh' : values['web-locale']
  if (typeof webLocale !== 'string' || !WEB_LOCALES.has(webLocale)) throw new UsageError()
  const serverV2Mode = values['server-v2-mode'] === undefined ? 'live' : values['server-v2-mode']
  if (typeof serverV2Mode !== 'string' || !SERVER_V2_MODES.has(serverV2Mode)) throw new UsageError()
  if (values.benchmark !== undefined && (typeof values.benchmark !== 'string' || !values.benchmark)) {
    throw new UsageError()
  }
  const saveReplay = values['save-replay']
  if (saveReplay !== undefined) {
    if (mode === 'replay') throw new UsageError()
    if (typeof saveReplay !== 'string' || !saveReplay) throw new UsageError()
  }
  const cleanList = value => (Array.isArray(value) ? value.filter(entry => typeof entry === 'string' && entry) : [])
  return {
    help: false,
    mode,
    manifest: values.manifest,
    out: values.out,
    benchmark: typeof values.benchmark === 'string' ? values.benchmark : null,
    includeServerV2: values['include-server-v2'] === true,
    serverV2Mode,
    sample: cleanList(values.sample),
    group: cleanList(values.group),
    webLocale,
    includeQueries: values['include-queries'] === true,
    saveReplay: typeof saveReplay === 'string' ? saveReplay : null,
  }
}

function supportsMode(sample, mode) {
  return mode === 'replay' ? !!sample.replay : !!sample.image
}

function selectSamples(samples, config) {
  const knownIds = new Set(samples.map(sample => sample.id))
  for (const id of config.sample) {
    if (!knownIds.has(id)) throw new UsageError()
  }
  const knownGroups = new Set(samples.map(sample => sample.group))
  for (const group of config.group) {
    if (!knownGroups.has(group)) throw new UsageError()
  }
  const hasExplicit = config.sample.length > 0 || config.group.length > 0
  if (!hasExplicit) {
    const selected = samples.filter(sample => supportsMode(sample, config.mode))
    const skippedIds = samples.filter(sample => !supportsMode(sample, config.mode)).map(sample => sample.id)
    return { selected, skippedIds }
  }
  const idSet = config.sample.length ? new Set(config.sample) : null
  const groupSet = config.group.length ? new Set(config.group) : null
  const selected = samples.filter(sample =>
    (!idSet || idSet.has(sample.id)) && (!groupSet || groupSet.has(sample.group)))
  if (!selected.length) throw new UsageError()
  if (selected.some(sample => !supportsMode(sample, config.mode))) throw new UsageError()
  return { selected, skippedIds: [] }
}

function normalizedPath(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function pathsOverlap(a, b) {
  const na = normalizedPath(a)
  const nb = normalizedPath(b)
  if (na === nb) return true
  const separator = path.sep
  return na.startsWith(nb + separator) || nb.startsWith(na + separator)
}

function isDirectory(value) {
  try {
    return statSync(value).isDirectory()
  } catch {
    return false
  }
}

function assertOutputsSafe({ outPath, saveReplayPath, manifestPath, benchmarkPath, samples }) {
  const outputs = [outPath]
  if (saveReplayPath) outputs.push(saveReplayPath)
  for (let i = 0; i < outputs.length; i++) {
    for (let j = i + 1; j < outputs.length; j++) {
      if (pathsOverlap(outputs[i], outputs[j])) throw new OutputPathError()
    }
  }
  const inputs = [manifestPath]
  if (benchmarkPath) inputs.push(benchmarkPath)
  for (const sample of samples) {
    if (sample.image) inputs.push(sample.image)
    if (sample.replay) inputs.push(sample.replay.path)
  }
  for (const output of outputs) {
    if (isDirectory(output)) throw new OutputPathError()
    for (const input of inputs) {
      if (pathsOverlap(output, input)) throw new OutputPathError()
    }
  }
}

function assertExpectedIdsKnown(sample, publicEquipmentById) {
  if (sample.expectation !== 'match') return
  const catalogue = publicEquipmentById || {}
  if (sample.expectedIds.some(id => !Object.hasOwn(catalogue, id))) {
    const error = new AgentError('invalid_request')
    error.phase = 'input'
    throw error
  }
}

function sampleErrorOf(error) {
  const phase = typeof error?.phase === 'string' && error.phase
    ? error.phase
    : (MEDIA_CODES.has(error?.code) ? 'attachments' : 'model')
  return { phase, code: safeCode(error) }
}

function emptyRecognition() {
  return {
    familyAssessment: 'unreviewed',
    stages: { attachments: 0, model: 0, recognition: 0, end: 0 },
    rawCandidateCount: null,
    cleanCandidateCount: null,
    equipment: [],
    bodyParts: [],
    elapsedMs: null,
  }
}

function buildRecognition(events, structured, fallbackElapsedMs) {
  const recognition = emptyRecognition()
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const stage = typeof event.stage === 'string' ? event.stage : null
    if (stage && Object.hasOwn(recognition.stages, stage)) recognition.stages[stage]++
    if (stage === 'model' && event.status === 'completed'
      && typeof event.elapsedMs === 'number' && Number.isFinite(event.elapsedMs)) {
      recognition.elapsedMs = event.elapsedMs
    }
    if (stage === 'recognition') {
      if (typeof event.rawCandidateCount === 'number' && Number.isFinite(event.rawCandidateCount)) {
        recognition.rawCandidateCount = event.rawCandidateCount
      }
      if (typeof event.cleanCandidateCount === 'number' && Number.isFinite(event.cleanCandidateCount)) {
        recognition.cleanCandidateCount = event.cleanCandidateCount
      }
    }
  }
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const equipment = new Set(recognition.equipment)
    const bodyParts = new Set(recognition.bodyParts)
    for (const candidate of Array.isArray(structured.candidates) ? structured.candidates : []) {
      if (candidate && typeof candidate === 'object') {
        if (EQUIPMENT_SLUGS.includes(candidate.equipment)) equipment.add(candidate.equipment)
        if (BODY_PART_SLUGS.includes(candidate.bodyPart)) bodyParts.add(candidate.bodyPart)
      }
    }
    const fallback = structured.fallback && typeof structured.fallback === 'object' ? structured.fallback : {}
    for (const slug of Array.isArray(fallback.equipment) ? fallback.equipment : []) {
      if (EQUIPMENT_SLUGS.includes(slug)) equipment.add(slug)
    }
    for (const slug of Array.isArray(fallback.bodyParts) ? fallback.bodyParts : []) {
      if (BODY_PART_SLUGS.includes(slug)) bodyParts.add(slug)
    }
    recognition.equipment = [...equipment].sort()
    recognition.bodyParts = [...bodyParts].sort()
    if (recognition.cleanCandidateCount === null && Array.isArray(structured.candidates)) {
      recognition.cleanCandidateCount = structured.candidates.length
    }
  }
  if (recognition.elapsedMs === null
    && typeof fallbackElapsedMs === 'number' && Number.isFinite(fallbackElapsedMs)) {
    recognition.elapsedMs = fallbackElapsedMs
  }
  return recognition
}

function collectDiagnostic(events, event) {
  try {
    if (event && typeof event === 'object') events.push(event)
  } catch { /* diagnostics must never break a run */ }
}

function projectPlatform(record) {
  if (!record.ok) {
    return { error: record.error, elapsedMs: record.elapsedMs }
  }
  const projected = {
    finalIds: record.finalIds,
    topLevels: record.topLevels,
    top1Level: record.top1Level,
    top1Score: record.top1Score,
    clarificationCount: record.clarificationCount,
    fallbackOnly: record.fallbackOnly,
    elapsedMs: record.elapsedMs,
    firstExpectedRank: record.firstExpectedRank,
    firstExpectedDisplayRank: record.firstExpectedDisplayRank,
    wrongEquipment: record.wrongEquipment,
    wrongBodyPart: record.wrongBodyPart,
    wrongHigh: record.wrongHigh,
    top1Correct: record.top1Correct,
    strictTop1Hit: record.strictTop1Hit,
    mrrAt5: record.mrrAt5,
    ndcgAt5: record.ndcgAt5,
    multiValidHit: record.multiValidHit,
  }
  if (record.recall !== undefined) projected.recall = record.recall
  if (record.filter !== undefined) projected.filter = record.filter
  if (record.display !== undefined) projected.display = record.display
  if (record.mrrAt10 !== undefined) projected.mrrAt10 = record.mrrAt10
  if (record.funnel !== undefined) projected.funnel = record.funnel
  return projected
}

function projectRow(row) {
  const out = {
    id: row.id,
    group: row.group,
    family: row.family,
    expectation: row.expectation,
    ...(row.groundTruthId !== undefined ? { groundTruthId: row.groundTruthId } : {}),
    ...(row.visibleFeatures !== undefined ? { visibleFeatures: row.visibleFeatures } : {}),
    ...(row.expectedOutcome !== undefined ? { expectedOutcome: row.expectedOutcome } : {}),
    recognition: row.recognition,
    platforms: {},
  }
  for (const platform of ALL_PLATFORMS) {
    if (row.platforms[platform]) out.platforms[platform] = projectPlatform(row.platforms[platform])
  }
  if (row.error) out.error = row.error
  return out
}

function hasRowError(row) {
  return !!row.error || ALL_PLATFORMS.some(platform => row.platforms[platform]
    && row.platforms[platform].ok === false)
}

async function runSample({ sample, benchmarkMeta, mode, includeQueries, saveReplayPath, modelRunner, adapters, replaySave }) {
  const meta = benchmarkMeta?.byId?.get(sample.id) ?? null
  const enrichedSample = meta
    ? { ...sample, groundTruthId: meta.groundTruthId }
    : sample

  const row = {
    id: sample.id,
    group: sample.group,
    family: sample.family,
    expectation: sample.expectation,
    expectedIds: sample.expectedIds,
    expectedEquipment: sample.expectedEquipment,
    groundTruthId: meta ? meta.groundTruthId : undefined,
    visibleFeatures: meta ? meta.visibleFeatures : undefined,
    expectedOutcome: meta ? meta.expectedBehavior?.outcome ?? null : undefined,
    recognition: emptyRecognition(),
    platforms: {},
    error: null,
  }

  const evaluateAllPlatforms = async structured => {
    for (const platform of PLATFORMS) {
      if (!adapters[platform]) continue
      row.platforms[platform] = evaluatePlatform({
        matcher: adapters[platform],
        structured,
        sample: enrichedSample,
        includeQueries,
        publicEquipmentById: adapters.publicEquipmentById,
        publicBodyPartById: adapters.publicBodyPartById ?? null,
      })
    }
    if (adapters.serverV2) {
      row.platforms.server_v2 = await evaluateServerV2({
        adapter: adapters.serverV2,
        structured,
        sample: enrichedSample,
        publicEquipmentById: adapters.publicEquipmentById,
        publicBodyPartById: adapters.publicBodyPartById ?? null,
      })
    }
  }

  try {
    if (mode === 'replay') {
      const structured = await loadReplay(sample)
      row.recognition = buildRecognition([], structured, null)
      await evaluateAllPlatforms(structured)
      return row
    }
    if (mode === 'vision') assertExpectedIdsKnown(sample, adapters.publicEquipmentById)
    const modelInput = await loadModelInput(sample)
    const events = []
    const diagnostic = event => collectDiagnostic(events, event)
    const startedAt = Date.now()
    let structured = null
    try {
      const result = await modelRunner.run(modelInput, diagnostic)
      structured = result && typeof result === 'object' && result.structured
        && typeof result.structured === 'object' ? result.structured : null
      if (!structured) throw new AgentError('model_unavailable')
    } catch (error) {
      row.recognition = buildRecognition(events, null, Date.now() - startedAt)
      row.error = sampleErrorOf(error)
      return row
    }
    row.recognition = buildRecognition(events, structured, Date.now() - startedAt)
    if (saveReplayPath) replaySave.push({ id: sample.id, structured })
    if (mode === 'e2e') {
      await evaluateAllPlatforms(structured)
    }
  } catch (error) {
    row.error = row.error || sampleErrorOf(error)
  }
  return row
}

function gitCommitOf(root) {
  try {
    const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
    return result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()
      ? result.stdout.trim()
      : null
  } catch {
    return null
  }
}

function catalogueSha256Of(root) {
  try {
    const bytes = readFileSync(path.join(root, 'frontend', 'src', 'lib', 'exercises-data.js'))
    return createHash('sha256').update(bytes).digest('hex')
  } catch {
    return null
  }
}

function writeJsonAtomically(target, value) {
  const directory = path.dirname(target)
  const temp = path.join(directory, `.${path.basename(target)}.tmp-${randomUUID()}`)
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(temp, target)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* the temp file may never have existed */ }
    const wrapped = new Error('write failed')
    wrapped.kind = 'write'
    wrapped.cause = error
    throw wrapped
  }
}

async function openAdapters(mode, webLocale, includeServerV2, serverV2Mode, env, injected) {
  if (injected) return { adapters: injected, close: async () => {} }
  try {
    if (mode === 'vision') {
      const catalogue = await openCatalogueMetadata()
      return {
        adapters: {
          web: null,
          rn: null,
          serverV2: null,
          publicEquipmentById: catalogue.publicEquipmentById,
          publicBodyPartById: catalogue.publicBodyPartById,
        },
        close: () => catalogue.close(),
      }
    }
    const adapters = await openEvaluationAdapters({
      webLocale,
      includeServerV2,
      serverV2Mode,
      env,
    })
    return { adapters, close: () => adapters.close() }
  } catch (error) {
    if (error?.phase === 'config') throw error
    const wrapped = new Error('adapters failed')
    wrapped.kind = 'adapters'
    wrapped.cause = error
    throw wrapped
  }
}

async function runGuarded(argv, options) {
  const config = parseArguments(argv)
  if (config.help) {
    printUsage()
    return 0
  }

  const env = options.env ?? process.env
  const baseDir = env.INIT_CWD ?? process.cwd()
  const manifestPath = path.resolve(baseDir, config.manifest)
  const outPath = path.resolve(baseDir, config.out)
  const benchmarkPath = config.benchmark ? path.resolve(baseDir, config.benchmark) : null
  const saveReplayPath = config.saveReplay ? path.resolve(baseDir, config.saveReplay) : null

  const manifest = await loadEvaluationManifest(manifestPath)
  const benchmarkMeta = benchmarkPath ? await loadBenchmarkMetadata(benchmarkPath) : null
  const { selected, skippedIds } = selectSamples(manifest.samples, config)
  assertOutputsSafe({ outPath, saveReplayPath, manifestPath, benchmarkPath, samples: manifest.samples })

  const modelRunner = config.mode === 'replay' ? null
    : (options.modelRunner ?? createEvaluationModelRunner(env))

  const { adapters, close } = await openAdapters(
    config.mode,
    config.webLocale,
    config.includeServerV2,
    config.serverV2Mode,
    env,
    options.adapters,
  )

  const rows = []
  const replaySave = []
  try {
    try {
      mkdirSync(path.dirname(outPath), { recursive: true })
    } catch (error) {
      const wrapped = new Error('mkdir failed')
      wrapped.kind = 'write'
      wrapped.cause = error
      throw wrapped
    }

    for (const sample of selected) {
      rows.push(await runSample({
        sample,
        benchmarkMeta,
        mode: config.mode,
        includeQueries: config.includeQueries,
        saveReplayPath,
        modelRunner,
        adapters,
        replaySave,
      }))
    }
  } finally {
    await close()
  }

  const summary = summarizeEvaluation(rows)
  if (saveReplayPath) writeJsonAtomically(saveReplayPath, { results: replaySave })
  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: config.mode,
    gitCommit: gitCommitOf(REPO_ROOT),
    webLocale: config.webLocale,
    skippedIds,
    samples: rows.map(projectRow),
    summary,
    catalogueSha256: catalogueSha256Of(REPO_ROOT),
  }
  writeJsonAtomically(outPath, report)

  const errorCount = rows.filter(hasRowError).length
  console.log(`report: ${outPath}`)
  console.log(`samples: run=${rows.length} skipped=${skippedIds.length} errors=${errorCount}`)
  if (summary.byPlatform.web || summary.byPlatform.rn || summary.byPlatform.server_v2) {
    const parts = []
    if (summary.byPlatform.web) parts.push(`web=${summary.byPlatform.web.matched}`)
    if (summary.byPlatform.rn) parts.push(`rn=${summary.byPlatform.rn.matched}`)
    if (summary.byPlatform.server_v2) parts.push(`server_v2=${summary.byPlatform.server_v2.matched}`)
    console.log(`matched: ${parts.join(' ')}`)
  }
  return errorCount > 0 ? 1 : 0
}

/** The CLI entry point. */
export async function runCli(argv, options = {}) {
  try {
    return await runGuarded(argv, options)
  } catch (error) {
    failWith(error)
    return 2
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  process.exitCode = await runCli(process.argv.slice(2))
}
