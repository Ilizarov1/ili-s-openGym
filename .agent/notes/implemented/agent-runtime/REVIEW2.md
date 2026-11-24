# openGym Agent 运行环境第二轮评审

[需求](REQUIREMENTS.md) · [设计](DESIGN.md) · [执行计划](EXECUTION.md) · [验收记录](ACCEPTANCE.md) · [第一轮评审](REVIEW.md)

状态：**代码整改完成，待 RN 设备复验**。评审对象为工作树 `D:\dev\open-gym-agent-runtime` 的分支 `feat/agent-runtime`，提交 `789bb3da4`（第一轮整改后的分支顶端）。本轮复核第一轮 A–F 清单，并在此之外重新检查共享核心、NestJS、Web 和 RN 的实际代码与测试。

## 整改 todo

- [x] S1 取消/提案保存竞态、confirm 的 run 状态门槛、取消/中断时过期 pending 提案
- [x] S2 附件媒体预算与文本上下文预算分离，执行 `attachmentBytes`
- [x] S3 HTTP 超时和取消覆盖响应体读取
- [x] M1 RN `start` 的幂等前置、输入 schema/数组校验、会话删除归因
- [x] M2 Web/RN requestId 复用键包含 profile/session/input
- [x] M3 Web Agent store 按账号清理
- [x] M4 RN 附件读取并写入 `meta.attachments`
- [x] M5 RN fixture `tool` 宿主参数
- [x] M6 模型记忆提案、Web/RN 记忆编辑、RN 类别/大小校验
- [x] M7 宿主记忆记录携带 scope 并传入 `selectMemories`
- [x] M8 `normalize` 嵌套条目校验与损坏文件测试
- [x] M9 RN 读取 `agent.enabled` 并显示服务器禁用态
- [x] L1 RN execution/dataVersion/取消 durationMs
- [x] L2 空提案和非法 kind 在创建时拒绝
- [x] L3 RN 拒绝提案后的按钮文案
- [x] L4 Web 会话载入失败提示
- [x] L5 B2/B3/B8 测试、文档路径/文件地图、fixture 开关文档
- [ ] RN 设备复验（D1–D5、附件、记忆编辑；需要模拟器）
- [x] B5 共享记忆 kind/limit 用例（宿主 budgets 由代码审查和该用例覆盖）
- [ ] B4 failed 分支的直接用例（当前 nest 用例仍接受 completed/failed 两条路径）

## 结论

第一轮 A–F 的代码修改基本落实，第一轮声明的测试命令本轮全部复跑通过。第二轮发现并已整改的问题：

- **3 个高优先级问题**：取消与提案保存的竞态仍会产生可确认提案；真实图片附件必然超出上下文预算；HTTP 超时和取消不覆盖响应体读取。
- **若干中优先级问题**：RN 本机路径缺少服务端已有的幂等/校验顺序；Web/RN 的 requestId 复用键不完整；Web 状态跨账号残留；RN 附件未接通；RN fixture 工具用例参数与 RN 工具名不匹配；记忆提案路径与设计不一致；A2 的 scope fail-closed 未落到真实宿主。
- **测试与文档证据仍有欠账**：B2、B3、B5、B8 和 D1–D5 没有直接测试；EXECUTION 2.1 声称的单元测试不存在；RN 设备复验仍是待验项。

建议先修复 S1–S3，再处理 M1–M5；其余项可在同一整改轮完成或明确登记为后续。

## 本轮复跑证据

所有命令在 `D:\dev\open-gym-agent-runtime` 内执行。

