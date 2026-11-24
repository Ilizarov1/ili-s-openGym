# AI 动作检索 `v2` 优化与评测交接文档（`HANDOFF`）

> 关联文档：[设计方案](DESIGN.md) · [执行记录](EXECUTION.md) · [基线对比报告](COMPARISON_REPORT.md) · [子系统路由](../../../../docs/subsystem/ai-agent/README.md)

## 1. 工作区与资产地图

| 位置 | 分支 / 角色 | 关键路径与说明 |
|---|---|---|
| `D:\dev\open-gym` | 主仓（样本与文档） | [test_pic/](../../../../test_pic/)（32 样本固定器械集：`benchmark.json` + 5 份 `manifest-*.json`，已清零宽空格）；`.agent/notes/proposed/ai-search-eval-v2/` 全部方案与对比报告 |
| `D:\wt\og-retrieval` | `codex/server-retrieval`（`v2` 实现与评测器） | `api/src/agent/retrieval/retrieval.service.ts`（已放开 `topOf` 75/75/30）、`api/src/agent/retrieval/catalogue.ts`、`frontend/scripts/ai-search-eval*.mjs`（支持 `--benchmark`、`--include-server-v2`、`ai-search-eval-compare.mjs`） |
| `D:\dev\.tools\opengym-retrieval` | 本机依赖与外置评测档案（不入库） | PG `127.0.0.1:55432`、ROCm BGE `127.0.0.1:8765`（`BAAI/bge-m3` + `bge-reranker-v2-m3`）、`retrieval.env`（含 `DEEPSEEK_API_KEY`）、`eval-runs\v1-vs-v2\` 下保存 4 档冻结 `*-replay.json` 与 `*-report.json` |

---

## 2. 本轮基线对比实测结果（Paired Single-VLM，零误差）

同一次 `deepseek-flash` VLM 输出同时评测 `v1 (rn)` 与 `v2 (server_v2)`，`Top-5` 对 `v2` 强制截断前 5 项保公平；`RRF 首名` 为 `v2` 经文本 Top-75 + 向量 Top-75 融合后、送入 Cross-Encoder 精排前的首位命中率：

| 数据集 / 梯度 (样本) | `v1` Top-1 / Top-5 / Wrong-High | **`v2` 精排前 RRF 首名 / RRF@30** | **`v2` 精排后 Top-1 / Top-5 / Top-10** | `v2` Wrong-High / BadImage-FP | 延迟 P50 (`v1` vs `v2` / Rerank) |
|---|---|---|---|---|---|
| `photo-only` (32) | `9/25 (36.0%)` / `13/25 (52.0%)` / `7/32 (21.9%)` | `6/25 (24.0%)` / `16/25 (64.0%)` | **`2/25 (8.0%)`** / `4/25 (16.0%)` / `8/25 (32.0%)` | `16/32 (50.0%)` / `5/6 (83.3%)` | `66ms` vs `2260ms` (`2135ms`) |
| `simple` (32) | `19/25 (76.0%)` / `19/25 (76.0%)` / `5/32 (15.6%)` | `18/25 (72.0%)` / `22/25 (88.0%)` | **`3/25 (12.0%)`** / `8/25 (32.0%)` / `13/25 (52.0%)` | `23/32 (71.9%)` / `5/6 (83.3%)` | `51ms` vs `2276ms` (`2081ms`) |
| `alias` (32) | `21/25 (84.0%)` / `21/25 (84.0%)` / `4/32 (12.5%)` | `17/25 (68.0%)` / **`25/25 (100%)`** | **`9/25 (36.0%)`** / `13/25 (52.0%)` / `16/25 (64.0%)` | `18/32 (56.3%)` / `5/6 (83.3%)` | `61ms` vs `2399ms` (`2218ms`) |
| `detailed` (32) | `18/25 (72.0%)` / `21/25 (84.0%)` / `5/32 (15.6%)` | **`19/25 (76.0%)`** / **`25/25 (100%)`** | **`5/25 (20.0%)`** / `12/25 (48.0%)` / `16/25 (64.0%)` | `22/32 (68.8%)` / `5/6 (83.3%)` | `61ms` vs `2572ms` (`2408ms`) |
| `repo13` 回放 (13) | `5/11 (45.5%)` / `7/11 (63.6%)` / `0/13 (0.0%)` | **`8/11 (72.7%)`** / **`11/11 (100%)`** | **`2/11 (18.2%)`** / `7/11 (63.6%)` / `7/11 (63.6%)` | `6/13 (46.2%)` / `FP 1/2` | `34ms` vs `1635ms` (`1499ms`) |

> 注：本轮 4 档 `BadImage-FP` 均为 `5/6 (83.3%)`（VLM 仅在 `machine_032` 天花板图短路）；`v1` 的 `high` 档准确率 `41.7%–76.5%`，而 `v2` 的 `high` 档准确率仅 `5.9%–33.3%`。

---

## 3. 核心归因定位（精确到源码位置）

1. **多路召回 + RRF 已跑通，唯一严重掉点在 Cross-Encoder `rerankQuery` 缺失动作名称**：
   - `RetrievalService.retrieve`（`D:\wt\og-retrieval\api\src\agent\retrieval\retrieval.service.ts` L91–L92）构造 `rerankQuery` 时，只拼了 `hintText` + `fallback.understanding` + `equipment/bodyPart/posture` slug 列表，**遗漏了 VLM 识别的动作名 `candidates[i].name` 与 `nameEn`**（而 `textRecall` L55 和 `vectorQuery` L65 都带了）。
   - 结果 `bge-reranker-v2-m3` 面对整段描述与长 `rerank_text`（`catalogue.ts` L97 含英文 description/instructions）发生普遍打分饱和（`0.994–0.9999`），长描述偏门变式（如 `11567`、`5815`、`1598`、`2277`）反超了已在 `RRF #1` 的标准主动作（`0576`、`1299`、`0599`、`0770`）。
