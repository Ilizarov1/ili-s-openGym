# openGym Agent 运行环境执行计划

[需求](REQUIREMENTS.md) · [技术设计](DESIGN.md)

状态为待执行。所有命令使用 PowerShell。以下检查在实施对应阶段时运行；未执行的设备或环境检查在验收记录中标记为待验。

## 范围与约束

- 目标客户端只有 Web（`frontend/src`）和 RN Android（`mobile-rn`）。不修改 `frontend/android`、`frontend/ios`、watch 端，也不为旧版 Capacitor/已安装 App 保留 API 兼容分支。
- Web 只使用服务端执行；RN 支持本机和服务端执行。
- API 可以和 Web、RN 同批改动，允许移除旧字段、旧路由或旧响应形状；不新增双写、双路由或版本协商。
- 首期使用桩任务、桩工具和桩业务适配器验收，不接入真实训练写入。真实写入口需要证明原子性后再注册。
- 每个需求使用独立 worktree 和分支。本文默认分支 `feat/agent-runtime`，工作树放在仓库同级目录；使用当前 Agent 的 worktree 工具或 `git worktree add` 均可。

## 文件地图

| 区域 | 新增 | 修改 |
|---|---|---|
| 共享核心 | `api/agent-runtime/contracts.js`、`contracts.d.ts`、`errors.js`、`schema.js`、`ids.js`、`context.js`、`tools.js`、`proposals.js`、`state.js`、`memory.js`、`model-gateway.js`、`run.js`、`index.js`；`api/agent-runtime/providers/http.js`、`endpoint.js`、`fixture.js`、`openai.js`、`index.js` | `api/scripts/build-api.mjs`、`mobile-rn/metro.config.js` |
| API | `api/src/agent/agent.types.ts`、`agent.store.ts`、`agent-crypto.ts`、`agent-config.store.ts`、`agent-run.store.ts`、`agent-session.store.ts`、`agent-memory.store.ts`、`agent-proposal.store.ts`、`agent-gateway.ts`、`agent.service.ts`、`agent.flags.ts`、`agent.module.ts`；`api/src/agent/tasks/stub-task.ts`、`tools/stub-tools.ts`、`agent-proposal.adapter.ts`、`agent-media.ts`；`agent-runs.controller.ts`、`agent-configs.controller.ts`、`agent-sessions.controller.ts`、`agent-memories.controller.ts`、`agent-proposals.controller.ts` | `api/src/common/persistence/paths.ts`、`api/src/app.module.ts`、`api/src/system/system.controller.ts`、`api/openapi.yaml`、`scripts/build-api-docs.mjs`、`.env.example` |
| API 测试 | `api/test/agent-runtime.test.js`、`agent-providers.test.js`、`agent-portability.test.js`、`agent-fixtures.mjs`、`api/test/nest/agent.test.js` | 无 |
| Web | `frontend/src/agent/api.js`、`store.js`、`api.test.js`；`frontend/src/views/Agent.jsx`、`AgentSetup.jsx`、`Agent.test.jsx`、`AgentSetup.test.jsx` | `frontend/src/App.jsx`、`frontend/src/views/settings-pages.js`、`frontend/src/views/Settings.jsx`、`frontend/src/locales/*.js`（按需） |
| RN | `mobile-rn/src/agent/types.ts`、`store.ts`、`config.ts`、`gateway.ts`、`media.ts`、`tasks.ts`、`tools.ts`、`runtime.ts`、`server-client.ts`、`recovery.ts`、`index.ts`；`mobile-rn/src/screens/AgentScreen.tsx`、`AgentProfileScreen.tsx` | `mobile-rn/src/storage.ts`、`mobile-rn/src/screens/index.ts`、`mobile-rn/src/screens/SettingsScreen.tsx`、`mobile-rn/App.tsx` |
| 文档 | `docs/agent-runtime/ACCEPTANCE.md` | `docs/agent-runtime/EXECUTION.md`、`DESIGN.md`、`REQUIREMENTS.md`、`docs/README.md`、`docs/RN_MIGRATION_STATUS.md`、`AGENTS.md`、`docs/SELF_HOSTING.md` |

## 阶段 0 基线与决策

退出条件：独立工作树已建立，版本和契约已记录，桩数据可被测试引用。

