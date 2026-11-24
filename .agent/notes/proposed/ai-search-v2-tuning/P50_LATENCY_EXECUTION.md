# AI 动作检索 `v2` P50 延迟优化执行计划（`p50-latency-v2`）

> 依据设计文档：[P50_LATENCY_DESIGN.md](P50_LATENCY_DESIGN.md) · 交接基线：[P50_LATENCY_HANDOFF.md](P50_LATENCY_HANDOFF.md) · 最终对比报告：[P50_LATENCY_COMPARISON.md](P50_LATENCY_COMPARISON.md) · Iter1 报告：[ITER1_COMPARISON.md](ITER1_COMPARISON.md) · Prompt 优化报告：[VLM_PROMPT_COMPARISON.md](VLM_PROMPT_COMPARISON.md)

## 验收门槛（相对 Iter1 基线 + `vlm-prompt-v2` 零退化）

- **延迟目标**（全 4 档 + `repo13` 留出集，冷启动预热后实测）：
  - `v2` **P50 `<= 800ms`**（理想 **`<= 600ms`**）；
  - `v2` **P95 `<= 1000ms`**；
  - `rerankMs` P50 由 `1443–1665ms` 压至 **`<= 500–700ms`**。
- **精度与安全零退化（Iter1 冻结 replay 主门槛）**：
  - `photo-only`：`Top-1 >= 36.0%`（`Top-5 >= 52.0%`）；
  - `simple`：`Top-1 >= 76.0%`、`Top-5 >= 88.0%`；
  - `alias`：`Top-1 >= 88.0%`、`Top-5 >= 96.0%`；
  - `detailed`：`Top-1 >= 84.0%`、`Top-5 >= 92.0%`；
  - `repo13`：`Top-1 >= 90.9%`、`Top-5 = 100.0%`；
  - `Wrong-High` 全档不高于 Iter1（`detailed` 保持 `0/32`、`repo13` 保持 `0/13`）；`BadImage-High-FP` 保持 `0/6`；`multiValidCoverage` 与 `clarificationNoHigh` 无明显下跌。
