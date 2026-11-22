#!/usr/bin/env node
// The AI exercise-search evaluation CLI (D08/D10/D11 of
// docs/ai-exercise-search/EVAL_CLI_EXECUTION.md).
//
//   node frontend/scripts/ai-search-eval.mjs --mode replay|vision|e2e
//     --manifest <path> --out <path>
//     [--sample <id>]... [--group <name>]...
//     [--web-locale en|zh] [--include-queries] [--save-replay <path>]
//
// Command-line paths resolve against INIT_CWD ?? cwd (npm switches the cwd to
// frontend/; the manifest's internal paths resolve against the manifest file).
// The report is written to a temp file next to --out and renamed into place.
//
// stdout carries only the report path and the counts; every failure prints a
// fixed description plus a safe error code on stderr — never an exception
// object, a path, a key or model free text. Exit codes: 0 the run succeeded
// (even with low hit rates), 1 the report was written but sample errors
// exist, 2 arguments, manifest, configuration or a global execution/write
// failure. Real-model modes exit 2 on missing configuration before any
// sample request is sent.

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
import { loadEvaluationManifest, loadModelInput, loadReplay } from './ai-search-eval-input.mjs'
import { createEvaluationModelRunner } from './ai-search-eval-model.mjs'
import { evaluatePlatform, summarizeEvaluation } from './ai-search-eval-report.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const REPORT_SCHEMA_VERSION = 1
const MODES = new Set(['replay', 'vision', 'e2e'])
const WEB_LOCALES = new Set(['en', 'zh'])
const PLATFORMS = ['web', 'rn']
const MEDIA_CODES = new Set(['agent_media_invalid', 'agent_media_too_large'])
const SAFE_CODES = new Set([...Object.keys(ERROR_STATUS), 'asset_missing', 'permission_denied'])

