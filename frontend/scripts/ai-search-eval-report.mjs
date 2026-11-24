#!/usr/bin/env node
// Matcher evaluation and report aggregation (D11 of
// docs/ai-exercise-search/EVAL_CLI_EXECUTION.md), extended for paired
// v1 (web/rn) vs v2 (server_v2) comparison.
//
//   evaluatePlatform({ matcher, structured, sample, includeQueries, publicEquipmentById, publicBodyPartById })
//   evaluateServerV2({ adapter, structured, sample, publicEquipmentById, publicBodyPartById })
//   summarizeEvaluation(rows)
//
// Only whitelisted event fields survive into the returned record: public
// catalogue ids, finite numbers, slug labels and the fixed decision names.
// Model free text, API keys and image bytes never reach the output.

import { ERROR_STATUS } from '../../api/agent-runtime/index.js'

const SAFE_CODES = new Set([...Object.keys(ERROR_STATUS), 'asset_missing', 'permission_denied'])
const LEVELS = new Set(['high', 'medium', 'low'])
const V2_STAGES = new Set(['retrieval_text', 'retrieval_vector', 'retrieval_fusion', 'rerank'])
const RETRIEVAL_BACKENDS = new Set(['postgres', 'local', 'remote', 'fixture'])

function safeCode(error) {
  const code = error?.code
  return typeof code === 'string' && SAFE_CODES.has(code) ? code : 'unknown'
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function round4(value) {
  return Number(value.toFixed(4))
}

function classifyEvent(event) {
  if (!event || typeof event !== 'object') return null
  const stage = event.stage ?? event.kind ?? event.type
  if (stage === 'recall' || stage === 'filter' || stage === 'display') return stage
  if (Array.isArray(event.top)) return 'recall'
  if (typeof event.decision === 'string') return 'filter'
  if (typeof event.resultCount === 'number') return 'display'
  return null
}

function projectTopItems(list, limit = 5) {
  if (!Array.isArray(list)) return []
  return list
    .slice(0, limit)
    .filter(item => item && typeof item === 'object' && typeof item.id === 'string')
    .map(item => {
      const score = finiteNumber(item.score)
      return score === undefined ? { id: item.id } : { id: item.id, score }
    })
}

function projectRecall(event, includeQueries) {
  const out = {}
  const candidateIndex = finiteNumber(event.candidateIndex)
  if (candidateIndex !== undefined) out.candidateIndex = candidateIndex
  const queryWordCount = finiteNumber(event.queryWordCount)
  if (queryWordCount !== undefined) out.queryWordCount = queryWordCount
  const hitCount = finiteNumber(event.hitCount)
  if (hitCount !== undefined) out.hitCount = hitCount
  if (typeof event.queryOrigin === 'string') out.queryOrigin = event.queryOrigin
  if (Array.isArray(event.top)) out.top = projectTopItems(event.top, event.top.length)
  if (Array.isArray(event.expectedRanks)) {
    out.expectedRanks = event.expectedRanks.map(rank =>
      Number.isInteger(rank) && rank >= 1 ? rank : null)
  }
  if (includeQueries && typeof event.query === 'string') out.query = event.query
  return out
}

function projectFilter(event) {
  const out = {}
  const candidateIndex = finiteNumber(event.candidateIndex)
  if (candidateIndex !== undefined) out.candidateIndex = candidateIndex
  if (typeof event.decision === 'string') out.decision = event.decision
  if (typeof event.id === 'string' && event.id) out.id = event.id
  return out
}

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

function computeRankingMetrics(finalIds, sample) {
  const expectedIds = Array.isArray(sample?.expectedIds) ? sample.expectedIds : []
  const expectedSet = new Set(expectedIds)
  const groundTruthId = typeof sample?.groundTruthId === 'string' && sample.groundTruthId
    ? sample.groundTruthId
    : (expectedIds[0] ?? null)

  let firstExpectedDisplayRank = null
  for (let index = 0; index < finalIds.length; index++) {
    if (expectedSet.has(finalIds[index])) {
      firstExpectedDisplayRank = index + 1
      break
    }
  }

  if (sample?.expectation !== 'match') {
    return {
      strictTop1Hit: null,
      firstExpectedDisplayRank,
      mrrAt5: null,
      mrrAt10: null,
      ndcgAt5: null,
      multiValidHit: null,
    }
  }

  const strictTop1Hit = Boolean(groundTruthId) && finalIds[0] === groundTruthId
  const mrrAt5 = firstExpectedDisplayRank !== null && firstExpectedDisplayRank <= 5
    ? round4(1 / firstExpectedDisplayRank)
    : 0
  const mrrAt10 = firstExpectedDisplayRank !== null && firstExpectedDisplayRank <= 10
    ? round4(1 / firstExpectedDisplayRank)
    : 0

  const rel = id => (id === groundTruthId ? 2 : (expectedSet.has(id) ? 1 : 0))
  let dcg = 0
  for (let i = 0; i < Math.min(5, finalIds.length); i++) {
    const r = rel(finalIds[i])
    if (r > 0) dcg += (Math.pow(2, r) - 1) / Math.log2(i + 2)
  }
  const hasPrimaryInSet = Boolean(groundTruthId) && expectedSet.has(groundTruthId)
  const altCount = Math.max(0, expectedSet.size - (hasPrimaryInSet ? 1 : 0))
  const idealRels = [
    ...(hasPrimaryInSet ? [2] : []),
    ...Array(altCount).fill(1),
  ].slice(0, 5)
  let idcg = 0
  for (let i = 0; i < idealRels.length; i++) {
    idcg += (Math.pow(2, idealRels[i]) - 1) / Math.log2(i + 2)
  }
  const ndcgAt5 = idcg > 0 ? round4(dcg / idcg) : 0

  let multiValidHit = null
  if (expectedSet.size >= 2) {
    const hits = new Set(finalIds.slice(0, 5).filter(id => expectedSet.has(id)))
    multiValidHit = hits.size >= 2
  }

  return {
    strictTop1Hit,
    firstExpectedDisplayRank,
    mrrAt5,
    mrrAt10,
    ndcgAt5,
    multiValidHit,
  }
}

function computeSafetyMetrics({ finalIds, topLevels, sample, publicEquipmentById, publicBodyPartById }) {
  const top1Level = Array.isArray(topLevels) && LEVELS.has(topLevels[0]) ? topLevels[0] : null
  const expectedIds = Array.isArray(sample?.expectedIds) ? sample.expectedIds : []
  const expectedEquipment = Array.isArray(sample?.expectedEquipment) ? sample.expectedEquipment : []

  let wrongEquipment = null
  if (sample?.expectation === 'match' && finalIds.length > 0 && publicEquipmentById) {
    const equipment = publicEquipmentById[finalIds[0]]
    wrongEquipment = typeof equipment === 'string' && equipment !== ''
      && !expectedEquipment.includes(equipment)
  }

  let wrongBodyPart = null
  if (sample?.expectation === 'match' && finalIds.length > 0 && publicBodyPartById) {
    const expectedBps = new Set(expectedIds.map(id => publicBodyPartById[id]).filter(Boolean))
    const top1Bp = publicBodyPartById[finalIds[0]]
    if (typeof top1Bp === 'string' && top1Bp !== '' && expectedBps.size > 0) {
      wrongBodyPart = !expectedBps.has(top1Bp)
    }
  }

  const top1Correct = sample?.expectation === 'match'
    ? (finalIds.length > 0 && expectedIds.includes(finalIds[0]))
    : (sample?.expectation === 'empty' ? finalIds.length === 0 : null)
  const wrongHigh = top1Level === 'high' && top1Correct === false

  return { top1Level, wrongEquipment, wrongBodyPart, top1Correct, wrongHigh }
}

/** Run one v1 platform matcher over a validated structured output. */
export function evaluatePlatform({
  matcher,
  structured,
  sample,
  includeQueries = false,
  publicEquipmentById = null,
  publicBodyPartById = null,
}) {
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
    const finalIds = []
    const topLevels = []
    for (const item of items) {
      if (item && typeof item === 'object' && typeof item.exerciseId === 'string') {
        finalIds.push(item.exerciseId)
        topLevels.push(LEVELS.has(item.level) ? item.level : null)
      }
    }
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
    const clarificationCount = Array.isArray(result?.clarifications)
      ? result.clarifications.length
      : (Array.isArray(structured?.clarifications) ? structured.clarifications.length : 0)

    const ranking = computeRankingMetrics(finalIds, sample)
    const safety = computeSafetyMetrics({
      finalIds,
      topLevels,
      sample,
      publicEquipmentById,
      publicBodyPartById,
    })

    return {
      ok: true,
      recall: collected.recall,
      filter: collected.filter,
      display: collected.display,
      finalIds,
      topLevels,
      top1Level: safety.top1Level,
      top1Score: null,
      clarificationCount,
      fallbackOnly,
      elapsedMs,
      firstExpectedRank,
      wrongEquipment: safety.wrongEquipment,
      wrongBodyPart: safety.wrongBodyPart,
      wrongHigh: safety.wrongHigh,
      top1Correct: safety.top1Correct,
      strictTop1Hit: ranking.strictTop1Hit,
      firstExpectedDisplayRank: ranking.firstExpectedDisplayRank,
      mrrAt5: ranking.mrrAt5,
      ndcgAt5: ranking.ndcgAt5,
      multiValidHit: ranking.multiValidHit,
    }
  } catch (error) {
    return {
      ok: false,
      error: { phase: 'match', code: safeCode(error) },
      elapsedMs: Date.now() - startedAt,
    }
  }
}

