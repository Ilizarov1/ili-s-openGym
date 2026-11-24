# AI 动作检索评估 CLI 与诊断日志执行文档

状态：已执行（2026-11-22）。D01–D13 全部落地，D14 离线矩阵、fixture 整链路与真实模型命令均通过；验收记录与待验项见 [eval/ACCEPTANCE.md](eval/ACCEPTANCE.md)。适用于 OpenGym Web、RN Android 本机执行和 RN 配对服务端执行。开始前核对当前 HEAD，阅读根目录 AGENTS.md、opengym-development 技能及本目录的 [需求](REQUIREMENTS.md)、[设计](DESIGN.md) 和 [原验收记录](ACCEPTANCE.md)。

## 背景与目标

照片经 `exercise-search.v1` 得到模型生成的名称和器械线索。Web / RN 再用各自的动作目录匹配。任务目前单轮且没有检索工具，客户端每条查询只审查关键词首名。识别正确、搜不到正确 ID、正确 ID 排在后面、首名被拒绝，目前都可能表现为空结果。

已有 [5 张照片的 smoke](evidence/smoke-go-2026-11-21.json) 记录了带提示的模型响应，客户端主要用 fixture 验证。需要一个不依赖打开客户端或手动点搜索的评估入口，以及一套能用同一 traceId 串起真实请求的阶段日志。

## 范围

- 交付 PowerShell 可运行的 CLI、版本化样本清单、JSON 报告及 runbook。支持离线回放、视觉识别和整链路三种模式。
- 日志覆盖 Web、RN 本机和配对服务端。继续复用现有 Harness、模型供应商、目录适配器和匹配算法。
- 检索排序、阈值、提示词、候选数量、会话语义、API 对外格式保持当前行为。本任务不做召回优化、不加自动工具回查、不引入 Embedding 或向量库。
- CLI 从已归一化的图片开始走模型相关链路。浏览器 Canvas、Expo 相机与相册预处理属于客户端边界，分别验证；CLI 报告明确标记这一边界。

## 逐文件实施规格

本节是施工依据。上文用于说明目标，参数、文件归属、事件字段和操作顺序以下文为准。按 D01 到 D14 顺序实施。新增导出和类型声明也在指定文件内完成。已有同名符号时编辑原定义；不另建第二套运行入口。

### D01 公共事件模块

- [x] 新增 `api/agent-runtime/exercise-search-diagnostics.js` 和同名 `.d.ts`。这个模块只用标准 JS，供 Nest、Web 和 Metro 直接导入。声明以下导出：
  - `isExerciseSearchTraceId(value: unknown): value is string`。只接受 `req_<8-4-4-4-12 的十六进制 UUID>` 及 Web 已有 `req_<13 位时间戳>_<1–8 位小写 base36>`。不合法时忽略该日志事件，不改变请求合法性。
  - `createExerciseSearchTrace({ traceId, source, enabled, write? })`。关闭或 trace 无效时返回 `undefined`，否则返回接收一个事件对象的函数。默认 `write` 为 `console.info`，每次输出一行 JSON。捕获序列化及 sink 错误。根字段固定为 `event: "exercise_search"`、`schemaVersion: 1`、`traceId`、`source`、`stage`。
  - `safeExerciseSearchError(code: unknown): string`。仅透传 `api/agent-runtime/errors.js` 中声明的错误码以及 `permission_denied`、`asset_missing`；其余返回 `unknown`。不接收整个错误对象。
  - `logExerciseSearchMedia({ mediaAttemptId, source, enabled, write?, metrics })`。选图阶段尚无 requestId，媒体事件用独立的 UUID 和 `mediaAttemptId`。其余 envelope 与运行事件相同。提交事件携带最新一次成功选图的尝试 ID，供本地串联。
- [x] 在模块内按下表**逐字段投影**。未声明字段一律丢弃，不能展开任意输入对象。计数、时间和分数只接受有限数值，公开 ID 由上游用可信目录判定后才可传入。器械、肌群/部位由任务已有 slug 白名单校验。事件数组控制在图片 2、候选 5、检索 Top 5 的业务上限内，Top 5 为排序切片。CLI 明细对象保持在 CLI 内，绝不传给生产 sink。
- [x] 新增 `api/test/exercise-search-diagnostics.test.js`。用内存 write 捕获 JSON；断言关开关为零行、异常 sink 不抛、自定义 requestId 不出现在输出、未知字段和错误消息被剥离。用含假密钥、路径和 Data URL 的 测试标记断言输出不包含这些值。

