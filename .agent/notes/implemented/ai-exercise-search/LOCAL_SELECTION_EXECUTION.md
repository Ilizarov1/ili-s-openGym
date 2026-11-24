# AI 动作检索查询内 Top 3 选优执行文档

状态：待执行。目标是在固定模型响应下，用最小的 matcher 改动救回已经排在原始第 2–3 名的正确动作。执行者按 T0–T6 顺序勾选，并把每次运行的退出码、commit 和报告路径记到同目录 `eval/LOCAL_SELECTION_RESULTS.md`。

## 背景和范围

P1 提示词单独版本为 `e53e6667e`。用 135 条固定响应对比 P1 与 P1+M1 后，两端各有 133 条正例，其中 44 条最终 Top 5 未命中，26 条的正确 ID 原始排名在第 2–3。M1 遇到首名已经通过时停止，原始推胸两例的 `1301` 内侧推胸就属于这种情况。正确的 `0576`、`0577` 已召回，但没有进入最终列表。两版各端 Top 5 同为 89/133。原始 A/B 证据保存在 `D:/dev/open-gym-ai-search-quality/docs/ai-exercise-search/eval/QUALITY_RESULTS.md` 的「固定模型响应的 P1 与 P1+M1」小节。

生产代码只改 `frontend/src/lib/exercise-ai-search.js`。每条查询最多审查 **原始前 3 项**，只选 **1 项**。同一个模型候选的查询仍按现有原始分择优，模型候选之间沿用现有加分、去重、排序和最终 Top 5 上限。P1 提示词、模型、Harness、原始召回、查询数量、普通关键词搜索、CLI 和日志 schema 继续沿用现状。不改 Web/RN 页面或目录。跨查询排序、自动改写和真实模型补跑由后续独立任务处理。此次可以出现正确平推进入 Top 5 而低置信上斜仍排第一，单独记录该现象。

## T0 固定基线和输入

- [ ] 从 `D:/dev/open-gym` 执行下列命令。当前主分支是否已合入提示词不影响本次对照，基线固定为 `e53e6667e`，不能从带 M1 的 `d0872a38e` 开工。该 worktree 专用于本轮；只复制本执行文档供记录，主工作区其余未提交改动不带入实验分支。分支或路径已存在时先核对归属与状态，不覆盖现有工作。
- [ ] 确认共享的 135 条回放清单及其引用的响应文件仍在。该清单含 13 条已有回放、12 批各 10 条冻结的真实响应，以及 `original-chest` 组的两个原始样本。清单引用的目录和报告路径继续指向既有工作区，完成验收前保留这些本地文件。若清单或原始回放丢失，先恢复同一批已有响应；不以新的模型响应替代，也不缩小分母后沿用历史结论。
- [ ] 安装依赖、运行基线。全程只使用 `--mode replay`，无需 `.env` 或 API Key。录入报告的 `gitCommit`、`catalogueSha256`、`webLocale`、样本 ID 和 `skippedIds`。预期 135 样本、零跳过、零错误、两个平台都有结果。预期两端各 133 条正例，Web Top 1 为 46／133、RN 为 50／133，两端 Top 5 均为 89／133。若与已存报告差异超出耗时，先定位目录、输入或基线差异。

```powershell
Set-Location 'D:\dev\open-gym'
git status --short
git worktree add -b codex/ai-search-top3 D:/dev/open-gym-ai-search-top3 e53e6667e
if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed' }
Set-Location 'D:\dev\open-gym-ai-search-top3'
Copy-Item -LiteralPath 'D:/dev/open-gym/docs/ai-exercise-search/LOCAL_SELECTION_EXECUTION.md' -Destination 'docs/ai-exercise-search/LOCAL_SELECTION_EXECUTION.md'
$evalManifest = 'D:/dev/open-gym-ai-search-quality/.codex/ai-search-eval/quality/p1-m1-paired-manifest.json'
$evalOut = '.codex/ai-search-eval/top3'
if (-not (Test-Path -LiteralPath $evalManifest)) { throw 'Frozen replay manifest missing' }
npm.cmd --prefix frontend ci
if ($LASTEXITCODE -ne 0) { throw 'Frontend install failed' }
npm.cmd --prefix mobile-rn ci
if ($LASTEXITCODE -ne 0) { throw 'RN install failed' }
node frontend/scripts/ai-search-eval.mjs --mode replay --manifest $evalManifest --web-locale zh --include-queries --out "$evalOut/a-p1.json"
if ($LASTEXITCODE -ne 0) { throw 'P1 baseline replay failed' }
```

## T1 B 组：同查询 Top 3 选优，不加变体规则

