# Coach GenUI 新建计划打通方案（`coach-genui-create-plan`）— 执行计划

- **关联设计**：[`DESIGN.md`](./DESIGN.md)
- **执行纪律**：严格遵循 [`.agent/lessons.md`](../../../lessons.md) 中的 `L-008` ~ `L-011`——**先跑真实 DeepSeek 探针验证协议与 Prompt，再写前端 UI，最后用真实浏览器 4 维清单 + 双标签页 + 刷新闭环验收**。

---

## 阶段拆解

### Phase 1：协议层与后端校验/上下文打通（`api/`）
1. **检查 `ndjson-parser.js` 单行上限**：确认多日 `add-routine` JSON 行（3~4 个 routine × 5 个动作 ≈ 2~3 KB）不会被行长限制误截断。
2. **更新 `api/agent-runtime/genui/protocol.js`**：
   - `validateChange`：允许 `type === 'add-routine'`（及 `'programme'`）使用空 `target: {}`；
   - 新增 `cleanAddRoutineAfter`，完整清洗并保留 `name`、`emoji`、`prog`、`weekdays`（`0..6`）与 `ex` 数组（最多 16 个动作对象）。
3. **更新 `api/coach/core/validate.js`**：
   - `case 'add-routine'` 支持可选 `after.weekdays`（`0..6` 整数去重，非法报错），并在提案级交叉校验禁止两个 `add-routine` 冲突占同一周几。
4. **更新 `api/src/agent/coach-genui.service.ts`**：
   - `normalizeCoachPlan`：当输入对象包含数组类型 `routines`（哪怕长度为 0）时返回 `{ routines: [], week, customIds, programmes }`，仅当输入非对象/无 plan 数据时返回 `null`；
   - `inspectContext`：在 `routines.length === 0` 时输出清晰的 0 计划提示，并汇总最近训练记录中出现频率最高的前 12 个动作（`id "本地化名"`），为 0 计划老记录账号提供 grounded 锚点；
   - `normalizeProposalChanges`：对 `add-routine` 补齐默认 `target: {}`，兼容 `ex[i].exId -> id` 与字符串 `"8-12"` 区间拆分。
5. **更新 `api/agent-runtime/tasks/coach-genui.js`**：
   - System Prompt 补充 `add-routine` 节点说明（含 `weekdays` 与 `ex` 字段示例），指引模型新建计划时先利用上下文已有动作或调用 `search_catalogue` 获取合法 ID。
6. **后端单测与构建**：
   - 补充 `api/test/coach-genui-protocol.test.js`（`add-routine` 空 target、嵌套 `ex`、`weekdays` 清洗与边界测试）；
   - 补充 `api/test/nest/coach-genui-sse.test.js`（0 计划账号通过 `add-routine` 提案、0 计划账号误发 `sets` 仍被拦截降级）；
   - 补充 `api/coach/core/validate.js` 对应单测（`add-routine` `weekdays` 校验与冲突拒绝）；
   - 运行 `npm.cmd --prefix api run build` 与 `node --test` 全绿。

### Phase 2：真实 DeepSeek 探针门禁（写前端 UI 前必过）
> 按 `L-011` 铁律：在写任何前端 UI 之前，先用真实 DeepSeek（`deepseek-flash`）针对 351 条记录 / 0 计划的新账号直连 `/api/agent/coach/stream` 跑 5 条探针用例，核查真实 SSE 输出与校验结果：
1. **探针 1（0 计划纯分析）**：「分析下我最近的训练」→ 验证能产出基于 351 条真实记录的趋势/负荷卡片，且不强塞无关提案；
2. **探针 2（0 计划新建单日计划）**：「帮我新建一个胸肩推日计划，安排在周一和周四」→ 验证模型调用 `search_catalogue`（如需）并产出通过 `validateReview` 的 `proposal_action`（`type: "add-routine"`, `weekdays: [1, 4]`, 全部 `ex[].id` 合法）；
3. **探针 3（0 计划新建多日分化计划）**：「根据我最近的训练记录，帮我建一套一周三练的推拉腿计划」→ 验证单张卡片内产出 3 条 `add-routine`、排期不冲突且全部通过校验；
4. **探针 4（多轮追问调整新建计划）**：在探针 2 基础上第 2 轮追问「把其中一个动作换成哑铃飞鸟，再给我确认」→ 验证 Turn 2 保持合法 NDJSON，无 `[Proposal: ...]` 方括号退化；
5. **探针 5（有计划账号回归）**：「帮我分析上斜卧推是否停滞」→ 确认原有账号体验无退化。

若任一探针暴露模型字段习惯偏差，在 Phase 2 当场调优 Prompt / 规整器并重测通过后再进入 Phase 3。

### Phase 3：前端引擎、预览卡片与路由切换（`frontend/`）
1. **`frontend/src/lib/coach.js`**：
   - `CHANGE_APPLY['add-routine']`：新建 routine 并按 `after.weekdays` 写入 `s.week[d] = [id]`；
   - 确认 `pushSnapshot` + `revertLast` 能完整回滚新增的 `routines` 与 `week`。