| stage | 字段（除 envelope） |
|---|---|
| `media` | `mediaAttemptId`、`status`（ready/failed/cancelled）、`inputBytes`、`outputBytes`、`outputWidth`、`outputHeight`、`attempts`、`rotationApplied`、`elapsedMs`、失败时 `errorCode`。平台不能观测的字段省略 |
| `submit` | `execution`（server/local）、`hasHint`、`imageCount`、可选 `mediaAttemptId` |
| `attachments` | `images`，每项只含 `mime`、`width`、`height`、`bytes` |
| `model` | `round`、`status`（completed/failed/cancelled）、`elapsedMs`、`toolCalls`、失败时 `errorCode` |
| `recognition` | `rawCandidateCount`、`cleanCandidateCount`、`equipment`、`bodyParts` |
| `recall` | `candidateIndex`（从 0 开始）、`queryOrigin`（primary/english）、`queryWordCount`、`hitCount`、`top`（每项 `id`、`score`，仅公开目录） |
| `filter` | `candidateIndex`、`decision`（见 D04）、可选公开 `id` |
| `display` | `resultCount`、`publicIds`、`customCount`、`fallbackOnly`、`elapsedMs` |
| `end` | `status`（completed/failed/cancelled/interrupted）、`phase`（submit/attachments/model/recognition/match/poll）、`elapsedMs`、失败时 `errorCode` |

`source` 固定使用 `web`、`rn`、`api`、`rn-local`。客户端和运行时可各有一条 end，按 source 分开解读，同一 source 下同一 trace 最多一条 end。同一请求允许多条 recall 和 filter。

> **执行结果**（2026-11-22）：三个文件按规格落地；词表白名单直接导入任务旁的 `exercise-search-vocabulary.json`（不引入整个任务模块）。`node --test api/test/exercise-search-diagnostics.test.js` 18/18。非法 source 与关闭开关同样返回 `undefined`（保守扩展，防任意字符串进 envelope）。

### D02 共享任务与 Harness

- [x] 修改 `api/agent-runtime/tasks/exercise-search.js`。只在 `structuredFrom` 和 `createExerciseSearchTask().parseOutput` 增加可选回调：成功选取原 structured 或从 text 提取 JSON 后，在调用现有 `cleanExerciseSearchOutput` 前保存 candidates 数量；清洗后通过 `context.meta.exerciseSearchDiagnostic?.(...)` 发出 recognition。保留原解析优先级、异常、截断及去重。equipment/bodyParts 取清洗后的 fallback。不要为日志再次解析或复制整个输出。
- [x] 修改 `api/agent-runtime/run.js` 的 `runAgent`。仅在 `task.id === 'exercise-search.v1'` 时读取 `context.meta.exerciseSearchDiagnostic`。在 `taskAttachments` 成功后发附件事件；在 `gateway.invoke` 前后用现有注入时钟计时并发 model 事件，失败路径发同一阶段错误事件再让原异常处理继续。在 `completedOrCancelled` 和非取消 catch 出口通过一个 run 内布尔守卫发 end。使用当前阶段变量标记附件、模型、解析等失败点。不要把 trace 或日志字段传入 modelInput、结果持久化或任务 prompt。
- [x] 在 `api/test/agent-exercise-search.test.js` 增加测试。注入 in-memory 回调，断言 fixture 成功事件按 attachments → model → recognition → end；坏图无 model；无效输出以 recognition 阶段失败结束；普通任务不发这些事件。用同一预算运行有／无诊断的任务，排除注入时钟等元数据后比较结果。

> **执行结果**（2026-11-22）：8 条新用例全绿（事件顺序、阶段计数、坏图 phase=attachments 且零 gateway 调用、解析失败 phase=recognition、stub 任务零事件、有无 sink 结果一致、抛错 sink 不影响运行）。错误码白名单复用 `errors.js` 的 `ERROR_STATUS` 键避免漂移。`node --test` 三件套 59/59。

### D03 绑定服务端和 RN 本机

- [x] 修改 `api/src/agent/agent.service.ts`。在执行 job 时调用 `bindContext` 的位置构造 trace sink，`traceId` 使用规范化请求 `request.requestId`，`source: "api"`，只有 `process.env.AGENT_EXERCISE_SEARCH_DIAGNOSTICS === "1"` 且任务相符时开启。作为 `meta.exerciseSearchDiagnostic` 传入，保留其他 meta、账号隔离、任务注册和请求去重。
- [x] 修改 `mobile-rn/src/agent/runtime.ts`。在 `exercise-search.v1` 的 `bindContext` 入参与服务端按同样约定传 sink，`source: "rn-local"`，开关固定为 `process.env.EXPO_PUBLIC_AGENT_EXERCISE_SEARCH_DIAGNOSTICS === "1"`。沿用已有 local 作用域。若类型桥里的 RunContext 声明限制 meta，仅在 `mobile-rn/src/agent/shared.d.ts` 将 bindContext 入参和返回类型对齐共享契约。
- [x] 检查 `api/scripts/build-api.mjs` 的拷贝规则。现有递归拷贝已纳入新文件时保留原代码，以构建产物中存在 `api/dist/agent-runtime/exercise-search-diagnostics.js` 为验收。禁止把开关、trace 或日志附到公开 run 响应、OpenAPI 或 SQLite 表。