| 步骤 | 文件 | 动作 | 完成判据 |
|---|---|---|---|
| 0.1 工作树 | Git 元数据 | 用 worktree 工具或 `git worktree add ..\open-gym-agent-runtime -b feat/agent-runtime` 创建独立工作树；后续命令都在其中执行 | `git branch --show-current` 为 `feat/agent-runtime`，原工作区改动未混入 |
| 0.2 版本记录 | `docs/agent-runtime/ACCEPTANCE.md`（新） | 建立“环境、命令、预期、实际、证据”表；记录 Node、npm、Java、Android SDK、Expo、adb 版本 | 文档中有可复核的版本行 |
| 0.3 契约冻结 | `docs/agent-runtime/DESIGN.md` | 确认已写入：JSON Schema 受限子集、`targetScope`、`data/secret` 派生密钥、本机 `phoneMayCall`、Web 仅服务端、接口清单 | 设计文档不再有“由所属模块提供”的空白接口 |
| 0.4 桩数据 | `api/test/agent-fixtures.mjs`（新） | 导出两个账号、两个工作区、同一对象两个版本、未同步记录、1×1 PNG；导出 fixture 模型用例 `text`、`tool`、`proposal`、`error`、`late` | `node -e "import('./api/test/agent-fixtures.mjs').then(m => console.log(Object.keys(m)))"` 输出预期键 |
| 0.5 基线命令 | 无 | 在 `api`、`frontend`、`mobile-rn` 分别执行一次安装和现有检查，确认基线可跑 | 现有命令无新增失败；失败先记录，不归因于本需求 |

```powershell
git worktree add ..\open-gym-agent-runtime -b feat/agent-runtime
Set-Location ..\open-gym-agent-runtime
node -v; npm.cmd -v; java -version; adb version; npx.cmd expo --version
```

## 阶段 1 共享运行核心

退出条件：`api/test/agent-runtime.test.js`、`agent-providers.test.js`、`agent-portability.test.js` 通过；API 构建产物包含 `dist/agent-runtime/index.js`。

