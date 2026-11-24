# AI 动作检索评测重构与 `v1` vs `v2` 对比执行计划

> 依据设计文档：[DESIGN.md](DESIGN.md) · 对比成果报告：[COMPARISON_REPORT.md](COMPARISON_REPORT.md)

## Phase 1：设计与执行建档

- [x] 在 `.agent/notes/proposed/ai-search-eval-v2/` 创建 [DESIGN.md](DESIGN.md) 与本执行文档，完成 `ai-agent` 语义级变更声明。

## Phase 2：修复观测落差并重构评测系统（`D:\wt\og-retrieval`）

- [x] **2.1 修复 `RetrievalService` 诊断切片上限**：
  - `api/src/agent/retrieval/retrieval.service.ts`：`topOf(rows, score, limit = 5)` 在 `retrieval_text` 传 `75`、`retrieval_vector` 传 `75`、`retrieval_fusion` 传 `30`，保持线上检索与排序逻辑不变；
  - `api/test/retrieval.service.test.js`：补充超 5 条命中时的诊断切片长度断言（`text`/`vector` = `75`，`fusion` = `30`，`rerank` = `10`）。
- [x] **2.2 扩展评测输入与适配器**：
  - `frontend/scripts/ai-search-eval-input.mjs`：新增 `loadBenchmarkMetadata(benchmarkPath)` 解析 `benchmark.json` 结构化标签；
  - `frontend/scripts/ai-search-eval-adapters.mjs`：补充 `publicBodyPartById`，并在 `includeServerV2` 时装配 `serverV2`（支持 `live` PG+HTTP 与 `fixture` 内存模式）。
- [x] **2.3 升级评测报告聚合与 CLI 入口**：
  - `frontend/scripts/ai-search-eval-report.mjs`：修复 `top5` 截断前 5 项、补齐对称指标（`strictTop1`、`mrrAt5`、`ndcgAt5`、`wrongHigh`、`wrongBodyPart`、`calibration`、`badImageFp`/`nearOodFp`、`coverage`/`selectivePrecision`、`clarificationRate`、`multiValidCoverage`）与 `server_v2` 专属漏斗/分数分布指标（`top10`、`mrrAt10`、`v2Funnel`、`shortCircuitRate`）；
  - `frontend/scripts/ai-search-eval.mjs`：新增 `--benchmark`、`--include-server-v2`、`--server-v2-mode live|fixture`，向后兼容既有参数与输出格式；
  - `frontend/scripts/ai-search-eval-compare.mjs`：实现四档梯度对比、非对称漏斗、切片/Invariance、校准与逐样本翻正/翻错对比生成器；
  - `frontend/scripts/ai-search-eval.test.mjs`：保留旧 8 项测试全部通过，新增 `server_v2` fixture、benchmark 元数据、公平 `top5` 截断、安全红线与隐私断言测试（共 `10/10` 通过）。

## Phase 3：自动化构建与回归门禁（`D:\wt\og-retrieval`）

```powershell
Set-Location D:\wt\og-retrieval
npm.cmd --prefix api run build
node --test api/test/retrieval.service.test.js api/test/exercise-search-diagnostics.test.js api/test/agent-exercise-search.test.js
npm.cmd --prefix frontend run test:ai-search-eval
```

- [x] 上述命令全部退出码 `0` 后再进入真实评测。

## Phase 4：执行 `v1` vs `v2` 配对实测（`D:\wt\og-retrieval` + `D:\dev\open-gym\test_pic`）

