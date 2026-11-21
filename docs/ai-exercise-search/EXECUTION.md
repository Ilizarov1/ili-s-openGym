# AI 动作检索执行计划

[需求](REQUIREMENTS.md) · [技术设计](DESIGN.md)

状态为待执行。所有命令使用 PowerShell。以下检查在实施对应阶段时运行；未执行的设备或环境检查在验收记录中标记为待验。

## 状态维护

- 初始所有步骤为 `- [ ]`。
- **每完成一步，立即把该步骤改为 `- [x]`**，并在 `记录` 行填写完成日期、commit、命令结果或证据路径。
- 未通过、失败或阻塞时保持 `- [ ]`，在 `记录` 行写 `阻塞：原因`，不要勾选。
- 一个阶段的全部步骤和退出条件都完成后，才能进入下一阶段。
- 设计或范围变化时，先更新本文件和 `DESIGN.md`，再继续勾选。

## 范围与约束

- 前置：[agent-runtime 执行计划](../agent-runtime/EXECUTION.md) 阶段 1–4（共享核心、服务端、Web、RN）全部勾选且 A1–A7 有证据；本需求不改动桩任务已验收的行为。
- 实施在既有 worktree `D:\dev\open-gym-agent-runtime`（分支 `feat/agent-runtime`）中进行，文档随该分支提交；如需拆分业务分支，另建 `feat/ai-exercise-search` 基于其上。
- 目标客户端只有 Web（`frontend/src`）和 RN Android（`mobile-rn`）。Web 仅服务端执行；RN 本机与服务端均可。
- 入口范围：RN 动作库 Tab 与训练添加/替换选择器（`ExerciseLibraryScreen` 含 `replacing` 语义）、Web `Library` 页与 `ExercisePicker`。
- 验收以 fixture 驱动为主；真实视觉模型只做一次 smoke（阶段 7）。
- 每个步骤的可观察判据优先写成可重放命令或 fixture 用例；设备项标注模拟器序列号与截图路径。

## 文件地图

| 区域 | 新增 | 修改 |
|---|---|---|
| 共享核心 | `api/agent-runtime/tasks/exercise-search.js`、`tasks/exercise-search-vocabulary.json` | `contracts.js`、`contracts.d.ts`、`errors.js`、`run.js`、`providers/fixture.js`、`providers/openai.js` |
| API | `api/src/agent/tasks/index.ts`、`api/test/agent-exercise-search.test.js`、`api/test/nest/agent-exercise-search.test.js` | `agent.types.ts`、`agent.service.ts`、`agent-session.store.ts`、`agent-run.store.ts`、`agent-config.store.ts`、`agent.flags.ts`、`openapi.yaml`、`.env.example`、`scripts/build-api.mjs`（若 tasks 目录未在复制清单） |
| Web | `frontend/src/lib/exercise-ai-search.js`、`exercise-ai-search.golden.json`、`exercise-ai-search.test.js`、`frontend/src/components/ExerciseAiSearch.jsx`、`frontend/src/components/ExerciseAiSearch.test.jsx` | `lib/exercise-search.js`、`views/Library.jsx`、`sheets.jsx`、`views/AgentSetup.jsx`、`locales/*.js`（按需） |
| RN | 无 | `src/agent/types.ts`、`store.ts`、`config.ts`、`media.ts`、`tasks.ts`、`runtime.ts`、`server-client.ts`、`recovery.ts`、`src/screens/ExerciseLibraryScreen.tsx`、`src/screens/AgentProfileScreen.tsx`、`src/librarySearch.ts`、`src/design/components/SearchField.tsx`、`src/design/gallery/DesignGallery.tsx` |
| 文档 | `docs/ai-exercise-search/ACCEPTANCE.md` | `AGENTS.md`、`docs/README.md`、`docs/RN_MIGRATION_STATUS.md`、`docs/SELF_HOSTING.md` |

## 阶段 0 基线与前置

退出条件：前置依赖已核对，环境与版本可复核，基线检查无新增失败。

- [ ] **0.1 核对前置与 worktree**
  - 范围：确认 agent-runtime 基础设施就绪，避免在未验收的核心上开工。
  - 文件：`../agent-runtime/EXECUTION.md`、`../agent-runtime/ACCEPTANCE.md`（核对对象，本步不改）。
  - 动作：`git -C D:\dev\open-gym-agent-runtime branch --show-current` 确认为 `feat/agent-runtime`；逐项核对 agent-runtime 执行计划阶段 1–4 的勾选状态与 A1–A7 证据；未完成项列入阻塞。
  - 判据：worktree 分支正确；阶段 1–4 全部 `- [x]` 且证据可打开；否则本计划阻塞并记录缺口。
  - 记录：待填（worktree 路径 / commit / 勾选状态）。

- [ ] **0.2 建立验收记录与环境版本**
  - 范围：新建本需求的验收记录文档。
  - 文件：`docs/ai-exercise-search/ACCEPTANCE.md`（新）。
  - 动作：建立“环境、命令、预期、实际、证据”表；记录 Node、npm、Java、Android SDK、Expo、adb 版本；预留 A1–A16 表骨架。
  - 判据：文档中有可复核的版本行和完整 A1–A16 空表。
  - 记录：待填。

- [ ] **0.3 冻结契约复核**
  - 范围：本计划与 [DESIGN](DESIGN.md) 的一致性，不涉及代码。
  - 文件：`DESIGN.md`（核对对象；发现偏差先改文档再开工）。
  - 动作：核对 §1 落点表与本文件地图一致；确认五个新错误码（`agent_media_invalid` 400、`agent_media_too_large` 413、`turn_limit` 429、`session_busy` 409、`session_conflict` 409）、`sessionMode`、首轮固定执行位置、会话 TTL（2h）与 run TTL（1h）均已写入 DESIGN。
  - 判据：两份文档无相互矛盾的接口、错误码或路径表述。
  - 记录：待填（确认 commit）。