2. **`frontend/src/components/CoachGenUI.jsx` & `frontend/src/coach.css`**：
   - 为 `ProposalActionBlock` 新增 `add-routine` 专属预览组件（展示 emoji + 名称、周几排期标签、动作本地化名 + 组次/时长处方列表）；
   - 核查九维 UI 规范（窄屏 375px/430px 无溢出、数字等宽对齐、热区 ≥ 44px、暗色/浅色主题 Token 一致）。
3. **`frontend/src/views/CoachChat.jsx`**：
   - `send()`：移除 `|| !(S.routines || []).length`，仅在 `pending?.kind === 'create'` 时走 `refinePlan(msg)`；
   - 菜单「开始新计划」(`askNewPlan`)：改为走 `runStream` 流式建计划（流式不可用时回落至 `requestPlan`）；
   - `compactHistoryNode`：确保历史中的 `add-routine` 节点保留精简 `name`/`weekdays`/`ex` 并输出合法 NDJSON。
4. **多语言与前端单测**：
   - 若新增任何 `t()` 文案，同步补齐 `frontend/src/locales/` 全部 19 个语种并跑 `check-locales.mjs` + `check-source-strings.mjs --strict`；
   - 补充 `CoachChat.test.jsx`（0 计划账号走流式对话不劫持到 `refinePlan`）、`CoachGenUI.test.jsx`（`add-routine` 完整预览渲染、应用写入 `routines` + `week`、撤销回滚）、`coach.test.js`（`add-routine` 含 `weekdays` 应用与 `revertLast` 回滚）；
   - 运行 Vitest 全量相关测试 + `npm.cmd --prefix frontend run build`。

### Phase 4：真实浏览器 4 维硬验收与证据归档
> 按 `L-010` / `L-011` 与前端硬验收规范，在真实开发服务 + 真实 DeepSeek + `ego-browser` 下完整跑通：
1. **351 条记录 / 0 计划新账号实测**：
   - 发送「分析下我最近的训练」→ 验证图表真实水合、无报错；
   - 发送「根据我最近的训练，帮我建一套一周三练的推拉腿计划」→ 验证卡片展示完整动作清单 + 周几排期；
   - 点击「应用」→ 切到计划页 `#/plan` 核查新计划与周历真实生效；
   - 返回 `#/coach` 并 **`F5` 整页刷新** → 核查卡片显示「已采纳」且动作明细仍在；
   - 测试「撤销教练上次的更改」→ 核查 `#/plan` 新增计划与周历干净回滚。
2. **多轮 + 新对话并发态验证**：
   - 连续追问 ≥ 3 轮，核查每轮无纯文本/方括号泄漏；
   - 点击「新对话」后在双标签页下立即发新消息，采样流式过程 DOM 确认无旧历史闪现，同步落盘后 `F5` 刷新复核。
3. **录制实操 GIF 与验收报告**：
   - 录制「0 计划账号分析 → 生成新建计划卡片 → 一键应用 → 计划页生效」真实操作 GIF 存入 `.agent/notes/proposed/coach-genui-create-plan/evidence/`，并沉淀 `ACCEPTANCE.md`。
4. **治理自检**：运行 `.\.agent\scripts\verify-governance.ps1` 与 `node scripts/build-api-docs.mjs --check` 确认零告警。

---

## 预期改动文件清单

| 子系统 | 文件 | 改动摘要 |
|---|---|---|
| `ai-agent` | `api/agent-runtime/genui/protocol.js` | 放行 `add-routine` 空 `target`，新增 `cleanAddRoutineAfter` 保留 `ex` 与 `weekdays` |
| `ai-agent` | `api/agent-runtime/tasks/coach-genui.js` | System Prompt 补充 `add-routine` 契约与建计划指引 |
| `ai-agent` | `api/coach/core/validate.js` | `add-routine` 支持可选 `weekdays` 校验与同日冲突检测 |
| `ai-agent` | `api/src/agent/coach-genui.service.ts` | 允许 `routines: []` 建计划校验、`inspectContext` 补高频训练动作 ID、`add-routine` 规整 |
| `web-client` | `frontend/src/lib/coach.js` | `CHANGE_APPLY['add-routine']` 支持写入 `weekdays` 至 `s.week` |
| `web-client` | `frontend/src/components/CoachGenUI.jsx` | `ProposalActionBlock` 渲染 `add-routine` 动作明细与排期预览 |
| `web-client` | `frontend/src/coach.css` | 新增 `add-routine` 预览区样式（复用设计 Token） |
| `web-client` | `frontend/src/views/CoachChat.jsx` | 移除 `!(S.routines \|\| []).length` 劫持、「开始新计划」改走 GenUI、历史序列化兼容 |
| `web-client` | `frontend/src/locales/*.js` | 若有新增文案则同步 19 语种 |
| 测试 | `api/test/coach-genui-protocol.test.js`、`api/test/nest/coach-genui-sse.test.js`、`frontend/src/lib/coach.test.js`、`frontend/src/components/CoachGenUI.test.jsx`、`frontend/src/views/CoachChat.test.jsx` | 覆盖空计划流式、协议清洗、周历排期、预览渲染、应用与撤销全闭环 |
