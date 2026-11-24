#!/usr/bin/env node
// Evaluation sample loading for the AI exercise-search CLI (D10 of
// docs/ai-exercise-search/EVAL_CLI_EXECUTION.md).
//
//   loadEvaluationManifest(path) — read and validate the versioned sample manifest
//   loadReplay(sample)           — read one sample's recorded structured output
//   loadModelInput(sample)       — turn a sample's image (and hint) into task input
//
// Manifest paths (image, replay.path) resolve against the manifest file's
// directory; command-line paths are the entry's business. Nothing here ever
// prints: image paths, file names and recorded model text never reach stdout,
// stderr or an error message. Failures throw AgentError instances carrying a
// safe `code` plus a `phase` the entry maps onto the report row:
//
//   phase 'manifest'    — the whole manifest is unusable (exit 2)
//   phase 'replay'      — one sample's replay is unusable (sample error)
//   phase 'attachments' — one sample's image is unusable (sample error)

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  AgentError,
  EXERCISE_SEARCH_MAX_HINT,
  EXERCISE_SEARCH_MAX_IMAGE_BYTES,
  isExerciseSearchOutput,
} from '../../api/agent-runtime/index.js'

const MANIFEST_SCHEMA_VERSION = 1
const EXPECTATIONS = new Set(['match', 'empty'])
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/
const SAFE_LEVELS = new Set(['high', 'medium', 'low'])
const SAMPLE_FIELDS = new Set([
  'id', 'group', 'expectation', 'expectedIds', 'expectedEquipment', 'family',
  'image', 'hintText', 'replay',
])
const REPLAY_FIELDS = new Set(['path', 'index'])
// The shared task sniffs magic bytes itself; here only the extension decides
// which MIME the data URL declares.
const IMAGE_MIME_BY_EXTENSION = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

function evaluationError(phase, code) {
  const error = new AgentError(code)
  error.phase = phase
  return error
}

function fileErrorCode(error) {
  if (error?.code === 'ENOENT') return 'asset_missing'
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return 'permission_denied'
  return 'invalid_request'
}

function requireString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

// "必须是去重数组": the arrays have to arrive deduplicated, in string form so
// ids keep their leading zeros.
function requireStringArray(value) {
  if (!Array.isArray(value)) return null
  const out = []
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry) return null
    if (seen.has(entry)) return null
    seen.add(entry)
    out.push(entry)
  }
  return out
}

function validateSample(entry, manifestDir, seenIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  for (const key of Object.keys(entry)) {
    if (!SAMPLE_FIELDS.has(key)) return null
  }
  const id = requireString(entry.id)
  if (!id || seenIds.has(id)) return null
  seenIds.add(id)
  const group = requireString(entry.group)
  const family = requireString(entry.family)
  if (!group || !family) return null
  const expectation = entry.expectation
  if (!EXPECTATIONS.has(expectation)) return null
  const expectedIds = requireStringArray(entry.expectedIds)
  const expectedEquipment = requireStringArray(entry.expectedEquipment)
  if (!expectedIds || !expectedEquipment) return null
  if (expectation === 'match') {
    // match 必须有公开 ID 和至少一个器械；empty 的两个数组均为空。
    if (!expectedIds.length || !expectedEquipment.length) return null
  } else if (expectedIds.length || expectedEquipment.length) {
    return null
  }

  const sample = { id, group, family, expectation, expectedIds, expectedEquipment }
  if (entry.image !== undefined) {
    const image = requireString(entry.image)
    if (!image) return null
    sample.image = path.resolve(manifestDir, image)
  }
  if (entry.hintText !== undefined) {
    if (typeof entry.hintText !== 'string' || entry.hintText.length > EXERCISE_SEARCH_MAX_HINT) return null
    sample.hintText = entry.hintText
  }
  if (entry.replay !== undefined) {
    const replay = entry.replay
    if (!replay || typeof replay !== 'object' || Array.isArray(replay)) return null
    for (const key of Object.keys(replay)) {
      if (!REPLAY_FIELDS.has(key)) return null
    }
    const replayPath = requireString(replay.path)
    if (!replayPath) return null
    if (!Number.isInteger(replay.index) || replay.index < 0) return null
    sample.replay = { path: path.resolve(manifestDir, replayPath), index: replay.index }
  }
  return sample
}

/** Read and validate the evaluation manifest. Throws AgentError (phase
 * 'manifest', exit 2) when the file or any sample inside it is invalid. */
export async function loadEvaluationManifest(manifestPath) {
  let raw
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    throw evaluationError('manifest', fileErrorCode(error))
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw evaluationError('manifest', 'invalid_request')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw evaluationError('manifest', 'invalid_request')
  }
  // 顶层只含 schemaVersion 与 samples。
  for (const key of Object.keys(parsed)) {
    if (key !== 'schemaVersion' && key !== 'samples') throw evaluationError('manifest', 'invalid_request')
  }
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw evaluationError('manifest', 'invalid_request')
  if (!Array.isArray(parsed.samples)) throw evaluationError('manifest', 'invalid_request')

  const manifestDir = path.dirname(path.resolve(manifestPath))
  const seenIds = new Set()
  const samples = []
  for (const entry of parsed.samples) {
    const sample = validateSample(entry, manifestDir, seenIds)
    if (!sample) throw evaluationError('manifest', 'invalid_request')
    samples.push(sample)
  }
  return { schemaVersion: MANIFEST_SCHEMA_VERSION, samples }
}

