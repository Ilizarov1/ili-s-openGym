# RN 客户端接入 AI Coach GenUI（`rn-coach-genui`）— 执行计划

- **关联设计**：[`DESIGN.md`](./DESIGN.md)
- **工作树规范**：严格遵循 [`docs/code-standards.md`](../../../docs/code-standards.md) `[L-001]` / `[L-003]` / `[L-004]` 与 [`.agent/lessons.md`](../../../lessons.md) `L-010` / `L-011`：
  - 在短路径工作树 `D:\wt\rn-coach-genui`（分支 `feat/rn-coach-genui`）内开发；
  - UI 调试阶段全程使用 **Debug APK + Metro 热更新**，严禁每改一行 UI 就重编 Release APK；
  - 交付前必须通过 `npm.cmd run check`、真实模拟器 + 真实 DeepSeek 多轮闭环验收，并录制操作 GIF 归档至 `evidence/`。

---

## 阶段拆解（可并行拆分指导）

### Phase 0：前置核查与短路径工作树初始化
1. 核实后端 `POST /api/agent/coach/stream` 与 `GET /api/config` 对手机配对 `Authorization: Bearer <token>` 的鉴权兼容性（写一条 API 集成测试覆盖 Bearer Token 流式调用，若有缺口当场补齐）。
2. 在短路径 `D:\wt\rn-coach-genui` 创建工作树并验证基线 `cd mobile-rn; npm.cmd run check` 全绿。

### Phase 1：RN 数据层、SSE 流式客户端与同步意图（无 UI，可独立单测）
> **并行组 A（网络与协议桥接）**：
1. **`mobile-rn/src/agent/coach-stream.ts`**：
   - 实现纯函数 `createSseFrameParser()`（处理分片、CRLF/LF、UTF-8 多字节、心跳行）；
   - 实现 `streamCoachGenUI({ connection, text, formSubmission, history, plan, lang, today, signal, onEvent })`，优先 `expo/fetch` 流式读取，自动降级 `XMLHttpRequest` `onprogress` 增量切片，完整处理 `429 turn_limit`、`404/503` 与 `AbortSignal`。
2. **`mobile-rn/src/agent/coach-bridge.ts`**：
   - 复用 `api/agent-runtime/genui/` 常量与 `frontend/src/lib/coach-genui-hydration.js` 纯函数水合逻辑；
   - 实现类型安全的 `pruneClearedChat`、`countGenUITurns`、`buildGenUIHistory`（严格输出合法 NDJSON，遵循 `L-009`）、`hydrateCoachTrend`、`hydrateCoachMuscleLoad`、`hydrateCoachKpi`；
   - 实现动作本地化名解析（内置词库 + `profile.customEx` 自定义动作名）。
3. **单元测试**：`mobile-rn/scripts/coach-stream.test.mjs`（覆盖 SSE 分片解析、`429`、中止、`buildGenUIHistory` NDJSON 输出与 `pruneClearedChat`）。

> **并行组 B（类型、同步意图与应用/撤销引擎）**：
4. **`mobile-rn/src/training.ts`**：扩展 `Profile` 类型，补充 `CoachState`、`CoachChatMessage`、`CoachProposalChange` 等严格 TypeScript 定义（零 `any`）。
5. **`mobile-rn/src/profileChanges.ts`**：
   - 新增 5 个可重放意图：`coachChatAppend`、`coachChatClear`、`coachProposalApplied`、`coachApplyProposal`、`coachRevertLast`；
   - 接入 `frontend/src/lib/coach.js` 的 `applyChangeSet` / `revertLast`（或纯 TS 等价实现，确保与 Web 共享快照 `coach.snapshots`、`coach.log`、`routines`、`week` 结构）；
   - 严格落位 5 切面防复活检查（`L-010`）：`coachChatClear` 单调推进 `chatClearedAt`、`coachChatAppend` 保证 `at > chatClearedAt` 并裁切旧记录、`synchronize()` 合并远端快照后持续强制单调水位。
6. **单元测试**：`mobile-rn/scripts/coach-profile-changes.test.mjs`（覆盖 `add-routine` + `weekdays` 应用与 `coachRevertLast` 回滚、`coachChatClear` 跨同步不复活、`coachProposalApplied` 幂等重放）。

### Phase 2：GenUI 原生渲染组件库（`mobile-rn/src/coach/`）
> 严格遵守 `src/design/` Token 规范与 ESLint 规则（零裸色值/裸像素、零 `react-native` 原生文本/按钮直接导入）：
1. **`mobile-rn/src/coach/StreamStepsBar.tsx`**：流式阶段指示条 + `search_catalogue` 检索态 + 「停止」按钮。
2. **`mobile-rn/src/coach/ProposalActionNode.tsx`**：
   - 渲染常规计划修改 diff（`before → after`）；
   - 渲染 `add-routine` 专属预览（周几胶囊 + 动作中文名 + `tabular-nums` 组次/时长列表）；
   - 勾选状态管理、一键应用回调、已采纳态、撤销提示文案。
3. **`mobile-rn/src/coach/DataVisualNodes.tsx`**：
   - `ExerciseTrendNode`（复用 `LineChart` + `Segmented` 指标/周期纯本地切换）；
   - `MuscleLoadNode`（复用 `BodyMap` + `Segmented` `72h/7d/28d` 本地切换）；
   - `KpiStripNode`（复用 `StatTile`）、`ComparisonTableNode`、`AlternativesNode`（复用 `ExerciseMedia`）、`QuickFormNode`（复用 `Chip` + 尺度选择）。