- **二次回归校验（`vlm-prompt-v2` 冻结 replay）**：
  - `D:\dev\.tools\opengym-retrieval\eval-runs\vlm-prompt-v2\` 四档回放重跑相对 [VLM_PROMPT_COMPARISON.md](VLM_PROMPT_COMPARISON.md) 无精度/安全倒退。
- **代码与测试契约**：
  - `v1` 匹配器、VLM Prompt 与 JSON Schema 保持未修改；
  - 全部 Node / Nest / `test:ai-search-eval` 自动化单测通过，且 `Start-Retrieval.ps1` / `Stop-Retrieval.ps1` 生命周期管理完好。

---

## Phase 1：设计与执行建档（主仓 `D:\dev\open-gym`）

- [x] 在 `.agent/notes/proposed/ai-search-v2-tuning/` 创建 [P50_LATENCY_DESIGN.md](P50_LATENCY_DESIGN.md)（含完整 `ai-agent` 语义级变更声明）与本执行文档。
- [x] 更新 [docs/subsystem/ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md) 注册设计与执行文档入口（保持 `<= 300` 行）。

## Phase 2：单变量实验 1 — P0.2 ROCm 半精度、`max_length=256` 与启动预热（`D:\wt\og-retrieval`）

- [x] **2.1 改造 `D:\wt\og-retrieval\services\retrieval-model\main.py`**：
  - 增加 `RETRIEVAL_RERANK_DTYPE`（CUDA 默认 `fp16`，支持 `fp16`/`bf16`/`fp32`，CPU 强制 `fp32`）与 `RETRIEVAL_RERANK_MAX_LENGTH`（默认 `256`，范围 `64..512`）；保持 `RETRIEVAL_EMBEDDING_DTYPE` 默认 `fp32`；
  - 在 `rerank()` 的 `score()` 中开启 `torch.autocast`（配合 `pad_to_multiple_of=8`）、FP32 Sigmoid 转换及 `torch.isfinite(logits)` / `_finite(scores)` 单 batch 自动回退 FP32；
  - 在 `_load_models()` 末尾增加轻量 warmup；在 `/health` 增量输出 `dtype`、`max_length`、`warmup_ok`、`fp32_fallbacks`（保留全部旧字段）。
- [x] **2.2 重启 8765 并对比 `fp16` vs `bf16` 单变量收益**：
  - 使用 `Stop-Retrieval.ps1` + `pwsh -NoProfile -File .\scripts\windows\Start-Retrieval.ps1 ... -ModelsOnly` 重启验证（记录了 PS 5.1 `Start-Process -PassThru` `ExitCode` 为 `$null` 的坑点至 `.agent/lessons.md` `L-006`）。
  - 实测 `exp1-fp16`（`fp32_fallbacks=0`，`rerankMs` `75–89ms`，总 P50 `165–269ms`）与 `exp1-bf16`（`fp32_fallbacks=0`，`rerankMs` `80–89ms`，总 P50 `181–273ms`）均零精度退化，锁定更快且尾数精度更高的 **`fp16`** 为默认值。

## Phase 3：单变量实验 2 — P0.1 紧凑 `rerank_text` 零重建快验与分数分布核查（`D:\wt\og-retrieval`）

- [x] **3.1 在 `retrieval.service.ts` 实施 Stage A 临时紧凑卡片**：
  - 在 `docs` 构造处使用 `name_en`、`name_zh`、`aliases`、`body_part`、`equipment`、`target`、`posture` 格式化紧凑卡片（缺结构字段时回退 `row.rerank_text`），未改动 `catalogue.ts` 与 PG 索引。
- [x] **3.2 运行单变量对比并核查分数分布（`eval-runs\v1-vs-v2-p50-exp2-compact`）**：
  - 实测仅再省 ~30ms（`rerankMs` `44–59ms`），但 **`alias` 跌破精度/安全红线**：`Top-1` `22/25 (88%) → 21/25 (84%)`（`machine_024`）、`Top-5` `24/25 (96%) → 23/25 (92%)`（`machine_014` 丢失步骤/描述中的 `"chest support"`）、`Wrong-High` `2/32 → 3/32`（`machine_017` 分差变动）。
  - **分布判定闸门结论**：属语义信息丢失而非阈值偏移；经协调器确认按闸门拦截并**放弃 Stage B**，`ranking.ts` 与 `catalogue.ts` 保持零改动。

## Phase 4：还原 `rerank_text` 读取 + P1.1 候选池配置 + P1.2 并行与批量 SQL（`D:\wt\og-retrieval`）

- [x] **4.1（已按 Stage A 闸门收敛）还原 `retrieval.service.ts` 读取 `row.rerank_text`，不改 `catalogue.ts` 与 PG 索引**：
  - `catalogue.ts` `TEMPLATE_VERSION` 保持 `'exercise-search-retrieval-docs-v2'`；`retrieval.service.ts` 恢复直接读取持久化列 `row.rerank_text`。
- [x] **4.2 实现 P1.1 `rerankTopK` 与 P1.2 并发重叠 / `UNNEST` 批量 `textRecall`**：
  - `api/src/agent/retrieval/config.ts` 新增可选 `rerankTopK?: number`（环境变量 `EXERCISE_SEARCH_RERANK_TOP_K`，支持 `10..30`）；
  - `retrieval.service.ts` 保留 `merged.slice(0, 30)` 供 `retrieval_fusion` 诊断，精排切片 `merged.slice(0, rerankTopK)`；
  - `retrieval.service.ts` 在 `!fixture` 时于 `textRecall` 开始前并发启动 `embedText`（含 `.catch(() => undefined)`、独立 `AbortController` 与错误/finally 清理），维持 `BEGIN READ ONLY === 4`；
  - 将 `textRecall` 改写为 `WITH q AS MATERIALIZED (...) CROSS JOIN LATERAL (... UNION ...) + 单次 short_cjk ILIKE` 的 `UNNEST` 批量 SQL（保留 `FROM retrieval_exercise_terms` 与 `d.aliases`），PG `EXPLAIN (ANALYZE, BUFFERS)` 实测 6 词由 `151ms` 降至 **`43ms`**（纯英文 3 词 `24ms`），75 条输出与原循环 100% 一致。
- [x] **4.3 编译 API（无需重建 PG 索引）**：
  - 执行 `npm.cmd --prefix api run build`（因未修改 `catalogue.ts`，跳过 `build-retrieval-index.mjs --rebuild`）。
- [x] **4.4 A/B 对比 `rerankTopK = 20` vs `16` vs `30` 并锁定默认值**：
  - `exp3-topk16` 与 `exp3-topk20` 均在 `alias machine_024` 裁掉 RRF 第 21–30 位的标准动作 `0770`（`alias` `Top-1` `22/25 → 21/25`、`Top-5` `24/25 → 23/25`；`topk16` 还使 `simple` `Top-5` `22/25 → 21/25`）。
  - `exp3-topk30` 在全 4 档 + `repo13` 实现零精度损失，且 P50 仅 `127–159ms`；据此锁定 `config.ts` 与 `retrieval.service.ts` 默认值 **`rerankTopK = 30`**（保留 `10..30` 可配置性）。
- [x] **4.5 更新并补充自动化单测**：
  - 更新 `api/test/retrieval.service.test.js` 验证单次 `UNNEST` 批量查询、`d.aliases` 与权重数组参数传递；
  - 新增单测覆盖：① `rerankTopK` 切片及边界校验（`16` 切片且保留 `retrieval_fusion.top.length === 30`）；② 并发 `embedText` 在 `textRecall` 报错时立即 abort 且正/反双侧均无 `unhandledRejection`；③ 新增 `services/retrieval-model/test_main.py` 覆盖 `fp16`/`bf16` `autocast`、`pad_to_multiple_of=8`、非有限 logits 自动回退 FP32 计数与 `/health` 字段兼容及 ROCm 实卡冒烟。

## Phase 5：最终全栈合并验证与冷启压测（`D:\wt\og-retrieval`）

- [x] **5.1 运行全部编译与自动化单测门禁**：
  - `npm.cmd --prefix api run build` → `build: dist ready`
  - `D:\dev\.tools\opengym-retrieval\venv\Scripts\python.exe -m unittest services\retrieval-model\test_main.py -v` → **4/4 passed**
  - `node --test api/test/retrieval.service.test.js api/test/exercise-search-diagnostics.test.js api/test/agent-exercise-search.test.js` → **61/61 passed**
  - `node --test api/test/nest/agent-exercise-search.test.js` → **10/10 passed**
  - `npm.cmd --prefix frontend run test:ai-search-eval` → **10/10 passed**
- [x] **5.2 干净重启 8765 并校验默认配置就绪**：
  - `/health`: `status=ready`, `device=rocm`, `embedding.dtype=fp32 (warmup_ok=true)`, `rerank.dtype=fp16 (max_length=256, warmup_ok=true, fp32_fallbacks=0)`。
- [x] **5.3 运行最终全量零 VLM 成本回放评测（均 `errors=0`，评测前后 `fp32_fallbacks=0`）**：
  1. `v1-vs-v2` 4 档（`D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2-p50\`）：P50 **`147 / 149 / 151 / 156ms`**（P95 **`252 / 173 / 184 / 173ms`**），`rerankMs` P50 **`81 / 84 / 85 / 88ms`**，全部精度与安全指标 100% 持平 `Iter1`；
  2. `repo13` 留出集（`v1-vs-v2-p50\repo13-report.json`）：P50 **`119ms`** / P95 **`239ms`**（`rerankMs 78ms`），`Top-1 = 10/11 (90.9%)`、`Top-5 = 11/11 (100.0%)`、`Wrong-High = 0/13`；
  3. `vlm-prompt-v2` 4 档二次回归校验（`D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2-p50-promptv2\`）：P50 **`146 / 149 / 148 / 158ms`**（P95 **`160 / 162 / 163 / 173ms`**），精度与安全 100% 持平 `VLM_PROMPT_COMPARISON.md`。

## Phase 6：前后对比归档、四步核对与治理门禁（`D:\dev\open-gym`）

- [x] **6.1 生成前后对比报告**：已在 `.agent/notes/proposed/ai-search-v2-tuning/` 创建 [P50_LATENCY_COMPARISON.md](P50_LATENCY_COMPARISON.md)（含单变量消融、全栈对比、`vlm-prompt-v2` 回归、分数分布与脱敏核查）。
- [x] **6.2 回填本执行文档**：已勾选全量完成项并回填下方实测摘要与改后四步核对记录。
- [x] **6.3 更新路由并运行治理门禁**：已在 [docs/subsystem/ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md) 纳入 `P50_LATENCY_COMPARISON.md` 链接（54 行 `<= 300`），更新 `.agent/lessons.md`（`L-006` 次数 `1 -> 2`、新增 `L-007`），并运行 `.\.agent\scripts\verify-governance.ps1` 通过全部校验。

---

## 改后四步核对记录（Post-Edit 4-Step Audit）

1. **受影响子系统与真实运行时路径定位**：
   - 属 `ai-agent` 子系统。在线运行时由 `api/src/agent/agent.service.ts` 调用 `RetrievalService.retrieve()`（`api/dist/src/agent/retrieval/retrieval.service.js`），查询本地 PG 18（`127.0.0.1:55432`）并向本地模型推理服务（`127.0.0.1:8765`，`services/retrieval-model/main.py`）发起 `/v1/embeddings` 与 `/v1/rerank`；离线评测通过 `frontend/scripts/ai-search-eval-adapters.mjs` 直接加载同一份编译产物 `api/dist/src/agent/retrieval/*.js`。
2. **沿调用链排查改动行之外的副作用**：
   - `main.py`：新增 `torch.autocast` 仅包裹 `model.model(**encoded)`，随后显式将 `logits.float()` 传入 `activation_fn` 避免 FP16 Sigmoid 精度损失，且先检查 `torch.isfinite(logits)` 防止 `+inf` 被 Sigmoid 掩盖为 `1.0`；`embedding` 保持 FP32 默认值，不产生入库向量偏移；`/health` 保持 `Start-Retrieval.ps1:85` 与 `:108` 依赖的全部原有字段不变。
   - `config.ts` / `retrieval.service.ts`：`rerankTopK` 设为可选字段并兜底 `?? 30`，不破坏不传该字段的测试字面量；`embedPromise` 在启动后立即挂载 `.catch(() => undefined)`，失败时通过独立 `embedController.abort()` 取消并清理 `signal` 监听器，杜绝 `UnhandledPromiseRejection` 与事件监听泄漏；PG 事务严格串行复用 `pin.client`，维持 `BEGIN READ ONLY === 4` 契约与 `retrieval_fusion.top.length === 30` 诊断契约。
   - 保持 `frontend/src/lib/exercise-ai-search.js`（`v1`）、`api/agent-runtime/tasks/exercise-search.js`（VLM Prompt）、输出 Schema、`catalogue.ts`、`ranking.ts` 与 `scripts/windows/` 零改动。
3. **反向检查契约文档与源码链接同步更新**：
   - 已同步更新 [P50_LATENCY_DESIGN.md](P50_LATENCY_DESIGN.md)（反映 Stage A 弃用 Stage B、锁定 `rerankTopK=30` 及 `LATERAL UNION` SQL 设计）、本执行文档、新增 [P50_LATENCY_COMPARISON.md](P50_LATENCY_COMPARISON.md)、更新 [docs/subsystem/ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md) 路由链接，并登记 `.agent/lessons.md`（`L-006`、`L-007`）。`api/openapi.yaml` 无接口变动，无需重编 API 文档。
4. **核验测试真实覆盖宣称的行为**：
   - `services/retrieval-model/test_main.py`（4 tests）验证了 `RETRIEVAL_RERANK_DTYPE`（`fp16`/`bf16`/`fp32`）与 `RETRIEVAL_RERANK_MAX_LENGTH` 解析、`pad_to_multiple_of=8`、非有限 `logits` 触发单 batch FP32 回退并递增 `rerank_fp32_fallbacks`、`/health` 字段兼容性及真实 ROCm GPU 半精度矩阵运算。
   - `api/test/retrieval.service.test.js`（含更新的 `UNNEST` 测试与 2 个新增测试，共 61 tests 全绿）真实断言了单次 `UNNEST` SQL 与权重数组传参、`rerankTopK` 切片同时保留 30 条融合诊断、并发 `embedText` 在 `textRecall` 报错前已发起并在报错时被中止（且双侧失败均无未捕获 Rejection）。
   - `api/test/nest/agent-exercise-search.test.js`（10 tests）与 `frontend` `test:ai-search-eval`（10 tests）全绿；全量 9 份冻结回放评测（`v1-vs-v2-p50` 4 档 + `repo13` + `v1-vs-v2-p50-promptv2` 4 档）零错误通过，隐私扫描 `hits: 0`。