| 步骤 | 文件 | 动作 | 完成判据 |
|---|---|---|---|
| 1.1 契约 | `api/agent-runtime/contracts.js`（新）、`contracts.d.ts`（新） | 定义 `RunRequest`、`TaskDefinition`、`RunContext`、`ModelInput`、`ModelOutput`、`RunResult`、`ToolDefinition`、`ToolCall`、`Proposal`、`MemoryRecord`、`RunRecord`；写入 `AGENT_SCHEMA_VERSION = 1`。`TaskDefinition` 含 `targetScope(input, context)`、`budgets`、步骤工具列表；`RunContext` 含解析后的 `targetScope` 和 `execution` | 类型被 `contracts.d.ts` 导出；Node 可导入，无 Node 内建依赖 |
| 1.2 错误码 | `api/agent-runtime/errors.js`（新） | 定义 `AgentError` 和稳定错误码：`invalid_request`、`scope_denied`、`profile_not_found`、`profile_capability_missing`、`context_budget_exceeded`、`fact_missing`、`tool_not_allowed`、`tool_args_invalid`、`tool_target_out_of_scope`、`tool_budget_exceeded`、`proposal_not_found`、`proposal_conflict`、`proposal_consumed`、`run_not_found`、`run_terminal`、`model_unavailable`、`model_timeout`、`model_response_too_large`、`session_deleted`、`memory_not_found`、`agent_disabled` | 每个错误有 HTTP 状态和可展示信息；单元用例覆盖映射 |
| 1.3 schema | `api/agent-runtime/schema.js`（新） | 实现 JSON Schema 2020-12 受限子集校验：`type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`、`oneOf`、`minLength`、`maxLength`、`pattern`、`minimum`、`maximum`。不引入新依赖 | 工具参数和结果可校验；非法输入返回 `schema.path` |
| 1.4 ID | `api/agent-runtime/ids.js`（新） | `createId(prefix, randomUUID)`；`randomUUID` 由宿主注入，默认用 `globalThis.crypto.randomUUID`；生成 `run_`、`ses_`、`mem_`、`prop_`、`ev_` 前缀 | Node 和 RN 都能调用；不导入 `node:crypto` |
| 1.5 上下文 | `api/agent-runtime/context.js`（新） | `bindContext` 绑定 scope/runId/targetScope/deadline/signal；`addEvidence`/`resolveEvidence`；`trimContext` 按“指令 → 当前输入 → 必要事实 → 当前工具结果 → 可选历史/记忆”裁剪；预算超限返回 `context_budget_exceeded` | 裁剪顺序和证据映射有单测；A2 可复现 |
| 1.6 工具围栏 | `api/agent-runtime/tools.js`（新） | `createToolRegistry`、`createDispatcher`；依次检查步骤允许列表、`argsSchema`、调用预算、`targetScope`、归属回调；通过后调用只读 `run`，结果再按 `resultSchema` 校验。拒绝时计数不变 | 拒绝用例底层调用次数为 0；A3 可复现 |
| 1.7 提案围栏 | `api/agent-runtime/proposals.js`（新） | 生成不可变提案（`proposalId`、`kind`、`changes`、`targetScope`、`targetVersion`）；`confirm` 只接受已存提案 ID，调用适配器做版本检查和一次性消费；`reject` 标记拒绝；重复确认返回原结果，版本变化返回 `proposal_conflict` | A4 可复现；并发确认只写一次 |
| 1.8 状态机 | `api/agent-runtime/state.js`（新） | `accepted → running → completed｜failed｜cancelled｜interrupted`；终态只写一次；取消先提交状态再中止信号；晚到结果不能改终态或生成提案 | A7 的共享用例通过 |
| 1.9 记忆 | `api/agent-runtime/memory.js`（新） | `selectMemories` 按类别和预算取最近更新；`projectMemories` 去敏；`createMemoryProposal`/`applyMemoryProposal` 使用提案围栏和版本检查 | 跨 scope 不召回；删除后不进入下一次上下文 |
| 1.10 模型接口 | `api/agent-runtime/model-gateway.js`（新） | 定义 `ModelGateway.invoke(profileRef, modelInput, signal)`；规范化 `{ text, structured, toolCalls }`；`assertCapabilities` 校验文本/图像/工具；不直接发请求 | 能力缺失返回 `profile_capability_missing`；工具调用归一化有单测 |
| 1.11 提供商 | `api/agent-runtime/providers/http.js`、`endpoint.js`、`fixture.js`、`openai.js`、`index.js`（新） | `http.js` 用注入的 `fetchImpl`，超时/取消/响应上限（1 MiB）；`endpoint.js` 提供 `validateBaseUrl`/`phoneMayCall` 的共享实现（从现有规则移植，不 import `api/coach/core`）；`openai.js` 支持 OpenAI Chat Completions 和 OpenAI-compatible 的文本、图像、工具调用；`fixture.js` 返回 text/tool/proposal/error/late 固定序列；`index.js` 只注册 `fixture`、`openai`、`compatible` | `agent-providers.test.js` 通过；fixture 外部网络调用为 0；图像与工具请求构造有断言；共享目录不依赖 Coach 目录 |
| 1.12 编排 | `api/agent-runtime/run.js`（新） | `runAgent({ task, request, context, gateway, tools, proposals, store, signal })`：校验输入 → 读必要事实 → 组装模型输入 → 模型轮次 → 工具派发 → 输出/提案校验 → 终态。模型轮次受 `budgets.rounds` 限制；工具结果作为数据块进入下一轮 | A2/A3/A4/A7 共享用例通过；无宿主平台导入 |
| 1.13 导出 | `api/agent-runtime/index.js`（新） | 导出 `createIds`、`bindContext`、`createDispatcher`、`createProposalService`、`createRunState`、`selectMemories`、`createProvider`、`runAgent` 和类型声明入口 | `node -e "import('./api/agent-runtime/index.js')"` 成功 |
| 1.14 共享测试 | `api/test/agent-runtime.test.js`（新）、`agent-providers.test.js`（新）、`agent-portability.test.js`（新） | 覆盖范围越权、预算裁剪、必要事实缺失、工具四类拒绝、提案未确认/重复确认/版本冲突、取消与完成竞争、晚到结果、记忆 scope/删除、provider 文本/图像/工具、无 Node 内建导入 | `node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js` 全绿 |
| 1.15 API 构建 | `api/scripts/build-api.mjs` | 把 `agent-runtime` 加入 `copyDir` 列表；把 `agent-runtime/index.js`、`agent-runtime/contracts.d.ts` 加入 `required` | `npm.cmd run build` 成功；`dist/agent-runtime/index.js` 存在；`node -e "import('./dist/agent-runtime/index.js')"` 成功 |
| 1.16 Metro | `mobile-rn/metro.config.js` | 在 `watchFolders` 加入 `path.resolve(__dirname, '../api/agent-runtime')`；不新增 RN 依赖 | 共享目录解析路径存在；阶段 4 的 `expo export` 作为最终验证 |

```powershell
Set-Location api
node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js
npm.cmd run build
Test-Path .\dist\agent-runtime\index.js
node -e "import('./dist/agent-runtime/index.js').then(m => console.log(Object.keys(m)))"
```

## 阶段 2 服务端执行与存储

退出条件：A1 的两条服务端路径、A2、A5、A6、A7 在 API 集成测试中通过；OpenAPI 路由检查通过。

