# AI 动作检索 D 组（候选级器械选优 + 精确名硬冲突修复）对照与验收记录

本文件是 [CANDIDATE_EQUIPMENT_EXECUTION.md](../CANDIDATE_EQUIPMENT_EXECUTION.md) 的 D0–D5 执行记录、纯 D 诊断回放、精确名硬冲突修复对照、逐样本增退表与最终验证证据。离线回放报告与纯 D 补丁归档在主工作区 `D:/dev/open-gym/.codex/ai-search-eval/candidate-equipment/`。冻结清单保留在原质量评估工作区的本地忽略目录。回放产物不入库。

## 1. 基线、实验提交与输入核对（D0 / D1 / D2 / 冲突修复）

- 实验工作树：`D:/dev/open-gym-ai-search-candidate-equipment`（分支 `codex/ai-search-candidate-equipment`，基于 C 组 `08565837e`）
- 冻结回放清单：`D:/dev/open-gym-ai-search-quality/.codex/ai-search-eval/quality/p1-m1-paired-manifest.json`（135 样本：133 正例 + 2 预期空样本，0 缺失文件）
- 目录哈希（`catalogueSha256`）：`99add164cbdd8396efb48672fe865d7cd97b487a65c365a270c294cd72825f96`
- `webLocale`：`zh`
- `skippedIds`：`[]`；`summary.sampleErrors = 0`；Web 与 RN 各完成 135 条

| 版本 | 说明 | Commit / Diff 标识 | 报告路径 | 回放退出码 |
|---|---|---|---|---:|
| **A（P1 基线）** | P1 单独版本（原始 `results[0]`） | `e53e6667ed9ca871b3ce56a4744001b9388cb13e` | `D:/dev/open-gym-ai-search-top3/.codex/ai-search-eval/top3/a-p1.json` | 0 |
| **B（历史继承）** | 同查询 Top 3 选优（无变体规则） | `921068546b2e056337e83942c47cb8ec58d94915` | 历史对照见 `LOCAL_SELECTION_RESULTS.md` | 0 |
| **C（起点）** | B + 同器械推胸变体规则（含单值 `fallback.equipment` 提示） | `08565837e88596b314c077941457ac9538a8b53c` | `D:/dev/open-gym-ai-search-top3/.codex/ai-search-eval/top3/c-top3-variants.json` | 0 |
| **纯 D（诊断回放）** | C + 仅移除 `fallbackEquipmentHint`（回放时基于 `08565837e` 未提交工作区；随后原样固化为独立提交） | 报告内 `gitCommit=08565837e88596b314c077941457ac9538a8b53c`（C + 未提交纯 D）；独立提交 `772571faaa6143b84f29c0e7e979683c3719195f`；补丁快照 `.codex/ai-search-eval/candidate-equipment/pure-d.patch` | `.codex/ai-search-eval/candidate-equipment/d-diagnostic.json` | 0 |
| **D + 冲突修复** | 纯 D + Top 3 精确名全触发硬器械冲突时拒绝（禁止非精确变体 / 双语非精确 / CJK 回退穿透）+ D04 第 4 名召回测试更新 | `e514195f3eb0b2efe45deb8d159410bf5a29b7f2` | `.codex/ai-search-eval/candidate-equipment/d-conflict-fix.json` | 0 |
| **CLI 计数修复（D5）** | 仅同步 `frontend/scripts/ai-search-eval.test.mjs` 的 `REPLAY_SAMPLES: 10 → 13`（对齐 `d0872a38e`，与 matcher 分开提交） | `137ae0fc10053db66d5757bf3b0aab9accb60632` | 报告按 `e514195f3` 保留 | — |

### 1.1 纯 D 诊断回放时的未提交 Diff 哈希（对应 `d-diagnostic.json`）

`d-diagnostic.json` 在未提交纯 D 改动上生成，报告中 `gitCommit` 仍显示 `08565837e88596b314c077941457ac9538a8b53c`，对应两份文件的精确哈希如下（随后原样提交为 `772571faa`）：

