# 子系统路由：`ai-agent`（Agent 运行时、多模态检索、AI Coach 与 MCP）

> 返回总路由：[AGENTS.md](../../../AGENTS.md) · [docs/README.md](../../README.md) · 工程规范：[code-standards.md](../../code-standards.md)

## 1. 职责与边界

负责跨端共享的 Agent 运行时核心（契约、工具与提案安全围栏、多提供商适配）、多模态智能动作检索（拍照/文本/追问消歧 + 双端候选评分 + 离线回放与真机视觉评测 CLI）、AI Coach 训练教练（生成/调整/复盘计划），以及供外部桌面 AI 客户端接入的本地 stdio MCP 服务。

## 2. 代码入口与目录映射

| 路径 | 职责说明 |
|---|---|
| `api/agent-runtime/` | 共享 Agent 核心：契约 schema、围栏校验、状态编排、模型提供商适配 |
| `api/agent-runtime/tasks/`、`exercise-search-diagnostics.js` | `exercise-search.v1` 共享任务定义、系统提示词、受控词表快照与隐私安全诊断事件 |
| `api/src/agent/`、`api/src/agent/langchain/` | NestJS 服务端 Agent 模块：LangChain / LangGraph 执行引擎（支持 `AGENT_SERVER_ENGINE=legacy` 回退）、按账号隔离配置、会话存储与异步作业调度 |
| `api/src/agent/retrieval/`、`api/src/agent/tasks/exercise-search-v2.ts` | 服务端动作检索 v2、PostgreSQL pgvector 索引与融合精排 |
| `services/retrieval-model/` | 本机 Embedding 与 Cross-Encoder HTTP 服务 |
| `scripts/build-retrieval-index.mjs`、`scripts/windows/` | 公开动作索引构建、版本切换与 Windows 检索依赖启停 |
| `frontend/src/agent/`、`components/ExerciseAiSearch.jsx` | Web 端 Agent 客户端、Zustand 会话态与动作库/选择器共用多模态识别 UI |
| `frontend/src/lib/exercise-ai-search.js` | 双端共用的 AI 候选召回、CJK 回退、器械过滤与重排匹配器（含 `*.golden.json` 黄金集） |
| `mobile-rn/src/agent/`、`ai-search-matcher.ts` | RN 本机/服务端双模式 Agent 执行、SQLite 会话与记忆、SecureStore 密钥存储及无 Expo 依赖纯匹配桥 |
| `frontend/scripts/ai-search-eval*.mjs` | 多模态动作检索评测 CLI（`replay` / `vision` / `e2e` 模式）及隐私脱敏回归测试 |
| `api/coach/`（含 `prompts/` 与 `core/`） | AI Coach 提示词模板与核心管线（`core/` 同时被手机端 `coach-local.js` 直接复用） |
| `mcp/` | 独立本地训练数据 MCP 服务（只读查询 `DATA_DIR`，唯一写操作经由 API `log_workout`） |

## 3. 核心契约与隐私红线

1. **双执行环境契约一致**：服务端模式（NestJS）与 RN 本机直连模式必须共用 `api/agent-runtime/` 的输入输出 schema 与安全围栏，修改任务契约时须同步验证 Web 与 RN 两端。
2. **评测与诊断零敏感泄露**：评测报告、stdout/stderr 与诊断事件严禁输出 API Key、图片 Base64 数据 URL、用户私有自定义动作 ID 或未脱敏异常堆栈（由 `ai-search-eval.test.mjs` 强断言守卫）。
3. **Coach 资产同步校验**：修改 `api/coach/prompts/` 或共享核心后，必须运行 `node scripts/build-coach-assets.mjs --check` 确认打包产物一致。

## 4. 常用验证命令（PowerShell）

```powershell
# 运行 AI 动作检索匹配器单测与评测 CLI 自动化测试（含隐私脱敏断言）
cd frontend; npx.cmd vitest run src/lib/exercise-ai-search.test.js
npm.cmd --prefix frontend run test:ai-search-eval

# 校验 Coach 提示词与资产同步、运行 MCP 服务测试
node scripts/build-coach-assets.mjs --check
cd mcp; npm.cmd test
```

## 5. 文档与需求笔记路由

### 产品与接入文档
- [AI Coach 配置、权限边界与使用说明](../../AI_COACH.md)
- [MCP 服务接入、工具清单与认证](../../../mcp/README.md)

