# 服务端 Agent Runtime 迁移至 LangChain / LangGraph 执行计划

> **对应设计**：[`DESIGN.md`](DESIGN.md)
> **工程规范**：[`docs/code-standards.md`](../../../../docs/code-standards.md) · [`SKILL.md`](../../../skill/opengym-development/SKILL.md)
> **执行原则**：Windows 环境一律使用 PowerShell；严禁改动 [`api/agent-runtime/`](../../../../api/agent-runtime/)；严禁覆盖或回退工作区中与本任务无关的现有未提交修改。

---

## 0. 分阶段任务清单

### P0：依赖安装与编译基线确认
- [x] 在 `api/` 目录安装运行时依赖（纯 ESM + NodeNext 兼容版本）：
  ```powershell
  npm.cmd --prefix api install @langchain/core@^1.5.1 @langchain/openai@^1.8.5 @langchain/langgraph@^1.7.5 zod@^4.6.6
  ```
  > 注：`@langchain/core@1.5.1` 与 `@langchain/openai@1.8.5` 均依赖 `zod@^4.6.6`，`@langchain/langgraph@1.7.5` 支持 `zod@^3.25.32 || ^4.2.0`，且现有可选依赖 `@anthropic-ai/claude-agent-sdk@0.3.302` 要求 `zod@^4.0.0`；使用 `zod@^4.6.6` 可实现零 `peerDependency` 冲突及单一去重 `zod@4.6.6`（`npm.cmd --prefix api ls` 退出码 0）。
- [x] 检查 [`api/package.json`](../../../../api/package.json) 与 `api/package-lock.json` 更新无 peerDependency 冲突。
- [x] 验证 `@langchain/openai` `ChatOpenAI` 对 `configuration.fetch`、`modelKwargs`（透传 DeepSeek `thinking: { type: 'disabled' }` 与 `response_format`）、`bindTools` 的类型定义与实际发送行为。

### P1：底层基础模块（`errors.ts`、`http-fetch.ts`、`messages.ts`）
- [x] 新建 [`api/src/agent/langchain/errors.ts`](../../../../api/src/agent/langchain/errors.ts)：
  - 导出：`extractNestedAgentError(error)`、`mapLangChainError(error, signal)`、`sanitizeErrorText(text)`（及别名 `mapProviderError`、`sanitizeErrorMessage`）。
  - 验收：递归解包 `cause` 中的 `AgentError`；正确映射 `AbortError` -> `run_cancelled`、超时 -> `model_timeout`、HTTP 错误 -> `model_unavailable`、`GraphRecursionError` -> `invalid_request`；脱敏 `sk-...`、`Bearer ...` 与 `data:image/...`。
- [x] 新建 [`api/src/agent/langchain/http-fetch.ts`](../../../../api/src/agent/langchain/http-fetch.ts)：
  - 导出：`createBoundedFetch(options)`（默认 `maxBytes = 1024 * 1024`、`timeoutMs = 60_000`）。
  - 验收：超时与外部 `signal` 均覆盖完整 body 流读取；超过 `maxBytes` 立即取消流并抛出 `AgentError('model_response_too_large')`；重新构造干净的 `Response`（剔除 `content-encoding` / `content-length`）返回给 OpenAI SDK。
- [x] 新建 [`api/src/agent/langchain/messages.ts`](../../../../api/src/agent/langchain/messages.ts)：
  - 导出：`buildInitialMessages(modelInput)`、`extractModelOutput(aiMessage)`、`extractTokenUsage(aiMessage)`。
  - 验收：保留 `trimContext` 硬预算裁剪；支持文本与多模态 `image_url` + `[label]`；历史记录映射为标准 `HumanMessage` / `AIMessage`；输出经 `normalizeModelOutput()` 校验。

### P2：模型适配与诊断回调（`fixture-chat-model.ts`、`model-factory.ts`、`diagnostics-callback.ts`）
- [x] 新建 [`api/src/agent/langchain/fixture-chat-model.ts`](../../../../api/src/agent/langchain/fixture-chat-model.ts)：
  - 导出：`FixtureChatModel`（继承 `BaseChatModel`）。
  - 验收：复用 [`createFixtureProvider()`](../../../../api/agent-runtime/providers/fixture.js)；覆盖 `text`、`tool`、`proposal`、`error`、`late`、`candidates`、`fallback-only` 全部场景；`late` 场景下监听 `signal` 提前中断。
