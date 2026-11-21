# openGym Agent 运行环境评审整改

[需求](REQUIREMENTS.md) · [设计](DESIGN.md) · [执行计划](EXECUTION.md) · [验收记录](ACCEPTANCE.md)

状态：整改完成（见分支顶端提交 "Address agent runtime review findings"）。本文件由对提交 `3024072ff` 的三方评审（共享核心、NestJS 服务端、Web/RN 客户端）汇总而来，是本轮整改的执行清单；清单 A–F 已全部完成并勾选。共享核心 27 条测试在评审时实跑通过，与本清单不冲突的既有验收结论继续有效。

## 评审结论摘要

- 无阻断项：两道围栏、按账号串行存储、凭据密封、取消竞态、终态一次写入、scope 隔离实现正确。
- 主要问题：幂等重试的检查顺序、Web requestId 复用语义、RN runtime 生命周期导致取消失效、`normalize` 静默清零，以及 EXECUTION.md 部分判据的测试证据欠账。
- 修改遵循 [EXECUTION.md](EXECUTION.md) 的状态维护约定：每完成一项立即勾选并填写记录。

## 修改清单

### A 共享核心（`api/agent-runtime/`）

- [x] **A1 工具派发器检查顺序与设计文档对齐**
  - 问题：`tools.js` 在参数校验之前检查调用预算；DESIGN §4 / EXECUTION 1.6 的顺序是 允许列表 → 参数结构 → 调用次数 → 目标 → 归属回调。
  - 动作：把预算检查移到 `argsSchema` 校验之后；补一条"预算耗尽且参数错误时返回 `tool_args_invalid`"的顺序用例。
  - 记录：2026-11-21，`tools.js:121-131` 调整顺序；`agent-runtime.test.js` 增加顺序断言，全绿。

- [x] **A2 `selectMemories` 收紧为 scope fail-closed**
  - 问题：`memory.js` 对无 `scope` 字段的记录放行任意 scope 过滤；A5 的跨 scope 隔离依赖宿主恰好总是预过滤。
  - 动作：scope 过滤存在时要求 `memory.scope === scope`；补用例断言无 scope 记录不被选入。
  - 记录：2026-11-21，`memory.js:33-38` fail-closed；共享测试补 m4（无 scope）用例，通过。

- [x] **A3 新增 `run_interrupted` 错误码**
  - 问题：`state.js interrupted()` 复用 `run_terminal`，中断与"操作已终态"共用一个码，R6 要求可区分。
  - 动作：`errors.js` 增加 `run_interrupted`（409）；`state.js` 使用之；服务端 `agent-run.store.ts`、RN `store.ts` 的 markInterrupted 同步改码；openapi 枚举补码；nest 测试断言同步更新。
  - 记录：2026-11-21，`errors.js`、`state.js:94`、`agent-run.store.ts:98`、`store.ts:257` 及 nest 测试同步；boot 测试断言 `run_interrupted` 通过。

- [x] **A4 增加 `shared.d.ts` 漂移守卫**
  - 问题：`mobile-rn/src/agent/shared.d.ts` 是手写类型子集，共享核心改名时 RN typecheck 静默通过、运行时才失败。
  - 动作：`agent-portability.test.js` 增加"shared.d.ts 引用的每个函数导出名都存在于 `api/agent-runtime/index.js`"的静态断言。
  - 记录：2026-11-21，新增守卫用例（声明名 + RN 实际 import 名双向校验；`AgentRunState`/`AgentRunRecord` 为结构替身显式豁免），通过。

### B 服务端（`api/src/agent/`）

- [x] **B1 幂等去重前置，闭合 A6 重试契约**
  - 问题：`agent.service.ts start()` 先 `configs.resolve`/`sessions.ensure` 再 `runs.begin`；首次提交后配置被删或会话进入 tombstone 时，同 requestId 重试得到 404/409 而非原作业；不同输入的冲突请求先产生 ensure 副作用。
  - 动作：`AgentRunStore` 增加 `find(uid, requestId, requestHash)`（命中返回原作业，指纹不符抛 `request_conflict`）；`start()` 在 resolve/ensure 之前先查。
  - 记录：2026-11-21，`agent-run.store.ts` 增加 `find()`，`agent.service.ts start()` 前置；nest 新用例"profile 删除后重试返回原 runId"通过。并发首次提交仍由 `begin()` 原子裁决。

