# AI 器械检索效果优化执行文档

状态：待执行。基线为 `cef3bafb3` 的检索行为。先核对实际 HEAD，按根目录 AGENTS.md 和 opengym-development 技能在独立工作树执行。只保留通过对照的改动。部署日常仍使用现有模型、Harness 和目录，不增加工具调用、模型回合、向量库或新依赖。

## 背景与优化顺序

同一台坐姿杠杆推胸，标注接受 ID 为 `0576`、`0577`。第一次真实测评中，两项都没有进入原始召回。第二次模型认出坐姿杠杆推胸，但没有在单条候选填器械字段。英文通用查询把两个正确 ID 排到第 2 和第 3；匹配器只取第 1。低置信上斜推胸因为查询词更多、原始关键词分更高而成为最终首位。

对照分四次，每次只改一个变量：**P1 提示词 → M1 每条查询保留 Top 5 → M2 最终排序 → Q1 仅零目标族召回时的查询扩展实验**。按下文定义的条件决定保留或回退。M1 和 M2 即使提示词有效也要用旧结构化输出离线检验。Q1 只有前面通过的版本仍存在可复现的漏召回才做，禁止把几项改动合在一次实验中比较。

## 凭据与运行方式

当前 CLI 从进程环境读配置，`api/.env` 确实存在且已被 Git 忽略。可以在本机工作区的 `api/.env` 固定写下这些值，保留文件里已有的配置。历史使用 OpenCode Go 时可复用同文件中现成的 `OPENCODE_API_KEY`，无需重复写密钥。每个 Git worktree 的未跟踪文件彼此独立，下方命令从任意执行工作树显式读取主工作区的密钥文件。

```dotenv
# 兼容 API 示例。另两种配置见下文。
OPEN_GYM_EVAL_PROVIDER=compatible
OPEN_GYM_EVAL_BASE_URL=https://your-provider.example/v1
OPEN_GYM_EVAL_MODEL=your-vision-model
OPEN_GYM_EVAL_API_KEY=your-key
```

- OpenCode Go：provider 填 `opencode`，模型填当前获授权的视觉模型 ID，例如此前的 `deepseek-v4.1-flash`。端点固定，可省略 BASE_URL 和 EVAL_API_KEY，改用已有 `OPENCODE_API_KEY`。
- OpenAI 官方：provider 填 `openai`，设置支持图像输入的模型与 EVAL_API_KEY，省略 BASE_URL。兼容 API 的 Base URL 不含 `/chat/completions`。
- Node 24 支持 `--env-file`。进程中已有同名环境变量优先于文件；正式对照前用新 PowerShell 窗口，避免拿到上次配置。不要把密钥写进命令行、样本、报告或版本库，不读取或打印整份 env。离线回放不加载密钥文件。

```powershell
Set-Location 'D:\dev\open-gym'
node --env-file=api/.env frontend/scripts/ai-search-eval.mjs --mode e2e --sample photo-chest-press --sample hinted-chest-press --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/check.json
```

## 执行 TODO

每项完成后在本文件末尾记录 commit、命令、退出码和对照报告路径。失败实验记结果，不把改动留在最终分支。无真实模型授权或样本时标待验，不用 fixture 冒充真实效果。

### T0 固定评估输入与环境

- [ ] 在主工作区执行 `git status --short`、`git rev-parse HEAD`、`git check-ignore api/.env`、`node --version`。确认 `api/.env` 已忽略。建立独立工作树。若文档尚未提交，可从主工作区读文档，实施仍以独立工作树为 cwd。
- [ ] 在独立工作树装 frontend 依赖。下文所有命令在此目录执行；若安装失败，记录原因，不修改锁文件解决环境问题。

```powershell
git worktree add -b codex/ai-search-quality D:/dev/open-gym-ai-search-quality HEAD
Set-Location 'D:\dev\open-gym-ai-search-quality'
npm.cmd --prefix frontend ci
$evalManifest = 'docs/ai-exercise-search/eval/manifest.json'
$evalDir = '.codex/ai-search-eval/quality'
$evalEnvFile = 'D:/dev/open-gym/api/.env'
```

