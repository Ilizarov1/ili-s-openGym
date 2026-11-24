# AI 动作检索 P1（本地召回补强）验收记录（RN 单端）

状态：Stage 1（P1-A）与 Stage 3（P1-C）已达硬门槛并独立提交保留；Stage 2（P1-B）经单元测试与 135 条冻结回放验证未达保留门槛，已按单变量原则 `git checkout --` 完整回退，并保留失败对照数据于本地 `.codex/ai-search-eval/p1/`。所有开发、评测与验收均在独立 worktree `D:\dev\open-gym-ai-search-p1`（分支 `codex/ai-search-p1`）完成，主工作区保持干净未改动。

## 1. 环境与基线

| 项 | 实际值 |
|---|---|
| 基线起点（`main`） | `0306fcae0cb49d94b6cd894f03a56eb5046062b8` |
| Worktree / 分支 | `D:\dev\open-gym-ai-search-p1` / `codex/ai-search-p1` |
| `catalogueSha256` | `99add164cbdd8396efb48672fe865d7cd97b487a65c365a270c294cd72825f96` |
| 保留提交（Stage 1 / P1-A） | `fafa48564` — `feat(ai-search): P1-A enable nameEn query across languages and structured candidate query selection` |
| 回退阶段（Stage 2 / P1-B） | 受控查询松弛 + `lying`/`stack` 变体识别 + `queryOrigin: 'relaxed'`（未提交，已 `git checkout --` 完整回退） |
| 保留提交（Stage 3 / P1-C） | `6fc84f294` — `feat(ai-search): P1-C expand gym synonyms and add fixed-machine vs free-weight conflict matrix` |
| 135 条配对清单 | `p1-m1-paired-manifest.json`（133 正例 + 2 空例，`skippedIds: []`，`sampleErrors: 0`） |
| P0-B 3× 真实响应清单 | `.codex/ai-search-eval/p1/p0b-30-manifest.json`（由 `docs/ai-exercise-search/eval/manifest.json` 的 `hinted` + `photo-only` 10 场景组合 `t1-p0b-{1,2,3}-replay.json` 生成，共 30 条） |
| 仓库固定回放清单 | `docs/ai-exercise-search/eval/manifest.json`（`mode=replay`，13 条可执行 + 5 条跳过） |
| 原始产物位置 | `.codex/ai-search-eval/p1/`（git 忽略，不提交） |

---

## 2. 135 条冻结回放 RN 逐阶段总表

### 2.1 总体指标与 P1 / 历史样本拆分（RN）

| 范围 | 指标 | 基线（`0306fcae0`） | P1-A（`fafa48564`） | P1-B（已回退） | P1-C（`6fc84f294`，最终保留） | 最终相对基线 |
|---|---|---|---|---|---|---|
| **全部 135 条** | Top 1 | `92/133` (69.2%) | **`95/133`** (71.4%) | `98/133` (73.7%) | **`95/133`** (71.4%) | **+3** (+2.2pp) |
| **全部 135 条** | Top 5 | `106/133` (79.7%) | **`110/133`** (82.7%) | `112/133` (84.2%) | **`110/133`** (82.7%) | **+4** (+3.0pp) |
| **全部 135 条** | Recall@5 | `116/133` (87.2%) | **`120/133`** (90.2%) | `122/133` (91.7%) | **`120/133`** (90.2%) | **+4** (+3.0pp) |
| **全部 135 条** | 错器械首位 | `21/131` (16.0%) | `20/132` (15.2%) | `21/132` (15.9%) | **`20/132`** (15.2%) | **-1** (-0.8pp) |
| **全部 135 条** | 空结果误报 | `0/2` | `0/2` | `0/2` | **`0/2`** | `0` |
| **全部 135 条** | 仅兜底（FallbackOnly） | `4/135` | `3/135` | `3/135` | **`3/135`** | **-1** |
| **全部 135 条** | Latency P50 / P95 | `41ms / 120ms` | `45ms / 104ms` | `43ms / 120ms` | **`42ms / 109ms`** | `+1ms / -11ms` |
| **P1 现行样本（90 条）** | Top 1 | `72/90` (80.0%) | **`74/90`** (82.2%) | `74/90` (82.2%) | **`74/90`** (82.2%) | **+2** (+2.2pp) |
| **P1 现行样本（90 条）** | Top 5 | `78/90` (86.7%) | **`81/90`** (90.0%) | `81/90` (90.0%) | **`81/90`** (90.0%) | **+3** (+3.3pp) |
| **P1 现行样本（90 条）** | Recall@5 | `79/90` (87.8%) | **`82/90`** (91.1%) | `82/90` (91.1%) | **`82/90`** (91.1%) | **+3** (+3.3pp) |
| **P1 现行样本（90 条）** | 错器械首位 | `7/90` (7.8%) | `6/90` (6.7%) | `6/90` (6.7%) | **`6/90`** (6.7%) | **-1** (-1.1pp) |
| **P1 前历史样本（45 条）** | Top 1 | `20/43` (46.5%) | `21/43` (48.8%) | `24/43` (55.8%) | **`21/43`** (48.8%) | **+1** (+2.3pp) |
| **P1 前历史样本（45 条）** | Top 5 | `28/43` (65.1%) | `29/43` (67.4%) | `31/43` (72.1%) | **`29/43`** (67.4%) | **+1** (+2.3pp) |
| **P1 前历史样本（45 条）** | Recall@5 | `37/43` (86.0%) | `38/43` (88.4%) | `40/43` (93.0%) | **`38/43`** (88.4%) | **+1** (+2.4pp) |
| **P1 前历史样本（45 条）** | 错器械首位 / 空结果误报 | `14/41` / `0/2` | `14/42` / `0/2` | `15/42` / `0/2` | **`14/42` / `0/2`** | `0` / `0` |

