#!/usr/bin/env node
// CLI automation for the AI exercise-search evaluation CLI (D12 of
// docs/ai-exercise-search/EVAL_CLI_EXECUTION.md). This file runs under
// node:test — NOT vitest — and frontend/vite.config.js excludes exactly this
// path from the vitest collection on purpose:
//
//   npm.cmd --prefix frontend run test:ai-search-eval
//
// Part A spawns the real CLI. Every replay run boots a Vite SSR server, so
// the file keeps the subprocess count to four: two full replays of the
// committed manifest (one direct node run, one through the npm prefix — the
// pair doubles as the repeat-run consistency check) and two fast argument
// failures. Part B stays in-process through the runCli injection seam with
// fixture model runners and matcher stand-ins: no network, no Vite, no
// subprocess. Every scratch file lives under the system temp dir and is
// removed in each test's finally; nothing is ever written inside the repo.
//
// Privacy assertions capture stdout/stderr programmatically and never print
// the synthetic markers they assert on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { AgentError } from '../../api/agent-runtime/index.js'
import { runCli } from './ai-search-eval.mjs'
import { createEvaluationModelRunner } from './ai-search-eval-model.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = path.join(REPO_ROOT, 'frontend', 'scripts', 'ai-search-eval.mjs')
// Relative on purpose: the direct run resolves it against cwd (repo root),
// the npm run against INIT_CWD (repo root) — both paths the CLI must support.
const REAL_MANIFEST = 'docs/ai-exercise-search/eval/manifest.json'
const REPLAY_SAMPLES = 10
const PHOTO_ONLY_SAMPLES = 5

// The synthetic markers. None of these may ever reach a report, stdout or
// stderr; the assertions below print only pass/fail, never the values.
const SECRET_KEY = 'sk-TESTSECRET123'
const CUSTOM_ID = 'custom-private-9182736450'
const DATA_URL_MARKER = 'data:image/png;base64,SECRETDATAMARKER999'
const CONTROLLED_QUERY = 'controlled query lever chest press q1729'
const IMAGE_NAME = 'probe-photo.png'

// ---------------------------------------------------------------- subprocess