| 文件 | `git diff` UTF-8 SHA-256 | 文件内容 SHA-256 |
|---|---|---|
| `frontend/src/lib/exercise-ai-search.js` | `b3dc10684b90d4b94464feb81018a1fe022baacf5d14e9fadf6167e96272ecb4` | `6268a63db299d9706886e2fe3e0773d43a7fe9300d16b5c6b4bc12daf52016d0` |
| `frontend/src/lib/exercise-ai-search.test.js` | `7ca6c8e6727f5e8154d2a500574733525efa70e1f4e6bc5d024bf2c35374b73e` | `db0e3562c632a1e178bfe6f178ebb7ca62a926afe77f475286b8a2d59a47d62b` |
| 两文件合并 `git diff` | `3251d6adb7e1113ec7e9e9b1128492f5f37ce80a48491258a890a17f2ab4abd9` | — |

### 1.2 D2 原始定向测试失败记录（标记为未通过，继承自 B/C）

在纯 D 改动上运行定向单测退出码为 **`1`**（`63 passed / 4 failed`，3 文件共 67 用例；`library-search-rn.test.ts` 7/7、`ExerciseAiSearch.test.jsx` 27/27、全部 Group B/C/D 新用例通过）。4 条失败用例均不含 `fallback.equipment`，全部继承自 B（`921068546`）/ C（`08565837e`）：

1. `AI exercise matching pipeline (3.3) > drops a candidate whose equipment hint contradicts a bodyweight hit`：`push-up` + `smith machine` 拒绝第 1 名 `0662`（自重）与第 2 名 `0659`（自重）后，穿透命中第 3 名 `0653`（`push-up (bosu ball)`, `bosu ball`）。
2. `AI exercise retrieval goldens (3.4) > keeps ambiguity, conflict and boundary cases at 100%`：golden `conflict` 子集仅 `1/3`（`conflict-push-up-smith` 返回 `0653`；`conflict-dip-machine` 拒绝第 1 名 `0251` 自重 `chest dip` 后穿透返回第 3 名 `0009` `assisted chest dip (kneeling)`）。
3. `AI exercise matcher diagnostics (D04) > still records a second-place expected id the original rules never surface`：原用例假定只读 `results[0]`，第 1 名 `0027` 无名称证据被拒后，Top 3 选优合法命中第 2 名 `0576`。
4. `AI exercise matcher diagnostics (D04) > projects public ids only for trusted entries across decision kinds`：同 1，`push-up` + `smith machine` 返回 `['0653']` 而非 `[]` 与 `equipment_conflict: 0662`。

### 1.3 可比性与原始召回等价核对

使用 PowerShell 7 `Get-Content -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable` 对 `manifest` 与四份报告（A / C / 纯 D / D+冲突修复）核对：

- `catalogueSha256`：四份报告完全一致（`99add164cbdd8396efb48672fe865d7cd97b487a65c365a270c294cd72825f96`）。
- `webLocale`：四份报告完全一致（`zh`）。
- 样本 ID 集合与顺序：与 manifest 135 条完全一致，`skippedIds = []`，`sampleErrors = 0`，Web/RN 均匹配 135 条。
- 逐样本逐端逐 query 原始 `recall` 序列化比较（`ConvertTo-Json -Depth 15 -Compress`，共 926 条 query = Web 463 + RN 463）：
  - **A vs 纯 D：0 差异**；**C vs 纯 D：0 差异**。
  - **A vs D+冲突修复：0 差异**；**C vs D+冲突修复：0 差异**。

## 2. 总体与分组指标（A / C / 纯 D / D+冲突修复）

### 2.1 总体指标（按平台、按版本）