### 2.2 按分组对照（RN）

| 分组 | Top 1（基线 → P1-A → P1-B[回] → P1-C） | Top 5（基线 → P1-A → P1-B[回] → P1-C） | Recall@5（基线 → P1-A → P1-B[回] → P1-C） | 错器械首位（基线 → P1-A → P1-B[回] → P1-C） |
|---|---|---|---|---|
| `hinted` | `2/5 → 2/5 → 2/5 → 2/5` | `3/5 → 3/5 → 3/5 → 3/5` | `5/5 → 5/5 → 5/5 → 5/5` | `3/5 → 3/5 → 3/5 → 3/5` |
| `edge` | `1/3 → 2/3 → 2/3 → 2/3` | `1/3 → 2/3 → 2/3 → 2/3` | `2/3 → 3/3 → 3/3 → 3/3` | `0/1 → 0/2 → 0/2 → 0/2` |
| `quality-regression` | `1/3 → 1/3 → 2/3 → 1/3` | `2/3 → 2/3 → 3/3 → 2/3` | `2/3 → 2/3 → 3/3 → 2/3` | `1/3 → 1/3 → 1/3 → 1/3` |
| `final-hinted` | `15/15 → 15/15 → 15/15 → 15/15` | `15/15 → 15/15 → 15/15 → 15/15` | `15/15 → 15/15 → 15/15 → 15/15` | `0/15 → 0/15 → 0/15 → 0/15` |
| `final-photo-only` | `8/15 → 9/15 → 9/15 → 9/15` | `9/15 → 10/15 → 10/15 → 10/15` | `9/15 → 10/15 → 10/15 → 10/15` | `3/15 → 3/15 → 3/15 → 3/15` |
| `prompt-a-hinted` | `9/15 → 9/15 → 9/15 → 9/15` | `10/15 → 10/15 → 10/15 → 10/15` | `14/15 → 14/15 → 14/15 → 14/15` | `6/15 → 6/15 → 6/15 → 6/15` |
| `prompt-a-photo-only` | `6/15 → 6/15 → 7/15 → 6/15` | `10/15 → 10/15 → 11/15 → 10/15` | `12/15 → 12/15 → 13/15 → 12/15` | `4/15 → 4/15 → 5/15 → 4/15` |
| `prompt-b-hinted` | `14/15 → 15/15 → 15/15 → 15/15` | `14/15 → 15/15 → 15/15 → 15/15` | `14/15 → 15/15 → 15/15 → 15/15` | `0/15 → 0/15 → 0/15 → 0/15` |
| `prompt-b-photo-only` | `10/15 → 10/15 → 10/15 → 10/15` | `12/15 → 13/15 → 13/15 → 13/15` | `12/15 → 13/15 → 13/15 → 13/15` | `2/15 → 1/15 → 1/15 → 1/15` |
| `q1-control-hinted` | `14/15 → 14/15 → 14/15 → 14/15` | `14/15 → 14/15 → 14/15 → 14/15` | `15/15 → 15/15 → 15/15 → 15/15` | `1/15 → 1/15 → 1/15 → 1/15` |
| `q1-control-photo-only` | `11/15 → 11/15 → 11/15 → 11/15` | `14/15 → 14/15 → 14/15 → 14/15` | `14/15 → 14/15 → 14/15 → 14/15` | `1/15 → 1/15 → 1/15 → 1/15` |
| `original-chest` | `1/2 → 1/2 → 2/2 → 1/2` | `2/2 → 2/2 → 2/2 → 2/2` | `2/2 → 2/2 → 2/2 → 2/2` | `0/2 → 0/2 → 0/2 → 0/2` |