- [x] 新建 [`api/src/agent/langchain/model-factory.ts`](../../../../api/src/agent/langchain/model-factory.ts)：
  - 导出：`createLangChainChatModel({ resolved, tools, responseFormat, signal, timeoutMs, fixtureInput })`、`resolveServerOpenAIBaseUrl(resolved)`。
  - 验收：校验 `validateBaseUrl`；`maxRetries: 0`、`verbose: false`；注入 `createBoundedFetch`；DeepSeek 透传 `thinking: { type: 'disabled' }`；`responseFormat === 'json'` 透传 `response_format: { type: 'json_object' }`；仅在 `tools.length > 0` 时调用 `bindTools(..., { tool_choice: 'auto' })`。
- [x] 新建 [`api/src/agent/langchain/diagnostics-callback.ts`](../../../../api/src/agent/langchain/diagnostics-callback.ts)：
  - 导出：`createExerciseSearchDiagnosticCallbacks(...)`、`createExerciseSearchDiagnosticTracker(...)`。
  - 验收：严格对齐 `attachments -> model -> recognition -> retrieval/rerank -> end` 顺序；异常隔离（sink 抛错不影响主流程）；仅作用于 `exercise-search.*` 任务。

### P3：LangGraph 图编排引擎（`graph-runner.ts`、`index.ts`）
- [x] 新建 [`api/src/agent/langchain/graph-runner.ts`](../../../../api/src/agent/langchain/graph-runner.ts)：
  - 导出：`runServerAgentWithLangChain(options)`。
  - 验收：使用 `@langchain/langgraph` `StateGraph` + `Annotation.Root` 实现 `prepare` -> `model` <-> `tool` -> `finalize`。
  - 逐项对齐 [`run.js`](../../../../api/agent-runtime/run.js) 语义：
    1. 请求/作用域/能力/Facts/Attachments/Memory 前置校验与加载；
    2. 多轮以原生 `AIMessage(tool_calls)` -> `ToolMessage` 序列往返（不使用扁平化 user JSON）；
    3. `toolNode` 通过 [`createDispatcher()`](../../../../api/agent-runtime/tools.js) 执行四重围栏，拒绝时硬中断并原样抛出 `AgentError`，写入 `context.evidence`；
    4. 超出 `budgets.rounds` 或 `GraphRecursionError` 抛出 `AgentError('invalid_request', 'the model kept calling tools after the round budget')`；
    5. `finalizeNode` 依次执行 `parseOutput` -> `postProcess`（`exercise-search.v2`）-> `Proposal` 作用域/版本校验与创建；
    6. 所有节点及 Proposal 创建后复核 `signal.aborted` 与 `state.acceptResult()`，取消竞态下执行 `proposals.discard()`；
    7. 返回同构 `RunResult`（含 `evidence`、`proposal` 与 `usage: { rounds, toolCalls, ...tokens }`）。
- [x] 新建 [`api/src/agent/langchain/index.ts`](../../../../api/src/agent/langchain/index.ts) 汇总导出，所有内部相对导入统一使用 `.js` 后缀（适配 `NodeNext`）。

### P4：接入 NestJS 宿主层与构建脚手架
- [x] 修改 [`api/src/agent/agent.flags.ts`](../../../../api/src/agent/agent.flags.ts)：新增 `agentServerEngine()`（读取 `AGENT_SERVER_ENGINE`，仅 `'legacy'` 回退旧引擎，默认 `'langchain'`）。
- [x] 修改 [`api/src/agent/agent.types.ts`](../../../../api/src/agent/agent.types.ts)：在 `AgentRunResult['usage']` 补充可选 `inputTokens?`、`outputTokens?`、`totalTokens?`。
- [x] 修改 [`api/src/agent/agent-gateway.ts`](../../../../api/src/agent/agent-gateway.ts)：保留原 `forAccount().invoke()` 供 `legacy` 模式使用，新增 `forAccountLangChain(uid)` 执行按轮重新解密校验与 LangChain 模型调用。
- [x] 修改 [`api/src/agent/agent.service.ts`](../../../../api/src/agent/agent.service.ts)：`execute()` 按 `agentServerEngine()` 分流调用 `runServerAgentWithLangChain` 或 `runAgent`。
- [x] 修改 [`api/scripts/build-api.mjs`](../../../../api/scripts/build-api.mjs)：在 `required` 产物校验清单加入 `src/agent/langchain/index.js` 与 `src/agent/langchain/graph-runner.js`。