- [ ] 新增 `docs/ai-exercise-search/eval/quality-replay.json`，布局为 `{ "results": [{ "structured": ... }] }`。固定三类案例。头两项从主工作区 `.codex/ai-search-eval/my-model-chest-replay.json` 按 sample ID 提取 `hinted-chest-press`、`photo-chest-press`；只保留候选名、英文名、等级、合法器械/部位枚举，理由与 understanding 换成合成简述。第三项构造「零目标召回」样本：单候选 `name: "seated machine chest press"`、`level: "high"`、合法 rationale，fallback 给 `leverage machine` 和 `chest`，省略候选级器械。不要将第三项称为第一次模型回放，第一次没有保存查询原文。零召回样本以实际基线报告确认为准。
- [ ] 修改 `docs/ai-exercise-search/eval/manifest.json`，新增 group `quality-regression` 的三个 replay-only 样本，ID 顺序为 `quality-hinted-chest`、`quality-photo-chest`、`quality-no-recall-chest`，expectedIds 固定 `["0576","0577"]`，expectedEquipment 固定 `["leverage machine"]`，family 为 `chest-press`。现有样本和标签保留。找不到本地回放时记录缺失，请用户提供已有受控回放；不可编造前两项为真实模型输出。
- [ ] 从 `frontend/scripts/ai-search-eval-report.mjs` 核对指标字段，固定下文比较方式。对照按平台及 sample ID 匹配。出现任一样本错误、输入集合不一致、重复遗漏或两组目录哈希变化，判为无效对照。使用同一工作树和同一目录版本；报告文件每次写不同路径。

### T1 建基线

- [ ] 运行全量离线回放，包含项目现有样本和 T0 新样本。检查两个真实回放在 Web/RN 都出现目标原始第 2/3，最终没有目标；低置信 `1299` 在首位。检查第三例目标未召回。若不同，先对照旧报告和工作树版本，记录变化，按实际基线重新定位。

```powershell
node frontend/scripts/ai-search-eval.mjs --mode replay --manifest $evalManifest --include-queries --out "$evalDir/baseline-replay.json"
```

- [ ] 建真实 A 组。使用相同 endpoint、模型、已知图片、样本提示、locale 与目录，跑 3 次，每次包含原清单全部纯图和带提示样本。保存报告与结构化回放。每次执行退出非零时停止该组，修复配置或按本阶段规则重跑同一组；保留前次错误证据。统计时以 5 张图为 5 个独立场景，重复调用用于观察波动。

```powershell
foreach ($rep in 1..3) {
  node "--env-file=$evalEnvFile" frontend/scripts/ai-search-eval.mjs --mode e2e --group photo-only --group hinted --manifest $evalManifest --include-queries --save-replay "$evalDir/prompt-a-$rep-replay.json" --out "$evalDir/prompt-a-$rep.json"
  if ($LASTEXITCODE -ne 0) { throw "Prompt A run $rep failed" }
}
```

- [ ] 在 `docs/ai-exercise-search/eval/QUALITY_RESULTS.md` 建对照表。每阶段每端填 Top 1／Top 5／recall@5、错器械、空结果误报、兜底和 P50/P95，并按纯图与带提示拆分。针对推胸另外记录 expectedRanks、最终 ID、是否 `1299` 在首位。Top 5 的真值来自 manifest，控制台 `matched` 只表示完成匹配。写下 API provider、模型 ID 与运行次数，省略密钥、请求正文和私有路径。

### T2 P1 只改系统 Prompt

- [ ] 只修改 `api/agent-runtime/tasks/exercise-search.js` 中 `PROMPT` 的第 5、6 条和 `## Names`。不改 schema、provider、清洗逻辑或 matcher。
  1. 第 5 条分别写明 `candidate.equipment` 与 `candidate.bodyPart` 是单数 slug，`fallback.equipment` 与 `fallback.bodyParts` 是数组。有可见或用户明确说明的器械／部位时，**每条对应候选都填**。没有明确证据才省略，兜底字段不能代替候选字段。
  2. 第 6 条保留置信等级和最多 5 项；加约束：看不清角度、握法、单双侧时，优先给更通用的动作，省略缺证据变体；宁可只返回 1 条。识别多功能器械时只给合理且有依据的可能动作。
  3. Names 写明 English lookup name 用简短的目录式 `设备前缀 + 核心动作名`。列 `lever chest press`、`sled leg press`、`cable row` 三例；在器械类型明确时，用前缀 `lever`、`sled`、`cable`，避免把泛称 `machine`、`plate-loaded` 当成检索必带修饰词。角度和姿势仅在它们可辨且是动作区分条件时写进英文名。非英文 name 提供 nameEn。ID 禁止猜测保持原样。