- [x] 确认 PG（`127.0.0.1:55432`）与本机 ROCm 模型服务（`127.0.0.1:8765`）就绪；产物目录 `D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2\`。
- [x] 运行仓库 13 条回放（`docs/ai-exercise-search/eval/manifest.json` + `--include-server-v2`）验证端到端连通性。
- [x] 运行单样本冒烟（`machine_001`）验证 DeepSeek VLM 与 `server_v2` 联调正常。
- [x] 依次运行 `test_pic` 四档清单（`manifest-photo-only.json`、`manifest-simple.json`、`manifest-alias.json`、`manifest-detailed.json`）并 `--save-replay` 冻结 VLM 输出。
- [x] 运行 `ai-search-eval-compare.mjs` 生成 [COMPARISON_REPORT.md](COMPARISON_REPORT.md) 与 `compare-summary.json`。

## Phase 5：改后四步核对与治理收尾

- [x] 更新 `D:\dev\open-gym\docs\subsystem\ai-agent\README.md` 路由（保持 ≤ 300 行）。
- [x] 在本文件回填 Phase 3–4 实测结果与改后四步核对记录。
- [x] 运行 `.\.agent\scripts\verify-governance.ps1` 验证仓库文档治理全绿（退出码 `0`，扫描 244 条本地链接通过，`docs/subsystem/ai-agent/README.md` 为 53 行）。

---

## 实测结果与改后四步核对记录

### Phase 3–4 实测证据
- **`npm.cmd --prefix api run build`**：退出码 `0`（`build: dist ready`）。
- **`node --test api/test/retrieval.service.test.js api/test/exercise-search-diagnostics.test.js api/test/agent-exercise-search.test.js`**：`53/53` 全部通过（`0` 失败、`0` 跳过）。
- **`npm.cmd --prefix frontend run test:ai-search-eval`**：`10/10` 全部通过（覆盖旧 8 项回归 + 新增 `server_v2` 公平 `top5`、benchmark `strictTop1`/`ndcg`、真实 `RetrievalService` fixture 与隐私脱敏断言）。
- **外置评测产物（均 `errors=0`，退出码 `0`，不提交仓库）**：
  - `D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2\repo13-replay.json`（`run=13, skipped=5, errors=0`）
  - `D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2\smoke-m001.json` + `smoke-m001-replay.json`（`run=1, errors=0`）
  - `D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2\photo-only-report.json` + `photo-only-replay.json`（`run=32, errors=0`）
  - `D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2\simple-report.json` + `simple-replay.json`（`run=32, errors=0`）
  - `D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2\alias-report.json` + `alias-replay.json`（`run=32, errors=0`）
  - `D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2\detailed-report.json` + `detailed-replay.json`（`run=32, errors=0`）
  - `D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2\compare-summary.json`

### 改后四步核对记录（Post-Edit 4-Step Verification）

1. **① 受影响子系统与真实运行时路径**：
   - 已核实子系统：`ai-agent`（`D:\wt\og-retrieval` 评测 CLI 与 `RetrievalService` 诊断投影；`D:\dev\open-gym` `test_pic` 样本清单与 `.agent/notes/proposed/ai-search-eval-v2/` 文档）。
   - 运行时入口链路：`ai-search-eval.mjs` → `openEvaluationAdapters()` 加载真实 Web 匹配器、RN `ai-search-matcher.ts` 及编译后 `api/dist/src/agent/retrieval/retrieval.service.js` → `evaluatePlatform()` / `evaluateServerV2()` → `summarizeEvaluation()` → `ai-search-eval-compare.mjs`。
2. **② 调用链行外副作用追踪**：
   - 上游调用方：NestJS `AgentService` 与 `ai-search-eval.mjs` 调用 `RetrievalService.retrieve()` 时均受益于 `topOf` 75/75/30 完整诊断；`exercise-search-diagnostics.js` 已具 `MAX_RECALL_TOP` 白名单（75/75/30/30），无越界风险。
   - 下游与共享状态：不传 `--include-server-v2` 与 `--benchmark` 时，`ai-search-eval.mjs` 输出字段与 3 行 stdout 格式与旧版 100% 兼容；PG 池在 `openEvaluationAdapters().close()` 的 `finally` 中调用 `service.onModuleDestroy()` 释放。
3. **③ 契约文档与源码链接反向同步**：
   - 已同步更新 [docs/subsystem/ai-agent/README.md](../../../docs/subsystem/ai-agent/README.md)（保持 ≤ 300 行），链接至 `DESIGN.md`、`EXECUTION.md` 与 `COMPARISON_REPORT.md`。
4. **④ 测试真实覆盖度核验**：
   - 正常行为覆盖：`retrieval.service.test.js` 真实返回 80 条记录验证 `text=75 / vector=75 / fusion=30 / rerank=10`；`ai-search-eval.test.mjs` 真实跑通 `RetrievalService` fixture 适配器、`--benchmark` 关联与 `top5` vs `top10` 分离；四档共 128 样本 + 13 条回放均实跑零误差通过。
   - 失败/边界覆盖：测试 `top1Score` 越界、超时/取消销毁连接、隐私标记（Key/自定义 ID/Data URL/图片名）被 report 与 compare Markdown 彻底剥离。