- [x] **B2 任务输入 schema 同步校验**
  - 问题：`inputSchema` 校验发生在异步执行里（run.js），超长 prompt 得到 202 + failed run 而非 400，且消耗一个去重 requestId。
  - 动作：`start()` 在 `parseStart` 后用共享 `assertValid` 先校验 `request.input`。
  - 记录：2026-11-21，`agent.service.ts:107-110`；超长 prompt 现在直接 400，不再创建 run。

- [x] **B3 `normalize` 拒绝结构残缺文件**
  - 问题：`agent.store.ts` 对"合法 JSON 但结构错误"的文件静默归一化为空文档并回写 `schema: 1`，`requestIndex` 去重索引随之丢失；违反 EXECUTION 2.3 判据。
  - 动作：校验 `schema === 1` 且 `profiles/runs/requestIndex/sessions/memories/proposals` 为对象、`stub` 结构完整，不符抛 `agent_store_corrupt`。
  - 记录：2026-11-21，`agent.store.ts normalize` 严格化；boot 测试的存量 `schema:1` 文件继续可读。

- [x] **B4 会话删除归因为 `failed` 而非 `cancelled`**
  - 问题：`execute()` 中会话在执行前被删时 run 被标为 `cancelled`，统计语义错误；nest 测试弱断言（接受 completed）掩盖了两条路径。
  - 动作：改为 `state.failed({ code: 'session_deleted' })`；测试断言改为 `failed` + `session_deleted`。
  - 记录：2026-11-21，`agent.service.ts` 改为 `state.failed`；nest 断言收紧为 `['completed','failed']` 且 failed 时错误码必须是 `session_deleted`（删除通常晚于会话检查，稳定路径是 completed，race 路径归因正确）。

- [x] **B5 任务 budgets 被服务端组装消费**
  - 问题：`execute()` 里记忆/历史上限硬编码（limit 8 / slice(-8)），任务声明的 `memoryItems/historyItems` 未消费。
  - 动作：用 `withRunDefaults(task.budgets)` 取 `memoryItems`/`historyItems`；任务声明 `memoryCategories` 时按类别筛选。
  - 记录：2026-11-21，`agent.service.ts execute()` 消费任务 budgets；`contracts.d.ts` 的 `TaskDefinition` 声明 `memoryCategories`。RN `runtime.ts` 同步消费（见 D1）。

- [x] **B6 `onModuleInit` 等待中断标记完成**
  - 问题：`markInterrupted` 以 `void` 触发未等待，启动后瞬间轮询可能读到仍是 `running` 的遗留作业。
  - 动作：`onModuleInit` 改 async 并 await。
  - 记录：2026-11-21，改 async + 单账号失败不阻塞 boot；boot 中断测试仍绿。

- [x] **B7 解密失败使用独立错误码 `agent_config_corrupt`**
  - 问题：`agent-crypto.ts` 把密文篡改、密钥轮换后的解密失败都映射为 `agent_config_disabled`（503"实例没有 secret"），信息误导。
  - 动作：`errors.js` 增加 `agent_config_corrupt`（500）；解密失败与版本不符改用之；openapi 枚举补码。
  - 记录：2026-11-21，`agent-crypto.ts decrypt` 改码；`agent-crypto.test.js` 4 用例覆盖重启解密/AAD 篡改/密文篡改/secret 缺失。

- [x] **B8 `fixture:image` 附件受 fixture 生产限制约束**
  - 问题：`agent-media.ts` 的 fixture 附件不经过 `fixtureAllowed()`，与 fixture 配置的生产限制不一致。
  - 动作：`fixtureAllowed()` 移到 `agent.flags.ts`，配置存储与媒体适配共用；生产实例拒绝 fixture 附件。
  - 记录：2026-11-21，`agent.flags.ts fixtureAllowed()`，`agent-config.store.ts`/`agent-media.ts` 共用。

- [x] **B9 openapi 修正**
  - 问题：GET `/agent/sessions/{sessionId}` 不存在与已删除都返回 409，openapi 却列了 404。
  - 动作：移除该 404 引用；`AgentError.code` 枚举补 `run_interrupted`、`agent_config_corrupt`；重新生成 `website/api.html`。
  - 记录：2026-11-21，`openapi.yaml` 三处修正；`node scripts/build-api-docs.mjs` 重生成（108 endpoints）；`openapi-routes.test.js`/`routes.test.js` 双向枚举通过。