- [ ] **0.4 记录实施前基线**
  - 范围：三个工程目录的现有检查，确认基线可跑。
  - 文件：无源码改动。
  - 动作：在 worktree 内分别执行 `api` 的 `npm.cmd run build`、`frontend` 的 `npm.cmd run build`、`mobile-rn` 的 `npm.cmd run check`；已有失败先记录为基线，不归因于本需求。
  - 判据：现有命令无新增失败，或失败有明确基线记录。
  - 记录：待填（命令、版本、失败项）。

## 阶段 1 共享运行核心扩展

退出条件：扩展后的共享核心测试全绿；桩任务既有用例不回归；`npm.cmd run build` 产物含 `dist/agent-runtime/tasks/`。

- [ ] **1.1 新增五个稳定错误码**
  - 范围：共享错误枚举与 HTTP 映射，服务端与 RN 共用。
  - 文件：`api/agent-runtime/errors.js`。
  - 动作：新增 `agent_media_invalid`（400）、`agent_media_too_large`（413）、`turn_limit`（429）、`session_busy`（409）、`session_conflict`（409），各带可展示信息；补充错误映射单测。
  - 判据：五个码可通过导出的映射函数得到预期 HTTP 状态与文案；不在 agent-runtime 原有清单内的码全部集中在此步落地。
  - 记录：待填。

- [ ] **1.2 扩展任务契约类型**
  - 范围：`TaskDefinition` 可选钩子与 `RunRequest` 会话模式，双端宿主共用。
  - 文件：`api/agent-runtime/contracts.js`、`contracts.d.ts`。
  - 动作：`TaskDefinition` 增加可选 `validateInput(input, context)`、`attachments(input, context)`、`capabilities(input)`、`userMessage(input)`、`assistantMessage(result)`、`fixtureCase(input, context)`，以及 `memoryCategories` 的空数组语义（空数组 = 不读长期记忆，宿主不得解释为全选）；`RunRequest` 增加 `sessionMode: 'new' | 'continue'`；类型在 `contracts.d.ts` 导出。
  - 判据：`node -e "import('./api/agent-runtime/index.js')"` 成功；类型被导出；缺省行为与桩任务现状一致（不声明钩子时回退原路径）。
  - 记录：待填。

- [ ] **1.3 运行编排接入钩子**
  - 范围：`run.js` 的模型输入组装与运行前校验。
  - 文件：`api/agent-runtime/run.js`。
  - 动作：`readFacts` 后、组装 `ModelInput` 前调用任务 `attachments` 钩子（声明即接管，含空数组，不与宿主附件合并）并统一走 `trimContext` 媒体预算；启动前用 `capabilities(input)` 动态校验能力（缺省回退 `requiredCapabilities`）；`memoryCategories` 为空数组时跳过 `selectMemories`；按 `sessionMode` 分派：`new` 时 `ensure` 会话（同 ID 且 `taskId` 不同返回 `session_conflict`）、`continue` 时只读（缺失或已删除返回 `session_deleted`，不建空会话）。
  - 判据：`agent-runtime.test.js` 原有用例不回归；新增用例覆盖钩子接管、空记忆、`continue` 缺会话三类行为。
  - 记录：待填。

- [ ] **1.4 提供商结构化输出支持**
  - 范围：共享 provider 的 JSON 模式与 fixture 序列。
  - 文件：`api/agent-runtime/providers/openai.js`、`providers/fixture.js`、`providers/index.js`。
  - 动作：`openai.js` 在任务请求结构化输出时携带 `response_format: json_object`（或等价兼容参数），不支持的配置静默跳过；`fixture.js` 新增 `candidates`、`fallback-only` 固定序列，未知用例返回明确错误；`index.js` 注册命名提供商 `opencode`（复用 OpenAI 兼容实现，固定 `baseUrl https://opencode.ai/inference/openai/v1`，不作为服务端自定义端点的开口）。
  - 判据：`agent-providers.test.js` 断言 JSON 模式请求构造、fixture 新序列与 opencode 固定 baseUrl；fixture 外部网络调用为 0。
  - 记录：待填。

- [ ] **1.5 更新 API 构建复制清单**
  - 范围：构建产物完整性。
  - 文件：`api/scripts/build-api.mjs`。
  - 动作：确认 `agent-runtime/tasks/`（含 `exercise-search.js` 与词表 JSON）进入 `copyDir` 列表与 `required` 校验；若 agent-runtime 阶段 1.15 只复制了根目录，此处补上。
  - 判据：`npm.cmd run build` 后 `dist/agent-runtime/tasks/exercise-search.js` 与词表 JSON 存在且可导入。
  - 记录：待填。

- [ ] **1.6 共享核心测试汇总**
  - 范围：阶段 1 的回归与新增用例。
  - 文件：`api/test/agent-runtime.test.js`、`agent-providers.test.js`（扩展）。
  - 动作：补齐 1.1–1.4 的新用例；全量运行共享核心三个测试文件加本文件。
  - 判据：`node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js` 全绿；无 Node 内建新增导入。
  - 记录：待填（测试输出摘要）。

## 阶段 2 共享任务与词表

退出条件：`exercise-search.v1` 可被两端宿主注册并在 fixture provider 下完整跑通文本与图片输入。