| 工作目录 | 命令 | 结果 |
|---|---|---|
| `api` | `npm.cmd run build` | `build: dist ready` |
| `api` | `node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js` | 28 pass / 0 fail |
| `api` | `node --test test/agent-crypto.test.js` | 4 pass / 0 fail |
| `api` | `npm.cmd run test:nest -- test/nest/agent.test.js` | 4 pass / 0 fail |
| `api` | `node --test test/openapi-routes.test.js test/nest/routes.test.js` | 5 pass / 0 fail |
| `frontend` | `npm.cmd test -- --run src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx` | 16 pass / 0 fail |
| `frontend` | `npm.cmd run build` | Vite 构建成功（仅有既有的 chunk 体积/动态导入警告） |
| `mobile-rn` | `npm.cmd run check` | lint（仅 2 条既有 warning）、lint:rules、typecheck、design:check 全过 |

另用三个独立脚本复核 S1、S2、S3，输出见对应条目。RN 设备未在本轮复跑，`ACCEPTANCE.md` 的待验项仍有效。

## 第一轮整改复核

| 项 | 结论 | 说明 |
|---|---|---|
| A1 工具检查顺序 | 通过 | `tools.js` 已是允许列表 → 参数 schema → 预算 → 目标；顺序断言存在。 |
| A2 `selectMemories` fail-closed | 本轮补齐 | 两端记忆记录已带 scope，服务端执行和 RN `selectMemories` 都传 `scope`（见 M7）。 |
| A3 `run_interrupted` | 通过 | 共享状态、服务端启动中断、RN 恢复和 openapi 已同步，boot 测试断言通过。 |
| A4 `shared.d.ts` 漂移守卫 | 通过 | 声明名和 RN 实际 import 名双向校验，28 条共享测试包含该守卫。 |
| B1 幂等前置 | 通过（部分测试） | `find()` 在 resolve/ensure 之前；profile 删除后的重试用例存在。session tombstone 后重试未直接覆盖。 |
| B2 输入 schema 同步校验 | 代码通过，本轮补测试 | `start()` 已同步 `assertValid`；nest 新增超长 prompt 400 和同 requestId 修正重试用例。 |
| B3 `normalize` 拒绝残缺文件 | 本轮补齐 | 顶层容器和 stub 已严格校验；本轮补嵌套条目校验和 `agent-store.test.js`。 |
| B4 会话删除归因 `failed` | 代码通过，测试不确定 | `execute()` 已改 `failed` + `session_deleted`；nest 用例仍接受 completed 或 failed，稳定的 completed 路径掩盖了 failed 分支。 |
| B5 任务 budgets | 代码通过，**无测试** | 服务端和 RN 都消费 `memoryItems`/`historyItems`；没有测试断言上限或类别筛选，且两个桩任务都未声明 `memoryCategories`，类别分支从未执行。 |
| B6 `onModuleInit` 等待 | 通过 | `await markInterrupted`，boot 测试通过。 |
| B7 `agent_config_corrupt` | 通过 | 4 条 crypto 用例覆盖重启解密、AAD/密文篡改、secret 缺失。 |
| B8 fixture 附件 gate | 代码通过，本轮补测试/文档 | 新增生产实例拒绝 fixture profile 的 nest 用例；`AGENT_FIXTURE_PROVIDER` 已写入 `.env.example` 和 SELF_HOSTING。 |
| B9 openapi | 通过 | 路由和错误码检查通过，`website/api.html` 已重生成。 |
| C1 requestId 生命周期 | 本轮补齐 | 终态/新会话/Retry 的 Web 用例通过；复用键已改为 profile/session/input，Web 新增切换 profile 用例、RN 同步。 |
| C2 提案确认按钮终态 | 通过（Web） | Web 用 `handledProposal` 禁用按钮；RN 的拒绝对话按钮文案有误（见 L3）。 |
| C3 demo 构建路由 | 通过 | `/agent` 和 `/agent/setup` 均补 `!DEMO`。 |
| C4 Web 测试欠账 | 通过 | 轮询停止、提案冲突、禁用态用例均存在，16 pass。 |
| D1 模块级活动运行表 | 代码通过，**无自动化/设备复验** | `activeRuns` 已提升到模块级，`recover` 会排除活 run；仍只有 typecheck/Metro 证据。 |
| D2 RN requestId + `createId` | 代码通过，**无自动化/设备复验** | requestRef 和 `createId('req', randomUUID)` 已接入；身份键问题同 M2。 |
| D3 RN `markInterrupted` | 代码通过，**无自动化/设备复验** | 已改 `run_interrupted`、`durationMs` 和排除集合；未复跑设备。 |
| D4 恢复使用 `workspaceScope` | 代码通过，**无自动化/设备复验** | `App.tsx` 已用 `workspaceScope`，传 `activeRunIds()`。 |
| D5 桩目标版本联动 | 代码通过，**无自动化/设备复验** | `targetVersion` 读取 `agent_kv`；未复跑设备确认/新提案。 |
| E1–E4 测试欠账 | 通过 | nest 附件、并发、crypto、Web 用例均在本轮通过。 |
| F1 EXECUTION 口径 | **部分** | 4.8 记录已说明合并进 `tasks.ts`；文件地图仍列 `mobile-rn/src/agent/tools.ts`（见 L5）。 |
| F2 文档入口 | 通过 | `docs/README.md` 和 `AGENTS.md` 已链接 REVIEW。 |
| F3 验收记录 | 通过 | ACCEPTANCE 已有评审整改段。 |

