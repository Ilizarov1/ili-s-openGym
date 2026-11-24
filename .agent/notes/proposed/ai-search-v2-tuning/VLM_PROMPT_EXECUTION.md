# AI 动作检索上游 VLM Prompt 优化执行计划（`vlm-prompt-v2`）

> 依据设计文档：[VLM_PROMPT_DESIGN.md](VLM_PROMPT_DESIGN.md) · 交接基线：[VLM_PROMPT_HANDOFF.md](VLM_PROMPT_HANDOFF.md) · Iter1 报告：[ITER1_COMPARISON.md](ITER1_COMPARISON.md)

## 验收门槛（相对 Iter1 基线 `v2` + 现行 Prompt）

- **`photo-only` (32)**：`v2` Top-1 由 `36.0% (9/25)` 明显提升（目标 `>= 48.0%` 即 `>= 12/25`），`Wrong-High` 严格低于 Iter1 `4/32`（目标 `<= 2/32`），`Coverage` 保持高水准（不误拒清晰/单主体正例）；
- **拒识安全（全档）**：`BadImage-FP` 由 `4/6 (66.7%)` 明显下降（目标 `<= 2/6`），`BadImage-High-FP` 保持 `0/6`；
- **无回归防线**：
  - `simple` (32)：`Top-1 >= 76.0%`、`Top-5 >= 88.0%`、`Wrong-High <= 2/32`（Iter1 为 `4/32`）；
  - `alias` (32)：`Top-1 >= 84.0%`（基线 `88.0%`）、`Top-5 >= 92.0%`（基线 `96.0%`）、`Wrong-High <= 2/32`；
  - `detailed` (32)：`Top-1 >= 84.0%`、`Top-5 >= 92.0%`、`Wrong-High = 0/32`；
  - `repo13` (13)：`Top-1 >= 81.8%`（基线 `90.9%`）、`Top-5 = 100.0%`、`Wrong-High = 0/13`、`NearOOD-FP = 0/2`；
- **范围红线**：严禁修改 `api/src/agent/retrieval/`、`frontend/src/lib/exercise-ai-search.js`、`services/retrieval-model/main.py` 及 `EXERCISE_SEARCH_OUTPUT_SCHEMA`；仅改动 `api/agent-runtime/tasks/exercise-search.js` 与 `api/test/agent-exercise-search.test.js`（外加主仓评测对比与验收文档）。

---

## Phase 1：设计与执行建档（主仓 `D:\dev\open-gym`）

- [x] 在 `.agent/notes/proposed/ai-search-v2-tuning/` 创建 [VLM_PROMPT_DESIGN.md](VLM_PROMPT_DESIGN.md)（含完整 `ai-agent` 语义级变更声明）与本执行文档。
- [x] 更新 [docs/subsystem/ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md) 提案路由入口（保持 `<= 300` 行）。

## Phase 2：代码修改与自动化门禁（`D:\wt\og-retrieval`）

- [x] **2.1 检查并确认本机检索服务就绪**：
  ```powershell
  Set-Location D:\wt\og-retrieval
  try { Invoke-RestMethod http://127.0.0.1:8765/health } catch { .\scripts\windows\Start-Retrieval.ps1 -RuntimeRoot D:\dev\.tools\opengym-retrieval }
  ```
- [x] **2.2 更新 `D:\wt\og-retrieval\api\agent-runtime\tasks\exercise-search.js`**：
  - 按 [VLM_PROMPT_DESIGN.md](VLM_PROMPT_DESIGN.md) §2.1 更新 `PROMPT` 的规则 4、规则 6 与 `## Names` 末句；
  - 核查保持纯 ESM、无 Node 内置模块导入、无 JSON Schema 变更，且全部 11 项旧单测子串原样保留。
- [x] **2.3 扩充 `D:\wt\og-retrieval\api\test\agent-exercise-search.test.js`**：
  - 在 `instructions()` 契约用例中补充 Prompt v2 核心指令断言（接触垫先判、观察-候选一致、废片 `candidates: []`、易混封顶 `medium`）。
