# 问题 1 专题记录：AI Coach 英文回复与动作名本地化现状分析（暂缓处理）

> **状态**：`resolved (real mode)`（真实服务端 + 前端渲染链路已通过 [`I18N_EXECUTION.md`](I18N_EXECUTION.md) 完成修复并验收；Demo 模式按需求保持不动）
> **关联方案**：[`DESIGN.md`](DESIGN.md) · [`POLISH_EXECUTION.md`](POLISH_EXECUTION.md) · [`I18N_EXECUTION.md`](I18N_EXECUTION.md)

---

## 1. 问题现象（来自 2026-11-25 实测反馈）

在简体中文（`zh`）界面下使用 AI Coach（包括 Demo 模式与真实 DeepSeek 模式）时，出现以下语言不统一现象：

1. **Demo 模式文案为英文硬编码**：`VITE_DEMO=1` 下的 `streamDemo()` 返回的分析文本、卡片副标题、微表单选项标签（如 `Front shoulder`、`Dumbbells`）与提案说明均为写死英文。
2. **动作名称显示英文**：无论在旧版 `ReviewCard` / `DebriefCard` / `PlanCard` 还是新版 GenUI 卡片（1RM 趋势图、替代动作卡、替换按钮、提案前后对比）中，动作名多显示英文（如 `Barbell Incline Bench Press`、`Archer Push Up`、`Arm Crossover`）。
3. **真实大模型未始终跟随界面语言**：在首个版本中，`POST /api/agent/coach/stream` 未将前端传入的 `body.lang` 透传进 LangGraph Prompt；同时服务端的步骤文案（`STEP_STARTED.label`）与校验降级提示（`fallback_notice`）硬编码为英文。

---

## 2. 根因拆解

| 根因编号 | 所属层次 | 精确位置 | 原因说明 |
|---|---|---|---|
| **R1** | 前端老 Coach 公共展示函数 | [`frontend/src/lib/coach.js`](../../../../frontend/src/lib/coach.js#L690) | `exName(id)` 直接返回 `EXIDX[id]?.n`（英文词库原名），未调用 [`exerciseNameFor(ex)`](../../../../frontend/src/lib/i18n-core.js#L216)。因此整个 Coach 模块中 `changeTitle`、`changeValues`、`RoutineBlock` 全部渲染英文动作名。 |
| **R2** | 前端动作词库中文包覆盖率与双语格式 | `frontend/src/exercise-names/zh.js` + `i18n-core.js` | `exerciseNameFor(ex)` 依赖词库翻译包，但部分冷门动作在 `zh.js` 尚未翻译，会回退英文；此外默认开启 `showEn` 时会以 `中文名 (English Name)` 拼接展示，在窄屏按钮（如“将 A 换成 B”）中容易显得过长。 |
| **R3** | 前端 Demo 流式剧本 | [`frontend/src/lib/coach-genui-client.js`](../../../../frontend/src/lib/coach-genui-client.js#L191-L335) | `streamDemo()` 中的英文关键词正则（`vaguePain`）及回复文案均为英文硬编码，未按 `getLang()` 走多语言或中文触发词匹配。 |
| **R4** | 服务端 Prompt 与事件文案 | [`api/src/agent/coach-genui.controller.ts`](../../../../api/src/agent/coach-genui.controller.ts)、[`coach-genui.service.ts`](../../../../api/src/agent/coach-genui.service.ts) | 初版未透传 `body.lang`，且 `STEP_STARTED.label` 与 `verifyBlock` 降级文案为纯英文字符串（注：目前已在 `coach-genui.controller.ts` / `service.ts` 预埋 `lang` 透传基础能力，完整多语言文案映射留待专项统一收口）。 |

---

## 3. 后续专项改造方向（待排期）

1. **统一 Coach 动作名本地化策略**：在 `coach.js`、`coach-genui-hydration.js` 与 `CoachGenUI.jsx` 中统一封装 `localizedExName(id, { compact })`（卡片标题可用 `exerciseNameFor`，紧凑按钮优先纯中文主名避免按钮折行过长），并同步核验所有 19 语种及 `coach.test.js` 单测。
2. **服务端事件改用结构化 `code` 而非写死英文句子**：`STEP_STARTED`、`fallback_notice` 与 `RUN_ERROR` 传递稳定枚举/错误码，由前端通过 `t(...)` 按 19 语种渲染。
3. **补齐 Demo 剧本多语言与中文触发词**：让 `VITE_DEMO=1` 在中文界面下也能识别中文痛点/停滞关键词并输出全中文体验。