- [ ] 除该文件外确认生产代码无改动，按 T1 同一命令只把输出的 `prompt-a-` 替换为 `prompt-b-`，运行相同 3 次。先比较原始结构化回放中 high/medium 候选的 equipment 填充率，以及推胸结果里无充分证据的上斜候选比例，再看实际召回和最终命中。人工判断有无视觉证据时看同一原图及用户提示，不凭模型置信度倒推。
- [ ] **保留门槛**：两个端各自整体 Top 5 均不得下降；纯图、带提示任一组都不得下降；至少一组的 recall@5 或 Top 5 提升，且其改善在 3 对重复中至少出现 2 对；错器械率不得升高。若只是字段填得更满、对照收益不稳定，回退 Prompt 改动。真实对照缺失时不发布 Prompt 改动。

### T3 M1 仅改首名截断

- [ ] 修改 `frontend/src/lib/exercise-ai-search.js` 的 `matchOne` 与 `createExerciseAiSearch().match`。固定关键词候选预算为各查询前 5 项，按查询顺序收集；同一 ID 在双语查询重复时保留原分较高项，平分沿用原查询顺序。每个候选执行原有名称证据、BASE_FLOOR 与硬器械冲突规则，允许首项被拒后审查后续项。保留 CJK 回退策略：按原判定条件得到 CJK 候选时纳入一次且保持原低置信度，校验和展示沿用原行为。单项判断移到同文件的私有辅助函数，外层按 ID 合并，最终最多 5 项。本阶段保持原有全局计分与排序方式，便于单独测 Top K 增量。
- [ ] 调整同文件 filter 事件，让筛选记录能说明同一 candidateIndex 下哪些公共 ID 被接受或拒绝；保持既有事件字段与错误码，检查共享诊断模块是否有把 per-query 事件错误截断为 1 条。生产日志继续不记录查询原文。现有显示等级、badge 和交互不变。
- [ ] 修改 `frontend/src/lib/exercise-ai-search.test.js`。补测试：第一项冲突而第二项通过、0576/0577 位于第 2/3、双语 ID 去重、exact match 优先不退化、仍最多 5 项、CJK 歧义不被放宽、无关名称不给结果。现有 golden 失败时逐例核对，不用批量更新期望值消除失败。
- [ ] 对 T1 相同固定清单跑下方命令。**保留门槛**：Web/RN 的两个真实回放样本都至少有一个目标进入 Top 5，既有正例 Top 1/Top 5 不丢命中，预期空样本不新增误报，不新增错器械首位。逐样本核对，可接受 ID 或金标只有目录证据支持时才修改并用新标签重跑两侧。

```powershell
node frontend/scripts/ai-search-eval.mjs --mode replay --manifest $evalManifest --include-queries --out "$evalDir/m1-replay.json"
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts
```

### T4 M2 仅改跨查询排序

- [ ] 修改 `frontend/src/lib/exercise-ai-search.js`。增加内部排序元数据 `modelLevel`、`exact`、`equipmentMatch`、`bodyPartMatch`、`queryRank`、`candidateIndex`。强制通过现有冲突校验才可排序；不改变各查询召回或展示等级。按以下键顺序比较：来源可靠性（CJK 近似回退放在普通通过结果之后）、模型等级 high > medium > low、精确名／别名、器械一致、部位一致、无证据变体数升序、模型候选顺序、查询内名次、名称、ID。无证据变体仅在当前推胸族用下列显式词表判定：inner、outdoor、incline、decline、single arm、one arm。只在目录英文名含该短语、该模型候选的名称与英文名均不含该短语时计 1；英文匹配忽略大小写和连字符。此项用于区分通用杠杆推胸与未被查询支持的内侧或户外变体。器械提示优先取候选 equipment，无候选器械且 fallback 只有一个已知器械时，作为排序弱提示使用；多器械 fallback 不加推断。跨查询不直接比较关键词原始分。在按 ID 合并时用同一 comparator 选保留项，保留现有 rationale 和等级合并，最后从 UI 投影移除新增内部字段。
- [ ] 在上述 matcher 测试中加入「high 三词、low 四词得分更高」「同级候选中精确匹配与器械相容区分」「低置信精确变体不能盖过高置信有名称证据的匹配」「无候选器械时单值 fallback 和多值 fallback」用例。重跑同一清单输出 `m2-replay.json`。与进入本阶段前的已保留版本比，**两个真实回放样本的 Top 1 命中数至少上升 1 个／端，且 `1299` 不得排在任何命中的高置信推胸之前**；两端既有样本不得丢 Top 1/Top 5，不新增空样本误报或错器械。M1 没通过时，M2 从当前已接受版本独立验证；收益不满足即回退。

```powershell
node frontend/scripts/ai-search-eval.mjs --mode replay --manifest $evalManifest --include-queries --out "$evalDir/m2-replay.json"
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts
```