4. **`mobile-rn/src/coach/GenUIBriefing.tsx`**：统一按顺序渲染 `nodes[]` 与 `pendingNode` 骨架占位，兼容旧 `checklist` 只读编号列表。

### Phase 3：Coach 对话屏、导航入口与深链（`mobile-rn/src/screens/` & `App.tsx`）
1. **`mobile-rn/src/screens/CoachChatScreen.tsx`**：
   - 顶部 `Header`（返回 + 教练标题/状态 + `...` 菜单触发 `ActionSheet`：新对话 / 撤销教练上次的更改 / Agent 设置）；
   - 未配对时展示 `EmptyState` + 「去扫码配对」按钮；
   - 对话流采用稳定 `key={m.id}` 列表，底部 `KeyboardAvoidingView` 包裹：快捷胶囊行（`检查我的训练`、`上次训练`、`改进一个计划`（仅当 `routines.length > 0`）、`新对话`（仅当 `userTurns > 0 && !turnLimitReached`））+ `N/10 轮` 计数 + 固定不卸载 `TextField` + 发送按钮；
   - `chatGenRef` 代次守卫（点击「新对话」或离开会话时中止并废弃旧流残留）；
   - 0 计划账号直接走 GenUI 流式对话（不复刻 Web 旧版 `refinePlan` 劫持）。
2. **`mobile-rn/App.tsx`、`HomeScreen.tsx`、`PlanScreen.tsx`**：
   - `Panel` 联合类型新增 `{ kind: 'coach' }`；
   - 注册深链 `opengym://coach`（支持 `e2e=1`）；
   - 在 `HomeScreen` 与 `PlanScreen` 增加自然入口卡片/按钮打开 Coach。
3. **静态门禁全绿**：
   - 运行 `cd mobile-rn; npm.cmd run check`（`eslint` + `lint:rules` + `tsc --noEmit` + `design:check`）全部 0 错误。

### Phase 4：Android 模拟器真实模型 4 维硬验收 & GIF 录屏
> 遵循 `[L-003]` / `[L-004]` / `[L-011]` 与 `mobile-rn` 设备申领规范：
1. 启动本地开发 API（`node scripts/dev.mjs`，配好 DeepSeek `deepseek-flash` 与 `adb reverse tcp:3000 tcp:3000`），启动 Metro 服务。
2. 原子申领 Android 模拟器（`agent-device open ... --serial <id>`），使用配对账号登录（测试 **0 计划 / 351 条历史记录** 与 **已有计划** 两类账号）。
3. 逐项实测 4 维验收清单：
   - **流式体验**：验证真机/模拟器上逐字流式出现（非整段卡顿后一次性蹦出）与 `search_catalogue` 工具提示；
   - **0 计划分析 & 新建计划全闭环**：发「分析下我最近的训练」→ 图表/肌群图本地交互切换（切换周期不发网络请求）→ 发「帮我新建一个胸肩推日计划（周一、周四）」→ 预览动作与排期 → 点击应用 → 切到「计划」Tab 核查生效 → 强杀重启 App 验证 SQLite 持久化仍在 → 菜单点击「撤销教练上次的更改」核查回滚；
   - **多轮 & 软键盘焦点**：连续追问 ≥ 3 轮无 `[Shown ...]` 方括号退化；软键盘弹出/收起与流式刷新期间输入框无失焦、无横向溢出；
   - **跨端同步 & 新对话防复活**：在 RN 点「新对话」后发新消息，再在 Web 端打开同一账号核查聊天同步一致、旧记录不复活。
4. 使用 `.agent/scripts/record-gif.ps1 -Serial <id> -Out .agent/notes/proposed/rn-coach-genui/evidence/rn-coach-genui-e2e.gif` 录制真实操作 GIF，并编写 `ACCEPTANCE.md`。
5. （按需）仅在所有交互与视觉确认定稿后执行一次双架构 Release APK 构建与验签。

---

## 预期改动文件清单

| 子系统 | 文件 | 改动摘要 |
|---|---|---|
| `mobile-rn` | `mobile-rn/src/agent/coach-stream.ts` | AG-UI SSE 流式客户端（`expo/fetch` + XHR 兜底） |
| `mobile-rn` | `mobile-rn/src/agent/coach-bridge.ts` | 历史 NDJSON 序列化、本地水合桥、应用/撤销桥与本地化名 |
| `mobile-rn` | `mobile-rn/src/training.ts` | 扩展 `Profile.coach` 严格 TS 类型 |
| `mobile-rn` | `mobile-rn/src/profileChanges.ts` | 新增 5 个 Coach 可重放同步意图与单调 `chatClearedAt` |
| `mobile-rn` | `mobile-rn/src/coach/*.tsx` | `StreamStepsBar`、`ProposalActionNode`、`DataVisualNodes`、`GenUIBriefing` |
| `mobile-rn` | `mobile-rn/src/screens/CoachChatScreen.tsx` | AI Coach 原生对话主屏（键盘/热区/10 轮/胶囊/代次守卫） |
| `mobile-rn` | `mobile-rn/App.tsx`、`HomeScreen.tsx`、`PlanScreen.tsx` | 新增 `coach` 面板、深链 `opengym://coach` 与主入口 |
| `mobile-rn` | `mobile-rn/scripts/coach-*.test.mjs` | SSE 解析、历史序列化、同步意图、应用与撤销单测 |
| `api-sync`（核查） | `api/test/nest/coach-genui-sse.test.js` | 补充手机配对 Bearer Token 调用 `/api/agent/coach/stream` 测试 |
