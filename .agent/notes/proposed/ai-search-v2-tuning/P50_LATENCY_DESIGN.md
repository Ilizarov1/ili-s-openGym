# AI 动作检索 `v2` P50 延迟优化设计（`p50-latency-v2`）

> 所属子系统：`ai-agent` · 交接基线：[P50_LATENCY_HANDOFF.md](P50_LATENCY_HANDOFF.md) · 执行计划：[P50_LATENCY_EXECUTION.md](P50_LATENCY_EXECUTION.md) · 精排纠偏设计：[DESIGN.md](DESIGN.md) · Iter1 报告：[ITER1_COMPARISON.md](ITER1_COMPARISON.md) · Prompt 优化报告：[VLM_PROMPT_COMPARISON.md](VLM_PROMPT_COMPARISON.md) · 子系统路由：[ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md)

## 1. 背景、性能基线与瓶颈实测画像

在 Iter1（[DESIGN.md](DESIGN.md) / [ITER1_COMPARISON.md](ITER1_COMPARISON.md)）与上游 VLM Prompt 优化（[VLM_PROMPT_COMPARISON.md](VLM_PROMPT_COMPARISON.md)）之后，服务端混合检索 `v2` 的精度与安全防线已经建立，但端到端检索（扣除上游 VLM 调用）P50 仍停留在 **`1561–1872ms`**（P95 **`1833–2215ms`**），远高于互动检索的目标水位（**P50 `<= 800ms`、理想 `<= 600ms`，P95 `<= 1000ms`**）。

### 1.1 冻结基线与精度红线

1. **主基线（Iter1 `v1-vs-v2` 冻结 replay + `repo13` 留出集，来自 [P50_LATENCY_HANDOFF.md](P50_LATENCY_HANDOFF.md) §2）**：
   - `photo-only` (32)：P50 `1620ms` / P95 `1833ms`（`text 95ms / vec 57ms / fuse 0ms / rerank 1451ms`，`rerank` 占 **89.6%**）；`RRF@15/20/30 = 14/14/15 (25)`；Top-1 `36.0%`、Top-5 `52.0%`、`Wrong-High 4/32`。
   - `simple` (32)：P50 `1670ms` / P95 `1902ms`（`text 121ms / vec 57ms / fuse 0ms / rerank 1498ms`，`rerank` 占 **89.7%**）；`RRF@15/20/30 = 21/22/23 (25)`；Top-1 `76.0%`、Top-5 `88.0%`、`Wrong-High 4/32`。
   - `alias` (32)：P50 `1674ms` / P95 `1912ms`（`text 132ms / vec 55ms / fuse 0ms / rerank 1478ms`，`rerank` 占 **88.3%**）；`RRF@15/20/30 = 25/25/25 (25)`；Top-1 `88.0%`、Top-5 `96.0%`、`Wrong-High 2/32`。
   - `detailed` (32)：P50 `1827ms` / P95 `2102ms`（`text 117ms / vec 61ms / fuse 0ms / rerank 1665ms`，`rerank` 占 **91.1%**）；`RRF@15/20/30 = 24/25/25 (25)`；Top-1 `84.0%`、Top-5 `92.0%`、`Wrong-High 0/32`。
   - `repo13` (13)：P50 `1561ms` / P95 `1998ms`（`text 59ms / vec 37ms / fuse 0ms / rerank 1443ms`，`rerank` 占 **92.4%**）；`RRF@15/20/30 = 11/11/11 (11)`；Top-1 `90.9%`、Top-5 `100.0%`、`Wrong-High 0/13`。
2. **二次回归校验基线（`vlm-prompt-v2` 冻结 replay，来自 [VLM_PROMPT_COMPARISON.md](VLM_PROMPT_COMPARISON.md) §1.1）**：
   - 现行生产 VLM 输出下 `v2`：`photo-only` Top-1 `60.0%` / Top-5 `72.0%`、`simple` Top-1 `76.0%` / Top-5 `96.0%`、`alias` Top-1 `92.0%` / Top-5 `96.0%`、`detailed` Top-1 `92.0%` / Top-5 `96.0%`；优化后同样不得出现精度或安全退化。

### 1.2 本机硬件与数据库实测诊断

在动手改造前，对 `D:\wt\og-retrieval` 与本机依赖（`D:\dev\.tools\opengym-retrieval`）执行现场测量，确认四项具体瓶颈源：