| 平台 | 版本 | Top 1 | Top 5 | Recall@5 | 错器械首位 | 空结果误报 | 兜底 only | Matcher P50 / P95 (ms) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Web | **A (P1)** | 46/133 | 89/133 | 116/133 | 18/131 | 0/2 | 4/135 | 34 / 101 |
| Web | **C (Top3+变体)** | 49/133 (+3) | 110/133 (+21) | 116/133 | 17/131 (**+1 新增**/-2 修复) | 0/2 | 4/135 | 34 / 117 |
| Web | **纯 D（诊断）** | 49/133 (+3) | 106/133 (+17) | 116/133 | 18/131 (**0 新增**/0 修复) | 0/2 | 4/135 | 35 / 102 |
| Web | **D + 冲突修复** | **49/133 (+3)** | **106/133 (+17)** | 116/133 | **17/131 (0 新增/-1 修复)** | **0/2** | 4/135 | 33 / 94 |
| RN | **A (P1)** | 50/133 | 89/133 | 116/133 | 16/131 | 0/2 | 4/135 | 33 / 95 |
| RN | **C (Top3+变体)** | 52/133 (+2) | 110/133 (+21) | 116/133 | 17/131 (**+1 新增**) | 0/2 | 4/135 | 34 / 98 |
| RN | **纯 D（诊断）** | 52/133 (+2) | 106/133 (+17) | 116/133 | 16/131 (**0 新增**/0 修复) | 0/2 | 4/135 | 34 / 105 |
| RN | **D + 冲突修复** | **52/133 (+2)** | **106/133 (+17)** | 116/133 | **15/131 (0 新增/-1 修复)** | **0/2** | 4/135 | 31 / 98 |

### 2.2 全部分组明细（A / C / 纯 D / D+冲突修复）