- [ ] **2.1 词表快照与对照测试**
  - 范围：受控词表的单一事实来源。
  - 文件：`api/agent-runtime/tasks/exercise-search-vocabulary.json`（新）、`api/test/agent-exercise-search.test.js`（新）。
  - 动作：写入 `bodyPart`（11 项）与 `equipment`（34 项）的现有 slug 枚举；测试对照 `frontend/src/lib/exercises-data.js` 与 `mobile-rn/src/catalogueData.ts` 校验快照与目录一致。
  - 判据：`node --test test/agent-exercise-search.test.js` 中词表用例通过；目录新增枚举时测试失败提示更新快照。
  - 记录：待填。

- [ ] **2.2 实现任务定义**
  - 范围：`exercise-search.v1` 的契约、prompt 与四个钩子。
  - 文件：`api/agent-runtime/tasks/exercise-search.js`（新）。
  - 动作：实现输入 schema（`hintText?` ≤500、`images?` data URL 数组）与 `validateInput`（文字或图片至少一项、图片 ≤2 张）；输出 schema（`candidates` 0..5 + 必返 `fallback`，字段与长度按 DESIGN §2）；prompt 按 [DESIGN](DESIGN.md) §2 系统提示词全文落为 `PROMPT` 常量，组装时把词表 slug 清单追加为提示词末段、图片块标注"当前图片/上一轮图片"；`attachments` 钩子校验 data URL 前缀、MIME 与 magic bytes、解码后字节（≤1MiB/张）、像素尺寸、张数（≤2），失败返回 `agent_media_invalid` / `agent_media_too_large`；`capabilities(input)` 按输入返回 `['text']` 或 `['text','image']`；`userMessage`（纯图为 `[图片]`）与 `assistantMessage`（`meta` 只含张数/字节/MIME/尺寸）；`memoryCategories: []`；`fixtureCase` 仅 `profileRef.provider === 'fixture'` 时生效。
  - 判据：fixture provider 下纯文字、纯图（1×1 PNG）、图+文三类输入都能产出结构化输出；越限图片、非法 data URL、>2 张分别被拒且错误码正确。
  - 记录：待填。

- [ ] **2.3 实现输出清洗**
  - 范围：模型输出进入 schema 校验前的兜底。
  - 文件：`api/agent-runtime/tasks/exercise-search.js`。
  - 动作：`parseOutput` 截断候选到 5；丢弃缺 `name` 或非法 `level` 的候选；超长字段截断；`fallback` 缺失时生成安全默认（`understanding` 取 `hintText` 截断或固定文案）；`bodyParts`/`equipment` 过滤为合法 slug；从围栏/多余文本中提取首个完整 JSON 对象，仍失败返回 `model_unavailable`。
  - 判据：构造的脏输出（多候选、非法枚举、代码围栏、纯文本）全部被清洗为合法结构或稳定错误，不把原始响应透出。
  - 记录：待填。

- [ ] **2.4 任务级测试**
  - 范围：阶段 2 的完整用例。
  - 文件：`api/test/agent-exercise-search.test.js`。
  - 动作：覆盖输入至少一项（空白文字 + 无图拒绝、空白文字 + 图合法）、图片校验全项、`hintText` 长度边界（恰 500 通过、501 拒绝）、图片边界（1×1 通过、极端长宽比与伪造 MIME 拒绝）、清洗规则、词表 fixture 用例（`candidates`/`fallback-only`/`error`）、提示词不变量（JSON-only 指令、禁止输出目录 ID、词表注入段、图片标注）、真实配置忽略 `fixtureCase`。
  - 判据：`node --test test/agent-exercise-search.test.js` 全绿。
  - 记录：待填（测试输出摘要）。

## 阶段 3 共享匹配管道

退出条件：双端对同一 fixture 候选得到相同动作集合；Web vitest 全绿且 golden 门槛达标（初始门槛见 3.4，校准后固化）；RN typecheck 通过。

- [ ] **3.1 检索引擎暴露打分接口**
  - 范围：现有检索函数新增只读出口，不改行为。
  - 文件：`frontend/src/lib/exercise-search.js`。
  - 动作：新增 `searchScored(list, query)` 返回 `{ exercise, score }[]`；现有 `searchExercises` 与其他导出保持不变。
  - 判据：现有 Web 检索测试不回归；`searchScored` 对精确名、别名、模糊串的排序可复现。
  - 记录：待填。

- [ ] **3.2 实现匹配管道**
  - 范围：模型候选到动作库对象的纯函数转换，Web 与 RN 共用。
  - 文件：`frontend/src/lib/exercise-ai-search.js`（新）。
  - 动作：`createExerciseAiSearch({ searchScored, list, translate })`；按 [DESIGN](DESIGN.md) §6 的流程与常量表实现：逐候选 `name`（含 CJK 先试 `nameEn`）在候选池上 `searchScored` 取最高分；零命中或低于 `BASE_FLOOR` 且含 CJK 时走字符级回退（bigram Dice ≥ `CJK_DICE_MIN` 且 LCS ≥ `CJK_LCS_MIN`，`top1 − top2 ≥ CJK_MARGIN` 才取唯一最优并降级 `low`，否则歧义丢弃）；`equipment`/`bodyPart` 提示命中加 `EQ_BONUS`/`BP_BONUS`，器械明显冲突丢弃；去重（同动作保留调整分最高、依据「；」拼接 ≤2 条）截断 5 条；全部未匹配转兜底；`fallback` slug 过滤为现有筛选值。常量为命名导出、初值按 DESIGN §6，fixture 校准后固化；RN 侧经 `mobile-rn/src/librarySearch.ts` 暴露候选池（含自建动作与别名），动作库当前筛选不进入候选池。
  - 判据：注入相同候选池与 fixture 候选时，纯函数输出确定且与测试快照一致；常量值与 DESIGN §6 一致。
  - 记录：待填。

