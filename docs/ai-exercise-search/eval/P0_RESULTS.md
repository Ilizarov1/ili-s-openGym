# AI 动作检索 P0 准确度优化验收记录（RN 单端）

状态：Stage 1（P0-A）与 Stage 2（P0-B）已保留并独立提交；Stage 3（P0-C）经 3× 真实模型对照未达保留门槛，已按单变量原则回退并保留失败对照数据。所有开发、评测与验收均在独立 worktree `D:\dev\open-gym-ai-search-p0`（分支 `codex/ai-search-p0`）完成，主工作区 `D:\dev\open-gym` 保持干净。

## 1. 环境与基线

| 项 | 实际值 |
|---|---|
| 基线起点（`main`） | `78a66803a3ac93be30dcd65db6e9bb8dbb26475e` |
| Worktree / 分支 | `D:\dev\open-gym-ai-search-p0` / `codex/ai-search-p0` |
| `catalogueSha256` | `99add164cbdd8396efb48672fe865d7cd97b487a65c365a270c294cd72825f96` |
| 保留提交（Stage 1 / P0-A） | `14c55f9a5` — `feat(ai-search): P0-A cross-query lexicographic ranking and generic unsupported variant penalty` |
| 保留提交（Stage 2 / P0-B） | `26b9f6c2b` — `feat(ai-search): P0-B ground visual observation in fallback before candidates` |
| 回退阶段（Stage 3 / P0-C） | `temperature: 0` 透传（未提交，已 `git checkout --` 完整回退） |
| 135 条配对清单 | `p1-m1-paired-manifest.json`（133 正例 + 2 空例，`skippedIds: []`，`sampleErrors: 0`） |
| 3× e2e 清单 | `docs/ai-exercise-search/eval/manifest.json`（`--group photo-only --group hinted`，每轮 10 场景） |
| 真实模型配置 | 外部 `api/.env` 注入（仅运行 CLI 时通过 `node --env-file` 传入，密钥与私有路径不入库） |
| 原始产物位置 | `.codex/ai-search-eval/p0/`（git 忽略，不提交） |

---

## 2. Stage 1（P0-A）：135 条冻结回放 RN 对照

### 2.1 总体指标与 P1 / 历史样本拆分（RN）

| 范围 | 指标 | 基线（`78a66803a`） | P0-A（`14c55f9a5`） | 变化 |
|---|---|---|---|---|
| **全部 135 条** | Top 1 | `52/133` (39.1%) | **`92/133`** (69.2%) | **+40** (+30.1pp) |
| **全部 135 条** | Top 5 | `106/133` (79.7%) | `106/133` (79.7%) | `0` |
| **全部 135 条** | Recall@5 | `116/133` (87.2%) | `116/133` (87.2%) | `0` |
| **全部 135 条** | 错器械首位 | `15/131` (11.5%) | `21/131` (16.0%) | **+6**（6 升 / 12 降） |
| **全部 135 条** | 空结果误报 | `0/2` | `0/2` | `0` |
| **全部 135 条** | 原始 `recall` 差异 | — | `0` 处 | 召回零污染 |
| **全部 135 条** | `1299` 排在 `0576` 前 | `9` 例 | **`0` 例** | **-9**（清零） |
| **全部 135 条** | Latency P50 / P95 | `32ms / 96ms` | `34ms / 110ms` | `+2ms / +14ms` |
| **P1 现行样本（90 条）** | Top 1 / Top 5 / Recall@5 | `46/90` / `78/90` / `79/90` | **`72/90`** (80.0%) / `78/90` / `79/90` | **Top 1 +26** |
| **P1 现行样本（90 条）** | 错器械首位 | `6/90` | `7/90` | `+1` |
| **P1 前历史样本（45 条）** | Top 1 / Top 5 / Recall@5 | `6/43` / `28/43` / `37/43` | **`20/43`** (46.5%) / `28/43` / `37/43` | **Top 1 +14** |
| **P1 前历史样本（45 条）** | 错器械首位 / 空结果误报 | `9/41` / `0/2` | `14/41` / `0/2` | `+5` / `0` |