| 步骤 | 文件 | 动作 | 完成判据 |
|---|---|---|---|
| 2.1 路径 | `api/src/common/persistence/paths.ts` | 增加 `agentFile(uid)`，返回 `data/agent-<uid>.json`；沿用 `safeUid` | 单元测试得到预期路径 |
| 2.2 类型 | `api/src/agent/agent.types.ts`（新） | 定义 `AgentAccountData`（`schema`、`profiles`、`runs`、`sessions`、`memories`、`proposals`）、脱敏 `AgentProfilePublic`、存储态与响应态 | `npm.cmd run build` 通过 |
| 2.3 存储 | `api/src/agent/agent.store.ts`（新） | 注入 `Paths`、`AtomicWriter`；`read(uid)` 解析；`update(uid, fn)` 用每账号 Promise 链串行读改写，原子写入，权限 600；损坏文件返回 `agent_store_corrupt` | 并发两次更新后两条记录都在；文件权限正确 |
| 2.4 加密 | `api/src/agent/agent-crypto.ts`（新） | 注入 `RUNTIME_CONFIG`；用 `secret` 经 HKDF（info `opengym-agent-config-v1`）派生 32 字节密钥；AES-256-GCM；AAD 为 `uid + profileId + version`；密文含 `v`、`iv`、`tag`、`data`；`secret` 缺失返回 `agent_config_disabled` | 加密→重启→解密成功；改 AAD 或密钥解密失败 |
| 2.5 配置 | `api/src/agent/agent-config.store.ts`（新） | 默认配置读取 `api/coach/config.js` 的 `load()`/`credentialFor(uid)`（仅 `authMode: instance` 且 `fixture` 或管理员已配置的 HTTP provider 可用）；用户配置存 `agent-<uid>.json`，provider 仅 `fixture`/`openai`（`fixture` 只在非生产/验收实例可用），拒绝 `baseUrl`，密钥加密；`list` 只返回 ID/版本/provider/model/能力/尾 4 位；`resolve` 只给网关返回明文 | A1 三种配置可解析；跨账号看不到他人配置；服务端用户不能自定义端点 |
| 2.6 运行记录 | `api/src/agent/agent-run.store.ts`（新） | 创建前持久化 `requestId` 指纹和 `runId`；`findByRequest` 命中相同输入返回原作业，不同输入 `request_conflict`；`finish` 终态只写一次；`markInterrupted` 标记本环境非终态 | A6/A7 可复现 |
| 2.7 会话 | `api/src/agent/agent-session.store.ts`（新） | `list`/`get`/`ensure`/`append`/`delete`；会话有 `version` 和 `deletedAt`；晚到写入返回 `session_deleted`；删除时删除摘要 | A5 的“运行中删除会话”通过 |
| 2.8 记忆 | `api/src/agent/agent-memory.store.ts`（新） | `list`/`create`/`update`/`delete`/`applyProposal`；按 scope 和类别过滤；版本递增 | A5 的跨 scope 和删除通过 |
| 2.9 提案 | `api/src/agent/agent-proposal.store.ts`（新） | `save`/`get`/`confirm`/`reject`；确认在 `AgentStore.update` 内完成“读原提案 → 检查版本 → 应用 → 记录 consumed”；重复确认返回原结果 | A4 写入次数 0/1/0 |
| 2.10 网关 | `api/src/agent/agent-gateway.ts`（新） | 用共享 `createProvider`；`fetch`/`AbortController` 注入；解析配置后调用；把 provider 错误映射为稳定错误码；fixture 不联网 | A1 的配置撤销、能力缺失、超时/取消可复现 |
| 2.11 桩任务 | `api/src/agent/tasks/stub-task.ts`（新） | `stub.v1`：输入 `{ prompt, fixtureCase? }`；能力 `text,image,tools`；步骤 `read_facts`、`model`、`propose`；工具 `get_stub_fact`、`get_stub_target`；`targetScope` 返回桩目标集合；输出 schema 为 `{ text?, proposal? }` | A2/A3 可复现 |
| 2.12 桩工具 | `api/src/agent/tools/stub-tools.ts`（新） | 两个只读工具：返回桩事实/目标；记录调用计数；`target(args)` 返回目标 ID | A3 拒绝时计数为 0 |
| 2.13 桩写入 | `api/src/agent/agent-proposal.adapter.ts`（新） | 在同一 `AgentStore.update` 中检查 `targetVersion`、写入桩结果、记录 consumed；不触碰真实训练数据 | A4 写入次数和冲突可复现 |
| 2.14 服务 | `api/src/agent/agent.service.ts`（新） | `start` 返回 `202 { runId, status: 'accepted' }`；创建运行记录后异步执行；`get`/`cancel`；取消先写 `cancelled` 再 abort；晚到结果丢弃；启动时 `markInterrupted`；重复请求返回原作业；注入 `node:crypto` 的 `randomUUID` | A1/A6/A7 通过 |
| 2.15 控制器 | `api/src/agent/agent-runs.controller.ts`、`agent-configs.controller.ts`、`agent-sessions.controller.ts`、`agent-memories.controller.ts`、`agent-proposals.controller.ts`（新） | 全部 `@SessionRequired()`；`readBody`/`json`；精确路由：`POST /agent/runs`、`GET /agent/runs/:runId`、`POST /agent/runs/:runId/cancel`、`GET/POST /agent/configs`、`PATCH/DELETE /agent/configs/:profileId`、`GET /agent/sessions`、`GET/DELETE /agent/sessions/:sessionId`、`GET/POST /agent/memories`、`PATCH/DELETE /agent/memories/:memoryId`、`POST /agent/proposals/:proposalId/confirm`、`POST /agent/proposals/:proposalId/reject`；错误映射到 HTTP | `openapi-routes.test.js` 通过；跨账号 401/404 |
| 2.16 模块 | `api/src/agent/agent.module.ts`（新）、`api/src/app.module.ts` | `AgentModule` 导入 `PersistenceModule`、`AuthModule`；注册控制器/提供者；在 `AppModule.imports` 加入 | 应用启动；路由可枚举 |
| 2.17 开关 | `api/src/agent/agent.flags.ts`（新）、`api/src/system/system.controller.ts`、`.env.example` | `AGENT_RUNTIME_DISABLED` 为真时所有 Agent 路由返回 `503 agent_disabled`；`/api/config` 返回 `agent: { enabled }`；`.env.example` 加说明 | 关开关后路由 503；`/api/config` 反映状态 |
| 2.18 OpenAPI | `api/openapi.yaml`、`scripts/build-api-docs.mjs` | 增加 `agent` tag、15 条路径和 `AgentRun`/`AgentRunRequest`/`AgentProfile`/`AgentSession`/`AgentMemory`/`AgentProposal`/`AgentError` schema；在 `TAGS` 增加 `agent` | `openapi-routes.test.js` 两个用例通过；文档生成包含 Agent 段 |
| 2.19 媒体 | `api/src/agent/agent-media.ts`（新） | 复用 `api/media.js` 的读取入口；首期只接受 `fixture:image` 和当前账号可访问的已登记服务端媒体引用；校验 MIME、大小和实际格式；返回 data URL；不新增上传入口 | 1×1 PNG 可作为图像输入；超限或错误格式被拒绝 |
| 2.20 API 测试 | `api/test/nest/agent.test.js`（新） | 用临时 `DATA_DIR`、`fixtureSession` 和 `coach.json`（instance + fixture/openai）起 Nest；覆盖 A1 服务端默认/用户、A2 越权、A5 记忆/会话、A6 重试去重、A7 取消/重启；检查 `agent-<uid>.json` 和日志不含明文密钥/请求正文 | `npm.cmd run test:nest -- test/nest/agent.test.js` 通过 |