- [ ] 修改 `frontend/src/lib/exercise-ai-search.js` 的 `matchOne`。在同文件增加常量 `QUERY_PICK_LIMIT = 3` 和私有函数 `pickQueryHit(results, queries, names, equipmentHint, candidateEquipment, genericWords)`，用来替代循环内的 `results[0]`。它只检查 `results.slice(0, QUERY_PICK_LIMIT)`，排名沿用原数组顺序。跳过没有 exercise 的条目。
- [ ] 对每个条目调用已有 `exactNameMatch(exercise, names)`，其中 `names = [name, nameEn]`。继续按已有校验语义处理：非精确项需要 `score >= BASE_FLOOR` 和 `hasNameEvidence(queries, exercise, genericWords)`。精确项保留现有分数和名称证据豁免。所有项均须通过现有 `conflictFor(candidateEquipment, exercise)`，精确项也无器械冲突豁免。不要改这些辅助函数、阈值与词表。
- [ ] `equipmentHint` 只用于本次查询内排序，优先取合法的 `candidate.equipment`。候选没有合法器械值时，从输出的 `fallback.equipment` 取去重后的合法值，**只有恰好一个值**才作为弱提示。多个或零值均不加偏好。沿用共享 matcher 已有的合法器械值和清洗路径；不要将该弱提示透传至硬冲突判断、跨查询加分或产品输出。
- [ ] 单查询内排序键固定为：**精确名称或别名 → 与 equipmentHint 一致 → 原始检索名次**。各键按此顺序比较，布尔 true 优先；完全相同时保留原顺序。只返回一个合格 hit，携带原始 score，不累加新分数。分别保留当前英文和主名称查询、英文启用条件、调用顺序及 raw recall 事件。多个查询赢家仍用原始 score 取最大值，平分保持原查询顺序。
- [ ] 将现有 CJK 回退保持在同一层级：对前一步的最终词法赢家执行原有 `!exactName && isCjkName(name)` 分支。词法无合格项时仍允许进入原 CJK 回退；原有近似阈值、歧义判定、fallback 等级和硬器械冲突检查保持。保留现有 filter 决策和安全投影，没有词法赢家且没有 CJK 回退时，用原实现按最高原分选中的词法首项的拒绝原因记录诊断；原词法列表为空仍报告 no_hit。原分数和名称证据校验可与原最终分支复用同一个私有判断，避免两处规则漂移。
- [ ] 修改 `frontend/src/lib/exercise-ai-search.test.js`，加可控 `searchScored` 返回值测试：首项通过且器械不同，允许第 2 项胜出；首项被拒时审查第 2、3 项；第 4 项不参与；无器械提示/多值兜底保留原名次；单值兜底仅排序；第 2 项精确名称或别名优先；精确项命中现有器械冲突仍拒绝；两个查询仍按原分选择；CJK 精确、近似回退和歧义路径保持。用合成候选避免把测试绑到真实目录分数。保留已有 golden；失败先复现原因，不批量更新标签。
- [ ] 运行 T3 命令中 B 组的测试和离线回放，将代码记录成单独实验提交。B 组是独立对照，即使预期无法处理同器械的内侧推胸，也要先运行以量出其单独收益。

## T2 C 组：只追加一条推胸变体规则

- [ ] 基于 B 组实验提交，仍只修改 `frontend/src/lib/exercise-ai-search.js`。在私有 `pickQueryHit` 中，把一个布尔排序键插在**器械一致之后、原始名次之前**：优先选择没有未经输入支持的特殊变体的条目。在其他条件不变时，这条规则允许通用杠杆推胸排在内侧推胸前面。
- [ ] 触发条件全部满足才应用：模型候选的英文查询（`nameEn` 优先，缺失时取 `name`）与目录英文名（现有 `exercise.n`，缺失取 `exercise.name`）均包含完整短语 `chest press`；两个被比较项的 `eq` 相同。标准化使用小写、将连字符换成空格、压缩连续空格；用单词边界匹配。固定短语 `inner`、`outdoor`、`incline`、`decline`、`single arm`、`one arm`。目录名含某短语而模型主名及英文名均没有对应表达时，记作未经支持；`single arm` 和 `one arm` 视为等价。如果主名含中文，对照同组词 `内侧`、`户外`、`上斜`、`下斜`、`单臂`，避免明确变体被当成意外修饰。缺少修饰词只影响胜负，禁止丢弃条目。器械不同的条目跳过该键，维持 B 排序。实现使用单次按原名次扫描并比较当前赢家，避免跨器械的规则让全列表比较结果不稳定。
- [ ] 在同一测试文件补：`1301` 内侧项先通过时，通用杠杆推胸 `0576` 能在同器械下胜出；明确英文或中文上斜时不惩罚上斜；目录 ID 只出现在测试里；哈克、肩推等非推胸排序输出与 B 一致；器械不同不启用变体键；通用平推和上斜的跨查询原分排序保持当前行为。已有两个历史推胸响应在全量 CLI 中做真实数据回归。
- [ ] 运行 T3 的 C 组命令。C 组作为增量提交。不要在 C 组顺手调 P1、BASE_FLOOR、K 值或调整全局 Top 5 排序。若发现选优还不够，记录失败原因后结束本轮。