### 2.2 按分组对照（RN）

| 分组 | Top 1（基线 → P0-A） | Top 5（基线 → P0-A） | 错器械首位（基线 → P0-A） |
|---|---|---|---|
| `hinted` | `1/5` → `2/5` | `3/5` → `3/5` | `1/5` → `3/5` |
| `edge` | `1/3` → `1/3` | `1/3` → `1/3` | `0/1` → `0/1` |
| `quality-regression` | `0/3` → `1/3` | `2/3` → `2/3` | `1/3` → `1/3` |
| `final-hinted` | `11/15` → **`15/15`** | `15/15` → `15/15` | `0/15` → `0/15` |
| `final-photo-only` | `4/15` → **`8/15`** | `9/15` → `9/15` | `3/15` → `3/15` |
| `prompt-a-hinted` | `1/15` → **`9/15`** | `10/15` → `10/15` | `5/15` → `6/15` |
| `prompt-a-photo-only` | `3/15` → **`6/15`** | `10/15` → `10/15` | `2/15` → `4/15` |
| `prompt-b-hinted` | `11/15` → **`14/15`** | `14/15` → `14/15` | `0/15` → `0/15` |
| `prompt-b-photo-only` | `5/15` → **`10/15`** | `12/15` → `12/15` | `2/15` → `2/15` |
| `q1-control-hinted` | `9/15` → **`14/15`** | `14/15` → `14/15` | `1/15` → `1/15` |
| `q1-control-photo-only` | `6/15` → **`11/15`** | `14/15` → `14/15` | `0/15` → `1/15` |
| `original-chest` | `0/2` → **`1/2`** | `2/2` → `2/2` | `0/2` → `0/2` |

仓库内 13 条固定回放（`p0a-repo-replay.json`，不含 P1 样本）：RN Top 1 = `4/11`、Top 5 = `6/11`、Recall@5 = `9/11`、错器械首位 = `4/9`、空结果误报 = `0/2`。

### 2.3 逐样本增退核对（RN）