---

## 3. 逐样本增退与各阶段保留/回退判定

### 3.1 Stage 1（P1-A，保留 `fafa48564`）逐样本变化

- **Top 1 / Top 5 / Recall@5 净增**：Top 1 `+3`（`92 → 95`）、Top 5 `+4`（`106 → 110`）、Recall@5 `+4`（`116 → 120`），零样本退化。
- **关键救回样本（4 例 Top 5 / 3 例 Top 1 + 1 例错器械改善）**：
  - `edge-french-chest-press`：`[] → ["0576"]`（Top 1 `false → true`，Top 5 `false → true`，法语名启用 `nameEn`）
  - `final-1-photo-shoulder-press`：`["1041","2659"] → ["0603","1299"]`（Top 1 `false → true`，Top 5 `false → true`，英文口语 `plate-loaded shoulder press` 启用 `nameEn: "lever shoulder press"`）
  - `prompt-b-2-hinted-chest-press`：`["10671","1299"] → ["0576","1299"]`（Top 1 `false → true`，Top 5 `false → true`，`nameEn: "lever chest press"` 启用并按 `unsupportedVariants` 胜过含 `stack` / `incline` 的 `primary` 命中）
  - `prompt-b-2-photo-shoulder-press`：`["1041"] → ["0576","0603"]`（Top 5 `false → true`，Recall@5 `false → true`）
  - `prompt-b-3-photo-chest-press`：`["0088"] → ["0594"]`（错器械首位 `true → false`，`barbell seated calf raise` → `lever seated calf raise`）
- **其他列表微调（Top 1 / Top 5 / WrongEq 均守恒）**：
  - `final-1-hinted-leg-press`：`["0739","2287"] → ["0739"]`
  - `final-1-photo-hack-squat`：`["0581"] → ["0606","0581"]`
  - `final-3-photo-hack-squat`：`["0743","1583","1383"] → ["0743","1583","0742"]`
  - `prompt-b-1-photo-hack-squat`：`["9698","1237","1350"] → ["11762","0581","1350"]`
  - `prompt-b-2-photo-chest-press`：`["1030","0576"] → ["0596","0602","0576"]`
  - `prompt-b-3-photo-hack-squat`：`["0743","0739"] → ["0743","2746","0739"]`
  - `q1-control-1-photo-hack-squat`：`["1350","9698","0739"] → ["2664","11762","0739"]`
  - `q1-control-2-photo-chest-press`：`["1030","0576"] → ["1030","0576","5527"]`
- **保留判定**：满足 Stage 1 全部硬门槛（135 条 Top 1 `+3 ≥ +3`、Top 5 `+4 ≥ +3`、Recall@5 `+4 ≥ +3`、4 个点名样本全部命中、P1-90 零退化、错器械首位下降、空结果 `0/2`、`88/88` golden 通过、`wrong-high = 0`、P0-B 30 零退化），独立提交保留。

### 3.2 Stage 2（P1-B，未达保留门槛，已回退）

- **135 条对照（相对 P1-A `fafa48564`）**：
  - Top 1 `95/133 → 98/133`（**+3**，未达到硬门槛 **≥ +4**）；
  - Top 5 `110/133 → 112/133`（**+2**，未达到硬门槛 **≥ +3**）；
  - Recall@5 `120/133 → 122/133`（+2）；
  - 错器械首位 `20/132 → 21/132`（**+1 退化**：`prompt-a-3-photo-shoulder-press` 原候选 `plate loaded shoulder press` 缺 `candidate.equipment`，松弛为 `shoulder press` 后选中同分排序靠前的 `0219 cable shoulder press`，替代原 `1041 lever lying chest press`）；
  - P1 现行 90 条与 P0-B 30 条均 **+0**；
  - 仅救回 3 例历史/合成样本（`quality-no-recall-chest` `10671 → 0576`、`prompt-a-2-photo-chest-press` `1041 → 0576`、`my-model-chest-hinted-chest-press` `10671 → 0576`）；
  - **未救回其余点名样本**：`hinted-chest-press`、`prompt-a-3-hinted-chest-press` 因 pre-P1 历史回放无 `candidate.equipment` 且 `2144 cable seated chest press` 本身含 `seated` 且 `unsupportedVariants === 0`，`isCleanQueryHit` 为真而未进入松弛；`final-3-photo-leg-press` 因 VLM 候选 0 本身给出 `equipment: "leverage machine"` 并干净命中 `2267 lever seated leg press` 而未进入松弛；
  - **边界单测失败**：`"seated machine"` 在 `primary` 阶段即因 `'seated'` 不在 `BROAD_WORDS` 而命中 `1452 lever seated crunch`（未保持空结果）。
