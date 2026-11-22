# AI 动作检索 D 组执行文档

状态：已完成（D0–D5 已执行并验收；纯 D 的 D2 定向测试因继承自 B/C 的 4 条既有失败标记为未通过，纯 D 诊断回放通过全部 D4 回放门槛后，已单独提交精确名硬冲突修复 `e514195f3` 与 CLI 计数同步 `137ae0fc1`，最终验证全部通过，推荐保留 P1 + D + 冲突修复，未合并主分支）。本轮只移除查询内选优对 `fallback.equipment` 的依赖。按 D0–D5 逐项勾选，在 `eval/CANDIDATE_EQUIPMENT_RESULTS.md` 记录 commit、命令、退出码、报告路径及通过或回退判定。

## 背景与目标

[A/B/C 执行方案](LOCAL_SELECTION_EXECUTION.md) 用 135 条固定响应验证了查询内 Top 3。C 在两端均把 Top 5 从 89/133 提高到 110/133，救回原始推胸两例；但在 `prompt-a-1-photo-hack-squat` 上，模型把器械推断为 `leverage machine`，且仅写在 `fallback.equipment`。C 用这个值选中 `5784` 杠杆反向哈克，替换了原首位 `1583` 滑车反向哈克。A 组因此保留，C 组代码在 `08565837e`。原始结果与回退记录在 `D:/dev/open-gym-ai-search-top3/docs/ai-exercise-search/eval/LOCAL_SELECTION_RESULTS.md`。

D 组从 C 出发，仅允许**合法的候选级 `equipment`** 参与同查询内选优。保留 C 的 Top 3 数量、校验、精确名称优先、同器械推胸变体规则，以及每条查询只交出一个候选的行为。保持现有跨查询原分比较、全局排序、分数加成、硬冲突规则、CJK 回退、诊断事件和兜底展示。没有新的模型请求，无需 `.env`、API Key 或页面操作。本轮生产代码限 `frontend/src/lib/exercise-ai-search.js`。

## D0 建工作树并核对对照输入

- [x] 在 PowerShell 从主工作区查看 `git status --short`，验证 C 提交存在。新建 `codex/ai-search-candidate-equipment`，基于 `08565837e`，不从 A 或主分支开工。若该路径或分支已经存在，先核对归属和未提交改动。只将本执行文档复制到实验工作树，主工作区其他文档改动不带入对照。
- [x] 核对固定清单以及历史 A、C 报告均存在。清单包含 135 条响应（133 正例、2 预期空结果）。保留清单引用的旧工作树本地文件直至验收结束。文件缺失时从已有报告工作区恢复，不能用新模型响应补齐。A、C 的 locale 均为 `zh`，目录哈希相同，样本 ID 按同一顺序排列，无跳过、无执行错误。
- [x] 安装当前提交锁定的 frontend 与 RN 依赖；RN 依赖用于 CLI 的 Vite SSR 加载实际 RN 适配器。依赖安装失败时记录具体错误，保留锁文件。

```powershell
Set-Location 'D:\dev\open-gym'
git status --short
git worktree add -b codex/ai-search-candidate-equipment D:/dev/open-gym-ai-search-candidate-equipment 08565837e
if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed' }
Set-Location 'D:\dev\open-gym-ai-search-candidate-equipment'
Copy-Item -LiteralPath 'D:/dev/open-gym/docs/ai-exercise-search/CANDIDATE_EQUIPMENT_EXECUTION.md' -Destination 'docs/ai-exercise-search/CANDIDATE_EQUIPMENT_EXECUTION.md'

$evalManifest = 'D:/dev/open-gym-ai-search-quality/.codex/ai-search-eval/quality/p1-m1-paired-manifest.json'
$reportA = 'D:/dev/open-gym-ai-search-top3/.codex/ai-search-eval/top3/a-p1.json'
$reportC = 'D:/dev/open-gym-ai-search-top3/.codex/ai-search-eval/top3/c-top3-variants.json'
$reportD = '.codex/ai-search-eval/candidate-equipment/d-top3-candidate-equipment.json'
foreach ($path in $evalManifest, $reportA, $reportC) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Replay input missing: $path" }
}
npm.cmd --prefix frontend ci
if ($LASTEXITCODE -ne 0) { throw 'Frontend install failed' }
npm.cmd --prefix mobile-rn ci
if ($LASTEXITCODE -ne 0) { throw 'RN install failed' }
```

