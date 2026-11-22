# AI 动作检索 P3 阶段评估与验收结果（RN 单端）

本文记录 P3（结构化姿势标签 + 标准别名表 + 去非语义后缀精确判定 + 跨部位冲突保护 + BM25 零结果兜底 + 补充排程修复）在独立 worktree（分支 `codex/ai-search-p3`，基于 `main` 基线 `45a33b107`）的实现提交、RN 单端（`platforms.rn`）离线/真机 e2e 实测数据、Stage 3（P3-C）单变量对照与回退依据，以及最终 Stage 4 全量回归验收证据。

---

## 1. 环境与代码提交矩阵

- **评测端**：`platforms.rn`（React Native Android 与共享 `frontend/src/lib/exercise-ai-search.js` / `exercise-search.js` / `exercise-bm25.js`）。
- **基线提交**：`45a33b107`（`docs(ai-search): add P2 retrieve-select execution plan and RN evaluation results`）。
- **最终代码 HEAD**：`8fa0b82a5`（不含 `.codex/` 局部评测缓存与 API 密钥）。

| 阶段 | 提交 | 改动内容 |
|---|---|---|
| **Stage 0 (P3-0)** | `766c56bd6` | 新增 `scripts/exercise-search-meta-overrides.json`、`scripts/generate-exercise-search-meta.mjs` 与 `frontend/src/lib/exercise-search-meta.json`；将标准别名与 8 类 `posture` 词条注入 `corpusOf`（`frontend/src/lib/exercise-search.js`）；同步服务端只读快照 `api/agent-runtime/tasks/exercise-search-catalogue.json`；新增 `frontend/src/lib/exercise-search-meta.test.js`、`docs/ai-exercise-search/eval/manifest-p3.json` 与 `docs/ai-exercise-search/test_pic/` 5 张新实拍图。 |
| **Stage 1 (P3-A)** | `9d5232182` | 在 `api/agent-runtime/exercise-search-diagnostics.js` 新增 `'body_part_conflict'` 过滤枚举（保持 `schemaVersion: 1`）；在 `frontend/src/lib/exercise-ai-search.js` 实现 `stripNonSemanticSuffix` 去括号精确判定、`COMPATIBLE_BODY_PARTS` 跨部位冲突拦截及本地 `inferCandidatePosture` / `postureMatch` 软排序。 |
| **Stage 2 (P3-B)** | `dad597737` | 在 `exercise-search-diagnostics.js` 新增 `'bm25'` 查询来源枚举（保持 `schemaVersion: 1`）；新增纯 JS `frontend/src/lib/exercise-bm25.js`（`WeakMap` 懒缓存 3 字段加权 BM25 + 短语改写 + `hasUnknownNonFitnessToken` 幻觉闸门）；仅在严格 AND 零命中且非冲突时触发 BM25 并封顶 `'medium'`。 |
| **补充修复 1** | `82e5e0551` | `frontend/src/lib/exercise-search.js` 新增 `+120` 精确标准别名加分，使 `lever seated chest press` 等精确别名稳定排在含多余变式词的条目之上（如 `0576` 排第 1）。 |
| **补充修复 2** | `8fa0b82a5` | `0198` 增补标准别名 `'cable lat pulldown'`；将 `compareRankedHits` 的姿势加分收窄为 `hintPostureMatch`（基于 `postureFromText(hintText)`），防止候选 1 名称中的 `坐姿` 意外反超候选 0 `0198`。 |
| **Stage 3 (P3-C)** | 已实测并单变量回退 | 在 `api/agent-runtime/tasks/exercise-search*.json/.js` 实验性增加可选 `candidate.posture`；因 3× 真实模型 e2e 聚合未达预设硬门槛（见第 6 节），已通过 `git checkout -- api/` 完整回退。 |

---

## 2. 元数据与姿势标注统计（Stage 4 `--check` 实测）

`node scripts/generate-exercise-search-meta.mjs --check` 与 `node scripts/sync-ai-search-catalogue.mjs --check` 在 `8fa0b82a5` 验证通过：

