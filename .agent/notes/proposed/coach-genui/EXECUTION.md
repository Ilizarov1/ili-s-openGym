# AI Coach 生成式 UI（路线 A）执行计划（`EXECUTION.md`）

> **关联设计**：[`DESIGN.md`](DESIGN.md)
> **并行编排模式**：Orca `/orchestration` 启动 3 个并行 OpenCode（`opencode-go/deepseek-v4.1-flash` 最大思考档位）子 Agent，按**严格互不重叠的文件边界**并发执行 Wave 1；随后由主协调者执行 Wave 2 集成校验、OpenAPI 同步、多语言门禁、改后四步核对与真实操作 GIF 验收。

---

## 1. 并行任务包拆分（Wave 1 — 零文件重叠）

### Task W1：共享 GenUI 协议核与 `coach-genui.v1` 任务契约（`ai-agent` shared core）
- **负责范围**：纯 JS 零依赖协议层，供 NestJS 服务端、Web 端与未来 RN 端共同复用。
- **独占修改/新增文件**：
  - `api/agent-runtime/genui/protocol.js`（新增）
  - `api/agent-runtime/genui/protocol.d.ts`（新增）
  - `api/agent-runtime/genui/index.js`（新增）
  - `api/agent-runtime/tasks/coach-genui.js`（新增）
  - `api/agent-runtime/index.js`（仅追加导出）
  - `api/test/coach-genui-protocol.test.js`（新增）
- **禁止修改**：`api/src/**`、`frontend/**`、`mobile-rn/**`、既有 `api/agent-runtime/` 运行时逻辑文件。
- **交付验收标准**：
  1. `protocol.js` 导出标准 AG-UI 事件类型常量 `AGUI_EVENT_TYPES`、SSE 格式化/解析纯函数 `formatSseEvent` / `parseSseChunk`、5 类受控 Block 常量 `GENUI_BLOCK_TYPES`、校验与清洗降级函数 `validateGenUIBlock` / `sanitizeGenUIBlocks`（校验 `exId` 是否在传入 `validExIds` 集合中，非法块自动降级为 `fallback_notice`，单次最多 6 块）。
  2. `coach-genui.js` 导出 `COACH_GENUI_TASK_ID = 'coach-genui.v1'`、`createCoachGenUITask()`（含结构化 Prompt 约束、输出解析与安全降级）以及确定性 fixture 生成器 `buildFixtureGenUIResponse({ question, plan, formSubmission, validExIds })`（可根据提问关键词如 `bench/stall/shoulder/pain` 或微表单提交产出真实可用的多块组合）。
  3. 严格零 `node:` / `Buffer` / `process` / 第三方依赖。
  4. 执行通过：`node --test api/test/agent-portability.test.js api/test/coach-genui-protocol.test.js`。

### Task W2：NestJS AG-UI SSE 流式控制器 + LangGraph 编排服务（`api-sync` / `ai-agent` server）
- **负责范围**：基于现有 `@langchain/langgraph` 与 NestJS `NodeAdapter` 落地流式端点 `POST /api/agent/coach/stream`。
- **独占修改/新增文件**：
  - `api/src/agent/coach-genui.service.ts`（新增）
  - `api/src/agent/coach-genui.controller.ts`（新增）
  - `api/src/agent/agent.module.ts`（注册新 Controller / Service）
  - `api/scripts/build-api.mjs`（更新 `required` 产物校验清单）
  - `api/test/nest/coach-genui-sse.test.js`（新增）
