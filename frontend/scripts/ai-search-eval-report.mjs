#!/usr/bin/env node
// Matcher evaluation and report aggregation (D11 of
// docs/ai-exercise-search/EVAL_CLI_EXECUTION.md).
//
//   evaluatePlatform({ matcher, structured, sample, includeQueries, publicEquipmentById })
//   summarizeEvaluation(rows)
//
// evaluatePlatform runs one production matcher with the D04 diagnostics
// contract — { emit, evaluation: { expectedIds, includeQueries } } — and
// records the recall/filter/display events next to the matcher's own result.
// A matcher crash becomes a match-phase failure for that platform only; the
// caller keeps going with the other platform.
//
// Only whitelisted event fields survive into the returned record: public
// catalogue ids, finite numbers, slug labels and the fixed decision names.
// The query text is carried only when includeQueries was explicitly asked
// for. Nothing here prints anything.

import { ERROR_STATUS } from '../../api/agent-runtime/index.js'

const SAFE_CODES = new Set([...Object.keys(ERROR_STATUS), 'asset_missing', 'permission_denied'])

function safeCode(error) {
  const code = error?.code
  return typeof code === 'string' && SAFE_CODES.has(code) ? code : 'unknown'
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

// The D04 matcher emits recall/filter/display events. The stage field is the
// contract; the shape fallbacks keep this tolerant if the neighbouring file
// lands with a slightly different envelope.
function classifyEvent(event) {
  if (!event || typeof event !== 'object') return null
  const stage = event.stage ?? event.kind ?? event.type
  if (stage === 'recall' || stage === 'filter' || stage === 'display') return stage
  if (Array.isArray(event.top)) return 'recall'
  if (typeof event.decision === 'string') return 'filter'
  if (typeof event.resultCount === 'number') return 'display'
  return null
}

// recall: candidateIndex、queryOrigin、queryWordCount、hitCount、top (id+score,
// public catalogue only)。Evaluation mode adds expectedRanks — the 1-based
// original-list rank per expectedIds entry, null when absent — and the query
// text only when includeQueries is true.
function projectRecall(event, includeQueries) {
  const out = {}
  const candidateIndex = finiteNumber(event.candidateIndex)
  if (candidateIndex !== undefined) out.candidateIndex = candidateIndex
  const queryWordCount = finiteNumber(event.queryWordCount)
  if (queryWordCount !== undefined) out.queryWordCount = queryWordCount
  const hitCount = finiteNumber(event.hitCount)
  if (hitCount !== undefined) out.hitCount = hitCount
  if (typeof event.queryOrigin === 'string') out.queryOrigin = event.queryOrigin
  if (Array.isArray(event.top)) {
    out.top = event.top
      .filter(item => item && typeof item === 'object' && typeof item.id === 'string')
      .map(item => {
        const score = finiteNumber(item.score)
        return score === undefined ? { id: item.id } : { id: item.id, score }
      })
  }
  if (Array.isArray(event.expectedRanks)) {
    out.expectedRanks = event.expectedRanks.map(rank =>
      Number.isInteger(rank) && rank >= 1 ? rank : null)
  }
  if (includeQueries && typeof event.query === 'string') out.query = event.query
  return out
}

// filter: candidateIndex、decision、可选公开 id。
function projectFilter(event) {
  const out = {}
  const candidateIndex = finiteNumber(event.candidateIndex)
  if (candidateIndex !== undefined) out.candidateIndex = candidateIndex
  if (typeof event.decision === 'string') out.decision = event.decision
  if (typeof event.id === 'string' && event.id) out.id = event.id
  return out
}

// display: resultCount、publicIds、customCount、fallbackOnly、elapsedMs。
function projectDisplay(event) {
  const out = {}
  const resultCount = finiteNumber(event.resultCount)
  if (resultCount !== undefined) out.resultCount = resultCount
  const customCount = finiteNumber(event.customCount)
  if (customCount !== undefined) out.customCount = customCount
  const elapsedMs = finiteNumber(event.elapsedMs)
  if (elapsedMs !== undefined) out.elapsedMs = elapsedMs
  if (typeof event.fallbackOnly === 'boolean') out.fallbackOnly = event.fallbackOnly
  if (Array.isArray(event.publicIds)) {
    out.publicIds = event.publicIds.filter(id => typeof id === 'string')
  }
  return out
}

/** Run one platform's matcher over a validated structured output. Returns the
 * platform record for the report row: ok plus recall/filter/display events,
 * the final ids, fallbackOnly, elapsedMs, firstExpectedRank (the minimum
 * original rank across all queries for the sample's expectedIds, null when
 * never ranked) and wrongEquipment (only for match-positive samples whose
 * first final item's equipment is outside expectedEquipment). */
export function evaluatePlatform({ matcher, structured, sample, includeQueries = false, publicEquipmentById = null }) {
  const startedAt = Date.now()
  const collected = { recall: [], filter: [], display: [] }
  try {
    const diagnostics = {
      emit: event => {
        try {
          const kind = classifyEvent(event)
          if (!kind) return
          collected[kind].push(
            kind === 'recall' ? projectRecall(event, includeQueries)
              : kind === 'filter' ? projectFilter(event)
                : projectDisplay(event),
          )
        } catch { /* diagnostics must never break the match */ }
      },
      evaluation: {
        expectedIds: [...(sample?.expectedIds || [])],
        includeQueries: !!includeQueries,
      },
    }
    const result = matcher.match({ structured }, {
      hintText: typeof sample?.hintText === 'string' ? sample.hintText : '',
      diagnostics,
    })
    const elapsedMs = Date.now() - startedAt
    const items = result && Array.isArray(result.items) ? result.items : []
    const finalIds = items
      .map(item => (item && typeof item === 'object' && typeof item.exerciseId === 'string' ? item.exerciseId : null))
      .filter(id => id !== null)
    const display = collected.display.length ? collected.display[collected.display.length - 1] : null
    const fallbackOnly = display && typeof display.fallbackOnly === 'boolean'
      ? display.fallbackOnly
      : finalIds.length === 0
    let firstExpectedRank = null
    for (const event of collected.recall) {
      if (!Array.isArray(event.expectedRanks)) continue
      for (const rank of event.expectedRanks) {
        if (typeof rank === 'number' && rank >= 1 && (firstExpectedRank === null || rank < firstExpectedRank)) {
          firstExpectedRank = rank
        }
      }
    }
    let wrongEquipment = null
    if (sample?.expectation === 'match' && finalIds.length > 0 && publicEquipmentById) {
      const equipment = publicEquipmentById[finalIds[0]]
      wrongEquipment = typeof equipment === 'string' && equipment !== ''
        && !(sample.expectedEquipment || []).includes(equipment)
    }
    return {
      ok: true,
      recall: collected.recall,
      filter: collected.filter,
      display: collected.display,
      finalIds,
      fallbackOnly,
      elapsedMs,
      firstExpectedRank,
      wrongEquipment,
    }
  } catch (error) {
    return {
      ok: false,
      error: { phase: 'match', code: safeCode(error) },
      elapsedMs: Date.now() - startedAt,
    }
  }
}

// Nearest-rank percentile: rank = ceil(p/100 × n), 1-based.
function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length))
  return sorted[rank - 1]
}