```powershell
Set-Location api
npm.cmd run build
npm.cmd run test:nest -- test/nest/agent.test.js
```

## 阶段 3 Web 客户端

退出条件：Web 能用服务端默认配置和用户配置启动桩任务，能取消、查看提案、确认/拒绝、查看和删除记忆；Web 构建通过。

| 步骤 | 文件 | 动作 | 完成判据 |
|---|---|---|---|
| 3.1 API 客户端 | `frontend/src/agent/api.js`（新） | 基于 `frontend/src/lib/api.js` 的 `api()`；封装 `listProfiles/createProfile/updateProfile/deleteProfile/startRun/getRun/cancelRun/listSessions/getSession/deleteSession/listMemories/saveMemory/deleteMemory/confirmProposal/rejectProposal`；把 `{status, code}` 映射为可展示错误 | 单测覆盖成功、401、409、503 |
| 3.2 状态 | `frontend/src/agent/store.js`（新） | Zustand store：`profiles`、`activeRun`、`sessions`、`memories`、`loading`、`error`；轮询只在 `Agent` 页面挂载时运行 | 页面卸载后停止轮询 |
| 3.3 主页面 | `frontend/src/views/Agent.jsx`（新） | 仅服务端：选择默认/用户配置，输入 prompt，启动/取消，展示运行状态、结果、提案确认/拒绝、会话和记忆列表；新任务生成 `requestId`（`crypto.randomUUID()`），重试沿用同一 ID；未登录跳转登录 | A1/A4/A5 的 Web 路径可操作 |
| 3.4 配置页 | `frontend/src/views/AgentSetup.jsx`（新） | 默认配置只读；用户配置新建/编辑/删除；provider 仅 `openai`/`fixture`；密钥只写不读回；显示能力和尾 4 位 | A1 用户配置路径可操作；删除后列表消失 |
| 3.5 路由 | `frontend/src/App.jsx` | 懒加载 `Agent`/`AgentSetup`；增加 `/agent`、`/agent/setup`；`noTabs` 包含 Agent 页面 | 直接访问两个路由可渲染 |
| 3.6 设置入口 | `frontend/src/views/settings-pages.js` | 增加 `PAGES.agent`（`AI Agent`，复用 `sparkles` 图标）和 `ROOT_GROUPS` 行；`pageVisible` 返回 `!!ctx.user && !ctx.mobile && !ctx.demo`，旧客户端不显示 | 设置根页有 Agent 行；Capacitor 构建不显示 |
| 3.7 设置跳转 | `frontend/src/views/Settings.jsx` | `page === 'agent'` 时跳 `/agent/setup`；搜索命中 `hit.page === 'agent'` 时跳 `/agent/setup` | 根页点击和搜索都能到达 |
| 3.8 测试 | `frontend/src/agent/api.test.js`（新）、`frontend/src/views/Agent.test.jsx`（新）、`AgentSetup.test.jsx`（新） | Mock `api()`；覆盖启动/取消/轮询停止、提案确认冲突、密钥不回显、删除配置、503 禁用 | `npm.cmd test -- src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx` 通过 |
| 3.9 文案 | `frontend/src/locales/*.js`（按需） | 新文案先以英文 key 写入；翻译包缺失时 `t()` 回退英文；阶段 5 补齐主要语言 | `npm.cmd test` 的现有 locale 测试不被破坏 |
| 3.10 构建 | 无 | `npm.cmd run build`；检查 bundle 不含 RN/Capacitor 专属导入 | 构建成功，Agent 页面 chunk 可按需加载 |