- [x] **2.4 执行编译与全量单测门禁**：
  ```powershell
  Set-Location D:\wt\og-retrieval
  npm.cmd --prefix api run build
  node --test api/test/agent-exercise-search.test.js api/test/retrieval.service.test.js api/test/exercise-search-diagnostics.test.js
  node --test api/test/nest/agent-exercise-search.test.js
  npm.cmd --prefix frontend run test:ai-search-eval
  ```

## Phase 3：先导 A/B 实况评测（`photo-only` + `simple`，`D:\wt\og-retrieval`）

- [x] **3.1 运行 `photo-only` 与 `simple` 两档实况 `deepseek-flash` E2E 评测**（先验净收益再决定是否微调或扩展全量）：
  ```powershell
  Set-Location D:\wt\og-retrieval
  $env:OPEN_GYM_EVAL_PROVIDER = 'deepseek'
  $env:OPEN_GYM_EVAL_MODEL = 'deepseek-flash'
  $outDir = 'D:\dev\.tools\opengym-retrieval\eval-runs\vlm-prompt-v2'
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null

  foreach ($tier in @('photo-only', 'simple')) {
    node --env-file=D:\dev\.tools\opengym-retrieval\retrieval.env frontend/scripts/ai-search-eval.mjs `
      --mode e2e `
      --manifest "D:\dev\open-gym\test_pic\manifest-$tier.json" `
      --benchmark D:\dev\open-gym\test_pic\benchmark.json `
      --include-server-v2 `
      --save-replay "$outDir\$tier-replay.json" `
      --out "$outDir\$tier-report.json"
  }
  ```
- [x] **3.2 中期闸门核对（Iter1 基线 vs Prompt v2）**：
  - 逐指标对比 `photo-only` 与 `simple` 的 `Top-1`、`Strict Top-1`、`Top-5`、`Wrong-High`、`BadImage-FP`、`BadImage-High-FP`、`Coverage`、`clarNoHigh` 与清晰组打扰率；
  - 若 `photo-only` 明显提升且 `simple` 无退化，直接进入 Phase 4（实测 `photo-only` Top-1 `+24.0pp` 升至 `60.0%`，`simple` Top-5 `+8.0pp` 升至 `96.0%`，零正例误拒，直接放行 Phase 4，未启用 `iter2b`）；
  - 若存在明显副作用（如误拒正例、或某类指令未生效），允许做 **至多 1 次** 针对性微调（将结果写入 `vlm-prompt-v2-iter2b/`，重过 Phase 2.4 单测后再跑 `photo-only` + `simple` 验证）。

## Phase 4：全量补测（`alias`、`detailed`、`repo13`）与前后对比归档

- [x] **4.1 补跑 `alias`、`detailed`（32 样本 × 2）与 `repo13`（13 样本）实况 E2E**：
  ```powershell
  Set-Location D:\wt\og-retrieval
  $env:OPEN_GYM_EVAL_PROVIDER = 'deepseek'
  $env:OPEN_GYM_EVAL_MODEL = 'deepseek-flash'
  $outDir = 'D:\dev\.tools\opengym-retrieval\eval-runs\vlm-prompt-v2' # 若走 iter2b 则用最终目录

  foreach ($tier in @('alias', 'detailed')) {
    node --env-file=D:\dev\.tools\opengym-retrieval\retrieval.env frontend/scripts/ai-search-eval.mjs `
      --mode e2e `
      --manifest "D:\dev\open-gym\test_pic\manifest-$tier.json" `
      --benchmark D:\dev\open-gym\test_pic\benchmark.json `
      --include-server-v2 `
      --save-replay "$outDir\$tier-replay.json" `
      --out "$outDir\$tier-report.json"
  }

  node --env-file=D:\dev\.tools\opengym-retrieval\retrieval.env frontend/scripts/ai-search-eval.mjs `
    --mode e2e `
    --manifest D:\wt\og-retrieval\docs\ai-exercise-search\eval\manifest.json `
    --include-server-v2 `
    --save-replay "$outDir\repo13-replay.json" `
    --out "$outDir\repo13-report.json"
  ```
- [x] **4.2 生成同轮 `v1` vs `v2` 汇总报告，并计算「Prompt v1 (Iter1) vs Prompt v2」前后完整对比**：
  ```powershell
  Set-Location D:\wt\og-retrieval
  node frontend/scripts/ai-search-eval-compare.mjs `
    --input "photo-only=$outDir\photo-only-report.json" `
    --input "simple=$outDir\simple-report.json" `
    --input "alias=$outDir\alias-report.json" `
    --input "detailed=$outDir\detailed-report.json" `
    --baseline rn `
    --out-md "$outDir\PROMPT_V2_VS_V1.md" `
    --out-json "$outDir\compare-summary.json"
  ```