function fraction(numerator, denominator) {
  return denominator > 0 ? { numerator, denominator } : null
}

function recallHit(platform, expectedIds) {
  for (const event of platform.recall || []) {
    for (const item of event.top || []) {
      if (expectedIds.includes(item.id)) return true
    }
  }
  return false
}

// One metric block. 分母：top1/top5/recallAt5 为已成功匹配的 match 正例；
// wrongEquipment 为其中有最终首名的；falsePositive 为成功匹配的 empty 样本；
// fallbackOnly 为全部成功匹配。执行失败单列。Latency p50/p95 nearest-rank。
function summarizeMetrics(pairs) {
  const ok = pairs.filter(pair => pair.platform.ok)
  const matchPositive = ok.filter(pair => pair.row.expectation === 'match')
  const matchPositiveWithFirst = matchPositive.filter(pair => (pair.platform.finalIds || []).length > 0)
  const emptyOk = ok.filter(pair => pair.row.expectation === 'empty')
  return {
    matched: ok.length,
    failed: pairs.length - ok.length,
    top1: fraction(
      matchPositiveWithFirst.filter(pair => pair.row.expectedIds.includes(pair.platform.finalIds[0])).length,
      matchPositive.length,
    ),
    top5: fraction(
      matchPositive.filter(pair => (pair.platform.finalIds || []).some(id => pair.row.expectedIds.includes(id))).length,
      matchPositive.length,
    ),
    recallAt5: fraction(
      matchPositive.filter(pair => recallHit(pair.platform, pair.row.expectedIds)).length,
      matchPositive.length,
    ),
    wrongEquipment: fraction(
      matchPositiveWithFirst.filter(pair => pair.platform.wrongEquipment === true).length,
      matchPositiveWithFirst.length,
    ),
    falsePositive: fraction(
      emptyOk.filter(pair => (pair.platform.finalIds || []).length > 0).length,
      emptyOk.length,
    ),
    fallbackOnly: fraction(
      ok.filter(pair => pair.platform.fallbackOnly === true).length,
      ok.length,
    ),
    latencyP50Ms: percentile(ok.map(pair => pair.platform.elapsedMs), 50),
    latencyP95Ms: percentile(ok.map(pair => pair.platform.elapsedMs), 95),
  }
}

function pairsOf(rows, platform) {
  return rows.flatMap(row => {
    const record = row.platforms?.[platform]
    return record ? [{ row, platform: record }] : []
  })
}

/** Aggregate the sample rows by platform and by group. Every counted metric
 * is { numerator, denominator }, null when there is no denominator; execution
 * failures are listed separately as `failed`. Vision (model-stage) latency and
 * matcher latency are aggregated independently. */
export function summarizeEvaluation(rows) {
  const list = Array.isArray(rows) ? rows : []
  const platforms = ['web', 'rn'].filter(name => list.some(row => row.platforms?.[name]))
  const byPlatform = {}
  for (const platform of platforms) {
    byPlatform[platform] = summarizeMetrics(pairsOf(list, platform))
  }
  const byGroup = {}
  const groups = []
  for (const row of list) {
    if (!groups.includes(row.group)) groups.push(row.group)
  }
  for (const group of groups) {
    const block = {}
    const groupRows = list.filter(row => row.group === group)
    for (const platform of platforms) {
      const pairs = pairsOf(groupRows, platform)
      if (pairs.length) block[platform] = summarizeMetrics(pairs)
    }
    byGroup[group] = block
  }
  // Vision latency is the model stage, reported through
  // row.recognition.elapsedMs by the entry; matcher latency lives in the
  // per-platform blocks above.
  const visionElapsed = list
    .map(row => (typeof row.recognition?.elapsedMs === 'number' && Number.isFinite(row.recognition.elapsedMs)
      ? row.recognition.elapsedMs
      : null))
    .filter(value => value !== null)
  return {
    samples: list.length,
    sampleErrors: list.filter(row => row.error).length,
    byPlatform,
    byGroup,
    visionLatency: {
      count: visionElapsed.length,
      p50Ms: percentile(visionElapsed, 50),
      p95Ms: percentile(visionElapsed, 95),
    },
  }
}