- [ ] **3.3 匹配管道测试**
  - 范围：双端一致性证据。
  - 文件：`frontend/src/lib/exercise-ai-search.test.js`（新）、`mobile-rn`（typecheck 覆盖）。
  - 动作：vitest 覆盖英文精确/模糊、中文“坐姿推举”字符级回退、别名、自建动作、提示消歧（`EQ_BONUS`/`BP_BONUS` 与冲突丢弃）、歧义丢弃、全未匹配转兜底、等级合成（精确 high→高；精确 medium 或模糊→中；回退/歧义→低）；`BASE_FLOOR`、`CJK_DICE_MIN`、`CJK_LCS_MIN`、`CJK_MARGIN` 的校准终值写入用例。
  - 判据：`npm.cmd test -- src/lib/exercise-ai-search.test.js` 全绿；`mobile-rn` 的 `npm.cmd run typecheck` 通过；双端注入同一候选池对同一 fixture 候选产出相同动作集合（同算法断言）。
  - 记录：待填。

- [ ] **3.4 检索效果 golden 集**
  - 范围：匹配质量的量化验收，双端共用同一评测与门槛。
  - 文件：`frontend/src/lib/exercise-ai-search.golden.json`（新）、`frontend/src/lib/exercise-ai-search.test.js`（扩展 runner）。
  - 动作：编写约 85 个"模型输出 → 期望动作"样例，覆盖矩阵按 [DESIGN](DESIGN.md) §6 效果评测：英文精确名（跨部位/器械抽样）、变体与俚语、拼写近似、中文名（中英两种本地化池各跑：中文名配中文池走 CJK 回退、`nameEn` 配英文池走精确命中）、用户别名、自建动作、提示消歧/冲突、设计歧义，以及边界子集：无关节输出（食物/风景/自拍 → 空候选 + 诚实兜底）、幻觉请求（不可能的动作 → 空候选不得编造）、全景多器械（截断 ≤5 且依据各自成立）、五候选同动作（去重为 1）、语言错配、追问矛盾轮（最新轮优先）；runner 断言初始门槛（英文子集 top-1 ≥ 90%、top-5 包含 ≥ 97%；中文子集 top-1 ≥ 75%、包含 ≥ 90%；歧义、冲突与边界子集 100%；全局错误"高"为 0）；以"最小常量过门槛"校准 `BASE_FLOOR` 与三个 CJK 阈值，校准终值写回测试断言与 DESIGN 常量表。
  - 判据：golden runner 全绿且各子集达标；校准后常量与 DESIGN §6 一致；不达标时先调常量，仍不达标回 DESIGN 修算法，**不得放宽门槛**；边界子集正确率 100%（无关节与幻觉请求必须空候选 + 诚实兜底，编造动作为零容忍）。
  - 记录：待填（各子集命中率与校准后常量表）。

## 阶段 4 服务端宿主

退出条件：nest 集成测试全绿；OpenAPI 路由与文档生成检查通过。

- [ ] **4.1 建立任务注册表**
  - 范围：`AgentService` 从单任务改为按 `taskId` 分发。
  - 文件：`api/src/agent/tasks/index.ts`（新）、`api/src/agent/agent.service.ts`。
  - 动作：`createTaskRegistry({ store, media })` 返回 `Map<taskId, { task, tools, messageOf }>`，注册 `stub.v1` 与 `exercise-search.v1`；`parseStart` 按 `taskId` 取任务（未知返回 `invalid_request`），`start` 用任务自己的 `inputSchema` 与 `validateInput` 校验，`execute` 用任务自己的工具集合，`session.append` 用 `messageOf` 投影消息。
  - 判据：桩任务既有 nest 用例不回归；AI 任务用桩 schema 不再互相拒绝。
  - 记录：待填。

- [ ] **4.2 扩展服务端类型**
  - 范围：存储与响应的形状。
  - 文件：`api/src/agent/agent.types.ts`。
  - 动作：`AgentStartBody` 增加 `taskId`、`sessionMode`；配置能力增加显式 `image` 覆盖；会话增加 `taskId`、`executionLocation`、`meta`；消息增加可选 `meta`；`AgentRunStart`/`AgentRun` 增加脱敏 `profile: { id, label, provider, model, version }`。
  - 判据：`npm.cmd run build` 通过；新旧字段无冲突。
  - 记录：待填。

- [ ] **4.3 会话存储扩展**
  - 范围：会话的模式、轮次与清理。
  - 文件：`api/src/agent/agent-session.store.ts`。
  - 动作：`ensure` 记录 `taskId` 与 `executionLocation: 'server'`，同 ID 不同 `taskId` 返回 `session_conflict`；`append` 接受期望 `sessionVersion`，版本变化返回 `session_conflict`；按 task + session 统计已提交 run 数（失败/取消也计数），超过上限返回 `turn_limit`；新增 AI 会话 2 小时未更新的 TTL 清理（启动与新 run 时执行）。
  - 判据：并发追加同版本只成功一次；第 7 个 run（首轮后 5 轮）被拒；2h 过期会话被清理且可复现。
  - 记录：待填。

- [ ] **4.4 运行记录 TTL**
  - 范围：AI run 记录的短期保留。
  - 文件：`api/src/agent/agent-run.store.ts`。
  - 动作：AI 任务 run 记录保留 1 小时：超时清理结果与 requestId 索引；清理不触碰其他任务的记录。
  - 判据：注入旧时间戳后清理可复现；桩任务记录不受影响。
  - 记录：待填。