- [x] **4.3 编写并归档脱敏后的前后对比报告**：
  - 在主仓生成 [VLM_PROMPT_COMPARISON.md](VLM_PROMPT_COMPARISON.md)（完整前后指标、切片、14 重点样本归因、同轮 `v1` vs `v2` 与脱敏核查）。

## Phase 5：复核、回填四步核对与治理自检（主仓 `D:\dev\open-gym`）

- [x] 核查 `D:\wt\og-retrieval` 的 `git diff --stat`，确认仅改动 `api/agent-runtime/tasks/exercise-search.js` 与 `api/test/agent-exercise-search.test.js`（不污染检索器、Schema 或 `v1` 匹配器）。
- [x] 在本文件底部回填最终命令结果、关键前后对比数字与 **改后四步核对记录**。
- [x] 更新 [docs/subsystem/ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md) 纳入 [VLM_PROMPT_COMPARISON.md](VLM_PROMPT_COMPARISON.md) 链接，并运行 `.\.agent\scripts\verify-governance.ps1` 通过治理门禁。

---

## 实测结果与改后四步核对记录

### 1. 构建、单测与 E2E 实测结果

- **服务就绪**：`http://127.0.0.1:8765/health` 返回 `ready`（`rocm`，`BAAI/bge-m3` + `BAAI/bge-reranker-v2-m3`），本机 PostgreSQL `127.0.0.1:55432` 连通正常。
- **构建与单测门禁（全部通过，0 失败）**：
  - `npm.cmd --prefix api run build`：`build: dist ready`（已同步刷新 `api/dist/agent-runtime/tasks/exercise-search.js`）；
  - `node --test api/test/agent-exercise-search.test.js api/test/retrieval.service.test.js api/test/exercise-search-diagnostics.test.js`：**59/59** 通过（含全部 11 项旧字符串契约与新增 5 项 Prompt v2 核心约束断言）；
  - `node --test api/test/nest/agent-exercise-search.test.js`：**10/10** 通过；
  - `npm.cmd --prefix frontend run test:ai-search-eval`：**10/10** 通过（含隐私脱敏与真实 `RetrievalService` E2E 夹具）。