## 第二轮问题

### S1 取消与提案保存的竞态会留下可确认提案

- **问题**：`runAgent` 在 `run.js:302-313` 先检查取消，再 `await proposals.create(...)`；如果取消恰好发生在提案存储期间（服务端是异步 `AgentStore.update`），提案仍会写入。之后 `run.js:328-333` 发现状态已取消，只返回 cancelled 记录，不会删除提案。`AgentProposalStore.confirm`（`agent-proposal.store.ts:38-58`）也不检查提案所属 run 的状态，因此该 pending 提案仍可被确认并应用。
- **复现**：用共享核心构造一个在 `proposals.create` 中等待的提案服务，20 ms 后 `state.cancel()`，80 ms 后放行 create：

  ```text
  final cancelled proposals created 1 targetVersion 1
  ```

- **影响**：违反 R6/A7“取消后到达的模型结果不得产生可应用的提案”和 R4 的提案围栏。当前没有提案列表接口，proposal ID 也不会出现在 cancelled run 的响应中，所以实际暴露面有限；但这是明确的数据完整性违约，后续增加提案列表、通知或客户端缓存后就会变成可直接利用的问题。服务端重启标记 interrupted 时同样不会清理 pending 提案。
- **建议**：
  1. `proposals.create` 返回后立即复查 `state.acceptResult()`/`signal.aborted`；不通过时把提案标为 rejected/expired（提案服务需要内部 discard 能力），或把提案创建并入终态提交的原子步骤。
  2. `AgentProposalStore.confirm` 对带 `runId` 的提案读取对应 run，只有 `completed` 才允许应用；run 为 cancelled/interrupted/failed 时返回冲突/已过期。
  3. 取消和启动中断时把该 run 的 pending 提案一并标记过期。
  4. 增加“在提案保存期间取消”的共享/服务端用例，断言 `confirm` 失败且存储中没有 pending 提案。

### S2 真实图片附件必然超出 `contextChars`

- **问题**：`trimContext` 用 `JSON.stringify(modelInput).length` 计算上下文预算（`context.js:149-151`、`178-194`），而附件 data URL 被放进 `modelInput.user.attachments`（`run.js:199,226`）。一个 2 MiB 图片转 base64 后约 2.8 M 字符，远大于桩任务的 24,000 字符预算（`stub-task.ts:28`）。`RUN_DEFAULTS.attachmentBytes`（`contracts.js:59`）声明了 2 MiB，但从未被读取；`agent-media.ts:14` 也允许 2 MiB。结果是：`fixture:image`（1×1 PNG，约 100 字符）可以通过，任何真实照片都会失败。
- **复现**：

  ```text
  rejected context_budget_exceeded {"size":2796373,"limit":24000}
  ```