### T5 Q1 有残留漏召回才实验

- [ ] 用最后保留的 P1 设置和 matcher 重跑 T1 的 3 次真实命令，产物前缀改为 `q1-control-`。按同一 sample ID 比对这组报告。只有在 3 次真实调用中至少 2 次出现正例正确 ID 完全不在原始召回，且人工复核模型确实认对动作族和器械，才执行 Q1。单独的构造样本用于回归，不能单凭它决定上线。若不满足，把本阶段记为「未触发」。
- [ ] 在 `frontend/src/lib/exercise-ai-search.js` 实验一个受限改写：只处理照片回放中已证实的 **杠杆推胸**。当某条候选为 high/medium、英文名完整包含核心短语 `chest press`、没有 `incline/decline/single/one arm` 等明确变体，并且候选级器械为 `leverage machine` 或候选缺器械且 fallback 唯一器械值为 `leverage machine` 时，允许补查 `lever chest press`。原查询保持，若已提供相同英文名则不重复；若原查询前五已有同器械且英文目录名精确为 `lever chest press` 则不补查。每次匹配最多补查一次。用原 matcher 校验与排序。避免对所有动作做无证据的同义扩展。
- [ ] 如保留改写，在 `api/agent-runtime/exercise-search-diagnostics.js` 和同名 `.d.ts`、`frontend/scripts/ai-search-eval-report.mjs` 补 `queryOrigin: "rewrite"` 的枚举投影和对应测试，继续仅在 CLI 显式 `--include-queries` 时记录查询文本。在 matcher 测试加触发、明确变体不触发、无器械不触发、最多一次的用例。全量离线报告写 `q1-replay.json`。
- [ ] **保留门槛**：之前触发本阶段的真实漏召回样本，将这组 `q1-control-*-replay.json` 的结构化对象按样本和重复编号建立临时 replay 清单，清单放现有 manifest 同目录并保持相同 expectedIds 和 expectedEquipment。在 T5 代码改动前用现有 matcher 运行并保存 `q1-paired-before.json`，再用改写后的 matcher 和同一清单运行并保存 `q1-paired-after.json`，比较前后，至少 2 次在两端新增目标 recall@5 和最终 Top 5 命中；构造的零召回样本也应至少一个目标进入 Top 5。其他样本无 Top 1/Top 5、错器械或空图误报回归。否则回退 Q1。

### T6 最终验证并交付

- [ ] 最终配置跑全量离线回放，写 `final-replay.json`。跑 frontend matcher、RN 适配、CLI 和共享任务相关测试，检查 diagnostics 和 CLI 仍能输出原有基线字段。用与 T1 相同的 PowerShell 真实命令，输出前缀改为 `final-`。这组用于验证累计效果及纯图，不更换模型、样本标签或目录。
- [ ] 逐项核对：至少一个目标指标在对照中稳定改善，原有离线正例无丢失，原有预期空样本未增加错误结果，模型调用数不变。对低样本量结论只描述实测样本。阶段内出现任何负回归，应去掉造成回归的阶段，再重跑最终对照。禁止用整体平均掩盖单端或纯图退化。
- [ ] 在 `QUALITY_RESULTS.md` 写基线与各候选阶段矩阵、保留/排除判定、报告路径、模型配置来源及已知局限。只提交去敏后的固定样本、代码、测试和摘要。将 T5 临时清单移除或保留在本地忽略目录中，不提交。原始报告与密钥留在本地忽略目录。给出所保留阶段的独立 commit，便于逐个回退。更新 `AGENTS.md` 和 `docs/README.md` 指向结果记录。

```powershell
node frontend/scripts/ai-search-eval.mjs --mode replay --manifest $evalManifest --include-queries --out "$evalDir/final-replay.json"
npm.cmd --prefix frontend run test:ai-search-eval
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx
node --test api/test/exercise-search-diagnostics.test.js api/test/agent-runtime.test.js api/test/agent-exercise-search.test.js
npm.cmd --prefix frontend run build
npm.cmd --prefix mobile-rn run check
npm.cmd --prefix api run build
git diff --check
```

## 执行记录

| 阶段 | 状态 | 基线／对照 | 判定和证据 |
|---|---|---|---|
| T0/T1 | 待执行 | — | — |
| P1 | 待执行 | — | — |
| M1 | 待执行 | — | — |
| M2 | 待执行 | — | — |
| Q1 | 待判定是否触发 | — | — |
| T6 | 待执行 | — | — |

