# AI 动作检索 `v2` 精排与领域护栏纠偏执行计划（`ai-search-v2-tuning`）

> 依据设计文档：[DESIGN.md](DESIGN.md) · Iter1 对比报告：[ITER1_COMPARISON.md](ITER1_COMPARISON.md) · 基线交接：[HANDOFF.md](../ai-search-eval-v2/HANDOFF.md) · 基线报告：[COMPARISON_REPORT.md](../ai-search-eval-v2/COMPARISON_REPORT.md)

## 验收门槛（相对 `v1` 与基线 `v2`；本轮不做提速优化）

- `simple` / `alias` / `detailed` 档 `v2` `Top-1` 与 `Top-5` 净胜或至少持平并超越 `v1`（目标 `alias` / `detailed` `Top-1 >= 84%`，`photo-only` 不低于 `v1` `36%`）；✅ **全部达标**（`photo-only` 36.0%=v1、`simple` 76.0%=v1 / Top-5 88.0%>v1、`alias` 88.0%>v1 / Top-5 96.0%、`detailed` 84.0%>v1 / Top-5 92.0%）
- 独立留出集 `repo13`（`docs/ai-exercise-search/eval/manifest.json`）`Top-1` 与 `Top-5` 净胜 `v1`（验证通用性、无对 32 样本过拟合）；✅ **大幅净胜**（Top-1 `10/11 (90.9%)` vs `v1` `5/11 (45.5%)`，Top-5 `11/11 (100.0%)` vs `v1` `7/11`）
- `Wrong-High` 压降至 `<= 1/32`（理想 `0`）；`WrongEq` / `WrongBP` 显著下降；⚠️ **检索侧过自信已清零，四档全优于 `v1`**（`detailed` `0/32`、`repo13` `0/13`、`BadImage-High-FP` 全档 `0/6`；`photo-only` `4/32`、`simple` `4/32`、`alias` `2/32` 余量经核查 100% 为上游 VLM 自身给出 `high` 且与 `v1` 同错同一动作 ID；`WrongEq` / `WrongBP` 全档 ≤ `v1`）
- `BadImage-FP` 下降、`BadImage-High-FP` 归 `0`；✅ **达标**（`BadImage-FP` 由 `5/6` 降至 `4/6`，`BadImage-High-FP` 全部归 `0/6`）
- `hard_confusing` `clarificationNoHigh` 恢复（`>= 4/9`），`standard_positive` 清晰组打扰率明显下降；✅ **全部达标**（`clarificationNoHigh` 恢复至 `5/9–8/9`；`standard_positive` 打扰率在 `simple` `9/9→2/9`、`alias` `5/9→2/9`、`detailed` `6/9→4/9`）
- 本轮**不修改** `catalogue.ts`、`main.py`、PG 索引及 `v1`（`frontend/src/lib/exercise-ai-search.js`），RRF 候选池维持 `30`。✅ **已确认零改动**

---

## Phase 1：设计与执行建档（主仓 `D:\dev\open-gym`）

- [x] 在 `.agent/notes/proposed/ai-search-v2-tuning/` 创建 [DESIGN.md](DESIGN.md) 与本执行文档，完成 `ai-agent` 语义级变更声明。
- [x] 更新 [docs/subsystem/ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md) 提案路由入口（保持 `<= 300` 行）。

## Phase 2：Stage 0 消融摸底（`D:\wt\og-retrieval`）

- [x] 启动/检查本机依赖（PG `127.0.0.1:55432` + ROCm BGE `127.0.0.1:8765`），确认 `/health` 就绪。
- [x] 完成 `rerankQuery` 修正与纯 Logit+RRF+领域护栏融合的迭代验证。

## Phase 3：Stage 1 + Stage 2 实现与单测（`D:\wt\og-retrieval`）

- [x] **3.1 新增纯 TS 领域排序与校准模块 `api/src/agent/retrieval/ranking.ts`**：
  - 实现 `stripNonSemanticSuffix`、`hasVersionSuffix`、`buildWeightedTerms`、`buildVectorQuery`、`buildRerankQuery`、`equipmentConflictFor`、`bodyPartConflictFor`、`unsupportedVariantCount`、`scoreAndRankCandidates`（越界分透传 + `[0, 1]` Logit 反算 + RRF/精确名/属性/冲突/变式融合）、`calibrateLevels`（VLM 硬上限 + 精确名/非易混对/Margin 双门控）、`shouldRejectToFallback`（Score Floor + 全 `low` 多器械全景拒识）、`hasConfusablePair` 与 `deriveClarificationChips`。