- **影响**：R1/R2 要求的图像输入在服务端（以及接通后的 RN）实际不可用；验收只覆盖了 1×1 fixture，掩盖了问题。`trimContext` 还会静默丢弃多张图片（只保留一张后仍会超限）。
- **建议**：
  1. 文本预算只计算文本、事实、记忆、历史、工具结果；附件按 `size` 和 `attachmentBytes` 单独计量，不把 data URL 计入 `contextChars`。
  2. 在共享层执行 `attachmentBytes` 和附件数量上限，媒体适配器不再各写一份常量。
  3. 不要为了满足文本预算静默删除用户本次提交的附件；应在媒体预算或模型能力处返回明确错误。
  4. 用 256 KiB/1 MiB 的真实图片补一条共享或服务端用例（fixture 之外）。

### S3 HTTP 超时和取消不覆盖响应体读取

- **问题**：`createHttpClient` 的超时定时器和外部 abort 监听在 `fetch` 返回响应头后就清理/移除了（`http.js:69-83`），而 `readLimited(response, maxBytes)` 在 `http.js:86` 才读取响应体。提供方先返回响应头、再缓慢或永不发送响应体时，超时不会触发，取消也不会中止读取。
- **复现**：本地 HTTP 服务返回响应头后延迟 400 ms 再写 body，客户端设置 `timeoutMs: 50`：

  ```text
  RESOLVED after 411 ms {"a":1}
  ```

- **影响**：违反 R1“统一处理超时、取消”。真实提供方或代理的慢响应会让 run 一直停在 `running`，`AgentService.cancel` 已写 cancelled 但底层请求仍占用连接和 `active` 表项；RN 本机同样受影响。
- **建议**：
  1. 超时和外部 abort 必须覆盖到 `readLimited` 完成，而不是只覆盖 `fetch` 的响应头阶段。
  2. 在 `readLimited` 的 reader 上响应 abort，超时映射 `model_timeout`，取消映射 `run_cancelled`。
  3. 增加“响应头已返回、body 卡住”的超时和取消测试；现有 `agent-providers.test.js` 只覆盖了 fetch 阶段。

### M1 RN 本机 `start` 缺少服务端已有的顺序和校验

- **问题**：`runtime.start`（`runtime.ts:203-230`）先 `config.resolve`、`ensureSession`，之后才计算指纹并 `beginRun`；这与第一轮 B1 在服务端修正的顺序相反。profile 被删除或 session tombstone 后，同 requestId 的重试会在 `resolve`/`ensure` 处失败，而不是返回原 run。输入 schema 也没有在创建 run 前同步校验：`runAgent` 在 `run.js:182` 才校验，RN 的 prompt 输入框没有长度限制（`AgentScreen.tsx:189`），超长输入会先创建一个 accepted/failed run。`runtime.start` 也没有拒绝数组形式的 `input`。
- **影响**：RN 本机幂等语义与 A6 不一致；无效输入会产生无意义 run，并消耗 requestId。服务端 B2 的“400 而不是 failed run”判据在 RN 上不成立。
- **建议**：把服务端的 `find` 前置逻辑抽成共享/RN 可用的 run store 查询；在 `beginRun` 前执行 `assertValid(task.inputSchema)` 和 `Array.isArray` 检查；补 RN 可执行的纯逻辑测试或明确的设备用例。

### M2 requestId 复用键不完整（Web 与 RN）

- **问题**：Web `Agent.jsx:55,110-117` 和 RN `AgentScreen.tsx:46,114-118` 只在提示词文本相同时复用 requestId。服务端指纹包含 `profileId`、`sessionId`、`attachmentIds`（`agent.service.ts:125`），RN 指纹也包含 profile/session（`runtime.ts:210-216`）。因此同一提示词下切换 profile、载入其他会话，或按 RN 的“测试提案/延迟”按钮（会加入 `fixtureCase`）都会用旧 requestId 提交不同输入，得到 `request_conflict`。这是第一轮 C1/D2 修复的未覆盖分支。
- **复现路径**：启动一个本机 fixture run（提示词 `x`）→ 运行期间点“测试提案” → 同一 requestId、输入多出 `fixtureCase: 'proposal'` → 指纹冲突。
- **建议**：把复用键改成完整提交指纹（至少 `prompt + profileId + sessionId + fixtureCase/attachmentIds`），或在 profile/session/mode/fixtureCase 改变时清空 requestRef；补 Web 和 RN 的“同文本、不同 profile/session”用例。

