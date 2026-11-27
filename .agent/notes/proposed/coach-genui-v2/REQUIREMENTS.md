# AI Coach 生成式 UI v2 需求文档：叙事穿插流与细粒度原子原语（Interleaved Narrative GenUI）

> 状态：**待设计 / 待实施（Proposed）**  
> 前置基线（v1 已完成）：[v1 设计](../coach-genui/DESIGN.md) · [v1 体验打磨](../coach-genui/POLISH_EXECUTION.md) · [v1 真实模式中文化](../coach-genui/I18N_EXECUTION.md)  
> 适用子系统：`ai-agent`、`web-client`（协议层同步保持 `mobile-rn` 零依赖可移植性）

---

## 1. 背景与问题根因

v1（路线 A：AG-UI SSE + A2UI 风格受控目录）已完成端到端落地并接入真实 DeepSeek 模型，打通了 5 种业务块（`exercise_trend` / `muscle_load` / `exercise_alternatives` / `quick_form` / `proposal_action`）、客户端真实数据水合、中文动作名接地、白名单提案校验与撤销闭环。

但在真实对话体验后，暴露出**三个深层体验痛点**，让用户感觉「生成的 UI 卡片和回答是分离的」：

1. **视觉割裂与内容重复**：v1 输出契约为 `{ text, blocks[] }`（见 `api/agent-runtime/tasks/coach-genui.js`），协议层面将“回答正文”和“UI 卡片”物理拆分为上下两块。模型被迫先在顶部气泡里把所有结论说完，下面再把卡片像附件一样重复贴出来，缺乏上下文衔接。
2. **一轮堆卡导致信息过载**：v1 仅有 5 种重型业务大卡，缺乏轻量表达原语，稍微复杂的问题就会一次堆出 2~4 张大卡片，视觉压力大、抓不住当下重点。
3. **非真流式导致的节奏突兀**：v1 后端使用整包等待（`model.invoke()`）完成后再解析 JSON，先回放全文再集中推送全部 `blocks`，没有「讲到哪儿、对应的图或控件就在哪儿长出来」的实时同步感。

---

## 2. 产品目标与已对齐决策

经需求对齐，v2 锁定以下核心方向（**产品体验与技术深度并重**）：

1. **核心交互形态 — 叙事穿插流（Interleaved Narrative Stream）**：
   - 不再区分“顶部文字气泡 + 底部附件卡区”；教练的一轮回复是一份**统一流动的交互式简报**，按逻辑顺序交替编织「短段解说 → 紧跟其后的图表/原语/控件 → 下一句洞察 → 下一步操作」。
2. **自由度与严谨性平衡 — 受控但百变的原子原语体系**：
   - **坚守零数值幻觉与安全写操作**：所有历史曲线、1RM、训练量、肌群负荷仍由客户端从真实本地日志水合；所有计划修改仍过 `validateReview()` 白名单与可撤销事务。
   - **引入细粒度原子原语**：在现有 5 个核心业务块基础上新增轻量展示/交互原语，使模型能按提问意图自由编排周报摘要、动作对比矩阵、热身/技术勾选清单、风险提示与交互图表，避免千篇一律的固定大卡。
3. **双重价值目标**：
   - **产品侧**：克制、顺手、不啰嗦，像私人教练面对面一边画图讲课、一边让你勾选项或微调参数。
   - **工程侧**：落地真正的逐节点增量流式协议（`model.stream()` + NDJSON 增量状态机解析器 + 零依赖共享协议 + 节点级局部降级与中断恢复）。

---

## 3. 功能需求明细

### FR-1：统一叙事节点协议（`nodes[]` 替代 `{ text, blocks[] }`）
- 在 `api/agent-runtime/genui/` 中定义 **GenUI v2 叙事节点模型**：单轮回复由扁平有序的 `nodes: GenUINode[]` 构成（不再嵌套布局树，保持移动端可渲染性）。
- 每种节点具有稳定的 `id`、`type` 与严格声明的参数 schema，所有文本与枚举均在共享协议层完成裁剪与白名单清洗。
- **向后兼容**：
  - 历史会话中持久化的 v1 消息（`{ text, blocks }`）在前端读取时自动归一化为 `[ { type: 'prose', text }, ...blocks ]`，老聊天记录零迁移、无破坏。
  - 若服务端因兼容或降级回退发出旧版 `TEXT_MESSAGE_CONTENT` + `genui.block_upsert`，前端仍能正常渲染。