### 待实施提案（`.agent/notes/proposed/`）
- [AI 动作检索评测系统重构与 `v1` vs `v2` 前后对比](../../../.agent/notes/proposed/ai-search-eval-v2/DESIGN.md) · [执行计划](../../../.agent/notes/proposed/ai-search-eval-v2/EXECUTION.md) · [对比实测报告](../../../.agent/notes/proposed/ai-search-eval-v2/COMPARISON_REPORT.md) · [交接文档](../../../.agent/notes/proposed/ai-search-eval-v2/HANDOFF.md)
- [AI 动作检索 `v2` 精排与领域护栏纠偏](../../../.agent/notes/proposed/ai-search-v2-tuning/DESIGN.md) · [执行计划](../../../.agent/notes/proposed/ai-search-v2-tuning/EXECUTION.md) · [Iter1 对比报告](../../../.agent/notes/proposed/ai-search-v2-tuning/ITER1_COMPARISON.md) · [结果与指标解读](../../../.agent/notes/proposed/ai-search-v2-tuning/RESULTS_SUMMARY.md) · [VLM Prompt 交接](../../../.agent/notes/proposed/ai-search-v2-tuning/VLM_PROMPT_HANDOFF.md) · [P50 提速交接](../../../.agent/notes/proposed/ai-search-v2-tuning/P50_LATENCY_HANDOFF.md) · [P50 提速设计](../../../.agent/notes/proposed/ai-search-v2-tuning/P50_LATENCY_DESIGN.md) · [P50 提速执行计划](../../../.agent/notes/proposed/ai-search-v2-tuning/P50_LATENCY_EXECUTION.md) · [P50 提速对比报告](../../../.agent/notes/proposed/ai-search-v2-tuning/P50_LATENCY_COMPARISON.md) · [Prompt 优化设计](../../../.agent/notes/proposed/ai-search-v2-tuning/VLM_PROMPT_DESIGN.md) · [Prompt 优化执行计划](../../../.agent/notes/proposed/ai-search-v2-tuning/VLM_PROMPT_EXECUTION.md) · [Prompt 优化前后对比报告](../../../.agent/notes/proposed/ai-search-v2-tuning/VLM_PROMPT_COMPARISON.md) · [全流程复盘与指标解读（含图表）](../../../.agent/notes/proposed/ai-search-v2-tuning/OPTIMIZATION_RETROSPECTIVE_AND_METRICS_GUIDE.md)

### 已实施需求与评测记录（`.agent/notes/implemented/`）
- **服务端 Agent Runtime 迁移至 LangChain / LangGraph（方案 B）**：[设计](../../../.agent/notes/implemented/server-agent-langchain/DESIGN.md) · [执行与验收](../../../.agent/notes/implemented/server-agent-langchain/EXECUTION.md)
- **Agent 运行时**：[需求](../../../.agent/notes/implemented/agent-runtime/REQUIREMENTS.md) · [设计](../../../.agent/notes/implemented/agent-runtime/DESIGN.md) · [执行](../../../.agent/notes/implemented/agent-runtime/EXECUTION.md) · [验收](../../../.agent/notes/implemented/agent-runtime/ACCEPTANCE.md)
- **多模态动作检索**：[需求](../../../.agent/notes/implemented/ai-exercise-search/REQUIREMENTS.md) · [设计](../../../.agent/notes/implemented/ai-exercise-search/DESIGN.md) · [验收](../../../.agent/notes/implemented/ai-exercise-search/ACCEPTANCE.md) · [评测 CLI Runbook](../../../.agent/notes/implemented/ai-exercise-search/eval/README.md) · [P2 结果](../../../.agent/notes/implemented/ai-exercise-search/eval/P2_RESULTS.md) · [P3 结果](../../../.agent/notes/implemented/ai-exercise-search/eval/P3_RESULTS.md) · [RN 智能检索交互设计](../../../.agent/notes/implemented/ai-exercise-search/RN_UI_AND_SEARCH_UX_DESIGN.md)
- **服务端智能动作检索改造（PostgreSQL pgvector + 本机/远程重排）**：[方案设计](../../../.agent/notes/implemented/server-retrieval/SERVER_RETRIEVAL_PLAN.md) · [执行计划与验收记录](../../../.agent/notes/implemented/server-retrieval/SERVER_RETRIEVAL_EXECUTION.md)