function spawnCapture(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

const runCliSubprocess = args => spawnCapture(process.execPath, [CLI, ...args])

// npm.cmd cannot be spawned directly on Windows (Node refuses .cmd files
// without a shell), so cmd.exe takes one properly quoted command line. The
// run keeps INIT_CWD at the repo root, which is exactly the path resolution
// this invocation has to prove.
function runCliThroughNpm(args) {
  const quote = value => (/\s|"/.test(value) ? `"${value}"` : value)
  const command = ['npm.cmd', '--prefix', 'frontend', 'run', 'eval:ai-search', '--', ...args]
    .map(quote).join(' ')
  return spawnCapture(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command])
}

const readJson = async file => JSON.parse(await readFile(file, 'utf8'))

// 两份回放报告的可比投影：召回名次、筛选判定、finalIds、阶段计数。随机
// ID、时间戳、git commit 与耗时豁免（display/recognition 的 elapsedMs）。
function stableOf(report) {
  const platform = record => record && {
    recall: record.recall,
    filter: record.filter,
    finalIds: record.finalIds,
    fallbackOnly: record.fallbackOnly,
    firstExpectedRank: record.firstExpectedRank,
    wrongEquipment: record.wrongEquipment,
    display: (record.display ?? []).map(({ elapsedMs, ...rest }) => rest),
  }
  return {
    skippedIds: report.skippedIds,
    samples: report.samples.map(row => {
      const { elapsedMs, ...recognition } = row.recognition ?? {}
      return {
        id: row.id,
        group: row.group,
        family: row.family,
        expectation: row.expectation,
        error: row.error ?? null,
        recognition,
        platforms: { web: platform(row.platforms?.web), rn: platform(row.platforms?.rn) },
      }
    }),
  }
}

const assertBothPlatforms = (report, label) => {
  assert.equal(report.samples.length, REPLAY_SAMPLES, `${label}: expected ${REPLAY_SAMPLES} replay rows`)
  assert.equal(report.skippedIds.length, PHOTO_ONLY_SAMPLES, `${label}: the photo-only group must be skipped`)
  for (const row of report.samples) {
    assert.ok(!report.skippedIds.includes(row.id), `${label}: ${row.id} is both run and skipped`)
    for (const name of ['web', 'rn']) {
      const record = row.platforms?.[name]
      assert.ok(record, `${label}: ${row.id} has no ${name} platform`)
      assert.ok(Array.isArray(record.recall), `${label}: ${row.id}/${name} has no recall events`)
      assert.ok(Array.isArray(record.filter), `${label}: ${row.id}/${name} has no filter decisions`)
      assert.ok(Array.isArray(record.display), `${label}: ${row.id}/${name} has no display event`)
      assert.ok(Array.isArray(record.finalIds), `${label}: ${row.id}/${name} has no final ids`)
    }
    assert.equal(row.error, undefined, `${label}: ${row.id} carries a sample error`)
  }
  assert.equal(report.summary.byPlatform.web.matched, REPLAY_SAMPLES, `${label}: web matched count`)
  assert.equal(report.summary.byPlatform.rn.matched, REPLAY_SAMPLES, `${label}: rn matched count`)
}

// The first replay run's projection, kept for the consistency test that
// follows. Nothing but this in-memory summary survives the first test.
let firstReplayStable = null

// ------------------------------------------------------------- temp fixtures

// A genuinely valid PNG: the shared task sniffs the magic bytes and reads the
// IHDR before any model sees the image, so the file has to be a real one.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC_TABLE = new Int32Array(256)
for (let n = 0; n < 256; n++) {
  let value = n
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[n] = value
}

function crc32(bytes) {
  let crc = -1
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function tinyPng(width = 4, height = 4) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  const scanline = Buffer.concat([Buffer.from([0x00]), Buffer.alloc(width, 0x80)])
  const raw = Buffer.concat(Array.from({ length: height }, () => scanline))
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function writeFixtures({ root = null, manifestName = 'manifest.json', samples, files = [], dirs = [] }) {
  // Reusing a root lets a follow-up manifest (a later replay, a second
  // vision pass) reference files an earlier run in the same test created.
  const base = root ?? await mkdtemp(path.join(tmpdir(), 'og-ai-search-eval-'))
  for (const dir of dirs) await mkdir(path.join(base, dir), { recursive: true })
  for (const [relative, bytes] of files) {
    const target = path.join(base, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  await writeFile(path.join(base, manifestName), `${JSON.stringify({ schemaVersion: 1, samples }, null, 2)}\n`)
  return { root: base, manifestPath: path.join(base, manifestName) }
}

const fixtureSample = (id, overrides = {}) => ({
  id,
  group: 'fixture',
  expectation: 'match',
  expectedIds: ['0576'],
  expectedEquipment: ['leverage machine'],
  family: 'fixture-family',
  ...overrides,
})

// --------------------------------------------------------- in-process seams

// A counting fixture gateway: it records every invoke (the run contract is
// one invoke per sample) and answers with a valid exercise-search output,
// mirroring what normalizeModelOutput hands runAgent for a provider answer.
// `failOn` may return a message string — the call then throws an AgentError
// carrying that message, exactly like a provider failure does.
function fixtureGateway({ structuredOf, failOn } = {}) {
  const calls = []
  return {
    calls,
    async invoke(profileRef, modelInput) {
      calls.push({ profileRef, modelInput })
      const failure = typeof failOn === 'function' ? failOn(modelInput, calls.length) : null
      if (failure) throw new AgentError('model_unavailable', failure)
      const structured = typeof structuredOf === 'function' ? structuredOf(modelInput, calls.length) : null
      return { text: '', structured, toolCalls: [] }
    },
  }
}

// The real D10 runner with the gateway injected through its options seam: the
// exercise-search task, bindContext diagnostics and runAgent all execute for
// real; only the network edge is the fixture.
const fixtureRunner = gateway => createEvaluationModelRunner(
  { OPEN_GYM_EVAL_PROVIDER: 'fixture' },
  { gateway },
)

// A matcher stand-in honouring the D04 diagnostics contract. It records what
// it was called with and emits the same recall/filter/display shapes the
// production matcher emits. recall events always carry `query` — the worst
// case — so the test proves the CLI's own projection strips the query unless
// --include-queries was explicitly asked for.
function fakeMatcher({ finalIds = ['0576'], query = 'chest press machine' } = {}) {
  const calls = []
  return {
    calls,
    match(output, hints = {}) {
      const structured = output?.structured ?? null
      const diagnostics = hints?.diagnostics ?? null
      calls.push({ structured, hintText: hints?.hintText ?? null })
      const emit = event => {
        try {
          if (typeof diagnostics?.emit === 'function') diagnostics.emit(event)
        } catch { /* a broken sink never changes the match */ }
      }
      const expectedIds = Array.isArray(diagnostics?.evaluation?.expectedIds)
        ? diagnostics.evaluation.expectedIds
        : []
      emit({
        stage: 'recall',
        candidateIndex: 0,
        queryOrigin: 'primary',
        queryWordCount: 3,
        hitCount: finalIds.length,
        top: finalIds.slice(0, 5).map(id => ({ id, score: 42 })),
        expectedRanks: expectedIds.map(id => (finalIds.includes(id) ? finalIds.indexOf(id) + 1 : null)),
        query,
      })
      emit({ stage: 'filter', candidateIndex: 0, decision: 'accepted', id: finalIds[0] })
      emit({
        stage: 'display',
        resultCount: finalIds.length,
        publicIds: finalIds,
        customCount: 0,
        fallbackOnly: finalIds.length === 0,
      })
      return { items: finalIds.map(id => ({ exerciseId: id })), fallback: { understanding: '' } }
    },
  }
}

// Run the CLI in-process. stdout/stderr are captured programmatically — the
// test never prints them, and the synthetic markers stay unread.
async function runInProcess(argv, options = {}) {
  const stdout = []
  const stderr = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args) => { stdout.push(args.map(String).join(' ')) }
  console.error = (...args) => { stderr.push(args.map(String).join(' ')) }
  try {
    const code = await runCli(argv, { env: { INIT_CWD: REPO_ROOT }, ...options })
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

// What the shared task leaves after cleanExerciseSearchOutput: the shape the
// matchers see and --save-replay records.
const CLEANED_STRUCTURED = {
  candidates: [{
    name: 'lever chest press',
    nameEn: 'lever chest press',
    rationale: 'silhouette of a seated chest press machine',
    level: 'medium',
    equipment: 'leverage machine',
    bodyPart: 'chest',
  }],
  fallback: {
    understanding: 'a seated lever chest press machine',
    bodyParts: ['chest'],
    equipment: ['leverage machine'],
  },
}

const rowOf = (report, id) => report.samples.find(row => row.id === id)

// =========================================================== A: subprocess

test('replay on the real manifest (direct node): exit 0, web + rn for every replay-capable sample', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'og-ai-search-eval-'))
  try {
    const outPath = path.join(root, 'replay-direct.json')
    const run = await runCliSubprocess(['--mode', 'replay', '--manifest', REAL_MANIFEST, '--out', outPath])
    assert.equal(run.code, 0, `the CLI exited ${run.code}; stderr: ${run.stderr}`)
    // stdout carries only the report path and the counts
    const lines = run.stdout.trim().split(/\r?\n/).filter(Boolean)
    assert.equal(lines.length, 3, 'stdout must hold exactly the three summary lines')
    assert.match(lines[0], /^report: /)
    assert.equal(lines[1], `samples: run=${REPLAY_SAMPLES} skipped=${PHOTO_ONLY_SAMPLES} errors=0`)
    assert.match(lines[2], /^matched: web=\d+ rn=\d+$/)
    assert.doesNotMatch(run.stderr, /ai-search-eval:/, 'no failure description on a clean run')

    const report = await readJson(outPath)
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.mode, 'replay')
    assertBothPlatforms(report, 'direct')
    firstReplayStable = stableOf(report)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('second replay through the npm prefix: repo-root paths, identical rankings, decisions and final ids', async t => {
  if (!firstReplayStable) {
    t.skip('the direct replay run produced no projection to compare against')
    return
  }
  const root = await mkdtemp(path.join(tmpdir(), 'og-ai-search-eval-'))
  try {
    const outPath = path.join(root, 'replay-npm.json')
    const run = await runCliThroughNpm(['--mode', 'replay', '--manifest', REAL_MANIFEST, '--out', outPath])
    assert.equal(run.code, 0, `the npm-prefixed CLI exited ${run.code}; stderr: ${run.stderr}`)
    // npm prints its own banner; the CLI's own three lines are all there
    assert.match(run.stdout, /^report: /m)
    assert.match(run.stdout, new RegExp(`^samples: run=${REPLAY_SAMPLES} skipped=${PHOTO_ONLY_SAMPLES} errors=0$`, 'm'))
    assert.match(run.stdout, /^matched: web=\d+ rn=\d+$/m)

    const report = await readJson(outPath)
    assertBothPlatforms(report, 'npm-prefix')
    assert.deepEqual(stableOf(report), firstReplayStable,
      'the two replay runs disagree on rankings, filter decisions or final ids')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('--mode bogus exits 2 with the fixed usage error and nothing else', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'og-ai-search-eval-'))
  try {
    const outPath = path.join(root, 'never-written.json')
    const run = await runCliSubprocess(['--mode', 'bogus', '--manifest', REAL_MANIFEST, '--out', outPath])
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '', 'a usage failure prints nothing on stdout')
    assert.deepEqual(
      run.stderr.trim().split(/\r?\n/),
      ['ai-search-eval: invalid arguments (use --help for usage)', 'code: invalid_request'],
      'stderr must be the fixed usage error only — no stack traces, no JSON dumps')
    await assert.rejects(readFile(outPath), 'no report is written for a usage failure')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an invalid --web-locale exits 2 with the fixed usage error and nothing else', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'og-ai-search-eval-'))
  try {
    const outPath = path.join(root, 'never-written.json')
    const run = await runCliSubprocess([
      '--mode', 'replay', '--manifest', REAL_MANIFEST, '--out', outPath, '--web-locale', 'klingon',
    ])
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '', 'a usage failure prints nothing on stdout')
    assert.deepEqual(
      run.stderr.trim().split(/\r?\n/),
      ['ai-search-eval: invalid arguments (use --help for usage)', 'code: invalid_request'],
      'stderr must be the fixed usage error only — no stack traces, no JSON dumps')
    await assert.rejects(readFile(outPath), 'no report is written for a usage failure')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ========================================================= B: in-process

test('vision with a fixture model: one call per valid image, invalid images stop before the model, the batch continues', async () => {
  const png = tinyPng()
  const oversize = Buffer.alloc(1024 * 1024 + 1, 0x07)
  const { root, manifestPath } = await writeFixtures({
    samples: [
      fixtureSample('vision-bad-extension', { image: 'images/probe.txt' }),
      fixtureSample('vision-first', { image: 'images/probe.png' }),
      fixtureSample('vision-oversize', { image: 'images/oversize.png' }),
      fixtureSample('vision-second', { image: 'images/probe.png' }),
    ],
    files: [
      ['images/probe.png', png],
      ['images/probe.txt', Buffer.from('this is not an image', 'utf8')],
      ['images/oversize.png', oversize],
    ],
  })
  try {
    const gateway = fixtureGateway({ structuredOf: () => CLEANED_STRUCTURED })
    const adapters = { publicEquipmentById: { '0576': 'leverage machine' } }
    const outPath = path.join(root, 'report-vision.json')
    const run = await runInProcess(
      ['--mode', 'vision', '--manifest', manifestPath, '--out', outPath],
      { modelRunner: fixtureRunner(gateway), adapters },
    )
    assert.equal(run.code, 1, 'a run with failing samples exits 1 after writing the report')
    assert.match(run.stdout, /^samples: run=4 skipped=0 errors=2$/m)
    assert.equal(gateway.calls.length, 2, 'exactly the two valid samples reached the model')

    const report = await readJson(outPath)
    assert.equal(report.mode, 'vision')
    const badExtension = rowOf(report, 'vision-bad-extension')
    const oversizeRow = rowOf(report, 'vision-oversize')
    assert.deepEqual(badExtension.error, { phase: 'attachments', code: 'invalid_request' })
    assert.deepEqual(oversizeRow.error, { phase: 'attachments', code: 'agent_media_too_large' })
    assert.equal(badExtension.recognition.stages.model, 0, 'the invalid image never called the model')
    assert.equal(oversizeRow.recognition.stages.model, 0, 'the oversize image never called the model')

    // The shared runtime validated the synthetic PNG for real: the model
    // stage ran exactly once per valid sample, end to end.
    const attachments = gateway.calls[0].modelInput.user.attachments
    assert.equal(attachments.length, 1)
    assert.equal(attachments[0].mime, 'image/png')
    assert.equal(attachments[0].width, 4)
    assert.equal(attachments[0].height, 4)
    for (const id of ['vision-first', 'vision-second']) {
      const row = rowOf(report, id)
      assert.equal(row.error, undefined, `${id} must survive the failures around it`)
      assert.deepEqual(row.platforms, {}, 'vision never evaluates matchers')
      assert.deepEqual(row.recognition.stages, { attachments: 1, model: 1, recognition: 1, end: 1 })
      assert.equal(row.recognition.cleanCandidateCount, 1)
      assert.deepEqual(row.recognition.equipment, ['leverage machine'])
      assert.ok(!run.stdout.includes('probe.png'), 'the image file name never reaches stdout')
    }

    // A run without failing samples exits 0. Same root: the image exists.
    const clean = await writeFixtures({
      root,
      manifestName: 'manifest-clean.json',
      samples: [fixtureSample('vision-only-good', { image: 'images/probe.png' })],
    })
    const cleanGateway = fixtureGateway({ structuredOf: () => CLEANED_STRUCTURED })
    const cleanOut = path.join(clean.root, 'report-clean.json')
    const cleanRun = await runInProcess(
      ['--mode', 'vision', '--manifest', clean.manifestPath, '--out', cleanOut],
      { modelRunner: fixtureRunner(cleanGateway), adapters },
    )
    assert.equal(cleanRun.code, 0)
    assert.equal(cleanGateway.calls.length, 1)
    const cleanReport = await readJson(cleanOut)
    assert.equal(cleanReport.samples.length, 1)
    assert.equal(cleanReport.samples[0].error, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('e2e with a fixture gateway: one model call per sample, one structured output to both platforms, save-replay feeds a later replay run', async () => {
  const png = tinyPng()
  const { root, manifestPath } = await writeFixtures({
    samples: [
      fixtureSample('e2e-first', { image: 'images/probe.png', hintText: 'a seated chest press machine' }),
      fixtureSample('e2e-second', { image: 'images/probe.png', hintText: 'another seated chest press' }),
    ],
    files: [['images/probe.png', png]],
    dirs: ['saved'],
  })
  try {
    const gateway = fixtureGateway({ structuredOf: () => CLEANED_STRUCTURED })
    const webMatcher = fakeMatcher()
    const rnMatcher = fakeMatcher()
    const adapters = { web: webMatcher, rn: rnMatcher, publicEquipmentById: { '0576': 'leverage machine' } }
    const outPath = path.join(root, 'report-e2e.json')
    const savePath = path.join(root, 'saved', 'results.json')
    const run = await runInProcess(
      ['--mode', 'e2e', '--manifest', manifestPath, '--out', outPath, '--save-replay', savePath],
      { modelRunner: fixtureRunner(gateway), adapters },
    )
    assert.equal(run.code, 0)
    assert.equal(gateway.calls.length, 2, 'exactly one model call per valid sample')

    const report = await readJson(outPath)
    assert.equal(report.mode, 'e2e')
    assert.equal(report.summary.byPlatform.web.matched, 2)
    assert.equal(report.summary.byPlatform.rn.matched, 2)
    for (const id of ['e2e-first', 'e2e-second']) {
      const row = rowOf(report, id)
      assert.equal(row.error, undefined)
      // the model stage really ran through the shared runtime's diagnostics
      assert.deepEqual(row.recognition.stages, { attachments: 1, model: 1, recognition: 1, end: 1 })
      for (const name of ['web', 'rn']) {
        assert.deepEqual(row.platforms[name].finalIds, ['0576'], `${id}/${name} final ids`)
        assert.equal(row.platforms[name].firstExpectedRank, 1)
      }
    }
    // Both platforms consumed the very same structured output.
    assert.equal(webMatcher.calls.length, 2)
    assert.equal(rnMatcher.calls.length, 2)
    for (let index = 0; index < 2; index++) {
      assert.deepEqual(webMatcher.calls[index].structured, CLEANED_STRUCTURED)
      assert.deepEqual(rnMatcher.calls[index].structured, webMatcher.calls[index].structured)
    }

    // --save-replay wrote { results: [{ id, structured }] }…
    const saved = await readJson(savePath)
    assert.deepEqual(Object.keys(saved), ['results'])
    assert.deepEqual(saved.results.map(entry => entry.id), ['e2e-first', 'e2e-second'])
    assert.deepEqual(saved.results[0].structured, CLEANED_STRUCTURED)

    // …and a subsequent replay run consumes it. Same root: the saved file
    // the new manifest points at is right there.
    const replay = await writeFixtures({
      root,
      manifestName: 'replay-manifest.json',
      samples: [fixtureSample('replay-consumed', { replay: { path: 'saved/results.json', index: 0 } })],
    })
    const replayWeb = fakeMatcher()
    const replayRn = fakeMatcher()
    const replayOut = path.join(replay.root, 'report-replay.json')
    const replayRun = await runInProcess(
      ['--mode', 'replay', '--manifest', replay.manifestPath, '--out', replayOut],
      { adapters: { web: replayWeb, rn: replayRn, publicEquipmentById: { '0576': 'leverage machine' } } },
    )
    assert.equal(replayRun.code, 0)
    assert.equal(replayWeb.calls.length, 1)
    assert.equal(replayRn.calls.length, 1)
    assert.deepEqual(replayWeb.calls[0].structured, saved.results[0].structured)
    assert.deepEqual(replayRn.calls[0].structured, saved.results[0].structured)
    const replayReport = await readJson(replayOut)
    assert.equal(replayReport.mode, 'replay')
    assert.deepEqual(replayReport.samples[0].platforms.web.finalIds, ['0576'])
    assert.deepEqual(replayReport.samples[0].platforms.rn.finalIds, ['0576'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('privacy: secret markers, private ids, data urls and image names never leave the run; queries only with --include-queries', async () => {
  const png = tinyPng()
  const { root, manifestPath } = await writeFixtures({
    samples: [fixtureSample('privacy-probe', {
      image: `images/${IMAGE_NAME}`,
      hintText: `坐姿推胸 ${SECRET_KEY} ${CUSTOM_ID} ${DATA_URL_MARKER}`,
    })],
    files: [[`images/${IMAGE_NAME}`, png]],
  })
  // A hostile model runner: it sees the markers in the input, pushes a
  // diagnostic event whose undeclared fields carry every marker, and answers
  // with the markers inside the model free text. The report, stdout, stderr
  // and the collected diagnostics must all drop them.
  const seenInputs = []
  const privacyRunner = {
    async run(sampleInput, diagnostic) {
      seenInputs.push(sampleInput)
      diagnostic?.({
        stage: 'model',
        status: 'completed',
        elapsedMs: 4,
        message: `${SECRET_KEY} ${CUSTOM_ID} ${DATA_URL_MARKER}`,
        raw: sampleInput,
      })
      return {
        structured: {
          candidates: [{
            name: 'lever chest press',
            rationale: `the cue mentions ${SECRET_KEY} and ${CUSTOM_ID}`,
            level: 'medium',
            equipment: 'leverage machine',
            bodyPart: 'chest',
          }],
          fallback: { understanding: `the hint mentions ${SECRET_KEY} ${CUSTOM_ID} ${DATA_URL_MARKER}` },
        },
      }
    },
  }
  const markers = [SECRET_KEY, CUSTOM_ID, DATA_URL_MARKER, IMAGE_NAME, 'data:image/']
  try {
    // Positive controls first: the pipeline really carried the secrets.
    const assertSawSecrets = () => {
      assert.ok(seenInputs.at(-1).hintText.includes(SECRET_KEY), 'the input must carry the secret for the test to mean anything')
      assert.ok(seenInputs.at(-1).images[0].startsWith('data:image/png;base64,'), 'the input must carry the image data url')
    }

    const outPlain = path.join(root, 'report-plain.json')
    const plain = await runInProcess(
      ['--mode', 'e2e', '--manifest', manifestPath, '--out', outPlain],
      { modelRunner: privacyRunner, adapters: { web: fakeMatcher(), rn: fakeMatcher(), publicEquipmentById: { '0576': 'leverage machine' } } },
    )
    assertSawSecrets()
    assert.equal(plain.code, 0)
    assert.equal(plain.stderr, '')
    const plainText = await readFile(outPlain, 'utf8')
    for (const marker of markers) {
      assert.ok(!plainText.includes(marker), `the report leaked ${marker.length} forbidden characters`)
      assert.ok(!plain.stdout.includes(marker) && !plain.stderr.includes(marker), 'the console leaked a marker')
    }
    const plainReport = JSON.parse(plainText)
    const plainRow = rowOf(plainReport, 'privacy-probe')
    assert.equal(plainRow.recognition.stages.model, 1, 'the hostile diagnostic event was counted')
    assert.equal(plainRow.recognition.equipment[0], 'leverage machine')
    // the CLI's own projection dropped the query the stand-in matcher sent
    for (const name of ['web', 'rn']) {
      const recall = plainRow.platforms[name].recall
      assert.ok(recall.length >= 1)
      assert.equal('query' in recall[0], false, `the ${name} recall carries no query without --include-queries`)
    }
    assert.ok(!plainText.includes(CONTROLLED_QUERY), 'the query text never appears without the flag')

    // With --include-queries the controlled query appears — and only there.
    const outQueries = path.join(root, 'report-queries.json')
    const flagged = await runInProcess(
      ['--mode', 'e2e', '--manifest', manifestPath, '--out', outQueries, '--include-queries'],
      { modelRunner: privacyRunner, adapters: { web: fakeMatcher({ query: CONTROLLED_QUERY }), rn: fakeMatcher({ query: CONTROLLED_QUERY }), publicEquipmentById: { '0576': 'leverage machine' } } },
    )
    assertSawSecrets()
    assert.equal(flagged.code, 0)
    assert.equal(flagged.stderr, '')
    const flaggedText = await readFile(outQueries, 'utf8')
    for (const marker of markers) assert.ok(!flaggedText.includes(marker), 'the flag must not open the door to the secrets')
    const flaggedReport = JSON.parse(flaggedText)
    for (const name of ['web', 'rn']) {
      const recall = rowOf(flaggedReport, 'privacy-probe').platforms[name].recall
      assert.equal(recall[0].query, CONTROLLED_QUERY, `the ${name} recall carries the controlled query`)
    }
    assert.ok(!flagged.stdout.includes(CONTROLLED_QUERY) && !flagged.stderr.includes(CONTROLLED_QUERY),
      'the query appears only in the report, never on the console')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a provider error records only a safe code, the batch continues and the exit code reflects it', async () => {
  const png = tinyPng()
  const { root, manifestPath } = await writeFixtures({
    samples: [
      fixtureSample('e2e-before-error', { image: 'images/probe.png', hintText: 'first good sample' }),
      fixtureSample('e2e-exploding', { image: 'images/probe.png', hintText: 'please fail this sample' }),
      fixtureSample('e2e-after-error', { image: 'images/probe.png', hintText: 'sample after the failure' }),
    ],
    files: [['images/probe.png', png]],
  })
  try {
    const gateway = fixtureGateway({
      structuredOf: () => CLEANED_STRUCTURED,
      failOn: modelInput => (modelInput.user.text.includes('please fail this sample')
        ? `provider exploded carrying ${SECRET_KEY}`
        : null),
    })
    const outPath = path.join(root, 'report-error.json')
    const run = await runInProcess(
      ['--mode', 'e2e', '--manifest', manifestPath, '--out', outPath],
      { modelRunner: fixtureRunner(gateway), adapters: { web: fakeMatcher(), rn: fakeMatcher(), publicEquipmentById: { '0576': 'leverage machine' } } },
    )
    assert.equal(run.code, 1, 'a run with a sample error exits 1 after writing the report')
    assert.equal(run.stderr, '')
    assert.equal(gateway.calls.length, 3, 'the failing sample did call the model once, then failed')

    const reportText = await readFile(outPath, 'utf8')
    const report = JSON.parse(reportText)
    assert.equal(report.summary.sampleErrors, 1)
    assert.equal(report.summary.byPlatform.web.matched, 2)
    assert.equal(report.summary.byPlatform.rn.matched, 2)

    const before = rowOf(report, 'e2e-before-error')
    const failed = rowOf(report, 'e2e-exploding')
    const after = rowOf(report, 'e2e-after-error')
    // only the safe error code survives — never the thrown message
    assert.deepEqual(failed.error, { phase: 'model', code: 'model_unavailable' })
    assert.deepEqual(failed.platforms, {}, 'a failed sample evaluates no matcher')
    assert.equal(failed.recognition.stages.model, 1)
    assert.equal(failed.recognition.stages.end, 1)
    assert.equal(before.error, undefined)
    assert.equal(after.error, undefined, 'the batch continued past the failure')
    assert.deepEqual(after.platforms.web.finalIds, ['0576'])
    assert.deepEqual(after.platforms.rn.finalIds, ['0576'])
    assert.ok(!reportText.includes(SECRET_KEY), 'the provider error message leaked into the report')
    assert.ok(!run.stdout.includes(SECRET_KEY) && !run.stderr.includes(SECRET_KEY), 'the provider error message leaked to the console')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