> **执行结果**（2026-11-22）：两端绑定按规格落地，RN 直接跨树导入 `exercise-search-diagnostics.js`，typecheck 通过，未动 `shared.d.ts`。`build-api.mjs` 的 `required` 数组追加该文件，构建失败即断言缺失。dist 实例冒烟：开关开时同一 `req_<uuid>` 串联 attachments→model→recognition→end（source `api`），开关关 0 事件。nest agent 测试 13/13。

### D04 共享 matcher 与目录边界

- [x] 修改 `frontend/src/lib/exercise-ai-search.js`。给 `createExerciseAiSearch` 加 `isPublicExercise(exercise)`，缺省返回 false。给现有 `match(output, hints)` 增加 `hints.diagnostics`，形状固定为 `{ emit, evaluation?: { expectedIds: string[], includeQueries: boolean } }`。生产调用只传 emit。
- [x] 在 `matchOne` 原查询循环中记录 recall。保持 EN 查询仅在当前含汉字条件下执行的行为，打上 english/primary 标签。在访问 `results[0]` 前采集同步排名，即使为空也发事件。生产 Top 5 从实际前 5 后过滤自建项，不能重新挑 5 个公开项填补；CLI 计算每个 expectedId 在原列表中的完整名次，从 1 开始，缺失为 null。只有 `includeQueries === true` 才将 `query` 字段加入 CLI 事件。
- [x] 在 `matchOne` 原有各返回点发 filter。固定决策名：`invalid_candidate`、`no_hit`、`cjk_ambiguous`、`no_name_evidence`、`below_floor`、`equipment_conflict`、`accepted`、`accepted_cjk_fallback`。在外层重复 ID 合并处分开发 `deduplicated`。CJK 回退内部须区分无合格项与最高两项差距过小，且只有**确实因此被拒绝**时发 cjk_ambiguous，已有可接受词法首名时不视作拒绝。只传实际接受或被校验拒绝的公开 ID，拿不到则省略。在返回现有 `{ items, fallback }` 前发 display。禁止改 Top 1、阈值、证据规则、计分、输出排序、候选结构、现有相似搜索行为。
- [x] 修改 `frontend/src/lib/exercises.js` 中 `createWebAiSearch`，用初始化后的 `new Set(CATALOGUE)` 按对象身份识别公开条目。修改 RN matcher，使可信公开条目来自 `createLibrarySearch` 构造的 (custom === false) 目录项，自建 ID 即使和公开范围格式相同也不记录。
- [x] 新增 `mobile-rn/src/agent/ai-search-matcher.ts`。将 `ai-search.ts` 中 WeakMap、`matcherFor` 及 `matchAiSearch` 原逻辑迁入，导出 `matcherFor(source)`、`matchAiSearch(source, structured, hintText, diagnostics?)`。新模块不运行时导入 Expo、SQLite 或会话控制器，仅 type import。原文件重新导出 `matchAiSearch`，现有 RN 调用无需改导入来源。
- [x] 修改 `frontend/src/lib/exercise-ai-search.test.js`。新增可注入结果列表的首名冲突、第二名是预期 ID 用例，断言 recall 仍记录第二名，输出仍为原有空结果。再以自建项、中文歧义、别名用例覆盖字段投影。比较传诊断与不传诊断的返回值深度一致。原 golden 继续运行。

> **执行结果**（2026-11-22）：全部落地；`cjkFallback` 内部改为返回 `{ exercise, ambiguous }` 以区分两种拒绝原因，匹配判定字节级不变。vitest 22/22（16 条既有 golden 全绿 + 6 条新用例）；RN typecheck 与对改动文件的 eslint 全绿。CLI 评估模式经 `expectedRanks` 拿到 1 起始完整名次。

### D05 Web 客户端