- [x] **3.2 接入 `api/src/agent/retrieval/retrieval.service.ts` 与 `fixture-retrieval.ts`**：
  - `textRecall` 与 `vectorRecall` 查询 `d.aliases`（缺失回退 `[]`，保持单次 `withReadClient` 事务与 4 次 `BEGIN READ ONLY`）；
  - 接入 `ranking.ts` 全链路，保持 `topOf` 75/75/30 与 `merged.slice(0, 30)` 不变；`clarifications` 为空时省略键、`rankedIds` 为空时省略 `items` 以符合 `assertExerciseSearchV2Output`。
- [x] **3.3 扩充 `api/test/retrieval.service.test.js`**：
  - 保留原有全部单测通过，新增 6 组覆盖 Query 构造、后缀清理、别名/加权 `textRecall`、标准主动作胜出、VLM 上限与易混对降级、全景低置信与 Score Floor 拒识单测。

## Phase 4：自动化门禁与零 VLM 成本回放复测（`D:\wt\og-retrieval`）

- [x] **4.1 编译与自动化测试门禁**（最终改后全绿）。
- [x] **4.2 冻结 4 档零 VLM 成本回放与独立 `repo13` 留出验证**（全部输出至 `D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2-iter1\`）。

## Phase 5：复核、报告回填与治理收尾（主仓 `D:\dev\open-gym`）

- [x] 核查工作区 diff 范围（`catalogue.ts`、`main.py`、`v1` 匹配器零改动）与脱敏合规后，归档 [ITER1_COMPARISON.md](ITER1_COMPARISON.md)。
- [x] 在本文件回填 Phase 3–4 实测数字与 **改后四步核对记录**。
- [x] 运行 `.\.agent\scripts\verify-governance.ps1` 验证全部文档链接、README 行数与规则台账通过。

---

## 实测结果与改后四步核对记录

### Phase 3–4 实测证据（全部在最终代码落盘后执行）
- **`npm.cmd --prefix api run build`**：退出码 `0`（`build: dist ready`）。
- **`node --test api/test/retrieval.service.test.js api/test/exercise-search-diagnostics.test.js api/test/agent-exercise-search.test.js`**：`59/59` 全部通过（`0` 失败、`0` 跳过）。
- **`node --test api/test/nest/agent-exercise-search.test.js`**：`10/10` 全部通过（`0` 失败、`0` 跳过）。
- **`npm.cmd --prefix frontend run test:ai-search-eval`**：`10/10` 全部通过（`0` 失败、`0` 跳过）。
- **四档零 VLM 回放对比（`v1` → 基线 `v2` → 调优后 `v2`，详见 [ITER1_COMPARISON.md](ITER1_COMPARISON.md)）**：
  - `photo-only` (32)：Top-1 `36.0%` → `8.0%` → **`36.0%`**（Strict `28.0% → 32.0%` +4pp），Top-5 **`52.0%`**（= `v1`），Wrong-High `21.9% → 50.0% → 12.5% (4/32)`，BadImage-FP `5/6 → 4/6`（High-FP `0/6`），`hard_confusing` `clarNoHigh` `6/9 → 2/9 → 8/9`，P50 延迟 `2260ms → 1620ms`（未做提速改造下因 `rerankQuery` 去噪附带下降）。
  - `simple` (32)：Top-1 `76.0%` → `12.0%` → **`76.0%`**（Strict `68.0% → 72.0%` +4pp），Top-5 `76.0% → 32.0% → 88.0%`（**+12pp**），Wrong-High `15.6% → 71.9% → 12.5% (4/32)`，WrongEq `12.0% → 56.0% → 12.0%`，WrongBP `0% → 20.0% → 0.0%`，`clarNoHigh` `4/9 → 0/9 → 6/9`，清晰组打扰率 `9/9 → 2/9`。
  - `alias` (32)：Top-1 `84.0%` → `36.0%` → **`88.0%`**（**+4pp**，Strict `80.0%`），Top-5 `84.0% → 52.0% → 96.0%`（**+12pp**），Wrong-High `12.5% → 56.3% → 6.3% (2/32)`，WrongEq `8.0% → 24.0% → 4.0%`，`clarNoHigh` `5/9 → 0/9 → 6/9`，清晰组打扰率 `5/9 → 2/9`。
  - `detailed` (32)：Top-1 `72.0%` → `20.0%` → **`84.0%`**（**+12pp**，Strict `84.0%`），Top-5 `84.0% → 48.0% → 92.0%`（**+8pp**），Wrong-High `15.6% → 68.8% →` **`0.0% (0/32)`**，WrongEq `12.0% → 8.0%`，WrongBP `28.0% → 0.0%`，`clarNoHigh` `4/9 → 0/9 → 5/9`。
  - 二合一双动作共现（`multiValidCoverage`）：`simple` `13.0% → 82.6%`、`alias` `21.7% → 87.0%`、`detailed` `13.0% → 78.3%`。
- **独立 `repo13` 留出回放（`D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2-iter1\repo13-report.json`，13 样本零误差）**：
  - `v2` Top-1 **`10/11 (90.9%)`**（`v1` `5/11 (45.5%)`，基线 `v2` `2/11 (18.2%)`），Strict Top-1 `8/11 (72.7%)`（`v1` `3/11`），Top-5 **`11/11 (100.0%)`**（`v1` `7/11`），Wrong-High **`0/13`**，WrongEq `1/11`（`v1` `4/10`），NearOOD-FP **`0/2`**，`clarNoHigh` `12/13`。

### 改后四步核对记录（Post-Edit 4-Step Verification）

1. **① 受影响子系统与真实运行时路径**：
   - 已核实子系统：`ai-agent`（`D:\wt\og-retrieval\api\src\agent\retrieval\` 与 `D:\dev\open-gym\.agent\notes\proposed\ai-search-v2-tuning\`）。
   - 运行时入口链路：`AgentService.execute()` (`EXERCISE_SEARCH_V2_TASK_ID`) / `openServerV2Adapter()` → `RetrievalService.retrieve()` → `buildWeightedTerms()` / `buildVectorQuery()` / `buildRerankQuery()` → `scoreAndRankCandidates()` → `shouldRejectToFallback()` → `calibrateLevels()` → `deriveClarificationChips()` → `assertExerciseSearchV2Output()`。已验证 `catalogue.ts`、`services/retrieval-model/main.py` 与 `frontend/src/lib/exercise-ai-search.js`（`v1`）均未修改。
2. **② 调用链行外副作用追踪**：
   - 上游调用方：`AgentService.execute()` 与评测适配器均只调用 `RetrievalService.retrieve()` 且消费 `structured.{rankedIds, items, fallback, clarifications}` 与 `historyMeta.matches`，契约完全一致；`clarifications` 为空时省略键、`rankedIds` 为空时省略 `items`，满足 `EXERCISE_SEARCH_V2_OUTPUT_SCHEMA`。
   - 下游与共享状态：`textRecall` 与 `vectorRecall` 各自保留在单一 `withReadClient` 事务内（单测验证 `BEGIN READ ONLY === 4`）；缺失 `aliases` 列的 Mock 行安全回退 `[]`；PG 索引与 `catalogueHash` 未变；诊断事件仍输出前 75/75/30 与前 10 原始 `relevanceScore`。
3. **③ 契约文档与源码链接反向同步**：
   - 已同步更新 [docs/subsystem/ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md)（共 54 行，≤ 300 行），并归档脱敏后的 [ITER1_COMPARISON.md](ITER1_COMPARISON.md)（已扫描无 `sk-` 密钥、`data:image/` 或私有 ID 泄露）。
4. **④ 测试真实覆盖度核验**：
   - 正常行为覆盖：`retrieval.service.test.js`（59/59 组通过）实测 `aliases` 查询、序位加权、主动作胜出变式与冲突动作、VLM 置信上限、易混对降级、清晰 `high` 静默消歧与 `assertExerciseSearchV2Output` schema 校验；`agent-exercise-search.test.js`（10/10）与 `test:ai-search-eval`（10/10）全绿；真实 PG + ROCm BGE 4 档（128 样本）+ `repo13`（13 样本）全部零误差实跑通过。
   - 失败/边界覆盖：测试 `relevanceScore = 1.2` 越界分数保持排序与 `level: undefined`、全景多器械全 `low` 拒识、低分地板（`0.12`）拒识、以及原有超时/取消销毁连接回归。