- [ ] **4.5 配置能力与解析顺序**
  - 范围：服务端配置的图像能力声明与稳定排序。
  - 文件：`api/src/agent/agent-config.store.ts`、`api/src/agent/agent.flags.ts`、`.env.example`。
  - 动作：配置支持显式 `capabilities.image` 覆盖；服务端默认配置由管理员 `agentVision`（默认开）声明图像能力；`list` 返回按配置 ID 升序的稳定排序；`resolve` 只在当前执行位置内取第一个可用配置，不跨端回退；用户配置 provider 枚举增加 `opencode`；`.env.example` 增加 `OPENCODE_API_KEY` 空占位与说明，真实值只进 git 忽略的 `.env`。
  - 判据：`image:false` 配置拒绝带图请求并返回 `profile_capability_missing`；纯文字请求在同配置下可跑；同层多配置时选择可复现。
  - 记录：待填。

- [ ] **4.6 AgentService 会话模式、轮次与并发**
  - 范围：运行入口的行为校验与响应。
  - 文件：`api/src/agent/agent.service.ts`。
  - 动作：`start` 校验 `sessionMode`（`new`/`continue` 语义按 1.3）；同一会话存在活动 run 时返回 `session_busy`；轮次校验走会话存储；`start`/`get` 响应附带脱敏配置摘要。
  - 判据：`continue` 缺会话返回 `session_deleted` 且不建空会话；并发第二个 run 返回 `session_busy`；响应含配置摘要且不含密钥。
  - 记录：待填。

- [ ] **4.7 OpenAPI 同步**
  - 范围：接口契约文档。
  - 文件：`api/openapi.yaml`、`scripts/build-api-docs.mjs`。
  - 动作：`AgentRunRequest` 增加 `taskId` 可选值与 `sessionMode` 说明；错误枚举增加五个新码；`AgentRunStart`/`AgentRun` 增加配置摘要字段；不新增路由；文档生成包含新字段。
  - 判据：`openapi-routes.test.js` 通过；文档生成包含 exercise-search 说明。
  - 记录：待填。

- [ ] **4.8 服务端集成测试**
  - 范围：阶段 4 的端到端证据。
  - 文件：`api/test/nest/agent-exercise-search.test.js`（新）。
  - 动作：临时 `DATA_DIR` + fixture 配置（含 `image:false` 用例）起 Nest；覆盖：文本/图片（1×1 PNG）发起、内联图片非法格式与超限拒绝、请求超 5 MiB 413 兜底、`sessionMode=continue` 不建空会话、`turn_limit`/`session_busy`、会话删除无消息与元数据残留、TTL 清理、`start/get` 配置摘要、日志不含图片数据。
  - 判据：`npm.cmd run test:nest -- test/nest/agent-exercise-search.test.js` 全绿；既有 `agent.test.js` 不回归。
  - 记录：待填。

## 阶段 5 Web 客户端

退出条件：Web 能在动作库与 `ExercisePicker` 完成 fixture 驱动的识别、追问、兜底与选择回填；构建通过。

- [ ] **5.1 实现共用识别态组件**
  - 范围：Web 端识别态的全部 UI 与状态机。
  - 文件：`frontend/src/components/ExerciseAiSearch.jsx`（新）。
  - 动作：实现发起面板（多行文字、隐藏 `<input type="file">`、canvas 归一化多档压缩 ≤1280/0.85→960/0.6、≤1MiB）、摘要卡（文字 + 缩略图 + 所用配置 + 取消）、候选行、兜底区、追问输入行、错误态；状态机按 DESIGN §8（`idle → sheetOpen → running → candidates | fallbackOnly | error`，追问 ≤5 轮）；识别态挂载期间 2s 轮询，卸载即 cancel；发起走 `frontend/src/agent/api.js` 现有封装并传 `taskId`、`sessionMode`、`input`。
  - 判据：组件单测覆盖状态机全转移；fixture 配置下三种输入组合可发起。
  - 记录：待填。

- [ ] **5.2 Library 页接入**
  - 范围：动作库的入口与识别态覆盖。
  - 文件：`frontend/src/views/Library.jsx`。
  - 动作：搜索行增加 ✨ 入口（点按先做能力/配置预检）；AI 模式覆盖列表区并忽略关键词与筛选；退出 `x` 恢复文字/筛选快照；兜底 chips 清空文字与其他筛选、应用该维度后退出（不恢复快照）；候选行打开动作详情。
  - 判据：vitest 覆盖 A2、A4、A5、A14 的 Web 路径；关键词检索行为不变。
  - 记录：待填。

- [ ] **5.3 ExercisePicker 接入**
  - 范围：训练选择器的 AI 覆盖层。
  - 文件：`frontend/src/sheets.jsx`。
  - 动作：`ExercisePicker` 搜索行增加 ✨；AI 检索以覆盖层替换选择器列表（不嵌套第二个 Sheet）；候选沿用 `onPick(ex)`（打开配置/详情）与 `onPick(e, true)`（快速添加/替换）语义；选中后退出 AI 模式并由调用方关闭选择器。
  - 判据：vitest 覆盖 A15 Web 路径；原选择器无 AI 时行为不变。
  - 记录：待填。

- [ ] **5.4 配置页能力开关**
  - 范围：服务端用户配置的图像能力声明。
  - 文件：`frontend/src/views/AgentSetup.jsx`。
  - 动作：配置表单增加“该模型可读取图片”开关，写 `capabilities.image` 覆盖；默认关闭 provider 推断；provider 可选列表增加 `opencode`。
  - 判据：开关状态随配置往返；关闭后带图请求得到可读错误（A10）。
  - 记录：待填。