### C Web（`frontend/src/`）

- [x] **C1 requestId 生命周期修复**
  - 问题：`Agent.jsx` 按"提示词文本"复用 requestId 且从不复位——run 完成后同文本永远命中去重返回旧作业；"New conversation" 后同文本 409 `request_conflict`。
  - 动作：run 到达终态后清空 requestRef；"New conversation" 一并清空；Retry 视为显式新任务生成新 requestId（响应丢失场景的重试仍由 requestRef 复用覆盖，A6 契约不变）。
  - 记录：2026-11-21，`Agent.jsx` 增加终态清空 effect、`onRetry` 生成新 id；`Agent.test.jsx` 用例覆盖"运行中复用 → 终态后新 id → 新会话新 id"。

- [x] **C2 提案确认/拒绝后按钮反映终态**
  - 问题：确认后 `activeRun.result.proposal.status` 仍是 `pending`，按钮不禁用，重复点击全靠服务端幂等兜底。
  - 动作：页面维护已处理的 proposalId 状态，处理后禁用按钮。
  - 记录：2026-11-21，`Agent.jsx handledProposal` 状态；测试断言确认后按钮变为 Applied 且禁用。

- [x] **C3 `/agent` 路由排除 demo 构建**
  - 问题：路由守卫只看 `user && !MOBILE`，设置入口条件是 `!!ctx.user && !ctx.mobile && !ctx.demo`，demo 实例可直接 URL 访问。
  - 动作：守卫补 `!DEMO`。
  - 记录：2026-11-21，`App.jsx` 两条 agent 路由守卫补 `!DEMO`；`npm.cmd run build` 通过。

- [x] **C4 补 Web 测试欠账（EXECUTION 3.8 判据）**
  - 问题：无"轮询停止"用例（'cancels an open run' 反而手动调 `stopPolling()` 掩盖实现）、无 `proposal_conflict` 展示用例、AgentSetup 无禁用态用例。
  - 动作：补三组用例：fake timers 验证卸载后轮询停止；confirm 冲突展示错误；`agent.enabled=false` 时 setup 页显示禁用提示。
  - 记录：2026-11-21，`Agent.test.jsx` 4 个新用例 + 移除手动 stopPolling；`AgentSetup.test.jsx` 禁用态用例；`vitest run` 16/16 通过。

### D RN（`mobile-rn/src/`）

- [x] **D1 活动运行注册表提升为模块级**
  - 问题：`runtime.ts` 的 `active` Map 随 `createLocalRuntime` 闭包创建，`AgentScreen` 的 `useMemo([connection, data])` 在配对账号自动 sync（≤30 秒）时重建 runtime，进行中 run 的 `AbortController` 随旧闭包丢失，取消无法中止模型调用。
  - 动作：`active` 提升为 `runtime.ts` 模块级 Map（按 runId）；导出 `activeRunIds()` 供恢复逻辑排除活 run。
  - 记录：2026-11-21，`runtime.ts` 模块级 `activeRuns` + `activeRunIds()`；`runtime.recover()` 传排除集；typecheck 通过。

- [x] **D2 requestId 重试语义 + 共享 `createId`**
  - 问题：`AgentScreen.start()` 每次点击都新生成 requestId，服务端响应丢失后重试会创建第二个作业（A6 客户端语义落空）；且未按 EXECUTION 4.13 用共享 `createId` 生成。
  - 动作：与 C1 相同的 requestRef 语义；用共享 `createId('req', randomUUID)` 生成。
  - 记录：2026-11-21，`AgentScreen.tsx` requestRef + 终态清空 + `createId`；`src/agent/index.ts` 导出 `createId`。

- [x] **D3 `markInterrupted` 修正 `durationMs` 与错误码**
  - 问题：`store.ts` 把 `durationMs` 写成 `Date.now()` epoch 值（≈1.7e12）；错误码为 `run_terminal`。
  - 动作：`durationMs = now - COALESCE(startedAt, createdAt)`；错误码改 `run_interrupted`；签名增加排除集合，跳过本进程活 run。
  - 记录：2026-11-21，`store.ts markInterrupted` 双 SQL 分支（带/不带排除集）。

