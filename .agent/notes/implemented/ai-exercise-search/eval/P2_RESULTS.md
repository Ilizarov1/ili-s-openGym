# AI 动作检索 P2（两阶段检索基建 + 闭集重排对照 + 一键消歧 Chip）验收记录（RN 单端）

状态：
- **Stage 0（P2-0，保留 `619c3ee7e`）**：只读 `search_catalogue` 工具围栏、5,632 条紧凑目录快照与三端宿主注册已完成并通过构建、Metro 隔离与围栏单测。
- **Stage 1（P2-A，已回退）**：条件触发两阶段“宽召回 + 闭集多选重排”经两组 3× 真实模型 e2e 验证未达到硬保留门槛（纯图 Top 1 与 3/3 一致率均未高于基线，错器械首位上升且纯图 P50 延迟翻倍至 22.7–24.8s），已按单变量与止损原则通过 `git checkout --` 完整回退至 `619c3ee7e`，原始实验报告保留在本地 `.codex/ai-search-eval/p2/`（git 忽略，不提交）。
- **Stage 2（P2-B，保留 `f8c4b5ef0`）**：结构化可选 `clarifications` 契约 + 共享 `deriveClarificationChips(...)`（高置信清晰隐藏、近亲/歧义保留、4 组确定性中文消歧兜底）+ RN `<Chip tone="neutral">` / Web `.chips.wrap` 一键消歧追问已实现，并通过 135 条回放零回归与全套自动化验收。

所有开发、评测与文档验收均在独立 worktree `D:\dev\open-gym-ai-search-p2`（分支 `codex/ai-search-p2`）内完成，主工作区 `D:\dev\open-gym` 未作修改，未合并 `main`。

---

## 1. 环境与基线

| 项 | 实际值 |
|---|---|
| 基线起点（`main`） | `10317619a`（`docs(ai-search): add P1 recall execution plan and RN evaluation results`，含 P0-B + P1-C） |
| Worktree / 分支 | `D:\dev\open-gym-ai-search-p2` / `codex/ai-search-p2` |
| 评测焦点 | **RN 单端**（`platforms.rn`） |
| `catalogueSha256` | `99add164cbdd8396efb48672fe865d7cd97b487a65c365a270c294cd72825f96` |
| 紧凑目录快照 | `api/agent-runtime/tasks/exercise-search-catalogue.json`（`5,632` 条、`726,553` 字节、`0` 缺中文名，未静态导入进 `api/agent-runtime/index.js`） |
| 保留提交（Stage 0 / P2-0） | `619c3ee7e` — `feat(ai-search): P2-0 add read-only search_catalogue tool and compact catalogue snapshot` |
| 回退阶段（Stage 1 / P2-A） | 条件触发两阶段“宽召回 + 闭集多选重排”（已完整回退，保留实验记录用于第 2 节分析） |
| 保留提交（Stage 2 / P2-B） | `f8c4b5ef0` — `feat(ai-search): P2-B add one-tap disambiguation chips for ambiguous AI search results` |
| 3× 真实 e2e 清单 | `docs/ai-exercise-search/eval/manifest.json`（`--mode e2e --group hinted --group photo-only --web-locale zh --include-queries`，每轮 10 场景，3 轮共 30 次） |
| 135 条冻结回放清单 | `p1-m1-paired-manifest.json`（133 正例 + 2 空例，`skippedIds: []`，`sampleErrors: 0`） |
| 仓库固定回放清单 | `docs/ai-exercise-search/eval/manifest.json`（`--mode replay`，13 条可执行 + 5 条跳过，`sampleErrors: 0`） |

---

## 2. Stage 1（P2-A）3× 真实模型 e2e 逐轮与聚合对照（RN）

### 2.1 逐轮与聚合指标对照（Baseline vs P2-A）

> [!NOTE]
> 以下 `Clean P2-A` 与 `对照探索轮（attempt2-biased）` 均为完整 `10/10` 零错误运行（`sampleErrors: 0`）；早期含瞬时网络超时的 `attempt1-with-err` 仅记录 3 次 Round 1 上游 `model_unavailable`（均未进入 Round 2）供降级与稳定性审计，不计入正式对照计数。Stage 1 实验期间，`api` 离线测试 `78/78` 通过（包含 `fixtureCase: 'rerank'` 两轮调用与 Round 2 失败自动回退 Round 1 有效输出的优雅降级断言）。

