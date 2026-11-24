#!/usr/bin/env node
// Compare paired v1 (web/rn) vs v2 (server_v2) evaluation reports across prompt
// tiers and generate a Markdown + JSON comparison summary.
//
//   node frontend/scripts/ai-search-eval-compare.mjs
//     --input photo-only=<path> --input simple=<path> ...
//     [--extra repo13=<path>]
//     [--baseline rn|web]
//     --out-md <path> [--out-json <path>]

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const BASELINES = new Set(['rn', 'web'])
const CHALLENGER = 'server_v2'

function parseNamedSpec(value) {
  const index = value.indexOf('=')
  if (index <= 0 || index === value.length - 1) return null
  return { label: value.slice(0, index).trim(), filePath: value.slice(index + 1).trim() }
}

function pct(fraction) {
  if (!fraction || !fraction.denominator) return null
  return Number(((fraction.numerator / fraction.denominator) * 100).toFixed(1))
}

function fmtFrac(fraction) {
  if (!fraction || fraction.denominator <= 0) return 'N/A'
  const p = ((fraction.numerator / fraction.denominator) * 100).toFixed(1)
  return `${fraction.numerator}/${fraction.denominator} (${p}%)`
}

function fmtDeltaFrac(base, next, lowerIsBetter = false) {
  const a = pct(base)
  const b = pct(next)
  if (a === null || b === null) return 'N/A'
  const diff = Number((b - a).toFixed(1))
  const sign = diff > 0 ? '+' : ''
  const mark = diff === 0 ? '' : ((lowerIsBetter ? diff < 0 : diff > 0) ? ' ✅' : ' ⚠️')
  return `${sign}${diff}pp${mark}`
}

function fmtNum(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'N/A'
}

function fmtDeltaNum(base, next, lowerIsBetter = false) {
  if (typeof base !== 'number' || typeof next !== 'number') return 'N/A'
  const diff = Number((next - base).toFixed(3))
  const sign = diff > 0 ? '+' : ''
  const mark = diff === 0 ? '' : ((lowerIsBetter ? diff < 0 : diff > 0) ? ' ✅' : ' ⚠️')
  return `${sign}${diff.toFixed(3)}${mark}`
}

function fmtMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : 'N/A'
}

function fmtDeltaMs(base, next) {
  if (typeof base !== 'number' || typeof next !== 'number') return 'N/A'
  const diff = Math.round(next - base)
  return `${diff >= 0 ? '+' : ''}${diff}ms`
}

function fmtCalTier(cal, level) {
  const entry = cal?.[level]
  if (!entry || entry.total === 0) return '0/0 (-)'
  const p = ((entry.correct / entry.total) * 100).toFixed(1)
  return `${entry.correct}/${entry.total} (${p}%)`
}

function isPlatformOk(record) {
  return Boolean(record && typeof record === 'object' && !record.error)
}

function computeInvariance(rows, baseline) {
  const byFamily = new Map()
  for (const row of rows) {
    if (row.expectation !== 'match' || !row.family) continue
    if (!byFamily.has(row.family)) byFamily.set(row.family, [])
    byFamily.get(row.family).push(row)
  }
  const families = []
  for (const [family, list] of byFamily.entries()) {
    if (list.length < 2) continue
    const passCount = plat => list.filter(row => isPlatformOk(row.platforms?.[plat]) && row.platforms[plat].top1Correct === true).length
    const v1Pass = passCount(baseline)
    const v2Pass = passCount(CHALLENGER)
    families.push({
      family,
      sampleCount: list.length,
      v1SamplePass: v1Pass,
      v1AllPass: v1Pass === list.length,
      v2SamplePass: v2Pass,
      v2AllPass: v2Pass === list.length,
    })
  }
  return families.sort((a, b) => a.family.localeCompare(b.family))
}

function extractFlips(rows, baseline) {
  const toPositive = []
  const toNegative = []
  for (const row of rows) {
    const v1 = row.platforms?.[baseline]
    const v2 = row.platforms?.[CHALLENGER]
    if (!isPlatformOk(v1) || !isPlatformOk(v2)) continue
    if (v1.top1Correct === v2.top1Correct) continue
    const item = {
      id: row.id,
      group: row.group,
      family: row.family,
      expectation: row.expectation,
      v1Top1: v1.finalIds?.[0] ?? null,
      v1Level: v1.top1Level ?? null,
      v2Top1: v2.finalIds?.[0] ?? null,
      v2Level: v2.top1Level ?? null,
      v2Score: v2.top1Score ?? null,
      v2Rank: v2.firstExpectedDisplayRank ?? null,
      v2TextHit75: v2.funnel?.textRecallHitAt75 ?? null,
      v2VectorHit75: v2.funnel?.vectorRecallHitAt75 ?? null,
      v2FusionHit30: v2.funnel?.fusionRecallHitAt30 ?? null,
    }
    if (!v1.top1Correct && v2.top1Correct) toPositive.push(item)
    else if (v1.top1Correct && !v2.top1Correct) toNegative.push(item)
  }
  return { toPositive, toNegative }
}