```powershell
Set-Location frontend
npm.cmd test -- src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx
npm.cmd run build
```

## 阶段 4 RN 客户端

退出条件：RN 本机执行和服务端执行都能跑桩任务；工作区隔离、SecureStore 配置、取消/重启中断、提案确认通过设备验收。

| 步骤 | 文件 | 动作 | 完成判据 |
|---|---|---|---|
| 4.1 作用域 | `mobile-rn/src/storage.ts` | 把 `scopeOf` 导出为 `workspaceScope(connection)`，内部调用保持不变；返回 `server + uid` 或 `practice` | 现有 `readLocal/saveLocal` 行为不变 |
| 4.2 类型 | `mobile-rn/src/agent/types.ts`（新） | 复用共享 `contracts.d.ts`；定义 RN 存储态和 `AgentConnection` | `npm.cmd run typecheck` 通过 |
| 4.3 存储 | `mobile-rn/src/agent/store.ts`（新） | 打开独立 `opengym-agent.db`；建表 `agent_profiles`、`agent_runs`、`agent_sessions`、`agent_messages`、`agent_memories`、`agent_proposals`，全部带 `scope` 主键；提案确认用事务 | 同一 scope 读写隔离；事务失败回滚 |
| 4.4 配置 | `mobile-rn/src/agent/config.ts`（新） | 元数据存 SQLite；密钥存 SecureStore，key 为 `agent_<sha256(scope)>_<profileId>`（`expo-crypto`）；写入失败恢复旧密钥或删除新密钥；删除配置时删密钥 | 配置删除后无孤立密钥；A1 本机配置可解析 |
| 4.5 网关 | `mobile-rn/src/agent/gateway.ts`（新） | 用共享 `createProvider`；注入 RN `fetch` 和 `AbortController`；本机自定义端点先过共享 `endpoint.js` 的 `phoneMayCall` 和 `validateBaseUrl`，不直接 import Coach 目录 | 局域网 HTTP 允许，公网 HTTP 拒绝；取消可中止 |
| 4.6 媒体 | `mobile-rn/src/agent/media.ts`（新） | 用 `expo-file-system` 读取已登记图片；校验 MIME/大小；转 base64 data URL；只把元数据写日志 | 1×1 图片作为图像输入；超限返回错误 |
| 4.7 本机任务 | `mobile-rn/src/agent/tasks.ts`（新） | 定义 `stubTask`：读取当前 `LocalState` 的桩事实，暴露 `get_workspace_fact`/`get_workspace_target`，输出文本或提案 | A2 本机未同步记录可读 |
| 4.8 本机工具 | `mobile-rn/src/agent/tools.ts`（新） | 只读工具从 `workspaceScope` 绑定的 `LocalState` 读取；`target(args)` 返回目标 ID；调用计数 | 越界 ID 拒绝，计数 0 |
| 4.9 运行时 | `mobile-rn/src/agent/runtime.ts`（新） | `createLocalRuntime({ connection, data })`：共享 `runAgent` + SQLite store + RN gateway + 桩任务/工具/提案适配器；注入 `expo-crypto` 的 `randomUUID`；运行开始时捕获 `workspaceScope`，切换工作区后仍用原 scope 读写 | 本机 run 可完成/取消/失败；切工作区不串数据 |
| 4.10 服务端客户端 | `mobile-rn/src/agent/server-client.ts`（新） | 用 `Connection` 的 `server`/`token` 调 `/api/agent/*`；`startRun/getRun/cancelRun` 和配置/会话/记忆 CRUD；2 秒轮询；Bearer 头 | A1 服务端路径可用；断线后按 run ID 查询 |
| 4.11 恢复 | `mobile-rn/src/agent/recovery.ts`（新） | 启动时把当前 scope 的 `accepted/running` 标为 `interrupted`；保留已完成结果 | A7 重启后遗留作业为中断 |
| 4.12 导出 | `mobile-rn/src/agent/index.ts`（新） | 导出 `createLocalRuntime`、`server-client`、`config`、`recovery`、`store` 的公共函数 | 其他模块只从 index 导入 |
| 4.13 主页面 | `mobile-rn/src/screens/AgentScreen.tsx`（新） | 本机/服务端切换；配置选择；prompt；启动/取消；状态、结果、提案确认/拒绝、会话和记忆列表；新任务用共享 `createId` 生成 `requestId`，重试沿用；复用 `Screen`、`Header`、`Card`、`ListRow`、`Button`、`Text` | A1/A4/A5 的 RN 路径可操作 |
| 4.14 配置页 | `mobile-rn/src/screens/AgentProfileScreen.tsx`（新） | 本机配置新建/编辑/删除，provider 可选 `fixture`/`openai`/`compatible`；服务端用户配置新建/编辑/删除，provider 仅 `fixture`/`openai`；密钥输入；显示 provider/model/能力和尾 4 位 | 配置保存失败不留孤立密钥 |
| 4.15 入口 | `mobile-rn/src/screens/SettingsScreen.tsx`、`mobile-rn/src/screens/index.ts`、`mobile-rn/App.tsx` | Settings 增加 `ListRow` “Agent” 和 `onOpenAgent` 回调；`screens/index.ts` 导出两个新屏；`App.tsx` 增加 `panel.kind` 的 `agent` 和 `agentProfile` 两种取值、深链 `agent`、启动时 `recoverAgentRuns`、渲染两个屏，并把 `connection`/`data` 传给 Agent 屏 | 从设置进入；深链 `opengym://agent` 可打开 |
| 4.16 检查 | 无 | `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run design:check`、`npm.cmd run check` | 全部通过；无新图标，`design:check` 不要求双端同步 |
| 4.17 Metro 打包 | 无 | `npx.cmd expo export --platform android --output-dir .expo-agent-export` | 输出 Android bundle；共享核心被解析；无 Node 内建模块报错 |
| 4.18 设备验收 | 无 | 按 [RN Android 工具与验收](../../.agents/skills/opengym-development/references/rn-android.md) 申请设备；安装 APK；执行 A1 本机、A2、A5、A7 | 设备记录含序列号、APK 哈希、实际结果和截图 |
| 4.19 APK | 无 | `npx.cmd expo prebuild --platform android --no-install`；`.\android\gradlew.bat :app:assembleRelease`；`apksigner verify`；`Get-FileHash -Algorithm SHA256` | 签名通过；哈希写入验收记录 |