### FR-2：真正的逐节点增量流式（NDJSON Incremental Stream）
- **模型输出格式升级**：后端 Prompt 要求模型按 **NDJSON（每行一个合法 JSON 节点）** 顺序输出，严禁外层数组或 Markdown 代码围栏。例如：
  ```jsonl
  {"type":"prose","text":"你最近 6 周上斜卧推停在 73kg，主要瓶颈在肩部恢复而非胸肌力量。"}
  {"type":"kpi_strip","items":[{"kind":"exercise_stat","exId":"0047","metric":"e1rm","weeks":6},{"kind":"muscle_sets","muscle":"chest","window":"72h"},{"kind":"muscle_sets","muscle":"deltoids","window":"72h"}]}
  {"type":"exercise_trend","exId":"0047","metric":"e1rm","weeks":8,"highlightStall":true}
  {"type":"prose","text":"肩前束负荷已超过胸部，建议把次要的平板卧推换成关节更友好的变式："}
  {"type":"comparison_table","columns":["动作","肩部压力","进阶空间"],"rows":[...]}
  {"type":"proposal_action","title":"...","summary":"...","changes":[...]}
  ```
- **共享增量状态机解析器（零依赖）**：
  - 在 `api/agent-runtime/genui/` 新增增量 NDJSON 解析器（支持跨 TCP/token 分片拼接、容忍空行/意外围栏行、支持提取未闭合 `prose` 行的增量文本 delta）。
  - 后端 LangGraph 编排节点由 `model.invoke()` 升级为 **`model.stream()`**：
    - `prose` 节点在模型逐 token 生成时实时向下游推送文本增量（前端边打字边呈现该段落）；
    - 非 `prose` 结构化节点在检测到起始 `"type":"..."` 时可发射 `genui.node_pending`（前端在该叙事位置即时展示对应类型的轻量局部占位）；
    - 该行 JSON 一旦闭合，立即通过共享校验器（含 `validExIds` / `validateReview` 校验），通过后立刻推送 `genui.node_commit`，前端在原地平滑替换为真实组件。
- **局部容错与中止**：
  - 单行 JSON 解析失败或字段校验不通过时，仅对该节点静默丢弃或降级为轻量提示，绝不中断后续节点流；
  - 用户点击「停止」时立即中断上游模型流并保留已提交的叙事节点，不丢失已生成内容。

### FR-3：新增 5 个细粒度原子原语
| 原语 `type` | 核心字段 | 防幻觉与边界约束 |
|---|---|---|
| `prose` | `text`（必填，1~2 句，≤ 280 字）、`tone?`（`'normal' \| 'lead' \| 'closing'`） | 作为叙事穿插骨架；Prompt 硬约束不得复述紧邻下方组件已展示的数字与完整标题 |
| `kpi_strip` | `items`（2~4 项）：支持两类显式声明项：<br>① **真实水合项**（`kind: 'exercise_stat'` 含 `exId/metric/weeks`；`kind: 'muscle_sets'` 含 `muscle/window`；`kind: 'session_count'` 含 `weeks`）<br>② **处方/标签项**（`kind: 'prescription'` 含 `label/value`，仅用于建议组次如 `4×8`、`RIR 2`） | **严禁模型直接写历史统计数字**；所有历史数据指标必须经水合项由前端从本地日志计算得出 |
| `comparison_table` | `title?`、`columns`（2~4 列）、`rows`（2~6 行，单元格支持文本或 `{ exId }` 自动解析中文动作名与缩略图） | 仅用于定性对比（发力重点、关节压力、适用场景、周期策略等）；列宽自适应移动端不横向溢出 |
| `checklist` | `listId`、`title?`、`items`（2~6 项，每项 `{ id, label, detail? }`） | 支持用户直接在聊天流里逐项勾选（如热身步骤、动作技术要点、降载检查项），勾选态保留在当前消息状态中 |
| `callout` | `variant`（`'info' \| 'tip' \| 'warning'`）、`title?`、`text` | 轻量左色条提示框，用于伤病预警、核心原则或下次训练关键提醒 |