function summarizeReportPair(label, report, baseline) {
  const summary = report?.summary || {}
  const rows = Array.isArray(report?.samples) ? report.samples : []
  const v1 = summary.byPlatform?.[baseline] || null
  const v2 = summary.byPlatform?.[CHALLENGER] || null
  const hardGroupV1 = summary.byGroup?.hard_confusing?.[baseline] || null
  const hardGroupV2 = summary.byGroup?.hard_confusing?.[CHALLENGER] || null
  const stdGroupV1 = summary.byGroup?.standard_positive?.[baseline] || null
  const stdGroupV2 = summary.byGroup?.standard_positive?.[CHALLENGER] || null
  return {
    label,
    mode: report?.mode ?? null,
    samples: summary.samples ?? rows.length,
    sampleErrors: summary.sampleErrors ?? 0,
    visionLatency: summary.visionLatency ?? null,
    v1,
    v2,
    hardClarification: {
      v1Rate: hardGroupV1?.clarificationRate ?? null,
      v2Rate: hardGroupV2?.clarificationRate ?? null,
      v1NoHigh: hardGroupV1?.clarificationNoHigh ?? null,
      v2NoHigh: hardGroupV2?.clarificationNoHigh ?? null,
    },
    stdOverClarification: {
      v1Rate: stdGroupV1?.clarificationRate ?? null,
      v2Rate: stdGroupV2?.clarificationRate ?? null,
    },
    byGroup: summary.byGroup ?? {},
    invariance: computeInvariance(rows, baseline),
    flips: extractFlips(rows, baseline),
  }
}

