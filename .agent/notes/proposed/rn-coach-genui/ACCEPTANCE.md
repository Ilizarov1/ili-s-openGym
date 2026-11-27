# `rn-coach-genui` Phase 4 验收报告（Android 模拟器 + 真实 DeepSeek + 真实 `xunji-history` 账号）

- 日期：2026-11-27
- 范围：`mobile-rn/` AI Coach GenUI 客户端在真实 Android 模拟器、真实 DeepSeek 模型与真实 `xunji-history` 数据下的 4 维硬验收；本轮同时修复了验收中发现的 2 个真实缺陷。
- 依据：[`DESIGN.md`](./DESIGN.md)、[`EXECUTION.md`](./EXECUTION.md) Phase 4、[`PHASE3_REPORT.md`](./PHASE3_REPORT.md)、[`.agent/skill/opengym-development/references/rn-android-env.md`](../../../skill/opengym-development/references/rn-android-env.md)

## 1. 环境与账号

| 项 | 值 |
|---|---|
| 模拟器 | `emulator-5556`（AVD `openGymRnQa`，Android 16 / API 36，x86_64） |
| 视口 | 1080×2400 @420dpi = **411dp**；另用 `wm density 480` 复核 **360dp**（见 §4.2） |
| 安装包 | `mobile-rn/android/app/build/outputs/apk/debug/app-debug.apk`（Debug APK，未重编） |
| JS | Metro `npx expo start --port 8081`（Debug 热更新链路，`adb reverse tcp:8081`） |
| API | `node scripts/dev.mjs --data-dir %TEMP%\opengym-e2e-xunji --port 3000 --web-port 5173`；app 连接 `http://10.0.2.2:3000` |
| 模型 | 真实 DeepSeek（`DEEPSEEK_API_KEY` 由 `api/.env` 注入，`model=deepseek-flash`；`AgentConfigStore.defaultProfile()` 在 key 存在时解析为 `provider: 'deepseek'`，`CoachGenUIService.resolveProfile()` 因此走 `mode: 'model'`，非 fixture） |
| 账号 | `xunji-history`（`id: C2WAM8hH_739C1mg`，`lang: zh`，`unit: kg`） |
| 数据 | `data/dev` 的副本：**351 场训练、95 个 `xunji-ex-*` 自定义动作、6 套计划**（真实数据未被修改，测试后临时目录已清理） |
| 认证 | 用该 API 的 `secret` 按 `/api/pair/redeem` 同格式签发 Bearer 会话，经 Hermes CDP `ExpoSecureStore` 写入 `openGymConnection`（不落盘、不打印任何密钥） |

验收前核对 `GET /api/data`：`workouts=351, customEx=95, routines=6, lang=zh, unit=kg`，返回体 450,351 字节。

## 2. 自动化检查

| 检查 | 命令 | 结果 |
|---|---|---|
| RN 静态门禁 | `cd mobile-rn; npm.cmd run check` | **exit 0**（eslint + lint:rules + tsc + design:check；仅 2 条改动前既有 warning） |
| RN 流式/同步意图单测 | `node --test mobile-rn/scripts/coach-stream.test.mjs mobile-rn/scripts/coach-profile-changes.test.mjs` | **25/25 pass** |
| API GenUI SSE 集成测试 | `node --test api/test/nest/coach-genui-sse.test.js` | **23/23 pass**（含 #23 手机配对 Bearer Token 流式调用） |
| 治理自检 | `.\.agent\scripts\verify-governance.ps1` | **0 errors**（README ≤ 300 行、断链、错题升格全部通过） |

## 3. 四维硬验收结果

### 3.1 维度 1 — 真实流式到达与工具状态：**PASS**

- 打开路径：`opengym://coach` 深链（首页/计划页也有入口）；已配对状态直接进入对话，无报错；未配对分支仍渲染「先完成配对 / 去扫码配对」（代码路径未变，本轮以已配对主路径验收）。
- 真实逐字到达（同一轮内 2s 间隔截图）：
  - +2s：仅用户消息 + `StreamStepsBar`「正在整理回答…」+「停止」；prose 尚未出现。
  - +4s：`kpi_strip` 与 `muscle_load` 卡片已渲染，正文停在半句「建议每个动…」。
  - +6s：正文完整结束并出现收尾 `callout`。
  - 见 [`./evidence/01-stream-analysis.png`](./evidence/01-stream-analysis.png)。
