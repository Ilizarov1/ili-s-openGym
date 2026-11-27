# `rn-coach-genui` Phase 3 — Coach chat screen, navigation & deep link

- 日期：2026-11-27
- 范围：`mobile-rn/src/screens/CoachChatScreen.tsx`（新增）、`mobile-rn/App.tsx`、`mobile-rn/src/screens/HomeScreen.tsx`、`mobile-rn/src/screens/PlanScreen.tsx`、`mobile-rn/src/screens/index.ts`（仅新增一行导出）
- 依据：[`DESIGN.md`](./DESIGN.md) §2.1 / §3.3、[`EXECUTION.md`](./EXECUTION.md) Phase 3、[`PHASE2_REPORT.md`](./PHASE2_REPORT.md)、[`frontend/src/views/CoachChat.jsx`](../../../../frontend/src/views/CoachChat.jsx)
- 未改动：`mobile-rn/src/coach/*`、`mobile-rn/src/agent/coach-stream.ts`、`mobile-rn/src/agent/coach-bridge.ts`、`mobile-rn/src/profileChanges.ts`、`mobile-rn/src/training.ts`、`api/*`、`frontend/*`（Phase 2 的 Props 接口与本屏用法完全一致，无需修正）

## 1. 文件清单

| 文件 | 改动 |
|---|---|
| `mobile-rn/src/screens/CoachChatScreen.tsx` | 新增：AI 教练对话主屏（流式、10 轮、快捷胶囊、键盘稳定输入栏、提案应用/撤销、菜单、未配对引导） |
| `mobile-rn/App.tsx` | `Panel` 新增 `{ kind: 'coach' }`；注册深链 `opengym://coach`；渲染 `CoachChatScreen`；向 `HomeScreen` / `PlanScreen` 传入 `onOpenCoach` |
| `mobile-rn/src/screens/HomeScreen.tsx` | 新增可选 `onOpenCoach` 与「AI 教练」入口卡片（`ListRow`，46dp 行高） |
| `mobile-rn/src/screens/PlanScreen.tsx` | 新增可选 `onOpenCoach` 与「AI 教练」入口行（`ListRow`，46dp 行高） |
| `mobile-rn/src/screens/index.ts` | 新增 `export * from './CoachChatScreen'`（沿用全部 screen 的集中导出约定） |

## 2. 导航、深链与入口

- **深链**：`opengym://coach`（`App.tsx` 的 `apply(url)` 解析，`route === 'coach'` → `setPanel({ kind: 'coach' })`）。`opengym://coach?e2e=1` 与其它面板一致地由既有 `params.e2e === '1'` 分支置 `e2e`，无需额外处理。
- **首页入口**：`HomeScreen` 中「本周还剩」卡片与「今日训练」小节之间的 `Card`+`ListRow`（`sparkles` 图标，标题「AI 教练」，副标题「分析训练、改进计划、从零新建计划」，`testID="home-open-coach"`）。
- **计划页入口**：`PlanScreen` 中 `Segmented` 之下、计划列表之上的同款入口行（副标题「分析训练、调整动作与排程」，`testID="plan-open-coach"`）。
- **接线**：`<CoachChatScreen profile={profile} connection={connection ?? null} commit={changes => gym.commit(changes)} onBack={closePanel} onOpenPair={() => setPanel({ kind: 'qrPair' })} onOpenAgent={() => setPanel({ kind: 'agent' })} />`。面板本身由既有 `Modal` 承载，硬件返回键走既有 `requestClosePanel`。

## 3. 屏幕行为（对齐 `CoachChat.jsx` + `coach-genui.controller.ts`）