### FR-4：现有 5 个核心业务块轻量化与内联交互升级
1. **视觉融入叙事流**：去掉厚重独立外框与重复标题层级，采用统一的简报内部节律（与 `prose` / 原语共用柔和间距与分隔节奏），不再像“粘贴在气泡外的陌生卡片”。
2. **组件内本地交互（不重调 LLM）**：
   - `exercise_trend`：在图表顶部/角落提供紧凑胶囊切换器，允许用户本地秒切指标（`1RM / 重量 / 训练量`）与周期（`4周 / 8周 / 12周 / 24周`），直接复用 `hydrateExerciseTrend` 重新水合。
   - `muscle_load`：提供紧凑胶囊切换器，允许本地秒切时间窗（`72小时 / 7天 / 28天`），直接复用 `hydrateMuscleLoad` 重新水合。
3. **保留既有能力不退化**：
   - `exercise_alternatives`（真实中文名 + 动画缩略图 + 器械标签本地化 + 一键发起替换）；
   - `quick_form`（动态单选/多选/滑块追问表单 + 提交自动续聊）；
   - `proposal_action`（轻量内联操作条风格 + `validateReview` 校验 + 裸字符串 `after` 兼容 + 一键应用/撤销 + 已应用后不再误报计划变更警告）。

### FR-5：信息克制预算（可配置）与 Prompt 编排纪律
- **可配置的防堆卡预算**：
  - 默认单轮重型可视化锚点（`exercise_trend` 或 `muscle_load`）预算为 `1`（除非用户明确要求同时看多个图表）；
  - 该预算必须**可配置**（例如通过后端配置/环境变量或请求级参数覆盖默认上限，方便后续按体验调优而无需改协议代码）；
  - 轻量原语（`kpi_strip` / `comparison_table` / `checklist` / `callout`）单轮合计建议 `1~3` 个；
  - 整轮总节点数硬上限 `MAX_GENUI_NODES = 8`（含 `prose`）。
- **单列竖排优先（移动端友好）**：所有叙事节点与组件统一采用**单列纵向流式布局**，**不做双列并排卡片排版**，避免移动端窄屏下图表/表格挤压变形或横向滚动。
- **克制原则**：纯知识/概念问答（如“RIR 1 和 RIR 3 的区别”）只输出 `1~2` 个 `prose`（最多配 1 个 `comparison_table` 或 `callout`），绝不强行附带无关图表。
- **反重复原则**：Prompt 明确规定 `prose` 只讲洞察、因果与下一步引导，不重复 `kpi_strip` / 图表里的具体数字。
- **中文接地继承**：完全继承 v1 I1/I2 的中文词库注入（`lang=zh` 时 Prompt 与全部用户可见字段严格中文、禁止吐出裸英文动作名）及 `useLang()` 响应式水合。

### FR-6：前端叙事表面与平滑流式动效
- **统一简报容器**：一轮教练回复渲染为一个连贯的 `.genui-briefing` 容器，内部按 `nodes[]` 顺序流式生长；只有纯 `prose`（无任何 UI 节点）的简短问答才退回普通紧凑气泡样式，保持聊天轻盈感。
- **精准局部占位替代整屏假骨架**：
  - 首 token 到达前展示极简的顶部进度条（`StreamStepsBar`）与单段轻占位；
  - 节点流式到达时，只在尾部对应类型处展示匹配高度的轻量微骨架（`genui.node_pending`），收到 `genui.node_commit` 后原地淡入展开；
  - 严格遵守 `prefers-reduced-motion: reduce`。
- **不退化约束**：
  - 传统 `pending` 卡片（`ReviewCard` / `DebriefCard` / `PlanCard`）仍保持 `createdAt` 时间线锚定；
  - **本阶段不要求改造 Demo 模式**（`frontend/src/lib/coach-genui-client.js` 中的 `streamDemo()` 可保持原样或仅做最小兼容，聚焦真实大模型链路）。

---

## 4. 受影响子系统与改前语义级变更声明