## D1 修改 matcher 的唯一生产行为

- [x] 打开 `frontend/src/lib/exercise-ai-search.js`，在 `createExerciseAiSearch().match` 中保留 `const fallback = cleanFallback(...)` 及原返回值。删除从该对象取单值的 `const fallbackEquipmentHint = ...`，并从 `matchOne(...)` 调用中移除对应实参。
- [x] 在同文件 `matchOne` 删除 `fallbackEquipmentHint` 形参以及 `const equipmentHint = validCandidateEquipment || fallbackEquipmentHint`。保留现有使用 `filterSlugs` 和 `equipmentValues` 得到 `validCandidateEquipment` 的代码。调用 `pickQueryHit` 时，把第四个参数从 `equipmentHint` 换为 `validCandidateEquipment`，第五个参数仍传原有 `candidate.equipment`。前者只控制排序，后者保留原有硬冲突语义。
- [x] 检查本文件里的 `fallbackEquipmentHint` 已全部移除。候选字段缺失或非法时，器械排序键对每项都为 false；单值和多值 fallback 都不得改变候选顺序。同设备推胸变体仍可比较，候选级器械合法时仍有现有加分／相容选择。禁止把 fallback 换成全局默认值或低置信例外。
- [x] `git diff` 核对 `pickQueryHit` 实现及其排序键、`cleanFallback`、`searchScored`、CJK 分支、跨查询和最终排序均未动。本轮不新增日志字段。

## D2 固定测试和提交

- [x] 修改 `frontend/src/lib/exercise-ai-search.test.js` 中 `AI exercise within-query top-3 selection (Group B)`。将 `uses single-value fallback equipment only for within-query ordering, never conflict or bonus` 改为验证**单值 fallback 不参与选优**：使用两个非精确、名称证据相当的非推胸候选，同一查询第 1 为滑车反向哈克、第 2 为杠杆反向哈克；构造低置信模型候选，省略 candidate.equipment，分别用空 fallback 和 `equipment: ["leverage machine"]` 匹配，两个结果的 `items` 深度一致，首项是原始第 1。带器械的调用仍返回原 `fallback.equipment` 供展示。
- [x] 扩展既有「第 2 项与候选器械一致」用例：加入与候选级器械相反的单值 fallback，验证第 2 项仍胜出。再以非法候选器械值搭配单值 fallback，验证原始名次保持。保持 C 的推胸变体测试和已存在 golden，禁止通过改期望 ID 消除失败。
- [ ] 运行定向测试并记录退出码。通过后单独提交本轮 matcher 和测试两文件，提交用于报告内的 `gitCommit`；别把用户文档、副本、回放或测试产物顺带进此提交。该实验提交不等于合入主分支。（**纯 D 未通过**：退出码 `1`，4 条继承自 B/C 的失败；经授权先跑纯 D 诊断回放 `d-diagnostic.json` 过关后，将纯 D 单独提交为 `772571faa`，并在独立提交 `e514195f3` 完成精确名硬冲突修复与 D04 第 4 名召回测试更新，随后 68/68 全通过。）

```powershell
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx
if ($LASTEXITCODE -ne 0) { throw 'D matcher regression tests failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Diff whitespace check failed' }
git add -- frontend/src/lib/exercise-ai-search.js frontend/src/lib/exercise-ai-search.test.js
git commit -m "D: use only candidate equipment for within-query selection"
if ($LASTEXITCODE -ne 0) { throw 'D commit failed' }
```

## D3 回放并校验可比性

- [x] 在 D 实验提交上运行（分别输出纯 D 诊断报告 `d-diagnostic.json` 与冲突修复报告 `d-conflict-fix.json`）：

```powershell
node frontend/scripts/ai-search-eval.mjs --mode replay --manifest $evalManifest --web-locale zh --include-queries --out $reportD
if ($LASTEXITCODE -ne 0) { throw 'D paired replay failed' }
```