- [x] **D4 恢复逻辑使用 `workspaceScope` 并排除活 run**
  - 问题：`App.tsx` 手写 `${server}|${user.id}` 重复 `scopeOf` 逻辑（分隔符变化时守卫静默失效）；工作区切换触发的恢复会把本进程活 run 误标中断。
  - 动作：App.tsx 改用 `workspaceScope(connection)`；`recoverAgentRuns` 接受并传入 `activeRunIds()`。
  - 记录：2026-11-21，`App.tsx:90` 用 `workspaceScope`；`recovery.ts` 签名扩展；恢复传 `activeRunIds()`。

- [x] **D5 桩目标版本与 kv 联动**
  - 问题：`tasks.ts` 硬编码版本 1，首次提案确认（写 version 2）后设备上的提案确认永久 `proposal_conflict`，无复位入口。
  - 动作：`createLocalTask`/`createLocalTools` 接受目标版本读取器，从 `agent_kv` 读当前版本；确认后新提案使用新版本。
  - 记录：2026-11-21，`tasks.ts` `TargetVersionReader`；`runtime.ts` 注入 `store.readKv(scope, 'target:<id>')?.version ?? 1`。

### E 测试与证据欠账（EXECUTION 判据）

- [x] **E1 服务端 A2 越权与媒体路径集成用例**
  - 动作：nest 测试补：他人 attachment hash 引用被拒；`fixture:image` 附件端到端完成（媒体适配首次被集成测试触达）。
  - 记录：2026-11-21，nest 新用例：非法 hash 与未知 64-hex 引用 400（随 B2 移入提交校验）；`fixture:image` 运行 completed。

- [x] **E2 A6 并发重试与 2.3 并发更新用例**
  - 动作：nest 测试补：Promise.all 两个同 requestId 提交 → 同一 runId；并发两个配置创建 → 两条都落盘。
  - 记录：2026-11-21，两个并发用例加入首个 nest 测试块，全部通过。

- [x] **E3 EXECUTION 2.4 加密判据单元用例**
  - 动作：新增 `api/test/agent-crypto.test.js`（运行于 `npm.cmd run build` 之后，导入 dist）：同 secret 重启解密；改 AAD/密文失败返回 `agent_config_corrupt`；secret 缺失 `agent_config_disabled`。
  - 记录：2026-11-21，4 用例全绿（`node --test test/agent-crypto.test.js`；注意 AgentError 需从 `dist/agent-runtime/errors.js` 导入，与 dist 内类实例一致）。

- [x] **E4 C1/C4/C2 的 Web 用例与断言更新**
  - 动作：随 C1–C4 一起落在 `Agent.test.jsx`/`AgentSetup.test.jsx`。
  - 记录：2026-11-21，`vitest run src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx` 16/16。

### F 文档

- [x] **F1 EXECUTION.md 口径修正**
  - 动作：4.8 记录行注明工具落点合并进 `tasks.ts`；2.18 "15 条路径"修正为实际 path/operation 口径。
  - 记录：2026-11-21，4.8 记录行补落点说明；2.18 在本轮整改核实时已是"16 条路径"口径（提交 3024072ff 已自行修正），无需再改。

- [x] **F2 文档入口**
  - 动作：`docs/README.md` agent-runtime 行补 REVIEW.md 链接；`AGENTS.md` 目录地图加 REVIEW.md。
  - 记录：2026-11-21，两处已更新。

- [x] **F3 验收记录追加整改段**
  - 动作：`ACCEPTANCE.md` 增加"评审整改"小节，记录本轮命令与结果。
  - 记录：2026-11-21，已追加。

## 本轮明确不做的后续项

以下问题需要设计决策或真实任务接入才有意义，仅记录，不在本轮修改：

1. **真实 OpenAI 提供商的结构化输出/提案解析**：`openai.js` 恒返回 `structured: null` 且无文本→JSON 解析路径，提案流程目前只有 fixture 能端到端；需复用 Coach 的结构化输出逻辑后接入（对应 ACCEPTANCE"真实供应商兼容性另行记录"）。
2. **`addEvidence` 与 `targetScope` 的合并语义**：所有事实 objectId 必须落在 targetScope 内，把"可读事实"与"可操作目标"合成一个集合；真实业务任务接入前需重新设计。
3. **`run.js` 轮次耗尽的错误码**（现为 `invalid_request`）与 `runAgent` 返回形状的类型注解。
4. **RN 本机配置能力表**（`capabilitiesOf` 恒全真，`assertCapabilities` 形同虚设）。
5. **提案目标版本在"本轮未读过该目标"时跳过校验**（confirm 时适配器仍兜底）。