```powershell
Set-Location mobile-rn
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run design:check
npm.cmd run check
npx.cmd expo export --platform android --output-dir .expo-agent-export
```

## 阶段 5 双端验收与交接

退出条件：A1–A7 全部有 Web/RN/API 对应证据；文档和目录地图更新；回退步骤可用。

| 步骤 | 文件 | 动作 | 完成判据 |
|---|---|---|---|
| 5.1 验收记录 | `docs/agent-runtime/ACCEPTANCE.md` | 按 A1–A7 记录命令、版本、前置数据、预期、实际、通过/失败/待验、证据路径 | 每条有证据；未跑项标明待验 |
| 5.2 文档入口 | `docs/README.md` | Agent runtime 行增加 `ACCEPTANCE.md` 链接 | 链接可打开 |
| 5.3 项目地图 | `AGENTS.md` | 增加 `api/agent-runtime/`、`api/src/agent/`、`frontend/src/agent/`、`mobile-rn/src/agent/`、`docs/agent-runtime/ACCEPTANCE.md` | 目录职责与代码一致 |
| 5.4 RN 状态 | `docs/RN_MIGRATION_STATUS.md` | 增加 Agent 运行环境条目，写明 Web/RN 已完成项和待验项 | 与验收记录一致 |
| 5.5 部署说明 | `docs/SELF_HOSTING.md`、`.env.example` | 说明 `AGENT_RUNTIME_DISABLED` 是回退开关；服务端用户配置复用 `data/secret`，备份必须包含它 | 备份/恢复说明与实现一致 |
| 5.6 文案 | `frontend/src/locales/*.js`（按需） | 补齐主要语言的 Agent 文案；未补语言继续回退英文；不新增未翻译的硬编码句子 | `npm.cmd test` 通过；抽查中英文页面 |
| 5.7 最终检查 | 无 | 依次跑完整命令矩阵；记录 API 镜像、Web 构建、RN APK 的哈希 | 全部通过或明确待验 |
| 5.8 回退演练 | 无 | 设 `AGENT_RUNTIME_DISABLED=1` 重启；确认 Agent 路由 503、Web/RN 入口提示禁用；恢复后数据仍可读 | 回退不删除 Agent 数据 |