| 指标 | 数值 | 说明 |
|---|---|---|
| `EXDB` / 只读快照总条目 | `5,632` | `api/agent-runtime/tasks/exercise-search-catalogue.json` 保持完全同步 |
| `exercise-search-meta.json` 收录条目 | `2,796` | 覆盖带姿势标签及/或别名的动作条目（不修改 `exercises-data.js`） |
| 精补覆盖表 `exercise-search-meta-overrides.json` | `108` 条 | 聚焦商用固定器械与 `V13_IDS` 经典动作中英文健身房俗称 |
| 结构化 `posture` 覆盖总数 | `2,720` | `standing: 844`、`seated: 537`、`supine: 523`、`prone: 291`、`kneeling: 195`、`bent_over: 149`、`hanging: 141`、`side_lying: 40` |
| 标准别名条目 / 别名总条数 | `244` 条动作 / `446` 条别名 | 受 `exercise-search-meta.test.js`（4/4 通过）防碰撞与禁收宽泛词把关 |

---

## 3. 135 条历史基准与仓库 13 条离线回放（`platforms.rn`）

> 注：最终状态快照（`p3-final-135.json`、`p3-final-repo.json`、`new5-p3-final.json`）在工作区完成 `8fa0b82a5` 最终代码修改后、提交前瞬间运行录制（报告 JSON 内 `gitCommit` 记录当时父提交 `82e5e0551`，代码与目录状态与已提交 `8fa0b82a5` 一致）。

### 3.1 135 条离线回放分阶段对比

| 阶段 | 快照文件 | 命中 / 样本 | `Top 1` | `Top 5` | `Recall@5` | `WrongEq` | `FalsePositive` | `FallbackOnly` | `P50` | `P95` |
|---|---|---|---|---|---|---|---|---|---|---|
| Baseline (`45a33b107`) | `baseline-135.json` | `135/135` (`err=0`) | `95/133` | `110/133` | `120/133` | `20/132` | `0/2` | `3/135` | `43ms` | `111ms` |
| Stage 0 (`P3-0`) | `p3-0-135.json` | `135/135` (`err=0`) | `95/133` | `110/133` | **`121/133`** (`+1`) | `20/132` | `0/2` | `3/135` | `42ms` | `101ms` |
| Stage 1 (`P3-A`) | `p3a-135.json` | `135/135` (`err=0`) | `95/133` | `110/133` | `121/133` | `20/132` | `0/2` | `3/135` | `41ms` | `109ms` |
| Stage 2 (`P3-B`) | `p3b-135.json` | `135/135` (`err=0`) | `95/133` | `110/133` | `121/133` | `20/132` | `0/2` | `3/135` | `41ms` | `107ms` |
| Final (`8fa0b82a5` 代码) | `p3-final-135.json` | `135/135` (`err=0`) | `95/133` | `110/133` | `121/133` | `20/132` | `0/2` | `3/135` | `42ms` | **`110ms`** |

- 135 条中所有关键组均零退化，`prompt-a-hinted` 的 `Recall@5` 从 `14/15` 提升至 `15/15`，RN `P95` 从 `111ms` 微降至 `110ms`（远低于 `150ms` 红线）。

### 3.2 仓库 `manifest.json` 13 条回放（`skipped=5`）

| 阶段 | 命中 / 样本 | `Top 1` | `Top 5` | `Recall@5` | `WrongEq` | `FalsePositive` | `P50` | `P95` |
|---|---|---|---|---|---|---|---|---|
| `P3-A` (`p3a-repo.json`) | `13/13` (`skipped=5, err=0`) | `5/11` | `7/11` | `10/11` | `4/10` | `0/2` | `34ms` | `130ms` |
| `P3-B` (`p3b-repo.json`) | `13/13` (`skipped=5, err=0`) | `5/11` | `7/11` | `10/11` | `4/10` | `0/2` | `35ms` | `181ms` |
| Final (`p3-final-repo.json`) | `13/13` (`skipped=5, err=0`) | `5/11` | `7/11` | `10/11` | `4/10` | `0/2` | `31ms` | `180ms` |