- **Top 5 增退**：`0` 增 `0` 退（`106/133` 完全守恒）。
- **Top 1 净增 +40（45 升 / 5 降）**：
  - **Top 1 改善（45 例）**：
    - `hinted-leg-press` (`1391 → 0739`)、`quality-photo-chest` (`0405 → 0576`)、`my-model-chest-photo-chest-press` (`1299 → 0576`)
    - `final-*`（8 例）：`final-1-hinted-hack-squat` (`0739 → 0743`)、`final-1-photo-leg-extension` (`0599 → 0585`)、`final-2-hinted-chest-press` (`1299 → 0576`)、`final-2-hinted-hack-squat` (`0739 → 0743`)、`final-2-photo-hack-squat` (`0739 → 0743`)、`final-3-hinted-hack-squat` (`1391 → 0743`)、`final-3-photo-leg-extension` (`0599 → 0585`)、`final-3-photo-hack-squat` (`1583 → 0743`)
    - `prompt-a-*`（13 例）：`prompt-a-1-hinted-leg-extension` (`2267 → 0585`)、`prompt-a-1-hinted-shoulder-press` (`0405 → 0603`)、`prompt-a-1-photo-leg-extension` (`0586 → 0585`)、`prompt-a-2-hinted-chest-press` (`1299 → 0576`)、`prompt-a-2-hinted-leg-press` (`1391 → 0739`)、`prompt-a-2-hinted-leg-extension` (`0739 → 0585`)、`prompt-a-2-hinted-shoulder-press` (`0405 → 0603`)、`prompt-a-2-photo-leg-press` (`1391 → 0739`)、`prompt-a-2-photo-leg-extension` (`0586 → 0585`)、`prompt-a-3-hinted-leg-press` (`1391 → 0739`)、`prompt-a-3-hinted-shoulder-press` (`0405 → 0603`)、`prompt-a-3-photo-leg-press` (`2335 → 0739`)、`prompt-a-3-photo-leg-extension` (`0599 → 0585`)
    - `prompt-b-*`（10 例）：`prompt-b-1-hinted-hack-squat` (`0739 → 0743`)、`prompt-b-1-photo-chest-press` (`0603 → 0576`)、`prompt-b-1-photo-leg-press` (`1391 → 0739`)、`prompt-b-1-photo-leg-extension` (`0599 → 0585`)、`prompt-b-2-hinted-hack-squat` (`0739 → 0743`)、`prompt-b-2-photo-leg-extension` (`0599 → 0585`)、`prompt-b-2-photo-hack-squat` (`0739 → 0743`)、`prompt-b-3-hinted-hack-squat` (`0739 → 0743`)、`prompt-b-3-photo-leg-extension` (`0599 → 0585`)、`prompt-b-3-photo-hack-squat` (`0739 → 0743`)
    - `q1-control-*`（11 例）：`q1-control-1-hinted-leg-press` (`1391 → 0739`)、`q1-control-1-hinted-leg-extension` (`5178 → 0585`)、`q1-control-1-hinted-hack-squat` (`0739 → 0743`)、`q1-control-1-photo-leg-press` (`1391 → 0739`)、`q1-control-2-hinted-chest-press` (`1299 → 0576`)、`q1-control-2-hinted-hack-squat` (`0739 → 0743`)、`q1-control-2-photo-leg-extension` (`0599 → 0585`)、`q1-control-2-photo-hack-squat` (`0739 → 0743`)、`q1-control-3-photo-leg-press` (`1391 → 0739`)、`q1-control-3-photo-shoulder-press` (`10671 → 0603`)、`q1-control-3-photo-hack-squat` (`0739 → 0743`)
  - **Top 1 下降（5 例，均因排序尊重模型置信度与候选顺序所致）**：
    - `prompt-a-2-photo-hack-squat` (`0743 → 0046`)：pre-P1 无 `equipment` 字段，候选 0 为 `high` `"hack squat"`（召回首位 `0046` barbell），旧版因候选 1 `medium` `"sled hack squat"` 词数多而偶然反超。
    - `prompt-a-3-photo-shoulder-press` (`1454 → 1041`)：候选 0 为 `medium` `"plate loaded shoulder press"`（旧库词法命中 `1041`），候选 1 为 `low` `"seated machine shoulder press"`。
    - `prompt-b-2-photo-chest-press` (`0576 → 1030`)：模型纯图把推胸机错判为候选 0 `medium` `"pec deck fly"`（`1030`）、候选 2 `low` `"lever chest press"`（`0576`）。
    - `prompt-b-3-photo-shoulder-press` (`0603 → 0576`)：模型纯图把推肩机错判为候选 0 `medium` `"lever chest press"`（`0576`）、候选 1 `low` `"lever shoulder press"`（`0603`）。
    - `q1-control-2-photo-chest-press` (`0576 → 1030`)：模型纯图把推胸机错判为候选 0 `high` `"pec deck fly"`（`1030`）、候选 1 `medium` `"chest press machine"`（`0576`）。
- **错器械首位 12 例变差与 6 例改善根因分析**：
  - **6 例改善**：`quality-photo-chest` (`0405 → 0576`)、`prompt-a-1-hinted-shoulder-press` (`0405 → 0603`)、`prompt-a-2-hinted-leg-extension` (`0739 → 0585`)、`prompt-a-2-hinted-shoulder-press` (`0405 → 0603`)、`prompt-a-3-hinted-shoulder-press` (`0405 → 0603`)、`prompt-a-3-photo-leg-press` (`2335 → 0739`)。
  - **12 例变差**：**11/12 来自 P1 之前缺失 `candidate.equipment` 的历史样本**（8 例 `hack squat` 候选 0 无 `equipment` 落到 `0046` barbell hack squat、3 例 `seated chest press` 候选 0 无 `equipment` 落到 `2144` cable chest press），此前它们仅因后排低置信长词候选（`leg press` `0739`、`single arm chest press` `10672`、`incline chest press` `1299`）词数原始分偏高而偶然遮掩了缺器械问题；其余 1 例为 `q1-control-1-photo-hack-squat`（候选 0/1 为 `medium` row、候选 2 为 `low` leg press）。经评审裁决，Stage 1 收益压倒性成立，绝不为此回退或重新引入 `fallback.equipment` 污染，予以保留并继续推进。