| 组别 | 轮次 | Top 1（总体 / hinted / photo） | Top 5（总体 / hinted / photo） | 错器械首位（总体 / H / P） | Round 2 触发（H / P） | 视觉 P50 / P95（全量；纯图） |
|---|---|---|---|---|---|---|
| **Baseline（P0-B + P1-C，引用）** | Rep 1 | `8/10` (`5/5` / `3/5`) | `10/10` (`5/5` / `5/5`) | `0/10` (`0/5` / `0/5`) | `0/5` / `0/5` | `11723ms / 24779ms` |
| **Baseline（P0-B + P1-C，引用）** | Rep 2 | `7/10` (`5/5` / `2/5`) | `9/10` (`5/5` / `4/5`) | `1/10` (`0/5` / `1/5`) | `0/5` / `0/5` | `9865ms / 28869ms` |
| **Baseline（P0-B + P1-C，引用）** | Rep 3 | `10/10` (`5/5` / `5/5`) | `10/10` (`5/5` / `5/5`) | `0/10` (`0/5` / `0/5`) | `0/5` / `0/5` | `6842ms / 22445ms` |
| **Baseline 3× 聚合** | **合计** | **`25/30` (83.3%)** (`15/15` / `10/15` [66.7%]) | **`29/30` (96.7%)** (`15/15` / `14/15` [93.3%]) | **`1/30`** (`0/15` / `1/15`) | `0%` / `0%` | **3/3 一致率 `6/10`** |
| **Clean P2-A（无偏触发，已回退）** | Rep 1 | `8/10` (`5/5` / `3/5`) | `9/10` (`5/5` / `4/5`) | `1/10` (`0/5` / `1/5`) | `1/5` / `5/5` | `9955ms / 33046ms`；`14616ms / 26606ms` |
| **Clean P2-A（无偏触发，已回退）** | Rep 2 | `5/10` (`4/5` / `1/5`) | `6/10` (`4/5` / `2/5`) | `2/10` (`0/5` / `2/5`) | `1/5` / `5/5` | `13205ms / 39887ms`；`32816ms / 34018ms` |
| **Clean P2-A（无偏触发，已回退）** | Rep 3 | `10/10` (`5/5` / `5/5`) | `10/10` (`5/5` / `5/5`) | `0/10` (`0/5` / `0/5`) | `1/5` / `5/5` | `12021ms / 28037ms`；`22657ms / 23878ms` |
| **Clean P2-A 3× 聚合** | **合计** | **`23/30` (76.7%)** (`14/15` [93.3%] / **`9/15` [60.0%]**) | **`25/30` (83.3%)** (`14/15` / `11/15` [73.3%]) | **`3/30`** (`0/15` / `3/15`) | **`3/15` (20.0%)** / **`15/15` (100%)** | `12039ms / 33046ms`；纯图 **`22657ms / 34018ms`**；一致率 **`5/10`** |
| **探索轮 `attempt2-biased`（已回退）** | Rep 1 | `8/10` (`5/5` / `3/5`) | `8/10` (`5/5` / `3/5`) | `0/10` (`0/5` / `0/5`) | `0/5` / `5/5` | `8691ms / 35051ms`；`24249ms / 24827ms` |
| **探索轮 `attempt2-biased`（已回退）** | Rep 2 | `8/10` (`5/5` / `3/5`) | `10/10` (`5/5` / `5/5`) | `0/10` (`0/5` / `0/5`) | `0/5` / `5/5` | `11842ms / 40310ms`；`25337ms / 28481ms` |
| **探索轮 `attempt2-biased`（已回退）** | Rep 3 | `7/10` (`5/5` / `2/5`) | `10/10` (`5/5` / `5/5`) | `0/10` (`0/5` / `0/5`) | `0/5` / `5/5` | `5340ms / 39678ms`；`26460ms / 30989ms` |
| **探索轮 `attempt2-biased` 3× 聚合** | **合计** | **`23/30` (76.7%)** (`15/15` / **`8/15` [53.3%]**) | **`28/30` (93.3%)** (`15/15` / `13/15` [86.7%]) | **`0/30`** | `0/15` (0%) / `15/15` (100%) | `11842ms / 35051ms`；纯图 **`24827ms / 39678ms`**；一致率 **`6/10`** |

### 2.2 逐样本 3/3 Top-1 一致性（`Clean P2-A`）与回退根因

- `Clean P2-A` 逐样本 Top-1 命中率（按 `manifest.json` `expectedIds` 核验 `finalIds[0]`）：
  - `hinted` 组（4/5 稳定）：`hinted-leg-press` `3/3`、`hinted-leg-extension` `3/3`、`hinted-shoulder-press` `3/3`、`hinted-hack-squat` `3/3`、`hinted-chest-press` `2/3`（Rep 2 仅产单候选误中 `10671`）。
  - `photo-only` 组（1/5 稳定）：`photo-shoulder-press` `3/3`、`photo-chest-press` `2/3`（Rep 2 错中 `1871`）、`photo-hack-squat` `2/3`（Rep 2 被近亲 `5516` 挤至次席）、`photo-leg-extension` `1/3`（Rep 1 被 `0599` 挤至第 2、Rep 2 错中 `2146`）、`photo-leg-press` `1/3`（Rep 1 错中 `0594`、Rep 2 错中 `2267`）。
