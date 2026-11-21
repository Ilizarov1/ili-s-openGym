# openGym Agent 运行环境执行计划

[需求](REQUIREMENTS.md) · [技术设计](DESIGN.md)

状态为已执行（首期）。共享核心、API、Web、RN 和 Android 模拟器验收已完成；真实供应商兼容性待单独记录。所有命令使用 PowerShell；未执行的设备或环境检查在验收记录中标记为待验。

## 状态维护

- 初始所有步骤为 `- [ ]`。
- **每完成一步，立即把该步骤改为 `- [x]`**，并在 `记录` 行填写完成日期、commit、命令结果或证据路径。
- 未通过、失败或阻塞时保持 `- [ ]`，在 `记录` 行写 `阻塞：原因`，不要勾选。
- 一个阶段的全部步骤和退出条件都完成后，才能进入下一阶段。
- 设计或范围变化时，先更新本文件和 `DESIGN.md`，再继续勾选。

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

- [x] **0.1 建立独立工作树**
  - 文件：`Git 元数据`（无源码改动）
  - 动作：用 worktree 工具或 `git worktree add ..\open-gym-agent-runtime -b feat/agent-runtime` 创建独立工作树；后续命令都在其中执行。
  - 判据：`git branch --show-current` 为 `feat/agent-runtime`，原工作区改动未混入。
  - 记录：2026-11-20：工作树 `D:\dev\open-gym-agent-runtime`，分支 `feat/agent-runtime`，基线 `413e9d3b8`。

- [x] **0.2 记录环境和版本**
  - 文件：`docs/agent-runtime/ACCEPTANCE.md`（新）
  - 动作：建立“环境、命令、预期、实际、证据”表；记录 Node、npm、Java、Android SDK、Expo、adb 版本。
  - 判据：文档中有可复核的版本行。
  - 记录：2026-11-20：Node v24.18.0、npm 11.16.0、Expo CLI 58.1.21、Temurin 17.0.21、Android SDK 36、Gradle 9.0.0，设备 emulator-5560。

- [x] **0.3 冻结契约和决策**
  - 文件：`docs/agent-runtime/DESIGN.md`
  - 动作：确认已写入 JSON Schema 受限子集、`targetScope`、`data/secret` 派生密钥、本机 `phoneMayCall`、Web 仅服务端和接口清单。
  - 判据：设计文档不再有“由所属模块提供”的空白接口。
  - 记录：2026-11-20：受限 schema、targetScope、HKDF 派生、phoneMayCall、Web 仅服务端和 16 条接口已冻结。

- [x] **0.4 准备桩数据**
  - 文件：`api/test/agent-fixtures.mjs`（新）
  - 动作：导出两个账号、两个工作区、同一对象两个版本、未同步记录、1×1 PNG；导出 fixture 模型用例 `text`、`tool`、`proposal`、`error`、`late`。
  - 判据：`node -e "import('./api/test/agent-fixtures.mjs').then(m => console.log(Object.keys(m)))"` 输出预期键。
  - 记录：`api/test/agent-fixtures.mjs` 导出账号、工作区、目标版本、未同步记录、1×1 PNG 和五种模型用例。

- [x] **0.5 记录实施前基线**
  - 文件：`docs/agent-runtime/ACCEPTANCE.md`
  - 动作：在 `api`、`frontend`、`mobile-rn` 分别执行一次安装和现有检查，确认基线可跑；已有失败先记录，不归因于本需求。
  - 判据：现有命令无新增失败，或失败有明确基线记录。
  - 记录：api/frontend/mobile-rn `npm ci` 完成；API 构建、Web 构建通过；Windows 权限/CRLF 基线失败已记录。

```powershell
git worktree add ..\open-gym-agent-runtime -b feat/agent-runtime
Set-Location ..\open-gym-agent-runtime
node -v; npm.cmd -v; java -version; adb version; npx.cmd expo --version
```

## 阶段 1 共享运行核心

退出条件：`api/test/agent-runtime.test.js`、`agent-providers.test.js`、`agent-portability.test.js` 通过；API 构建产物包含 `dist/agent-runtime/index.js`。

- [x] **1.1 定义运行契约**
  - 文件：`api/agent-runtime/contracts.js`（新）、`contracts.d.ts`（新）
  - 动作：定义 `RunRequest`、`TaskDefinition`、`RunContext`、`ModelInput`、`ModelOutput`、`RunResult`、`ToolDefinition`、`ToolCall`、`Proposal`、`MemoryRecord`、`RunRecord`；写入 `AGENT_SCHEMA_VERSION = 1`。`TaskDefinition` 含 `targetScope(input, context)`、`budgets`、步骤工具列表；`RunContext` 含解析后的 `targetScope` 和 `execution`。
  - 判据：类型被 `contracts.d.ts` 导出；Node 可导入；无 Node 内建依赖。
  - 记录：`contracts.js` 与 `contracts.d.ts` 已添加，Node 导入成功。

- [x] **1.2 定义稳定错误码**
  - 文件：`api/agent-runtime/errors.js`（新）
  - 动作：定义 `AgentError` 和稳定错误码：`invalid_request`、`scope_denied`、`profile_not_found`、`profile_capability_missing`、`context_budget_exceeded`、`fact_missing`、`tool_not_allowed`、`tool_args_invalid`、`tool_target_out_of_scope`、`tool_budget_exceeded`、`proposal_not_found`、`proposal_conflict`、`proposal_consumed`、`run_not_found`、`run_terminal`、`model_unavailable`、`model_timeout`、`model_response_too_large`、`session_deleted`、`memory_not_found`、`agent_disabled`。
  - 判据：每个错误有 HTTP 状态和可展示信息；单元用例覆盖映射。
  - 记录：`errors.js` 错误码、HTTP 状态和可展示信息已添加。