const USAGE = `Usage: node frontend/scripts/ai-search-eval.mjs --mode <replay|vision|e2e> --manifest <path> --out <path>

  --mode <name>          replay | vision | e2e (required)
  --manifest <path>      evaluation manifest, relative to the invocation directory
  --out <path>           JSON report destination
  --sample <id>          select one sample by id (repeatable)
  --group <name>         select samples by group (repeatable)
  --web-locale <lang>    en | zh (default zh)
  --include-queries      include the matched query text in recall events
  --save-replay <path>   vision/e2e only: save { results: [{ id, structured }] }
  --help                 show this help

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

// 同类选择取并集，两类选择取交集。未知 ID/group、无匹配或选定样本不支持
// 当前模式时报使用错误；没显式选择时按模式跳过不适用项并写入 skippedIds。
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

// Equal, or one path sits inside the other's directory — either way writing
// the output would touch an input.
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

// 输入输出路径不得重合，也不得覆盖任何图片、清单或已提交的 fixture：
// every image and replay path the manifest declares counts, selected or not.
function assertOutputsSafe({ outPath, saveReplayPath, manifestPath, samples }) {
  const outputs = [outPath]
  if (saveReplayPath) outputs.push(saveReplayPath)
  for (let i = 0; i < outputs.length; i++) {
    for (let j = i + 1; j < outputs.length; j++) {
      if (pathsOverlap(outputs[i], outputs[j])) throw new OutputPathError()
    }
  }
  const inputs = [manifestPath]
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

// Vision mode loads no matcher; the catalogue metadata is what lets it check
// that a positive sample's expected ids really are catalogue ids before any
// request is paid for.
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

// recognition 只记录阶段计数、白名单器械/部位和耗时；familyAssessment 固定
// unreviewed，不计算虚假的模型识别正确率。
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
  return {
    recall: record.recall,
    filter: record.filter,
    display: record.display,
    finalIds: record.finalIds,
    fallbackOnly: record.fallbackOnly,
    elapsedMs: record.elapsedMs,
    firstExpectedRank: record.firstExpectedRank,
    wrongEquipment: record.wrongEquipment,
  }
}

// The report row carries exactly the agreed fields; the expected ids and
// equipment stay on the internal row for summarizeEvaluation only.
function projectRow(row) {
  const out = {
    id: row.id,
    group: row.group,
    family: row.family,
    expectation: row.expectation,
    recognition: row.recognition,
    platforms: {},
  }
  for (const platform of PLATFORMS) {
    if (row.platforms[platform]) out.platforms[platform] = projectPlatform(row.platforms[platform])
  }
  if (row.error) out.error = row.error
  return out
}

function hasRowError(row) {
  return !!row.error || PLATFORMS.some(platform => row.platforms[platform]
    && row.platforms[platform].ok === false)
}

// One sample, serial: load its input, call the model at most once, evaluate
// both matchers on the same structured output. Model free text never enters
// the row; only counts, whitelisted slugs and elapsed times do.
async function runSample({ sample, mode, includeQueries, saveReplayPath, modelRunner, adapters, replaySave }) {
  const row = {
    id: sample.id,
    group: sample.group,
    family: sample.family,
    expectation: sample.expectation,
    expectedIds: sample.expectedIds,
    expectedEquipment: sample.expectedEquipment,
    recognition: emptyRecognition(),
    platforms: {},
    error: null,
  }
  try {
    if (mode === 'replay') {
      const structured = await loadReplay(sample)
      row.recognition = buildRecognition([], structured, null)
      for (const platform of PLATFORMS) {
        row.platforms[platform] = evaluatePlatform({
          matcher: adapters[platform],
          structured,
          sample,
          includeQueries,
          publicEquipmentById: adapters.publicEquipmentById,
        })
      }
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
      for (const platform of PLATFORMS) {
        row.platforms[platform] = evaluatePlatform({
          matcher: adapters[platform],
          structured,
          sample,
          includeQueries,
          publicEquipmentById: adapters.publicEquipmentById,
        })
      }
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

// out 先写同目录临时文件后 rename。
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

async function openAdapters(mode, webLocale, injected) {
  if (injected) return { adapters: injected, close: async () => {} }
  try {
    if (mode === 'vision') {
      const catalogue = await openCatalogueMetadata()
      return {
        adapters: { web: null, rn: null, publicEquipmentById: catalogue.publicEquipmentById },
        close: () => catalogue.close(),
      }
    }
    const adapters = await openEvaluationAdapters({ webLocale })
    return { adapters, close: () => adapters.close() }
  } catch (error) {
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

  // npm script 的相对路径基于 INIT_CWD ?? cwd，不能基于 npm 切换后的 frontend cwd。
  const env = options.env ?? process.env
  const baseDir = env.INIT_CWD ?? process.cwd()
  const manifestPath = path.resolve(baseDir, config.manifest)
  const outPath = path.resolve(baseDir, config.out)
  const saveReplayPath = config.saveReplay ? path.resolve(baseDir, config.saveReplay) : null

  const manifest = await loadEvaluationManifest(manifestPath)
  const { selected, skippedIds } = selectSamples(manifest.samples, config)
  assertOutputsSafe({ outPath, saveReplayPath, manifestPath, samples: manifest.samples })

  // 真实模型模式缺配置时在任何样本发请求前退出 2；replay 不创建 provider。
  const modelRunner = config.mode === 'replay' ? null
    : (options.modelRunner ?? createEvaluationModelRunner(env))

  try {
    mkdirSync(path.dirname(outPath), { recursive: true })
  } catch (error) {
    const wrapped = new Error('mkdir failed')
    wrapped.kind = 'write'
    wrapped.cause = error
    throw wrapped
  }

  const rows = []
  const replaySave = []
  const { adapters, close } = await openAdapters(config.mode, config.webLocale, options.adapters)
  try {
    for (const sample of selected) {
      rows.push(await runSample({
        sample,
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
  // 只在 --save-replay 显式指定时写独立 { results: [{ id, structured }] } 文件；
  // 失败样本保留报告行并写安全错误，从不写入模型自由文本之外的兜底内容。
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
  if (summary.byPlatform.web || summary.byPlatform.rn) {
    const web = summary.byPlatform.web ? summary.byPlatform.web.matched : 0
    const rn = summary.byPlatform.rn ? summary.byPlatform.rn.matched : 0
    console.log(`matched: web=${web} rn=${rn}`)
  }
  return errorCount > 0 ? 1 : 0
}

/** The CLI entry point. Never throws: every failure prints a fixed
 * description plus a safe code on stderr and maps onto the exit code. */
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