---

## 3. Stage 2（P0-B）与 Stage 3（P0-C）：3× 真实模型 e2e 对照（RN）

### 3.1 逐轮与聚合指标对比

| 组别 | 轮次 | Top 1（总体 / hinted / photo） | Top 5（总体 / hinted / photo） | Recall@5 | 错器械首位（总体 / H / P） | 视觉 P50 / P95 |
|---|---|---|---|---|---|---|
| **C0（基线：P0-A）** | Rep 1 | `8/10` (`5/5` / `3/5`) | `9/10` (`5/5` / `4/5`) | `9/10` | `1/10` (`0/5` / `1/5`) | `5924ms / 15870ms` |
| **C0（基线：P0-A）** | Rep 2 | `8/10` (`5/5` / `3/5`) | `9/10` (`5/5` / `4/5`) | `9/10` | `0/10` (`0/5` / `0/5`) | `7007ms / 15313ms` |
| **C0（基线：P0-A）** | Rep 3 | `7/10` (`4/5` / `3/5`) | `8/10` (`4/5` / `4/5`) | `8/10` | `1/10` (`0/5` / `1/5`) | `4578ms / 23632ms` |
| **C0 聚合（3×）** | **合计** | **`23/30` (76.7%)** (`14/15` / `9/15`) | **`26/30` (86.7%)** (`14/15` / `12/15`) | `26/30` | **`2/30`** (`0/15` / `2/15`) | Top1 极差 `1` |
| **T1（+ P0-B，保留）** | Rep 1 | `8/10` (`5/5` / `3/5`) | `10/10` (`5/5` / `5/5`) | `10/10` | `0/10` (`0/5` / `0/5`) | `11723ms / 24779ms` |
| **T1（+ P0-B，保留）** | Rep 2 | `7/10` (`5/5` / `2/5`) | `9/10` (`5/5` / `4/5`) | `9/10` | `1/10` (`0/5` / `1/5`) | `9865ms / 28869ms` |
| **T1（+ P0-B，保留）** | Rep 3 | `10/10` (`5/5` / `5/5`) | `10/10` (`5/5` / `5/5`) | `10/10` | `0/10` (`0/5` / `0/5`) | `6842ms / 22445ms` |
| **T1 聚合（3×）** | **合计** | **`25/30` (83.3%)** (`15/15` / `10/15`) | **`29/30` (96.7%)** (`15/15` / `14/15`) | `29/30` | **`1/30`** (`0/15` / `1/15`) | Top1 极差 `3` |
| **T2（+ P0-C，回退）** | Rep 1 | `8/10` (`5/5` / `3/5`) | `8/10` (`5/5` / `3/5`) | `8/10` | `0/10` (`0/5` / `0/5`) | `11129ms / 15027ms` |
| **T2（+ P0-C，回退）** | Rep 2 | `7/10` (`5/5` / `2/5`) | `8/10` (`5/5` / `3/5`) | `8/10` | `1/10` (`0/5` / `1/5`) | `11071ms / 32291ms` |
| **T2（+ P0-C，回退）** | Rep 3 | `8/10` (`5/5` / `3/5`) | `9/10` (`5/5` / `4/5`) | `9/10` | `1/10` (`0/5` / `1/5`) | `10279ms / 19966ms` |
| **T2 聚合（3×）** | **合计** | **`23/30` (76.7%)** (`15/15` / `8/15`) | **`25/30` (83.3%)** (`15/15` / `10/15`) | `25/30` | **`2/30`** (`0/15` / `2/15`) | Top1 极差 `1` |