## T3 固定命令和报告

B、C 命令分别在对应实验提交上执行。测试有失败仍需记录，报告和错误不可只留最后一次。若未生成实验提交，报告中的 `gitCommit` 无法区分版本，需补录准确的 diff 哈希并重跑。

```powershell
# 完成 T1 并提交 B 组后运行
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx
node frontend/scripts/ai-search-eval.mjs --mode replay --manifest $evalManifest --web-locale zh --include-queries --out "$evalOut/b-top3.json"

# 完成 T2 并提交 C 组后运行
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx
node frontend/scripts/ai-search-eval.mjs --mode replay --manifest $evalManifest --web-locale zh --include-queries --out "$evalOut/c-top3-variants.json"
```

## T4 逐样本比较

- [ ] 在 `docs/ai-exercise-search/eval/LOCAL_SELECTION_RESULTS.md` 按 A/B/C、Web/RN 记录 Top 1、Top 5、Recall@5、错器械首位、空结果误报和 matcher 延迟。按组额外列纯图和带提示 Top 5。比较同一 sampleId，不用 overall matched 代替命中率。CLI 已报告的指标无需另加生产字段。
- [ ] 从冻结 manifest 将每条样本的 `expectedIds` 以 sample ID 建表。A、B 和 C 的报告用 PowerShell `ConvertFrom-Json -AsHashtable` 读入，核对相同目录哈希、locale、样本 ID 集合、分母和每个样本的 raw recall。比较 recall 时忽略平台耗时及报告生成时间，逐 query 比较 origin、实际 query、hitCount、Top 5 ID、score 和 expectedRanks。有变化先定位是否不慎改了原始检索；该次对照不用于决策。
- [ ] 每端列出四张逐样本表：Top 5 新命中、Top 5 新丢失、Top 1 新丢失、错器械首位及原本空样本新增结果。每行包含样本 ID、A/B/C 最终 ID 列表、目标原始名次和新旧 filter 决策。用 A 报告中 `firstExpectedRank` 为 2 或 3 且最终没有 expectedId 的正例冻结目标组，预期每端 26 条。按同一规则另列 P1 后真实响应子组（`prompt-b-*`、`q1-control-*`、`final-*`），预期每端 13 条。计算每版实际救回条数。
- [ ] 明确列出 `original-chest` 两条原始复现，以及旧 M2 的绳索推胸、杠铃哈克和肩推反例。用冻结 manifest 确认对应的 `hinted-chest-press`、`hinted-hack-squat` 和 `hinted-shoulder-press` 样本，分别检查首位是否新增器械错误、是否丢掉已有 `1454` Top 1。原始推胸若目标进入 Top 5 但 `1299` 仍为首位，按本轮范围记剩余问题。

## T5 保留／回退规则

- [ ] **有效性**：两端都必须在 `original-chest` 两条找到至少一个标注目标（0576/0577），且在第 2–3 名漏失组以及 P1 后真实响应子组各至少新增 1 条最终 Top 5 命中。只改变候选条数、排名细节或 filter 事件不算改善。
- [ ] **无回归**：原有 Top 1 和 Top 5 命中的样本逐条保留，不能用新增命中抵消丢失；两端均无新增错器械首位、空样本误报或 M2 已知回归；原始召回等价。任一项失败就不纳入本轮合并范围。
- [ ] **选择最小改动**：B 过门槛就优先选 B；C 只有在同样过门槛且相对 B 再新增 Top 5 命中、没有新回归时才选。如果 B 未通过而 C 通过，可保留 B+C 作为一个有证据的方案。两组都不通过则保留 P1，报告失败样本和具体原因。保存实验提交 ID 用于追溯，但不要合并失败实验。
- [ ] 在 `LOCAL_SELECTION_RESULTS.md` 记录最终选择、实际增量和回退理由。结果未通过时，不能改预期 ID、扩大 K、降低门槛或追加其他修复来凑通过；需要新实验先明确范围。

## T6 交付与验收

- [ ] 只在最终选中的版本运行并记录以下验证。若 A 被保留，说明 B/C 的差异和失败门槛。把最终版本的 matcher diff 与 P1 比较，确认生产修改只在计划文件内。若报告中新增命中仅来自多加重复变体，按样本标签逐项复核实际动作。
- [ ] 更新本文件各 TODO 状态和 `eval/LOCAL_SELECTION_RESULTS.md`；给出通过版本 commit、三份报告和按样本的增退表。报告和原始响应仍留在本地忽略目录。主分支操作单独授权。

```powershell
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx
npm.cmd --prefix frontend run test:ai-search-eval
npm.cmd --prefix frontend run build
npm.cmd --prefix mobile-rn run check
git diff --check
```