### M3 Web Agent 状态跨账号残留

- **问题**：`frontend/src/agent/store.js` 是模块级 Zustand store；`Agent.jsx`/`AgentSetup.jsx` 在 `user` 变化时只重新加载 profile/会话/记忆，从不清理 `activeRun`、`profiles`、`sessions`、`memories`（`Agent.jsx:60-65`）。退出登录在同一 SPA 内只 `setUser(null)`（`useStore.js:1029-1031`），没有整页刷新。同一浏览器随后登录另一个账号并进入 `/agent`，会先看到上一个账号的 run 结果、配置标签和会话/记忆列表，直到各请求返回；旧 `activeRun` 是终态时会一直显示。
- **影响**：共享浏览器场景下的跨账号数据可见性，违反 R2/R5 的账号隔离精神（虽然后端 API 仍按账号拒绝）。
- **建议**：在 `user.id` 变化时重置整个 agent store（可提供 `reset()`），或在 store 外按 `user.id` 创建/清空实例；补“用户 A 完成后切换用户 B”的组件测试。

### M4 RN 本机接受 `attachmentIds` 但从不读取附件

- **问题**：`runtime.start` 只把 `attachmentIds` 放进指纹（`runtime.ts:210-216`），`execute` 没有调用 `readAttachments`/`readAttachment`；`mobile-rn/src/agent/media.ts` 只被 `index.ts` 导出，没有调用方。`runAgent` 从 `context.meta.attachments` 读取附件（`run.js:199`），而 RN `bindContext` 的 `meta` 只有 `{ connection, prompt }`（`runtime.ts:149`）。
- **影响**：RN 本机的图像能力实际不存在；带附件的请求会静默丢掉附件，模型只看到文本。DESIGN 和 EXECUTION 4.6 声称已支持图像输入。
- **建议**：在 `runtime.start`/`execute` 用 `readAttachments` 解析已登记文件，写入 `meta.attachments`；或者暂时拒绝非空 `attachmentIds` 并修正文档。补 RN 设备用例（1×1 图片和超限）。

### M5 RN 本机 fixture `tool` 用例与 RN 工具名不匹配

- **问题**：共享 fixture provider 的 `tool` 用例默认返回 `get_stub_fact`，参数默认 `{ id: 'target-1' }`（`providers/fixture.js:49-53`）。RN 本机任务暴露的是 `get_workspace_fact`/`get_workspace_target`（`tasks.ts:128-130`），目标范围是 `local-profile`/`local-queue`（`tasks.ts:41-43`），而 RN gateway 没有传 `toolName`/`arguments`（`gateway.ts:32-38`）。因此 RN 本机的 `fixtureCase: 'tool'` 会得到 `tool_not_allowed` 或 `tool_target_out_of_scope`，不会成功执行工具。
- **影响**：RN 的 fixture 工具路径未被验收（UI 只暴露 proposal/late），但输入 schema 允许 `tool`；共享 provider 的可配置项没有在 RN 宿主配置。
- **建议**：RN gateway 为 fixture 传 `toolName: 'get_workspace_fact'` 和 `arguments: { id: LOCAL_PROFILE }`（或让任务声明 fixture 工具）；补 RN 纯逻辑/设备用例。

### M6 长期记忆的提案路径与设计不一致，编辑能力缺失

