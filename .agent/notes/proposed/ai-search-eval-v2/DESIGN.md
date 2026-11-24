# AI 动作检索评测系统重构与 `v1` vs `v2` 前后对比设计（`ai-search-eval-v2`）

> 所属子系统：`ai-agent` · 对应待对比服务端改造分支：`D:\wt\og-retrieval`（`codex/server-retrieval`）· 执行文档：[EXECUTION.md](EXECUTION.md)

## 1. 背景与核心难题

`codex/server-retrieval`（`D:\wt\og-retrieval`）将动作检索的召回、融合与精排从客户端本地匹配器（`exercise-search.v1`，Web/RN 最多展示 5 项）迁移至 NestJS 服务端多路检索管线（`exercise-search.v2`：PostgreSQL 文本/三元组/`tsvector` Top-75 + `pgvector` HNSW 余弦 Top-75 → RRF `k=60` 融合 Top-30 → `BAAI/bge-reranker-v2-m3` Cross-Encoder 精排 Top-10）。

要对修改前（`v1`）与修改后（`v2`）做**严谨、可归因、不被噪声欺骗**的前后对比，必须解决三类评测结构差异与当前代码的真实观测落差：

1. **修改前拿不到部分新指标**：`v1` 没有向量路、RRF 融合和 Cross-Encoder 连续精排分数，也没有第 6–10 名展示位；`v2` 没有客户端 `recallAt5`、`body_part_conflict` 过滤日志与本地 BM25 回退标记。强行对非对偶指标求差会产生伪结论。
2. **展示截断不对称**：`v2` 返回最多 10 项而 `v1` 最多 5 项，若直接用全量 `finalIds` 算 `Top-5` 会导致 `v2` 占尽“多给 5 条”的统计便宜。
3. **当前分支存在观测与接入落差**：
   - `D:\wt\og-retrieval\api\src\agent\retrieval\retrieval.service.ts` L276 `topOf(rows)` 硬编码 `rows.slice(0, 5)`，尽管诊断白名单 `exercise-search-diagnostics.js` 已放宽到 `75`/`75`/`30`/`30`，导致 `Recall@75` 与 `RRF Recall@30` 漏斗数据无法采集；
   - `frontend/scripts/ai-search-eval.mjs` 尚未接入 `RetrievalService` / `exercise-search.v2`，且未消费 `test_pic/benchmark.json` 中的 `ground_truth_id`、二合一特征、预期轨迹等元信息。

---

## 2. 评测原则与对比纯净性

