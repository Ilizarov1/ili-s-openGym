# AI Coach 生成式 UI v2 执行计划（`EXECUTION.md`）

> 关联文档：[REQUIREMENTS.md](REQUIREMENTS.md) · [DESIGN.md](DESIGN.md)  
> 编排方式：主协调者统筹设计、分片派发与最终验证；编码任务由 **OpenCode (`opencode-go/deepseek-v4.1-flash`)** 子 Agent 按严格文件边界分阶段并行执行。

---

## 1. 分片拓扑与并行依赖

为兼顾最大并发效率与零文件冲突（同时遵守 OpenCode 2~3 并发上限）：

- **Stage 1（双路并发，零文件重叠）**：
  - **V2-W1（共享协议核与增量 NDJSON 解析器）** ↔ 与 **V2-W3（Web 叙事表面、新原语、内联交互与 19 语言包）** 同时执行。
  - 两者均以 [DESIGN.md §3](DESIGN.md#3-锁定的跨端协议契约v2-w1--v2-w2--v2-w3-唯一真源) 为唯一契约真源，目录完全隔离（`api/agent-runtime/` vs `frontend/`）。
- **Stage 2（紧接 V2-W1 完成）**：
  - **V2-W2（NestJS 真流式编排、Streaming Bounded Fetch、预算配置与 OpenAPI）**，直接基于 V2-W1 产出的 `genui` 导出编译验证。
- **Stage 3（主协调者集成收尾与真机/真模型验收）**：
  - 全量跨端测试与门禁检查、真实 DeepSeek 端到端实测（4 大验收场景）、录制真实交互操作 GIF 落盘至 `evidence/`、填写改后四步核对记录并运行仓库治理门禁。

---

## 2. 分片任务清单与严格文件边界

### Task V2-W1：共享 GenUI v2 协议核、增量 NDJSON 状态机与任务契约

- **执行代理**：OpenCode 子 Agent（`opencode-go/deepseek-v4.1-flash`）
- **允许修改 / 新增文件（严禁越界）**：
  - `api/agent-runtime/genui/protocol.js`
  - `api/agent-runtime/genui/protocol.d.ts`
  - `api/agent-runtime/genui/ndjson-parser.js`（新增）
  - `api/agent-runtime/genui/ndjson-parser.d.ts`（新增）
  - `api/agent-runtime/genui/index.js`
  - `api/agent-runtime/tasks/coach-genui.js`
  - `api/agent-runtime/index.js`
  - `api/test/coach-genui-protocol.test.js`
- **禁止触碰**：`api/src/`、`frontend/`、`api/openapi.yaml`、`mobile-rn/`。
- **核心交付项**：
  1. 扩展 `protocol.js` & `protocol.d.ts`：新增 `GENUI_PROTOCOL_VERSION = 2`、`MAX_GENUI_NODES = 8`、`DEFAULT_MAX_VISUAL_NODES = 1`、`MAX_VISUAL_NODES_LIMIT = 4`、`GENUI_NODE_TYPES`（11 种）、`GENUI_HEAVY_VISUAL_TYPES`、`GENUI_CUSTOM_EVENTS`、`validateGenUINode()`、`sanitizeGenUINodes()`（含 `maxVisuals` 预算裁剪与 `maxNodes` 上限）、`v1ToGenUINodes()`；100% 保留 v1 既有导出与语义。
  2. 新增零依赖 `ndjson-parser.js` & `.d.ts`：`createNdjsonNodeParser()` 支持跨 token 分片拼接、`prose` 未闭合前实时安全提取增量 delta（正确处理 JSON 转义与 UTF-16 代理对）、非 `prose` 类型前瞻发射 `node_pending`、容忍 Markdown 代码围栏与空行、容忍多行缩进 JSON / v1 `{ text, blocks }` 整包对象兜底（`legacy_payload`）、纯文本兜底与单行畸形 JSON 局部容错。
  3. 升级 `api/agent-runtime/tasks/coach-genui.js`：更新 `COACH_GENUI_SYSTEM_PROMPT` 为 v2 NDJSON 叙事穿插流提示词（含反重复、纯问答克制、零数值幻觉、`kpi_strip` 区分水合项与处方项、单列友好约束）；更新 `buildFixtureGenUIResponse` 同时返回 `nodes` + 兼容 `text` / `blocks`；更新 `parseCoachGenUIOutput` 同时解析 NDJSON 与 v1 JSON 并输出 `{ nodes, text, blocks, warnings }`。
  4. 扩展 `api/test/coach-genui-protocol.test.js` 覆盖所有新原语校验、防幻觉剥离 `value`、跨分片/逐字节 NDJSON 解析、转义字符与中文增量、畸形行局部降级、v1 整包 JSON 兜底、`maxVisuals` 预算裁剪与零依赖守卫。
- **验收命令**：
  ```powershell
  node --test api/test/coach-genui-protocol.test.js api/test/agent-portability.test.js
  ```

---

### Task V2-W3：Web 叙事简报表面、5 原语、内联交互、CSS 与 19 语言包

- **执行代理**：OpenCode 子 Agent（`opencode-go/deepseek-v4.1-flash`）
- **允许修改 / 新增文件（严禁越界）**：
  - `frontend/src/lib/coach-genui-hydration.js`
  - `frontend/src/lib/coach-genui-hydration.test.js`
  - `frontend/src/lib/coach-genui-client.js`
  - `frontend/src/components/CoachGenUI.jsx`
  - `frontend/src/components/CoachGenUI.test.jsx`
  - `frontend/src/views/CoachChat.jsx`
  - `frontend/src/views/CoachChat.test.jsx`
  - `frontend/src/coach.css`
  - `frontend/src/locales/*.js`（全部 19 个语言包，含 `pt-BR.js` 规则）
- **禁止触碰**：`api/`、`mobile-rn/`、`docs/`。
- **核心交付项**：
  1. `coach-genui-hydration.js`：新增 `hydrateKpiStrip(S, { items })`（真实计算 `exercise_stat` / `muscle_sets` / `session_count`，透传 `prescription`）与 `resolveExerciseRef(S, exId)`；保留既有 3 个水合函数不变。
  2. `coach-genui-client.js`：`streamFromServer` 支持可选 `maxVisuals`，正确读取 `RUN_FINISHED` 中的 `nodes`（兼容 `{ text, blocks }`），`streamDemo` 保持不变。
  3. `CoachGenUI.jsx`：
     - 导出 `normalizeGenUINodes(message)`（v1 `{ text, blocks }` 自动转 `nodes[]`）；
     - 导出 `GenUIBriefing` 统一单列叙事简报容器与 `GenUINodePending` 局部微骨架；
     - 实现 5 个新原语渲染器：`ProseNode`、`KpiStripNode`、`ComparisonTableNode`（支持 `{ exId }` 中文名+小缩略图）、`ChecklistNode`（可勾选+进度统计+持久化回调）、`CalloutNode`（`info`/`tip`/`warning`）；
     - 升级 `ExerciseTrendBlock`（内联胶囊切换 `1RM / Weight / Volume` + `4w / 8w / 12w / 24w`）与 `MuscleLoadBlock`（内联胶囊切换 `72h / 7d / 28d`），纯本地重水合零网络请求；
     - 保留 `GenUISurface` 与 `GenUISkeleton` 导出向后兼容。
  4. `CoachChat.jsx`：
     - `runStream` 实时处理 `genui.prose_delta`、`genui.node_pending`、`genui.node_commit`、`genui.node_drop` 及 v1 `TEXT_MESSAGE_CONTENT` / `genui.block_upsert`；
     - 点击「停止」时若已有提交节点则持久化保留至 `S.coach.chat`；
     - `Message` 对 `kind === 'genui'` 自动区分纯 `prose`（渲染紧凑 `.bub`）与含 UI 节点（渲染 `<GenUIBriefing>`），支持 `checklistState` 持久化更新。
  5. `coach.css`：全部使用 `index.css` CSS 变量，单列纵向流式布局，轻量化嵌入式面板节律，触摸热区合规，Dark/Light 双主题兼容，`prefers-reduced-motion: reduce` 完整覆盖。
  6. 19 个 `locales/*.js`：补齐 DESIGN.md §4 中新增的英文键及各语种翻译，通过 `check-locales.mjs` 与 `check-source-strings.mjs --strict`。
  7. 补全 Vitest 单测覆盖全部新原语、v1 历史消息兼容、内联切指标/切时间窗、勾选态持久化、流式事件顺序与停止保留。
- **验收命令**：
  ```powershell
  cd frontend; npx.cmd vitest run src/lib/coach-genui-hydration.test.js src/components/CoachGenUI.test.jsx src/views/CoachChat.test.jsx; node scripts/check-locales.mjs; node scripts/check-source-strings.mjs --strict; npm.cmd run build
  ```

---

### Task V2-W2：NestJS 真流式编排、Streaming Bounded Fetch、预算配置与 OpenAPI

- **执行代理**：OpenCode 子 Agent（`opencode-go/deepseek-v4.1-flash`），在 V2-W1 验收通过后启动。
- **允许修改 / 新增文件（严禁越界）**：
  - `api/src/agent/langchain/http-fetch.ts`
  - `api/src/agent/langchain/model-factory.ts`
  - `api/src/agent/coach-genui.service.ts`
  - `api/src/agent/coach-genui.controller.ts`
  - `api/openapi.yaml`
  - `website/api.html`（通过 `node scripts/build-api-docs.mjs` 自动更新）
  - `api/test/nest/coach-genui-sse.test.js`
- **禁止触碰**：`api/agent-runtime/`、`frontend/`、`mobile-rn/`。
- **核心交付项**：
  1. `http-fetch.ts` & `model-factory.ts`：新增可选 `streaming?: boolean`；当 `streaming === true` 且上游返回 2xx `ReadableStream` 时，返回逐块校验 `maxBytes` / `timeoutMs` / `AbortSignal` 的透传 `ReadableStream`，彻底消除整包缓冲阻塞；非流式调用行为保持 100% 不变。
  2. `coach-genui.controller.ts`：解析可选 `maxVisuals`（整数校验并钳制 `0..4`），透传至 `CoachStreamRequest`。
  3. `coach-genui.service.ts`：
     - 解析生效预算 `resolveMaxVisuals(request.maxVisuals)`（请求参数 > `process.env.COACH_GENUI_MAX_VISUALS` > `DEFAULT_MAX_VISUAL_NODES`）；
     - 升级为 `model.stream()`（不设 `responseFormat: 'json'`，启用 `streaming: true`）+ `createNdjsonNodeParser()` 边读 chunk 边实时发射 `genui.prose_delta` / `genui.node_pending` / `genui.node_commit` / `genui.node_drop`；
     - 节点闭合瞬间执行 `validateGenUINode`、预算门控与 `validateReview`（`proposal_action` 失败时原地降级为本地化 `fallback_notice`）；
     - 支持 `legacy_payload`（v1 `{ text, blocks }` 兜底）与 `plain_text` 兜底；支持 `model.stream` 不可用时自动回退 `model.invoke()`；
     - fixture 模式直接流式发射 v2 `nodes[]`（含 `prose` 交错 + 原语/块）；
     - `RUN_FINISHED` 输出 `{ runId, threadId, protocolVersion: 2, nodes, text, blocks }`；
     - 完整保留 `lang=zh` 中文词库接地与隐私错误脱敏。
  4. `api/openapi.yaml` + `node scripts/build-api-docs.mjs`：同步文档与 `website/api.html`。
  5. `api/test/nest/coach-genui-sse.test.js`：升级假 OpenAI 服务器支持 `stream: true` SSE 分片下发，新增断言：
     - 真交错时序（`prose_delta` → `node_commit(prose)` → `node_pending(kpi_strip)` → `node_commit(kpi_strip)` → `prose_delta` → `node_commit(prose)`，验证非全量堆到末尾）；
     - `maxVisuals` 预算裁剪（默认 `1` 截断第 2 个重型图，传 `maxVisuals: 2` 放行 2 个）；
     - v1 整包 JSON 兜底兼容；
     - `proposal_action` 实时校验（真实词库 ID + 裸字符串 `after` 通过，幻觉 ID 降级）；
     - `lang=zh` 中文接地、客户端断开中止流与错误脱敏。
- **验收命令**：
  ```powershell
  npm.cmd --prefix api run build; node --test api/test/nest/coach-genui-sse.test.js; node scripts/build-api-docs.mjs --check
  ```

---

## 3. 阶段 3：集成验证、真实 DeepSeek 实测与 GIF 硬验收

1. **全量自动化测试门禁**：
   - `node --test api/test/coach-genui-protocol.test.js api/test/agent-portability.test.js api/test/nest/coach-genui-sse.test.js`
   - `npm.cmd --prefix api run build`
   - `cd frontend; npx.cmd vitest run src/lib/coach-genui-hydration.test.js src/components/CoachGenUI.test.jsx src/views/CoachChat.test.jsx; node scripts/check-locales.mjs; node scripts/check-source-strings.mjs --strict; npm.cmd run build`
   - `node scripts/build-api-docs.mjs --check`
   - `.\.agent\scripts\verify-governance.ps1`
2. **真实 DeepSeek 端到端实测**（根目录 `npm run dev`）：
   - 场景 1：上斜卧推停滞分析 + 调整建议（验证叙事穿插流、克制单图、无重复废话）
   - 场景 2：动作肩部压力对比 + 4 步肩部热身清单（验证 `comparison_table` 中文名 + 可交互勾选 `checklist`）
   - 场景 3：卡片内联本地交互（`exercise_trend` 切换 `1RM -> 训练量` / `8周 -> 12周`，`muscle_load` 切换 `72小时 -> 28天`，验证零网络请求瞬时重绘）
   - 场景 4：纯概念问答「RIR 1 和 RIR 3 的区别是什么，简短说」（验证克制纯文字气泡，不塞无关图表）
3. **视觉硬验收 GIF**：
   - 录制完整真实操作流程并转换为 `.agent/notes/proposed/coach-genui-v2/evidence/coach-genui-v2-e2e.gif`，回填至 `DESIGN.md` 与 `ACCEPTANCE.md`。
