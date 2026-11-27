# AI Coach 生成式 UI 体验修复执行文档（问题 2 / 3 / 4）

> **关联设计**：[`DESIGN.md`](DESIGN.md) · **暂缓记录**：[`I18N_ISSUE_NOTES.md`](I18N_ISSUE_NOTES.md)
> **编排方式**：通过 Orca `/orchestration` 并行启动 2 个 OpenCode（`opencode-go/deepseek-v4.1-flash`）子 Agent，严格按互不重叠的文件边界完成修复与回归测试。

---

## 1. 语义级变更声明（本次修复增量）

### 子系统：`ai-agent`（问题 4：全量动作词库校验误杀修复）
- **涉及模块与入口**：[`api/src/agent/coach-genui.service.ts`](../../../../api/src/agent/coach-genui.service.ts)、[`api/test/nest/coach-genui-sse.test.js`](../../../../api/test/nest/coach-genui-sse.test.js)
- **触发条件（Trigger）**：真实模型（如 DeepSeek）在 `POST /api/agent/coach/stream` 中返回 `proposal_action` 替换动作提案，其目标替换动作来自 5,600+ 全量动作检索词库（`exercise-search-catalogue.json`），但不在旧 Coach 1,300 裁剪子集（`api/coach/core/library-data.js`）内。
- **改前 / 改后行为（Before / After）**：
  - **Before**：真实模型（如 DeepSeek）在 `swap-exercise` 提案中常将 `after` 写为裸字符串 ID（如 `after: "0123"`）而非 `{ id: "0123" }`，导致 `validateReview()` 读取 `c.after.id` 为 `undefined` 并报错 `changes[0].after.id must be an exercise id from the library` 将合法替换提案误杀降级为 `fallback_notice`。
  - **After**：`verifyBlock()` 向 `validateReview()` 传入全量已校验词库白名单 `customIds: [...state.validExIds]`，并在校验前对 `swap-exercise`/`add-exercise` 的裸字符串 `after` 规范化为 `{ id: after }`；同时 `swapCandidates()` 优先推荐常规力量替换动作。合法公开动作一键提案稳定放行，真正不存在的幻觉动作 ID（无论对象或字符串形态）依然 100% 拦截降级。
- **失败模式与降级兜底**：真正不存在于 5,600+ 词库与用户自定义动作集合中的 ID 仍被 `validateReview` 拒绝并安全降级为 `fallback_notice`。

### 子系统：`web-client`（问题 2：时间线倒挂修复 + 问题 3：精细化骨架屏与过渡动画）
- **涉及模块与入口**：[`frontend/src/views/CoachChat.jsx`](../../../../frontend/src/views/CoachChat.jsx)、[`frontend/src/components/CoachGenUI.jsx`](../../../../frontend/src/components/CoachGenUI.jsx)、[`frontend/src/coach.css`](../../../../frontend/src/coach.css)、[`frontend/src/components/CoachGenUI.test.jsx`](../../../../frontend/src/components/CoachGenUI.test.jsx)、[`frontend/src/views/CoachChat.test.jsx`](../../../../frontend/src/views/CoachChat.test.jsx)
- **触发条件（Trigger）**：
  - 问题 2：用户在存在未确认 `pending` 卡片（`DebriefCard` / `ReviewCard` / `PlanCard` / `AdaptProposal`）时继续在聊天框发起新的自由对话。
  - 问题 3：用户发送自由提问进入 AG-UI 流式等待及卡片逐块渲染过程。
- **改前 / 改后行为（Before / After）**：
  - **Before**：未确认的 `pending` 卡片硬编码在消息列表最末尾，后续新对话插到其上方导致时间线倒挂；流式期间无卡片骨架占位，组件直接生硬弹出。
  - **After**：`pending` 卡片按 `createdAt` 精确锚定在时间线原始位置（后续新消息永远排在下方）；流式等待阶段渲染与真实卡片结构一致的多形态呼吸骨架屏（`GenUISkeleton`），流式文本气泡带轻柔光标，各张 GenUI 卡片以交错上浮淡入动效平滑呈现（遵守 `prefers-reduced-motion`）。
- **失败模式与降级兜底**：若 `pending.createdAt` 缺失则安全回退到列表末尾；所有动效在 `prefers-reduced-motion: reduce` 下自动关闭，不破坏既有 5 组 `CoachChat` 测试与 19 语种门禁。

---

## 2. 并行子 Agent 任务拆分（零文件重叠）

### Task P1（后端：问题 4 校验器加固与专项回归测试）
- **独占文件**：
  - `api/src/agent/coach-genui.service.ts`
  - `api/test/nest/coach-genui-sse.test.js`
- **验收命令**：
  - `npm.cmd --prefix api run build`
  - `node api/scripts/test-nest.mjs test/nest/coach-genui-sse.test.js`

### Task P2（前端：问题 2 时间线顺序 + 问题 3 精细骨架屏与动效 + 专项单测）
- **独占文件**：
  - `frontend/src/components/CoachGenUI.jsx`
  - `frontend/src/views/CoachChat.jsx`
  - `frontend/src/coach.css`
  - `frontend/src/components/CoachGenUI.test.jsx`
  - `frontend/src/views/CoachChat.test.jsx`
- **验收命令**：
  - `cd frontend; npx.cmd vitest run src/components/CoachGenUI.test.jsx src/views/CoachChat.test.jsx src/views/CoachChat.fast-failure.test.jsx src/views/CoachChat.refusal.test.jsx src/views/CoachChat.demo-failure.test.jsx src/views/CoachChat.settled-elsewhere.test.jsx`
  - `cd frontend; node scripts/check-locales.mjs; node scripts/check-source-strings.mjs --strict; npm.cmd run build`

---

## 3. 收尾集成与实测证据（主协调者）
- **P1 实测通过**：`npm.cmd --prefix api run build`（`build: dist ready`）+ `node api/scripts/test-nest.mjs test/nest/coach-genui-sse.test.js`（**10/10 通过**，含测试 9 裸字符串 `after` 规范化放行 + 测试 10 对象/字符串形态幻觉 ID 严格拦截）。
- **P2 实测通过**：Vitest **6 文件 / 40 用例全绿**（含新增 3 项 `GenUISkeleton`/交错入场测试 + 2 项 `CoachChat` `pending` 时间线锚定回归测试）；`check-locales.mjs`（19 语种 / 3732 键同步）；`check-source-strings.mjs --strict`（3079 词条全绿）；`npm.cmd run build` 成功。
- **治理门禁**：`.\.agent\scripts\verify-governance.ps1` 全绿。
- **真实全栈重启**：已重启最新编译的 NestJS DeepSeek 后端（`:3000`）与非 Demo Vite 前端（`:5173`）。