### 子系统 A：`ai-agent`（`api/agent-runtime/`、`api/src/agent/`、`api/openapi.yaml`）
- **Trigger**：用户在 AI Coach 自由输入框发送消息或提交 `quick_form`，调用 `POST /api/agent/coach/stream`。
- **Before**：后端使用 `model.invoke()` 等待完整 `{ text, blocks[] }` JSON，校验后先分段回放 `TEXT_MESSAGE_CONTENT`，再一次性推送所有 `genui.block_upsert` 事件；支持 5 种大卡 + `fallback_notice`。
- **After**：后端升级为 `model.stream()` + 共享 NDJSON 增量状态机解析器，按模型生成顺序交错推送 `prose` 增量与结构化节点事件（`genui.node_pending` / `genui.node_commit`）；协议扩展为有序 `nodes[]`，新增 `prose`、`kpi_strip`、`comparison_table`、`checklist`、`callout` 5 种轻量原语，保留并兼容 5 种业务块；`validExIds` 与 `validateReview` 在节点闭合瞬间即时执行。
- **接口 / 状态 / 兼容性**：`POST /api/agent/coach/stream` 保持原路由与认证/CSRF 契约；SSE 帧继续遵守 AG-UI 事件外壳（新增 `CUSTOM` 事件名 `genui.node_pending` / `genui.node_commit` / `genui.prose_delta` 或在 `DESIGN.md` 中最终定名并同步 `api/openapi.yaml`）；如上游模型偶尔返回旧版整包 JSON `{ text, blocks }`，解析器自动兜底转换为 `nodes[]` 发射，防止模型偶发格式偏移导致白屏。
- **失败模式**：单行畸形 JSON 仅丢弃或局部降级；上游 `model.stream()` 不可用时可回退 `invoke()` 并走同一套 NDJSON/JSON 归一化管线；客户端断开时及时释放模型流连接。

### 子系统 B：`web-client`（`frontend/src/lib/coach-genui-*`、`CoachGenUI.jsx`、`CoachChat.jsx`、`coach.css`、`locales/*.js`）
- **Trigger**：前端消费 `/api/agent/coach/stream` SSE 事件并渲染会话消息与历史记录。
- **Before**：`CoachChat.jsx` 将每条 AI 回复渲染为「上方一个文字气泡 + 下方 `<GenUISurface blocks={...} />` 独立卡片堆」；`exercise_trend` / `muscle_load` 参数写死无法在卡片内切换；消息仅持久化 `{ text, blocks }`。
- **After**：`CoachChat.jsx` 与 `CoachGenUI.jsx` 将带 UI 节点的回复渲染为单一连贯叙事表面（按 `nodes[]` 交替渲染 `prose` 与各类组件）；新增 4 个轻量原语渲染器（`kpi_strip` 真实水合、`comparison_table`、`checklist` 本地勾选、`callout`）；`exercise_trend` 与 `muscle_load` 支持本地无刷新切换指标/时间窗；消息持久化 `nodes[]`（兼容读取旧 `{ text, blocks }`）。
- **接口 / 状态 / 兼容性**：不修改 `S.routines` / `S.workouts` 核心存储结构；`checklist` 勾选态随消息存入会话记录；新增 UI 英文源串必须同步覆盖全部 19 个 `frontend/src/locales/*.js`。
- **失败模式**：未知节点类型静默忽略或降级为轻量提示，绝不崩溃整条消息；水合查无对应训练历史时展示克制空态而非 `NaN`/断裂图表。

---

## 5. 非功能与工程红线

1. **共享运行时零依赖**：`api/agent-runtime/` 严禁引入 Node 内置模块或第三方包（必须通过 `api/test/agent-portability.test.js`）。
2. **多语言严格同步**：所有前端新增 `t('...')` 文本必须覆盖全部 19 个语言包（必须通过 `check-locales.mjs` 与 `check-source-strings.mjs --strict`）。
3. **OpenAPI 同步**：SSE 事件契约变更必须同步更新 `api/openapi.yaml` 并通过 `node scripts/build-api-docs.mjs --check`。
4. **隐私与安全**：严禁在日志、测试输出或诊断中打印任何 API Key；`proposal_action` 写操作必须继续严格走白名单校验与可撤销事务。
5. **仓库治理门禁**：必须通过 `.\.agent\scripts\verify-governance.ps1`，且各 `README.md` 严格 ≤ 300 行。