- [x] 修改 `frontend/src/components/ExerciseAiSearch.jsx`。开关固定为 `localStorage.getItem('opengym:ai-search-diagnostics') === '1'`，不可访问时按关闭处理。选择图片时生成 `mediaAttemptId`，从 `chooseImage` 记录耗时、输入字节和归一化成功或失败。给 `normalizeImageFile` 新增可选的摘要回调，在原 Canvas 步骤成功或失败时记录尺寸、字节和压缩轮数，函数仍返回原 Data URL。浏览器解码自行处理方向时省略 rotationApplied。
- [x] 在 `sendRequest` 只生成一次 requestId，将其当作 traceId，同时生成 per-run 诊断对象并随现有 `token` 传递给 `pollOnce` 和 `finishRun`。不要从全局可变 ref 取「当前 traceId」给已有回调。诊断对象记录开始时间、end 守卫和最新图片尝试 ID。最新媒体关联只驻留组件内存，随现有选图替换、取消草稿和 session 重置一起释放。重试建立新 trace，保留引用同一图片时的 mediaAttemptId。
- [x] `sendRequest` 发 submit。完成后由 `finishRun` 把 emit 传给 `createWebAiSearch(...).match`。提交和轮询错误、取消、离开和晚到响应路径保持现有序号守卫，并将能观察到的终态写入原请求的 trace。
- [x] 修改 `frontend/src/components/ExerciseAiSearch.test.jsx`。mock sink，覆盖服务端完成回包和客户端最终 ID trace 相同、重复 / 晚到轮询不误归属、两次提交 trace 不同、关开关零事件。测试完成后清理 localStorage，避免影响其他用例。

> **执行结果**（2026-11-22）：组件与测试落地，8 条新用例 + 19 条既有全绿（`ExerciseAiSearch.test.jsx` 27 条、`Library.test.jsx` 37 条）。`reopen`/卸载路径按规格只由 `cancelRound`/`exit` 发 end；`LIMIT_CODES` 重试先 resetSession，按规格释放媒体关联后省略 mediaAttemptId。

### D06 RN 客户端

- [x] 修改 `mobile-rn/src/agent/media.ts` 的 `normalizeAiImage`，新增一个可选媒体摘要回调，只在原实现的压缩、旋转分支累积元数据，不变更输出图像结构、文件清理或异常类型。
- [x] 修改 `mobile-rn/src/screens/ExerciseLibraryScreen.tsx`。在相机/相册入口创建 `mediaAttemptId`，调用 `normalizeAiImage` 时取摘要，记录权限拒绝、取消、成功和失败。仅在界面内存将尝试 ID 与选中图关联，传入 `runAiTurn`；禁止写入 SQLite 或改变图片行 schema。
- [x] 修改 `mobile-rn/src/agent/ai-search.ts`。给 `AiStartTurnInput` 增加可选 `mediaAttemptId`，给 `AiTurnStart` 增加 `traceId`。将 `createId('req', randomUUID)` 得到的 ID 同时用于日志和本机/服务端请求。通用诊断开关与 D03 相同；客户端 `source: "rn"`。提交异常在控制器用当前 trace 记录 end 后重新抛出。
- [x] 回到 `ExerciseLibraryScreen.tsx` 的 `runAiTurn`，在开始成功后绑定 `started.traceId`，随后完成匹配、轮询异常、取消和迟到回调均使用该运行对象。现有 `aiSeqRef` 守卫仍用于判断是否更新 UI。初次选图、追问历史路径未保留媒体 ID 时省略 mediaAttemptId。为重试和取消以渲染入口或设备 fixture 验证，禁止靠手工拼接日志来验收。