- [x] 用 PowerShell 的 `Get-Content -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable` 读取 manifest 和 A/C/D 报告，以样本 ID 建立 `expectedIds` 标签表。验证 135 条、同目录哈希、同 locale、同样本 ID 和顺序、`skippedIds` 为空、`summary.sampleErrors = 0`，并确认 Web/RN 各完成 135 条。断言同一平台同一样本的 `recall` 数组与 A、C 完全一致，逐查询检查候选序号、查询来源、文本、命中数、Top 5 ID 与分数及 `expectedRanks`。可以用 `ConvertTo-Json -Depth 15 -Compress` 序列化单个 recall 数组比较，匹配耗时不参与比较。任意不一致即停止判定，先定位输入或召回差异。
- [x] 按 A、C、D 分别保存最终 Top 1、Top 5、Recall@5、错器械首位、空结果误报及 matcher P50/P95，Web、RN 分开。逐样本计算 Top 1 为 `finalIds[0]` 命中任一 expectedId，Top 5 为任一 `finalIds` 命中。另写两张表，分别列出 A→D 的新增、丢失及新错器械首位，和 C→D 放弃、保住的命中。每行带平台、样本 ID、原始预期排名、三个版本最终 ID 及相关 filter 决策。
- [x] 从 A 冻结 P1 后漏失子集：组名以 `prompt-b-`、`q1-control-` 或 `final-` 开头，正例且 `firstExpectedRank` 为 2 或 3，A 的最终列表无标注目标。每端预期 13 条。再从这 13 条里取 C 最终命中的 12 条，逐条核对 D 是否仍命中。不可用 D 的新命中抵消 C 救回样本的丢失。

## D4 门槛与决策

以下门槛必须同时满足。总命中不必追平 C 的 110/133，C 上由旧兜底提示产生的额外收益单独披露。

| 验收项 | 检查方法和通过标准 |
|---|---|
| 哈克反例 | `prompt-a-1-photo-hack-squat` 的 D 首位在 Web 和 RN 都为 `1583`，`wrongEquipment=false`。C 的首位是 `5784`。 |
| 原始推胸 | `my-model-chest-hinted-chest-press` 和 `my-model-chest-photo-chest-press` 每条在两端均含 `0576` 或 `0577`。低置信上斜 `1299` 仍排首位时如实记录，由后续单独任务处理。 |
| 保留实际收益 | D 在两端逐条保留 C 已救回的 12 条 P1 后漏失样本。 |
| 无新增错误 | 相比 A，任何原有 Top 1 或 Top 5 命中都不能丢；没有新增错器械首位和预期空样本误报；原始召回完全相同。逐样本检查，不用净值抵消。 |
| 旧反例保护 | `hinted-chest-press` 和 `hinted-hack-squat` 首位分别不能变成 `2144` 和 `0046`；`hinted-shoulder-press` 两端继续以已有标注命中 `1454` 排首位。 |

- [x] D 通过所有项才推荐保留 **P1 + D**。记录 D 提交，以及它从 C 继承的 B/C 提交。D 未通过时推荐保留 A（`e53e6667e`），D 实验提交留作证据。不要现场加低置信例外、换 K 或放宽验收门槛。此次只交付可合并范围和证据，合并主分支需另行授权。（纯 D 通过全部回放门槛，D + 精确名硬冲突修复 `e514195f3` 同时通过回放与单测门槛，推荐保留 **P1 + D + 冲突修复**。）

## D5 最终验证与移交

- [x] 对拟保留版本运行下面的回归命令。已知 C 所在提交的 `frontend/scripts/ai-search-eval.test.mjs` 可能仍有 `REPLAY_SAMPLES = 10` 的基线计数断言，而 `eval/manifest.json` 已是 13 条可回放样本。若验证失败仅为这条，先保留原始失败记录，然后核对 `d0872a38e` 对该文件的既有修正。只在拟交付的分支单独提交计数修复（`10 → 13`），不带入该提交的其他文件，随后重跑 CLI 测试。修正必须与 D 实验提交分开，报告按原实验 commit 保留。
- [x] 新增 `docs/ai-exercise-search/eval/CANDIDATE_EQUIPMENT_RESULTS.md`，写入 A/C/D commit、三份报告路径、逐项验收结果、D 继承和放弃的收益、已知限制及拟合入范围。更新本文件 TODO 状态。原始响应、报告和私有路径关联清单留在本地忽略目录，不提交。
- [x] 最终检查与 C 的生产 diff 只有 D1 指定的变更。若 D 未通过，在结果文档说明保留 A，不能把实验分支误称为交付分支。（注：纯 D 提交 `772571faa` 相对 C 只有 D1 变更；后续经授权独立提交 `e514195f3` 仅追加精确名硬冲突修复与测试，详见结果文档。）

```powershell
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx
npm.cmd --prefix frontend run test:ai-search-eval
npm.cmd --prefix frontend run build
npm.cmd --prefix mobile-rn run check
git diff --check
```