- **回退判定**：严格按单变量与止损原则拒绝临时凑分，执行 `git checkout --` 完整回退所有 Stage 2 改动，仅保留 `.codex/ai-search-eval/p1/p1b-*.json` 对照数据用于本报告记录。

### 3.3 Stage 3（P1-C，保留 `6fc84f294`）

- **正向改动**：
  1. `frontend/src/lib/exercise-search.js` `SYNONYMS` 增补 14 条商业器械与连写词同义词（`selectorized`、`pinloaded`、`plateloaded`、`converging`、`isolateral`、`pecdeck`、`tbar`、`latpulldown`、`chestpress`、`shoulderpress`、`legpress`、`legextension`、`legcurl`、`hipthrust`）。
  2. `frontend/src/lib/exercise-ai-search.js` `conflictFor` 升级为分族器械硬冲突矩阵：保留 `MACHINE_HINTS` vs `BODYWEIGHT`，新增 `FIXED_MACHINES` ↔ `FREE_WEIGHTS` 双向硬冲突；实测确认反向 `BODYWEIGHT` 拦截 `FIXED_MACHINES` / `FREE_WEIGHTS` 在 `88/88` golden、135 条回放、13 条仓库回放与 30 条 P0-B 回放中均**零误杀**，予以一并启用；保持 `leverage machine` ↔ `sled machine`、`barbell` 族、`cable` ↔ `FIXED_MACHINES` 兼容。
- **回放对照（相对 P1-A `fafa48564`）**：
  - 135 条指标完全守恒无退化（Top 1 `95/133`、Top 5 `110/133`、Recall@5 `120/133`、WrongEq `20/132`、FalsePositive `0/2`）；
  - 逐样本变化 1 例：`final-3-photo-leg-press` `["2267","0088"] → ["2267"]`，候选 1 请求 `leverage machine` 时硬冲突拦截误召回的 `0088 barbell seated calf raise`；
  - 常规搜索与 AI 检索全套单测 100% 通过，`88/88` golden 通过、`wrong-high = 0`。
- **保留判定**：满足 Stage 3 全部硬门槛，独立提交保留。

---

## 4. P0-B 3× 真实模型响应（30 条）回放对照（RN）

| 范围 | 指标 | 基线（`0306fcae0`） | P1-A（`fafa48564`） | P1-B（已回退） | P1-C（`6fc84f294`，最终保留） |
|---|---|---|---|---|---|
| **3× 合计（30 条）** | Top 1 / Top 5 / Recall@5 | `25/30` (83.3%) / `29/30` (96.7%) / `29/30` (96.7%) | `25/30` / `29/30` / `29/30` | `25/30` / `29/30` / `29/30` | **`25/30`** (83.3%) / **`29/30`** (96.7%) / **`29/30`** (96.7%) |
| **3× 合计（30 条）** | 错器械首位 / Latency P50 / P95 | `1/30` (3.3%) / `35ms / 90ms` | `1/30` / `43ms / 72ms` | `1/30` / `42ms / 76ms` | **`1/30`** (3.3%) / **`36ms / 71ms`** |
| **Hinted（15 条）** | Top 1 / Top 5 / 错器械首位 | `15/15` (100.0%) / `15/15` / `0/15` | `15/15` / `15/15` / `0/15` | `15/15` / `15/15` / `0/15` | **`15/15`** (100.0%) / **`15/15`** / **`0/15`** |
| **Photo-only（15 条）** | Top 1 / Top 5 / 错器械首位 | `10/15` (66.7%) / `14/15` (93.3%) / `1/15` | `10/15` / `14/15` / `1/15` | `10/15` / `14/15` / `1/15` | **`10/15`** (66.7%) / **`14/15`** (93.3%) / **`1/15`** |
| **Rep 1 / 2 / 3** | Top 1（Top 5 / 错器械） | `8/10` (`10/10` / `0/10`)、`7/10` (`9/10` / `1/10`)、`10/10` (`10/10` / `0/10`) | 同左 | 同左 | **`8/10` (`10/10` / `0/10`)、`7/10` (`9/10` / `1/10`)、`10/10` (`10/10` / `0/10`)** |

