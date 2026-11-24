# AI 动作检索 `v2` P50 延迟优化交接文档（`P50_LATENCY_HANDOFF`）

> 关联文档：[精排纠偏设计](DESIGN.md) · [结果与指标解读](RESULTS_SUMMARY.md) · [Iter1 对比报告](ITER1_COMPARISON.md) · [VLM Prompt 交接](VLM_PROMPT_HANDOFF.md) · [子系统路由](../../../../docs/subsystem/ai-agent/README.md)

## 1. 工作区与资产地图

| 位置 | 角色 / 分支 | 关键路径与说明 |
|---|---|---|
| `D:\dev\open-gym` | 主仓（样本与文档） | [test_pic/](../../../../test_pic/)（32 样本 `benchmark.json` + `manifest-*.json`）；[ai-search-v2-tuning/](.) 全部方案、Iter1 报告与本交接文档 |
| `D:\wt\og-retrieval` | `codex/server-retrieval`（当前已调优 `v2` 实现） | **核心优化文件**：`services/retrieval-model/main.py`（ROCm `bge-m3` + `bge-reranker-v2-m3`）、`api/src/agent/retrieval/retrieval.service.ts`、`api/src/agent/retrieval/catalogue.ts`、`api/src/agent/retrieval/ranking.ts`、`scripts/build-retrieval-index.mjs`、`scripts/windows/{Start,Stop}-Retrieval.ps1` |
| `D:\dev\.tools\opengym-retrieval` | 本机依赖与外置评测档案（不入库） | PG `127.0.0.1:55432`、ROCm BGE `127.0.0.1:8765`、`retrieval.env`；`eval-runs\v1-vs-v2\` 保存冻结 4 档 `*-replay.json`；`eval-runs\v1-vs-v2-iter1\` 保存 Iter1 精度与耗时基线 |

---

## 2. 当前 Iter1 延迟与精度基线（优化起点）

Iter1 通过缩减 `rerankQuery` 噪声，在未改模型与索引的情况下已将 P50 从 `2260–2572ms` 降至 **`1561–1827ms`**；下表精确拆解当前各阶段耗时与 RRF 召回分布（优化后必须守住精度红线）：

| 数据集 (样本) | 总延迟 P50 / P95 | 分阶段 P50 (`text` / `vector` / `fusion` / `rerank`) | `rerank` 占比 | `RRF@15 / @20 / @30` (正例) | Iter1 `Top-1` / `Top-5` / `Wrong-High` |
|---|---|---|---|---|---|
| `photo-only` (32) | `1620ms` / `1833ms` | `95ms` / `57ms` / `0ms` / **`1451ms`** | **89.6%** | `14` / `14` / `15` (`25`) | `36.0%` / `52.0%` / `4/32` |
| `simple` (32) | `1670ms` / `1902ms` | `121ms` / `57ms` / `0ms` / **`1498ms`** | **89.7%** | `21` / `22` / `23` (`25`) | `76.0%` / `88.0%` / `4/32` |
| `alias` (32) | `1674ms` / `1912ms` | `132ms` / `55ms` / `0ms` / **`1478ms`** | **88.3%** | **`25`** / **`25`** / `25` (`25`) | `88.0%` / `96.0%` / `2/32` |
| `detailed` (32) | `1827ms` / `2102ms` | `117ms` / `61ms` / `0ms` / **`1665ms`** | **91.1%** | `24` / **`25`** / `25` (`25`) | `84.0%` / `92.0%` / `0/32` |
| `repo13` 留出 (13) | `1561ms` / `1998ms` | `59ms` / `37ms` / `0ms` / **`1443ms`** | **92.4%** | **`11`** / **`11`** / `11` (`11`) | `90.9%` / `100.0%` / `0/13` |

> **核心瓶颈判断**：`bge-reranker-v2-m3` 单步占总耗时的 **88%–92%**（`1.44–1.67s`），原因有三：① `rerank_text` 仍塞入最多 `384` tokens 的长英文说明/步骤，且 `main.py` 按 batch 最长序列统一 padding；② `CrossEncoder` 在 ROCm 上默认跑 **FP32**；③ 每次把全部 `30` 条融合候选都送进 Cross-Encoder（而 `alias`/`detailed`/`repo13` 在 `RRF@20` 已达 `100%`）。

---

## 3. 按 ROI 排序的提速改造清单（单变量迭代，先测精度保底再叠加）

### P0.1 缩短 Cross-Encoder 文档输入长度（`rerank_text` `384 tokens` → `~80–120 tokens` 结构化卡片）
- **现状**：`catalogue.ts` L97 将 `English + Chinese + Aliases + Attributes + 2句英文步骤 + 2句中文步骤 + description` 拼成最大 `384` tokens 的 `rerankText`；实测冗余长描述不仅拖慢 Cross-Encoder（Transformer 自注意力二次方开销），还是造成 Sigmoid 饱和（`0.95–0.99`）的源头之一。
- **建议分两步做（先零索引重建验证，再正式落盘）**：
  1. **快验方案（不改 PG 索引，先验证精排收益与精度影响）**：在 `retrieval.service.ts` L119 构造 `docs` 时，直接用已在 `Hit` 行上的结构化字段拼紧凑卡片（例如 ``English: ${row.name_en}. Chinese: ${row.name_zh}.${aliases} Attributes: ${attrs}``），在冻结 replay 上跑一轮验证**精度是否无损甚至更好、延迟能降多少**。
  2. **正式落盘方案（确认正向后执行）**：修改 `D:\wt\og-retrieval\api\src\agent\retrieval\catalogue.ts` L39 `TEMPLATE_VERSION` 与 L97 `rerankText` 模板（只保留 `English + Chinese + Aliases + Attributes` 紧凑卡片），执行 `npm.cmd --prefix api run build` 后运行 `node --env-file=D:\dev\.tools\opengym-retrieval\retrieval.env scripts/build-retrieval-index.mjs --rebuild` 重建 PG 索引。
- **⚠️ 重要连锁检查**：缩短 `rerank_text` 后，Cross-Encoder 原始打分分布很可能从 `0.95–0.99` 下移/拉开；务必对照检查 [ranking.ts](file:///D:/wt/og-retrieval/api/src/agent/retrieval/ranking.ts#L93-L113) 中的 `scoreFloor (0.42)`、`highScoreFloor (0.85)`、`mediumScoreFloor (0.50)` 是否仍适配新分数分布，切忌只看速度不复查 `Wrong-High` 与 `Coverage`！

### P0.2 ROCm 模型服务开启 FP16 半精度推理与合理 `max_length`（`services/retrieval-model/main.py`）
- **现状**：`D:\wt\og-retrieval\services\retrieval-model\main.py` L47 与 L194–L202 在 ROCm 上全程跑 FP32，且 `max_length=512`。
- **改造点**：
  1. 在 `rerank` 的 `score()`（L194）内，当 `model.model.device.type == "cuda"` 时开启 `torch.autocast(device_type="cuda", dtype=torch.float16)`（配合现有的 `_finite()` 校验；若某次 FP16 出现非有限值自动回退 FP32 重算一次，并在 `/health` 暴露实际精度便于观测）；
  2. 若文档已缩短至紧凑卡片，同步将 `rerank` 分词器 `max_length` 从 `512` 下调至 `256`（或按参数动态截断）；
  3. 同步评估 `embeddings()`（L162，目前约 `55–61ms`）是否开启 `torch.autocast("cuda", dtype=torch.float16)`（需确认 `bge-m3` 向量与 PG 中 FP32 建的库余弦相似度偏移几乎为零，或干脆仅对 `rerank` 开 FP16）。
- **注意**：修改 `main.py` 后必须用 `Stop-Retrieval.ps1` + `Start-Retrieval.ps1` 重启 `127.0.0.1:8765` 模型服务才生效，且首次推理前做一次 warmup 请求再测 P50/P95。

### P1.1 收窄送精排候选池（`30` → `16` 或 `20`）并严格保持诊断契约
- **依据**：从 Iter1 实测看，`alias`/`detailed`/`repo13` 在 `RRF@20` 已全部达到 **`100%`**（`photo-only` 在 `RRF@20→30` 差 1 例、`simple` 差 1 例，且极低排名候选往往也进不了 `Top-5`）。
- **⚠️ 关键踩坑防线**：`D:\wt\og-retrieval\api\test\retrieval.service.test.js` L229 明确断言 **`retrieval_fusion.top.length === 30`**！因此：
  - `merged` 仍保留 `.slice(0, 30)` 供 `retrieval_fusion` 诊断事件输出；
  - 仅在送给 `modelClient.rerank` 时切片 `const rerankPool = merged.slice(0, 20)`（对比 `16` vs `20` 的耗时与 `Top-5` 损益），同步在 `ranking.ts` 检查 `rrfRank` 与 `r.index` 对齐关系不受切片影响。

### P1.2 查询并行重叠 + 批量 SQL 压低非精排阶段耗时（`150–190ms` → `~60–90ms`）
1. **并发重叠 `embedText` 与 `textRecall`（零风险省 ~40–55ms）**：
   - `retrieval.service.ts` 目前串行先 `await textRecall` 再 `await modelClient.embedText(vectorQuery)`；两者互不依赖，可在 `textRecall` 开始时同步发起 `embedText(vectorQuery, signal)`，等 `textRecall` 返回并释放当前事务后再执行 `vectorRecall`。
   - **⚠️ 单测契约**：因为 PG 连接 `pin.client` 同一时间只能跑一个事务，且 `retrieval.service.test.js` L116 硬性断言 **`BEGIN READ ONLY` 次数 === `4`**（pin + text + vector + release），**严禁拆成多个事务或并发共用同一 PG `client`**，只并行 HTTP `embedText` 与 PG `textRecall` 即可安全省下 ~45ms。
2. **可选批量 `textRecall`（省 ~60–90ms）**：
   - 当前 `textRecall` 对 `terms`（通常 4–10 个词）在循环里串行发 `for (const { term, weight } of terms) await client.query(...)`，导致 `textMs` 高达 `95–132ms`。
   - 可改用单条 `UNNEST($2::text[], ...)` 批量 SQL（保留原有空 `terms` 或单元测试 Mock `FROM retrieval_exercise_terms` 兼容性）。

---

## 4. 本机重启、单测与零 VLM 成本验收命令（PowerShell）

```powershell
# 1. 若修改了 services/retrieval-model/main.py，先重启本机 8765 模型服务（并确认 warmup）
Set-Location D:\wt\og-retrieval
.\scripts\windows\Stop-Retrieval.ps1 -RuntimeRoot D:\dev\.tools\opengym-retrieval
.\scripts\windows\Start-Retrieval.ps1 -RuntimeRoot D:\dev\.tools\opengym-retrieval -ModelsOnly
Invoke-RestMethod http://127.0.0.1:8765/health