### P5：专项测试、全量回归与治理核对
- [x] 新建 [`api/test/nest/agent-langchain.test.js`](../../../../api/test/nest/agent-langchain.test.js)，启动真实编译后的 Nest 服务 + 本地 `node:http` Fake OpenAI Server，覆盖全部 7 组真实链路用例：
  1. **原生多轮 Tool Calling 消息序列验证**；
  2. **四重工具围栏硬中断 + 轮次预算与 `GraphRecursionError`**；
  3. **DeepSeek `thinking: { type: 'disabled' }` 与多模态 `response_format: { type: 'json_object' }` 参数透传**；
  4. **HTTP 边界与异常处理（>1MB 截断、headers 后卡死超时、取消竞态无 Proposal 残留、错误脱敏）**；
  5. **每轮 Profile 版本漂移拦截（`profile_not_found`）**；
  6. **引擎切换与回滚对拍（`langchain` vs `legacy`）**；
  7. **诊断事件顺序与隐私红线**。
- [x] 运行全套验证命令并记录实测输出。
- [x] 同步更新 [`docs/subsystem/ai-agent/README.md`](../../../../docs/subsystem/ai-agent/README.md) 并运行 `.\.agent\scripts\verify-governance.ps1`。
- [x] 回填本文件第 2 节「实测证据」与第 3 节「改后四步核对记录」。

---

## 1. 验收验证命令清单（PowerShell）

```powershell
# 1. 编译 TypeScript & 校验 dist 产物完整性
npm.cmd --prefix api run build

# 2. 跨端隔离与纯 JS 核心单测（强守卫 api/agent-runtime 不含 Node/LangChain 依赖）
node --test api/test/agent-portability.test.js api/test/agent-runtime.test.js api/test/agent-providers.test.js api/test/agent-exercise-search.test.js api/test/agent-store.test.js api/test/agent-crypto.test.js

# 3. NestJS 服务端集成测试（含新增 LangChain 专项测试与 OpenAPI 路由覆盖）
node api/scripts/test-nest.mjs test/nest/agent.test.js test/nest/agent-exercise-search.test.js test/nest/agent-langchain.test.js test/nest/routes.test.js

# 4. 动作检索评测与隐私脱敏回归
npm.cmd --prefix frontend run test:ai-search-eval

# 5. OpenAPI 契约一致性检查
node scripts/build-api-docs.mjs --check

# 6. 仓库治理门禁（README 行数 <= 300、断链、lessons 升格检查）
.\.agent\scripts\verify-governance.ps1
```

---

## 2. 实测证据回填区（实施后填写）

- `npm.cmd --prefix api run build`：exit 0，TypeScript (`strict: true`, `noEmitOnError: true`) 编译通过，输出 `build: dist ready`（已校验 `src/agent/langchain/index.js`、`src/agent/langchain/graph-runner.js` 等全部产物）。
- `api/test/agent-*.test.js`：`node --test api/test/agent-portability.test.js api/test/agent-runtime.test.js api/test/agent-providers.test.js api/test/agent-exercise-search.test.js api/test/agent-store.test.js api/test/agent-crypto.test.js` -> **72/72 通过**（0 失败，483.44ms），强守卫 `api/agent-runtime/` 零 Node / LangChain 依赖且未修改任何共享文件。
- `api/scripts/test-nest.mjs`（含 `agent-langchain.test.js`）：`node api/scripts/test-nest.mjs test/nest/agent.test.js test/nest/agent-exercise-search.test.js test/nest/agent-langchain.test.js test/nest/routes.test.js` -> **24/24 通过**（0 失败，12650.80ms；其中新增 `agent-langchain.test.js` 7/7 通过）。
- `npm.cmd --prefix frontend run test:ai-search-eval`：**10/10 通过**（0 失败，117623.94ms，含 `replay`、`vision`、`e2e`、`privacy` 与 `server_v2` 端到端测试）。
- `node scripts/build-api-docs.mjs --check`：exit 1（输出 `website\api.html is out of date. Run: node scripts/build-api-docs.mjs`），系仓库既有 Windows CRLF 检出（`website/api.html` 含 `\r\n`）导致，本任务未修改 `api/openapi.yaml` 或 `website/api.html`；另运行 `node --test api/test/openapi-routes.test.js` -> **4/4 通过**（929.47ms），验证 NestJS 路由与 `api/openapi.yaml` 完全一致。
- `.\.agent\scripts\verify-governance.ps1`：exit 0，全部治理门禁校验通过（9 个路由文件均 `<= 300` 行，217 条本地相对链接全部有效，`lessons.md` 无未升格规则）。