- 服务端直连 SSE 计时（同一账号、真实模型）：`RUN_STARTED` +9ms → `STEP_STARTED prepare/analyze` +10ms → `TOOL_CALL_START search_catalogue` **+756ms** → 首个 `genui.node_pending` **+3.24s** → `genui.prose_delta` 在 +4.45s…+5.05s 之间分多批到达；证明 chunk 是增量到达而非结束后一次性返回（短问答 `RUN_FINISHED` 737ms）。
- `search_catalogue` 工具状态：见 [`./evidence/02-tool-status.png`](./evidence/02-tool-status.png)，流式期间状态条显示「已检索动作库」。修复前该行只存在同一毫秒内（START 与 RESULT 同 tick），肉眼不可见，见 §5 缺陷 B。

### 3.2 维度 2 — 真实 `xunji-history` 分析、本地图表切换、建计划、持久化与撤销：**PASS**

- **kpi_strip（真实数值）**：`近4周训练次数 17`、`上斜卧推 e1RM 72kg ▼5%`、`单边腿弯举 10kg`、`背部近7日工作组 0组`；同轮另一份分析为 `面拉力量走向`、`单边腿弯举 13.3kg ▲5%`、`建议本周重点 拉类加量`。
- **muscle_load（BodyMap + 分段本地切换）**：`7天` = 108 组 / 6 场；切到 `28天` = 348 组 / 17 场（同一 BodyMap 热区与重点肌群列表即时重排）；`72小时/7天/28天` 全部本地重算。
- **exercise_trend（指标/周期本地切换）**：`1RM → 重量` 后标题与曲线立即切为「训练重量 / 面拉负重走向」，周期 `4周/8周/12周/24周` 可切；`上斜卧推 首末 73.3 → 72 kg（−2%，10 次训练）`、`面拉 70 → 84 kg（+20%）` 均为真实日志水合。
- **零新增流式请求**：用 Hermes CDP `Network` 域抓包——25s 本地切换窗口内只有 1 条后台 `GET /api/data`，`POST /api/agent/coach/stream` 为 **0**；16s 肌群窗口同样只有 1 条 `GET /api/data`、0 条 coach stream。
- **新建计划**：发送「帮我新建一个胸肩推日计划，安排在周一和周四」→ `proposal_action` 渲染 `周一`/`周四` 胶囊 + 6 个中文动作处方（含自定义动作 **`悍马机推胸（版本3）`**，`xunji-ex-343f6cf6315678305a9b5094`，由 RN `resolveExerciseName()` 本地解析），无横向溢出、无文字碰撞（411dp 与 360dp 均复核）。见 [`./evidence/03-proposal-preview.png`](./evidence/03-proposal-preview.png)。
- 点击「应用 1 项更改」→ 卡片切为「已采纳」，提示「已应用 1 项更改，可在右上角菜单撤销。」；`/api/data` 变为 `routines=7`、`week={"1":[新计划],"4":[新计划]}`；计划页「日程」显示周一/周四为「胸肩推日」。见 [`./evidence/04-plan-applied.png`](./evidence/04-plan-applied.png)。
- **强杀重启持久化**：`adb shell am force-stop dev.opengym.rn` 后经 `opengym://plan` 重启，周一/周四仍是「胸肩推日」，Coach 历史里的提案卡片仍为「已采纳」。
- **撤销**：右上角菜单「撤销教练上次的更改」→ 本地立即提示并回滚；约 8s 后 `/api/data` 变为 `routines=6`、`week={}`、`snapshots=0`、`log=4`，计划页恢复全周「休息」，动作与排期原子回滚。

### 3.3 维度 3 — 多轮、零方括号泄漏、软键盘与输入框焦点：**PASS（含环境说明）**

- 同一会话连续 3 轮：`分析下我最近的训练` → `帮我新建一个胸肩推日计划…` → `我自定义的「器械推胸」最近力量有进步吗？`，计数准确显示 `3/10 轮`。
- 全量 UI 树扫描：`[Shown` = **0**，`[Proposal` = **0**（`agent-device snapshot --raw` 结果），模型第 3 轮还主动指出「器械推胸不在计划里，按『杠杆推胸』取趋势」，无退化摘要文本。
- 输入框稳定性：流式期间 `coach-composer` 始终保持 `[focused]`、草稿不丢；发送后仅在 `RUN_STARTED` 清空输入；IME 显示（`mInputShown=true`）时输入栏被 `keyboardOverlap` 顶起、内容整体上移且不遮挡，输入框未卸载。
- 视口：411dp 与 360dp（`wm density 480`）均无横向溢出；胶囊行本身是设计内的横向滚动容器。
- 环境说明：该 AVD 向 Android 暴露宿主 AT 键盘（`hw.keyboard=no` 仍出现 `AT Translated Set 2 keyboard`），Gboard 因此显示“物理键盘工具条”而非全尺寸软键盘；本轮以该 IME 窗口的真实显示/隐藏验证了焦点、草稿保持与输入栏上移，真机全键盘场景沿用同一 `KeyboardAvoidingView + keyboardOverlap` 代码路径。