---

## 4. 痛点专项单测与单样本行为验证（`exercise-ai-search.test.js`）

以下痛点场景全部由 `frontend/src/lib/exercise-ai-search.test.js`（54 个测试全过，含 `88/88` 黄金集）直接覆盖：

| 验证场景 | 输入形态 / 查询词 | Final (`8fa0b82a5`) 结果 | 验证依据 |
|---|---|---|---|
| **去非语义后缀精确升级** | `lever lying chest press`（`high`, `leverage machine`, `chest`） | 命中 `1041`，`level: 'high'` | `stripNonSemanticSuffix` 剥离 `(plate loaded)` |
| **语义变式括号保护** | 含 `(inner)` 等语义括号的名称 | 不被剥离为精确高置信，保留 `wrong-high = 0` | `exercise-ai-search.test.js` 单测 + 黄金集 `88/88` |
| **BM25 7 种近义表达召回 `1041`** | `lever lying bench press`、`lying lever bench press`、`plate loaded bench press`、`flat machine chest press`、`horizontal machine chest press`、`supine chest press`、`lever bench press` | **7/7** 命中 `1041`，均标记 `'bm25'`，置信度封顶 `'medium'` | `exercise-ai-search.test.js` lines 1775–1804 |
| **陌生词幻觉闸门拦截** | `levitating barbell bench press`、`quantum flux squat machine`、`plate of pasta`、`orbital prism contraption` | **4/4** 返回 `[]`（0 误报） | `exercise-ai-search.test.js` lines 1806–1816 |
| **零污染严格 AND 路径** | `杠铃卧推` / `barbell bench press`（`0025`） | 命中 `0025`（`high`），`queryOrigin: 'bm25'` 出现 `0` 次 | `exercise-ai-search.test.js` lines 1819–1835 |
| **跨部位冲突拦截** | `lever bench press`（`bodyPart: 'chest'`）误扫到 `1221`（`back` 耸肩） | 触发 `body_part_conflict` 拦截 `1221` | Stage 1 单测 + `new5-p3-a/final` 实测 |
| **精确标准别名排序修正** | `lever seated chest press`（`0576`） | `searchScored` 与 `AI.zh.match` 均置顶 `0576`（`high`） | `exercise-ai-search.test.js` lines 1837–1853 |
| **组合器械 Candidate 0 排序保序** | 候选 0 `cable lat pulldown`（`0198`）+ 候选 1 `坐姿绳索划船`（`0861`） | 保持 `['0198', '0861']`，`0198` `high` 居首 | `exercise-ai-search.test.js` lines 1855–1879 |

---

## 5. 新增 5 张器械图片（`manifest-p3.json`）RN 实测对照

`docs/ai-exercise-search/test_pic/` 新增 5 台器械各拆成 `hinted` 与 `photo-only` 共 `10` 条样本。

### 5.1 固定 VLM 输出离线回放（消除模型随机性，衡量纯本地检索迭代）

使用 `main` 上录制的 10 样本冻结 VLM 结构化输出（`new5-main-replay-10.json`；其中 `p3-photo-shoulder-press` 补入独立重采结果以凑齐 10/10 有效输入）：