- [ ] **5.5 中断恢复引用**
  - 范围：Web 端“上次检索未完成”提示。
  - 文件：`frontend/src/components/ExerciseAiSearch.jsx`（或其挂载点）。
  - 动作：发起时把 `runId/sessionId/location` 写入按账号隔离的 `localStorage`；终态或退出清除；重进动作库检测到非终态引用时提示“上次检索未完成”，后台对旧 run 调 `cancel` 后清引用，提供重新发起入口。
  - 判据：模拟服务端重启后重进出现提示；终态路径不出现。
  - 记录：待填。

- [ ] **5.6 Web 测试与构建**
  - 范围：阶段 5 的验证汇总。
  - 文件：`frontend/src/components/ExerciseAiSearch.test.jsx`（新）、既有 Library/Sheets 测试（扩展）。
  - 动作：跑全部相关 vitest；`npm.cmd run build`；确认 bundle 可按需加载新组件；新文案英文 key 回退。
  - 判据：测试全绿；构建成功；locale 现有测试不破坏。
  - 记录：待填。

## 阶段 6 RN 客户端

退出条件：RN 本机与服务端两条路径都能 fixture 驱动完成识别、追问、兜底与选择回填；静态检查、Metro 导出通过；设备验收记录在案。

- [ ] **6.1 RN 类型与启动输入**
  - 范围：RN 侧契约类型。
  - 文件：`mobile-rn/src/agent/types.ts`。
  - 动作：`AgentStartInput` 增加 `taskId`、`sessionMode`；配置能力显式 `image` 覆盖；会话/消息 `meta`；运行结果配置摘要。
  - 判据：`npm.cmd run typecheck` 通过；与共享 `contracts.d.ts` 字段一致。
  - 记录：待填。

- [ ] **6.2 图片持有表**
  - 范围：本机图片的会话期存储与清理。
  - 文件：`mobile-rn/src/agent/store.ts`。
  - 动作：新增 `agent_ai_images` 表（`scope`、`sessionId`、`turn`、`id`、`mime`、`size`、`width`、`height`、`bytes`、`createdAt`）；会话删除同步删图；启动清理孤儿（会话已删/过期）；每会话 ≤2 张，新图逐出旧图。
  - 判据：同 scope 隔离；逐出与孤儿清理可复现；事务失败回滚。
  - 记录：待填。

- [ ] **6.3 配置解析与能力覆盖**
  - 范围：RN 静默解析顺序。
  - 文件：`mobile-rn/src/agent/config.ts`。
  - 动作：首轮解析顺序本机（按 ID 升序）> 服务端用户 > 服务端默认；练习模式仅本机；能力校验用共享 `capabilities(input)`；返回脱敏配置摘要；`AGENT_RUNTIME_DISABLED` 只隐藏服务端路径，本机不受影响；本机 provider 选项增加 `opencode`（密钥仍入 SecureStore）。
  - 判据：A10/A11 的本机路径可复现：仅文本配置拒绝带图、禁用后本机入口仍在。
  - 记录：待填。

- [ ] **6.4 图片归一化与读取**
  - 范围：RN 附件归一化。
  - 文件：`mobile-rn/src/agent/media.ts`。
  - 动作：`expo-image-picker` 选图后用 `expo-image-manipulator` 多档压缩（1280/0.85 → 960/0.6）至解码后 ≤1MiB，复用 `src/body/photos.ts` 的压缩与 EXIF 处理方式但不写进度照片目录；`expo-file-system` 读为 data URL；解码失败拒绝；图片元数据写日志。
  - 判据：1×1 PNG 可作为图像输入；大图压到 ≤1MiB；损坏文件返回 `agent_media_invalid`。
  - 记录：待填。

- [ ] **6.5 RN 任务注册**
  - 范围：本机执行的任务分发。
  - 文件：`mobile-rn/src/agent/tasks.ts`。
  - 动作：暴露 `createTaskRegistry(data)`，注册桩任务与 `exercise-search.v1`；桩行为不变。
  - 判据：`runtime.start({ taskId: 'exercise-search.v1', ... })` 在 fixture 本机配置下可完成。
  - 记录：待填。

- [ ] **6.6 RN 运行时扩展**
  - 范围：本机运行的会话与生命周期。
  - 文件：`mobile-rn/src/agent/runtime.ts`。
  - 动作：`start` 接受 `taskId`、`sessionMode`；创建 AI 会话时记录 `executionLocation`，追问不换端；轮次与并发校验（上限 `turn_limit`、并发 `session_busy` 的本机等价）；提供 `waitForRun` 辅助供识别态轮询 SQLite 状态；会话消息按任务投影写入。
  - 判据：本机 6 个 run 后拒第 7 个；运行中并发第二个 run 被拒；取消后晚到结果不写回。
  - 记录：待填。

- [ ] **6.7 服务端客户端扩展**
  - 范围：RN 服务端路径。
  - 文件：`mobile-rn/src/agent/server-client.ts`。
  - 动作：`startRun` 传 `taskId`、`sessionMode`、`input`（含 `images` 内联）；2s 轮询沿用；断线按 run ID 重查；解析响应中的配置摘要。
  - 判据：配对 + fixture 服务端配置下全流程可跑；断线重连后能查询原 run。
  - 记录：待填。

- [ ] **6.8 启动恢复与最近引用**
  - 范围：RN 中断提示。
  - 文件：`mobile-rn/src/agent/recovery.ts`。
  - 动作：启动时把本 scope 遗留 AI run 标记 `interrupted`；保留最近 AI run 引用，进入动作库时非终态则提示“上次检索未完成”并取消旧 run，提供重新发起。
  - 判据：杀进程重开后提示可复现；终态 run 不触发提示。
  - 记录：待填。