### 3.2 一致率与回放字段统计（3×）

| 组别 | 3/3 Top-1 一致率 | 候选总数 | `equipment` 填充率 | `bodyPart` 填充率 | 候选名含变体词次数 | 保留判定 |
|---|---|---|---|---|---|---|
| **C0** | `6/10` | `65` | `65/65` (100%) | `65/65` (100%) | `4` | 基线 |
| **T1（P0-B）** | `6/10` | `65` | `65/65` (100%) | `65/65` (100%) | `5` | **保留**（Top 1 `23→25`、Top 5 `26→29`、WrongEq `2→1`；`photo-only` Top 5 与 WrongEq 均在 2/3 轮改善；`fallback.understanding` 客观先描述传动与姿态无编造） |
| **T2（P0-C）** | `6/10` | `68` | `68/68` (100%) | `68/68` (100%) | `3` | **回退**（Top 1 `25→23`、Top 5 `29→25`、WrongEq `1→2` 均较 T1 退化，且 3/3 Top-1 一致率未提升仍为 `6/10`） |

> [!NOTE]
> **实跑偶发超时重试说明**：在 T1 与 T2 评测中均出现过单次上游接口 >30s 超时（`model_unavailable`：`t1-p0b` 首轮 rep 1/2 中 `photo-leg-extension` 约 30–34s；`t2-p0c` rep 2 中 `photo-shoulder-press` / `hinted-leg-press` 约 34–39s），未出现 HTTP 400 参数拒绝错误。上述汇总表均基于重试后 3 轮完整 10/10 零错误运行的结果统计。

---

## 4. 全量回归测试与静态检查（最终保留状态 `26b9f6c2b`）

| # | 命令 | 退出码 | 结果摘要 |
|---|---|---|---|
| 1 | `npm.cmd --prefix api run build` | `0` | `build: dist ready` |
| 2 | `node --test api/test/agent-exercise-search.test.js api/test/agent-providers.test.js api/test/agent-runtime.test.js api/test/exercise-search-diagnostics.test.js` | `0` | `72/72` 全部通过 |
| 3 | `npm.cmd --prefix api run test:nest -- test/nest/agent.test.js test/nest/agent-exercise-search.test.js` | `0` | `13/13` 全部通过（注：全量 `test:nest` 908 项中 894 通过、2 跳过，12 项失败均为 Windows NTFS/CRLF/Unix socket 既有环境限制，如 `0700`/`0600` 权限检查、Unix 域套接字 `recover.js`、`wrapped-copy`/`nudge-copy`/`prompts` 的 `\r\n` 差异，与本任务改动无关） |
| 4 | `npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts` | `0` | `47/47` 全部通过（含 88/88 golden、wrong-high=0） |
| 5 | `npm.cmd --prefix frontend run test:ai-search-eval` | `0` | `8/8` 全部通过 |
| 6 | `npm.cmd --prefix mobile-rn run check` | `0` | `lint`（仅 2 条既有 `react/no-array-index-key` warning）、`lint:rules` (`7/7`)、`typecheck`、`design:check`（127/127 图标）全部通过 |

## 5. 已知局限

1. **纯图场景残余方差**：`t1-p0b` 在 `hinted` 组已达 `15/15`（100%）Top 1 与 Top 5，但 `photo-only` 仍有 `6/10` 的 3/3 Top-1 一致率（`photo-chest-press` / `photo-shoulder-press` / `photo-leg-press` / `photo-leg-extension` 偶发单轮波动），且 `temperature: 0` 实测反而拉低准确度并无助于稳定，后续若需继续压低纯图方差，需从图像预处理/多视角或候选词表对齐而非降低采样温度着手。
2. **全量 `test:nest` 的 Windows 环境基线**：`npm.cmd --prefix api run test:nest` 全量运行在 Windows 下因 POSIX 文件权限与 CRLF 换行检查产生 12 项既有环境失败；Agent 相关的 `agent*.test.js` 与 `test/nest/agent*.test.js` 均 100% 通过。