function projectV2StageEvent(event, expectedSet, isMatch) {
  const topList = Array.isArray(event.top) ? event.top : []
  let firstExpectedRank = null
  const expectedRanks = []
  if (isMatch) {
    for (let i = 0; i < topList.length; i++) {
      const id = topList[i]?.id
      if (typeof id === 'string' && expectedSet.has(id)) {
        const rank = i + 1
        expectedRanks.push(rank)
        if (firstExpectedRank === null || rank < firstExpectedRank) firstExpectedRank = rank
      }
    }
  }
  const out = {
    stage: event.stage,
    ...(typeof event.backend === 'string' && RETRIEVAL_BACKENDS.has(event.backend) ? { backend: event.backend } : {}),
    ...(finiteNumber(event.elapsedMs) !== undefined ? { elapsedMs: event.elapsedMs } : {}),
    ...(finiteNumber(event.candidateCount) !== undefined ? { candidateCount: event.candidateCount } : {}),
    ...(typeof event.hasConfirmedEquipment === 'boolean' ? { hasConfirmedEquipment: event.hasConfirmedEquipment } : {}),
    ...(event.errorCode !== undefined ? { errorCode: safeCode({ code: event.errorCode }) } : {}),
    ...(isMatch ? { expectedHit: expectedRanks.length > 0, firstExpectedRank } : {}),
    top: projectTopItems(topList, 5),
  }
  return out
}