| 组别 | 端 | Top 1 (A / C / 纯 D / D+修复) | Top 5 (A / C / 纯 D / D+修复) | Recall@5 | 错器械首位 (A / C / 纯 D / D+修复) |
|---|---|---:|---:|---:|---:|
| `hinted` | web | 1/5 / 1/5 / 1/5 / 1/5 | 3/5 / 4/5 / 3/5 / 3/5 | 5/5 | 1/5 / 1/5 / 1/5 / 1/5 |
| `hinted` | rn | 1/5 / 1/5 / 1/5 / 1/5 | 3/5 / 4/5 / 3/5 / 3/5 | 5/5 | 1/5 / 1/5 / 1/5 / 1/5 |
| `edge` | web | 1/3 / 1/3 / 1/3 / 1/3 | 1/3 / 1/3 / 1/3 / 1/3 | 2/3 | 0/1 / 0/1 / 0/1 / 0/1 |
| `edge` | rn | 1/3 / 1/3 / 1/3 / 1/3 | 1/3 / 1/3 / 1/3 / 1/3 | 2/3 | 0/1 / 0/1 / 0/1 / 0/1 |
| `quality-regression` | web | 0/3 / 0/3 / 0/3 / 0/3 | 2/3 / 2/3 / 2/3 / 2/3 | 2/3 | 1/3 / 1/3 / 1/3 / 1/3 |
| `quality-regression` | rn | 0/3 / 0/3 / 0/3 / 0/3 | 2/3 / 2/3 / 2/3 / 2/3 | 2/3 | 1/3 / 1/3 / 1/3 / 1/3 |
| `final-hinted` | web | 11/15 / 11/15 / 11/15 / 11/15 | 13/15 / 15/15 / 15/15 / 15/15 | 15/15 | 0/15 / 0/15 / 0/15 / 0/15 |
| `final-hinted` | rn | 11/15 / 11/15 / 11/15 / 11/15 | 13/15 / 15/15 / 15/15 / 15/15 | 15/15 | 0/15 / 0/15 / 0/15 / 0/15 |
| `final-photo-only` | web | 4/15 / 4/15 / 4/15 / 4/15 | 7/15 / 9/15 / 9/15 / 9/15 | 9/15 | 3/15 / 3/15 / 3/15 / 3/15 |
| `final-photo-only` | rn | 4/15 / 4/15 / 4/15 / 4/15 | 7/15 / 9/15 / 9/15 / 9/15 | 9/15 | 3/15 / 3/15 / 3/15 / 3/15 |
| `prompt-a-hinted` | web | 1/15 / 1/15 / 1/15 / 1/15 | 8/15 / 12/15 / 10/15 / 10/15 | 14/15 | 6/15 / 5/15 / 6/15 / 6/15 |
| `prompt-a-hinted` | rn | 1/15 / 1/15 / 1/15 / 1/15 | 8/15 / 12/15 / 10/15 / 10/15 | 14/15 | 5/15 / 5/15 / 5/15 / 5/15 |
| `prompt-a-photo-only` | web | 2/15 / 3/15 / 3/15 / 3/15 | 9/15 / 11/15 / 10/15 / 10/15 | 12/15 | 3/15 / 3/15 / 3/15 / 3/15 |
| `prompt-a-photo-only` | rn | 2/15 / 3/15 / 3/15 / 3/15 | 9/15 / 11/15 / 10/15 / 10/15 | 12/15 | 2/15 / 3/15 / 2/15 / 2/15 |
| `prompt-b-hinted` | web | 11/15 / 11/15 / 11/15 / 11/15 | 14/15 / 14/15 / 14/15 / 14/15 | 14/15 | 0/15 / 0/15 / 0/15 / 0/15 |
| `prompt-b-hinted` | rn | 11/15 / 11/15 / 11/15 / 11/15 | 14/15 / 14/15 / 14/15 / 14/15 | 14/15 | 0/15 / 0/15 / 0/15 / 0/15 |
| `prompt-b-photo-only` | web | 3/15 / 4/15 / 4/15 / 4/15 | 9/15 / 12/15 / 12/15 / 12/15 | 12/15 | 2/15 / 2/15 / 2/15 / 2/15 |
| `prompt-b-photo-only` | rn | 5/15 / 5/15 / 5/15 / 5/15 | 9/15 / 12/15 / 12/15 / 12/15 | 12/15 | 2/15 / 2/15 / 2/15 / 2/15 |
| `q1-control-hinted` | web | 7/15 / 7/15 / 7/15 / 7/15 | 12/15 / 14/15 / 14/15 / 14/15 | 15/15 | 2/15 / 2/15 / 2/15 / **1/15** |
| `q1-control-hinted` | rn | 9/15 / 9/15 / 9/15 / 9/15 | 12/15 / 14/15 / 14/15 / 14/15 | 15/15 | 2/15 / 2/15 / 2/15 / **1/15** |
| `q1-control-photo-only` | web | 5/15 / 6/15 / 6/15 / 6/15 | 11/15 / 14/15 / 14/15 / 14/15 | 14/15 | 0/15 / 0/15 / 0/15 / 0/15 |
| `q1-control-photo-only` | rn | 5/15 / 6/15 / 6/15 / 6/15 | 11/15 / 14/15 / 14/15 / 14/15 | 14/15 | 0/15 / 0/15 / 0/15 / 0/15 |
| `original-chest` | web | 0/2 / 0/2 / 0/2 / 0/2 | 0/2 / 2/2 / 2/2 / 2/2 | 2/2 | 0/2 / 0/2 / 0/2 / 0/2 |
| `original-chest` | rn | 0/2 / 0/2 / 0/2 / 0/2 | 0/2 / 2/2 / 2/2 / 2/2 | 2/2 | 0/2 / 0/2 / 0/2 / 0/2 |

## 3. 逐样本对照表

### 3.1 A → 纯 D 与 A → D+冲突修复（新增、丢失及错器械变化）

- **Top 5 丢失**：Web 0 条，RN 0 条（纯 D 与 D+修复均无丢失）。
- **Top 1 丢失**：Web 0 条，RN 0 条（纯 D 与 D+修复均无丢失；Top 1 新增 Web +3：`prompt-a-1-photo-chest-press`、`prompt-b-1-photo-chest-press`、`q1-control-2-photo-chest-press`；RN +2：`prompt-a-1-photo-chest-press`、`q1-control-2-photo-chest-press`）。
- **新增错器械首位**：Web 0 条，RN 0 条（纯 D 与 D+修复均无新增）。
- **新增空样本误报**：Web 0/2，RN 0/2（原本 4 条空结果样本均保持 `[]`）。
- **Top 5 新增（两端各 +17 条，纯 D 与 D+修复集合完全一致）**：

