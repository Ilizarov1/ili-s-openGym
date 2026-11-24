# openGym 服务端智能动作检索改造

## 1. 目标与范围

把**召回、融合和精排**移到 NestJS。Web 和 RN 的服务端模式直接展示服务端返回的有序动作结果（最多 **10** 项）。新链路只索引公开动作库，沿用现有 Agent 配置做多模态识别。独立 worktree 承载代码改造，同时在当前 Windows 上装好数据库和模型运行环境。

- **范围边界**：服务端公开动作索引不包含用户自定义动作（`customEx`）和用户自定义别名；RN 端继续保留结果末尾的「新建自定义动作」兜底入口。旧版客户端和 RN 本机模式继续走 `exercise-search.v1`。
- **机器推理评估**：RX 9070 XT 有 16 GB 显存，在 AMD 的 Windows PyTorch 支持范围内。建库时批量编码约 5,632 条公开动作，日常检索只编码一次查询，再为最多 30 个候选打分。精排是更吃算力的一步，所以 **embedding 和精排各自支持本机或远程**，可以单独把精排切到远程。 [显卡规格](https://www.amd.com/en/products/graphics/desktops/radeon/9000-series/amd-radeon-rx-9070xt.html) · [AMD Windows 支持矩阵](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/compatibility/compatibilityrad/windows/windows_compatibility.html)

## 2. Windows 依赖与推理服务协议

### 2.1 数据库（PostgreSQL + pgvector + pg_trgm）

- 在 D 盘安装 PostgreSQL 18 x64，复用已有的 C++ Build Tools 编译 `pgvector 0.8.7`，并启用 `pg_trgm`。建立仅监听本机（`127.0.0.1`）的检索实例，默认端口 `55432`。PostgreSQL 仅存可重建的公开动作索引，账户和训练数据继续由现有 JSON 存储负责。 [PostgreSQL Windows 安装](https://www.postgresql.org/download/windows/) · [pgvector Windows 构建](https://github.com/pgvector/pgvector#installation)
- **编码与中文 trigram 验证**：初始化检索库必须采用 `UTF8` 编码与 `ICU`（或可正确识别多字节中文字符的 locale），建库前必须执行 `SELECT show_trgm('坐姿推胸');` 验证能够正常产出非空中文 trigram。
- **MSVC 编译止损预案**：若用 MSVC `nmake` 为 PostgreSQL 18 编译 `pgvector 0.8.7` 遇头文件或工具链阻塞，允许直接改用 PostgreSQL 17 或官方/社区预编译二进制，不卡在扩展编译环节。

### 2.2 本机推理服务（`127.0.0.1:8765`）

- 用 `uv` 配置独立的 Python 3.12 环境与 AMD PyTorch，默认监听 `127.0.0.1:8765`。使用 `BAAI/bge-m3` 生成 1024 维向量，使用 `BAAI/bge-reranker-v2-m3` 精排；优先使用 GPU，本机 GPU 后端不可用时切到 CPU。模型权重和 HuggingFace 缓存放在 D 盘。 [AMD 安装说明](https://rocm.docs.amd.com/projects/radeon-ryzen/en/latest/docs/install/installryz/windows/install-pytorch.html) · [Embedding 模型](https://huggingface.co/BAAI/bge-m3) · [精排模型](https://huggingface.co/BAAI/bge-reranker-v2-m3)
- **统一 HTTP 协议**：本机 Python 服务直接实现与远程兼容的标准接口，使 NestJS 的 `local` 和 `remote` 共用同一套 HTTP 客户端，仅切换端点、模型名与密钥：
  - `GET /health`：返回模型加载状态、已就绪模型名与实际计算设备（`cuda` / `rocm` / `cpu`）；
  - `POST /v1/embeddings`：OpenAI 兼容格式；
  - `POST /v1/rerank`：硅基流动兼容格式。
- **并发与显存保护**：Python 侧对建库批处理配置固定 `batch_size`（默认 ≤ 32），对在线推理加单卡并发信号量/排队保护，避免多请求并发或建库期间 OOM。

### 2.3 远程推理与环境变量清单

Embedding 和精排通过环境变量独立配置，重启 API 生效；本机两项默认启用 `local`，远程配置就绪后可按需单切。密钥仅留在后端环境变量，绝不进入 `/api/config`、诊断日志或错误堆栈。 [远程 Embedding 接口](https://docs.siliconflow.cn/docs/api/embeddings-post) · [远程精排接口](https://docs.siliconflow.cn/docs/api/rerank-post)

| 环境变量 | 说明与默认值 |
|---|---|
| `EXERCISE_SEARCH_VERSION` | `v1` \| `v2`；检索配置就绪时默认声明 `v2` |
| `EXERCISE_SEARCH_PG_URL` | PostgreSQL 连接串，默认指向 `127.0.0.1:55432` |
| `EXERCISE_SEARCH_EMBEDDING_BACKEND` | `local` \| `remote`，默认 `local` |
| `EXERCISE_SEARCH_RERANK_BACKEND` | `local` \| `remote`，默认 `local` |
| `EXERCISE_SEARCH_LOCAL_MODEL_URL` | 本机模型服务地址，默认 `http://127.0.0.1:8765` |
| `EXERCISE_SEARCH_REMOTE_EMBEDDING_URL` / `MODEL` / `API_KEY` / `DIM` | 远程 OpenAI 兼容 `/embeddings` 地址、模型名、密钥与输出维度（默认 `1024`） |
| `EXERCISE_SEARCH_REMOTE_RERANK_URL` / `MODEL` / `API_KEY` | 远程硅基流动兼容 `/rerank` 地址、模型名与密钥 |
| `EXERCISE_SEARCH_EMBEDDING_TIMEOUT_MS` | Embedding 请求超时，默认 `5000` |
| `EXERCISE_SEARCH_PG_TIMEOUT_MS` | PostgreSQL 检索查询超时，默认 `3000` |
| `EXERCISE_SEARCH_RERANK_TIMEOUT_MS` | Rerank 精排请求超时，默认 `15000` |

## 3. 公开动作索引 Schema 与构建

### 3.1 数据源与 Canonical ID 边界

- 以 `api/agent-runtime/tasks/exercise-search-catalogue.json`（约 5,632 条公开动作，由 `EXDB`、中文名、标准别名 `a` 与姿势 `p` 同步生成）作为唯一 ID 集合。
- 按动作 ID 关联读取 `catalogue/exercises/<id>.json` 中的英文 `description` / `instructions` 与 `catalogue/i18n/zh.json` 中的中文 `instructions`，**严格排除** `catalogue/exercises/` 下仅含 `variantOf` 的重定向文件（如 `0004.json`）。

### 3.2 文档拼接与长度控制

- **结构化文本字段**：`name_en`、`name_zh`、`aliases`（标准别名数组）、`body_part`、`equipment`、`target`、`posture`。
- **向量文档（`embed_text`）**：双语名称 + 标准别名 + 部位/器械/目标肌群/姿势标签 + 英文 `description` + 过滤掉通用尾句（如“重复所需的重复次数”“回到起始位置”）的中英文起始动作要领。
- **精排文档（`rerank_text`）**：与向量文档分开构建，按 ≤ 384 tokens 截断，突出动作双语名、标准别名、器械、部位、姿势与起始动作特征，避免冗长泛化步骤拉长 Cross-Encoder 耗时和引入噪声。

### 3.3 PostgreSQL 表结构、维度与原子切换

- **构建元数据表 `retrieval_index_builds`**：
  - `build_id`（主键）、`catalogue_hash`（目录快照与文档模板版本的 SHA-256）、`embedding_backend`、`embedding_model`、`embedding_dim`、`status`（`building` \| `ready` \| `retired`）、`doc_count`、`created_at`、`activated_at`。
- **动作索引表 `retrieval_exercise_docs`**：
  - `build_id`、`exercise_id`、`name_en`、`name_zh`、`aliases`、`equipment`、`body_part`、`target`、`posture`、`embed_text`、`rerank_text`、`embedding vector(1024)`；主键 `(build_id, exercise_id)`。
- **向量维度约束**：统一约定本机 `BAAI/bge-m3` 与远程 embedding 均输出 **1024 维**（若远程使用可变维模型须显式传递 `dimensions: 1024`，建库前先校验模型接口实际返回维度与表定义一致；若未来引入非 1024 维模型，再按维度建独立表或分区）。
- **索引与文本召回策略**：
  - 文本：为规范化名称（小写/去标点）和别名建精确匹配索引与 `pg_trgm` GIN 索引；针对 2–3 字短中文词（如 `推胸`、`划船`、`深蹲`），结合子串匹配（`ILIKE` / `word_similarity`）与英文词元（`tsvector`）辅助召回，避免纯 `pg_trgm` 漏召回短中文词。
  - 向量：按 `build_id` 为 `embedding` 建 HNSW 余弦距离索引。
- **隔离与原子切换**：索引按 `catalogue_hash` + `embedding_model` + `embedding_dim` 隔离。构建脚本先把全部条目写入 `status = 'building'` 的批次并校验 `doc_count` 一致，随后在单个事务内将同配置旧 `ready` 置为 `retired`、新批次置为 `ready`。在线检索只查当前激活的 `ready` build；单独切换精排模型直接复用现有向量索引。

## 4. 服务端流水线与 Runtime 挂载

### 4.1 Runtime 挂载点与状态机

- **任务契约**：`exercise-search.v2` 复用现有多模态识别提示词与结构化输出（`rounds: 1`，`tools: []`，`toolCalls: 0`，不挂载 `search_catalogue` 工具）。
- **异步后处理挂载**：一轮模型识别完成后，由服务端执行流继续驱动异步检索阶段（扩展 `runAgent` 支持异步 post-process 钩子，或在 `AgentService.execute()` 接管后处理提交）：**embedding、PG 召回、RRF 融合与 Cross-Encoder 精排全部完成后，Run 才进入 `completed` 终态**；期间状态保持 `running`，并把 `AbortController.signal` 透传到所有 HTTP 与 PG 调用，确保取消请求可及时中止下游。
- **解除 `v1` 硬编码**：同步修正 `api/src/agent/agent.service.ts` 中的 `maxTurns: 6` 判定和诊断开启判断，以及 `api/agent-runtime/run.js` 中的诊断开关判断，从精确匹配 `'exercise-search.v1'` 改为匹配 `exercise-search.*`（与 `agent-run.store.ts`、`agent-session.store.ts` 保持一致）。

### 4.2 双路召回、硬过滤、融合与精排

1. **文本召回（Top 75）**：以用户输入 `hintText` 及一轮识别各候选的 `name`、`nameEn` 分别执行子查询（避免多候选拼成单串稀释得分），按 `exercise_id` 取最高归一化得分合并，保留前 **75** 项。
2. **向量召回（Top 75）**：按固定模板拼接 `hintText`、`fallback.understanding` 与首候选英文名，调用当前 embedding 后端生成单次查询向量，HNSW 检索前 **75** 项。
3. **硬过滤边界**：仅当请求显式传入 `confirmedEquipment` 时，同时对文本与向量两路召回追加 `equipment = $confirmedEquipment` 硬条件；模型识别出的 `equipment`、`bodyPart` 与姿势**绝不作为硬过滤**，而是拼入 Cross-Encoder 的 query 线索，并在精排打分时作为跨部位/姿势匹配信号参与排序。
4. **RRF 融合与精排**：两路 Top 75 按 `exercise_id` 执行 RRF（`k = 60`）融合，取前 **30** 项与各自 `rerank_text` 送交 Cross-Encoder (`bge-reranker-v2-m3`)。服务端校验返回的索引/ID 均出自本次 30 项候选并去重，产出有序的最多 **10** 项结果。

## 5. API、Task 契约与双端消费

### 5.1 版本协商（`GET /api/config`）

- 在 `api/src/agent/agent.flags.ts` 的 `agentPublicConfig()` 中增加 `exerciseSearchVersion: 'v1' | 'v2'`，随 `GET /api/config`（已登录时的 `agent` 字段）返回。
- 客户端在**发起新会话时**读取并锁定本会话的 `taskId`（`exercise-search.v2` 或 `exercise-search.v1`），追问轮次沿用同一 `taskId`；旧版客户端和 RN 本机模式走 `exercise-search.v1`（注：RN 若本机已配可用 profile，按现有优先级仍走本机 `v1`）。

### 5.2 `exercise-search.v2` 输入/输出与会话投影

- **输入契约**：沿用 v1 的 `hintText`、`images`、`fixtureCase`，新增可选 `confirmedEquipment?: string`（按 `exercise-search-vocabulary.json` 的 34 项器械 slug 白名单校验，非法值返回 `400 invalid_request`，保持 `additionalProperties: false`）。
- **输出契约**：
  - `rankedIds: string[]`（有序、去重、最多 **10** 项）；
  - `items?: Array<{ id: string; level?: 'high' | 'medium' | 'low'; rationale?: string }>`（与 `rankedIds` 一一对应，承载按精排分数分档的置信度与简短依据；客户端若某项缺少 `rationale` 则回退展示动作自身的「部位 · 器械」）；
  - `fallback: { understanding: string; bodyParts?: string[]; equipment?: string[] }`（沿用既有兜底语义与筛选建议结构）；
  - `clarifications?: Array<{ label: string; prompt: string }>`（沿用既有 0–3 项一键消歧 Chip）。
- **会话历史投影（`assistantMessage`）**：写入会话的 assistant 消息必须包含精排后 Top-N 动作的中英文名称与 `fallback.understanding`（不可只存数字 ID），以保证多轮追问时模型能准确承接上一轮结果。

### 5.3 双端消费与 `confirmedEquipment` 控件

- **列表渲染（最多 10 项）**：Web（`frontend/src/components/ExerciseAiSearch.jsx`，同步将展示截断由 5 放宽到 **10**）与 RN 服务端 v2（对齐 `AI_SEARCH_DISPLAY_LIMIT = 10`）均按 `rankedIds` 从本地目录查出动作展示对象并严格保留服务端顺序；RN 端继续保留「新建自定义动作」兜底卡片。
- **器械限定控件**：在 Web 和 RN 的服务端智能检索输入区复用现有器械词表与本地化名称映射，提供**可清除的器械限定选择**（通过选择芯片触发轻量下拉/选择弹层，不平铺 34 项撑爆输入区），默认不限；追问默认沿用当前限定且允许修改或清除；该控件状态与普通动作库筛选完全独立。

### 5.4 新增错误码

在 `api/agent-runtime/errors.js` 新增检索链路专用稳定错误码，并在 Web `ERROR_TEXT` 与 RN `aiErrorMessage` 补齐可重试的中文提示文案，与 VLM 失败的 `model_unavailable` 区分：

| 错误码 | HTTP 状态 | 触发场景 |
|---|---|---|
| `retrieval_unavailable` | `503` | 本机/远程 embedding、rerank 或 PG 服务不可达 |
| `retrieval_index_not_ready` | `503` | 当前目录与 embedding 配置尚无 `ready` 状态的索引 |
| `retrieval_timeout` | `504` | 下游检索或精排超过配置超时时间 |

## 6. 诊断日志、工程落点与可测试性

- **诊断事件扩展**：更新 `api/agent-runtime/exercise-search-diagnostics.js`，`END_PHASES` 增加 `'retrieval'`、`'rerank'`，新增白名单 stage：`retrieval_text`、`retrieval_vector`、`retrieval_fusion`、`rerank`（仅记录后端类型、耗时、候选数、Top ID 与分数、`hasConfirmedEquipment`、错误码，绝不记录用户原文与密钥），继续沿用同一 `traceId` 和现有开关。
- **仓库目录与依赖落点**：
  - `api/package.json`：引入 PostgreSQL 客户端依赖（`pg`）；
  - `api/src/agent/retrieval/`：NestJS 检索模块（PG 连接池、索引读取、统一 embedding/rerank HTTP 客户端、RRF 融合与流水线编排）；
  - `services/retrieval-model/`：本机 Python 推理服务（`pyproject.toml`、`uv.lock` 与 FastAPI/Starlette 服务）；
  - `scripts/build-retrieval-index.mjs`：公开动作索引构建与校验脚本；
  - `scripts/windows/`：Windows PowerShell 初始化与启停脚本；
  - 独立 worktree 使用独立的 `DATA_DIR`、端口与环境文件，不污染主仓运行数据。
- **可测试性与 `fixture` 兼容**：NestJS 通过 DI 接口注入检索器与精排器，使 `provider: 'fixture'` 及无 PostgreSQL、无 GPU 的单测和双端 UI 自动化测试可通过内存 stub 检索器完整跑通 `exercise-search.v2`。

## 7. 启动与交付

提供 PowerShell 初始化和启动命令，依次启动 PostgreSQL、启动需要的本机模型、检查或构建当前 embedding 的索引，再启动 NestJS。索引未就绪或模型服务失败时，v2 返回明确的 `retrieval_index_not_ready` / `retrieval_unavailable` / `retrieval_timeout` 错误供用户重试。识别无候选或检索结果为空时，沿用现有理解与追问界面。

本期交付范围是**仓库改造、Windows 原生依赖安装和启动配置**。测评、验收和 Docker 镜像单列后续范围。