function buildMarkdown({ tiers, extras, baseline }) {
  const lines = []
  lines.push(`# AI 动作检索前后对比报告（\`${baseline} (v1)\` vs \`server_v2 (v2)\`）`)
  lines.push('')
  lines.push('> 注：所有成对比较基于同一次 VLM 识别输出（Paired Single-VLM），已剥离 VLM 随机波动。`v2` 的 `Top-5` 严格按前 5 名截断计分以保证公平性；`v1` 与 `v2` 非对偶指标（如服务端 `Recall@75`/`RRF@30`/`Top-10` 与客户端 `Recall@5`）分别以 `N/A (仅 v1/仅 v2)` 单列展示。')
  lines.push('')

  lines.push('## 1. 四档提示梯度总览（对称指标对比）')
  lines.push('')
  lines.push('| 梯度 | 有效样本 | 平台 | Top-1 | Strict Top-1 | Top-5 | MRR@5 | nDCG@5 | Wrong-High | WrongEq | WrongBP | BadImage-FP | NearOOD-FP | 延迟 P50 / P95 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')

  for (const tier of tiers) {
    const v1 = tier.v1
    const v2 = tier.v2
    const rows = [
      ['`v1`', v1],
      ['`v2`', v2],
    ]
    for (const [tag, m] of rows) {
      if (!m) continue
      lines.push(`| \`${tier.label}\` | ${tier.samples} (err=${tier.sampleErrors}) | ${tag} | ${fmtFrac(m.top1)} | ${fmtFrac(m.strictTop1)} | ${fmtFrac(m.top5)} | ${fmtNum(m.mrrAt5)} | ${fmtNum(m.ndcgAt5)} | ${fmtFrac(m.wrongHigh)} | ${fmtFrac(m.wrongEquipment)} | ${fmtFrac(m.wrongBodyPart)} | ${fmtFrac(m.badImageFp)} | ${fmtFrac(m.nearOodFp)} | ${fmtMs(m.latencyP50Ms)} / ${fmtMs(m.latencyP95Ms)} |`)
    }
    if (v1 && v2) {
      lines.push(`| \`${tier.label}\` Δ | - | **\`v2-v1\`** | ${fmtDeltaFrac(v1.top1, v2.top1)} | ${fmtDeltaFrac(v1.strictTop1, v2.strictTop1)} | ${fmtDeltaFrac(v1.top5, v2.top5)} | ${fmtDeltaNum(v1.mrrAt5, v2.mrrAt5)} | ${fmtDeltaNum(v1.ndcgAt5, v2.ndcgAt5)} | ${fmtDeltaFrac(v1.wrongHigh, v2.wrongHigh, true)} | ${fmtDeltaFrac(v1.wrongEquipment, v2.wrongEquipment, true)} | ${fmtDeltaFrac(v1.wrongBodyPart, v2.wrongBodyPart, true)} | ${fmtDeltaFrac(v1.badImageFp, v2.badImageFp, true)} | ${fmtDeltaFrac(v1.nearOodFp, v2.nearOodFp, true)} | ${fmtDeltaMs(v1.latencyP50Ms, v2.latencyP50Ms)} / ${fmtDeltaMs(v1.latencyP95Ms, v2.latencyP95Ms)} |`)
    }
  }
  lines.push('')

  lines.push('## 2. 消歧覆盖与多合法动作共现（对称对比）')
  lines.push('')
  lines.push('| 梯度 | `v1` 歧义组消歧率 (非High) | `v2` 歧义组消歧率 (非High) | `v1` 清晰组打扰率 | `v2` 清晰组打扰率 | `v1` 二合一双动作共现 | `v2` 二合一双动作共现 | `v1` Coverage / Precision | `v2` Coverage / Precision |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const tier of tiers) {
    const v1 = tier.v1
    const v2 = tier.v2
    lines.push(`| \`${tier.label}\` | ${fmtFrac(tier.hardClarification.v1Rate)} / ${fmtFrac(tier.hardClarification.v1NoHigh)} | ${fmtFrac(tier.hardClarification.v2Rate)} / ${fmtFrac(tier.hardClarification.v2NoHigh)} | ${fmtFrac(tier.stdOverClarification.v1Rate)} | ${fmtFrac(tier.stdOverClarification.v2Rate)} | ${fmtFrac(v1?.multiValidCoverage)} | ${fmtFrac(v2?.multiValidCoverage)} | ${fmtFrac(v1?.coverage)} / ${fmtFrac(v1?.selectivePrecision)} | ${fmtFrac(v2?.coverage)} / ${fmtFrac(v2?.selectivePrecision)} |`)
  }
  lines.push('')

  lines.push('## 3. 非对称诊断指标（各版本专属，不强行求差）')
  lines.push('')
  lines.push('| 梯度 | `v1` 本地 Recall@5 (仅 v1) | `v2` Top-10 (仅 v2) | `v2` MRR@10 (仅 v2) | `v2` 文本@75 (仅 v2) | `v2` 向量@75 (仅 v2) | `v2` RRF@30 (仅 v2) | `v2` 空例短路拒识率 (仅 v2) | `v2` 分阶段 P50 (text/vec/fuse/rerank) |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const tier of tiers) {
    const f = tier.v2?.v2Funnel
    const p50 = f?.stageLatencyP50Ms
    const stageStr = p50 ? `${fmtMs(p50.textMs)} / ${fmtMs(p50.vectorMs)} / ${fmtMs(p50.fusionMs)} / ${fmtMs(p50.rerankMs)}` : 'N/A'
    lines.push(`| \`${tier.label}\` | ${fmtFrac(tier.v1?.recallAt5)} | ${fmtFrac(tier.v2?.top10)} | ${fmtNum(tier.v2?.mrrAt10)} | ${fmtFrac(f?.textRecallAt75)} | ${fmtFrac(f?.vectorRecallAt75)} | ${fmtFrac(f?.fusionRecallAt30)} | ${fmtFrac(f?.emptyShortCircuitRate)} | ${stageStr} |`)
  }
  lines.push('')

  lines.push('## 4. 按样本组切片对照')
  lines.push('')
  for (const tier of tiers) {
    lines.push(`### 4.${tiers.indexOf(tier) + 1} \`${tier.label}\` 切片`)
    lines.push('')
    lines.push('| 组别 | `v1` Top-1 / Top-5 / FP | `v2` Top-1 / Top-5 / Top-10 / FP | `v2` Wrong-High | `v2` 文本@75 / 向量@75 / RRF@30 |')
    lines.push('|---|---|---|---|---|')
    for (const [group, block] of Object.entries(tier.byGroup)) {
      const g1 = block?.[baseline]
      const g2 = block?.[CHALLENGER]
      const v1Stat = g1 ? (g1.top1 ? `${fmtFrac(g1.top1)} / ${fmtFrac(g1.top5)} / -` : `- / - / ${fmtFrac(g1.falsePositive)}`) : 'N/A'
      const v2Stat = g2 ? (g2.top1 ? `${fmtFrac(g2.top1)} / ${fmtFrac(g2.top5)} / ${fmtFrac(g2.top10)} / -` : `- / - / - / ${fmtFrac(g2.falsePositive)}`) : 'N/A'
      const f = g2?.v2Funnel
      const funnelStr = f?.textRecallAt75 ? `${fmtFrac(f.textRecallAt75)} / ${fmtFrac(f.vectorRecallAt75)} / ${fmtFrac(f.fusionRecallAt30)}` : 'N/A'
      lines.push(`| \`${group}\` | ${v1Stat} | ${v2Stat} | ${fmtFrac(g2?.wrongHigh)} | ${funnelStr} |`)
    }
    lines.push('')
  }

  lines.push('## 5. 置信度分档校准（Calibration）与 `v2` Rerank 分数分布')
  lines.push('')
  lines.push('| 梯度 | `v1` high / medium / low 准确率 | `v2` high / medium / low 准确率 | `v2` 命中样本 Score (min/p50/max) | `v2` 错判正例 Score (min/p50/max) | `v2` 反例误报 Score (min/p50/max) |')
  lines.push('|---|---|---|---|---|---|')
  const fmtScore = s => (s && s.count > 0 ? `n=${s.count}: ${s.min}/${s.p50}/${s.max}` : 'n=0')
  for (const tier of tiers) {
    const c1 = tier.v1?.calibration
    const c2 = tier.v2?.calibration
    const s = tier.v2?.v2Funnel?.top1ScoreSummary
    lines.push(`| \`${tier.label}\` | ${fmtCalTier(c1, 'high')} · ${fmtCalTier(c1, 'medium')} · ${fmtCalTier(c1, 'low')} | ${fmtCalTier(c2, 'high')} · ${fmtCalTier(c2, 'medium')} · ${fmtCalTier(c2, 'low')} | ${fmtScore(s?.matchCorrect)} | ${fmtScore(s?.matchWrong)} | ${fmtScore(s?.emptyNonEmpty)} |`)
  }
  lines.push('')

  const photoTier = tiers[0]
  if (photoTier?.invariance?.length) {
    lines.push(`## 6. 同动作家族跨视角/跨加载方式一致率（以 \`${photoTier.label}\` 为例）`)
    lines.push('')
    lines.push('| 动作家族 | 样本数 | `v1` 命中 / 全对 | `v2` 命中 / 全对 |')
    lines.push('|---|---:|---|---|')
    for (const fam of photoTier.invariance) {
      lines.push(`| \`${fam.family}\` | ${fam.sampleCount} | ${fam.v1SamplePass}/${fam.sampleCount} (${fam.v1AllPass ? '全对' : '部分'}) | ${fam.v2SamplePass}/${fam.sampleCount} (${fam.v2AllPass ? '全对' : '部分'}) |`)
    }
    lines.push('')
  }

  lines.push('## 7. 逐样本成对变化归因（`v1` vs `v2`）')
  lines.push('')
  for (const tier of tiers) {
    lines.push(`### 7.${tiers.indexOf(tier) + 1} \`${tier.label}\`：翻正 ${tier.flips.toPositive.length} 例 / 翻错 ${tier.flips.toNegative.length} 例`)
    lines.push('')
    if (tier.flips.toPositive.length || tier.flips.toNegative.length) {
      lines.push('| 方向 | ID | 分组 / 家族 | `v1` 首名 (档位) | `v2` 首名 (档位 · 分数) | `v2` 期望排位 | `v2` 漏斗 (Text75/Vec75/RRF30) |')
      lines.push('|---|---|---|---|---|---:|---|')
      for (const f of tier.flips.toPositive) {
        lines.push(`| ✅ 翻正 | \`${f.id}\` | \`${f.group}\` / \`${f.family}\` | \`${f.v1Top1 ?? 'EMPTY'}\` (${f.v1Level ?? '-'}) | \`${f.v2Top1 ?? 'EMPTY'}\` (${f.v2Level ?? '-'} · ${f.v2Score ?? '-'}) | ${f.v2Rank ?? '-'} | ${f.v2TextHit75}/${f.v2VectorHit75}/${f.v2FusionHit30} |`)
      }
      for (const f of tier.flips.toNegative) {
        lines.push(`| ❌ 翻错 | \`${f.id}\` | \`${f.group}\` / \`${f.family}\` | \`${f.v1Top1 ?? 'EMPTY'}\` (${f.v1Level ?? '-'}) | \`${f.v2Top1 ?? 'EMPTY'}\` (${f.v2Level ?? '-'} · ${f.v2Score ?? '-'}) | ${f.v2Rank ?? '-'} | ${f.v2TextHit75}/${f.v2VectorHit75}/${f.v2FusionHit30} |`)
      }
    } else {
      lines.push('_本档位无 Top-1 翻正或翻错差异。_')
    }
    lines.push('')
  }

  if (extras.length) {
    lines.push('## 8. 补充基线数据集对比（历史回放集）')
    lines.push('')
    lines.push('| 数据集 | 样本 | `v1` Top-1 / Top-5 / Wrong-High / FP | `v2` Top-1 / Top-5 / Top-10 / Wrong-High / FP | `v2` 文本@75 / 向量@75 / RRF@30 |')
    lines.push('|---|---|---|---|---|')
    for (const ex of extras) {
      const f = ex.v2?.v2Funnel
      lines.push(`| \`${ex.label}\` | ${ex.samples} (err=${ex.sampleErrors}) | ${fmtFrac(ex.v1?.top1)} / ${fmtFrac(ex.v1?.top5)} / ${fmtFrac(ex.v1?.wrongHigh)} / ${fmtFrac(ex.v1?.falsePositive)} | ${fmtFrac(ex.v2?.top1)} / ${fmtFrac(ex.v2?.top5)} / ${fmtFrac(ex.v2?.top10)} / ${fmtFrac(ex.v2?.wrongHigh)} / ${fmtFrac(ex.v2?.falsePositive)} | ${fmtFrac(f?.textRecallAt75)} / ${fmtFrac(f?.vectorRecallAt75)} / ${fmtFrac(f?.fusionRecallAt30)} |`)
    }
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

export function compareEvaluations({ inputs, extras = [], baseline = 'rn' }) {
  if (!BASELINES.has(baseline)) throw new Error('Invalid baseline platform')
  const tiers = inputs.map(({ label, report }) => summarizeReportPair(label, report, baseline))
  const extraSummaries = extras.map(({ label, report }) => summarizeReportPair(label, report, baseline))
  const markdown = buildMarkdown({ tiers, extras: extraSummaries, baseline })
  return {
    schemaVersion: 1,
    baseline,
    challenger: CHALLENGER,
    tiers,
    extras: extraSummaries,
    markdown,
  }
}

function writeTextAtomically(target, text) {
  const dir = path.dirname(target)
  mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, `.${path.basename(target)}.tmp-${randomUUID()}`)
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, target)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* ignore */ }
    throw error
  }
}