---

## 6. 验收标准

### 6.1 自动化测试门禁
- `api/test/coach-genui-protocol.test.js` + `api/test/agent-portability.test.js`：覆盖 NDJSON 跨分片流式解析、畸形行局部降级、v1 整包 JSON 兜底兼容、全部新旧节点校验与零依赖守卫。
- `api/test/nest/coach-genui-sse.test.js`：覆盖真实 `stream()` 交错事件时序（先 `prose` 后 `node_commit` 再 `prose`，验证并非全量堆到末尾）、`lang=zh` 中文接地、`proposal_action` 校验与中断中止。
- `frontend` Vitest 套件：覆盖 `nodes[]` 渲染顺序、v1 历史 `{ text, blocks }` 兼容归一化、`kpi_strip` 真实水合、`checklist` 勾选态、`exercise_trend`/`muscle_load` 本地切指标与时间窗、中文词库包响应。
- 全量前端构建（`npm --prefix frontend run build`）、后端构建（`npm --prefix api run build`）、19 语言包检查与 OpenAPI 检查全绿。

### 6.2 真实 DeepSeek 端到端实测场景（通过根目录 `npm run dev` 启动）
1. **叙事穿插 + 克制布局**：问「帮我分析一下最近上斜卧推是不是停滞了，顺便给个调整建议」→ 验证文字与指标条/单一趋势图/建议交替出现，边讲边长，不重复废话、不堆 3~4 张大卡。
2. **对比矩阵 + 勾选清单**：问「帮我对比一下杠铃卧推、哑铃上斜卧推和双杠臂屈伸的肩部压力，并给我一份今天 Push Day 前的 4 步肩部热身清单」→ 验证出现 `comparison_table`（中文动作名）+ 可交互勾选的 `checklist`。
3. **本地内联交互**：在渲染出的 `exercise_trend` 上点击切换 `1RM -> 训练量` / `8周 -> 12周`，在 `muscle_load` 上切换 `72小时 -> 28天` → 验证曲线与肌群图瞬时重绘、不发网络请求。
4. **纯文字克制**：问「RIR 1 和 RIR 3 的区别是什么，简短说」→ 验证仅出简洁气泡文字，不硬塞无关 UI 块。

### 6.3 前端视觉硬验收
- 按 `.agent/skill/opengym-development/SKILL.md` 要求，录制真实交互操作 GIF 存至 `.agent/notes/proposed/coach-genui-v2/evidence/`，展示「逐节点流式生长 → 叙事穿插排版 → 卡片内本地切指标 → 清单勾选 → 一键修改提案」完整闭环，再决定是否升格至 `.agent/notes/implemented/`。

---

## 7. 新会话继续执行指南（Hand-off）

在新会话中可直接发送：
> 「请先阅读 `.agent/notes/proposed/coach-genui-v2/REQUIREMENTS.md` 和 `.agent/skill/opengym-development/SKILL.md`，按里面的需求起草 `DESIGN.md` 与并行 `EXECUTION.md`，再用 `/orchestration` 分片实现并实测验收。」

建议后续实现按 **3 个解耦并行分片** 推进（避免文件冲突）：
- **V2-W1（共享协议与增量解析器）**：`api/agent-runtime/genui/`、`api/agent-runtime/tasks/coach-genui.js` 及单测；
- **V2-W2（NestJS 真流式编排与 Prompt）**：`api/src/agent/coach-genui.service.ts`、`coach-genui.controller.ts`、`api/openapi.yaml` 及 SSE 集成测试；
- **V2-W3（Web 叙事表面、新原语与内联交互）**：`frontend/src/lib/coach-genui-{client,hydration}.js`、`CoachGenUI.jsx`、`CoachChat.jsx`、`coach.css`、19 `locales/*.js` 及前端单测。

> 本地一键启动命令已就绪：在仓库根目录运行 `npm run dev`（或 `npm run dev:build`），自动加载 `api/.env` 中的 DeepSeek 配置并串联启动 NestJS API 与 Vite 前端。