| 平台 | 样本 ID | 原始名次 | A 最终 ID | C 最终 ID | 纯 D / D+修复 最终 ID | Filter 决策对比 |
|---|---|---:|---|---|---|---|
| Web & RN | `final-1-hinted-hack-squat` | 2 | `0739,0738,1583,0046` | `0739,0738,1583,0743` | `0739,0738,1583,0743` | A: `c0=acc:0046`; C/D/D+修复: `c0=acc:0743` |
| Web & RN | `final-2-photo-hack-squat` | 2 | `0739,0046` | `0739,0743` | `0739,0743` | A: `c0=acc:0046`; C/D/D+修复: `c0=acc:0743` |
| Web & RN | `final-3-hinted-hack-squat` | 2 | `1391,0739,0046` | `1391,0739,0743` | `1391,0739,0743` | A: `c0=acc:0046`; C/D/D+修复: `c0=acc:0743` |
| Web & RN | `final-3-photo-hack-squat` | 2 | `1583,0046` | `1583,1383,0743` | `1583,1383,0743` | A: `c1=acc:0046; c3=eq_conflict:0284`; C/D/D+修复: `c1=acc:0743; c3=acc:1383` |
| Web / RN | `prompt-a-1-hinted-chest-press` | 2 | Web:`1299,2144,1301`<br>RN:`1299,1301,2144` | `1299,2144,0576,10671` | `1299,2144,0576` | A: `c0=acc:2144; c1=acc:1301`; C: `c0=acc:10671; c1=acc:0576`; D/D+修复: `c0=acc:2144; c1=acc:0576` |
| Web & RN | `prompt-a-1-photo-chest-press`（兼 Top 1） | 2 | `1301,1030` | `0576,1030` | `0576,1030` | A: `c0=acc:1301`; C/D/D+修复: `c0=acc:0576` |
| Web & RN | `prompt-a-2-hinted-chest-press` | 2 | `1299,1301,1625,10672` | `1299,0576,1625,10672` | `1299,0576,1625,10672` | A: `c0=acc:1301`; C/D/D+修复: `c0=acc:0576` |
| Web / RN | `prompt-b-1-photo-chest-press`（Web 兼 Top 1） | 2 | `1301,0603` | Web:`0576,0603`<br>RN:`0603,0576` | Web:`0576,0603`<br>RN:`0603,0576` | A: `c0=acc:1301`; C/D/D+修复: `c0=acc:0576` |
| Web & RN | `prompt-b-2-photo-hack-squat` | 2 | `0739,0046` | `0739,0743` | `0739,0743` | A: `c0=acc:0046`; C/D/D+修复: `c0=acc:0743` |
| Web & RN | `prompt-b-3-photo-hack-squat` | 2 | `0739,0046` | `0739,0743` | `0739,0743` | A: `c0=acc:0046`; C/D/D+修复: `c0=acc:0743` |
| Web / RN | `q1-control-1-hinted-hack-squat` | 2 | Web:`0739,0742,0046`<br>RN:`0739,0046` | Web:`0739,0742,0743`<br>RN:`0739,0743` | Web:`0739,0742,0743`<br>RN:`0739,0743` | A: `c0=acc:0046`; C/D/D+修复: `c0=acc:0743` |
| Web & RN | `q1-control-2-hinted-hack-squat` | 2 | `1372,0739,0046` | `1372,0739,0743` | 纯 D:`1372,0739,0743`<br>**D+修复:`0739,0743`** | A:`c0=0046; c2=1372`; C/纯 D:`c0=0743; c2=1372`; **D+修复:`c0=0743; c2=eq_conflict:3018`（兼修错器械首位）** |
| Web & RN | `q1-control-2-photo-chest-press`（兼 Top 1） | 2 | `1301,1030` | `0576,1030` | `0576,1030` | A: `c1=acc:1301`; C/D/D+修复: `c1=acc:0576` |
| Web & RN | `q1-control-2-photo-hack-squat` | 2 | `0739,0046` | `0739,0743` | `0739,0743` | A: `c0=acc:0046`; C/D/D+修复: `c0=acc:0743` |
| Web & RN | `q1-control-3-photo-hack-squat` | 2 | `0739,0046` | `0739,0743` | `0739,0743` | A: `c0=acc:0046`; C/D/D+修复: `c0=acc:0743` |
| Web & RN | `my-model-chest-hinted-chest-press` | 2 | `1299,6355,1301` | `1299,10671,0576` | `1299,10671,0576` | A: `c0=acc:6355; c1=acc:1301`; C/D/D+修复: `c0=acc:10671; c1=acc:0576` |
| Web & RN | `my-model-chest-photo-chest-press` | 2 | `1299,1301,2659` | `1299,0576,1041` | `1299,0576,1041` | A: `c0=acc:1301; c1=acc:2659`; C/D/D+修复: `c0=acc:0576; c1=acc:1041` |