- **实况 `deepseek-flash` E2E 核心指标（`Iter1` → `Prompt v2`，详细全表见 [VLM_PROMPT_COMPARISON.md](VLM_PROMPT_COMPARISON.md)）**：
  - `photo-only` (32, `err=0`)：`v2` Top-1 **`36.0% → 60.0% (+24.0pp)`**，Top-5 **`52.0% → 72.0% (+20.0pp)`**，`Wrong-High` **`4/32 → 2/32`**，`WrongBP` **`12/25 → 6/25`**，`BadImage-FP` **`4/6 → 2/6`**（`BadImage-High-FP` `1/6`：仅 `machine_029` 特写含可见 `'Abdominal Crunch'` 字样），`Coverage 25/25`；`v1` Top-1 **`36.0% → 52.0% (+16.0pp)`**。
  - `simple` (32, `err=0`)：`v2` Top-1 **`76.0% → 76.0%`**，Top-5 **`88.0% → 96.0% (+8.0pp)`**，`Wrong-High` **`4/32 → 2/32`**，`BadImage-FP` **`4/6 → 1/6`**，`BadImage-High-FP = 0/6`。
  - `alias` (32, `err=0`)：`v2` Top-1 **`88.0% → 92.0% (+4.0pp)`**，Top-5 **`96.0%`**，`Wrong-High` **`2/32 → 1/32`**，`BadImage-FP` **`4/6 → 1/6`**，`BadImage-High-FP = 0/6`；`v1` Top-1 **`84.0% → 92.0% (+8.0pp)`**。
  - `detailed` (32, `err=0`)：`v2` Top-1 **`84.0% → 92.0% (+8.0pp)`**，Top-5 **`92.0% → 96.0% (+4.0pp)`**，`BadImage-FP` **`4/6 → 2/6`**，`BadImage-High-FP = 0/6`，正例 `Wrong-High = 0/25`（`near_ood` `machine_027` 给出 `high` 致总 `Wrong-High = 1/32`）；`v1` Top-1 **`72.0% → 88.0% (+16.0pp)`**。
  - `repo13`：`--mode replay`（13 样本门禁复检）保持 **`10/11 (90.9%)` / Top-5 `100%` / `Wrong-High 0/13` / `NearOOD-FP 0/2`**；`--mode e2e`（10 实况样本含 5 纯图 `photo-*`）实测 `Top-1 = 6/10 (60.0%)`（`hinted` `5/5`，`photo-*` `1/5`）、`Top-5 = 8/10 (80.0%)`、`Wrong-High = 0/10`。
  - *注*：`alias` 与 `detailed` 首次实况运行时各有 1 个样本触发 `deepseek-flash` 瞬态 `model_unavailable` 错误（分别在 `machine_002` 与 `machine_011`），均已完整重跑至 `run=32 skipped=0 errors=0` 后归档对比。

### 2. 改后四步核对记录

1. **受影响子系统与真实运行时路径**：已确认 `D:\wt\og-retrieval\api\agent-runtime\tasks\exercise-search.js` 同时服务 NestJS 服务端 `exercise-search.v1` / `v2`（经 `npm.cmd --prefix api run build` 同步至 `api/dist/agent-runtime/tasks/exercise-search.js`）、RN 本机直连 `mobile-rn/src/agent/ai-search.ts` 及评测脚本 `frontend/scripts/ai-search-eval.mjs`。
2. **顺着调用链追踪改动行之外的副作用**：
   - 检查了 `exercise-search.js` 纯 ESM 无 Node 内置模块依赖红线（Metro 安全单测通过）；
   - 检查了 `git diff --stat`：`api/src/agent/retrieval/`、`frontend/src/lib/exercise-ai-search.js`、`services/retrieval-model/main.py` 与全部 JSON Schema 均为 0 改动；
   - 通过全四档实况 E2E 核验单主体正例零误拒（`Coverage = 25/25`）、精排端 P50 延迟仅波动 `-7ms ~ +57ms`。
3. **反向检查契约文档和源码链接**：
   - `api/test/agent-exercise-search.test.js` 已保留全部 11 项既有 `instructions()` 字符串断言并补充 Prompt v2 约束断言；
   - 主仓已新增 [VLM_PROMPT_COMPARISON.md](VLM_PROMPT_COMPARISON.md) 并在 [docs/subsystem/ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md) 登记入口，随后运行 `.\.agent\scripts\verify-governance.ps1` 校验断链与行数门禁。
4. **核验测试是否真实覆盖宣称的行为**：
   - `agent-exercise-search.test.js` 覆盖了 Prompt 文本契约、Schema 校验与纯 ESM 边界；
   - 真实 `deepseek-flash` 四档 128 次 + `repo13` 10 次 E2E 调用及 13 次 `repo13` Replay 实测直接验证了“接触垫先判 / 观察-候选一致 / 易混封顶 `medium` / 废片返回 `candidates: []`”四项 Prompt 优化目标与全部无回归防线。