1. **ROCm Cross-Encoder 默认 FP32 + 无 Warmup + `max_length=512`**：
   - 本机 GPU 为 **`AMD Radeon RX 9070 XT`**（`torch 2.9.1+rocm7.2.1`、`hip: 7.2.53211-158bd99533`、`cuda: True`、`bf16: True`）。
   - [main.py](file:///D:/wt/og-retrieval/services/retrieval-model/main.py#L47) 以默认 FP32 加载 `BAAI/bge-reranker-v2-m3` 并固定 `max_length=512`；[score()](file:///D:/wt/og-retrieval/services/retrieval-model/main.py#L194-L202) 未使用 `torch.autocast`，且启动后无预热推理。
2. **`rerank_text` 过长引发二次方 Transformer 注意力开销与 Sigmoid 饱和**：
   - PG `retrieval_exercise_docs` 共 **`5,632`** 条现役记录，当前 `rerank_text` 平均 **`367` 字符**、最长 **`617` 字符**（`catalogue.ts` L97 拼入中英文动作步骤与长说明，上限 `384` tokens）。
   - 同批实测：若精简为仅含结构化字段的紧凑卡片（`English + Chinese + Aliases + Attributes`），平均仅 **`104` 字符**（缩短约 **3.5 倍**），且能顺带缓解长文本导致的 `0.95–0.99` Sigmoid 饱和。
3. **精排候选数冗余（`30` 条全送精排）**：
   - `alias` / `detailed` / `repo13` 在 `RRF@20` 已达到 `100%` 召回；每次仍把全部 `30` 条送入 `CrossEncoder`，直接决定 batch padding 与计算量。
4. **串行 `textRecall` 循环查询与串行 `embedText` HTTP**：
   - [retrieval.service.ts](file:///D:/wt/og-retrieval/api/src/agent/retrieval/retrieval.service.ts#L85-L100) 串行先执行 `textRecall` 再发起 `modelClient.embedText(vectorQuery)`，白白浪费 `~45–55ms` 的网络/模型重叠窗口。
   - [textRecall()](file:///D:/wt/og-retrieval/api/src/agent/retrieval/retrieval.service.ts#L207-L224) 在 `for (const { term, weight } of terms)` 中逐词下发 SQL。PG 实测单条英文查询（`EXPLAIN ANALYZE`）耗 **`29.86ms`**，其中对 `retrieval_exercise_terms` 执行 `Seq Scan` 过滤 `23,317` 行占 `27.70ms`；一次检索常见 4–10 个词，串行循环放大到 **`95–132ms`**。

### 1.3 本轮范围边界（Out of Scope）

- **不修改 `v1` 本地匹配器**：`frontend/src/lib/exercise-ai-search.js` 保持零改动。
- **不修改上游 VLM Prompt 与接口 Schema**：`api/agent-runtime/tasks/exercise-search.js`、`api/src/agent/tasks/exercise-search-v2.ts` 及 `api/openapi.yaml` 保持零改动。
- **不改变向量索引字段 `embed_text` 语义**：`catalogue.ts` 中 `embedText` 模板保持不变（避免破坏向量检索召回特质；若重刷索引是因为 `rerankText` 变更导致 `catalogueHash` 升级，向量语义仍与原库同源）。
- **不破坏本机进程生命周期脚本**：`scripts/windows/Start-Retrieval.ps1` 与 `Stop-Retrieval.ps1` 保持兼容，`/health` 现有必需字段名与结构只增不删。

---

## 2. 分层优化架构（单变量验证后叠加）

### 2.1 P0.2：ROCm 模型服务半精度、动态截断与启动预热（`services/retrieval-model/main.py`）

1. **可配置半精度推理与自动 FP32 回退**：
   - 新增环境变量 `RETRIEVAL_RERANK_DTYPE`（允许值 `fp16` / `bf16` / `fp32`；在 CUDA/ROCm 上默认 **`fp16`**，CPU 上强制 `fp32`）。在 RX 9070 XT 上由执行阶段分别实测 `fp16` 与 `bf16` 的速度与精度表现，择优锁定默认值。
   - 在 `rerank()` 的 `score()` 中，当 `model.model.device.type == "cuda"` 且启用半精度时，使用 `torch.autocast(device_type="cuda", dtype=dtype)` 包裹 `model.model(**encoded, return_dict=True).logits`。
   - **Per-batch 非有限值兜底**：复用 `_finite()` 校验每个 batch 的 `scores`；若半精度下出现 `NaN`/`Inf`（`ValueError` 或 `FloatingPointError`），仅对该 batch 自动回退至无 `autocast` 的 FP32 重算一次，并累加 `state["rerank_fp32_fallbacks"]`，确保线上永不因溢出返回 503。
2. **合理 `max_length` 与对齐填充**：
   - 新增 `RETRIEVAL_RERANK_MAX_LENGTH`（默认 **`256`**，夹在 `64..512`），同步替换 `_load_models()` 中 `CrossEncoder(..., max_length=...)` 与 `score()` 的 `tokenizer(..., max_length=RERANK_MAX_LENGTH, pad_to_multiple_of=8)`（8 对齐以利于 ROCm/WMMA 矩阵内核），并在配置未超 `256` 时覆盖短卡片与紧凑 query 全部语义。
3. **`embedding` 模型保持 FP32 默认值**：
   - `bge-m3` 单次 `embedText` 仅 `~55ms` 且可与 `textRecall` 完全并行掩盖，**保持 `RETRIEVAL_EMBEDDING_DTYPE` 默认 `fp32`**，从根源消除查询向量与已入库向量之间的半精度漂移风险（支持环境变量切换供单变量验证）。
4. **启动期 Warmup 与可观测 `/health`**：
   - 在 `_load_models()` 末尾（`/` `/health` 报告 `ready` 之前）对已启用的 `embedding` 与 `reranker` 各执行 1 次轻量预热推理（包裹 `try/except`，记录状态字段而不阻断启动）。
   - `/health` 保持 `status`、`device`、`models.embedding.{name,enabled,ready,device}`、`models.rerank.{name,enabled,ready,device}` 完全兼容 `Start-Retrieval.ps1` L85，仅**增量追加** `models.embedding.dtype`、`models.rerank.dtype`、`models.rerank.max_length`、`models.rerank.warmup_ok`、`models.rerank.fp32_fallbacks`。

### 2.2 P0.1：紧凑 `rerank_text` 卡片与打分分布核查（Stage A 已验证并按闸门放弃 Stage B）

> **执行收敛结论**：Stage A 单变量实验（`exp2-compact`）实测表明：在 P0.2 已将 `rerankMs` 压至 `75–89ms` 后，删去步骤与描述仅再省 `~30ms`（`46–59ms`），却因丢失仅存在于步骤/描述中的机械语义（如 `1350 lever seated row` 的 `"with chest support"`）导致 `alias` `Top-1` 由 `88%` 跌至 `84%`、`Top-5` 由 `96%` 跌至 `92%`、`Wrong-High` 由 `2/32` 升至 `3/32`（`machine_014`、`machine_024`、`machine_017`）。因此按原设计安全闸门**放弃 Stage B**：保留 `catalogue.ts` `TEMPLATE_VERSION = 'exercise-search-retrieval-docs-v2'` 与 `ranking.ts` 零改动，无需重建 PG 索引。

1. **原定两阶段设计及 Stage A 判定准则**：
   - **Stage A（实验 2，不改 PG 索引）**：在 `retrieval.service.ts` 构造 `docs` 时临时拼装 `English + Chinese + Aliases + Attributes` 紧凑卡片（缺结构化字段时回退 `row.rerank_text`），验证延迟降幅、精度/安全与分数分布；
   - **Stage B 闸门（未触发）**：仅当 Stage A 证实零退化时才修改 `catalogue.ts` 至 `v3` 并重建 PG 索引；因 Stage A 触发语义丢失退化，**保持 `retrieval.service.ts` 直接读取 `row.rerank_text`**。

### 2.3 P1.1：收窄送精排候选池（`config.ts` + `retrieval.service.ts`，A/B 锁定默认 `30`）

1. **配置与兼容性**：
   - 在 [RetrievalConfig](file:///D:/wt/og-retrieval/api/src/agent/retrieval/config.ts#L5-L23) 新增可选字段 `rerankTopK?: number`，由 `retrievalConfig()` 从 `EXERCISE_SEARCH_RERANK_TOP_K` 读取（仅接受 `10..30` 的整数，否则抛出校验异常；业务代码以 `this.config.rerankTopK ?? 30` 兜底，兼容不传该字段的旧单测字面量配置）。
2. **诊断契约隔离与 A/B 默认值锁定**：
   - `merged` 保持 `fuseRrf(textHits, vectorHits).slice(0, 30)` 并在 `retrieval_fusion` 诊断事件继续上报 `topOf(merged, 'rrf', 30)`（满足 `retrieval.service.test.js` 对 `retrieval_fusion.top.length === 30` 的断言）。
   - 调用精排前切片 `const rerankPool = merged.slice(0, rerankTopK)` 并传给 `scoreAndRankCandidates`。
   - **A/B 实测裁决**：对比 `rerankTopK = 16 / 20 / 30` 后发现，`16` 与 `20` 均会在 `alias machine_024` 上裁掉位于融合排名 21–30 位的标准动作 `0770`（导致 `alias` `Top-1` `22/25 → 21/25`、`Top-5` `24/25 → 23/25`），而 `30` 仅多耗 `~25ms`（全栈 P50 仍仅 `119–156ms`）且精度零损益。因此锁定 `rerankTopK` 默认值为 **`30`**，同时保留 `10..30` 可配置开关。

### 2.4 P1.2：并发重叠与单次 `LATERAL` `UNNEST` 批量 `textRecall`（`retrieval.service.ts`）

1. **P1.2a 重叠 `embedText` 与 `textRecall`**：
   - 在 `retrieve()` 进入阶段一前（`!fixture` 时）构建 `vectorQuery` 并启动 `embedController = new AbortController()`（同步转发外部 `signal` 的 abort），立即调用 `this.modelClient!.embedText(vectorQuery, embedController.signal)`；同时挂载 `embedPromise.catch(() => undefined)` 防止 `textRecall` 提前抛错时触发 Node 未捕获 Rejection 警告。
   - 继续在 `pin.client` 上串行跑完 `textRecall` 事务；若 `textRecall` 或 `vectorRecall` 失败，立即 `embedController.abort()`，并在 `finally` 中兜底 abort 未完成请求与移除外层 `signal` 监听器。
   - 等 `textRecall` 完成并释放事务后，再 `await embedPromise` 并执行 `vectorRecall` 事务；`retrieval_vector.elapsedMs` 仅记录等待向量就绪 + PG 向量检索的增量耗时（`9–17ms`），维持 `BEGIN READ ONLY === 4` 契约不变。
2. **P1.2b 单次 `UNNEST + CROSS JOIN LATERAL` 批量 `textRecall`**：
   - PG `EXPLAIN (ANALYZE, BUFFERS)` 实测表明，朴素 `WITH q AS (UNNEST(...)) JOIN t ON (... OR ...)` 会导致 PG 放弃 `retrieval_terms_*` 索引而回退 `Seq Scan + Nested Loop`（6 词 `153ms`，反慢于旧循环 `151ms`）。
   - 改写为 `WITH q AS MATERIALIZED (...)` + `CROSS JOIN LATERAL`（精确 / `pg_trgm %` / `english_vector` 三路走各自索引 `UNION`）+ 外部单次 `short_cjk` `ILIKE` 扫描后 `GROUP BY` 再主键回表 `retrieval_exercise_docs`，实测 6 词耗时降至 **`43ms`**（纯英文 3 词 `24ms`），与原循环返回 75 条结果 100% 一致，并保留 `FROM retrieval_exercise_terms`、`d.aliases` 与 `BEGIN READ ONLY === 4`。

---

## 3. 语义级变更声明（Semantic Change Declaration）

### 子系统：`ai-agent`

- **涉及模块与真实入口**：
  - 入口路径 / 命令：
    - 服务端在线检索：`D:\wt\og-retrieval\api\src\agent\agent.service.ts` → `this.retrieval.retrieve(...)`（服务 `exercise-search.v2` API 请求）；
    - 本机模型推理服务：`http://127.0.0.1:8765/v1/embeddings` 与 `/v1/rerank`（由 `D:\wt\og-retrieval\scripts\windows\Start-Retrieval.ps1` 启动 `services/retrieval-model/main.py`）；
    - 索引构建 CLI：`D:\wt\og-retrieval\scripts\build-retrieval-index.mjs --rebuild` → `api/src/agent/retrieval/index-builder.ts`；
    - 零 VLM 成本评测 CLI：`D:\wt\og-retrieval\frontend\scripts\ai-search-eval.mjs --mode replay --include-server-v2`。
  - 实际改动源码：
    - `D:\wt\og-retrieval\services\retrieval-model\main.py`（及新增单测 `services/retrieval-model/test_main.py`）
    - `D:\wt\og-retrieval\api\src\agent\retrieval\config.ts`
    - `D:\wt\og-retrieval\api\src\agent\retrieval\retrieval.service.ts`
    - `D:\wt\og-retrieval\api\test\retrieval.service.test.js`（及 `api/dist/` 构建产物）
    - 未改动（Stage A 拦截后保持原状）：`catalogue.ts`、`ranking.ts`、PG 索引表数据
- **触发条件（Trigger）**：
  - 任何经由 `exercise-search.v2` 发起的服务端动作检索请求、`ai-search-eval.mjs --include-server-v2` 评测任务，或启停 `8765` 模型服务时触发。
- **改前 / 改后行为（Before / After）**：
  - **Before**：`bge-reranker-v2-m3` 在 ROCm 上以 FP32、`max_length=512` 且无预热方式运行，对 30 条动作文档执行精排，单步耗时 `1443–1665ms`；且 `textRecall` 逐词串行查库后再串行请求 `embedText`，导致总检索 P50 为 `1561–1872ms`（P95 `1833–2215ms`）。
  - **After**：模型服务启动时完成轻预热并以 `fp16` `autocast` + `max_length=256` + 8 对齐填充 + 逐 batch FP32 回退推理 Cross-Encoder；保留完整 `rerank_text` 与 `rerankTopK=30` 默认值（支持 `10..30` 配置）以守住零精度损失；`embedText` 与 `UNNEST + LATERAL` 批量 `textRecall` 并行重叠执行。端到端检索 **P50 实测降至 `119–158ms`、P95 `160–252ms`**，精度、校准与拒识安全 100% 持平。
- **接口 / 状态 / 兼容性变化（Contract, State & Compatibility）**：
  - **接口契约**：`EXERCISE_SEARCH_V2_OUTPUT_SCHEMA`、`api/openapi.yaml`、`retrieval_fusion`（`top.length <= 30`）与 `rerank` 诊断事件契约零破坏性修改；`/health` 原有字段完全兼容 `Start-Retrieval.ps1`，仅新增可观测元数据。
  - **状态与持久化**：因 Stage A 验证拦截后放弃 Stage B，`catalogue.ts` `TEMPLATE_VERSION` 保持 `'exercise-search-retrieval-docs-v2'` 不变，既有 PG `ready` 索引无缝复用。
  - **兼容性与迁移**：`RetrievalConfig.rerankTopK` 为可选字段（默认 `30`），兼容未传该字段的旧单测配置对象；`v1` 客户端与 RN 直连模式完全不受影响。
- **失败模式与降级兜底（Failure Modes & Fallback）**：
  - **ROCm 半精度数值异常**：逐 batch 校验 `torch.isfinite(logits)` 与 `_finite(scores)`，检测到 `NaN`/`Inf` 时自动对当前 batch 回退至无 `autocast` 的 FP32 重算并计数（`rerank_fp32_fallbacks`），不向调用方吐出错误；
  - **并行 `embedText` 与 `textRecall` 异常传播**：`textRecall` 失败或被取消时立即中止后台 `embedText` 请求并清理监听，避免悬挂异步任务或 `UnhandledPromiseRejection`；PG 事务仍严格单连接串行执行；
  - **进程与端口冲突**：仍完全复用 `Stop-Retrieval.ps1` + `Start-Retrieval.ps1 -ModelsOnly`（注：Windows PowerShell 5.1 冷启动 PG 时 `Start-Retrieval.ps1:53` 受 PS 5.1 `Start-Process -PassThru` `ExitCode` 为 `$null` 限制，需通过 `pwsh` 调用）。
- **实测证据（Empirical Evidence）**：
  - **改前基线**：Iter1 冻结 replay（`1561–1827ms` P50 / `1833–2102ms` P95）、`vlm-prompt-v2` 冻结 replay（`1663–1872ms` P50 / `1857–2215ms` P95）、RX 9070 XT ROCm 能力探测与 PG `5,632` 行统计 / `EXPLAIN ANALYZE`（`29.86ms` 单次扫描）。
  - **改后闭环实测证据**（已回填于 [P50_LATENCY_EXECUTION.md](P50_LATENCY_EXECUTION.md) 与 [P50_LATENCY_COMPARISON.md](P50_LATENCY_COMPARISON.md)）：单变量消融数据（Exp1 `fp16` vs `bf16`、Exp2 紧凑卡片拦截记录、Exp3 `rerankTopK` `20/16/30` 对比）、PG `EXPLAIN (ANALYZE, BUFFERS)`（`151ms → 43ms`）、85/85 自动化单测与最终 `v1-vs-v2`（P50 `119–156ms`）、`repo13`（P50 `119ms`）及 `vlm-prompt-v2`（P50 `146–158ms`）全量回放报告。