### 3.1 头部与菜单
- `Header`：返回按钮 + 标题「AI 教练」+ 状态副标题（`正在回答…` / `本轮对话已达上限` / `随时为你分析训练`）+ 右侧 `...`（`IconButton name="more"`）。
- `ActionSheet`：
  - 「新对话」：`chatGenRef.current += 1` → `AbortController.abort()` → 清空 live/失败/提示/表单已提交态 → `commit([{ kind: 'coachChatClear', at: Date.now() }])`。
  - 「撤销教练上次的更改」：仅当 `canRevertCoach(profile)` 时出现；`commit([{ kind: 'coachRevertLast', at }])`，并追加一条 `kind: 'reverted'` 教练消息 + 提示卡「已撤销教练上次的更改。」。
  - 「Agent 设置」：`onOpenAgent()`（打开既有 `AgentScreen`）。

### 3.2 未配对
- `!connection` 时渲染 `EmptyState`（「先完成配对」+ 配对说明）+ 主按钮「去扫码配对」（`onOpenPair`）+ 次按钮「Agent 设置」。

### 3.3 流式发送（文本 / `formSubmission`）
1. 守卫：`runningRef`（同一时刻只跑一条流）、`turnLimitReached`。
2. `const gen = chatGenRef.current`，`const ctl = new AbortController()`。
3. `history = buildGenUIHistory(pruneClearedChat(chat, chatClearedAt), chatClearedAt)`——**在追加本条用户消息之前**取历史；重试沿用同一份历史。
4. 立即 `commit([{ kind: 'coachChatAppend', message: { role: 'user', kind: 'text', text, formSubmission? } }])`，`at = max(Date.now(), chatClearedAt + 1)`（L-010 水位守卫）。
5. `streamCoachGenUI({ connection: { server, token }, text, formSubmission?, history, plan: { routines, week }, lang: profile.lang || 'zh', today: localDate(Date.now()), signal, onEvent })`。
6. `onEvent` 与 `publish` 双重代次守卫：`chatGenRef.current !== gen` 时既不改累加器也不 setState。
   - `RUN_STARTED`：清空输入框（仅当草稿仍是本次发送的文本，避免覆盖新输入）。
   - `STEP_STARTED` / `STEP_FINISHED`：步骤条数据。
   - `TOOL_CALL_START`（`activeTool` + `args.query`）/ `TOOL_CALL_RESULT`：`search_catalogue` 检索态。
   - `TEXT_MESSAGE_CONTENT`：`prose_0` 增量。
   - `CUSTOM`：`genui.prose_delta`（按 `nodeId` 追加，`tone` 校验）、`genui.node_pending`、`genui.node_commit`（replace upsert，清 pending）、`genui.node_drop`、`genui.block_upsert`（merge upsert，同时进 `nodes`/`blocks`）。
   - `RUN_ERROR`：live 错误条。
7. 完成：优先 `RUN_FINISHED.nodes`，其次实时 `nodes`，最后 `blocks`；无节点但有文本时合成一个 `prose_0`；`commit([{ kind: 'coachChatAppend', message: { role: 'coach', kind: 'genui', nodes, text } }])`。
8. 用户点「停止」：中止；若代次未变且有部分内容，按 Web 行为保留已到达的部分回答。
9. `429 / turn_limit`：`limitHit` → 10 轮上限卡片 + 主按钮「开始新对话」（不写错误条、不阻塞开始新对话）。
10. `404/503/network/401`：中文错误条 + 「重试」；「重试」用发送时捕获的历史重放**同一轮**（不重复追加用户消息）；草稿只在 `RUN_STARTED` 后清空，因此 404/503/网络失败时草稿仍在。
11. 0 计划账号（`routines.length === 0`）完全走 GenUI 流式，无任何 `refinePlan` 旧链路。

