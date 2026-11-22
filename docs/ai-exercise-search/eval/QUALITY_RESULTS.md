# AI 器械检索效果优化对照记录

本文件是 [QUALITY_EXECUTION.md](QUALITY_EXECUTION.md) 的对照数据记录。所有报告位于本工作树 `.codex/ai-search-eval/quality/`（本地忽略目录，不入库）。密钥只存在于主工作区 `api/.env`，从不写入报告或本文件。

## 执行环境

- 基线 commit：`cef3bafb398c302ef12113616a003fe7386263cf`，目录哈希（`frontend/src/lib/exercises-data.js` SHA256 前 12 位）：`99add164cbdd`
- 平台：Web 与 RN（共享匹配器，经 Vite SSR 分别加载 Web/RN 检索池）
- API provider：`compatible`，Base URL `https://api.deepseek.com`，模型 `deepseek-flash`（OpenAI 兼容端点；密钥经 `OPEN_GYM_EVAL_API_KEY` 注入，不记录）
- 运行方式：真实 e2e 每轮含 `photo-only` + `hinted` 共 10 样本（5 图 × 2 组），每样本 1 次模型调用；每阶段 3 次重复
- 评估 CLI：`frontend/scripts/ai-search-eval.mjs`，回放 manifest：`docs/ai-exercise-search/eval/manifest.json`（含新增 `quality-regression` 组）

## T0/T1 离线回放基线

命令：`node frontend/scripts/ai-search-eval.mjs --mode replay --manifest docs/ai-exercise-search/eval/manifest.json --include-queries --out .codex/ai-search-eval/quality/baseline-replay.json`（退出码 0，13 样本，跳过 5 个无回放的纯图样本）

说明：文档预期的「目标原始第 2/3、匹配器只取第 1、1299 最终首位」来自缺失的 `my-model-chest-replay.json`（主工作区 `.codex/ai-search-eval/` 为空）。按文档「按实际基线重新定位」，实际基线以 `evidence/smoke-go-2026-11-21.json` 与当前匹配器为准：`lever chest press` 查询可召回目标到原始第 1/2 并进入最终榜，但最终 Top 1 被 3-4 词查询的高关键词分变体占据；纯图样本的 Top 1 是肩推族 `0405`（错器械）。

### 总体（按平台）

| 指标 | Web | RN |
|---|---|---|
| matched / errors | 13 / 0 | 13 / 0 |
| Top 1 | 2/11 | 2/11 |
| Top 5 | 6/11 | 6/11 |
| recall@5 | 9/11 | 9/11 |
| 错器械（有首名样本） | 2/9 | 2/9 |
| 空结果误报 | 0/2 | 0/2 |
| 兜底 only | 4/13 | 4/13 |
| 匹配延迟 P50/P95 (ms) | 41 / 150 | 37 / 158 |

### 分组

| 组 | 端 | Top 1 | Top 5 | recall@5 | 错器械 | 误报 | 兜底 | P50/P95 (ms) |
|---|---|---|---|---|---|---|---|---|
| hinted | web | 1/5 | 3/5 | 5/5 | 1/5 | — | 0/5 | 113/150 |
| hinted | rn | 1/5 | 3/5 | 5/5 | 1/5 | — | 0/5 | 109/158 |
| edge | web | 1/3 | 1/3 | 2/3 | 0/1 | 0/2 | 4/5 | 17/36 |
| edge | rn | 1/3 | 1/3 | 2/3 | 0/1 | 0/2 | 4/5 | 17/30 |
| quality-regression | web | 0/3 | 2/3 | 2/3 | 1/3 | — | 0/3 | 42/76 |
| quality-regression | rn | 0/3 | 2/3 | 2/3 | 1/3 | — | 0/3 | 37/67 |

### 推胸族逐样本（基线）

| 样本 | 端 | 关键查询原始名次（expectedRanks） | 最终 ID | Top 1 是否 1299 | wrongEquipment |
|---|---|---|---|---|---|
| hinted-chest-press | web | `lever chest press` 1,2；`seated chest press` 目标缺席 | `10672, 0576, 2144, 1299` | 否（首名 10672） | false |
| hinted-chest-press | rn | 同上 | `10672, 0576, 1299, 2144` | 否（首名 10672） | false |
| quality-hinted-chest | web | 同 hinted-chest-press | `10672, 0576, 2144, 1299` | 否（首名 10672） | false |
| quality-hinted-chest | rn | 同上 | `10672, 0576, 1299, 2144` | 否（首名 10672） | false |
| quality-photo-chest | web | `chest press` 1,2 | `0405, 1030, 0576, 1451` | 否（首名 0405，肩推族） | true |
| quality-photo-chest | rn | 同上 | `0405, 1030, 0576, 1451` | 否（首名 0405，肩推族） | true |
| quality-no-recall-chest | web | 全部查询 null（零召回确认） | `6355` | 否 | false |
| quality-no-recall-chest | rn | 同上 | `6355` | 否 | false |
| edge-exact-chest-press | web | `lever chest press` 1,2 | `0576` | 否 | false |
| edge-french-chest-press | web | `presse à pectoraux assise` 无命中 | `[]` | 否 | null |

基线已知缺口：`edge-french-chest-press`（法语名零命中）、`quality-no-recall-chest`（零召回，M1/M2 均无法救）、`quality-*` 的 Top 1 全部失败。

## T1 真实 A 组基线（prompt-a-1/2/3）

（待 3 次运行完成后填写）

## P1 提示词对照（prompt-b-1/2/3）

（待执行）

## M1 首名截断对照（m1-replay）

（待执行）

## M2 跨查询排序对照（m2-replay）

（待执行）

## Q1 查询扩展实验

（待判定是否触发）

## 最终验证（final-replay / final-e2e）

（待执行）