1. **配对控制变量（Paired Single-VLM Evaluation）**：每个样本（图片 + 指定提示词档位）**仅调用 1 次 VLM**，将同一份通过 schema 校验的 `structured` 输出同时送入 `web`（`v1`）、`rn`（`v1`）与 `server_v2`（`v2`），并支持 `--save-replay` 冻结结果。这样将 VLM 随机方差完全剥离，对比 Δ 纯粹反映检索与排序链路差异。
2. **首轮基线对比不篡改线上精排逻辑**：本次重构仅修复**观测与公平性落差**（放开 `topOf` 诊断切片上限、`top5` 严格截取前 5 名、接入 `server_v2` 适配器与指标聚合器），**不在对比测试中提前修改 `v2` 精排阈值、Score Floor 或排序权重**，先如实测出 `v2` 在现行代码下的表现、误报与分数分布，再输出量化调优建议。
3. **隐私与脱敏红线**：评测报告、stdout/stderr、对比报表与文档严禁包含 API Key、图片 Base64 Data URL、私有自定义动作 ID 或模型自由文本。原始 JSON 报告与 replay 统一落盘至 `D:\dev\.tools\opengym-retrieval\eval-runs\`。

---

## 3. 对称对比指标 vs 非对称诊断指标体系

### 3.1 对称核心指标（`v1` 与 `v2` 同口径计算，直接计算 Δ）

| 指标 | 计算口径 | 样本范围 | 设计意图 |
|---|---|---|---|
| `strictTop1` | `finalIds[0] === groundTruthId` | `match` | 区分标准主动作与可接受近亲变体是否排在首位 |
| `top1` | `expectedIds.includes(finalIds[0])` | `match` | 核心首命中率 |
| `top5` | `finalIds.slice(0, 5)` 命中任意 `expectedIds` | `match` | **强制切前 5 项**，消除 `v2` 10 项展示的统计偏置 |
| `mrrAt5` / `ndcgAt5` | 前 5 名首个命中倒数秩；相关性按 `groundTruth=2, alt=1` 折算 | `match` | 提升 25 正例在排序微调时的区分度 |
| `wrongHigh` | `top1Level === 'high'` 且（正例首名错 / 空例非空） | 全部成功样本 | **第一产品红线**：严防高置信度误导用户记错训练日志 |
| `wrongEquipment` | 首名动作 `eq` 不在 `expectedEquipment` 内 | 有首名的 `match` | 捕获跨器械错判 |
| `wrongBodyPart` | 首名动作 `bp` 不在期望动作 `bp` 集合内 | 有首名的 `match` | 补齐同器械下跨部位错位（如推胸误中耸肩/肩推） |
| `calibration` | `high / medium / low` 三档各自的 Top-1 准确率 | 非空样本 | 验证 `v2` 硬编码阈值（`0.8` / `0.5`）与 `v1` 置信档位是否校准 |
| `badImageFp` / `badImageHighFp` | `bad_image`（含 `machine_022`、`028`–`032`）非空率及高置信误报率 | 废片样本 | 验证拒识安全性（目标接近 0%） |
| `nearOodFp` / `nearOodHighFp` | `near_ood`（`machine_027`）非空率及高置信误报率 | 库外近亲样本 | 区分合理近似兜底与高置信幻觉 |
| `coverage` / `selectivePrecision` | `match` 非空比例 / 非空样本首名命中率 | `match` | 防止靠“全拒识”或“强行凑数”刷单指标 |
| `clarificationRate` / `clarificationNoHigh` | 输出 `clarifications` 的比例及同时首项非 `high` 比例 | 分 `hard_confusing` 与 `standard_positive` | 验证歧义场景“应问必问”与清晰场景“少打扰” |
| `multiValidCoverage` | `expectedIds.length >= 2` 的样品在前 5 名中命中至少 2 个期望 ID | 多合法动作样本 | 衡量二合一器械/多动作器械是否同时给出选项 |
| `fallbackOnly` | 仅剩兜底无推荐结果比例 | 全部样本 | 总体退化/拒识覆盖率 |
| `latencyP50Ms` / `latencyP95Ms` | 平台检索/匹配阶段耗时 P50 / P95（nearest-rank） | 全部成功样本 | 评估本地毫秒级匹配与服务端 PG+GPU 精排的耗时代价 |
| 梯度曲线 & Invariance | 四档（`photo-only` → `simple` → `alias` → `detailed`）变化 & 同 `family` 跨视角/加载方式一致率 | 32 样本四档矩阵 | 隔离视觉、俗称、长文本、拍摄域迁移短板 |

### 3.2 非对称诊断指标（明确标注 `N/A (仅 v1)` / `N/A (仅 v2)`，不强行求差）

| 归属 | 指标 | 说明 |
|---|---|---|
| **仅 `v1`** | `recallAt5`、`filter` 拒因统计、Web/RN 双端差异 | 本地召回与规则过滤日志专属，`v2` 记 `N/A (仅 v1)` |
| **仅 `v2`** | `top10`、`mrrAt10` | 展示上限放宽至 10 项后第 6–10 名带来的额外挽回收益 |
| **仅 `v2`** | `v2Funnel`：`textRecallAt75` → `vectorRecallAt75` → `fusionRecallAt30` → `rerank Top-1/5/10` | 精准定位问题出在文本召回、向量召回、RRF 融合还是 Cross-Encoder 精排 |
| **仅 `v2`** | `shortCircuitRate`（VLM 零候选短路跳过下游比例）、分阶段延迟（`textMs` / `vectorMs` / `fusionMs` / `rerankMs`）、`top1Score` 分数分布 | 诊断 `v2` 在 `bad_image`/`near_ood` 上的真实拒识路径、性能瓶颈与阈值标定依据 |

---

## 4. 语义级变更声明（Semantic Change Declaration）

### 子系统：`ai-agent`

- **涉及模块与真实入口**：
  - 入口路径 / 命令：`D:\wt\og-retrieval\api\src\agent\retrieval\retrieval.service.ts`（`exercise-search.v2` 在线检索路径，由 `AgentService.execute()` 及评测适配器调用）、`D:\wt\og-retrieval\frontend\scripts\ai-search-eval.mjs`（评测 CLI）。
  - 拟改动源码：
    - `D:\wt\og-retrieval\api\src\agent\retrieval\retrieval.service.ts`
    - `D:\wt\og-retrieval\api\test\retrieval.service.test.js`
    - `D:\wt\og-retrieval\frontend\scripts\ai-search-eval-input.mjs`
    - `D:\wt\og-retrieval\frontend\scripts\ai-search-eval-adapters.mjs`
    - `D:\wt\og-retrieval\frontend\scripts\ai-search-eval-report.mjs`
    - `D:\wt\og-retrieval\frontend\scripts\ai-search-eval.mjs`
    - `D:\wt\og-retrieval\frontend\scripts\ai-search-eval-compare.mjs`（新增）
    - `D:\wt\og-retrieval\frontend\scripts\ai-search-eval.test.mjs`
- **触发条件（Trigger）**：
  - 生产或评测调用 `RetrievalService.retrieve()` 时触发诊断事件发射；
  - 执行 `node frontend/scripts/ai-search-eval.mjs` 传入 `--benchmark` 或 `--include-server-v2` 时触发 `v2` 适配与扩展指标计算；
  - 执行 `node frontend/scripts/ai-search-eval-compare.mjs` 时读取多档报告生成对比分析。
- **改前 / 改后行为（Before / After）**：
  - **Before**：`RetrievalService` 的 `topOf()` 将 `retrieval_text`/`retrieval_vector`/`retrieval_fusion` 的 `top` 截断为 5 条，导致上游 75/30 召回不可观测；评测 CLI 仅能跑 `web`/`rn`（`v1`）且 `top5` 未对 `finalIds` 切片限制；未接入 `server_v2` 与四档对比汇总。
  - **After**：`RetrievalService` 发射完整的 `75`/`75`/`30` 诊断序列（与 `exercise-search-diagnostics.js` 白名单上限完全对齐）；评测 CLI 可选启用 `server_v2`（`live` 或 `fixture`）与 `--benchmark` 元数据，同轮 VLM 输出配对评测 `v1` 与 `v2`；`top5` 严格按前 5 项计分；`ai-search-eval-compare.mjs` 输出对称 Δ 与非对称漏斗报告。不传新参数时，旧 CLI 参数、报告字段与既有测试行为 100% 兼容。
- **接口 / 状态 / 兼容性变化（Contract, State & Compatibility）**：
  - **接口契约**：`exercise-search.v2` 对外 HTTP/Task API 响应结构（`rankedIds`, `items`, `fallback`, `clarifications`）零变更；`ai-search-eval` 新增可选 CLI 标志（`--benchmark`、`--include-server-v2`、`--server-v2-mode`），既有字段全部保留。
  - **状态与持久化**：不修改数据库表结构、索引批次、`DATA_DIR` 或客户端持久化状态；评测产物仅写入 `--out` 与 `--save-replay` 指定路径。
  - **兼容性与迁移**：旧清单、旧 replay JSON 与旧 `ai-search-eval.test.mjs` 全部保持兼容通过。
- **失败模式与降级兜底（Failure Modes & Fallback）**：
  - 诊断发射失败仍被 `RetrievalService.emit()` 内 `try/catch` 吞掉，不影响在线检索结果；
  - 当 `server_v2` 单样本检索超时或服务不可达时，`evaluateServerV2` 返回 `{ ok: false, error: { phase, code } }`，记录到 `failed` 计数器并继续执行其余样本与平台（与既有 `evaluatePlatform` 一致）；
  - 缺失配置或 `benchmark` 与 `manifest` ID 不一致时在请求发出前退出码 `2` 并仅输出安全错误码。
- **实测证据（Empirical Evidence）**：
  - **改前基线 / 复现证据**：代码核查确认 `retrieval.service.ts` L276 `rows.slice(0, 5)` 与 `ai-search-eval-model.mjs` L99 仍调用 `createExerciseSearchTask()`，且 `D:\wt\og-retrieval` 本机 PG（`55432`）与 ROCm BGE（`8765`，`bge-m3` + `bge-reranker-v2-m3`）均已就绪。
  - **改后闭环实测证据**（实施后回填于 [EXECUTION.md](EXECUTION.md) 与 [COMPARISON_REPORT.md](COMPARISON_REPORT.md)）：`api` 构建与单测、`test:ai-search-eval` 全绿，以及 `test_pic` 四档 32 样本 × `v1`/`v2` 真实配对评测数据。