### 3.4 维度 4 — 跨端同步与「新对话」防复活：**PASS**

- `coach.chatClearedAt` 单调推进：首次「新对话」后为 `1795774475142`；GIF 流程再次「新对话」后为 **`1795774971105`**（严格递增）。
- 清空后先发送 1 轮 → `/api/data` 的 `coach.chat` 从 0 变为 2（仅新对话的用户消息 + 回答），旧消息 **0 条复活**；随后同会话 3 轮累计为 4~5 条，均为清空后写入。
- RN 与 Web 读取同一份状态：Web 客户端（Vite `http://127.0.0.1:5173`，cookie 会话）打开「计划 → 训练计划」显示同样的 6 套计划（`胸部与肩部训练A`、`背部与手臂训练A` 等），撤销后的「本周」与 RN 一致为全休息。见 [`./evidence/06-web-plan-sync.png`](./evidence/06-web-plan-sync.png)。
- 观察（非本期缺陷）：`xunji-history` 首次打开 **Web** 教练会先进入「认识教练」问卷（Web 侧首次引导），RN 端按设计直接进入对话；两端最终读写同一 `coach.chat` / `coach.snapshots` / `routines` 状态。

## 4. 证据

### 4.1 连续操作 GIF 与演示视频

- [`./evidence/rn-coach-genui-e2e.gif`](./evidence/rn-coach-genui-e2e.gif) — **3.63 MB，GIF89a，504 帧，50.4s（约 1.8× 时间压缩的真实连续录屏）**
- [`./evidence/opengym-rn-demo.mp4`](./evidence/opengym-rn-demo.mp4) — **5.40 MB，H.264 `yuv420p`，720×1600 @ 30fps，134.9s（移除输入栏 `N/10 轮` 与 `消息` 标签后的完整产品演示视频）**：
  1. **Part 1 — AI 教练分析训练动作并改进计划**：首页进入 AI 教练 → 发送「帮我分析一下我最近的训练动作和表现」→ 实时流式展示真实 `xunji-history` 数据水合趋势图与本地指标切换（`重量`）→ 追问改进胸肩训练计划 → 展示 3 项 diff 提案卡 → 一键「应用 3 项更改」并切换为「已采纳」。
  2. **Part 2 — 多模态智能检索（`test_pic/演示/` 真实器械图）**：动作库进入「AI 检索动作」→ 相册选取 `test_pic/演示/` 挂片式推肩机与 Hammer Strength 高位划船机两张图片 → `deepseek-flash` 实时视觉识别分别命中「杠杆坐姿肩部推举」与「杠杆高位划船」并展示带动作动画与肌群高亮的详情页。
- 内容顺序：新对话清空 → 输入「分析下我最近的训练」→ 流式状态条/工具状态/增量正文 → KPI/肌群图/趋势曲线本地切换（1RM/重量、4/8/12/24 周）→ 输入建计划请求 → 周几胶囊与动作处方预览 → 应用 → 已采纳 → 计划页周一/周四「胸肩推日」。

### 4.2 关键截图

| 文件 | 内容 |
|---|---|
| [`01-stream-analysis.png`](./evidence/01-stream-analysis.png) | 发送后 ~2s：状态条 + 「已检索动作库」+ 半截正文 + KPI |
| [`02-tool-status.png`](./evidence/02-tool-status.png) | 流式中工具状态「已检索动作库」稳定可读 |
| [`03-proposal-preview.png`](./evidence/03-proposal-preview.png) | `add-routine` 提案：周一/周四胶囊、6 个中文动作（含自定义动作）、「应用 1 项更改」 |
| [`04-plan-applied.png`](./evidence/04-plan-applied.png) | 计划页：周一、周四 = 胸肩推日（411dp） |
| [`05-muscle-load-zh.png`](./evidence/05-muscle-load-zh.png) | 修复后肌群名中文化（胸部/腹部…）与真实组数 |
| [`06-web-plan-sync.png`](./evidence/06-web-plan-sync.png) | Web 端同一账号的 6 套计划（跨端一致性） |