function main(argv) {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: 'string', multiple: true },
      extra: { type: 'string', multiple: true },
      baseline: { type: 'string' },
      'out-md': { type: 'string' },
      'out-json': { type: 'string' },
      help: { type: 'boolean' },
    },
  })
  const v = parsed.values
  if (v.help) {
    console.log('Usage: ai-search-eval-compare.mjs --input <label>=<report.json> --out-md <report.md> [--extra <label>=<report.json>] [--out-json <summary.json>] [--baseline rn|web]')
    return 0
  }
  const baseDir = process.env.INIT_CWD ?? process.cwd()
  const baseline = v.baseline ?? 'rn'
  if (!BASELINES.has(baseline) || !Array.isArray(v.input) || !v.input.length || !v['out-md']) {
    console.error('ai-search-eval-compare: invalid arguments')
    return 2
  }
  const loadSpecs = (list = []) => list.map(raw => {
    const spec = parseNamedSpec(raw)
    if (!spec) throw new Error('Invalid --input/--extra specification')
    const abs = path.resolve(baseDir, spec.filePath)
    return { label: spec.label, report: JSON.parse(readFileSync(abs, 'utf8')) }
  })
  const inputs = loadSpecs(v.input)
  const extras = loadSpecs(v.extra || [])
  const result = compareEvaluations({ inputs, extras, baseline })

  const outMd = path.resolve(baseDir, v['out-md'])
  writeTextAtomically(outMd, result.markdown)
  console.log(`compare-md: ${outMd}`)
  if (v['out-json']) {
    const outJson = path.resolve(baseDir, v['out-json'])
    const { markdown: _md, ...jsonSummary } = result
    writeTextAtomically(outJson, `${JSON.stringify(jsonSummary, null, 2)}\n`)
    console.log(`compare-json: ${outJson}`)
  }
  return 0
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}
