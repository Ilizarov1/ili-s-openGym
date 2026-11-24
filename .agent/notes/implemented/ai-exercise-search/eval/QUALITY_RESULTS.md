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

命令（每次）：`node --env-file=D:/dev/open-gym/api/.env frontend/scripts/ai-search-eval.mjs --mode e2e --group photo-only --group hinted --manifest docs/ai-exercise-search/eval/manifest.json --include-queries --save-replay <replay> --out <report>`，3 次重复均退出 0（10 样本、0 错误）。5 张图 × 2 组共 10 个场景，每样本 1 次模型调用。

### 逐次指标（web 与 rn 数值一致，除标注外）

| 指标 | rep1 | rep2 | rep3 |
|---|---|---|---|
| Top 1 | 1/10 | 1/10 | 1/10 |
| Top 5 | 5/10 | 6/10 | 6/10 |
| recall@5 | 9/10 | 8/10 | 9/10 |
| 错器械 | 2/10（rn 同） | 4/10（rn 2/10） | 3/10（rn 同） |
| 兜底 only | 0/10 | 0/10 | 0/10 |
| 匹配 P50/P95 (ms) | 43/124（rn 40/93） | 41/225（rn 36/196） | 44/153（rn 40/162） |

分组（合并 3 次）：hinted top1 合计 2/15，photo-only top1 合计 2/15；photo-only top5 合计 9/15（rep1 4、rep2 6、rep3 9，按端合计）。

### 推胸族逐次（两端一致）

| 样本 | rep | expectedRanks（关键查询） | 最终 ID | Top 1 |
|---|---|---|---|---|
| hinted-chest-press | 1 | `lever chest press` 2,3 | `1299, 2144, 1301`（rn 尾序不同） | **1299** |
| hinted-chest-press | 2 | 同查询 2,3 | `1299, 1301, 1625, 10672` | **1299** |
| hinted-chest-press | 3 | 全 null | `1299, 2144, 1030, 1221` | **1299** |
| photo-chest-press | 1 | 某查询 2,3 | `1301, 1030` | 1301（非目标） |
| photo-chest-press | 2 | 全 null | `1030, 2664, 2659` | 1030（非目标） |
| photo-chest-press | 3 | 某查询 1,2 | `5527, 0576, 1030` | 5527（非目标） |

三次运行中 `1299` 均在 hinted 推胸首位——文档描述的低置信上斜变体登顶问题在真实 A 组完全复现；`0576/0577` 三次都未进入最终榜（rep3 甚至缺席原始召回一次）。

### 原始回放候选字段填充率（P1 对照基线）

| 次数 | high+medium 候选数 | 候选级 equipment | 候选级 bodyPart | 推胸族无证据变体候选 |
|---|---|---|---|---|
| rep1 | 25 | **0/25** | **0/25** | 2 |
| rep2 | 22 | **0/22** | **0/22** | 3 |
| rep3 | 19 | **0/19** | **0/19** | 1 |

模型在现行提示词下从不填候选级器械/部位字段，推胸样本反复混入无证据的上斜/单臂变体——正是 P1 第 5、6 条的靶点。



## P1 提示词对照（prompt-b-1/2/3）

改动：仅 `api/agent-runtime/tasks/exercise-search.js` 的 `PROMPT` 第 5、6 条与 `## Names`（+19/-5），schema、清洗逻辑与 matcher 均未动。命令与 A 组相同（输出前缀 `prompt-b-`），3 次均退出 0、10 样本 0 错误，模型调用数不变（每样本 1 次）。

### 逐对指标（web；rn 同趋势）

| 指标 | A1→B1 | A2→B2 | A3→B3 |
|---|---|---|---|
| Top 1 | 1/10 → 4/10 | 1/10 → 5/10 | 1/10 → 5/10 |
| Top 5 | 5/10 → **8/10** | 6/10 → **7/10** | 6/10 → **8/10** |
| recall@5 | 9/10 → 9/10 | 8/10 → 8/10 | 9/10 → 9/10 |
| 错器械 | 2/10 → 1/10 | 4/10 → **0/10** | 3/10 → 1/10 |

hinted Top 5：3→**5**、3→**4**、2→**5**（三对全升）；photo-only Top 5：2→3、3→3、4→3（合计 9/15 持平，A3 为离群好运轮）；photo-only recall@5 合计 12/15 持平。rn 端同判定。

### 推胸族（hinted-chest-press）

| rep | A（Top1 / 目标在最终榜） | B（Top1 / 目标在最终榜） |
|---|---|---|
| 1 | 1299 / 否 | **0576 / 是（唯一结果）** |
| 2 | 1299 / 否 | 1299 / 否（该轮模型只回 2 候选且含 `lever incline chest press` low 变体） |
| 3 | 1299 / 否 | **0576 / 是（唯一结果）** |

photo-chest-press：B1 `[1301, 0603]`（目标在原始 2/3 未入榜）、B2 **`[0576, 1030]` 目标 Top1**、B3 `[0088]`（该轮模型把模糊屏拍误读为其他器械，错器械）。

### 填充率与无证据变体

| rep | A：strong eq/bp 填充 | B：strong eq/bp 填充 | A：推胸无证据变体 | B：推胸无证据变体 |
|---|---|---|---|---|
| 1 | 0/25、0/25 | **14/14、14/14** | 2 | 0 |
| 2 | 0/22、0/22 | **15/15、15/15** | 3 | 1 |
| 3 | 0/19、0/19 | **13/13、13/13** | 1 | 0 |

人工核对原图与用户提示：B 组填入的器械/部位（leverage machine、sled machine、chest、upper legs 等）与 5 张图的可见器械及提示文本一致，非编造；候选数从 4-5 条收敛到 1-3 条，删掉的正是无证据的上斜/单臂变体。

### 判定：**保留 P1**

两端整体 Top 5 三对全升；hinted 组 Top 5 三对全升（满足「至少一组提升且 ≥2/3 对」）；photo-only 合计持平不降；错器械率下降；推胸 Top1 从三次 `1299` 变为两次目标 `0576`。已知波动：photo-only rep3 单对 Top 5 4→3、hinted rep2 recall@5 5→4，属单对随机波动（其 A3 为全部 A 轮中最好的一轮），聚合层面无退化。失败实验不适用。



## M1 首名截断对照（m1-replay）

（待执行）

## M2 跨查询排序对照（m2-replay）

（待执行）

## Q1 查询扩展实验

（待判定是否触发）

## 最终验证（final-replay / final-e2e）

（待执行）