/** Run the server v2 multi-way retrieval + fusion + rerank adapter over the
 * same validated structured recognition output. */
export async function evaluateServerV2({
  adapter,
  structured,
  sample,
  publicEquipmentById = null,
  publicBodyPartById = null,
}) {
  const startedAt = Date.now()
  const rawEvents = []
  const expectedIds = Array.isArray(sample?.expectedIds) ? sample.expectedIds : []
  const expectedSet = new Set(expectedIds)
  const isMatch = sample?.expectation === 'match'

  try {
    const result = await adapter.match({ structured }, {
      hintText: typeof sample?.hintText === 'string' ? sample.hintText : '',
      diagnostic: event => {
        if (event && typeof event === 'object' && V2_STAGES.has(event.stage)) {
          rawEvents.push(event)
        }
      },
    })
    const elapsedMs = Date.now() - startedAt
    const outStructured = result && typeof result === 'object' && result.structured && typeof result.structured === 'object'
      ? result.structured
      : {}
    const finalIds = Array.isArray(outStructured.rankedIds)
      ? outStructured.rankedIds.filter(id => typeof id === 'string')
      : []
    const outItems = Array.isArray(outStructured.items) ? outStructured.items : []
    const levelById = new Map()
    for (const item of outItems) {
      if (item && typeof item === 'object' && typeof item.id === 'string' && LEVELS.has(item.level)) {
        levelById.set(item.id, item.level)
      }
    }
    const topLevels = finalIds.map(id => levelById.get(id) ?? null)
    const clarificationCount = Array.isArray(outStructured.clarifications) ? outStructured.clarifications.length : 0
    const fallbackOnly = finalIds.length === 0

    const funnelEvents = rawEvents.map(event => projectV2StageEvent(event, expectedSet, isMatch))
    const byStage = Object.fromEntries(funnelEvents.map(event => [event.stage, event]))
    const rerankRaw = rawEvents.find(event => event.stage === 'rerank')
    const top1Score = finiteNumber(rerankRaw?.top?.[0]?.score) ?? null

    const shortCircuited = !Array.isArray(structured?.candidates) || structured.candidates.length === 0
    const textRecallHitAt75 = isMatch ? Boolean(byStage.retrieval_text?.expectedHit) : null
    const vectorRecallHitAt75 = isMatch ? Boolean(byStage.retrieval_vector?.expectedHit) : null
    const fusionRecallHitAt30 = isMatch ? Boolean(byStage.retrieval_fusion?.expectedHit) : null
    const stageLatencyMs = {
      textMs: finiteNumber(byStage.retrieval_text?.elapsedMs) ?? null,
      vectorMs: finiteNumber(byStage.retrieval_vector?.elapsedMs) ?? null,
      fusionMs: finiteNumber(byStage.retrieval_fusion?.elapsedMs) ?? null,
      rerankMs: finiteNumber(byStage.rerank?.elapsedMs) ?? null,
    }

    const ranking = computeRankingMetrics(finalIds, sample)
    const safety = computeSafetyMetrics({
      finalIds,
      topLevels,
      sample,
      publicEquipmentById,
      publicBodyPartById,
    })

    return {
      ok: true,
      finalIds,
      topLevels,
      top1Level: safety.top1Level,
      top1Score,
      clarificationCount,
      fallbackOnly,
      elapsedMs,
      firstExpectedRank: ranking.firstExpectedDisplayRank,
      wrongEquipment: safety.wrongEquipment,
      wrongBodyPart: safety.wrongBodyPart,
      wrongHigh: safety.wrongHigh,
      top1Correct: safety.top1Correct,
      strictTop1Hit: ranking.strictTop1Hit,
      firstExpectedDisplayRank: ranking.firstExpectedDisplayRank,
      mrrAt5: ranking.mrrAt5,
      mrrAt10: ranking.mrrAt10,
      ndcgAt5: ranking.ndcgAt5,
      multiValidHit: ranking.multiValidHit,
      funnel: {
        shortCircuited,
        textRecallHitAt75,
        vectorRecallHitAt75,
        fusionRecallHitAt30,
        stageLatencyMs,
        events: funnelEvents,
      },
    }
  } catch (error) {
    const rawPhase = rawEvents.at(-1)?.stage === 'rerank' ? 'rerank' : 'retrieval'
    return {
      ok: false,
      error: { phase: rawPhase, code: safeCode(error) },
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

function mean(values) {
  if (!values.length) return null
  return round4(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function scoreDistribution(values) {
  if (!values.length) return { count: 0, min: null, p25: null, p50: null, p75: null, max: null }
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    min: round4(sorted[0]),
    p25: round4(percentile(sorted, 25)),
    p50: round4(percentile(sorted, 50)),
    p75: round4(percentile(sorted, 75)),
    max: round4(sorted[sorted.length - 1]),
  }
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

function summarizeCalibration(okPairs) {
  const tiers = {}
  for (const level of ['high', 'medium', 'low']) {
    const slice = okPairs.filter(pair => pair.platform.top1Level === level)
    tiers[level] = {
      correct: slice.filter(pair => pair.platform.top1Correct === true).length,
      total: slice.length,
    }
  }
  return tiers
}

function summarizeV2Funnel(okPairs, matchPositive, emptyOk) {
  const latencyOf = (key, fn) => {
    const vals = okPairs
      .map(pair => pair.platform.funnel?.stageLatencyMs?.[key])
      .filter(value => typeof value === 'number' && Number.isFinite(value))
    return fn(vals)
  }
  const scoredPairs = okPairs.filter(pair => typeof pair.platform.top1Score === 'number' && Number.isFinite(pair.platform.top1Score))
  const matchCorrectScores = scoredPairs
    .filter(pair => pair.row.expectation === 'match' && pair.platform.top1Correct === true)
    .map(pair => pair.platform.top1Score)
  const matchWrongScores = scoredPairs
    .filter(pair => pair.row.expectation === 'match' && pair.platform.top1Correct === false)
    .map(pair => pair.platform.top1Score)
  const emptyNonEmptyScores = scoredPairs
    .filter(pair => pair.row.expectation === 'empty' && (pair.platform.finalIds || []).length > 0)
    .map(pair => pair.platform.top1Score)

  return {
    textRecallAt75: fraction(
      matchPositive.filter(pair => pair.platform.funnel?.textRecallHitAt75 === true).length,
      matchPositive.length,
    ),
    vectorRecallAt75: fraction(
      matchPositive.filter(pair => pair.platform.funnel?.vectorRecallHitAt75 === true).length,
      matchPositive.length,
    ),
    fusionRecallAt30: fraction(
      matchPositive.filter(pair => pair.platform.funnel?.fusionRecallHitAt30 === true).length,
      matchPositive.length,
    ),
    shortCircuitRate: fraction(
      okPairs.filter(pair => pair.platform.funnel?.shortCircuited === true).length,
      okPairs.length,
    ),
    emptyShortCircuitRate: fraction(
      emptyOk.filter(pair => pair.platform.funnel?.shortCircuited === true).length,
      emptyOk.length,
    ),
    stageLatencyP50Ms: {
      textMs: latencyOf('textMs', vals => percentile(vals, 50)),
      vectorMs: latencyOf('vectorMs', vals => percentile(vals, 50)),
      fusionMs: latencyOf('fusionMs', vals => percentile(vals, 50)),
      rerankMs: latencyOf('rerankMs', vals => percentile(vals, 50)),
    },
    stageLatencyP95Ms: {
      textMs: latencyOf('textMs', vals => percentile(vals, 95)),
      vectorMs: latencyOf('vectorMs', vals => percentile(vals, 95)),
      fusionMs: latencyOf('fusionMs', vals => percentile(vals, 95)),
      rerankMs: latencyOf('rerankMs', vals => percentile(vals, 95)),
    },
    top1ScoreSummary: {
      all: scoreDistribution(scoredPairs.map(pair => pair.platform.top1Score)),
      matchCorrect: scoreDistribution(matchCorrectScores),
      matchWrong: scoreDistribution(matchWrongScores),
      emptyNonEmpty: scoreDistribution(emptyNonEmptyScores),
    },
  }
}

// One metric block. Symmetric metrics share identical definitions across web,
// rn and server_v2; top5 always slices finalIds to the first 5 entries so
// v2's 10-slot display never inflates top5 fairness. Asymmetric v1/v2 fields
// become null where inapplicable.
function summarizeMetrics(pairs, platformName) {
  const ok = pairs.filter(pair => pair.platform.ok)
  const matchPositive = ok.filter(pair => pair.row.expectation === 'match')
  const matchPositiveWithFirst = matchPositive.filter(pair => (pair.platform.finalIds || []).length > 0)
  const matchPositiveWithBp = matchPositiveWithFirst.filter(pair => typeof pair.platform.wrongBodyPart === 'boolean')
  const matchMultiValid = matchPositive.filter(pair => typeof pair.platform.multiValidHit === 'boolean')
  const emptyOk = ok.filter(pair => pair.row.expectation === 'empty')
  const badImageOk = emptyOk.filter(pair => pair.row.family === 'bad-image')
  const nearOodOk = emptyOk.filter(pair => pair.row.family !== 'bad-image')
  const isV2 = platformName === 'server_v2'

  return {
    matched: ok.length,
    failed: pairs.length - ok.length,
    strictTop1: fraction(
      matchPositiveWithFirst.filter(pair => pair.platform.strictTop1Hit === true).length,
      matchPositive.length,
    ),
    top1: fraction(
      matchPositiveWithFirst.filter(pair => pair.row.expectedIds.includes(pair.platform.finalIds[0])).length,
      matchPositive.length,
    ),
    top5: fraction(
      matchPositive.filter(pair => (pair.platform.finalIds || []).slice(0, 5).some(id => pair.row.expectedIds.includes(id))).length,
      matchPositive.length,
    ),
    top10: isV2 ? fraction(
      matchPositive.filter(pair => (pair.platform.finalIds || []).slice(0, 10).some(id => pair.row.expectedIds.includes(id))).length,
      matchPositive.length,
    ) : null,
    mrrAt5: mean(matchPositive.map(pair => (typeof pair.platform.mrrAt5 === 'number' ? pair.platform.mrrAt5 : 0))),
    mrrAt10: isV2 ? mean(matchPositive.map(pair => (typeof pair.platform.mrrAt10 === 'number' ? pair.platform.mrrAt10 : 0))) : null,
    ndcgAt5: mean(matchPositive.map(pair => (typeof pair.platform.ndcgAt5 === 'number' ? pair.platform.ndcgAt5 : 0))),
    recallAt5: isV2 ? null : fraction(
      matchPositive.filter(pair => recallHit(pair.platform, pair.row.expectedIds)).length,
      matchPositive.length,
    ),
    wrongHigh: fraction(
      ok.filter(pair => pair.platform.wrongHigh === true).length,
      ok.length,
    ),
    wrongEquipment: fraction(
      matchPositiveWithFirst.filter(pair => pair.platform.wrongEquipment === true).length,
      matchPositiveWithFirst.length,
    ),
    wrongBodyPart: fraction(
      matchPositiveWithBp.filter(pair => pair.platform.wrongBodyPart === true).length,
      matchPositiveWithBp.length,
    ),
    calibration: summarizeCalibration(ok),
    falsePositive: fraction(
      emptyOk.filter(pair => (pair.platform.finalIds || []).length > 0).length,
      emptyOk.length,
    ),
    badImageFp: fraction(
      badImageOk.filter(pair => (pair.platform.finalIds || []).length > 0).length,
      badImageOk.length,
    ),
    badImageHighFp: fraction(
      badImageOk.filter(pair => (pair.platform.finalIds || []).length > 0 && pair.platform.top1Level === 'high').length,
      badImageOk.length,
    ),
    nearOodFp: fraction(
      nearOodOk.filter(pair => (pair.platform.finalIds || []).length > 0).length,
      nearOodOk.length,
    ),
    nearOodHighFp: fraction(
      nearOodOk.filter(pair => (pair.platform.finalIds || []).length > 0 && pair.platform.top1Level === 'high').length,
      nearOodOk.length,
    ),
    coverage: fraction(
      matchPositiveWithFirst.length,
      matchPositive.length,
    ),
    selectivePrecision: fraction(
      matchPositiveWithFirst.filter(pair => pair.row.expectedIds.includes(pair.platform.finalIds[0])).length,
      matchPositiveWithFirst.length,
    ),
    clarificationRate: fraction(
      ok.filter(pair => (pair.platform.clarificationCount ?? 0) > 0).length,
      ok.length,
    ),
    clarificationNoHigh: fraction(
      ok.filter(pair => (pair.platform.clarificationCount ?? 0) > 0 && pair.platform.top1Level !== 'high').length,
      ok.length,
    ),
    multiValidCoverage: fraction(
      matchMultiValid.filter(pair => pair.platform.multiValidHit === true).length,
      matchMultiValid.length,
    ),
    fallbackOnly: fraction(
      ok.filter(pair => pair.platform.fallbackOnly === true).length,
      ok.length,
    ),
    latencyP50Ms: percentile(ok.map(pair => pair.platform.elapsedMs), 50),
    latencyP95Ms: percentile(ok.map(pair => pair.platform.elapsedMs), 95),
    v2Funnel: isV2 ? summarizeV2Funnel(ok, matchPositive, emptyOk) : null,
  }
}

function pairsOf(rows, platform) {
  return rows.flatMap(row => {
    const record = row.platforms?.[platform]
    return record ? [{ row, platform: record }] : []
  })
}

/** Aggregate the sample rows by platform and by group. */
export function summarizeEvaluation(rows) {
  const list = Array.isArray(rows) ? rows : []
  const platforms = ['web', 'rn', 'server_v2'].filter(name => list.some(row => row.platforms?.[name]))
  const byPlatform = {}
  for (const platform of platforms) {
    byPlatform[platform] = summarizeMetrics(pairsOf(list, platform), platform)
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
      if (pairs.length) block[platform] = summarizeMetrics(pairs, platform)
    }
    byGroup[group] = block
  }
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