| 阶段 | 快照文件 | `Top 1` | `Top 5` | `Recall@5` | `WrongEq` | `hinted` Top 1 | `photo-only` Top 1 | `P50` | `P95` | 关键变化 |
|---|---|---|---|---|---|---|---|---|---|---|
| Stage 0 (`P3-0`) | `new5-p3-0.json` | `4/10` | `4/10` | `6/10` | `2/10` | `3/5` | `1/5` | `66ms` | `86ms` | `p3-hinted-lying-chest-press` 仍错中 `1221`（`rank=17`）；`p3-photo-chest-fly` 中 `0602` |
| Stage 1 (`P3-A`) | `new5-p3-a.json` | **`5/10`** | `5/10` | `6/10` | `2/10` | `3/5` | **`2/5`** | `62ms` | `88ms` | `body_part_conflict` 拦截 `1221`；`p3-photo-chest-fly` 从 `0602` 翻正为 `1030`（`Top 1`） |
| Stage 2 (`P3-B`) | `new5-p3-b.json` | **`6/10`** | **`6/10`** | **`7/10`** | `2/10` | **`4/5`** | `2/5` | `63ms` | `104ms` | **`p3-hinted-lying-chest-press` 经 `'bm25'` 从 `rank=17` 一举翻正为 `1041` (`Top 1`)** |
| Final (`8fa0b82a5`) | `new5-p3-final.json` | `6/10` | `6/10` | `7/10` | `2/10` | `4/5` | `2/5` | **`60ms`** | `108ms` | `0198` `hinted` 与 `photo-only` 均稳定 `Top 1` |

### 5.2 真实模型 Live E2E 对比（`manifest-p3.json` 新增 10 样本）

| 运行版本 | 模式 | 有效样本 | `Top 1` | `Top 5` | `Recall@5` | `WrongEq` | 典型观察 |
|---|---|---|---|---|---|---|---|
| `main` 基线 (`new5-main-baseline.json`) | Live E2E | `9`（`p3-photo-shoulder-press` 上游 `model_unavailable`） | `4/9` (`H 3/5, P 1/4`) | `4/9` | `6/9` | `1/9` | `p3-hinted-lying-chest-press` 误中 `1221` |
| Stage 0–2 保留代码 (`new5-p3-e2e.json`) | Live E2E | `9`（`p3-photo-chest-press` 遇到 `model_unavailable`） | `3/9` (`H 3/5, P 0/4`) | `4/9` | `5/9` | `3/9` | `p3-hinted-lying-chest-press` 经 `'bm25'` 首选命中 **`1041` (`Top 1`)**；`photo-only` 受上游识别为 `upper arms`/`back` 等 VLM 波动影响较大 |
| Stage 3 实验对比 (`new5-p3c-e2e.json`，已回退 `api/`) | Live E2E | `10/10` | **`8/10`** (`H 4/5, P 4/5`) | `8/10` | `8/10` | `1/10` | 给出 `candidate.posture="supine"` 时，**`p3-hinted-lying-chest-press` 与 `p3-photo-lying-chest-press` 双双 `Top 1` 命中 `1041`**，且 `photo-chest-fly` 命中 `1030` |

---

## 6. Stage 3（P3-C）3× 真实模型 E2E 对照与单变量回退结论

为验证 Prompt/Schema 增加可选 `candidate.posture` 是否能稳定跨过门槛，按 `P3_METADATA_BM25_EXECUTION.md` 第 6 节在原 `manifest.json`（`--group hinted --group photo-only --web-locale zh`，每轮 10 样本）运行 3 次真实模型 e2e：

| 轮次 | 有效样本 | `Top 1` | `Top 5` | `Recall@5` | `WrongEq` | `hinted` Top 1 | `photo-only` Top 1 | Posture 填充覆盖 | 视觉延迟 `P50 / P95` |
|---|---|---|---|---|---|---|---|---|---|
| `p3c-rep1`（`82e5e0551` 重放评估；`rep1` 初采 `8/10` 后合入 `82e5e0551` 升至 `9/10`） | `10/10` | `9/10` | `9/10` | `9/10` | `0/10` | `5/5` | `4/5` | `10/10` 样本（`22/22` 候选：`seated: 14, standing: 8`） | `6978ms / 13783ms` |
| `p3c-rep2`（`82e5e0551` 重放与实时一致） | `10/10` | `9/10` | `9/10` | `9/10` | `1/10` | `5/5` | `4/5` | `9/10` 样本（`20/23` 候选：`seated: 15, standing: 4, bent_over: 1`） | `7503ms / 22208ms` |
| `p3c-rep3`（`82e5e0551` Live E2E） | `9/10`（`photo-shoulder-press` `model_unavailable`） | `7/9` | `7/9` | `8/9` | `2/9` | `5/5` | `2/4` | `6/9` 样本（`14/23` 候选：`seated: 14`） | `7858ms / 27565ms` |
| **3× 聚合（基于 `82e5e0551`）** | **`29/30`** | **`25/29`** | **`25/29`** | `26/29` | **`3/29`** | **`15/15`** | `10/14` | **`25/29` 样本（`56/68` 候选）** | 3/3 Top-1 一致率 `7/10` |