- [ ] **6.9 SearchField 与设计画廊**
  - 范围：设计系统组件与治理同步。
  - 文件：`mobile-rn/src/design/components/SearchField.tsx`、`mobile-rn/src/design/gallery/DesignGallery.tsx`。
  - 动作：新增可选 `onAiPress`（传入才渲染 `sparkles` 44×44 按钮）与 `editable`；画廊增加带 ✨ 回调与禁用文字两种演示。
  - 判据：`npm.cmd run design:check` 与 `npm.cmd run check` 通过；画廊可见两种新演示。
  - 记录：待填。

- [ ] **6.10 动作库识别态**
  - 范围：RN 的识别态 UI 与选择语义。
  - 文件：`mobile-rn/src/screens/ExerciseLibraryScreen.tsx`。
  - 动作：`SearchField` 传 `onAiPress` 接入发起 Sheet（拍照/相册并排直调 picker）；识别态覆盖列表区：文字禁用、chips 隐藏、忽略原筛选、摘要卡 + 候选 + 兜底 + 追问行（`📷` 弹小 Sheet）；动作库候选进详情、`replacing` 行走 `setDetail` → “选择此动作替换”、非替换走 `pickCatalogue`/`pickCustom` 或详情；退出 `x` 恢复快照；离开页面取消并删会话与图片。
  - 判据：fixture 配置下 A1、A2、A3、A6、A14、A15 的 RN 路径可操作；替换后训练第一槽位变化且数量一致。
  - 记录：待填。

- [ ] **6.11 配置页能力开关**
  - 范围：RN 配置声明。
  - 文件：`mobile-rn/src/screens/AgentProfileScreen.tsx`。
  - 动作：本机与服务端用户配置增加“该模型可读取图片”开关，写 `capabilities.image`；provider 可选列表增加 `opencode`。
  - 判据：开关往返保存；`image:false` 配置带图请求被拒（A10 设备路径）。
  - 记录：待填。

- [ ] **6.12 静态检查与 Metro 导出**
  - 范围：RN 工程完整性。
  - 文件：无源码新增。
  - 动作：`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run design:check`、`npm.cmd run check`；`npx.cmd expo export --platform android --output-dir .expo-ai-search-export`。
  - 判据：全部通过；bundle 含共享任务与词表 JSON；无 Node 内建报错。
  - 记录：待填（bundle 路径）。

- [ ] **6.13 设备验收**
  - 范围：模拟器上的双路径验收。
  - 文件：无源码新增。
  - 动作：按 [RN Android 工具与验收](../../.agents/skills/opengym-development/references/rn-android.md) 申请设备；安装 APK；fixture 配置下执行 A1（本机 + 服务端）、A2、A3、A6、A8、A14、A15；另验 A11（服务端禁用时本机入口仍在）。
  - 判据：设备记录含模拟器序列号、APK 哈希、截图与实际结果；A1/A6/A8/A15 全过。
  - 记录：待填（序列号 / 截图路径）。

- [ ] **6.14 构建并验证 APK**
  - 范围：发布产物。
  - 文件：无源码新增。
  - 动作：`npx.cmd expo prebuild --platform android --no-install`；`.\android\gradlew.bat :app:assembleRelease`；`apksigner verify`；`Get-FileHash -Algorithm SHA256`。
  - 判据：签名通过；哈希写入验收记录。
  - 记录：待填（APK 路径 / SHA-256）。

## 阶段 7 双端验收与交接

退出条件：A1–A16 全部有 Web/RN/API 对应证据；文档与项目地图更新；回退演练完成。

- [ ] **7.1 填写验收记录**
  - 范围：A1–A16 的证据汇总。
  - 文件：`docs/ai-exercise-search/ACCEPTANCE.md`。
  - 动作：按编号记录命令、版本、前置数据、预期、实际、通过/失败/待验、证据路径；fixture 离线项与设备项分开标注。
  - 判据：每条有证据；未跑项标明待验。
  - 记录：待填。

- [ ] **7.2 真实视觉模型 smoke**
  - 范围：真实供应商的一次性验证。
  - 文件：`docs/ai-exercise-search/ACCEPTANCE.md`。
  - 动作：smoke 配置使用 `opencode` 提供商与模型 `deepseek-v4.1-flash-1017`（ID 以服务端模型列表为准；密钥从 git 忽略的 `api/.env` 读 `OPENCODE_API_KEY` 配服务端默认配置，或在 RN 本机配置录入，**任何真实密钥不进提交、文档与日志**）；对 `docs/ai-exercise-search/test_pic/` 中的实物照片执行手工 smoke（每张配一句文字），期望候选按下表预先填写，执行时逐张核对；竖拍照片同时验证 EXIF 方向归一化；只跑 fixture 的项保持"待验"标记。若该模型实测无图像能力，如实关闭能力开关并记录，另选有视觉能力的模型完成照片项。

| 照片（`test_pic/`） | 内容 | 期望候选（执行前预填） |
|---|---|---|
| `微信图片_20261121172209_120_66.jpg` | 待填 | 待填 |
| `微信图片_20261121172210_121_66.jpg` | 待填 | 待填 |
| `微信图片_20261121172211_122_66.jpg` | 待填 | 待填 |
| `微信图片_20261121172211_123_66.jpg` | 待填 | 待填 |
| `微信图片_20261121172212_124_66.jpg` | 待填 | 待填 |

  - 判据：真实模型路径产出可读结果或明确错误；每张的期望命中与实际差异逐张可追溯；竖拍照片识别后显示方向正确；结果与截图入验收记录。
  - 记录：待填。

