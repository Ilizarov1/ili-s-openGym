# openGym 服务端智能动作检索改造执行计划

实施依据为 [评审后的设计](SERVER_RETRIEVAL_PLAN.md)。本轮实施情况与检查证据见[主 Agent 验收记录](#7-主-agent-验收记录)。执行顺序为工作区隔离 → 本机依赖 → 公开索引 → API v2 → 双端接入 → 启停与切换。

本期交付仓库改造、Windows 原生依赖和启动配置。阶段检查用于确认构建产物、依赖就绪和契约接通。检索测评、设备验收和 Docker 镜像属于后续范围。

## 1. 隔离工作区与运行数据

- [x] 从 `main` 创建短路径 worktree `D:\wt\og-retrieval`，分支 `codex/server-retrieval`。编写时主仓 `HEAD` 为 `1564401f1`。创建前检查分支和路径占用，保留主仓现有改动。
- [x] 将评审后的设计和本执行文档复制到新 worktree。当前设计位于主工作区，尚未被 Git 跟踪，单独创建 worktree 取得的是提交中的文件。
- [x] 定义本机运行根 `D:\dev\.tools\opengym-retrieval`。PostgreSQL 安装和数据、Python 环境、模型缓存、日志、配置文件与 API 的独立 `DATA_DIR` 放在该目录下。预留 PG `55432`、模型 `8765`、API `13000`、Web `15173`。若端口被占用，统一调整配置和启动参数。

```powershell
$openGymRepo = 'D:\dev\open-gym'
$retrievalWorktree = 'D:\wt\og-retrieval'
$retrievalRuntime = 'D:\dev\.tools\opengym-retrieval'
$retrievalConfig = Join-Path $retrievalRuntime 'retrieval.env'
git -C $openGymRepo status --short
git -C $openGymRepo worktree list
Get-Command git, node, npm.cmd, uv
Get-NetTCPConnection -State Listen -LocalPort 55432,8765,13000,15173 -ErrorAction SilentlyContinue
git -C $openGymRepo worktree add -b codex/server-retrieval $retrievalWorktree main
if ($LASTEXITCODE -ne 0) { throw '创建检索 worktree 失败' }
$retrievalDocs = @(
    'docs\ai-exercise-search\SERVER_RETRIEVAL_PLAN.md',
    'docs\ai-exercise-search\SERVER_RETRIEVAL_EXECUTION.md'
)
foreach ($retrievalDoc in $retrievalDocs) {
    Copy-Item -LiteralPath (Join-Path $openGymRepo $retrievalDoc) -Destination (Join-Path $retrievalWorktree $retrievalDoc)
}
Set-Location -LiteralPath $retrievalWorktree
```

**阶段产出**为独立 worktree、两份文档和选定的运行目录与端口。

## 2. 准备 Windows 数据库和推理服务

### 2.1 PostgreSQL 与中文检索扩展

- [x] 从官方 Windows 分发获取 PostgreSQL 18 x64，安装到运行根下的用户可写目录。进入现有 Visual Studio Build Tools 的 x64 Developer PowerShell，设置当前会话的 `PGROOT`，用 pgvector `v0.8.7` 源码的 `nmake /F Makefile.win` 及 `nmake /F Makefile.win install` 构建并安装扩展。构建前按 `pg_config --includedir-server` 核对服务器头文件和 x64 工具链。若 PG 18 受头文件或工具链阻塞，选用兼容该 PG 主版本的可信预编译扩展，或改用 PostgreSQL 17 和独立数据目录。 [PostgreSQL Windows 分发](https://www.postgresql.org/download/windows/) · [pgvector Windows 构建说明](https://github.com/pgvector/pgvector#installation)
- [x] 用 `initdb` 初始化独立集群，使用 UTF8 和 ICU locale，或者能够正确识别中文字符的 UTF8 locale。用 `pg_ctl` 管理进程，监听 `127.0.0.1:55432`。创建检索数据库 `opengym_retrieval`，在该库启用 `vector` 与 `pg_trgm`。连接凭据由运行配置提供，初始化与索引命令只读取自己的检索库连接串。 [PostgreSQL initdb](https://www.postgresql.org/docs/18/app-initdb.html)
- [x] 建索引前，用 `psql` 连接 `opengym_retrieval` 执行以下 SQL。`server_encoding` 应为 `UTF8`，两个扩展均应返回版本，`show_trgm` 应返回非空中文三元组。中文检查失败时，修正检索库 locale 后再构建索引。 [PostgreSQL pg_trgm](https://www.postgresql.org/docs/18/pgtrgm.html)

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SHOW server_encoding;
SELECT extname, extversion FROM pg_extension WHERE extname IN ('vector', 'pg_trgm');
SELECT show_trgm('坐姿推胸');
```

### 2.2 本机推理与统一 HTTP 协议

- [x] 在 `services/retrieval-model/` 建立 FastAPI 推理服务，提交 `pyproject.toml` 与 `uv.lock`。使用 `uv` 建独立 Python 3.12 环境，将 `UV_PROJECT_ENVIRONMENT`、`UV_CACHE_DIR` 和 `HF_HOME` 指向 D 盘运行根。根据 AMD 官方 Windows 说明安装对应 PyTorch。启动时优先选择可用 GPU，GPU 初始化失败时用 CPU。本机模型文件固定到可复用的版本。 [AMD PyTorch Windows 安装](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installryz/windows/install-pytorch.html)
- [x] 本机以单进程监听 `127.0.0.1:8765`，按当前配置加载需要的 `BAAI/bge-m3` 与 `BAAI/bge-reranker-v2-m3`。在线精排和建库 embedding 共用一个推理信号量，建库每批最多 32 条。排队请求取消后退出队列，已经开始的推理在实际结束后释放计算槽位。

| 本机接口 | 实现要求 |
|---|---|
| `GET /health` | 返回各模型加载状态、已就绪模型名和实际计算设备。启用的本机模型加载完成后才算就绪。 |
| `POST /v1/embeddings` | OpenAI 兼容请求和响应。按输入顺序返回带 `index` 的 1024 维有限数值向量，支持单条和批量文本。 |
| `POST /v1/rerank` | 硅基流动兼容请求和响应。对 `query` 与 `documents` 逐对打分，推理侧启用 `truncation=True, max_length=512` 兜底截断，返回零起始 `index` 和有限 `relevance_score`。按请求中的 `top_n` 截取。 |

- [x] 在 `api/src/agent/retrieval/` 建立统一 HTTP 客户端，按配置选择本机或远程的端点、模型名和凭据。本机基址补上 `/v1/embeddings` 或 `/v1/rerank`，远程使用配置中的完整接口 URL。调用前验证配置，调用后验证响应条数、索引和向量维度。具备调维能力的远程接口启用显式 `1024` 配置并传 `dimensions: 1024`，固定维度接口校验返回实际维度。 [远程 Embedding 契约](https://docs.siliconflow.cn/docs/api/embeddings-post) · [远程精排契约](https://docs.siliconflow.cn/docs/api/rerank-post)

**阶段产出**为可连接的独立 PostgreSQL、非空中文 trigram、以及 `/health` 能报告就绪模型的本机推理服务。数据库和推理服务可以分别准备。

## 3. 建立可重建的公开动作索引

- [x] 在 `api/package.json` 增加 `pg`，在开发依赖中增加 `@types/pg`，运行 `npm.cmd --prefix api install` 更新 `api/package-lock.json`（干净环境或 CI 复现后续使用 `npm ci`）。把 PG 连接、配置解析、迁移和索引构建逻辑放在 `api/src/agent/retrieval/`，并同步把新增检索编译产物加入 `api/scripts/build-api.mjs` 的 `required` 校验清单。`scripts/build-retrieval-index.mjs` 作为 PowerShell 可调用的入口，在 API 构建后加载已编译模块，和在线查询共用配置与连接逻辑。
- [x] 以 `api/agent-runtime/tasks/exercise-search-catalogue.json` 的字符串 ID 为准，保留前导零。关联 `catalogue/exercises/<id>.json` 的英文说明与步骤、`catalogue/i18n/zh.json` 的中文步骤。跳过目录重定向，`0004` 等 `variantOf` 文件不进入索引。构建条目数从当次快照计算，当前基线为 5,632。用户自建动作与用户别名保持在账号数据侧。
- [x] 按设计分别生成 `embed_text` 和 `rerank_text`。先拼接双语名称、标准别名与属性，再补描述和可区分的起始动作要领，过滤通用尾句。`scripts/build-retrieval-index.mjs` 使用纯 JS 的确定性字符/词元预算保守截断 `rerank_text`（等效 ≤ 384 tokens），不跨进程调用本机 Python BGE tokenizer，确保纯远程模式无需下载本机权重即可建库；本机精排服务在推理时用 `max_length=512` 兜底。固定这套文档口径，精排模型切换后可直接使用现有文档和向量。`catalogue_hash` 由目录快照与文档模板版本生成，API 和构建脚本共用计算逻辑。重做仅说明或步骤发生变化的目录时使用 `--rebuild`。

| 表或索引 | 落地要求 |
|---|---|
| `retrieval_index_builds` | 保存 `build_id`、目录哈希、embedding 后端、脱敏规范化端点（仅协议+主机+路径，不含密钥）、模型、维度、状态、条数和时间。按目录哈希、后端、端点、模型和维度选出唯一的 `ready` 批次。 |
| `retrieval_exercise_docs` | 单表保存设计列出的动作与文档字段，主键 `(build_id, exercise_id)`，使用 `vector(1024)`。为每个批次单独建部分 HNSW 余弦距离索引（`WHERE build_id = ...`），不再动态创建 PG 声明式分区表。 |
| 名称与别名索引 | 用辅助表 `retrieval_exercise_terms` 按 `build_id` 隔离存储标准化名称或别名（不建跨表外键，便于按保留策略清理过旧 `retired` 批次）。建精确匹配索引、`pg_trgm` GIN 索引和英文 `tsvector` 索引，供短中文子串及英文词元补充召回。 |

- [x] `--ensure` 优先检查当前配置的 `ready` 批次。缺少时创建 `building` 批次，先用一条文本校验真实向量维度，再按批写入动作、词条和向量。`--rebuild` 为当前配置新建批次。对同一配置的构建加数据库锁，避免并发激活多个批次。
- [x] 核对 canonical ID 集合、文档数、向量数与索引后，在一个事务里标记旧批次 `retired` 并激活新批次。失败的 `building` 对在线请求不可见，重跑时可另建批次。一次请求固定一个 `build_id`，并允许已经开始的请求读完该批次。保留近期旧批次以便回切，按保留数清理过旧 `retired` 批次及其部分索引。

```powershell
npm.cmd --prefix api install
if ($LASTEXITCODE -ne 0) { throw 'API 依赖安装与锁文件更新失败' }
npm.cmd --prefix api run build
if ($LASTEXITCODE -ne 0) { throw 'API 构建失败' }
node "--env-file=$retrievalConfig" scripts/build-retrieval-index.mjs --ensure
```

**阶段产出**为与当前后端、模型、维度和目录相符的 `ready` 批次。构建摘要只输出目录哈希、批次、模型标识、维度、条数和状态。

## 4. 接通 NestJS 检索与 Agent v2

### 4.1 检索顺序、故障与取消

- [x] 在检索模块用 NestJS DI 注入索引读取、embedding 与精排接口。文本子查询分别使用 `hintText` 和候选 `name`、`nameEn`，按 `exercise_id` 取最高分，取前 **75**。向量查询按固定顺序拼接 `hintText`、`fallback.understanding` 与首候选英文名，只编码一次，按余弦距离取前 **75**。短中文词走词条子串和 `word_similarity`，英文词元从独立的 `tsvector` 路径补充。管线固定同一批次，器械过滤条件与查询词均使用 SQL 参数。 [pgvector 过滤与迭代扫描](https://github.com/pgvector/pgvector#filtering)
- [x] `confirmedEquipment` 是两路共用的唯一属性硬条件。识别的器械、部位，以及从识别文本和名称中提取的明确姿势进入精排 query。精排同分时可按匹配线索数，再按 RRF 名次和字符串 ID 稳定排序。缺失属性保持候选可参与排序。
- [x] 按一基名次做 RRF，`k=60`，合并同 ID 后取 **30** 项。精排输入按该名单固定顺序发送，校验返回的下标、得分和对应库内 ID，去掉重复及非法条目，按精排顺序输出最多 **10** 个 ID。识别阶段无动作候选或合法召回候选为空时，返回空 `rankedIds` 与识别理解、消歧信息。精排接口返回无效响应时使用检索错误分支。
- [x] 下游 HTTP 使用 Run 的取消信号和对应请求超时。PG 每次检索在短只读事务内执行：`BEGIN READ ONLY` → `SET LOCAL statement_timeout` →（仅传入 `confirmedEquipment` 时）`SET LOCAL hnsw.iterative_scan = 'relaxed_order'` → 查询 → `COMMIT`，避免会话级参数污染连接池。取消或超时时以 `client.release(err)` 销毁连接，连接取得晚于取消时立即释放，成功路径归还干净连接。取消优先保持 `cancelled`，检索超时归 `retrieval_timeout`。 [node-postgres 连接池](https://node-postgres.com/apis/pool#releasing-clients) · [客户端超时选项](https://node-postgres.com/apis/client)

### 4.2 Task、返回值和运行状态

- [x] 在 `api/src/agent/tasks/index.ts` 注册 `exercise-search.v2`。复用 v1 的识别 prompt、清洗器、附件和模型预算，一轮识别、零工具调用。v2 输入加白名单字段 `confirmedEquipment`，按现有 34 项 slug 校验，非法值走 `400 invalid_request`。v1 输入范围保持由原契约校验。
- [x] 在 `api/agent-runtime/run.js` 增加由宿主传入的可选异步后处理钩子，并同步共享类型，实行两阶段 schema 校验：一轮模型输出先按识别 schema（`EXERCISE_SEARCH_OUTPUT_SCHEMA`）清洗校验，再由 `AgentService.execute()` 传入异步检索 `postProcess`；最终结果经 `EXERCISE_SEARCH_V2_OUTPUT_SCHEMA` 校验且再次确认 Run 未取消/终态后才写 `completed`，中间保持 `running`。共享运行时继续接收纯数据与回调，PG、HTTP 实现只从 NestJS 模块装配。
- [x] 让 `result.structured` 返回 `rankedIds`、可选 `items`、`fallback` 和可选 `clarifications`。若提供 `items`，其 ID 和顺序与 `rankedIds` 一致。对可映射到 0–1 的精排分数，`level` 的首版展示档位为 ≥0.8 高、≥0.5 且 <0.8 中、<0.5 低。展示档位独立于结果筛选。依据取可核实的器械、部位或姿势匹配，缺失时由客户端展示动作既有属性。后处理通过独立旁路上下文（如 `{ structured, historyMeta }`，不污染保持 `additionalProperties: false` 的 `structured`）向 `assistantMessage` 传递已返回动作的中英文名称，完成 Run 时与 `fallback.understanding` 一并写入 assistant 历史，供下一轮识别承接。
- [x] 在 `AgentService` 和共享 runtime 以 `exercise-search.*` 识别检索类任务，覆盖六轮限制和诊断开关。沿用会话与 Run 存储、退出取消以及定期清理机制。`agentPublicConfig()` 增加 `exerciseSearchVersion`，同步 `api/openapi.yaml` 的公开版本和任务契约。显式 `v1` 或 `v2` 优先。未指定时，配置了 PG 连接并具备所选模型后端参数才声明 `v2`。已下发版本在本会话中锁定。
- [x] 在 `errors.js` 和诊断投影中增加 `retrieval_unavailable`（503）、`retrieval_index_not_ready`（503）、`retrieval_timeout`（504）。异步错误按现有轮询契约出现在 `failed` Run 的 `error.code`。新增 `retrieval_text`、`retrieval_vector`、`retrieval_fusion`、`rerank` 及结束阶段 `retrieval`、`rerank`，沿用 `traceId`，从白名单投影后端、耗时、候选数、ID、分数、已确认器械标记及错误码。凭据与用户原文留在各自的处理边界。
- [x] 在现有 fixture 开关下，为 `provider: 'fixture'` 注入内存检索器和精排器，返回固定公开 ID。让受控 fixture 环境复用 v2 契约和轮询链路，实际部署由真实检索依赖负责。

**阶段产出**为可构建的 API v2、规范化服务端排序结果、状态机和 fixture 后处理入口。使用 `npm.cmd --prefix api run build` 与 `npm.cmd --prefix api run test:nest`（及新增检索单测）确认编译产物与核心契约测试通过。

## 5. 接入 Web 和 RN

- [x] **Web** 在 `frontend/src/components/ExerciseAiSearch.jsx` 进入 AI 检索预检/发起新会话时主动请求一次 `GET /api/config` 刷新配置并锁定本次 `taskId`（而非仅读初始化缓存），保证服务端切换版本后新会话立即生效；字段缺失时选 `v1`。v2 按 `rankedIds` 从公开动作目录取展示对象，列表上限放宽到 10。让动作库和训练选择器共用原面板，按原动作选择回调提交已找到的动作。
- [x] **RN** 扩展 `mobile-rn/src/agent/server-client.ts` 的 `status()` 与 `ai-search.ts` 的会话启动、追问和最近 Run 引用，并同步核对 `mobile-rn/src/agent/recovery.ts` 中对 `EXERCISE_SEARCH_TASK_ID` 的硬编码清理与最近 Run 恢复逻辑。选择服务端模式时锁定 v2 或 v1，本机配置按现有优先级走本机 v1。`ExerciseLibraryScreen.tsx` 的 v2 路径按服务端 ID 顺序装载公开动作并保留「新建自定义动作」卡片，v1 路径继续使用现有 `matchAiSearch`。
- [x] 两端按 ID 对齐可选 `items` 展示元数据，未知 ID 跳过，合法 ID 按服务端顺序显示。缺少依据时显示动作的「部位 · 器械」。保留空结果的识别理解和消歧 Chip。分别补齐 Web `ERROR_TEXT` 和 RN `aiErrorMessage` 的三个检索错误提示。
- [x] 在 v2 输入区用现有单选控件提供「限定器械」。默认不限，选择后只发一个 slug，追问继承当前值并允许清除。Web 复用现有下拉或弹层，RN 使用现有 `Chip`、`Sheet` 和器械本地化词表。控制状态跟随 AI 会话，独立于普通动作库筛选。 [RN 设计系统](../RN_UI_DESIGN_SYSTEM.md)

```powershell
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run build
npm.cmd --prefix mobile-rn ci
npm.cmd --prefix mobile-rn run check
git diff --check
```

**阶段产出**为双端共享入口的 v2 消费、器械选择和故障提示，以及旧服务端或 RN 本机模式的 v1 入口。

## 6. 启动、切换与回退

在 `scripts/windows/` 增加 `Initialize-Retrieval.ps1`、`Start-Retrieval.ps1`、`Stop-Retrieval.ps1`。三者接收同一个 `-RuntimeRoot`，使用其下的 `retrieval.env`。初始化准备第 2 阶段的依赖与空缺配置。v2 启动按 PG → 本机所需模型 → 当前索引 `--ensure` → NestJS 执行。v1 直接启动 NestJS。记录各进程 PID 与启动日志，后台进程用 `Start-Process -WindowStyle Hidden`。停止脚本按相反顺序处理该运行根创建的进程，数据库用 `pg_ctl` 正常停止。更新 `AGENTS.md` 中实现引入的模块入口。

| 配置 | 初始值与切换方式 |
|---|---|
| `EXERCISE_SEARCH_VERSION` | 本机配置启用 `v2`。切回 `v1` 并重启可恢复原链路。 |
| `EXERCISE_SEARCH_PG_URL` | 指向本机 `127.0.0.1:55432` 的 `opengym_retrieval`。 |
| `EXERCISE_SEARCH_EMBEDDING_BACKEND` / `EXERCISE_SEARCH_RERANK_BACKEND` | 各自默认 `local`，可独立切到 `remote`。 |
| `EXERCISE_SEARCH_LOCAL_MODEL_URL` | `http://127.0.0.1:8765`。 |
| `EXERCISE_SEARCH_REMOTE_EMBEDDING_URL` / `EXERCISE_SEARCH_REMOTE_EMBEDDING_MODEL` / `EXERCISE_SEARCH_REMOTE_EMBEDDING_API_KEY` / `EXERCISE_SEARCH_REMOTE_EMBEDDING_DIM` | 仅远程 embedding 分支使用。实际输出固定为 1024 维。可调维接口设置 `EXERCISE_SEARCH_REMOTE_EMBEDDING_DIM=1024`。固定维接口保留该项为空，由返回值验证向量维度。 |
| `EXERCISE_SEARCH_REMOTE_RERANK_URL` / `EXERCISE_SEARCH_REMOTE_RERANK_MODEL` / `EXERCISE_SEARCH_REMOTE_RERANK_API_KEY` | 仅远程精排分支使用。 |
| `EXERCISE_SEARCH_EMBEDDING_TIMEOUT_MS` / `EXERCISE_SEARCH_PG_TIMEOUT_MS` / `EXERCISE_SEARCH_RERANK_TIMEOUT_MS` | 默认依次为 `5000`、`3000`、`15000`。 |

API 运行配置使用独立 `DATA_DIR`、`PORT=13000` 和 `ORIGIN=http://localhost:15173`。通过运行根 `retrieval.env` 的 `DEEPSEEK_API_KEY` 配置实例识别，`DEEPSEEK_MODEL` 默认为 `deepseek-flash`。独立实例首次联调需登录，已登录的 `GET /api/config` 才返回 `agent` 字段。密钥保存在 Git 跟踪范围外的运行环境文件。

```powershell
& .\scripts\windows\Initialize-Retrieval.ps1 -RuntimeRoot $retrievalRuntime
& .\scripts\windows\Start-Retrieval.ps1 -RuntimeRoot $retrievalRuntime
$env:API_TARGET = 'http://127.0.0.1:13000'
$env:API_ORIGIN = 'http://localhost:15173'
npm.cmd --prefix frontend run dev -- --host localhost --port 15173 --strictPort
```

- [x] **切精排**时更新该分支的后端和模型配置，重启服务并开新会话。向量索引沿用当前 `ready` 批次。
- [x] **切 embedding** 时先按目标配置执行 `--ensure`，确保对应批次（含目录哈希、后端、脱敏端点、模型与维度）已就绪，再启用新配置并重启；更换同名远程端点同样先用新配置 `--ensure` 在线构建，实现零停机切换。`--rebuild` 仅用于同配置重刷索引。
- [x] **回退**时把 `EXERCISE_SEARCH_VERSION` 改为 `v1`，重启 API 并重新发起新会话。也可使用 `Stop-Retrieval.ps1` 停止独立实例。原生依赖、版本化索引和 JSON 账户数据各自保存在其运行目录。

**交付产物**为独立 worktree 中的 API、双端与推理服务代码，索引构建入口，Windows 初始化和启停脚本，以及本机已配置的检索实例。记录用到的 PostgreSQL 主版本、计算设备、启用的 embedding 和精排后端、`ready` 批次及工作区路径。

## 7. 主 Agent 验收记录

执行日期为 2026-11-24。三个 GPT-6 Luna 子 Agent 分别实现检索后端、双端接入和 Windows 依赖与推理服务。主 Agent 对照以上清单检查仓库实现，并独立运行构建、契约检查及本机联调。

### 7.1 隔离工作区与运行数据

- 工作区为 `D:\wt\og-retrieval`，分支为 `codex/server-retrieval`，基于 `1564401f1`。复制时核对了两份评审文档的 SHA-256。原工作区的已有变更留在 `D:\dev\open-gym`。
- PostgreSQL、Python、模型缓存、PID、日志、`retrieval.env` 与账户数据均在 `D:\dev\.tools\opengym-retrieval`。端口使用 PG `55432`、模型 `8765`、API `13000` 和 Web `15173`。

### 7.2 Windows 数据库与推理服务

- PostgreSQL 18.1 x64 使用独立 ICU `zh-CN` 集群。实际连接确认 `UTF8`、`pg_trgm` 1.6 与 `pgvector` 0.8.7，并从「坐姿推胸」取得 5 个中文三元组。检查了 pgvector DLL、SQL 扩展与服务器头文件。
- 隔离环境为 Python 3.12.16、PyTorch 2.9.1 和 ROCm 7.2.1。两份固定版本的 BGE 模型在 Radeon RX 9070 XT 上就绪。实际调用返回合法的 1024 维向量、精排下标和有限分数。锁文件检查通过。
- 主 Agent 通过 ASGI 模拟断开连接。排队请求退出后未启动推理，已运行请求保持计算槽直到线程结束，后续请求收到 HTTP 200。单模型启用时的健康状态也已检查。
- 回环 HTTP 验证远程认证头、可调维端点的 `dimensions: 1024`、固定维度端点省略该字段、向量维度检查以及精排返回契约。

### 7.3 公开动作索引

- 最终批次 `8bad1217-020a-4dec-a5b4-d3135de99036` 为 `ready`，目录哈希为 `c6dd387e735bd217499ccceca4c8605521bab6cf5bb6bbaeeab48d4bbe12ea12`。真实 `BAAI/bge-m3` 为 5,632 个公开动作生成了 1024 维向量。取库内 ID 与公开快照逐个比对，确认前导零保留且重定向 ID `0004` 未进入索引。
- 启用器械条件的查询计划命中该批次的部分 HNSW 索引。全库精排文档用本机 BGE tokenizer 核对，最长为 225 tokens。构建阶段使用 JS 文档预算，精排模型推理使用 512 的成对截断。
- 独立 PostgreSQL 验证库检查了单条探针、批次切换、同名模型的不同端点各自保有 `ready` 批次、重建失败保留旧 `ready`，以及过期批次在检索持锁时保留、释放后清理。随后在本机实际重启中确认 `--ensure` 复用了最终批次。

### 7.4 NestJS 检索与 Agent v2

- API 构建通过，定向测试 65 项通过。覆盖新旧任务契约、六轮上限、非法器械、取消和超时、单连接并发、未知 ID 和分数过滤、无候选兜底、双语会话投影与诊断。
- 用受控识别 HTTP 响应连通真实 PostgreSQL、本机 Embedding 和 Cross-Encoder。Run 从 `running` 进入 `completed`，返回 10 个已限定器械的公开 ID，四段诊断完整。核对 RRF 分数、可核实的排序依据和后续请求中的双语历史。
- API 全量结果为 926 项中 915 通过、9 失败、2 跳过。9 项 Windows 文件权限、不可写目录与 Unix socket 的失败均在 `1564401f1` 的独立基线复现。
- 从原工作区 `api/.env` 读取官方 DeepSeek 凭据，并配置独立实例的 `DEEPSEEK_API_KEY` 和 `DEEPSEEK_MODEL=deepseek-flash`。通过 Web 代理提交真实纯文字和仅合成图片请求，两次 `exercise-search.v2` 均为 `completed`，各返回 10 个符合限定器械的公开 ID。模型识别、两路召回、RRF、精排和会话投影均有证据。纯文字耗时约 5.8 秒，仅合成图片耗时约 5.0 秒。真实请求日志为 `accept-deepseek-live-v2.log`。

### 7.5 Web 与 RN

- Web 生产构建通过，智能检索相关测试 85 项通过。验证新会话刷新任务版本、追问固定版本、按服务端 ID 展示、器械限定和 v1 兼容。真实 Web 代理能访问已登录的 v2 API。
- RN 的 `check` 通过。核对服务端 v2、服务端 v1、本机 v1、恢复与追问、限定器械 Sheet、结果顺序、元数据及自建动作入口。
- 切换 DeepSeek 后，API 定向测试 119 项、Web 相关测试 40 项与评估 CLI 测试 8 项通过。Web 生产构建、RN `check` 和 API 参考页一致性检查也通过。旧账号模型配置保留为不可用，改用 DeepSeek 时需要录入新的凭据。

### 7.6 本机启动、切换与回退

- 从停止状态启动 PostgreSQL、已选模型和 v2 API，确认两模型报告 `ready`，Web 代理及登录后的 `GET /api/config` 可用。实际停止并复起时三个后端监听均释放，重新启动复用同一 `ready` 批次。
- 另起隔离 v1 API 验证了版本回退，v1 仍可登录和读取配置，无需启动 PostgreSQL 或模型。停止后回退端口释放。
- 使用本机真实 Embedding 和经回环 HTTP 调用的远程精排分支，验证了切换精排复用同一向量索引。Embedding 端点切换的构建与复用在独立验证库覆盖。
- Web 联调入口为 `http://localhost:15173`。证据位于运行根 `logs/`，主要为 `accept-stop-start-v2.log`、`accept-pg-retention.log`、`accept-contract-v2-local.log`、`accept-contract-v2-remote-rerank.log`、`accept-api-nest-final.log` 和 `accept-api-baseline.log`。