## 验收对照

| 编号 | 需求 | 操作与可观察结果 | 证据位置 |
|---|---|---|---|
| A1 | R1 | Web 和 RN 分别用服务端默认、服务端用户配置启动桩任务；RN 另用本机配置。远程适配器只收到所选配置；撤销配置或缺少图像能力返回明确错误；不自动换环境 | `api/test/nest/agent.test.js`；`AgentSetup.test.jsx`；RN 设备记录 |
| A2 | R2 | 注入他人引用、超预算历史和未同步数据。越权引用被拒绝，可选内容被裁剪，必要事实保留，证据可回查版本；RN 本机能读未同步记录 | `agent-runtime.test.js`；`agent.test.js`；RN 设备记录 |
| A3 | R3、R4 | 返回未知工具、参数错误、真实但越界 ID、当前步骤禁用工具。所有拒绝用例底层执行次数为 0；有效请求在预算内执行 | `agent-runtime.test.js` |
| A4 | R4 | 提案未确认、并发确认、先改目标再确认。写入次数 0/1/0；冲突可识别；重复确认返回原结果 | `agent-runtime.test.js`；`agent.test.js`；Web 单测 |
| A5 | R5 | 保存偏好后切换账号/工作区、删除偏好、运行中删除会话。跨 scope 不召回；删除后不进入上下文；已删会话不被晚到结果重建 | `agent.test.js`；RN 设备记录；Web 单测 |
| A6 | R6 | 并发重试同一服务端请求并模拟响应丢失，按 ID 重连查询。同一请求一个作业、一次模型调用；复用 requestId 改输入返回冲突 | `agent.test.js` |
| A7 | R6 | 取消后模型才返回；运行中终止宿主并重启。晚到结果无提案；取消状态可查；遗留作业标为中断；已有结果可读 | `agent-runtime.test.js`；`agent.test.js`；RN 设备记录 |

## 命令矩阵

| 工作目录 | 命令 | 用途 |
|---|---|---|
| `api` | `npm.cmd ci` | 安装依赖 |
| `api` | `npm.cmd run build` | 编译 Nest，复制 `agent-runtime` |
| `api` | `node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js` | 共享核心测试 |
| `api` | `npm.cmd run test:nest -- test/nest/agent.test.js` | API 集成测试 |
| `api` | `docker build -t opengym-api-agent .\api` | 验证镜像包含共享核心 |
| `frontend` | `npm.cmd ci` | 安装依赖 |
| `frontend` | `npm.cmd test -- src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx` | Web 单测 |
| `frontend` | `npm.cmd run build` | Web 构建 |
| `mobile-rn` | `npm.cmd ci` | 安装依赖 |
| `mobile-rn` | `npm.cmd run check` | lint、规则、typecheck、design:check |
| `mobile-rn` | `npx.cmd expo export --platform android --output-dir .expo-agent-export` | Metro 解析和 JS bundle |
| `mobile-rn` | `npx.cmd expo prebuild --platform android --no-install`；`.\android\gradlew.bat :app:assembleRelease` | Android APK |
| 仓库根 | `Get-FileHash -Algorithm SHA256 <apk>` | 产物标识 |

## 启用与回退

- 首次只在本地和独立 API 数据目录启用；Web/RN 与 API 同批部署。
- 回退先设 `AGENT_RUNTIME_DISABLED=1` 并重启 API，确认 `/api/agent/*` 返回 `503 agent_disabled`；Web/RN 显示禁用状态。保留 `agent-<uid>.json`、`opengym-agent.db` 和 `data/secret`，恢复启用时验证存储可读、密钥可解密。
- 不删除旧 Coach 数据或训练数据；Agent 记录独立存放。