- **禁止修改**：`api/agent-runtime/**`（仅按 `DESIGN.md` 约定接口导入，若并行期间需类型兼容可做明确接口适配）、`frontend/**`、`mobile-rn/**`、`api/coach/**`。
- **交付验收标准**：
  1. `CoachGenUIController` 挂载 `@SessionRequired()` `@Post('agent/coach/stream')`，使用原生 `ServerResponse` 写出 `Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`X-Accel-Buffering: no`，带 15s `: ping\n\n` 心跳，监听 `req.on('close')` 立即取消 `AbortController`。
  2. `CoachGenUIService` 使用 `@langchain/langgraph` `StateGraph` 编排 4 节点（`prepareNode` → `analyzeNode` → `composeNode` → `validateNode`），支持 `fixture` 确定性演示模式与真实 `ChatOpenAI` 兼容模型调用；在每个节点实时通过回调向 SSE 发射 AG-UI 事件（`RUN_STARTED`、`STEP_STARTED/FINISHED`、`TOOL_CALL_START/RESULT`、`TEXT_MESSAGE_START/CONTENT/END`、`CUSTOM(genui.block_upsert)`、`RUN_FINISHED`/`RUN_ERROR`）。
  3. 对 `proposal_action` 块中的变更复用 `api/coach/core/validate.js` 校验，拦截非法动作 ID 或越权变更类型。
  4. 构建并通过集成测试：`npm.cmd --prefix api run build` 与 `node api/scripts/test-nest.mjs test/nest/coach-genui-sse.test.js`。

### Task W3：Web 端 AG-UI SSE 客户端、数据水合层、GenUI 受控组件目录与 `CoachChat` 融合（`web-client`）
- **负责范围**：在 Web 端落地流式客户端、本地真实数据水合、5 类受控组件渲染器、Demo 模式流式模拟与全语种 i18n 补齐。
- **独占修改/新增文件**：
  - `frontend/src/lib/coach-genui-client.js`（新增）
  - `frontend/src/lib/coach-genui-hydration.js`（新增）
  - `frontend/src/components/CoachGenUI.jsx`（新增）
  - `frontend/src/views/CoachChat.jsx`（融合流式 GenUI 消息、微表单回流与回退降级）
  - `frontend/src/coach.css`（新增 `.genui-*` Token 合规样式）
  - `frontend/src/locales/*.js`（补齐本次新增的精炼 `t('...')` 词条，保证 19 语种同步）
  - `frontend/src/lib/coach-genui-hydration.test.js`（新增）
  - `frontend/src/components/CoachGenUI.test.jsx`（新增）
- **禁止修改**：`api/**`、`mobile-rn/**`。
- **交付验收标准**：
  1. `coach-genui-hydration.js` 实现纯函数：`hydrateExerciseTrend(S, { exId, metric, weeks })`（复用 `onerm.js` / `history.js`）、`hydrateMuscleLoad(S, { window, focusMuscles })`（复用 `muscles.js`）、`hydrateExerciseAlternatives(S, { forExId, items })`（校验 `EXIDX` 真实词库）。
  2. `coach-genui-client.js` 实现 `streamCoachGenUI({ text, formSubmission, today, planSummary, signal, onEvent })`：
     - 服务端模式消费 `POST /api/agent/coach/stream` SSE 事件流，若服务端返回 `404`/`503` 或处于手机 BYOK 模式则抛出带 `fallback: true` 标记以便 `CoachChat` 无缝回退到 `askCoach()`；
     - `DEMO` 模式内置真实节奏的 AG-UI 流式事件生成器（支持 3 类剧本：① 问卧推停滞/肩痛 → 出 `ExerciseTrendBlock` + `MuscleLoadBlock` + `ExerciseAlternativesBlock` + `ProposalActionBlock`；② 问模糊不适/调计划 → 出 `QuickFormBlock` 微表单，提交后进入下一轮出针对性卡片；③ 普通问答 → 流式文本 + 相关趋势图）。
  3. `CoachGenUI.jsx` 完整实现 5 类受控组件 + `FallbackNoticeBlock` + `StreamStepsBar`，严格使用 `index.css` CSS 变量、`LineChart`、`BodyMap`、`Thumb` 与既有 `applyChangeSet` / `markStale` 安全写提案逻辑。
  4. `CoachChat.jsx` 保留所有既有 `PlanCard` / `ReviewCard` / `DebriefCard` / `AdaptProposal` / 既有单测 100% 绿灯，同时将自由提问升级为流式 GenUI 体验并支持中途点击停止生成。
  5. 执行通过：
     - `cd frontend; npx.cmd vitest run src/lib/coach-genui-hydration.test.js src/components/CoachGenUI.test.jsx src/views/CoachChat.test.jsx`
     - `cd frontend; node scripts/check-locales.mjs; node scripts/check-source-strings.mjs --strict`
     - `cd frontend; npm.cmd run build`

---

## 2. 集成与验收阶段（Wave 2 — 主协调者统一收尾）

待 W1、W2、W3 全部 `worker_done` 返回后，主协调者依次完成：

1. **跨包接口对齐检查**：核对 W1 `protocol.js`、W2 `coach-genui.service.ts`、W3 `coach-genui-client.js` 的字段名、SSE 格式与导出路径完全一致。
2. **契约文档同步**：更新 `api/openapi.yaml` 新增 `POST /api/agent/coach/stream`，执行 `node scripts/build-api-docs.mjs`。
3. **全量验证门禁**：
   - `npm.cmd --prefix api run build`
   - `node --test api/test/agent-portability.test.js api/test/coach-genui-protocol.test.js`
   - `node api/scripts/test-nest.mjs test/nest/coach-genui-sse.test.js test/nest/agent-langchain.test.js`
   - `cd frontend; npm.cmd test`
   - `cd frontend; node scripts/check-locales.mjs; node scripts/check-source-strings.mjs --strict; npm.cmd run build`
   - `.\.agent\scripts\verify-governance.ps1`
4. **前端视觉硬验收（真实操作 GIF）**：
   - 启动 `VITE_DEMO=1` 前端，用 `ego-browser` 真实执行多轮自由提问 → 观看流式步骤与文本 → 展示 `ExerciseTrendBlock` / `MuscleLoadBlock` / `ExerciseAlternativesBlock` / `QuickFormBlock` 微表单点选提交 → 点击 `ProposalActionBlock` 一键应用并校验计划更新 → 录制完整交互 GIF 存入 `evidence/coach-genui-after.gif`。
5. **改后四步核对与归档**：补齐 `DESIGN.md` 实测证据与四步核对记录，视验收状态准备迁入 `.agent/notes/implemented/coach-genui/`。