> 360dp 复核：`adb shell wm density 480`（1080×2400 → 360×800dp）下提案卡片、周几胶囊、组次与正文均无横向溢出或文字碰撞，复核后已恢复 420dpi。

## 5. 验收中发现并修复的缺陷

**缺陷 A — 肌群名未本地化（英文泄漏）**

- 现象：`muscle_load` 的「重点肌群」列表在 RN 上显示 `Shoulders / Chest / Abs / Calves / Lower back`，而 Web 通过 `t()`（`frontend/src/locales/zh.js`）显示中文。
- 根因：RN 无 i18n 运行时，`DataVisualNodes.tsx` 直接渲染水合出的 `MUSCLE_NAME` 英文标签；`KpiTile` 的 `muscle_sets` 兜底还会显示 slug。
- 修复：在 `mobile-rn/src/coach/DataVisualNodes.tsx` 增加 18 个肌群的中文映射（同时覆盖英文展示名与 body-map slug），显示名与 KPI 兜底统一走 `muscleLabel()`；不改动已存储节点数据，无迁移。
- 复核：`05-muscle-load-zh.png`（胸部/腹部等），`npm.cmd run check` 全绿。

**缺陷 B — `search_catalogue` 工具状态不可感知**

- 现象：服务端 `TOOL_CALL_START` 与 `TOOL_CALL_RESULT` 在同一毫秒返回（本地词库检索），`activeTool` 被立刻清空，状态条第二行「正在检索动作库…」来不及绘制，验收要求中的“工具状态出现”实际不可见。
- 根因：`CoachChatScreen` 在 `TOOL_CALL_RESULT` 立即 `activeTool = null`，React 合并同一批更新。
- 修复：累积器新增 `completedTool`，`search_catalogue` 返回后保留为「已检索动作库」直到本轮结束；`StreamStepsBar` 新增 `completedTool` 属性渲染弱化行（含检索词 Badge），不影响其它工具与持久化结构。
- 复核：[`02-tool-status.png`](./evidence/02-tool-status.png) 与 GIF 中均可见；RN 门禁与单测全绿。

两次修复后重新跑通 `npm.cmd run check`、25/25 RN 单测、23/23 API SSE 集成测试，并在模拟器上重走四维主路径。

## 6. Post-Edit 四步核对（`.agent/skill/opengym-development/SKILL.md` §5）

1. **定位受影响子系统与真实运行时路径**：`mobile-rn` → `CoachChatScreen.runTurn.onEvent`（AG-UI 事件累积）→ `StreamStepsBar`（live 区域渲染）；`DataVisualNodes.MuscleLoadNode/KpiTile` ← `coach-bridge.hydrateCoachMuscleLoad/hydrateCoachKpi`。未触及 API/Web/同步协议。
2. **追踪调用链副作用**：`completedTool` 仅存在于单轮流式累加器，`finishRun` 丢弃 live 状态，不进入 `coachChatAppend`/SQLite/`/api/data`；`muscleLabel()` 仅影响渲染文本，节点与动作 ID 原样保留，撤销/重放/跨端数据不变。
3. **反向检查契约与文档**：GenUI 节点结构与 `/api/data` 契约零改动；本报告补充 Phase 4 结果与两个 UI 层修复；DESIGN §3.2 的“本地化动作名/肌群”要求现已在 RN 侧闭合。
4. **核验测试是否覆盖宣称行为**：SSE 分片/中止/NDJSON/`pruneClearedChat` 由 `coach-stream.test.mjs` 与 `coach-profile-changes.test.mjs`（25 项）覆盖；工具事件顺序与 Bearer 鉴权由 `coach-genui-sse.test.js`（23 项）覆盖；两个纯 UI 修复以真实模拟器截图与 GIF 复核（RN 当前无组件级渲染测试框架，未新增虚假覆盖）。

## 7. 清理

- `agent-device close` 已释放 `emulator-5556` 声明；未触碰物理设备 `10AD3Z1EPU0029R`。
- 已停止本轮启动的 Metro（8081）与 `scripts/dev.mjs`（API 3000 / Web 5173）。
- 已删除临时数据目录 `%TEMP%\opengym-e2e-xunji`、临时 token 与录屏中间文件；`data/dev/` 保持原样。
