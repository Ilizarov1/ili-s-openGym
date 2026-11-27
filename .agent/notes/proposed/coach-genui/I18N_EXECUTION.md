# AI Coach 语言与动作名本地化修复执行文档（问题 1 · 非 Demo 模式）

> **关联文档**：[`DESIGN.md`](DESIGN.md) · [`I18N_ISSUE_NOTES.md`](I18N_ISSUE_NOTES.md)
> **范围边界**：聚焦**真实服务端模式与前端真实渲染层**，**不修改 Demo 模式剧本（`coach-genui-client.js` 中的 `streamDemo()`）**。
> **编排方式**：通过 Orca `/orchestration` 并行启动 2 个 OpenCode（`opencode-go/deepseek-v4.1-flash`）子 Agent（I1 后端 / I2 前端），文件边界零重叠。

---

## 1. 语义级变更声明（Semantic Change Declaration）

### 子系统：`ai-agent`（Task I1：后端中文词库上下文与语言强约束）
- **涉及模块与入口**：[`api/src/agent/coach-genui.service.ts`](../../../../api/src/agent/coach-genui.service.ts)、[`api/test/nest/coach-genui-sse.test.js`](../../../../api/test/nest/coach-genui-sse.test.js)
- **触发条件（Trigger）**：客户端调用 `POST /api/agent/coach/stream` 并传入非英文 `lang`（如 `zh` / `zh-TW`）时，LangGraph 编排执行 `analyzeNode`、`composeNode` 与 `validateNode`。
- **改前 / 改后行为（Before / After）**：
  - **Before**：`inspectContext()` 仅将计划动作写为裸 ID、`swapCandidates()` 仅注入英文名 `entry.n`，导致真实模型（DeepSeek）在中文回复的文本、卡片标题、替换理由和表单中混出英文动作名；模型回复异常或空内容时的兜底提示与默认中文提示不完全统一。
  - **After**：读取 `exercise-search-catalogue.json` 的 `zh` 字段，当 `lang` 以 `zh` 开头时在 `inspectContext()`（计划动作、近期训练动作）与 `swapCandidates()` 中提供中文动作名，并在 `buildPrompt()` 中明确约束所有用户可见文案与动作提及统一使用目标语言（仅 `exId`/`id` 保留纯 ID）；模型空响应兜底文案也跟随 `lang` 本地化。
- **接口 / 状态 / 兼容性变化**：`POST /api/agent/coach/stream` 请求/响应 Schema 不变，完全向后兼容；英文及未传 `lang` 时保持英文上下文。
- **失败模式与降级兜底**：词库条目缺失 `zh` 时自动回退 `entry.n`；空输出或降级提示在 `zh*` 语言下输出简体中文，其余语言输出英文。
- **实测证据**：`npm.cmd --prefix api run build` 与 `node api/scripts/test-nest.mjs test/nest/coach-genui-sse.test.js`（新增中文上下文与语言指令断言用例）。

### 子系统：`web-client`（Task I2：前端全 Coach 界面动作名与器材标签本地化，不含 Demo）
- **涉及模块与入口**：[`frontend/src/lib/coach.js`](../../../../frontend/src/lib/coach.js)、[`frontend/src/lib/coach-insights.js`](../../../../frontend/src/lib/coach-insights.js)、[`frontend/src/lib/coach-genui-hydration.js`](../../../../frontend/src/lib/coach-genui-hydration.js)、[`frontend/src/components/CoachGenUI.jsx`](../../../../frontend/src/components/CoachGenUI.jsx) 及配套单测（`coach-genui-hydration.test.js`、`CoachGenUI.test.jsx`、`coach-insights.test.js`）。
- **触发条件（Trigger）**：用户在非英文语言（如 `zh`）下浏览 Coach 聊天的 `PlanCard` / `ReviewCard` / `DebriefCard` / `WorkoutCoachSheet` / `GenUISurface`（折线图、肌群图、替代动作卡、替换按钮、提案前后对比）或动态切换语言/异步加载完 `exercise-names/*.js` 词库包时。
- **改前 / 改后行为（Before / After）**：
  - **Before**：`coach.js` 的 `exName()` 与 `coach-insights.js` 的 `nameOf()` 硬编码读取英文 `EXIDX[id]?.n`；`CoachGenUI.jsx` 的 `useMemo` 未订阅 `useLang()`，导致词库包异步加载后仍缓存旧英文名；器材标签（如 `Dumbbell`）未翻译。
  - **After**：全 Coach 链路统一通过 `exerciseNameFor(ex)` 输出本地化动作名，且 `CoachGenUI.jsx` 订阅 `useLang()` 作为 `useMemo` 依赖，语言切换或词包加载后即时刷新；已知器材标签通过已有 `t(...)` 词条本地化；不修改 `coach-genui-client.js` 中的 Demo 剧本。