- [ ] **7.3 更新文档与项目地图**
  - 范围：仓库导航与自托管说明。
  - 文件：`AGENTS.md`、`docs/README.md`、`docs/RN_MIGRATION_STATUS.md`、`docs/SELF_HOSTING.md`。
  - 动作：AGENTS.md 增加或核对 `api/agent-runtime/tasks/`、`frontend/src/components/ExerciseAiSearch.jsx`、`frontend/src/lib/exercise-ai-search.js` 等条目；README 挂 ACCEPTANCE 链接；RN 迁移状态增加本功能条目；SELF_HOSTING 说明 `agentVision`、会话 2h/run 1h 清理与 `AGENT_RUNTIME_DISABLED` 的服务端限定语义。
  - 判据：目录职责与代码一致；链接可打开。
  - 记录：待填。

- [ ] **7.4 运行最终命令矩阵**
  - 范围：全量回归。
  - 文件：无。
  - 动作：按下表跑完整命令矩阵；记录 API 镜像、Web 构建、RN APK 的哈希。
  - 判据：全部通过或明确待验。
  - 记录：待填。

- [ ] **7.5 演练回退**
  - 范围：运行开关与数据保留。
  - 文件：无。
  - 动作：`AGENT_RUNTIME_DISABLED=1` 重启后确认 Web 与 RN 服务端路径入口消失、RN 本机可用；`agentVision=0` 时服务端默认配置拒绝带图请求并显示可读错误；恢复后数据仍可读。
  - 判据：回退不删除 Agent 数据与图片表；恢复启用后功能正常。
  - 记录：待填。

## 命令矩阵

| 工作目录 | 命令 | 用途 |
|---|---|---|
| `api` | `npm.cmd ci` | 安装依赖 |
| `api` | `npm.cmd run build` | 编译 Nest，复制 `agent-runtime` 含 `tasks/` |
| `api` | `node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js test/agent-exercise-search.test.js` | 共享核心与任务测试 |
| `api` | `npm.cmd run test:nest -- test/nest/agent.test.js test/nest/agent-exercise-search.test.js` | API 集成测试 |
| `frontend` | `npm.cmd ci` | 安装依赖 |
| `frontend` | `npm.cmd test -- src/lib/exercise-ai-search.test.js src/components/ExerciseAiSearch.test.jsx` | 匹配管道与识别态测试 |
| `frontend` | `npm.cmd run build` | Web 构建 |
| `mobile-rn` | `npm.cmd ci` | 安装依赖 |
| `mobile-rn` | `npm.cmd run check` | lint、规则、typecheck、design:check |
| `mobile-rn` | `npx.cmd expo export --platform android --output-dir .expo-ai-search-export` | Metro 解析和 JS bundle |
| `mobile-rn` | `npx.cmd expo prebuild --platform android --no-install`；`.\android\gradlew.bat :app:assembleRelease` | Android APK |
| `mobile-rn` | `apksigner verify <apk>`；`Get-FileHash -Algorithm SHA256 <apk>` | 产物验签与标识 |
| `api` | `docker build -t opengym-api-ai-search .\api` | 验证镜像包含共享任务 |

## 启用与回退

- 首次只在本地与独立 API 数据目录启用；Web/RN 与 API 同批部署；入口出现依赖服务端 `agent.enabled`（agent-runtime 已定义的配置暴露）与本机配置可用性。
- `AGENT_RUNTIME_DISABLED=1` 只关闭服务端执行路径：Web 入口与 RN 服务端路径不渲染，RN 本机配置与练习模式不受影响。全局关闭需另设本机开关，不能复用该标志。
- `agentVision=0` 使服务端默认配置声明为无图像能力：带图请求返回 `profile_capability_missing`，纯文字请求不受影响。
- 回退保留 `agent-<uid>.json`、`opengym-agent.db`（含 `agent_ai_images`）与 `data/secret`；AI 会话 2h 与 run 1h TTL 会在启用期自动清理残留。
- 不删除旧 Coach 数据、训练数据或桩任务记录；`exercise-search.v1` 与 `stub.v1` 在注册表中并存，可单独禁用 AI 任务入口（隐藏 ✨）而不影响桩任务回归。

## 验收对照

| 编号 | 需求 | 证据位置 |
|---|---|---|
| A1 | R1 | 设备记录（本机 + 服务端）；`ExerciseAiSearch.test.jsx` |
| A2 | R2 | 设备记录；Web/RN 状态机单测 |
| A3 | R3 | `agent-exercise-search.test.js`；设备记录 |
| A4 | R3 | Web vitest（Library chips 规则） |
| A5 | R3 | Web vitest + 设备记录 |
| A6 | R4 | 设备记录；nest 测试（同执行位置） |
| A7 | R4 | nest 测试（`turn_limit`）；Web/RN 单测 |
| A8 | R4 | 设备记录（会话与图片删除） |
| A9 | R5 | Web/RN 单测 + 设备记录 |
| A10 | R5 | nest 测试（`image:false`）；设备记录 |
| A11 | R5 | 回退演练（7.5）；设备记录 |
| A12 | R6 | Web vitest（恢复提示）；RN 设备记录 |
| A13 | R1、R5 | 双端验收汇总（7.1） |
| A14 | R2 | Web/RN 单测 + 设备记录 |
| A15 | R1、R2 | 设备记录（替换槽位）；`sheets.jsx` 测试 |
| A16 | R4 | nest 测试（continue 不建空会话）；设备记录 |
