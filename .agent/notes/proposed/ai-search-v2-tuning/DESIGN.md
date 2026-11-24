# AI 动作检索 `v2` 精排与领域护栏纠偏设计（`ai-search-v2-tuning`）

> 所属子系统：`ai-agent` · 交接基线：[HANDOFF.md](../ai-search-eval-v2/HANDOFF.md) · 基线对比：[COMPARISON_REPORT.md](../ai-search-eval-v2/COMPARISON_REPORT.md) · 执行计划：[EXECUTION.md](EXECUTION.md) · 子系统路由：[ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md)

## 1. 背景、问题与本轮边界

### 1.1 实测“不升反降”核心事实
在 `D:\wt\og-retrieval`（`codex/server-retrieval` 分支）首轮 Paired Single-VLM 基线评测中，`v2`（`server_v2`）多路召回上限已优于或持平 `v1`（`rn`）：
- `alias` 档 `v2` 文本@75 与向量@75 均为 `25/25 (100%)`，**`RRF@10` 达 `25/25 (100%)`**；
- `detailed` 档与 `repo13` 回放集 **`RRF@30` 均达 `100%`**；`detailed` 精排前 `RRF #1` Top-1 达 `19/25 (76.0%)`（`v1` 为 `18/25`），`repo13` 精排前 `RRF #1` 达 `8/11 (72.7%)`（`v1` 为 `5/11`）。

但最终端到端 `v2` 在四档全部出现显著倒退：`photo-only` Top-1 `8.0%` vs `36.0%`、`simple` `12.0%` vs `76.0%`、`alias` `36.0%` vs `84.0%`、`detailed` `20.0%` vs `72.0%`、`Wrong-High` 飙升至 `50.0%–71.9%`、`hard_confusing` `clarificationNoHigh` 跌为 `0/9`。

### 1.2 六大精确归因
1. **精排 Query 漏动作名 + Sigmoid 饱和 + 纯精排一票否决 RRF**：`D:\wt\og-retrieval\api\src\agent\retrieval\retrieval.service.ts` L91–L104 构造 `rerankQuery` 时遗漏 VLM 识别出的动作名称（`name` / `nameEn`），仅用 `hintText` + 冗长中文 `fallback.understanding` + 裸 slug 匹配 384 token 的中英 `rerank_text`；`main.py` 返回 Sigmoid 分数全部挤在 `0.97–0.9999` 饱和区间，导致冷门变式或长说明动作以 `0.0001` 微弱分差掀翻高共识 `RRF #1`（`simple` 18 例被掀翻 15 例、`detailed` 19 例被掀翻 14 例）。
2. **VLM 候选序位与置信度全被丢弃（平权召回）**：`textRecall` 将 `candidates[0..4]` 及 `hintText` 平权取 `max(score)` 并按 `exercise_id` 字典序破平，后位 `low` 候选可轻易反超首位 `high` 候选；`vectorQuery` 把冗长 `understanding` 置于 `candidates[0]` 之前且缺少对齐 `embedText` 的结构化属性标签，拉低 `photo-only` 向量首名命中率（`3/25`）。
3. **首轮检索缺少器械/部位冲突拦截与标准主动作优先**：仅二轮 `confirmedEquipment` 时过滤器械，首轮对跨大类器械冲突（如自重拉伸 `2100`、悬吊带 `1073` 盖过 `leverage machine`）及部位冲突零惩罚，导致 `simple` `WrongEq` 高达 `56.0%`（`v1` 仅 `12.0%`）；同时缺少 `v1` 的 `stripNonSemanticSuffix` / `unsupportedVariantCount` 与版本号惩罚，导致 `v. 2`/`v. 4`/单臂等偏门变式在 RRF 和精排中抢占标准主动作（`0576`/`0585`/`0597`/`0599`/`0603`）首位。
4. **置信度单靠 Rerank 饱和分，越权抬升 VLM `medium/low`**：Cross-Encoder 看不到原图清晰度，仅凭文本分 `>= 0.8` 即将 VLM 明确标为 `low` 的全景废片（如 `machine_028`）强行抬升为 `high`。
5. **缺少 Score Floor 与低置信发散废片拒识**：除 VLM 零候选外一律吐出 10 条结果，`bad_image` 低分（如 `0.105`、`0.384`）与全景多器械低置信图均未回落到 `rankedIds: []` + `fallback`。
6. **消歧透传缺少“清晰静默 + 歧义兜底”双向规则**：`v2` 无条件透传 VLM `clarifications`，导致 `standard_positive` 清晰组打扰率暴涨至 `66.7%–100%`（`v1` 仅 `22.2%`），同时高置信误标又将 `hard_confusing` `clarificationNoHigh` 压成 `0/9`。