> **执行结果**（2026-11-22）：media.ts 摘要回调、控制器 `AiTurnStart { traceId, diagnostics }`、屏幕内存关联与 per-run 绑定全部落地；typecheck、对改动文件的 eslint、全量 `npm run lint` 全绿（仅 2 条仓库既有 warning）。`AiTurnDiagnostics.emit` 对 D04 的 `Record<string, unknown>` 槽位做了一次类型桥转换，运行时仍由 trace 逐字段校验。设备端轨迹复核项见 [eval/ACCEPTANCE.md](eval/ACCEPTANCE.md#待验项)。

### D07 评估清单与固定样本

- [x] 新增 `docs/ai-exercise-search/eval/manifest.json`。顶层只含 `schemaVersion: 1` 与 `samples`。样本字段固定为 `id`、`group`、`expectation`（match/empty）、`expectedIds`、`expectedEquipment`、`family`，以及按可用模式填写的 `image`、`hintText`、`replay`。replay 固定为 `{ path, index }`，index 从 0 开始。image 与 replay.path 均相对清单文件。样本 ID 必须唯一，expectedIds 和 expectedEquipment 必须是去重数组，match 必须有公开 ID 和至少一个器械，empty 的这两个数组均为空。ID 以字符串保留前导零。
- [x] 用当前 smoke 的五行按下表建立 `hinted-*` 样本，group 取 `hinted`。图片路径取 `../test_pic/` 加历史记录中的 photo，hintText 取记录的 hint，replay.path 指向 `../evidence/smoke-go-2026-11-21.json` 并填 index。再建五个 `photo-*` 样本，group 为 `photo-only`，复用图片和标签，省略 hintText、replay。下表是初始可接受集合，实施时逐条读实际目录核对，若证据矛盾，记录具体条目、理由并在改动中明确修正。

| 后缀 / 历史索引 | family | expectedEquipment | expectedIds |
|---|---|---|---|
| chest-press / 0 | chest-press | leverage machine | 0576, 0577 |
| leg-press / 1 | leg-press | sled machine | 2224, 0739, 1463, 1464 |
| leg-extension / 2 | leg-extension | leverage machine | 0585, 1873, 3386, 7108 |
| shoulder-press / 3 | shoulder-press | leverage machine | 0603, 1454, 0869, 2318, 2962 |
| hack-squat / 4 | hack-squat | sled machine | 0743, 1992 |

- [x] 新增 `docs/ai-exercise-search/eval/edge-responses.json`，与既有 smoke 使用相同的 `{ results: [{ structured }] }` 布局。在 manifest 增加 `edge` 分组条目，按顺序固定为：法语 `presse à pectoraux assise` + nameEn `lever chest press`，预期 0576/0577；`腿举` 无 nameEn，预期 2224/0739；`lever chest press` 同名候选，预期 0576/0577；无关照片描述返回空 candidates；不存在的器械名称 `orbital prism contraption`。最后两例 expectation 为 empty，family 分别为 unrelated 和 out-of-catalogue。所有带 candidate 的 fixture 设置 level=medium 和简短合成 rationale，fallback.understanding 填合成文本。评估首名错误而正确 ID 在后面的可重复断言由 D04 注入列表覆盖，避免猜测真实目录固定排名。

> **执行结果**（2026-11-22）：manifest 15 样本（hinted/photo-only/edge 各 5）与 edge-responses 5 条落地；17 个期望 ID 逐条对照 `frontend/src/lib/exercises-data.js` 全部存在且属于对应 family，器械 slug 在词表内，无需修正。JSON 解析与路径存在性检查通过。

### D08 CLI 入口和参数

- [x] 在 `frontend/package.json` 增加脚本 `"eval:ai-search": "node scripts/ai-search-eval.mjs"`。新增入口 `frontend/scripts/ai-search-eval.mjs`。使用 Node `util.parseArgs`，strict 模式，固定接受 `--mode replay|vision|e2e`（必填）、`--manifest`（必填）、`--out`（必填）、可重复的 `--sample` 与 `--group`、`--web-locale en|zh`（默认 zh）、`--include-queries`（默认 false）、`--save-replay <路径>`（仅 vision/e2e）、`--help`。同类选择取并集，两类选择取交集。未知 ID/group、无匹配或选定样本不支持当前模式时报使用错误；没显式选择时按模式跳过不适用项并写入 skippedIds。
- [x] npm script 的相对路径基于 `process.env.INIT_CWD ?? process.cwd()`，不能基于 npm 切换后的 frontend cwd。清单内部路径基于 manifest 文件目录。输入输出路径不得重合，也不得覆盖任何图片、清单或已提交的 fixture。out 先写同目录临时文件后 rename。只在 stdout 输出报告路径和计数，不打印异常对象或 JSON 原文。
- [x] 入口以 `try/finally` 关闭 Vite server；退出码固定为 0（运行成功，即使命中低）、1（报告已写，有样本错误）、2（参数、清单、配置或整体执行／写入失败）。错误输出只用固定说明及安全错误码。真实模型模式发现缺配置时在任何样本发请求前退出 2。

> **执行结果**（2026-11-22）：入口按规格落地并导出 `runCli(argv, { env, modelRunner, adapters })` 注入缝供 D12 使用。`--help` 退出 0；`--mode bogus`、坏 `--web-locale`、未知样本/组、空交集、out 与输入重合、replay 带 `--save-replay` 均退出 2；缺 provider 配置在任何请求前退出 2。

### D09 CLI 加载实际 Web / RN 适配器

- [x] 新增 `frontend/scripts/ai-search-eval-adapters.mjs`，导出 `openEvaluationAdapters({ webLocale })`，返回 `{ web, rn, publicEquipmentById, close }`。固定使用现有 `vite.createServer`，配置 `root` 为仓库绝对路径、`configFile: false`、`server.middlewareMode: true`、`server.ws: false`、`appType: "custom"`、`optimizeDeps.noDiscovery: true`、`server.fs.allow` 仅包含仓库根路径。只调用 `ssrLoadModule`，不调用 listen。加载途中失败也关闭 server。
- [x] 通过同一 SSR loader 导入 `/frontend/src/lib/i18n-core.js`、`/frontend/src/lib/exercises.js`、`/mobile-rn/src/librarySearch.ts` 和 D04 创建的 `/mobile-rn/src/agent/ai-search-matcher.ts`，Web 中文额外导入 `/frontend/src/locales/zh.js`、`/frontend/src/exercise-names/zh.js`。调用 `_setLangState(webLocale, dict, null, names, true, false)`；en 下 dict 为 {}、names 为 null。Web 用 `createWebAiSearch({})`，RN 用 `matcherFor(createLibrarySearch({ unit: "kg", favEx: [] }))`。publicEquipmentById 用 Web 导出的 CATALOGUE 建立，不扫描原始目录重新实现适配逻辑。
- [x] 先用 D14 的离线命令验证这四个模块确实从当前仓库加载，并验证 Node 退出后没有监听进程。若 SSR 导入出现资源路径错误，在这个文件修正 Vite 路径与加载配置并复跑。不要将 Vite 替换成其他构建器，不加新依赖，不伪造目录。若依赖自身阻断，保留输出并报告具体包和错误。

> **执行结果**（2026-11-22）：适配器按规格落地，root 从 `import.meta.url` 推导（不依赖 cwd）；zh 加载 `export default` 的词典与动作名包并注入 `_setLangState`。D14 的 replay 双端 10/10 证明四个真实模块均从当前仓库加载；进程由 `try/finally` 关闭，无监听残留。

### D10 CLI 加载样本与调用模型

- [x] 新增 `frontend/scripts/ai-search-eval-input.mjs`，导出 `loadEvaluationManifest(path)`、`loadReplay(sample)`、`loadModelInput(sample)`。清单仅校验约定字段。replay 读取 `results[index].structured` 并用 `isExerciseSearchOutput` 验证，无效则记样本错误，不在 replay 自动清洗或请求模型。image 只接受 .jpg/.jpeg/.png/.webp，先用 stat 限制 1 MiB，再读文件字节并组合 Data URL；内容、尺寸、宽高比由共享任务验证。禁止输出图片路径或文件名到日志和报告。图片不能通过校验时记录 attachments 阶段错误。
- [x] `frontend/scripts/ai-search-eval-model.mjs` 读取 `OPEN_GYM_EVAL_PROVIDER`（`fixture`、`openai`、`compatible` 或 `deepseek`）、`OPEN_GYM_EVAL_MODEL`、`OPEN_GYM_EVAL_BASE_URL` 和 `OPEN_GYM_EVAL_API_KEY`。DeepSeek 预设使用官方端点，密钥也可从 `DEEPSEEK_API_KEY` 读取。兼容提供商要求显式端点。fixture 仅使用本地样例。临时配置保存在本次进程内存。
- [x] 用共享 index 导出的 `createProvider`、`createModelGateway`、`createExerciseSearchTask`、`bindContext`、`runAgent` 直接编排。固定本地评估 scope `ai-search-eval`、profileId `eval`、execution `local`；用 Node randomUUID 生成合法的 requestId/runId；声明 text/image 能力。调用使用现有 provider 的超时；使用 `bindContext.meta.exerciseSearchDiagnostic` 采集模型阶段事件。fixture 默认使用任务自带 candidates；测试坏模型输出时注入一个记录调用次数的 fixture gateway，不能使用真实外部请求。entry 在 e2e 模式只调用一次 model runner，取同一 `result.structured` 给两端 matcher。

> **执行结果**（2026-11-22）：三个文件按规格落地；model runner 额外接受 `{ provider?, gateway? }` 注入缝供 D12 计数断言，不改变 CLI 行为。fixture 冒烟与 D14 真实模型运行均按此编排；`createId('req'/'run', randomUUID)` 保证合法请求 ID。

### D11 CLI 执行与报告

- [x] 新增 `frontend/scripts/ai-search-eval-report.mjs`，导出 `evaluatePlatform({ matcher, structured, sample, includeQueries, publicEquipmentById })`、`summarizeEvaluation(rows)`。evaluatePlatform 用现有 `matcher.match` 并传 D04 diagnostics，与原结果同时记录 `recall`、`filter`、`display`。单一平台异常记 match 阶段失败，另一个端继续。
- [x] 报告固定顶层 `schemaVersion`、`mode`、`gitCommit`、`webLocale`、`skippedIds`、`samples`、`summary`。读取 git commit 使用固定参数调用 `git rev-parse HEAD`，失败记 null；增加 `catalogueSha256`，以两端共享的 `frontend/src/lib/exercises-data.js` 内容计算。每条样本含 id/group/family/expectation、`recognition`、`platforms: {web?,rn?}` 和可选 `error: { phase, code }`。recognition 默认仅记录阶段计数、白名单器械/部位和耗时，`familyAssessment` 固定为 `unreviewed`，不计算虚假的模型识别正确率。
- [x] 每个成功平台包含 `recall`、`filter`、`finalIds`、`fallbackOnly`、`elapsedMs`、`firstExpectedRank`（跨所有查询的最小原始名次）和 `wrongEquipment`（仅 match 正例有最终首名，且不在 expectedEquipment 中）。按平台和 group 聚合，输出指标的 `numerator` 与 `denominator`；无分母的值为 null。Top 1 / Top 5 / recall@5 分母均为已成功匹配的 match 正例；错器械分母为这批正例中有首名的；误报分母为成功匹配的 empty 样本；兜底分母为全部成功匹配；执行失败单列。延迟用 nearest-rank 计算 p50/p95，vision 与 matcher 延迟分别聚合。
- [x] 在 D08 入口实现串行主循环。vision 不加载 matcher，仍校验正例 ID 能关联目录时可只加载 Web 目录元数据；replay 不创建 provider。e2e 调用一次模型、两次 matcher。只在 `--save-replay` 显式指定时写独立 `{ results: [{ id, structured }] }` 文件；失败样本保留行并写安全错误，禁止默认保存模型自由文本。允许保存的评估文件限本地受控输入，不提交生成文件。

> **执行结果**（2026-11-22）：报告字段与分母按规格落地；`summary.byGroup` 内按平台分块保持每个指标可归因；vision 延迟（模型阶段）与平台匹配延迟在 `summary.visionLatency` 与各平台块分别聚合。replay 10/10、fixture e2e 5/5、真实 e2e 双端一致，报告均不含图片路径或模型自由文本。

### D12 CLI 自动化验证

- [x] 新增 `frontend/scripts/ai-search-eval.test.mjs`，使用 `node:test`。子进程启动 CLI 验证 replay 的两端报告、重复回放名次、非法参数退出 2、显式路径经 npm prefix 正确解析。临时文件放系统 temp 并清理。
- [x] 同一测试文件用 fixture 跑 vision/e2e，校验有效图、非法图、失败后下一样本继续、报告稳定退出码和回复可回放。单独注入模型调用计数断言 e2e 每一有效样本调用一次。用合成敏感词、私人 ID 和 Data URL 验证默认 JSON 报告、stdout/stderr、运行日志均不出现这些值。受控查询只在 include-queries 时出现。
- [x] 在 `frontend/package.json` 增加 `"test:ai-search-eval": "node --test scripts/ai-search-eval.test.mjs"`。已有 Vitest 命令维持不变；新增测试文件在 scripts 下，由 Node 命令执行，若 Vitest 默认收进这一个文件，用现有配置增补对此路径的精确排除。

> **执行结果**（2026-11-22）：8/8 通过（约 54s；4 次子进程 + 7 次进程内注入运行，临时目录零残留）。实证 vitest 默认 include 会收编该 node:test 文件（`vitest run scripts/ai-search-eval.test.mjs` 报 No test suite found），已按规格在 `vite.config.js` 用 `configDefaults.exclude` + 精确路径排除，`vitest list` 确认其余 scripts 测试不受影响。

### D13 文档与索引

- [x] 新增 `docs/ai-exercise-search/eval/README.md`。复述实际支持的参数、日志开关、退出码、样本标签和指标分母，给出三种 PowerShell 模式和 fixture 命令。列出服务端 stdout、浏览器控制台、RN 日志如何按 traceId 查询。明确 Vite 必须安装 frontend 依赖，CLI 输入照片是已归一化附件。
- [x] 修改根 `AGENTS.md` 的 `docs/ai-exercise-search/`、`frontend/` 文件地图，补上 eval 清单、runbook 和 CLI 入口；修改 `docs/README.md` 的 AI exercise search 行，在执行文档之外加 runbook 链接。更新本文件各 D 项执行结果，保留错误或待验说明。

> **执行结果**（2026-11-22）：runbook、根 AGENTS.md（代码地图 + 文档地图）、docs/README.md 链接与本文件 D 项结果全部更新；另按 `.claude/` 等先例把 `.codex/`（评估报告产物目录）加入 `.gitignore`。

### D14 固定验收顺序与产物

- [x] 从仓库根路径执行下面的 PowerShell。第一条仅在该工作树尚未装 frontend 依赖时执行。完成后逐条检查退出码，构建前先确认工作树没有他人改动。离线回放报告落 `.codex/ai-search-eval/replay.json`，fixture 整链路落 `fixture-e2e.json`。真实模型只使用已授权的配置和受控照片。
- [x] 先检查 replay 有两端结果，验证带提示样本与 edge 指标分开。用 D04 固定用例验 A2。然后验证 fixture 视觉与整链路、真实视觉与整链路、三条应用运行路径的 trace，最后补隐私断言和构建检查。验收记录用 A1–A7 编号写到 `docs/ai-exercise-search/eval/ACCEPTANCE.md`，每行包括命令、退出码、结果摘要和报告相对路径；真实模型或设备缺失按待验记录。

> **执行结果**（2026-11-22）：矩阵 14 条命令全部退出 0（见 [eval/ACCEPTANCE.md](eval/ACCEPTANCE.md)）。frontend 依赖已装故跳过 `npm ci`。A1/A2/A3/A4/A5/A6/A7 通过：A5 的 Web 服务端路径完成双进程实跑（浏览器控制台 web 事件与 API 进程 stdout 的 api 事件按同一 traceId 拼接，fixture 配置）；RN 设备端轨迹按待验记录。实跑另发现一个 dev-only 的既有 StrictMode 问题（非本任务回归，见验收记录「实跑观察」）。

```powershell
npm.cmd --prefix frontend ci
npm.cmd --prefix frontend run test:ai-search-eval
npm.cmd --prefix frontend run eval:ai-search -- --mode replay --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/replay.json
$env:OPEN_GYM_EVAL_PROVIDER = 'fixture'
npm.cmd --prefix frontend run eval:ai-search -- --mode e2e --group photo-only --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/fixture-e2e.json
Remove-Item Env:OPEN_GYM_EVAL_PROVIDER
node --test api/test/exercise-search-diagnostics.test.js api/test/agent-runtime.test.js api/test/agent-exercise-search.test.js
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx
npm.cmd --prefix frontend run build
npm.cmd --prefix mobile-rn run check
npm.cmd --prefix api run build
git diff --check
```

取得已授权真实模型配置后，从根目录执行以下两条。第一个文件用于验证视觉模式可独立运行，第二个同时比较同一器械的纯图与带提示版本。

```powershell
npm.cmd --prefix frontend run eval:ai-search -- --mode vision --sample photo-chest-press --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/real-vision.json
npm.cmd --prefix frontend run eval:ai-search -- --mode e2e --sample photo-chest-press --sample hinted-chest-press --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/real-e2e.json
```

轨迹验收时服务端进程设 `AGENT_EXERCISE_SEARCH_DIAGNOSTICS=1`。Web 控制台执行 `localStorage.setItem('opengym:ai-search-diagnostics', '1')`，RN 在启动 Metro 或构建包前设 `EXPO_PUBLIC_AGENT_EXERCISE_SEARCH_DIAGNOSTICS=1`。对照提交、附件、模型、召回、筛选、展示和结束，记录同一 trace 的安全摘要。关闭 Web 开关用 `localStorage.removeItem('opengym:ai-search-diagnostics')`，服务端/RN 去掉环境变量后重启或重建。

> **历史执行结果**（2026-11-22）：两条真实模型命令使用当时的识别服务完成。报告见 `.codex/ai-search-eval/real-vision.json` 与 `real-e2e.json`。服务端轨迹冒烟和 Web 双进程同 traceId 实跑已完成。RN 设备端轨迹见当时的待验记录。当前接入参考 [评估 CLI](eval/README.md)。

## 验收清单

| 编号 | 操作 | 通过标准 |
|---|---|---|
| A1 | 断网或禁止出站，执行 replay | 无客户端界面、无密钥、无网络。两个平台均生成结果，报告含完整候选阶段。连续两次的排名和判定一致，随机 ID 和时间字段除外 |
| A2 | 回放一个已知目标在原始第二名或更后且最终未出现的案例，再回放一个零召回样本 | 报告分别显示目标原始名次及最终缺失、和零命中。可区分首名被拒的样本。启用日志前后业务输出相同 |
| A3 | 用 fixture provider 执行 vision / e2e，加入坏图、模型错误和有效图 | 有效图每样本调用一次模型。整链路报告同时有 Web / RN 结果。坏图不调用模型，模型错误只记录安全错误码，批运行继续并正确退出 |
| A4 | 对同一受控照片分别以纯图和带提示执行真实模型 e2e | 自动得到附件、模型、两端候选报告，分组独立，保存结果 ID。无已授权凭据时仅记录真实模型待验，fixture 通过不替代真实验收 |
| A5 | 用自动化或现有 fixture 流程分别触发 Web 服务端、RN 本机和 RN 配对服务端 | 每条实际请求能按同一个 traceId 查到提交、模型和最终匹配结果。坏图、重试和取消状态可定位，迟到响应不会串到新 trace |
| A6 | 用合成敏感文本、合成自建动作 ID、包含图片字段的输入和模拟 provider 异常进行隐私断言 | 生产日志无原文、图片正文、路径、alias、密钥、账号和自建 ID。关闭开关时不产生日志 |
| A7 | 跑当前 matcher golden、Web AI 组件、RN 搜索适配测试、共享任务测试，以及 RN 静态检查和 API 构建 | 不改变基线匹配结果和会话行为。新增失败不得标记为已通过，既有失败须附基线证据 |

逐项证据与退出码见 [eval/ACCEPTANCE.md](eval/ACCEPTANCE.md)。
