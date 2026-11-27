# Coach GenUI 新建计划打通方案（`coach-genui-create-plan`）— 设计文档

- **生命周期**：`proposed`
- **日期**：2026-11-27
- **目标**：彻底打通 GenUI 流式链路对「新建训练计划（单日/多日 Routine + 周历排期）」的原生支持，移除 `CoachChat` 中“0 计划强行劫持到旧版 `refinePlan`”的遗留分支，让无计划新账号（含从外部导入历史记录但 0 routine 的账号）既能正常分析训练，也能在对话中直接生成可预览、可勾选、可一键应用、可一键撤销的新建计划提案卡片。

---

## 1. 问题背景与目标边界

### 1.1 现状问题
1. **0 计划账号对话被旧分支劫持**：[CoachChat.jsx](file:///D:/dev/open-gym/frontend/src/views/CoachChat.jsx#L482-L492) 存在遗留判断 `if (pending?.kind === 'create' || !(S.routines || []).length)`。一旦账号 `routines.length === 0`（例如导入了 351 条训练记录但尚未建模板的新账号），任意提问都被静默路由至旧版 `POST /api/coach/plan`（`refinePlan`），绕过 GenUI 流式链路；在仅配置了新 Agent 模型的环境下直接报「应用无法使用教练给出的回答」。
2. **GenUI 链路存在 4 处阻断 `add-routine` 的卡点**：
   - `coach-genui.service.ts`：`normalizeCoachPlan` 将 `routines: []` 视为 `null`，`verifyProposalNode` 见 `!state.plan` 直接降级提案；且 `inspectContext` 未向模型暴露最近训练过的动作 ID，导致 0 计划账号分析训练缺少动作锚点。
   - `protocol.js`：`validateChange` 强制 `target` 非空、`cleanChangeValue` 丢弃嵌套对象数组 `after.ex` 及数字数组 `after.weekdays`，直接洗掉 `add-routine`。
   - `coach-genui.js`：System Prompt 未说明 `add-routine` 的字段契约与周历排期写法。
   - `CoachGenUI.jsx` & `coach.js`：`ProposalActionBlock` 渲染 `add-routine` 时只展示标题和理由，无法预览计划内的动作清单、组次与周几安排；`CHANGE_APPLY['add-routine']` 也未写入可选 `weekdays` 周历排期。

### 1.2 本期范围与非目标
- **本期包含**：
  - 放行 `routines: []` 账号走 GenUI 流式分析与新建计划提案；
  - 打通 `proposal_action` 内的 `add-routine` 全链路（协议 → 模型提示词 → 后端白名单校验 → 前端完整预览渲染 → 一键应用至 `routines` + `week` → 一键撤销）；
  - 将「开始新计划」菜单入口切到 GenUI 流式路径；
  - 保留对历史上已存在的 `pending?.kind === 'create'` 兼容渲染与 `refinePlan` 处理（仅在真有旧挂起提案时触发，避免破坏老数据）。
- **非目标**：
  - 不删除旧版后端 `/api/coach/plan` 路由或 `PlanCard` 组件（保持 OpenAPI 与老客户端向后兼容）；
  - 不改变现有 `applyChangeSet` 的原子事务模型与 `sync-merge.js` / `api/sync-stamps.js` 同步数据结构。

---

## 2. 按受影响子系统的语义级变更声明

### 2.1 `ai-agent`（`api/agent-runtime/` + `api/src/agent/` + `api/coach/core/`）
- **触发条件（Trigger）**：
  1. 任意账号（包括 `routines: []`）调用 `POST /api/agent/coach/stream`；
  2. 模型在 NDJSON 中输出 `type: "proposal_action"` 且包含一个或多个 `type: "add-routine"` 变更。
- **改前行为（Before）**：
  - `normalizeCoachPlan` 遇到 `routines: []` 返回 `null`；`verifyProposalNode` 拒绝一切提案并降级为 `fallback_notice`；
  - `inspectContext` 仅打印 `no synced plan` 与训练场次数，不提供最近训练动作 ID；
  - `protocol.js` 的 `validateChange` 因 `target: {}` 返回 `null`、`cleanChangeValue` 丢弃 `after.ex` 与 `after.weekdays`，节点在解析阶段即被丢弃；
  - `validateReview` 校验 `add-routine` 时忽略 `after.weekdays`。
- **改后行为（After）**：
  - `normalizeCoachPlan` 区分“未传 plan 对象（`null`）”与“已同步的空计划（`{ routines: [], week: {} }`）”；当客户端或存储态明确给出 `routines: []` 时返回空计划对象，`verifyProposalNode` 正常进入 `validateReview`；
  - `inspectContext` 在有训练记录时追加最近训练的高频动作清单（最多 12 个 `id "本地化名称"`），并在 `routines.length === 0` 时明确告知模型当前无计划模板，可直接分析训练或用 `add-routine` 新建计划；
  - `protocol.js` 放行 `add-routine`（及 `programme`）的空 `target: {}`，并为 `add-routine` 新增类型感知清洗 `cleanAddRoutineAfter`：完整保留 `name`、`emoji`、`prog`、`weekdays`（`0..6` 去重整数数组）与 `ex`（最多 16 个动作对象，保留 `id`/`sets`/`mode`/`reps`/`sec`/`min`/`speed`/`repsMin`/`repsMax`/`setsMax`/`prog`/`inc`/`bodyweight`/`side`）；
  - `validate.js` 在 `case 'add-routine'` 中清洗并校验可选 `after.weekdays`（`0..6` 整数去重），并在交叉校验中阻止同一次提案内两个 `add-routine` 冲突占同一星期几（允许空数组/缺省表示仅建模板不排周历）；
  - `coach-genui.service.ts` 的 `normalizeProposalChanges` 对 `add-routine` 做容错规整（缺省 `target` 补 `{}`；`ex[i].exId` 兼容映射到 `ex[i].id`；`reps: "8-12"` 字符串区间拆为 `repsMin: 8, repsMax: 12, reps: 10`），仍严格走 `validateReview` 词库白名单校验；
  - `coach-genui.js` 的 System Prompt 补充 `add-routine` 字段说明与使用指引（强调库外动作必须先调 `search_catalogue` 获取真实 ID）。
- **接口、状态与兼容性**：
  - `POST /api/agent/coach/stream` HTTP 路由、SSE 事件名及既有 `proposal_action` 节点类型不变；`add-routine.after.weekdays` 为向后兼容可选字段；
  - 若模型在 0 计划账号上误发修改已有计划的变更（如 `sets`、`swap-exercise`），`validateReview` 仍严格因 `routineId` 不存在而拦截降级为 `fallback_notice`，安全性不降级。
- **失败模式**：
  - 若模型编造不存在的动作 ID，`validateReview` 的 `knownEx(e.id)` 拒绝整条提案并降级为中文说明型 `fallback_notice`，绝不向客户端下发坏动作；
  - 若单个 `proposal_action` 超过 `MAX_ROUTINES`（7）或单日动作超过 `MAX_EX_PER_ROUTINE`（16），由 `validateReview` 拦截并降级。

### 2.2 `web-client`（`frontend/src/views/CoachChat.jsx` + `CoachGenUI.jsx` + `lib/coach.js` + `coach.css` + `locales/`）
- **触发条件（Trigger）**：
  1. 用户在 Coach 聊天框发送消息（不论 `S.routines` 是否为空）；
  2. 用户点击右上角菜单「开始新计划」；
  3. 聊天流收到含 `add-routine` 的 `proposal_action` 节点，用户预览、勾选并点击「应用」或随后点击「撤销教练上次的更改」。
- **改前行为（Before）**：
  - `S.routines.length === 0` 时发送任何消息都会被劫持到旧版 `refinePlan(msg)`；
  - 菜单「开始新计划」调用旧版 `requestPlan(coach.profile)`；
  - `ProposalActionBlock` 对 `add-routine` 仅显示标题「新增计划“XXX”」与 `why`，不展示动作明细与排期；
  - `CHANGE_APPLY['add-routine']` 只写入 `s.routines`，不处理 `weekdays`；
  - `compactHistoryNode` 保留完整 `changes`，需确保 `add-routine` 序列化不超长且保持合法 NDJSON。
- **改后行为（After）**：
  - `CoachChat.jsx` 的 `send()` 仅在 `pending?.kind === 'create'` 时走 `refinePlan(msg)`，移除 `|| !(S.routines || []).length` 劫持；
  - 菜单「开始新计划」改为通过 `runStream` 发送一条带档案意图的流式新建计划请求（流式不可用时仍回落至 `requestPlan`）；
  - `ProposalActionBlock` 对 `change.type === 'add-routine'` 渲染专属紧凑预览区：顶部显示标题（含 emoji）与排期胶囊（如「周一 · 周四」），下方以紧凑编号行展示每个动作的本地化名称（`exTitle(e.id)`）与处方（如 `4×6-10`、`3×10`、`3×45秒`、`20分钟`）；
  - `CHANGE_APPLY['add-routine']` 创建新 routine 后，若 `Array.isArray(a.weekdays)` 非空，按周历写入 `s.week[d] = [newRoutine.id]`（若该天原本为空则直接排入；若该天已有计划则覆盖该天槽位，与 `CHANGE_APPLY.week` 语义一致；且在 `rotation` 模式下保持现行不越权改队列原则）；由于 `applyChangeSet` 先调用 `pushSnapshot(s)`（快照同时保存 `routines` 与 `week`），「撤销教练上次的更改」天然一次性回滚新增计划与周历；
  - 若需要新增任何用户可见英文 key，同步补齐 `frontend/src/locales/` 全部 19 个语言文件并通过 `check-locales.mjs` 与 `check-source-strings.mjs --strict`。
- **接口、状态与兼容性**：
  - 历史 `coach.chat` 中已有的 `proposal_action` 与旧 `PlanCard`（当服务端存在遗留 `pending.kind === 'create'`）完全兼容；
  - 不修改 `sync-merge.js` 合并结构，新增的 `routines` 与 `week` 自动走既有的 `stampChange`（`stampRoutines` + `week.<d>` 逐日时间戳）多端同步。

---

## 3. 关键数据结构与协议设计

### 3.1 `add-routine` 变更节点契约（NDJSON）

```json
{
  "type": "proposal_action",
  "id": "prop_plan_1",
  "title": "三分化推拉腿新计划",
  "summary": "基于你近期的卧推与划船训练基础，整理为每周三练的推/拉/腿模板。",
  "changes": [
    {
      "id": "c1",
      "type": "add-routine",
      "target": {},
      "why": "以你熟悉的卧推为核心，补齐上胸与肩中束刺激。",
      "after": {
        "name": "推日（胸肩三头）",
        "emoji": "🏋️",
        "weekdays": [1],
        "ex": [
          { "id": "0025", "sets": 4, "reps": 8, "repsMin": 6, "repsMax": 10 },
          { "id": "0047", "sets": 3, "reps": 10, "repsMin": 8, "repsMax": 12 },
          { "id": "0334", "sets": 3, "reps": 15, "repsMin": 12, "repsMax": 15 }
        ]
      }
    }
  ]
}
```

### 3.2 `cleanAddRoutineAfter`（`api/agent-runtime/genui/protocol.js`）
- 仅在 `type === 'add-routine'` 时启用（避免放宽其他 scalar/flat 类型的清洗边界）：
  - `name`：非空裁剪字符串（≤ 40 字符）
  - `emoji`：可选短字符串（≤ 16 字符）
  - `prog`：可选字符串（≤ 32 字符）
  - `weekdays`：可选整数数组，过滤 `0..6` 并去重，最多 7 项
  - `ex`：对象数组（最多 16 项），每项清洗 `id`（允许 `exId` 兼容别名，裁剪至 40 字符）、`sets`、`mode`、`reps`、`repsMin`、`repsMax`、`setsMax`、`sec`、`min`、`speed`、`prog`、`inc`、`bodyweight`、`side`

### 3.3 `validateReview` 校验扩展（`api/coach/core/validate.js`）
- `case 'add-routine'`：
  - 若提供 `a.weekdays`，验证为数组，提取 `isInt(d, 0, 6)` 去重后写入 `out.after.weekdays`（若数组非空但全部非法则报错，若为空数组则省略）；
  - 交叉校验：用 `addedWeekdays = new Set()` 追踪本次提案内所有 `add-routine` 声明的周几，若两个 `add-routine` 声明了同一天则报错，避免互相覆盖。
- `MAX_CHANGES` 与 `MAX_ROUTINES`：
  - `protocol.js` 的 `proposal_action.changes` 上限保持 `6`（可一次创建 1~6 天分化计划，覆盖全部分化场景且不超过 `MAX_ROUTINES = 7`）。

### 3.4 前端预览卡片 UI 设计（九维审查前置）
1. **信息层级**：每个 `add-routine` 条目内，主标题为 `新增计划“推日（胸肩三头）”`（带 emoji 徽章），紧随其后是一行排期标签（如 `周一 · 周四`），再下方是浅一层背景（`var(--surface-2)`）的动作列表预览区，最底为 `why` 理由。
2. **动作处方格式化**：
   - `reps` 模式：有 `repsMin`/`repsMax` 时显示 `{sets}×{repsMin}-{repsMax}`，否则 `{sets}×{reps}`；
   - `time` 模式：`{sets}×{sec}s`；
   - `cardio` 模式：`{min} min`（有 `speed` 时附速率）；
   - 每行 `display: flex; justify-content: space-between; gap: 8px; min-width: 0`，动作名左侧 `overflow-wrap: anywhere` 不截断关键信息，处方右侧 `flex: none; font-variant-numeric: tabular-nums` 对齐。
3. **窄屏适配（375px / 430px）**：单列堆叠、禁止横向溢出；勾选框（`Check`）与「应用 N 项更改」按钮保持 ≥ 44px 触控热区。
4. **已采纳态 & 刷新持久**：采纳后标记 `applied: true`，卡片切换为「✓ 已采纳」，刷新后依然保留完整动作预览供回看；右上角菜单「撤销教练上次的更改」可一键同时撤销新增的 `routines` 与 `week`。

---

## 4. 风险与防护

| 风险 | 影响 | 防护措施 |
|---|---|---|
| 模型输出 `add-routine` 时编造动作 ID 或漏调 `search_catalogue` | 提案被白名单拒绝 | Prompt 明确要求先调 `search_catalogue`，`inspectContext` 预供近期高频动作 ID，**写 UI 前先跑真实 DeepSeek 探针**验证成功率 |
| 多日计划 NDJSON 单行偏长导致流式解析/历史截断 | 节点截断或 Turn 2 上下文丢失 | 确认 `MAX_LINE_CHARS`（`ndjson-parser.js`）足以容纳 6 天计划单行 JSON；`compactHistoryNode` 保留精简 `add-routine` 结构并适配预算 |
| 0 计划用户被模型误发修改类变更（`sets`/`swap-exercise`） | 应用崩溃 | `validateReview` 严格校验 `routineId` 存在性，不存在一律降级为 `fallback_notice` |
| 撤销新建计划后 `week` 残留悬空 routineId | 周历指向不存在的计划 | 验证 `pushSnapshot` + `revertLast` 完整恢复 `routines` 与 `week`，并在单测与浏览器中实测应用→撤销闭环 |