# 2. 若修改了 api/src/agent/retrieval/，先编译；若改了 catalogue.ts 则随后重建 PG 索引
npm.cmd --prefix api run build
# (仅当修改 catalogue.ts 时执行)：
# node --env-file=D:\dev\.tools\opengym-retrieval\retrieval.env scripts/build-retrieval-index.mjs --rebuild

# 3. 运行全套编译、单测与评测 CLI 回归门禁
node --test api/test/retrieval.service.test.js api/test/exercise-search-diagnostics.test.js api/test/agent-exercise-search.test.js
node --test api/test/nest/agent-exercise-search.test.js
npm.cmd --prefix frontend run test:ai-search-eval

# 4. 用冻结 4 档 replay + repo13 零 VLM 成本复测 P50/P95 与精度（输出至 v1-vs-v2-p50）
$runDir = 'D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2'
$outDir = 'D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2-p50'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

foreach ($tier in @('photo-only', 'simple', 'alias', 'detailed')) {
  $m = Get-Content "D:\dev\open-gym\test_pic\manifest-$tier.json" -Raw -Encoding UTF8 | ConvertFrom-Json
  $replayAbs = "$runDir\$tier-replay.json"
  for ($i = 0; $i -lt $m.samples.Count; $i++) {
    $m.samples[$i] | Add-Member -NotePropertyName replay -NotePropertyValue @{ path = $replayAbs; index = $i } -Force
  }
  $tmpManifest = "$outDir\replay-manifest-$tier.json"
  [IO.File]::WriteAllText($tmpManifest, ($m | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
  node --env-file=D:\dev\.tools\opengym-retrieval\retrieval.env frontend/scripts/ai-search-eval.mjs `
    --mode replay `
    --manifest $tmpManifest `
    --benchmark D:\dev\open-gym\test_pic\benchmark.json `
    --include-server-v2 `
    --out "$outDir\$tier-report.json"
}

node frontend/scripts/ai-search-eval-compare.mjs `
  --input "photo-only=$outDir\photo-only-report.json" `
  --input "simple=$outDir\simple-report.json" `
  --input "alias=$outDir\alias-report.json" `
  --input "detailed=$outDir\detailed-report.json" `
  --baseline rn `
  --out-md "$outDir\P50_COMPARISON.md" `
  --out-json "$outDir\compare-summary.json"

node --env-file=D:\dev\.tools\opengym-retrieval\retrieval.env frontend/scripts/ai-search-eval.mjs `
  --mode replay `
  --manifest docs/ai-exercise-search/eval/manifest.json `
  --include-server-v2 `
  --out "$outDir\repo13-report.json"
```

### 下轮验收门槛（相对 Iter1 基线）
- **延迟目标**：四档及 `repo13` 的 `v2` **P50 `<= 800ms`**（理想 `<= 600ms`），**P95 `<= 1000ms`**（`rerankMs` P50 从 `~1.5s` 压至 `<= 500–700ms`）；
- **精度与安全零退化（不得用准确率换速度）**：
  - `photo-only >= 36%`、`simple >= 76%`（Top-5 `>= 88%`）、`alias >= 88%`（Top-5 `>= 96%`）、`detailed >= 84%`（Top-5 `>= 92%`）、`repo13 >= 90.9%`（Top-5 `100%`）；
  - `Wrong-High` 全档不高于 Iter1（`detailed` 与 `repo13` 保持 `0`）；`BadImage-High-FP` 保持 `0/6`；`multiValidCoverage` 与 `clarificationNoHigh` 无明显下跌；
- **单测契约**：保持 `v1` 未修改、上述全部自动化单测通过，且不破坏 `Start-Retrieval.ps1` / `Stop-Retrieval.ps1` 生命周期管理。