**保留门槛对照与回退决定**：
- **预设硬门槛**：`hinted = 15/15`、3× 聚合 `Top 1 ≥ 25/30`、**`Top 5 ≥ 29/30`**、**`WrongEq ≤ 1/30`**、`photo-only` Top 1 ≥ `10/15`。
- **实际判定**：虽然在新增 5 图上 `new5-p3c-e2e` 取得了 `8/10`（包括纯图 `1041` 命中），且 3× 对照 `hinted` 维持 `15/15`、`3/3` 一致率 `7/10`，但 3× 聚合 `Top 5 = 25/29`（低于 `29/30` 门槛）且 `WrongEq = 3/29`（超过 `1/30` 门槛），同时 `rep3` 出现 1 例上游 `model_unavailable`。严格遵循单变量回退原则，执行 `git checkout -- api/` 完整回退 Stage 3 的 Prompt/Schema/词表改动，完整保留 Stage 0–2 与 `82e5e0551`/`8fa0b82a5` 本地收益。

---

## 7. Stage 4 最终全量回归与静态检查汇总（在 `8fa0b82a5` 执行）

| 检查项 | 命令 | 结果摘要 | 退出码 |
|---|---|---|---|
| 元数据一致性自检 | `node scripts/generate-exercise-search-meta.mjs --check` | `entries=2796, posture=2720, withAliases=244, aliases=446` | `0` |
| 服务端词表/目录快照同步检查 | `node scripts/sync-ai-search-catalogue.mjs --check` | `up to date (5632 entries)` | `0` |
| API 构建 | `npm.cmd --prefix api run build` | `build: dist ready` | `0` |
| API 单元与诊断合同回归 | `node --test api/test/agent-exercise-search.test.js api/test/agent-providers.test.js api/test/agent-runtime.test.js api/test/exercise-search-diagnostics.test.js` | `78/78` 通过（`0` fail, `0` skip） | `0` |
| API Nest 集成测试 | `npm.cmd --prefix api run test:nest -- test/nest/agent.test.js test/nest/agent-exercise-search.test.js` | `13/13` 通过（`0` fail, `0` skip） | `0` |
| Frontend 单测 + Golden 88 | `npm.cmd --prefix frontend test -- src/lib/exercise-search-meta.test.js src/lib/exercise-ai-search.test.js src/lib/exercise-search-rn.test.js src/lib/library-search-rn.test.ts src/lib/exercises.test.js src/components/ExerciseAiSearch.test.jsx` | `6` 个文件 `122/122` 通过（含 `ai-golden 88/88`、`english 47/47`、`chinese 22/22`、`ambiguous 6/6`、`conflict 3/3`、`boundary 10/10`、`wrong-high: 0`） | `0` |
| Eval CLI 工具测试 | `npm.cmd --prefix frontend run test:ai-search-eval` | `8/8` 通过（`0` fail, `0` skip） | `0` |
| Frontend 生产构建 | `npm.cmd --prefix frontend run build` | `vite build` 成功（483 modules） | `0` |
| Mobile-RN 全套静态检查 | `npm.cmd --prefix mobile-rn run check` | `eslint` `0` errors（`2` 条既有 `PlanScreen.tsx`/`StatsScreen.tsx` array-index-key warnings）；`lint:rules` `7/7` 通过；`tsc --noEmit` 通过；`design:check` `127/127` | `0` |
| Diff 空白/格式检查 | `git diff --check` | 无尾随空白/冲突标记错误 | `0` |