- **问题**：
  1. DESIGN §5 写模型输出 `kind: 'memory'` 的提案，实际共享实现使用 `kind: 'memory.save'`（`memory.js:99`）。`runAgent` 对所有提案都要求 `targetId` 在 `context.targetScope` 内（`run.js:281-286`），没有独立的记忆提案分支：模型若返回 `memory.save`，必须借用 `targetScope` 内的业务目标 ID 才能通过创建检查，adapter 随后又忽略该 target 和 `targetVersion` 去写记忆。未被模型路径使用的 `createMemoryProposal` 能构造正确的记忆提案，但它没有接到任何任务。
  2. 服务端 `AgentProposalAdapter` 和 RN `confirmProposal` 对 `memory.save` 都不检查 `targetVersion`（`agent-proposal.adapter.ts:17-18`、`runtime.ts:305-312`），与 R5“目标已变化时丢弃”不一致。
  3. R5 要求长期记忆“支持查看、编辑和删除”，但 Web 和 RN 只有新建/删除（`Agent.jsx:236-251`、`AgentScreen.tsx:242-275`），虽然服务端有 PATCH 路由。
  4. RN 记忆类别是自由文本（`AgentScreen.tsx:245`），`runtime.saveMemory`/`store.saveMemory` 不校验 `isMemoryCategory`，也没有服务端 4 KB 的值上限（`agent-memory.store.ts:10-19`）。
- **影响**：R5 的记忆提案、版本检查和编辑能力与设计要求不完全一致；RN 可以写入任意类别和超大值。
- **建议**：统一 `kind` 名称和记忆提案的 target/version 约定；在 confirm 时检查版本；补 Web/RN 编辑入口或明确登记为首期外；RN 复用 `isMemoryCategory` 和值上限。

### M7 `selectMemories` 的 scope 守卫没有落到真实宿主

- **问题**：`selectMemories` 在传入 `scope` 时要求 `memory.scope === scope`（`memory.js:34-38`），但服务端 `agent.service.ts:206-210` 和 RN `runtime.ts:126-130` 都没有传 `scope`；同时两端存储的 `AgentMemory` 记录没有 `scope` 字段（`agent-memory.store.ts:36-48`、`mobile-rn/src/agent/types.ts:10-21`），因为隔离由账号文档/数据库 scope 列完成。因此 A2 的 fail-closed 只在共享测试的 `createMemoryStore` 记录上有效，真实宿主若误传 `scope` 反而会过滤掉全部记忆。
- **影响**：A2 的整改记录声称“宿主忘记预过滤也不能泄漏”，实际宿主路径没有该保护，记录与实际能力不符。
- **建议**：二选一并写清契约：给宿主记忆记录补 `scope` 并让两端传 `scope`，或者删除/降级 `scope` 选项，改为在存储层保证并以测试覆盖。至少补一条宿主路径的越 scope 测试。

### M8 `normalize` 只校验顶层容器，嵌套损坏仍会绕过稳定错误码

- **问题**：`agent.store.ts:50-69` 只检查 `profiles`/`runs`/`requestIndex`/`sessions`/`memories`/`proposals` 是对象，以及 stub 的三个字段；没有检查每个条目是对象及其必备字段。例如 `runs: { run_x: null }` 可以通过读取，随后 `onModuleInit` 的 `run.status` 会抛 TypeError（被吞掉），`get`/`confirm` 等路径可能得到普通 500 `invalid_request`，而不是 `agent_store_corrupt`。B3 的目标是“结构错误不得被静默当成空文档”，当前只完成了一半。
- **建议**：对每个 profile/run/session/memory/proposal/target 做最小结构校验；不合法时统一 `agent_store_corrupt`。补合法 JSON 但嵌套损坏的文件用例（当前没有任何 `agent_store_corrupt` 测试）。

### M9 RN 不读取 `agent.enabled`，回退提示与文档不一致

- **问题**：EXECUTION 5.8 记录“Web/RN 入口提示禁用”，Web 读 `/api/config` 的 `agent.enabled`，RN 没有任何地方读取该字段（`AgentScreen`/`AgentProfileScreen` 也没有配置入参）。关闭服务端开关后，RN 的服务器模式只会在每次请求时收到 503，不会在入口显示禁用状态；本机模式仍可用。
- **建议**：如果 RN 本机应继续可用，文档改为“Web 入口提示禁用，RN 服务器模式按 503 提示”；如果要统一，把 `agent.enabled` 传入 RN 并渲染禁用态。