- **未达硬保留门槛并回退的根因**：
  1. **硬门槛未达成**：要求 `photo-only` Top 1 相对基线 `10/15` 净增 `≥ +2`（`≥ 12/15`）或 3/3 一致率达 `≥ 8/10`，且 `hinted` 保持 `15/15`、错器械 `≤ 1/30`。实测两组 P2-A 的纯图 Top 1 均**不升反降**（`9/15` 与 `8/15` < `10/15`），3/3 一致率最高仅 `6/10`（Clean P2-A 仅 `5/10`），Clean P2-A 的 `hinted` 退至 `14/15`、错器械升至 `3/30`。
  2. **纯图延迟翻倍**：Round 2 串行重新识别将 `photo-only` 视觉 P50 从基线 `~7–12s` 拉高至 **`22.7s–24.8s`**，P95 达 `34.0s–39.7s`。
  3. **本质原因**：面对单张静态低分辨器械照片，将同一图片连同 12–15 条高度相似的近亲目录名在 Round 2 重喂给视觉模型，并不能补充缺失的运动轨迹与握把推拉方向感知，反而放大了近亲干扰项（`2267 lever seated leg press`、`5516 lever hack squat`、`0599 lever seated leg curl`、`1871`/`1451`、`0594`）的错位概率。

---

## 3. 135 条冻结回放与仓库 13 条回放守恒数据（RN）

### 3.1 135 条冻结回放（`p1-m1-paired-manifest.json`，133 正例 + 2 空例，`skipped=0`, `errors=0`）

| 阶段 | Top 1 | Top 5 | Recall@5 | 错器械首位 | 空结果误报 | 仅兜底 | Latency P50 / P95 |
|---|---|---|---|---|---|---|---|
| 基线（`10317619a` / P1-C） | `95/133` (71.4%) | `110/133` (82.7%) | `120/133` (90.2%) | `20/132` (15.2%) | `0/2` | `3/135` | `42ms / 109ms` |
| Stage 1 试验（`p2a-135.json`，已回退） | `95/133` (71.4%) | `110/133` (82.7%) | `120/133` (90.2%) | `20/132` (15.2%) | `0/2` | `3/135` | `44ms / 112ms` |
| **Stage 2 保留版（`f8c4b5ef0`，`p2b-135.json`）** | **`95/133` (71.4%)** | **`110/133` (82.7%)** | **`120/133` (90.2%)** | **`20/132` (15.2%)** | **`0/2`** | **`3/135`** | **`46ms / 112ms`** |

### 3.2 仓库 13 条固定回放（`docs/ai-exercise-search/eval/manifest.json`，`run=13, skipped=5, errors=0`）

| 阶段 | Top 1 | Top 5 | Recall@5 | 错器械首位 | 空结果误报 | 仅兜底 | Latency P50 / P95 |
|---|---|---|---|---|---|---|---|
| 基线（`10317619a` / P1-C） | `5/11` (45.5%) | `7/11` (63.6%) | `10/11` (90.9%) | `4/10` (40.0%) | `0/2` | `3/13` | `34ms / 134ms` |
| **Stage 2 保留版（`f8c4b5ef0`，`p2b-repo.json`）** | **`5/11` (45.5%)** | **`7/11` (63.6%)** | **`10/11` (90.9%)** | **`4/10` (40.0%)** | **`0/2`** | **`3/13`** | **`33ms / 137ms`** |

---

## 4. Stage 0 与 Stage 2（P2-B）保留方案与验收摘要

1. **Stage 0 只读目录工具基建（`619c3ee7e`）**：
   - 新增 `scripts/sync-ai-search-catalogue.mjs` 与紧凑快照 `api/agent-runtime/tasks/exercise-search-catalogue.json`（5,632 条），在 `api/scripts/build-api.mjs` 将其纳入 `required` 校验，并经单元测试确认 `api/agent-runtime/index.js` 零 Node 内置导入、零目录静态导入（杜绝 Metro 重复打包）；
   - `api/agent-runtime/tasks/catalogue-search-tool.js` 实现严格只读的 `search_catalogue` 工具（`schema.js` 同步补齐 `minItems`/`maxItems` 数组长度校验），并在 API Server、RN 本机与评估 CLI 完成注册及围栏测试。