---

## 5. 仓库 13 条固定回放对照（RN）

| 阶段 | Top 1 | Top 5 | Recall@5 | 错器械首位 | 空结果误报 | Latency P50 / P95 |
|---|---|---|---|---|---|---|
| 基线（`0306fcae0`） | `4/11` (36.4%) | `6/11` (54.5%) | `9/11` (81.8%) | `4/9` (44.4%) | `0/2` | `31ms / 139ms` |
| P1-A（`fafa48564`） | **`5/11`** (45.5%) | **`7/11`** (63.6%) | **`10/11`** (90.9%) | `4/10` (40.0%) | `0/2` | `32ms / 144ms` |
| P1-B（已回退） | `6/11` (54.5%) | `8/11` (72.7%) | `11/11` (100.0%) | `4/10` (40.0%) | `0/2` | `35ms / 169ms` |
| **P1-C（`6fc84f294`，最终保留）** | **`5/11`** (45.5%) | **`7/11`** (63.6%) | **`10/11`** (90.9%) | **`4/10`** (40.0%) | **`0/2`** | **`34ms / 134ms`** |

---

## 6. 全量回归与静态检查（最终保留状态 `6fc84f294`）

| # | 命令 | 退出码 | 结果摘要 |
|---|---|---|---|
| 1 | `npm.cmd --prefix api run build` | `0` | `build: dist ready` |
| 2 | `node --test api/test/agent-exercise-search.test.js api/test/agent-providers.test.js api/test/agent-runtime.test.js api/test/exercise-search-diagnostics.test.js` | `0` | `72/72` 全部通过 |
| 3 | `npm.cmd --prefix api run test:nest -- test/nest/agent.test.js test/nest/agent-exercise-search.test.js` | `0` | `13/13` 全部通过 |
| 4 | `npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/exercise-search-rn.test.js src/lib/library-search-rn.test.ts src/lib/exercises.test.js` | `0` | 4 个测试文件共 `82/82` 通过（含 `88/88` golden：`english 47/47`、`chinese 22/22`、`ambiguous 6/6`、`conflict 3/3`、`boundary 10/10`、`wrong-high: 0`） |
| 5 | `npm.cmd --prefix frontend run test:ai-search-eval` | `0` | `8/8` 全部通过 |
| 6 | `npm.cmd --prefix frontend run build` | `0` | `481 modules transformed`，Vite 构建成功 |
| 7 | `npm.cmd --prefix mobile-rn run check` | `0` | `eslint`（0 error，仅 2 条既有 `react/no-array-index-key` warning）、`lint:rules` (`7/7`)、`typecheck`、`design:check`（127/127 图标）全部通过 |
| 8 | `git diff --check` | `0` | 无空白/格式错误 |

---

## 7. 已知局限

1. **剩余纯图视觉判错留给 P2**：最终保留版在 P1 现行 90 条样本已达到 Top 1 `74/90`（82.2%）、Top 5 `81/90`（90.0%）、Recall@5 `82/90`（91.1%），在 P0-B 3× 30 条真实响应中 `hinted` 达到 `15/15`（100%）。P1-90 剩余的 16 例非 Top 1 与 P0-B 30 剩余的 5 例非 Top 1（`photo-only` 组）全部源于纯图场景下 VLM 视觉判错动作家族（例如推肩看成推胸、推胸看成夹胸、哈克深蹲看成俯身划船、腿屈伸看成腿弯举）或模型给出的 `candidate.equipment` / 置信度顺序偏差（如 `final-3-photo-leg-press` 给出 `leverage machine`、`q1-control-3-hinted-hack-squat` 给出 `lever hack squat`），属于 P2（视觉/多视角/提示词阶段）解决范围，无法通过纯本地词法匹配修复。
2. **Pre-P1 历史无器械样本与 2 字裸中文**：pre-P1 45 条历史样本缺少 `candidate.equipment`（且依据红线严禁使用 `fallback.equipment` 参与排序），而 2 字裸中文（如 `"腿举"`）继续保持 `CJK_LCS_MIN = 3` 与 `ambiguous 6/6 (100%)` 防线不放宽。