### 3.2 C → 纯 D / D+冲突修复（放弃与保住的命中）

- **保住的命中**：Web 与 RN 均保住 C 的 **17/21** 条 Top 5 新增命中（含全部 12 条 P1 后子集样本、全部 2 条 `original-chest` 样本、全部 3 条 `prompt-a` 推胸样本）。
- **放弃的命中（两端均为同 4 条 P1 前旧响应，均因候选级未填 `equipment`、C 仅靠单值 `fallback.equipment=[sled machine]` 救回）**：

| 平台 | 样本 ID | 组别 | 原始名次 | A 最终 ID | C 最终 ID | 纯 D / D+修复 最终 ID | Filter 决策差异 |
|---|---|---|---:|---|---|---|---|
| Web / RN | `hinted-hack-squat` | `hinted` | 2 | Web:`1583,0739,0046`<br>RN:`0739,0046,1583` | Web:`1583,0739,0743`<br>RN:`0739,0743,1583` | Web:`1583,0739,0046`<br>RN:`0739,0046,1583` | C: `c0=acc:0743`; D/D+修复: `c0=acc:0046` |
| Web / RN | `prompt-a-2-hinted-hack-squat` | `prompt-a-hinted` | 2 | Web:`1027,0739,0046`<br>RN:`0739,0046,1027` | Web:`1027,0739,0743`<br>RN:`0739,0743,1027` | Web:`1027,0739,0046`<br>RN:`0739,0046,1027` | C: `c0=acc:0743`; D/D+修复: `c0=acc:0046` |
| Web & RN | `prompt-a-3-hinted-hack-squat` | `prompt-a-hinted` | 2 | `1583,0739,0046,1027` | `1583,0739,0743,1027` | `1583,0739,0046,1027` | C: `c0=acc:0743`; D/D+修复: `c0=acc:0046` |
| Web & RN | `prompt-a-3-photo-hack-squat` | `prompt-a-photo-only` | 2 | `0739,0046,1197` | `0739,0743,1197` | `0739,0046,1197` | C: `c0=acc:0743`; D/D+修复: `c0=acc:0046` |

- 另披露 Web 端两例 P1 前响应的 `wrongEquipment` 回退至 A：`prompt-a-2-hinted-leg-extension`（C `5178` 降回 A `1776`）与 `prompt-a-2-photo-shoulder-press`（C `1299` 降回 A `2144`），两者在 C 中均依赖单值 `fallback.equipment`，因此纯 D 恢复为与 A 相同（0 新增错误）。

### 3.3 纯 D → D+冲突修复 的逐样本变化（唯一变化）

两端在全部 135 样本中，仅 **1 条** 发生 `finalIds` 与 `filter` 变化，且为正向修复：