### L1 R6 运行记录字段不完整

- **问题**：
  - RN `AgentRunRow`/`rowOf`（`types.ts:28-45`、`runtime.ts:41-59`）没有 `execution`/`executionLocation`，`dataVersion` 列存在但从未写入；服务端 `dataVersion` 固定为 `1`（`agent.service.ts:145`）。
  - RN `cancel` 的非活动分支（`runtime.ts:260`）写入 cancelled 时没有 `durationMs`，而服务端 cancel 和共享 state 会计算。
- **影响**：R6 要求记录执行位置、数据来源与版本、耗时；当前只部分满足，且 RN 取消可能缺少耗时。
- **建议**：统一 run 记录的 `execution`/`dataVersion` 字段；用真实数据版本或明确标记为桩；补 `durationMs`。

### L2 空提案和非法 kind 在创建时未拒绝

- **问题**：`run.js:299-301` 只检查 `candidate.changes` 是数组，空数组也会创建提案；服务端 `proposalCreator`（`agent.service.ts:167-179`）不再校验 kind 的格式或改动结构。`AgentProposalAdapter` 的 stub.write 在空 changes 时仍会 `target.version += 1` 并写一条写记录（`agent-proposal.adapter.ts:35-52`）。非法 kind 要到确认时才在 adapter 报错。
- **建议**：创建前要求 `changes.length > 0`，按任务/适配器 schema 校验每个 change，并校验 kind；补空提案/非法 kind 用例。

### L3 RN 拒绝提案后确认按钮显示“已应用”

- **问题**：`AgentScreen.tsx:162-166` 的 reject 也设置同一个 `handledProposal`；确认按钮文案只看 id（`AgentScreen.tsx:216`），所以拒绝后按钮变成“已应用”。
- **建议**：handledProposal 同时记录 status，或分开 `handledProposalId` 与 `handledAction`。

### L4 Web 载入会话失败无用户提示

- **问题**：`Agent.jsx:212-216` 的 Load 点击处理没有 try/catch；会话被删除后 `getSession` 返回 409，promise 未处理，页面无提示。
- **建议**：与 RN 一样 catch 并显示错误。

### L5 测试与文档欠账

- `EXECUTION.md` 2.1 判据写“单元测试得到预期路径”，但不存在 `agentFile` 的单元测试；要么补测试，要么改记录口径。
- `EXECUTION.md:31` 文件地图仍列 `mobile-rn/src/agent/tools.ts`，实际工具合并在 `tasks.ts`（F1 只改了 4.8 的记录）。
- B2（超长 prompt 400）、B3（损坏文件）、B5（memory/history 预算和类别）、B8（生产实例拒绝 fixture）没有直接测试；B4 的 failed 分支仍是不确定测试。
- D1–D5 没有 RN 自动化测试，设备复验仍列在 `ACCEPTANCE.md` 待验项；本轮只复跑了 `npm run check`。
- `AGENT_FIXTURE_PROVIDER` 是 `fixtureAllowed()` 的开关，但没有出现在 `.env.example` 或 `SELF_HOSTING.md`；非 Docker 部署若未设置 `NODE_ENV=production`，fixture 会默认开启。
- DESIGN §6 的接口清单把 `/agent/configs` 和 `/agent/sessions` 的 `PATCH/DELETE/:id` 写成同一条路径，实际是 `/:profileId` 和 `/:sessionId`，建议改成准确路径。

## 建议整改顺序