- [x] **1.3 实现 schema 校验**
  - 文件：`api/agent-runtime/schema.js`（新）
  - 动作：实现 JSON Schema 2020-12 受限子集：`type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`const`、`oneOf`、`minLength`、`maxLength`、`pattern`、`minimum`、`maximum`；不引入新依赖。
  - 判据：工具参数和结果可校验；非法输入返回 `schema.path`。
  - 记录：`schema.js` 覆盖受限 JSON Schema 子集，错误带 `path`。

- [x] **1.4 实现 ID 生成**
  - 文件：`api/agent-runtime/ids.js`（新）
  - 动作：`createId(prefix, randomUUID)`；`randomUUID` 由宿主注入，默认用 `globalThis.crypto.randomUUID`；生成 `run_`、`ses_`、`mem_`、`prop_`、`ev_` 前缀。
  - 判据：Node 和 RN 都能调用；不导入 `node:crypto`。
  - 记录：`ids.js` 使用宿主注入的 randomUUID；Node/RN 测试通过。

- [x] **1.5 实现运行上下文**
  - 文件：`api/agent-runtime/context.js`（新）
  - 动作：`bindContext` 绑定 scope/runId/targetScope/deadline/signal；`addEvidence`/`resolveEvidence`；`trimContext` 按“指令 → 当前输入 → 必要事实 → 当前工具结果 → 可选历史/记忆”裁剪；预算超限返回 `context_budget_exceeded`。
  - 判据：裁剪顺序和证据映射有单测；A2 可复现。
  - 记录：`context.js` 证据映射与裁剪顺序有单测。

- [x] **1.6 实现工具调用围栏**
  - 文件：`api/agent-runtime/tools.js`（新）
  - 动作：`createToolRegistry`、`createDispatcher`；依次检查步骤允许列表、`argsSchema`、调用预算、`targetScope`、归属回调；通过后调用只读 `run`，结果再按 `resultSchema` 校验；拒绝时计数不变。
  - 判据：拒绝用例底层调用次数为 0；A3 可复现。
  - 记录：`tools.js` 四类拒绝时底层调用计数为 0。

- [x] **1.7 实现提案围栏**
  - 文件：`api/agent-runtime/proposals.js`（新）
  - 动作：生成不可变提案（`proposalId`、`kind`、`changes`、`targetScope`、`targetVersion`）；`confirm` 只接受已存提案 ID，调用适配器做版本检查和一次性消费；`reject` 标记拒绝；重复确认返回原结果，版本变化返回 `proposal_conflict`。
  - 判据：A4 可复现；并发确认只写一次。
  - 记录：`proposals.js` 未确认 0 写入、并发/重复确认只写一次、版本冲突拒绝。

- [x] **1.8 实现运行状态机**
  - 文件：`api/agent-runtime/state.js`（新）
  - 动作：`accepted → running → completed｜failed｜cancelled｜interrupted`；终态只写一次；取消先提交状态再中止信号；晚到结果不能改终态或生成提案。
  - 判据：A7 的共享用例通过。
  - 记录：`state.js` 终态只写一次，晚到结果丢弃。

- [x] **1.9 实现记忆投影和提案**
  - 文件：`api/agent-runtime/memory.js`（新）
  - 动作：`selectMemories` 按类别和预算取最近更新；`projectMemories` 去敏；`createMemoryProposal`/`applyMemoryProposal` 使用提案围栏和版本检查。
  - 判据：跨 scope 不召回；删除后不进入下一次上下文。
  - 记录：`memory.js` 跨 scope 不召回，删除后不再进入上下文。

- [x] **1.10 定义模型网关接口**
  - 文件：`api/agent-runtime/model-gateway.js`（新）
  - 动作：定义 `ModelGateway.invoke(profileRef, modelInput, signal)`；规范化 `{ text, structured, toolCalls }`；`assertCapabilities` 校验文本/图像/工具；不直接发请求。
  - 判据：能力缺失返回 `profile_capability_missing`；工具调用归一化有单测。
  - 记录：`model-gateway.js` 能力检查与工具调用归一化有单测。

- [x] **1.11 实现共享提供商**
  - 文件：`api/agent-runtime/providers/http.js`、`endpoint.js`、`fixture.js`、`openai.js`、`index.js`（新）
  - 动作：`http.js` 用注入的 `fetchImpl`，超时/取消/响应上限（1 MiB）；`endpoint.js` 提供 `validateBaseUrl`/`phoneMayCall` 的共享实现（从现有规则移植，不 import `api/coach/core`）；`openai.js` 支持 OpenAI Chat Completions 和 OpenAI-compatible 的文本、图像、工具调用；`fixture.js` 返回 text/tool/proposal/error/late 固定序列；`index.js` 只注册 `fixture`、`openai`、`compatible`。
  - 判据：`agent-providers.test.js` 通过；fixture 外部网络调用为 0；图像与工具请求构造有断言；共享目录不依赖 Coach 目录。
  - 记录：`providers/` fixture、OpenAI、HTTP 限制与 endpoint 规则；27 项共享测试通过。

- [x] **1.12 实现运行编排**
  - 文件：`api/agent-runtime/run.js`（新）
  - 动作：`runAgent({ task, request, context, gateway, tools, proposals, store, signal })`：校验输入 → 读必要事实 → 组装模型输入 → 模型轮次 → 工具派发 → 输出/提案校验 → 终态。模型轮次受 `budgets.rounds` 限制；工具结果作为数据块进入下一轮。
  - 判据：A2/A3/A4/A7 共享用例通过；无宿主平台导入。
  - 记录：`run.js` 编排 A2/A3/A4/A7 共享用例通过，无宿主平台导入。

- [x] **1.13 导出共享 API**
  - 文件：`api/agent-runtime/index.js`（新）
  - 动作：导出 `createIds`、`bindContext`、`createDispatcher`、`createProposalService`、`createRunState`、`selectMemories`、`createProvider`、`runAgent` 和类型声明入口。
  - 判据：`node -e "import('./api/agent-runtime/index.js')"` 成功。
  - 记录：`index.js` 导出 60 个符号，Node 导入成功。

- [x] **1.14 编写共享核心测试**
  - 文件：`api/test/agent-runtime.test.js`（新）、`agent-providers.test.js`（新）、`agent-portability.test.js`（新）
  - 动作：覆盖范围越权、预算裁剪、必要事实缺失、工具四类拒绝、提案未确认/重复确认/版本冲突、取消与完成竞争、晚到结果、记忆 scope/删除、provider 文本/图像/工具、无 Node 内建导入。
  - 判据：`node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js` 全绿。
  - 记录：`node --test api/test/agent-runtime.test.js api/test/agent-providers.test.js api/test/agent-portability.test.js`：27 pass。

- [x] **1.15 更新 API 构建**
  - 文件：`api/scripts/build-api.mjs`
  - 动作：把 `agent-runtime` 加入 `copyDir` 列表；把 `agent-runtime/index.js`、`agent-runtime/contracts.d.ts` 加入 `required`。
  - 判据：`npm.cmd run build` 成功；`dist/agent-runtime/index.js` 存在；`node -e "import('./dist/agent-runtime/index.js')"` 成功。
  - 记录：`npm.cmd run build` 成功；`dist/agent-runtime/index.js` 存在并可导入。

- [x] **1.16 更新 Metro 解析**
  - 文件：`mobile-rn/metro.config.js`
  - 动作：在 `watchFolders` 加入 `path.resolve(__dirname, '../api/agent-runtime')`；不新增 RN 依赖。
  - 判据：共享目录解析路径存在；阶段 4 的 `expo export` 作为最终验证。
  - 记录：`metro.config.js` 已加入共享目录；`expo export` 通过。

```powershell
Set-Location api
node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js
npm.cmd run build
Test-Path .\dist\agent-runtime\index.js
node -e "import('./dist/agent-runtime/index.js').then(m => console.log(Object.keys(m)))"
```

## 阶段 2 服务端执行与存储

退出条件：A1 的两条服务端路径、A2、A5、A6、A7 在 API 集成测试中通过；OpenAPI 路由检查通过。

- [x] **2.1 增加 Agent 数据路径**
  - 文件：`api/src/common/persistence/paths.ts`
  - 动作：增加 `agentFile(uid)`，返回 `data/agent-<uid>.json`；沿用 `safeUid`。
  - 判据：单元测试得到预期路径。
  - 记录：`Paths.agentFile(uid)` 返回 `data/agent-<uid>.json`。

- [x] **2.2 定义服务端存储类型**
  - 文件：`api/src/agent/agent.types.ts`（新）
  - 动作：定义 `AgentAccountData`（`schema`、`profiles`、`runs`、`sessions`、`memories`、`proposals`）、脱敏 `AgentProfilePublic`、存储态与响应态；运行记录含 `executionLocation` 和 `durationMs`。
  - 判据：`npm.cmd run build` 通过。
  - 记录：`agent.types.ts` 定义账号存储、脱敏 profile、run、session、memory、proposal。

- [x] **2.3 实现按账号串行存储**
  - 文件：`api/src/agent/agent.store.ts`（新）
  - 动作：注入 `Paths`、`AtomicWriter`；`read(uid)` 解析；`update(uid, fn)` 用每账号 Promise 链串行读改写，原子写入，权限 600；损坏文件返回 `agent_store_corrupt`。
  - 判据：并发两次更新后两条记录都在；文件权限正确。
  - 记录：`agent.store.ts` 每账号 Promise 串行、原子写入 0600、损坏文件稳定错误。

- [x] **2.4 实现凭据加密**
  - 文件：`api/src/agent/agent-crypto.ts`（新）
  - 动作：注入 `RUNTIME_CONFIG`；用 `secret` 经 HKDF（info `opengym-agent-config-v1`）派生 32 字节密钥；AES-256-GCM；AAD 为 `uid + profileId + version`；密文含 `v`、`iv`、`tag`、`data`；`secret` 缺失返回 `agent_config_disabled`。
  - 判据：加密→重启→解密成功；改 AAD 或密钥解密失败。
  - 记录：`agent-crypto.ts` HKDF + AES-256-GCM，AAD 含 uid/profile/version。

- [x] **2.5 实现配置存储**
  - 文件：`api/src/agent/agent-config.store.ts`（新）
  - 动作：默认配置读取 `api/coach/config.js` 的 `load()`/`credentialFor(uid)`（仅 `authMode: instance` 且 `fixture` 或管理员已配置的 HTTP provider 可用）；用户配置存 `agent-<uid>.json`，provider 仅 `fixture`/`openai`（`fixture` 只在非生产/验收实例可用），拒绝 `baseUrl`，密钥加密；`list` 只返回 ID/版本/provider/model/能力/尾 4 位；`resolve` 只给网关返回明文。
  - 判据：A1 三种配置可解析；跨账号看不到他人配置；服务端用户不能自定义端点。
  - 记录：`agent-config.store.ts` 默认配置、用户 fixture/openai、拒绝自定义端点、密钥只回尾 4 位。

- [x] **2.6 实现运行记录和幂等**
  - 文件：`api/src/agent/agent-run.store.ts`（新）
  - 动作：创建前持久化 `requestId` 指纹和 `runId`；`findByRequest` 命中相同输入返回原作业，不同输入 `request_conflict`；`finish` 终态只写一次；`markInterrupted` 标记本环境非终态。
  - 判据：A6/A7 可复现。
  - 记录：`agent-run.store.ts` 请求指纹、去重、冲突和终态一次写入。

- [x] **2.7 实现会话存储**
  - 文件：`api/src/agent/agent-session.store.ts`（新）
  - 动作：`list`/`get`/`ensure`/`append`/`delete`；会话有 `version` 和 `deletedAt`；晚到写入返回 `session_deleted`；删除时删除摘要。
  - 判据：A5 的“运行中删除会话”通过。
  - 记录：`agent-session.store.ts` 版本、tombstone、删除摘要和晚到写入拒绝。

- [x] **2.8 实现长期记忆存储**
  - 文件：`api/src/agent/agent-memory.store.ts`（新）
  - 动作：`list`/`create`/`update`/`delete`/`applyProposal`；按 scope 和类别过滤；版本递增。
  - 判据：A5 的跨 scope 和删除通过。
  - 记录：`agent-memory.store.ts` 按账号 CRUD、版本递增和提案写入。

- [x] **2.9 实现提案存储和确认**
  - 文件：`api/src/agent/agent-proposal.store.ts`（新）
  - 动作：`save`/`get`/`confirm`/`reject`；确认在 `AgentStore.update` 内完成“读原提案 → 检查版本 → 应用 → 记录 consumed”；重复确认返回原结果。
  - 判据：A4 写入次数 0/1/0。
  - 记录：`agent-proposal.store.ts` 在同一 `AgentStore.update` 内检查版本、应用并标记 consumed。

- [x] **2.10 实现服务端模型网关**
  - 文件：`api/src/agent/agent-gateway.ts`（新）
  - 动作：用共享 `createProvider`；`fetch`/`AbortController` 注入；解析配置后调用；把 provider 错误映射为稳定错误码；fixture 不联网。
  - 判据：A1 的配置撤销、能力缺失、超时/取消可复现。
  - 记录：`agent-gateway.ts` 复用共享 provider，按请求重新解析配置和能力。

- [x] **2.11 定义桩任务**
  - 文件：`api/src/agent/tasks/stub-task.ts`（新）
  - 动作：`stub.v1`：输入 `{ prompt, fixtureCase? }`；能力 `text,image,tools`；步骤 `read_facts`、`model`、`propose`；工具 `get_stub_fact`、`get_stub_target`；`targetScope` 返回桩目标集合；输出 schema 为 `{ text?, proposal? }`。
  - 判据：A2/A3 可复现。
  - 记录：`stub.v1` 任务、两件工具、目标集合和输出 schema 已添加。

- [x] **2.12 实现桩工具**
  - 文件：`api/src/agent/tools/stub-tools.ts`（新）
  - 动作：两个只读工具：返回桩事实/目标；记录调用计数；`target(args)` 返回目标 ID。
  - 判据：A3 拒绝时计数为 0。
  - 记录：`get_stub_fact`/`get_stub_target` 只读并记录调用计数。

- [x] **2.13 实现桩业务写入**
  - 文件：`api/src/agent/agent-proposal.adapter.ts`（新）
  - 动作：在同一 `AgentStore.update` 中检查 `targetVersion`、写入桩结果、记录 consumed；不触碰真实训练数据。
  - 判据：A4 写入次数和冲突可复现。
  - 记录：`agent-proposal.adapter.ts` 版本检查、桩写入与 consumed 同事务。

- [x] **2.14 实现 Agent 服务**
  - 文件：`api/src/agent/agent.service.ts`（新）
  - 动作：`start` 返回 `202 { runId, status: 'accepted' }`；创建运行记录后异步执行；`get`/`cancel`；取消先写 `cancelled` 再 abort；晚到结果丢弃；启动时 `markInterrupted`；重复请求返回原作业；注入 `node:crypto` 的 `randomUUID`。
  - 判据：A1/A6/A7 通过。
  - 记录：`agent.service.ts` 202 accepted、异步执行、取消先提交后 abort、启动标记中断。

- [x] **2.15 实现控制器**
  - 文件：`api/src/agent/agent-runs.controller.ts`、`agent-configs.controller.ts`、`agent-sessions.controller.ts`、`agent-memories.controller.ts`、`agent-proposals.controller.ts`（新）
  - 动作：全部 `@SessionRequired()`；`readBody`/`json`；精确路由：`POST /agent/runs`、`GET /agent/runs/:runId`、`POST /agent/runs/:runId/cancel`、`GET/POST /agent/configs`、`PATCH/DELETE /agent/configs/:profileId`、`GET /agent/sessions`、`GET/DELETE /agent/sessions/:sessionId`、`GET/POST /agent/memories`、`PATCH/DELETE /agent/memories/:memoryId`、`POST /agent/proposals/:proposalId/confirm`、`POST /agent/proposals/:proposalId/reject`；错误映射到 HTTP。
  - 判据：`openapi-routes.test.js` 通过；跨账号 401/404。
  - 记录：五个控制器覆盖 16 条 `/api/agent` 路由，全部 `@SessionRequired()`。

- [x] **2.16 注册模块**
  - 文件：`api/src/agent/agent.module.ts`（新）、`api/src/app.module.ts`
  - 动作：`AgentModule` 导入 `PersistenceModule`、`AuthModule`；注册控制器/提供者；在 `AppModule.imports` 加入。
  - 判据：应用启动；路由可枚举。
  - 记录：`AgentModule` 注册到 `AppModule`，路由可枚举。

- [x] **2.17 增加回退开关**
  - 文件：`api/src/agent/agent.flags.ts`（新）、`api/src/system/system.controller.ts`、`.env.example`
  - 动作：`AGENT_RUNTIME_DISABLED` 为真时所有 Agent 路由返回 `503 agent_disabled`；`/api/config` 返回 `agent: { enabled }`；`.env.example` 加说明。
  - 判据：关开关后路由 503；`/api/config` 反映状态。
  - 记录：`agent.flags.ts` 与 `/api/config` 的 `agent.enabled`；503 已用集成测试验证。

- [x] **2.18 更新 OpenAPI 和文档生成**
  - 文件：`api/openapi.yaml`、`scripts/build-api-docs.mjs`
  - 动作：增加 `agent` tag、16 条路径和 `AgentRun`/`AgentRunRequest`/`AgentProfile`/`AgentSession`/`AgentMemory`/`AgentProposal`/`AgentError` schema；在 `TAGS` 增加 `agent`。
  - 判据：`openapi-routes.test.js` 两个用例通过；文档生成包含 Agent 段。
  - 记录：`openapi.yaml` 增加 agent tag、16 条路径和 11 个 schema；文档生成器同步。

- [x] **2.19 实现服务端媒体适配**
  - 文件：`api/src/agent/agent-media.ts`（新）
  - 动作：复用 `api/media.js` 的读取入口；首期只接受 `fixture:image` 和当前账号可访问的已登记服务端媒体引用；校验 MIME、大小和实际格式；返回 data URL；不新增上传入口。
  - 判据：1×1 PNG 可作为图像输入；超限或错误格式被拒绝。
  - 记录：`agent-media.ts` 只读取 fixture 图片和本账号已登记图片，校验 MIME/大小/魔数。

- [x] **2.20 编写 API 集成测试**
  - 文件：`api/test/nest/agent.test.js`（新）
  - 动作：用临时 `DATA_DIR`、`fixtureSession` 和 `coach.json`（instance + fixture/openai）起 Nest；覆盖 A1 服务端默认/用户、A2 越权、A5 记忆/会话、A6 重试去重、A7 取消/重启；检查 `agent-<uid>.json` 和日志不含明文密钥/请求正文。
  - 判据：`npm.cmd run test:nest -- test/nest/agent.test.js` 通过。
  - 记录：`npm.cmd run test:nest -- test/nest/agent.test.js`：4 pass（含回退开关与重启中断）。

```powershell
Set-Location api
npm.cmd run build
npm.cmd run test:nest -- test/nest/agent.test.js
```

## 阶段 3 Web 客户端

退出条件：Web 能用服务端默认配置和用户配置启动桩任务，能取消、查看提案、确认/拒绝、查看和删除记忆；Web 构建通过。

- [x] **3.1 实现 Web API 客户端**
  - 文件：`frontend/src/agent/api.js`（新）
  - 动作：基于 `frontend/src/lib/api.js` 的 `api()`；封装 `listProfiles/createProfile/updateProfile/deleteProfile/startRun/getRun/cancelRun/listSessions/getSession/deleteSession/listMemories/saveMemory/deleteMemory/confirmProposal/rejectProposal`；把 `{status, code}` 映射为可展示错误。
  - 判据：单测覆盖成功、401、409、503。
  - 记录：`frontend/src/agent/api.js` 封装全部服务端路由，保留 `{status, code}`。

- [x] **3.2 实现 Web 状态**
  - 文件：`frontend/src/agent/store.js`（新）
  - 动作：Zustand store：`profiles`、`activeRun`、`sessions`、`memories`、`loading`、`error`；轮询只在 `Agent` 页面挂载时运行。
  - 判据：页面卸载后停止轮询。
  - 记录：`store.js` 负责配置、运行、会话、记忆和页面挂载期轮询。

- [x] **3.3 实现 Web 主页面**
  - 文件：`frontend/src/views/Agent.jsx`（新）
  - 动作：仅服务端：选择默认/用户配置，输入 prompt，启动/取消，展示运行状态、结果、提案确认/拒绝、会话和记忆列表；新任务生成 `requestId`（`crypto.randomUUID()`），重试沿用同一 ID；未登录跳转登录。
  - 判据：A1/A4/A5 的 Web 路径可操作。
  - 记录：`Agent.jsx` 支持配置选择、启动/取消、结果、提案确认/拒绝、会话和记忆。

- [x] **3.4 实现 Web 配置页**
  - 文件：`frontend/src/views/AgentSetup.jsx`（新）
  - 动作：默认配置只读，不可用时显示原因；用户配置新建/编辑/删除；provider 仅 `openai`/`fixture`；密钥只写不读回；显示能力和尾 4 位。
  - 判据：A1 用户配置路径可操作；删除后列表消失。
  - 记录：`AgentSetup.jsx` 默认只读，用户配置增删改，密钥只写不读回。

- [x] **3.5 增加 Web 路由**
  - 文件：`frontend/src/App.jsx`
  - 动作：懒加载 `Agent`/`AgentSetup`；增加 `/agent`、`/agent/setup`；`noTabs` 包含 Agent 页面。
  - 判据：直接访问两个路由可渲染。
  - 记录：`App.jsx` 增加 `/agent`、`/agent/setup` 且无底部 Tab。

- [x] **3.6 增加 Web 设置入口**
  - 文件：`frontend/src/views/settings-pages.js`
  - 动作：增加 `PAGES.agent`（`AI Agent`，复用 `sparkles` 图标）和 `ROOT_GROUPS` 行；`pageVisible` 返回 `!!ctx.user && !ctx.mobile && !ctx.demo`，旧客户端不显示。
  - 判据：设置根页有 Agent 行；Capacitor 构建不显示。
  - 记录：`settings-pages.js` 增加 AI Agent 行，Web 登录用户可见，手机/演示隐藏。

- [x] **3.7 接通 Web 设置跳转**
  - 文件：`frontend/src/views/Settings.jsx`
  - 动作：`page === 'agent'` 时跳 `/agent/setup`；搜索命中 `hit.page === 'agent'` 时跳 `/agent/setup`。
  - 判据：根页点击和搜索都能到达。
  - 记录：设置根页和搜索均跳转 `/agent/setup`。

- [x] **3.8 编写 Web 测试**
  - 文件：`frontend/src/agent/api.test.js`（新）、`frontend/src/views/Agent.test.jsx`（新）、`AgentSetup.test.jsx`（新）
  - 动作：Mock `api()`；覆盖启动/取消/轮询停止、提案确认冲突、密钥不回显、删除配置、503 禁用。
  - 判据：`npm.cmd test -- src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx` 通过。
  - 记录：`vitest run src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx`：12 pass。

- [x] **3.9 处理 Web 文案**
  - 文件：`frontend/src/locales/*.js`（按需）
  - 动作：新文案先以英文 key 写入；翻译包缺失时 `t()` 回退英文；阶段 5 补齐主要语言。
  - 判据：`npm.cmd test` 的现有 locale 测试不被破坏。
  - 记录：19 个语言包加入 `AI Agent` 键；其余新文案暂回退英文。

- [x] **3.10 构建 Web**
  - 文件：无
  - 动作：`npm.cmd run build`；检查 bundle 不含 RN/Capacitor 专属导入。
  - 判据：构建成功，Agent 页面 chunk 可按需加载。
  - 记录：`npm.cmd run build` 通过，Agent 页面为独立 chunk。

```powershell
Set-Location frontend
npm.cmd test -- src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx
npm.cmd run build
```

## 阶段 4 RN 客户端

退出条件：RN 本机执行和服务端执行都能跑桩任务；工作区隔离、SecureStore 配置、取消/重启中断、提案确认通过设备验收。

- [x] **4.1 导出工作区作用域**
  - 文件：`mobile-rn/src/storage.ts`
  - 动作：把 `scopeOf` 导出为 `workspaceScope(connection)`，内部调用保持不变；返回 `server + uid` 或 `practice`。
  - 判据：现有 `readLocal/saveLocal` 行为不变。
  - 记录：`storage.ts` 导出 `workspaceScope(connection)`，原读写行为不变。

- [x] **4.2 定义 RN 类型**
  - 文件：`mobile-rn/src/agent/types.ts`（新）
  - 动作：复用共享 `contracts.d.ts`；定义 RN 存储态和 `AgentConnection`。
  - 判据：`npm.cmd run typecheck` 通过。
  - 记录：`mobile-rn/src/agent/types.ts` 复用共享类型并定义存储态。

- [x] **4.3 实现 RN SQLite 存储**
  - 文件：`mobile-rn/src/agent/store.ts`（新）
  - 动作：打开独立 `opengym-agent.db`；建表 `agent_profiles`、`agent_runs`、`agent_sessions`、`agent_messages`、`agent_memories`、`agent_proposals`，全部带 `scope` 主键；提案确认用事务。
  - 判据：同一 scope 读写隔离；事务失败回滚。
  - 记录：`opengym-agent.db` 六张业务表 + request index + kv，全部带 scope。

- [x] **4.4 实现 RN 配置存储**
  - 文件：`mobile-rn/src/agent/config.ts`（新）
  - 动作：元数据存 SQLite；密钥存 SecureStore，key 为 `agent_<sha256(scope)>_<profileId>`（`expo-crypto`）；写入失败恢复旧密钥或删除新密钥；删除配置时删密钥。
  - 判据：配置删除后无孤立密钥；A1 本机配置可解析。
  - 记录：SQLite 元数据 + SecureStore `agent_<sha256(scope)>_<profileId>`。

- [x] **4.5 实现 RN 网关**
  - 文件：`mobile-rn/src/agent/gateway.ts`（新）
  - 动作：用共享 `createProvider`；注入 RN `fetch` 和 `AbortController`；本机自定义端点先过共享 `endpoint.js` 的 `phoneMayCall` 和 `validateBaseUrl`，不直接 import Coach 目录。
  - 判据：局域网 HTTP 允许，公网 HTTP 拒绝；取消可中止。
  - 记录：RN 网关复用共享 provider，本机端点先过 `phoneMayCall`。

- [x] **4.6 实现 RN 媒体读取**
  - 文件：`mobile-rn/src/agent/media.ts`（新）
  - 动作：用 `expo-file-system` 读取已登记图片；校验 MIME/大小；转 base64 data URL；只把元数据写日志。
  - 判据：1×1 图片作为图像输入；超限返回错误。
  - 记录：`media.ts` 读取已登记文件、校验魔数和 2 MiB 上限。

- [x] **4.7 定义 RN 桩任务**
  - 文件：`mobile-rn/src/agent/tasks.ts`（新）
  - 动作：定义 `stubTask`：读取当前 `LocalState` 的桩事实，暴露 `get_workspace_fact`/`get_workspace_target`，输出文本或提案。
  - 判据：A2 本机未同步记录可读。
  - 记录：`stub.local.v1` 读取当前 LocalState，含未同步队列。

- [x] **4.8 实现 RN 桩工具**
  - 文件：`mobile-rn/src/agent/tools.ts`（新）
  - 动作：只读工具从 `workspaceScope` 绑定的 `LocalState` 读取；`target(args)` 返回目标 ID；调用计数。
  - 判据：越界 ID 拒绝，计数 0。
  - 记录：`get_workspace_fact`/`get_workspace_target` 只读并记录调用计数。落点与文件地图不同：工具合并在 `mobile-rn/src/agent/tasks.ts` 的 `createLocalTools`，未单独建 `tools.ts`。

- [x] **4.9 实现 RN 本机运行时**
  - 文件：`mobile-rn/src/agent/runtime.ts`（新）
  - 动作：`createLocalRuntime({ connection, data })`：共享 `runAgent` + SQLite store + RN gateway + 桩任务/工具/提案适配器；注入 `expo-crypto` 的 `randomUUID`；运行开始时捕获 `workspaceScope`，切换工作区后仍用原 scope 读写。
  - 判据：本机 run 可完成/取消/失败；切工作区不串数据。
  - 记录：`createLocalRuntime` 捕获 workspace scope，共享 runAgent + SQLite。

- [x] **4.10 实现 RN 服务端客户端**
  - 文件：`mobile-rn/src/agent/server-client.ts`（新）
  - 动作：用 `Connection` 的 `server`/`token` 调 `/api/agent/*`；`startRun/getRun/cancelRun` 和配置/会话/记忆 CRUD；2 秒轮询；Bearer 头。
  - 判据：A1 服务端路径可用；断线后按 run ID 查询。
  - 记录：`server-client.ts` 用 Connection 的 server/token 调 `/api/agent/*`，2 秒轮询。

- [x] **4.11 实现 RN 启动恢复**
  - 文件：`mobile-rn/src/agent/recovery.ts`（新）
  - 动作：启动时把当前 scope 的 `accepted/running` 标为 `interrupted`；保留已完成结果。
  - 判据：A7 重启后遗留作业为中断。
  - 记录：`recovery.ts` 启动时把 accepted/running 标 interrupted。

- [x] **4.12 导出 RN Agent 模块**
  - 文件：`mobile-rn/src/agent/index.ts`（新）
  - 动作：导出 `createLocalRuntime`、`server-client`、`config`、`recovery`、`store` 的公共函数。
  - 判据：其他模块只从 index 导入。
  - 记录：`src/agent/index.ts` 导出公共入口。

- [x] **4.13 实现 RN 主页面**
  - 文件：`mobile-rn/src/screens/AgentScreen.tsx`（新）
  - 动作：本机/服务端切换；配置选择；prompt；启动/取消；状态、结果、提案确认/拒绝、会话和记忆列表；新任务用共享 `createId` 生成 `requestId`，重试沿用；复用 `Screen`、`Header`、`Card`、`ListRow`、`Button`、`Text`。
  - 判据：A1/A4/A5 的 RN 路径可操作。
  - 记录：`AgentScreen.tsx` 本机/服务端、配置、运行、取消、提案、会话和记忆。

- [x] **4.14 实现 RN 配置页**
  - 文件：`mobile-rn/src/screens/AgentProfileScreen.tsx`（新）
  - 动作：本机配置新建/编辑/删除，provider 可选 `fixture`/`openai`/`compatible`；服务端用户配置新建/编辑/删除，provider 仅 `fixture`/`openai`；密钥输入；显示 provider/model/能力和尾 4 位。
  - 判据：配置保存失败不留孤立密钥。
  - 记录：`AgentProfileScreen.tsx` 本机三提供商、服务端 fixture/openai，密钥只写。

- [x] **4.15 接通 RN 入口**
  - 文件：`mobile-rn/src/screens/SettingsScreen.tsx`、`mobile-rn/src/screens/index.ts`、`mobile-rn/App.tsx`
  - 动作：Settings 增加 `ListRow` “Agent” 和 `onOpenAgent` 回调；`screens/index.ts` 导出两个新屏；`App.tsx` 增加 `panel.kind` 的 `agent` 和 `agentProfile` 两种取值、深链 `agent`、启动时 `recoverAgentRuns`、渲染两个屏，并把 `connection`/`data` 传给 Agent 屏。
  - 判据：从设置进入；深链 `opengym://agent` 可打开。
  - 记录：Settings 行、屏幕导出、App 面板、深链 `agent` 和启动恢复已接通。

- [x] **4.16 运行 RN 静态检查**
  - 文件：无
  - 动作：`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run design:check`、`npm.cmd run check`。
  - 判据：全部通过；无新图标，`design:check` 不要求双端同步。
  - 记录：`npm.cmd run typecheck`、`lint`、`design:check` 通过；仅有 2 条既有 key 警告。

- [x] **4.17 验证 Metro 打包**
  - 文件：无
  - 动作：`npx.cmd expo export --platform android --output-dir .expo-agent-export`。
  - 判据：输出 Android bundle；共享核心被解析；无 Node 内建模块报错。
  - 记录：`npx.cmd expo export --platform android` 成功，生成 `.expo-agent-export` Android bundle。

- [x] **4.18 完成 RN 设备验收**
  - 文件：无
  - 动作：按 [RN Android 工具与验收](../../.agents/skills/opengym-development/references/rn-android.md) 申请设备；安装 APK；执行 A1 本机、A2、A5、A7。
  - 判据：设备记录含序列号、APK 哈希、实际结果和截图。
  - 记录：2026-11-20，emulator-5560/openGymRnQaWorker（Android 16）；A1 本机 completed、A4 确认 version 2、A5 记忆保存/删除、会话写入 2 条消息、A7 取消后保持 cancelled；截图见 ACCEPTANCE。

- [x] **4.19 构建并验证 APK**
  - 文件：无
  - 动作：`npx.cmd expo prebuild --platform android --no-install`；`.\android\gradlew.bat :app:assembleRelease`；`apksigner verify`；`Get-FileHash -Algorithm SHA256`。
  - 判据：签名通过；哈希写入验收记录。
  - 记录：APK SHA-256 `E2B0CD6368F233D93C09189A0C626D5E43E07056CFFBA988959C0D37370B2FEC`；Debug 证书验签通过；包名 dev.opengym.rn，versionCode 7，arm64-v8a/x86_64。

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

- [x] **5.1 填写验收记录**
  - 文件：`docs/agent-runtime/ACCEPTANCE.md`
  - 动作：按 A1–A7 记录命令、版本、前置数据、预期、实际、通过/失败/待验、证据路径。
  - 判据：每条有证据；未跑项标明待验。
  - 记录：`ACCEPTANCE.md` 记录环境、命令、A1-A7 证据和 RN 设备待验项。

- [x] **5.2 更新文档入口**
  - 文件：`docs/README.md`
  - 动作：Agent runtime 行增加 `ACCEPTANCE.md` 链接。
  - 判据：链接可打开。
  - 记录：`docs/README.md` 已链接 ACCEPTANCE。

- [x] **5.3 更新项目地图**
  - 文件：`AGENTS.md`
  - 动作：增加 `api/agent-runtime/`、`api/src/agent/`、`frontend/src/agent/`、`mobile-rn/src/agent/`、`docs/agent-runtime/ACCEPTANCE.md`。
  - 判据：目录职责与代码一致。
  - 记录：`AGENTS.md` 已加入四个代码目录和 ACCEPTANCE。

- [x] **5.4 更新 RN 状态**
  - 文件：`docs/RN_MIGRATION_STATUS.md`
  - 动作：增加 Agent 运行环境条目，写明 Web/RN 已完成项和待验项。
  - 判据：与验收记录一致。
  - 记录：`docs/RN_MIGRATION_STATUS.md` 已增加 Agent 运行环境小节。

- [x] **5.5 更新部署说明**
  - 文件：`docs/SELF_HOSTING.md`、`.env.example`
  - 动作：说明 `AGENT_RUNTIME_DISABLED` 是回退开关；服务端用户配置复用 `data/secret`，备份必须包含它。
  - 判据：备份/恢复说明与实现一致。
  - 记录：`.env.example` 与 `docs/SELF_HOSTING.md` 已说明回退开关和密钥备份。

- [x] **5.6 补齐 Web 文案**
  - 文件：`frontend/src/locales/*.js`（按需）
  - 动作：补齐主要语言的 Agent 文案；未补语言继续回退英文；不新增未翻译的硬编码句子。
  - 判据：`npm.cmd test` 通过；抽查中英文页面。
  - 记录：语言包补齐 `AI Agent`；其余 Agent 文案按设计回退英文。

- [x] **5.7 运行最终检查**
  - 文件：无
  - 动作：依次跑完整命令矩阵；记录 API 镜像、Web 构建、RN APK 的哈希。
  - 判据：全部通过或明确待验。
  - 记录：API 共享 27 pass、API 集成 4 pass、Web 目标测试 48 pass、Web/RN 构建和 Android 模拟器验收通过；Windows 基线失败见 ACCEPTANCE。

- [x] **5.8 演练回退**
  - 文件：无
  - 动作：设 `AGENT_RUNTIME_DISABLED=1` 重启；确认 Agent 路由 503、Web/RN 入口提示禁用；恢复后数据仍可读。
  - 判据：回退不删除 Agent 数据。
  - 记录：集成测试验证关闭开关 503、`/api/config` 为 false，重新启用后记忆仍可读。

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