| 平台 | 样本 ID | 纯 D 最终 ID (`wrongEq`) | D+修复 最终 ID (`wrongEq`) | Filter 决策变化与原因 |
|---|---|---|---|---|
| Web & RN | `q1-control-2-hinted-hack-squat` | `1372,0739,0743` (`true`) | **`0739,0743` (`false`)** | `c2`（`standing calf raise` + `eq=sled machine`）在纯 D 拒绝精确自重项 `3018` 后穿透选中非精确杠铃项 `1372` 并登顶错器械首位；D+修复在 `c2` 触发 `eq_conflict:3018` 后拒绝，首位恢复滑车 `0739`，两端错器械首位各减 1（Web `18→17`、RN `16→15`），Top 5 仍命中 `0743`。 |

### 3.4 冻结 P1 后漏失子集（13 条，C 救回 12 条）逐条核对

| 序号 | 样本 ID | 原始名次 | C 命中 (Web/RN) | 纯 D 命中 (Web/RN) | D+修复 命中 (Web/RN) |
|---:|---|---:|:---:|:---:|:---:|
| 1 | `final-1-hinted-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 2 | `final-2-photo-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 3 | `final-3-hinted-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 4 | `final-3-photo-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 5 | `prompt-b-1-photo-chest-press` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 6 | `prompt-b-2-photo-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 7 | `prompt-b-3-photo-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 8 | `q1-control-1-hinted-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 9 | `q1-control-2-hinted-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是**（兼消错器械首位） |
| 10 | `q1-control-2-photo-chest-press` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 11 | `q1-control-2-photo-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |
| 12 | `q1-control-3-hinted-hack-squat` | 2 | 否 / 否 | 否 / 否 | 否 / 否 |
| 13 | `q1-control-3-photo-hack-squat` | 2 | 是 / 是 | **是 / 是** | **是 / 是** |

结果：C 救回的 **12/12** 条在纯 D 与 D+冲突修复的 Web/RN 两端均逐条保留（0 丢失）。

## 4. D4 门槛与决策

| 验收项 | 检查结果（纯 D） | 检查结果（D + 冲突修复） | 判定 |
|---|---|---|---|
| **哈克反例**（`prompt-a-1-photo-hack-squat`） | Web/RN 首位均为 `1583`，`wrongEquipment=false`（C 为 `5784`） | Web/RN 首位均为 `1583`，`wrongEquipment=false` | **通过** |
| **原始推胸**（`my-model-chest-hinted-chest-press` / `photo`） | 两端均含 `0576`（首位仍为低置信上斜 `1299`，如实记录） | 两端均含 `0576`（首位仍为 `1299`，如实记录） | **通过** |
| **保留实际收益**（P1 后 12 条） | Web 12/12、RN 12/12 | Web 12/12、RN 12/12 | **通过** |
| **无新增错误**（相对 A） | Top 1 丢 0、Top 5 丢 0、新增错器械 0、空样本误报 0/2、926 条召回 0 差异 | Top 1 丢 0、Top 5 丢 0、新增错器械 0（且两端各额外修复 1 条）、空样本误报 0/2、926 条召回 0 差异 | **通过** |
| **旧反例保护** | `hinted-chest-press` Web/RN 首位 `10672`（≠`2144`）；`hinted-hack-squat` Web `1583` / RN `0739`（≠`0046`）；`hinted-shoulder-press` 两端首位 `1454` | 完全一致 | **通过** |
| **单测与 golden（D2 门槛）** | **未通过**（4 条继承自 B/C 的失败） | **通过**（68/68，golden 88/88，conflict 3/3） | **D+冲突修复通过** |

### 最终决策与推荐合入范围

- **推荐保留版本**：**P1 + D + 精确名硬冲突修复**（分支 `codex/ai-search-candidate-equipment` 当前 HEAD `137ae0fc10053db66d5757bf3b0aab9accb60632`）。
- **相对 P1（`e53e6667e`）的完整提交链**：
  1. `921068546` — `T1 (Group B): within-query top-3 selection without variant rule`
  2. `08565837e` — `T2 (Group C): add same-equipment chest-press unsupported-variant tie-breaker`
  3. `772571faa` — `D: use only candidate equipment for within-query selection`（纯 D，与 C 生产 diff 仅移除 `fallbackEquipmentHint`）
  4. `e514195f3` — `fix(ai-search): reject exact-name equipment conflicts in top-3 selection`（精确名硬冲突拒绝 + D04 第 4 名测试更新）
  5. `137ae0fc1` — `test(ai-search-eval): update REPLAY_SAMPLES count from 10 to 13`（D5 CLI 清单计数基线同步，仅改 `frontend/scripts/ai-search-eval.test.mjs`）
- **改动文件范围**：生产代码**仅修改** `frontend/src/lib/exercise-ai-search.js`；测试文件仅修改 `frontend/src/lib/exercise-ai-search.test.js` 与 `frontend/scripts/ai-search-eval.test.mjs`。
- **主分支状态**：本次未合并 `main`，如需合入请另行授权。
- **已知限制（留待后续独立任务）**：
  - 原始推胸两例（`my-model-chest-hinted-chest-press`、`my-model-chest-photo-chest-press`）中 `0576` 已救回 Top 5，但跨查询原分排序下低置信上斜 `1299` 仍排首位。
  - P1 前旧模型响应中未填候选级 `equipment` 的 4 条哈克深蹲样本（依赖单值 `fallback.equipment`）已主动放弃，以消除 `prompt-a-1-photo-hack-squat` 的错器械回归。

## 5. D5 最终验证命令与退出码

以下验证均在 `D:/dev/open-gym-ai-search-candidate-equipment` 执行：

| 命令 | 执行基线 | 退出码 | 结果摘要 |
|---|---|---:|---|
| `npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx` | 纯 D（未提交） | **1** | 63/67 通过；4 条继承自 B/C 的失败（D2 标记未通过，详见 §1.2） |
| `node frontend/scripts/ai-search-eval.mjs --mode replay --manifest ... --web-locale zh --include-queries --out .codex/ai-search-eval/candidate-equipment/d-diagnostic.json` | C + 未提交纯 D | **0** | 135/135，0 跳过，0 错误；Web/RN Top 5 均为 `106/133`（+17），错器械 0 新增 |
| `npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx` | `e514195f3`（D+冲突修复） | **0** | 3 文件 **68/68** 全过；golden **88/88**（english 47/47、chinese 22/22、ambiguous 6/6、conflict **3/3**、boundary 10/10、wrong-high 0） |
| `node frontend/scripts/ai-search-eval.mjs --mode replay --manifest ... --web-locale zh --include-queries --out .codex/ai-search-eval/candidate-equipment/d-conflict-fix.json` | `e514195f3`（D+冲突修复） | **0** | 135/135，0 跳过，0 错误；Web/RN Top 5 均为 `106/133`（+17），且两端错器械首位各减 1（Web `17/131`、RN `15/131`） |
| `npm.cmd --prefix frontend run test:ai-search-eval`（首次） | `e514195f3` | **1** | 仅基线既有 `REPLAY_SAMPLES = 10` vs 实际 `13` 断言失败（1 fail / 1 skip / 6 pass），按 D5 单独提交 `137ae0fc1` 同步为 `13` |
| `npm.cmd --prefix frontend run test:ai-search-eval`（修复后重跑） | `137ae0fc1` | **0** | **8/8** 全部通过（0 fail / 0 skip） |
| `npm.cmd --prefix frontend run build` | `e514195f3` | **0** | `vite build` 成功（481 modules transformed，built in 863ms） |
| `npm.cmd --prefix mobile-rn run check` | `e514195f3` | **0** | `eslint` 0 errors / 2 warnings、`lint:rules` 7/7、`tsc --noEmit` 0 errors、`design:check` OK（127/127） |
| `git diff --check` | `137ae0fc1` | **0** | 无空白/格式问题 |