/** Read `results[index].structured` and validate it with the shared output
 * schema. Invalid replays are a sample error — never auto-cleaned, the model
 * is never called for them. */
export async function loadReplay(sample) {
  const replay = sample.replay
  if (!replay || typeof replay.path !== 'string') throw evaluationError('replay', 'invalid_request')
  let raw
  try {
    raw = await readFile(replay.path, 'utf8')
  } catch (error) {
    throw evaluationError('replay', fileErrorCode(error))
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw evaluationError('replay', 'invalid_request')
  }
  const results = parsed && typeof parsed === 'object' && Array.isArray(parsed.results) ? parsed.results : null
  if (!results) throw evaluationError('replay', 'invalid_request')
  const entry = results[replay.index]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw evaluationError('replay', 'invalid_request')
  }
  if (!isExerciseSearchOutput(entry.structured)) throw evaluationError('replay', 'invalid_request')
  return entry.structured
}

/** Build the exercise-search task input for one vision/e2e sample: stat the
 * image with the shared 1 MiB limit first, then read the bytes and declare
 * the Data URL. Content, dimensions and aspect ratio stay the shared task's
 * to validate. Image paths never reach logs, errors or the report. */
export async function loadModelInput(sample) {
  const input = {}
  if (typeof sample.hintText === 'string' && sample.hintText.trim()) input.hintText = sample.hintText
  if (typeof sample.image === 'string') {
    const mime = IMAGE_MIME_BY_EXTENSION.get(path.extname(sample.image).toLowerCase())
    if (!mime) throw evaluationError('attachments', 'invalid_request')
    let info
    try {
      info = await stat(sample.image)
    } catch (error) {
      throw evaluationError('attachments', fileErrorCode(error))
    }
    if (!info.isFile()) throw evaluationError('attachments', 'asset_missing')
    if (info.size > EXERCISE_SEARCH_MAX_IMAGE_BYTES) {
      throw evaluationError('attachments', 'agent_media_too_large')
    }
    let bytes
    try {
      bytes = await readFile(sample.image)
    } catch (error) {
      throw evaluationError('attachments', fileErrorCode(error))
    }
    input.images = [`data:${mime};base64,${bytes.toString('base64')}`]
  }
  return input
}

function safeToken(value) {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : null
}

function safeTokenArray(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const token = safeToken(item)
    if (token && !out.includes(token)) out.push(token)
  }
  return out
}

/** Read non-sensitive structured benchmark metadata (groundTruthId,
 * visibleFeatures enums, expectedTrajectory and expectedBehavior). Free text
 * fields (hintText, description, etc.) are intentionally discarded. */
export async function loadBenchmarkMetadata(benchmarkPath) {
  let raw
  try {
    raw = await readFile(benchmarkPath, 'utf8')
  } catch (error) {
    throw evaluationError('manifest', fileErrorCode(error))
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw evaluationError('manifest', 'invalid_request')
  }
  if (!Array.isArray(parsed)) {
    throw evaluationError('manifest', 'invalid_request')
  }
  const byId = new Map()
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw evaluationError('manifest', 'invalid_request')
    }
    const id = requireString(entry.id)
    if (!id || byId.has(id)) {
      throw evaluationError('manifest', 'invalid_request')
    }
    const groundTruthId = safeToken(entry.ground_truth_id)
    const alternativeGroundTruthIds = safeTokenArray(entry.alternative_ground_truth_ids)
    const rawFeatures = entry.visible_features && typeof entry.visible_features === 'object' && !Array.isArray(entry.visible_features)
      ? entry.visible_features
      : {}
    const visibleFeatures = {
      loadingType: safeToken(rawFeatures.loading_type),
      frameArchetype: safeToken(rawFeatures.frame_archetype),
      occlusion: safeToken(rawFeatures.occlusion),
      angle: safeToken(rawFeatures.angle),
    }
    const rawBehavior = entry.expected_behavior && typeof entry.expected_behavior === 'object' && !Array.isArray(entry.expected_behavior)
      ? entry.expected_behavior
      : {}
    const maxLevel = typeof rawBehavior.max_allowed_level_if_nonempty === 'string' && SAFE_LEVELS.has(rawBehavior.max_allowed_level_if_nonempty)
      ? rawBehavior.max_allowed_level_if_nonempty
      : null
    byId.set(id, {
      id,
      groundTruthId,
      alternativeGroundTruthIds,
      groupId: safeToken(entry.group_id),
      sampleType: safeToken(entry.sample_type),
      isOod: entry.is_ood === true,
      visibleFeatures,
      expectedTrajectory: safeTokenArray(entry.expected_trajectory),
      expectedBehavior: {
        outcome: safeToken(rawBehavior.outcome),
        requireClarificationsOnPhotoOnly: rawBehavior.require_clarifications_on_photo_only === true,
        forbidHighConfidenceOnPhotoOnly: rawBehavior.forbid_high_confidence_on_photo_only === true,
        forbidHighConfidence: rawBehavior.forbid_high_confidence === true,
        expectShortCircuitRetrieval: rawBehavior.expect_short_circuit_retrieval === true,
        expectFallbackOnly: rawBehavior.expect_fallback_only === true,
        maxAllowedLevelIfNonempty: maxLevel,
      },
    })
  }
  return { byId }
}