2. **Stage 2 一键消歧 Chip（`f8c4b5ef0`）**：
   - 将纯图单视角无法稳定区分的运动学歧义从“后台盲目二轮重猜”转为“低延迟单次点选确认”；
   - `api/agent-runtime/tasks/exercise-search.js` 扩展可选 `clarifications`（0..3 项、`label` ≤ 16、`prompt` ≤ 60），清洗阶段过滤非法值、截断并按 `label` 去重，空时省略字段以保持 100% 向后兼容；
   - `frontend/src/lib/exercise-ai-search.js` 新增并导出 `deriveClarificationChips(items, source, hintText)`，由 `match()` 附带返回 `clarifications`：清晰 `high` 命中且无近亲竞品时返回 `[]` 零打扰；模型未给出或不足时按 4 组确定性中文消歧族（推胸/推肩/蝴蝶机、腿屈伸/腿弯举、哈克/腿举、固定器械/绳索）补齐，非健身空结果返回 `[]`；
   - **RN UI（`mobile-rn/src/screens/ExerciseLibraryScreen.tsx`）**：遵循设计系统规范复用 `<Chip tone="neutral">`（`testID="ai-clarification-chips"`），抽取 `sendAiFollowUpText(...)` 复用当前会话 `sessionId` 与最新图片发起追问；
   - **Web UI（`frontend/src/components/ExerciseAiSearch.jsx`）**：复用 `.chips.wrap` + `.chip`（`[data-ai-clarifications]`），点击即触发 `sendRequest({ text: chip.prompt, surface: 'follow' })`，运行中与达追问上限后自动隐藏。
   - **交互验证**：`ExerciseAiSearch.test.jsx` 已自动化覆盖消歧 Chip 渲染、点击携带 `chip.prompt` 且 `sessionMode: 'continue'` 发起追问、运行中防连点隐藏以及达追问上限隐藏；RN 端已完成 ESLint、自定义规则、TypeScript 类型检查与设计系统全检（Android 模拟器手工点按待实机环境复核）。

---

## 5. 全量回归与静态检查（最终保留状态 `f8c4b5ef0`）

| # | 命令 | 退出码 | 结果摘要 |
|---|---|---|---|
| 1 | `npm.cmd --prefix api run build` | `0` | `build: dist ready`（含紧凑目录快照与只读工具模块校验） |
| 2 | `node --test api/test/agent-exercise-search.test.js api/test/agent-providers.test.js api/test/agent-runtime.test.js api/test/exercise-search-diagnostics.test.js` | `0` | `76/76` 全部通过（含快照与 `EXDB` 一致性、Metro 边界、工具围栏及 `clarifications` 清洗测试） |
| 3 | `npm.cmd --prefix api run test:nest -- test/nest/agent.test.js test/nest/agent-exercise-search.test.js` | `0` | `13/13` 全部通过 |
| 4 | `npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/exercise-search-rn.test.js src/lib/library-search-rn.test.ts src/lib/exercises.test.js src/components/ExerciseAiSearch.test.jsx` | `0` | 5 个测试文件共 `112/112` 通过（含 `88/88` golden、`wrong-high: 0`、`deriveClarificationChips` 与 Web UI 消歧点击/上限单测） |
| 5 | `npm.cmd --prefix frontend run test:ai-search-eval` | `0` | `8/8` 全部通过 |
| 6 | `npm.cmd --prefix frontend run build` | `0` | `481 modules transformed`，Vite 构建成功 |
| 7 | `npm.cmd --prefix mobile-rn run check` | `0` | `eslint`（0 error，仅 2 条既有 `react/no-array-index-key` warning）、`lint:rules` (`7/7`)、`typecheck`、`design:check`（127/127 图标）全部通过 |
| 8 | `git diff --check` | `0` | 无空白或格式问题 |

---

## 6. 已知局限与后续方向

1. **单轮纯图残余上限**：在未保留自动二轮闭集重排的当前生产线上，`photo-only` 首轮 Top 1 基线仍为 `10/15`（66.7%）、3/3 一致率 `6/10`，通过 P2-B 一键消歧 Chip 将不确定动作转化为用户 1 次点击补充语义即可高精度收敛；后续如继续挖掘纯图自动识别率，建议探索前端图像裁剪/多视角拍摄提示，而非对同一静态糊图做多轮文本目录重排。
2. **RN 真机视觉/交互抽检**：`mobile-rn` 全部静态与类型检查已于保留 HEAD 通过，Android 真机/模拟器中 `<Chip tone="neutral">` 在多语言长文案与追问极限状态下的视觉排布待真机走查。