2. **`high / medium / low` 置信度硬编码阈值在饱和分数下彻底过自信**：
   - `retrieval.service.ts` L111 直接用 `score >= 0.8 => high`、`>= 0.5 => medium`。在 `alias`/`detailed` 中，错判正例的 `top1Score` 中位数达 `0.995–0.999`，直接导致 `Wrong-High` 飙升至 `50.0%–71.9%`。
3. **无 Score Floor 与服务端消歧兜底缺失**：
   - `retrieval.service.ts` 仅当 `candidates.length === 0` 时短路；其余 `bad_image`/`near_ood` 即使低分（如 `0.082–0.456`）仍强制吐出 10 条结果；背景器械命中时更会出现 `0.9997` 误报（`machine_028`）。
   - `v2` L114 直接透传 `recognition.clarifications`，未复用 `v1` 的 `deriveClarificationChips()` 兜底；且错标为 `high` 后，`hard_confusing` 组“消歧且非 high”率（`clarificationNoHigh`）跌为 `0/9`（`v1` 为 `4/9`–`6/9`）。
4. **单步精排延迟过高**：`bge-reranker-v2-m3` 对 30 条长文本打分单步 P50 `2.08–2.41s`（占 `v2` 后处理 ~92%）。

---

## 4. 下一会话优化路线（按 P0 → P1 单变量迭代）

- **P0.1 修复 `rerankQuery` + `RRF/Rerank` 融合排序（`retrieval.service.ts`、`catalogue.ts`）**：
  - 将 `candidates` 的 `nameEn`/`name` 放在 `rerankQuery` 首位，缩减 `fallback.understanding` 与 `rerank_text` 的冗余描述噪声（注意若改 `rerank_text` 模板需重跑 `build-retrieval-index.mjs --rebuild`）。
  - 评估 **RRF 排名与 Cross-Encoder 分数联合排序**（例如保留名次倒数或加权融合，避免精排单独掀翻高共识的 `RRF #1`）；可同步做消融对照：**无 Rerank（纯 RRF）vs 修复后 Rerank**。