---

## 3. 改后四步核对记录（Post-Edit 4-Step Verification，实施后填写）

1. **① 受影响子系统与真实运行时路径**：
   - 已核实子系统：`ai-agent`（主要，新增 `api/src/agent/langchain/*` 并接入 `AgentGateway` / `AgentService` / `agent.flags.ts` / `agent.types.ts`）与 `api-sync`（`api/package.json`、`api/package-lock.json`、`api/scripts/build-api.mjs`）；`api/agent-runtime/` 与 `mobile-rn/src/agent/` 保持零改动隔离。
   - 运行时入口链路：`AgentRunsController` (`POST /api/agent/runs`) -> `AgentService.start()` -> `AgentService.execute()` -> `agentServerEngine()`（默认 `'langchain'`）-> `runServerAgentWithLangChain()` (`StateGraph`: `prepare` -> `model` <-> `tool` -> `finalize`) -> `AgentGateway.forAccountLangChain()` -> `createLangChainChatModel()`（`ChatOpenAI` + `createBoundedFetch` 或 `FixtureChatModel`）。
2. **② 调用链行外副作用追踪**：
   - 上游调用方（Callers）：`AgentService` 保持所有输入校验、幂等指纹、`session_busy` 互斥锁、`AI_MAX_RUNS_PER_SESSION` 限流、`RetrievalService` 后处理及 `AgentSessionStore.append()` 投影不变；原有 `AgentGateway.forAccount().invoke()` 完整保留供 `AGENT_SERVER_ENGINE=legacy` 与已有直接调用方使用。
   - 下游与共享状态副作用：`toolNode` 经 `createDispatcher()` 执行白名单 -> 参数校验 -> 次数预算 -> `targetScope` -> 结果校验四重围栏并自动注册 `addEvidence()`；`finalizeNode` 复核 `signal.aborted` 与 `state.acceptResult()`，取消竞态下调用 `proposals.discard()` 回滚；`AgentStore` / `AgentProposalStore` / `AgentSessionStore` / `AgentMemoryStore` 存储格式与原子写完全不变；所有报错与诊断日志均经脱敏处理，不泄露 API Key 或图片 Base64。
3. **③ 契约文档与源码链接反向同步**：
   - 子系统路由与设计文档：已更新 [`docs/subsystem/ai-agent/README.md`](../../../../docs/subsystem/ai-agent/README.md) 目录映射并回填 [`EXECUTION.md`](EXECUTION.md)。
   - 自动契约门禁：`api/test/openapi-routes.test.js` 4/4 通过，[`verify-governance.ps1`](../../../scripts/verify-governance.ps1) 全通过；`api/openapi.yaml` 无破坏性路由变更（`AgentRunResult.usage` 新增可选 token 统计字段向后兼容）。
4. **④ 测试真实覆盖度核验**：
   - 正常行为覆盖：覆盖真实 Nest 进程 + 本地 `node:http` Fake OpenAI Server 原生多轮 `assistant(tool_calls)` -> `tool(tool_call_id)` 往返、`usage` token 统计、DeepSeek `thinking: { type: 'disabled' }`、多模态 `image_url` + `[label]` + `response_format: { type: 'json_object' }`、`langchain` 与 `legacy` 双引擎全任务对拍及 `exercise-search.*` 诊断事件顺序。
   - 失败模式覆盖：覆盖四重工具围栏硬中断（`tool_not_allowed` / `tool_args_invalid` / `tool_target_out_of_scope` / `tool_budget_exceeded`）、轮次上限与 `GraphRecursionError`（`invalid_request`）、>1MB 响应截断（`model_response_too_large`）、headers 后响应体卡死超时（`model_timeout`）、运行中取消竞态（`run_cancelled` 且无 pending Proposal）、每轮 Profile 版本漂移拦截（`profile_not_found`）及 HTTP 401 敏感凭据/Base64 脱敏。