- **接口 / 状态 / 兼容性变化**：英文环境（默认测试环境）下 `exerciseNameFor(ex)` 与 `ex.n` 完全等价，100% 兼容既有单测与旧存档；不新增任何未翻译的 `t('...')` 键。
- **失败模式与降级兜底**：用户自定义动作或词包未覆盖的条目自动回退原名，不出现空标题。
- **实测证据**：Vitest 套件全绿（含新增模拟加载中文词包后的本地化断言）、`check-locales.mjs` + `check-source-strings.mjs --strict` + `npm.cmd run build` 全绿。

---

## 2. 并行任务包拆分（零文件重叠）

### Task I1（后端）
- **独占文件**：
  - `api/src/agent/coach-genui.service.ts`
  - `api/test/nest/coach-genui-sse.test.js`
- **验收命令**：
  - `npm.cmd --prefix api run build`
  - `node api/scripts/test-nest.mjs test/nest/coach-genui-sse.test.js`

### Task I2（前端 · 不改 Demo）
- **独占文件**：
  - `frontend/src/lib/coach.js`
  - `frontend/src/lib/coach-insights.js`
  - `frontend/src/lib/coach-genui-hydration.js`
  - `frontend/src/components/CoachGenUI.jsx`
  - `frontend/src/lib/coach-genui-hydration.test.js`
  - `frontend/src/components/CoachGenUI.test.jsx`
  - `frontend/src/lib/coach-insights.test.js`
- **禁止修改**：`frontend/src/lib/coach-genui-client.js`（不处理 Demo）、`frontend/src/locales/**`、`api/**`、`mobile-rn/**`。
- **验收命令**：
  - `cd frontend; npx.cmd vitest run src/lib/coach.test.js src/lib/coach-insights.test.js src/lib/coach-genui-hydration.test.js src/components/CoachGenUI.test.jsx src/views/CoachChat.test.jsx`
  - `cd frontend; node scripts/check-locales.mjs; node scripts/check-source-strings.mjs --strict; npm.cmd run build`

---

## 3. 收尾与验证（主协调者）
- **I1 实测通过**：`npm.cmd --prefix api run build`（`build: dist ready`）+ `node api/scripts/test-nest.mjs test/nest/coach-genui-sse.test.js`（**11/11 通过**，新增测试 11 捕获出站 Prompt 断言包含中文动作名与 `zh` 语言指令）。
- **I2 实测通过**：Vitest **9 文件 / 141 用例全绿**（含中文词包对趋势图、替代动作、复盘 1RM、提案标题/对比、哑铃标签专项断言）；`check-locales.mjs`（19 语种 / 3732 键同步）；`check-source-strings.mjs --strict`（3079 词条全绿）；`npm.cmd run build` 退出码 `0`；未改动 `coach-genui-client.js`（Demo 模式）。
- **治理与真实 DeepSeek 验真**：通过 `.\.agent\scripts\verify-governance.ps1`，并重启真实 DeepSeek 全栈服务实测全中文返回。