- **P0.2 重标 `high / medium / low` 置信度门限（`retrieval.service.ts` L111）**：
  - 结合 `top1 - top2` Score Margin、RRF 一致性与名称/器械/部位线索联合判定 `high`，对无精确名称匹配或 `hard_confusing` 封顶 `medium`，目标将 `Wrong-High` 压回 `< 5%`（理想 `0%`）。
- **P1.1 增加 Rerank Score Floor 与服务端消歧对齐**：
  - 当首项分数及 RRF 信号均低于门限时回落为 `rankedIds: []` + `fallback` 理解，降低废片/OOD 误报；评估在 `v2` 复用共享消歧逻辑以恢复 `clarificationNoHigh`。
- **P1.2 压缩精排候选池与延迟**：候选池从 `30` 收窄至 `15–20`（核对 `Fusion Recall@20` 无损）并缩短文本，目标 `rerankMs` P50 `< 1000ms`。

---

## 5. 下一会话直接上手命令（免调 VLM 零成本回放复测）

```powershell
# 1. 启动/检查 D:\wt\og-retrieval 依赖（55432 PG + 8765 ROCm BGE）
Set-Location D:\wt\og-retrieval
.\scripts\windows\Start-Retrieval.ps1 -RuntimeRoot D:\dev\.tools\opengym-retrieval
Invoke-RestMethod http://127.0.0.1:8765/health

# 2. 改完 api/src/agent/retrieval/ 后先过编译与单测门禁
npm.cmd --prefix api run build
node --test api/test/retrieval.service.test.js api/test/exercise-search-diagnostics.test.js api/test/agent-exercise-search.test.js
npm.cmd --prefix frontend run test:ai-search-eval

# 3. 用已冻结的 4 档 *-replay.json 零 VLM 成本秒级复测 v1 vs v2（按索引 0..31 挂接 replay）
$runDir = 'D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2'
$outDir = 'D:\dev\.tools\opengym-retrieval\eval-runs\v1-vs-v2-iter1'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
foreach ($tier in @('photo-only', 'simple', 'alias', 'detailed')) {
  $m = Get-Content "D:\dev\open-gym\test_pic\manifest-$tier.json" -Raw | ConvertFrom-Json
  $replayAbs = "$runDir\$tier-replay.json"
  for ($i = 0; $i -lt $m.samples.Count; $i++) {
    $m.samples[$i] | Add-Member -NotePropertyName replay -NotePropertyValue @{ path = $replayAbs; index = $i } -Force
  }
  $tmpManifest = "$outDir\replay-manifest-$tier.json"
  [IO.File]::WriteAllText($tmpManifest, ($m | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
  node --env-file=D:\dev\.tools\opengym-retrieval\retrieval.env frontend/scripts/ai-search-eval.mjs --mode replay --manifest $tmpManifest --benchmark D:\dev\open-gym\test_pic\benchmark.json --include-server-v2 --out "$outDir\$tier-report.json"
}

# 4. 生成迭代前后对比报告（含 repo13 回放）
node frontend/scripts/ai-search-eval-compare.mjs --input "photo-only=$outDir\photo-only-report.json" --input "simple=$outDir\simple-report.json" --input "alias=$outDir\alias-report.json" --input "detailed=$outDir\detailed-report.json" --baseline rn --out-md "$outDir\ITER1_COMPARISON.md"
```

### 下轮验收门槛（相对本轮基线与 `v1`）
- `simple` / `alias` / `detailed` 档 `v2` `Top-1` 与 `Top-5` 净胜 `v1`（`alias` / `detailed` `Top-1 >= 84%`，`photo-only` 不低于 `v1` `36%`）；
- `Wrong-High` 压降至 `<= 1/32`（理想 `0`），`BadImage-FP` 与 `NearOOD-FP` 明显下降；`hard_confusing` `clarificationNoHigh` 恢复；`v2` 延迟 P50 `<= 1200ms`。