### 3.4 交互节点回调
- `onApplyProposal(changes, node, messageId)`：先 `applyCoachProposal(profile, changes, meta)` 预演（校验 + 统计），再 `commit([{ kind: 'coachApplyProposal', changes, meta }])`，`meta = { proposalId, messageId, nodeId: node.id, label, summary }`；`applyCoachProposal` 内部即调用 `applyCoachProposalApplied`，`routines` / `week` / `coach.log` / `coach.snapshots` / `node.applied` 一并持久化并同步。应用成功后本地 `appliedProposals` 也标记，保证流式期间的卡片立即显示「已采纳」并在落盘消息里带上 `applied: true`。
- `onApplyAlternative(item, node, messageId)`：构造 `swap-exercise` 变更（`target: { routineId, exId: forExId }`、`after: { id: item.exId }`）走同一 `coachApplyProposal`，提示「已替换…，可在右上角菜单撤销」。缺失 `routineId` / `forExId` 时给出中文提示、不写入。
- `onSubmitForm(submission, node, messageId)`：`formSubmission = { formId, values }` + `text = summaryText` 作为下一轮流式请求；本地把该节点标记为已提交（`QuickFormNode` 自身锁存 + 屏幕层 `submittedForms`）。达到上限或正在流式时忽略提交。

### 3.5 输入栏 / 快捷胶囊 / 焦点稳定
- `KeyboardAvoidingView`（iOS `padding`）+ Android 实测键盘重叠 `paddingBottom`（`Keyboard` + `View#measure`，同 `ExerciseLibraryScreen` 的既有方案），底部安全区 `useSafeAreaInsets().bottom`（`Screen` 使用 `edges={['top','left','right']}`）。
- 单行横向 `ScrollView`（`showsHorizontalScrollIndicator={false}`）：`检查我的训练` / `上次训练` / `改进一个计划`（仅 `routines.length > 0`；多套计划时用 `ActionSheet` 选择，单套直接发送定向改进提示）/ `新对话`（仅 `userTurns > 0 && !turnLimitReached`）。
- 紧凑轮次行：`N/10 轮`；达上限时额外渲染锁定提示卡 +「开始新对话」主按钮（不替换、不卸载输入框）。
- 输入区：固定位置、`key="coach-composer-input"` 的 `TextField`（始终挂载，流式与键盘切换都不卸载、不清空草稿）+ `md`（46dp）发送按钮（≥44dp），流式期间仅禁用发送按钮。

## 4. 静态门禁与单测

`cd mobile-rn; npm.cmd run check` → **exit 0**

```
> opengym-rn@0.1.6 check
> npm run lint && npm run lint:rules && npm run typecheck && npm run design:check

> opengym-rn@0.1.6 lint
> eslint App.tsx index.ts src

D:\dev\open-gym\mobile-rn\src\screens\PlanScreen.tsx
  220:32  warning  Do not use Array index in keys  react/no-array-index-key

D:\dev\open-gym\mobile-rn\src\screens\StatsScreen.tsx
  276:28  warning  Do not use Array index in keys  react/no-array-index-key

2 problems (0 errors, 2 warnings)

> opengym-rn@0.1.6 lint:rules
> node --test --test-reporter=dot scripts/eslint-rules.test.cjs

.......

> opengym-rn@0.1.6 typecheck
> tsc --noEmit

> opengym-rn@0.1.6 design:check
> node scripts/check-design-system.mjs

design:check OK (127 upstream icons, 127 RN icons)
```

> 两条 warning 均为改动前既有（`PlanScreen` 轮换顺序列表、`StatsScreen`），本次未新增任何 warning/error。

`node --test mobile-rn/scripts/coach-stream.test.mjs mobile-rn/scripts/coach-profile-changes.test.mjs` → **25/25 pass, exit 0**

## 5. 说明与后续

1. 「表单已提交」与「流式中的提案已采纳」在 SQLite 里没有独立的可重放意图（`coachProposalApplied` 只服务 `proposal_action`），因此：历史消息的提案采纳走 `coachApplyProposal` 的 `messageId + nodeId` 落盘；流式期间的采纳由屏幕层 `appliedRef` 在落盘时补写 `applied: true`；`quick_form` 的已提交态与 Web 一致，仅会话内锁存（`QuickFormNode` 自带 `sent`）。
2. 本轮未做真机/模拟器视觉验收与 GIF（属于 Phase 4），键盘重叠与滚动采用仓库既有已验证方案，待 Phase 4 在 360dp/412dp 真机复核。
3. 深链只新增 `opengym://coach`；`opengym://agent` 保持为 Agent 配置台不变。