### 1.3 本轮明确不做（Out of Scope）
- **暂不做提速优化**：不修改 `D:\wt\og-retrieval\api\src\agent\retrieval\catalogue.ts` 的 `rerankText` 模板、不重建 PostgreSQL 索引、不修改 `D:\wt\og-retrieval\services\retrieval-model\main.py`（保持 FP32 原样）、不收窄 RRF Top-30 送精排候选池。
- **不改动 `v1` 基线**：保持 `D:\wt\og-retrieval\frontend\src\lib\exercise-ai-search.js`（及主仓对应基线逻辑）零改动，确保配对对比严格同口径。

---

## 2. 技术方案设计（纯 TS 检索排序、领域护栏与置信校准）

在 `D:\wt\og-retrieval\api\src\agent\retrieval\` 下新增纯 TypeScript 领域排序模块 `ranking.ts`，并由 `retrieval.service.ts` 接入，完整保持外部接口、PG 表结构、索引与单测事务契约不变：

### 2.1 Stage 0 消融摸底（诊断参考）
在合入完整多信号方案前，可通过本地快速对照（仅修 `rerankQuery` vs 纯 RRF）验证未压缩 `rerank_text` 下 `bge-reranker-v2-m3` 经 Logit 展开后的区分力，作为权重标定的定性参考。

### 2.2 Stage 1：加权召回 + 结构化 Query + Logit 融合与领域护栏
1. **加权 `textRecall`（`ranking.ts` `buildWeightedTerms`）**：
   - 按 `hint`（`0.95`）与 `candidates[0..4]` 序位衰减（`[1.0, 0.90, 0.80, 0.72, 0.65]`）× VLM 置信系数（`high=1.0, medium=0.93, low=0.84`）为查询词赋权；同归一化词条取最高权重。
   - `textRecall` 按 `termScore * termWeight` 聚合每条动作的最高分（仍保持在单次 `withReadClient` 事务内执行，确保 `BEGIN READ ONLY` 事务次数严格不变）。
2. **对齐索引格式的 `vectorQuery` 与 `rerankQuery`**：
   - `buildVectorQuery`：参照 `catalogue.ts` `embedText` 模板，将主候选 `English: <nameEn>` / `Chinese: <nameZh>` 置顶，其次 `Attributes: <bodyPart>, <equipment>, <posture>`，尾部附加精简 `hint` 与截断后的 `fallback.understanding`（≤ 120 字符）。
   - `buildRerankQuery`：将 VLM 头部候选动作名（`nameEn` 与中文 `name`，优先第 1–2 候选）置于最前，其次为 `Attributes`（`equipment`, `bodyPart`, `posture`）与精简 `hint`，剔除冗长自由描述噪声。
3. **解除 Sigmoid 饱和 + 多信号联合重排（`scoreAndRankCandidates`）**：
   - **越界保护**：若精排分数 `relevanceScore < 0 || relevanceScore > 1`（如单测 mock 返回 `1.2`），保持按原始 `relevanceScore` 降序且不执行 Logit 截断、分数地板拦截与定级（保持 `level: undefined`）。
   - **Logit 反算与联合打分**：对 `[0, 1]` 区间分数裁剪至 `[1e-6, 1 - 1e-6]` 后计算 `logit = Math.log(p / (1 - p))` 并做稳健归一化，与 `rrf` 排名分、`exactMatch`（含 `stripNonSemanticSuffix` 剥离 `(plate loaded)` / `v. 2` 等非语义后缀后对 `name_en`、`name_zh`、`aliases` 的精确匹配）、属性匹配（器械 / 部位 / 姿势一致）、领域冲突惩罚及变式/版本号惩罚加权求和：
     - **跨大类器械/部位冲突惩罚**：复用 `v1` 的 `FIXED_MACHINES`、`FREE_WEIGHTS`、`BODYWEIGHT`（含 `suspension trainer` 与固定器械冲突）及 `COMPATIBLE_BODY_PARTS`；当候选池中存在非冲突候选时施加显著罚分。
     - **标准主动作优先**：复用 `v1` 的 `UNSUPPORTED_VARIANT_GROUPS`（扩展 `alternating|交替`）并识别尾部 `v. N` / `(version N)` 版本号；当用户输入与 VLM 候选名均未提及对应限定词时施加轻量罚分，保证标准主动作（如 `0576`/`0585`/`0597`/`0599`/`0603`/`0739`/`0743`/`0770`）不被 `v. 2`/`v. 4`/单臂变式抢占首位。
   - **诊断保真**：`rerank` 诊断事件仍按最终 `top10` 输出各条目的原始 `relevanceScore` 与 `rankedIds` 对齐，不破坏 `ai-search-eval` 报告格式。

### 2.3 Stage 2：双门控置信度 + 废片拒识 + 共享消歧规则
1. **双门控置信度定级（`calibrateLevels`）**：
   - **VLM 硬上限铁律**：检索重排只能降级，绝不将匹配的 VLM 候选 `level`（回退至 `candidates[0].level`）从 `medium`/`low` 抬升至 `high`。
   - **`high` 档充要条件**：必须同时满足 ① 对应 VLM 候选 `level === 'high'`；② `rawScore >= HIGH_SCORE_FLOOR`；③ 无器械冲突与部位冲突，且未命中未支持高危变式；④ 具备强规范名或高共识证据（`exactMatch` 命中，或 `rrfRank <= 2 && equipmentMatch && bodyPartMatch`）；⑤ 首名与次名不构成 `hasConfusablePair` 易混动作对（推胸/肩推/蝴蝶机、腿屈伸/腿弯举、哈克深蹲/腿举）；⑥ 若次名为不同动作且无别名共用，要求具备足够的 Logit Margin。
   - **次级定级**：否则在满足 `MEDIUM_SCORE_FLOOR` 且无冲突时封顶为 `medium`（若 VLM 上限为 `low` 则保持 `low`），其余为 `low`。
2. **Score Floor 与全景低置信废片拒识（`shouldRejectToFallback`）**：
   - 仅作用于 `[0, 1]` 正常分数区间；命中以下任一条件时回落为 `rankedIds: []`（不传或清空 `items`）+ `fallback` + 衍生消歧 Chip：
     - **全景多器械发散拦截**：VLM 全部候选均为 `low`，且分散覆盖 `>= 3` 组不同的 `(equipment, bodyPart)` 组合，同时无明确 `hintText`（或仅泛化词），精准拦截 `machine_028` 等健身房全景误报而不误伤单器械低置信识别；
     - **Score Floor 兜底**：首项 `rawScore < SCORE_FLOOR` 且未命中精确名称（`!exactMatch`）。
3. **服务端复用 `deriveClarificationChips()`**：
   - 在 `ranking.ts` 移植 [exercise-ai-search.js](../../../../frontend/src/lib/exercise-ai-search.js#L800-L983) 的 `hasConfusablePair` 与 `deriveClarificationChips`：
     - 当 `items.length > 0 && items[0].level === 'high' && !hasConfusablePair(items)` 时返回 `[]`，并在返回 `structured` 时**省略 `clarifications` 键**（符合 `EXERCISE_SEARCH_V2_OUTPUT_SCHEMA`）；
     - 其余情况清洗 `recognition.clarifications` 并按需补充领域兜底 Chip（上限 3 条），同步压低清晰组打扰率并恢复 `hard_confusing` `clarificationNoHigh`。

---

## 3. 语义级变更声明（Semantic Change Declaration）

### 子系统：`ai-agent`

- **涉及模块与真实入口**：
  - 入口路径 / 命令：`D:\wt\og-retrieval\api\src\agent\agent.service.ts` L344–L355（`EXERCISE_SEARCH_V2_TASK_ID` 在线检索 `postProcess`）、`D:\wt\og-retrieval\api\src\agent\retrieval\retrieval.service.ts`（`RetrievalService.retrieve()`）及 `D:\wt\og-retrieval\frontend\scripts\ai-search-eval.mjs`（`--include-server-v2` 评测 CLI）。
  - 拟改动源码：
    - `D:\wt\og-retrieval\api\src\agent\retrieval\ranking.ts`（新增纯 TS 检索排序、领域护栏、置信校准与消歧模块）
    - `D:\wt\og-retrieval\api\src\agent\retrieval\retrieval.service.ts`（查询构造、加权召回、`aliases` 列读取、调用 `ranking.ts` 融合排序/校准/拒识/消歧）
    - `D:\wt\og-retrieval\api\src\agent\retrieval\fixture-retrieval.ts`（可选补充 `aliases` 字段以对齐真实行结构）
    - `D:\wt\og-retrieval\api\test\retrieval.service.test.js`（新增精排 Query、序位加权、主动作优先、置信上限、废片拒识与消歧抑制单测）
- **触发条件（Trigger）**：
  - 线上调用 `exercise-search.v2`（且 VLM 返回 `candidates.length > 0`），或运行评测脚本 `ai-search-eval.mjs --include-server-v2` 经由 `RetrievalService.retrieve()` 执行文本/向量召回、RRF 融合与 Cross-Encoder 精排时触发。
- **改前 / 改后行为（Before / After）**：
  - **Before**：`textRecall` 对 `candidates[0..4]` 平权取最高分；`rerankQuery` 缺失 VLM 动作名称且混入长 `fallback.understanding`；排序唯 `relevanceScore` 论且无器械/部位/变式护栏；`level` 仅靠 `score >= 0.8` 硬阈值越权抬升 VLM 低置信候选；无 Score Floor 与全景低置信拒识；无条件透传 VLM `clarifications`。导致 4 档测试 `Top-1`、`Wrong-High`、`WrongEq` 与 `clarificationNoHigh` 全面劣于 `v1`。
  - **After**：`textRecall` 与 `vectorQuery`/`rerankQuery` 突出 VLM 首选动作名与属性并保留候选序位权重；精排通过 Logit 反算与 RRF/精确名/属性/冲突/变式信号联合排序，防止饱和微差掀翻共识主动作；`level` 受 VLM 置信上限、精确度、易混对与 Margin 双门控约束；低分与全景发散废片安全回落为空列表兜底；清晰高置信且无易混对时自动静默 `clarifications`，歧义场景自动补齐消歧 Chip。
- **接口 / 状态 / 兼容性变化（Contract, State & Compatibility）**：
  - **接口契约**：`EXERCISE_SEARCH_V2_TASK_ID` / `EXERCISE_SEARCH_V2_OUTPUT_SCHEMA`（`rankedIds`、`items`、`fallback`、`clarifications`）零字段增删；`clarifications` 为空时按 schema 省略该键；`rankedIds` 为空时 `items` 省略或保持空数组与 `rankedIds` 等长，完全通过 `assertExerciseSearchV2Output`。
  - **状态与持久化**：不修改 PostgreSQL 表结构、`catalogue.ts` 模板、`TEMPLATE_VERSION`、现有 PG 索引、`services/retrieval-model/main.py`、Web/RN 客户端存储与 `v1` 匹配器。
  - **兼容性与迁移**：`retrieval.service.ts` 对 `row.aliases` 缺省情况回退 `[]`，保持 `dbRow()` 等现有测试 Mock 行结构与 `BEGIN READ ONLY` 4 次事务计数兼容；精排越界分数（`< 0` 或 `> 1`）绕过 Logit 截断与 Score Floor 并保持 `level: undefined`，100% 兼容既有越界分数回归测试。
- **失败模式与降级兜底（Failure Modes & Fallback）**：
  - 数据库超时、连接取消或模型服务不可用仍沿用既有 `AgentError` 错误映射与 `PinnedBuild` 连接销毁路径；
  - 若所有候选触发领域冲突，仅降权不清空，确保不误杀合法识别；若触发 Score Floor 或全景多器械低置信拒识，安全返回 `rankedIds: []` + `fallback` 理解与中文消歧 Chip；
  - 诊断回调 `emit()` 仍受 `try/catch` 保护，绝不阻塞在线结果。
- **实测证据（Empirical Evidence）**：
  - **改前基线 / 复现证据**：见 [COMPARISON_REPORT.md](../ai-search-eval-v2/COMPARISON_REPORT.md)（`photo-only` `v2` Top-1 `8.0%`、`simple` `12.0%`、`alias` `36.0%`、`detailed` `20.0%`、`Wrong-High` `50.0%–71.9%`、`hard_confusing` `clarificationNoHigh = 0/9`）及 [HANDOFF.md](../ai-search-eval-v2/HANDOFF.md) 冻结 4 档 replay + `repo13` 回放数据。
  - **改后闭环实测证据**（执行完成后回填于 [EXECUTION.md](EXECUTION.md) 与 `ITER1_COMPARISON.md`）：`api` 构建与全部单测、`test:ai-search-eval`，以及零 VLM 成本 `test_pic` 四档回放 + `repo13` 留出回放对比数据。