1. **S3**：把超时/取消覆盖到响应体；这是所有真实模型调用的基础。
2. **S2**：分离媒体预算和文本预算；否则真实图片功能不可用。
3. **S1**：提案创建与终态的竞态，以及 confirm 的 run 状态门槛。
4. **M1、M2、M3**：RN 本机幂等/校验、requestId 身份、Web 跨账号清理。
5. **M4、M5、M6、M7**：RN 附件与 fixture 工具、记忆提案/编辑、scope 守卫。
6. **M8、M9、L1–L5**：损坏文件校验、RN 禁用态、R6 字段、提案校验、文案和证据补齐。

## 整改结果

2026-11-21 已按上面的 todo 完成代码修改。主要落点：

| 项 | 修改 | 验证 |
|---|---|---|
| S1 | `run.js` 在提案保存后复查取消并调用 `discard`；服务端/RN cancel 与启动中断过期 pending 提案；`AgentProposalStore.confirm` 要求来源 run 为 completed | 共享 18 条运行时用例；nest 6 条（含未完成 run 提案 409） |
| S2 | `context.js` 的文本预算排除附件 data URL，按 `attachmentBytes` 校验媒体大小 | 共享 `image payloads use the media budget` 用例 |
| S3 | `providers/http.js` 的超时/取消覆盖 `readLimited`，reader 在 abort 时取消 | provider 11 条，含 stalled body 超时和取消 |
| M1 | RN `start` 先算指纹和 `findRun`，再 resolve/session/附件；同步 schema 与数组校验；启动时会话删除归因 `failed` | RN `npm run check`；共享顺序由代码审查和设备待验 |
| M2 | Web/RN requestRef 使用完整提交键（profile/session/input） | Web 新增 profile 切换用例；RN typecheck |
| M3 | Web agent store 增加 `ownerId/reset/ensureOwner`，页面在账号切换时拒绝绘制旧状态 | Web 新增跨账号清理用例 |
| M4 | RN 从 `photoUploads` 解析附件，读取 2 MiB 图片并写入 `context.meta.attachments` | RN typecheck/Metro；设备待验 |
| M5 | RN fixture gateway 传 `get_workspace_fact` + `local-profile` | RN typecheck/Metro |
| M6 | 共享 run 支持 `memory.save`；服务端/RN 记忆 scope；Web/RN 编辑入口；RN 固定类别和 4 KB 上限 | 共享 memory proposal 用例；Web memory 更新用例 |
| M7 | 服务端/RN 记忆记录携带 scope，`selectMemories` 传 `scope`；API 响应剥离 scope | 共享 scope 用例；nest A5 |
| M8 | `agent.store.ts` 校验每个 profile/run/session/memory/proposal/target 条目；新增 `agent-store.test.js` | agent-store 4 条 |
| M9 | RN `server.status()` 读取 `/api/config` 的 `agent.enabled`，服务器模式显示禁用态 | RN typecheck；设备待验 |
| L1 | RN 新增 execution/dataVersion 字段及 SQLite 迁移；取消补 durationMs；服务端 `dataVersion` 仍为桩值 1 | RN typecheck；设备待验 |
| L2 | 空 changes/非法 kind 在创建时拒绝；adapter/store 兜底 | 共享空提案用例 |
| L3 | RN handledProposal 记录 consumed/rejected | RN typecheck |
| L4 | Web 载入会话失败显示 toast | Web 组件测试 |
| L5 | B2/B3/B8 测试、EXECUTION 文件地图、fixture 开关文档、DESIGN 路径/kind | 见 ACCEPTANCE 第二轮整改表 |

仍未完成：RN 设备复验；B4 的 failed 分支和 B5 的任务 memory budgets 的直接用例。共享测试 42 pass、nest 6 pass、Web 19 pass、Web/RN 构建通过。

## 本轮不纳入

以下仍沿用第一轮“明确不做”的判断，或需要产品决策：真实 OpenAI 结构化输出/提案解析、`addEvidence` 与 `targetScope` 合并语义、轮次耗尽错误码、RN 本机配置能力表、提案在“本轮未读过目标”时的版本校验策略。它们不应阻塞 S1–S3 的修复，但应与本文件中的记忆提案（M6）和真实供应商项一起排期。
