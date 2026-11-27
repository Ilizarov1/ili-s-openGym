# Coach GenUI 新建计划打通方案（`coach-genui-create-plan`）— 验收报告

- **工作树 / 分支**：`D:\wt\coach-genui-create-plan`（`feat/coach-genui-create-plan`）
- **日期**：2026-11-27
- **主 Agent 验收结论**：**全部通过（PASS）**

---

## 1. 自动化构建、单测与治理门禁

| 检查项 | 命令 / 范围 | 结果 |
|---|---|---|
| 后端编译与单测 | `npm --prefix api run build` + `sync-stamps` / `coach-genui-protocol` / `validate` / `agent-portability` / `coach-genui-sse` | **PASS**（162 / 162 通过，含新增 `add-routine` 协议、`weekdays` 校验、0 计划 SSE 与自定义动作名上下文） |
| 前端单测 | `vitest run`：`coach` / `sync-merge.coach` / `sync-stamps-parity` / `CoachGenUI` / `CoachChat` / `CoachChat.fast-failure` | **PASS**（162 / 162 通过，6/6 文件全绿） |
| 国际化严格校验 | `check-source-strings.mjs --strict` + `check-locales.mjs` | **PASS**（3,085 词条全语种齐备，零新增未译文案） |
| 前端生产构建 | `npm --prefix frontend run build` | **PASS**（0 错误） |
| OpenAPI 与治理自检 | `node scripts/build-api-docs.mjs --check` + `.agent/scripts/verify-governance.ps1` | **PASS**（0 告警） |

---

## 2. Phase 2 真实 DeepSeek 5 条探针结果（`deepseek-flash`）

基于真实导入的 **351 条训练记录 / 0 个计划模板** 账号克隆环境实测：

| 探针 | 输入 | 耗时 | 实测输出 | 结论 |
|---|---|---:|---|---|
| 1. 0 计划纯分析 | 「分析下我最近的训练」 | 4.5s | `kpi_strip` + `muscle_load` + `exercise_trend` + `callout` + `quick_form`；`proposals: []`、`warnings: []`、`bracketLeak: false` | **PASS** |
| 2. 0 计划单日新建 | 「帮我新建一个胸肩推日计划，安排在周一和周四」 | 4.5s | 触发 2 次 `search_catalogue`，输出通过白名单校验的 `proposal_action`（`add-routine`「胸肩推日」，`weekdays: [1, 4]`，6 个合法动作） | **PASS** |
| 3. 0 计划三练推拉腿 | 「根据我最近的训练记录，帮我建一套一周三练的推拉腿计划」 | 7.4s | 触发 6 次 `search_catalogue`，输出 `comparison_table` + 单张 `proposal_action`（3 条 `add-routine`：推/拉/腿各 5 个合法动作，全部通过白名单校验） | **PASS** |
| 4. Turn 2 多轮追问修改 | 「把其中一个动作换成哑铃飞鸟，再给我确认」 | 3.0s | 触发 `search_catalogue` 将 `1030` 替换为 `0308`（哑铃飞鸟），保留 `weekdays: [1, 4]`，无 `[Proposal: ...]` 方括号退化 | **PASS** |
| 5. 有计划账号回归 | 「帮我分析一下最近上斜卧推是不是停滞了」 | 3.8s | `exercise_trend` + `kpi_strip` + `callout` + `exercise_alternatives`；`proposals: []`、`warnings: []` | **PASS** |

> 探针阶段顺手发现并修复了导入型自定义动作（`customEx` 如 `xunji-ex-*`）在 `inspectContext` 中只显示 ID 未附名称的体验缺口，补齐 `customNames` 后，真实浏览器实测中模型已能准确理解并复用用户的自定义动作。

---

## 3. Phase 4 真实浏览器 4 维硬验收（430×820 移动端视口 + 真实 DeepSeek）

1. **初始态（0 计划 / 351 条训练记录账号）**：
   - 快捷胶囊仅显示 `['检查我的训练', '上次训练']`（无「改进一个计划」）。
2. **Turn 1（0 计划纯分析「分析下我最近的训练」）**：
   - 走 `/api/agent/coach/stream`，零报错（彻底消除旧版「应用无法使用教练给出的回答」），渲染 2 张真实数据水合卡片，`bracketLeak: false`、`overflowX: false`。
3. **Turn 2（新建计划预览卡片）**：
   - 生成 `add-routine` 提案卡片「添加训练日「背部拉日」」，卡片内完整预览周几标签（`星期二`、`星期五`）与 7 个动作清单及组次处方（混合内置词库动作与用户自有自定义动作），`overflowX: false`、`bracketLeak: false`。
4. **一键应用 → `#/plan` 落盘 → `F5` 整页刷新 → 一键撤销**：
   - 点击「应用 1 项更改」→ 卡片切换为「已采纳」，底部快捷胶囊实时解锁「改进一个计划」；
   - 服务端 `/api/data` 实测写入 `routines: [{ name: "背部拉日", exCount: 7 }]` 与 `week: { "2": [id], "5": [id] }`；
   - 返回 `#/coach` 执行 `F5` 整页刷新 → 卡片仍保持「已采纳」且 7 行动作预览完整保留；
   - 菜单点击「撤销教练上次的更改」→ 服务端实测 `routines: 0`、`week: {}`，新增计划与周历原子回滚。
5. **双标签页「新对话」并发无闪现**：
   - 双标签页打开 `#/coach`，Tab 1 点击「新对话」后 250ms 立即发送新消息，全程每 400ms 采样 DOM：`sawOldDuringStream: false`，同步完成后两标签页消息数完全一致（3 条：欢迎语 + 本轮问答）。
6. **视觉 QA 与实操 GIF 证据**：
   - 证据 GIF：[coach-genui-create-plan-e2e.gif](./evidence/coach-genui-create-plan-e2e.gif)（430×820 移动端暗色视口，242.1 KB，`GIF89a`）。
   - 独立视觉 QA 子 Agent 复核 4 帧实拍：零横向溢出/裁切，长中英双语动作名自动换行且与右侧等宽处方（`4×5-7` / `3×10-12` 等）对齐无碰撞，周几标签与 `#/plan` 计划页肌群缩略图、周一/周四排期均正常展示。
