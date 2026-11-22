# AI 动作检索 P1（本地召回补强）实施计划

状态：已完成并验收（Stage 1 P1-A `fafa48564` 与 Stage 3 P1-C `6fc84f294` 已保留提交；Stage 2 P1-B 经单元测试与 135 条回放验证未达保留门槛，已按单变量原则回退并留存对照数据）。目标是在不改提示词、不增加模型调用与 Token 成本的前提下，通过纯本地词法召回与匹配补强，修复多表达/包装词/非 CJK `nameEn` 丢弃与跨类器械冲突问题。按 Stage 0–3 严格单变量推进，评测聚焦 **RN 单端**（`platforms.rn`），并将逐阶段对照结果记录到 `docs/ai-exercise-search/eval/P1_RESULTS.md`。

## 1. 背景与根因诊断

P0（已合入 `main` `0306fcae0`，见 [P0_RESULTS.md](eval/P0_RESULTS.md)）完成跨查询词典序排序（P0-A）与视觉观察前置（P0-B）后，RN 指标已提升至：
- 135 条冻结回放（133 正例 + 2 空例）：Top 1 `92/133`（69.2%）、Top 5 `106/133`（79.7%）、Recall@5 `116/133`（87.2%）、空结果误报 `0/2`；其中 P1 现行 90 条子集 Top 1 `72/90`（80.0%）、Top 5 `78/90`、Recall@5 `79/90`。
- 3× 真实模型 e2e（30 次）：Top 1 `25/30`（83.3%，`hinted 15/15` / `photo 10/15`）、Top 5 `29/30`（96.7%）、错器械首位 `1/30`。

对 135 条冻结回放剩余 **41 条非 Top 1** 样本逐条核查后，确认 4 类可由纯本地逻辑直接修复的召回/匹配短板：

1. **非 CJK 候选的规范 `nameEn` 被直接丢弃（35/135 样本受影响）**：`frontend/src/lib/exercise-ai-search.js` `matchOne` 写死了 `const useEnglishQuery = isCjkName(name) && !!nameEn`，导致法语（`presse à pectoraux assise` → `lever chest press`）以及英文口语（`plate-loaded shoulder press` → `lever shoulder press`、`seated chest press` → `lever chest press`、`hack squat` → `sled hack squat`）完全丢弃了模型已经给出的规范 `nameEn`。
2. **包装词/低区分度体位词导致 `tokens.every` 严格 AND 滤掉标准动作**：无理想 `nameEn` 时，`seated chest press`、`seated machine chest press`、`plate-loaded shoulder press`、`seated leg press`、`seated leg extension` 因词库标准名（`0576 lever chest press`、`0603 lever shoulder press`、`0739 sled 45° leg press`、`0585 lever leg extension`）不含 `seated` / `plate-loaded`，被严格 AND 筛入偏门变体（`6355` outdoor、`10671` stack、`4174` reverse、`1041` lying）或错器械（`2144` cable、`5664` cable、`2267` lever）。
3. **共享同义词缺少商用器械与连写词**：`frontend/src/lib/exercise-search.js` `SYNONYMS` 缺少 `selectorized`、`pinloaded`、`plateloaded`、`converging`、`isolateral`、`pecdeck`、`tbar` 等常见健身房术语。
4. **器械硬冲突矩阵过粗**：`frontend/src/lib/exercise-ai-search.js` `conflictFor` 仅拦截“器械 vs 徒手/弹力带”，未拦截商用固定器械（`leverage machine` / `sled machine` / `smith machine`）与自由重量（`barbell` / `dumbbell` / `kettlebell` / `weight plate`）之间的明确跨类冲突。

## 2. 范围边界与防回退红线

- **不改动范围**：不改提示词（`api/agent-runtime/tasks/exercise-search.js`）、不改模型网关/API、不改评估 CLI、不改 UI 页面、不改动作目录。
- **常数与既有契约锁定**：保持 `AI_MATCH_CONSTANTS`（`BASE_FLOOR = 60`、`EQ_BONUS = 25`、`BP_BONUS = 15`、`CJK_DICE_MIN = 0.6`、`CJK_LCS_MIN = 3`、`CJK_MARGIN = 0.12`）与 `QUERY_PICK_LIMIT = 3` 不变；不重新引入 `fallback.equipment` 参与排序或加分。
- **不放宽 2 字裸中文简称**：实测 `"腿举"`（31 命中，得分 62/59/59）与 `"高位下拉"`（28 命中，60/57/57）、`"弯举"`（394 命中，64/64/63）词法分布高度同构；强行放宽 CJK 规则会击穿 `ambiguous` 黄金集，本轮保持 CJK 歧义红线 100%。
- **不剥离未知词与语义变式词**：查询松弛仅允许剥离显式白名单包装/低区分度体位词，严禁剥离未知词（保护 `levitating barbell bench press`、`quantum flux squat machine` 等幻觉测试）及语义变式词（`incline`、`decline`、`reverse`、`single arm/leg`、`close/wide grip`、`overhead`、`bent over` 等）。
- **视觉判错留给 P2**：当前 10 场景 3× 真实 e2e 中剩余的 5 次非 Top 1 全部为纯图 VLM 视觉判错动作家族（推肩看成推胸、腿屈伸看成腿弯举等），不在 P1 解决范围。

## 3. 待确认决策

1. **诊断日志 `queryOrigin` 枚举扩展**：Stage 2（P1-B）拟在 `api/agent-runtime/exercise-search-diagnostics.js` 将 `QUERY_ORIGINS` 从 `['primary', 'english']` 扩展为 `['primary', 'english', 'relaxed']`（保持 `schemaVersion: 1` 向后兼容），便于日志与回放报告区分原始召回与松弛召回。
2. **离线零噪声主评测策略**：因 P1 不触碰提示词与模型调用，主评测采用 **135 条冻结配对清单** + **仓库 13 条回放** + **P0-B 存档的 3× 30 条真实模型响应**（零模型方差、零 Token 成本）；最终保留版按需可选补跑 1 轮 10 场景真实 e2e smoke 验链路。

---

## 4. Stage 0：建工作树与锁定 RN 基线

- [x] 在 `D:\dev\open-gym` 确认 `git status --short` 干净、`main` 为 `0306fcae0`（或最新合入提交），新建独立 worktree `D:\dev\open-gym-ai-search-p1` 与分支 `codex/ai-search-p1`。
- [x] 核对离线对照输入存在：
  - 135 条冻结清单：`D:/dev/open-gym-ai-search-quality/.codex/ai-search-eval/quality/p1-m1-paired-manifest.json`
  - P0-B 3× 真实响应：`D:/dev/open-gym-ai-search-p0/.codex/ai-search-eval/p0/t1-p0b-{1,2,3}-replay.json`
- [x] 在新 worktree 安装锁定依赖（`frontend`、`mobile-rn`、`api`），运行基线 135 条回放至 `.codex/ai-search-eval/p1/p0-baseline-135.json`，校验 RN 基线与 `P0_RESULTS.md` 一致（Top 1 `92/133`、Top 5 `106/133`、Recall@5 `116/133`、空结果误报 `0/2`）。

```powershell
Set-Location 'D:\dev\open-gym'
git status --short
git worktree add -b codex/ai-search-p1 D:/dev/open-gym-ai-search-p1 main
Set-Location 'D:\dev\open-gym-ai-search-p1'
npm.cmd --prefix frontend ci
npm.cmd --prefix mobile-rn ci
npm.cmd --prefix api ci

$evalManifest = 'D:/dev/open-gym-ai-search-quality/.codex/ai-search-eval/quality/p1-m1-paired-manifest.json'
$outDir = '.codex/ai-search-eval/p1'
node frontend/scripts/ai-search-eval.mjs --mode replay --manifest $evalManifest --web-locale zh --include-queries --out "$outDir/p0-baseline-135.json"
```

---

## 5. Stage 1（P1-A）：全语言 `nameEn` 启用 + 同候选跨查询质量择优

### 5.1 生产改动

- [x] **`frontend/src/lib/exercise-ai-search.js`**：
  1. 在 `matchOne` 解除 `isCjkName(name)` 锁死：
     ```js
     const useEnglishQuery = !!nameEn && normalize(nameEn) !== normalize(name)
     const queries = useEnglishQuery ? [nameEn, name] : [name]
     const queryOrigins = useEnglishQuery ? ['english', 'primary'] : ['primary']
     ```
  2. 在 `pickQueryHit` 的 `hit` 对象补挂 `bodyPartMatch: !!validCandidateBodyPart && clean(exercise.bp) === validCandidateBodyPart`（不改 `pickQueryHit` 查询内 Top 3 既有排序键）。
  3. 新增 `isBetterCandidateQueryHit(next, current)` 替代 `matchOne` 中同一候选多个查询间纯按 `score` 比较的旧逻辑：
     - 比较顺序：`exact` 优先 → `equipmentMatch` 优先 → `bodyPartMatch` 优先 → `unsupportedVariants` 更少优先 → `score` 更高优先（全等保持先出现顺序，即 `english` 优先）。
  4. 保持 `queryOrigin` 为既有 `'english'` / `'primary'`、硬冲突 `exactConflict`、CJK 回退、`compareRankedHits` 全局排序不变。

### 5.2 单元测试

- [x] **`frontend/src/lib/exercise-ai-search.test.js`**：
  - 新增法语 `name` + `nameEn` 命中（`presse à pectoraux assise` + `lever chest press` → `0576`）；
  - 新增英文口语 `name` + 规范 `nameEn` 命中（`plate-loaded shoulder press` + `lever shoulder press` → `0603`）；
  - 验证 `nameEn` 与 `name` 标准化等价时不重复查询（仅 `['primary']`）；
  - 验证同候选下 `nameEn` 无变体/器械一致命中胜过词数更多但含变体/错器械的 `primary` 命中；
  - 更新 D04 对应 `queryOrigin` 测试描述并确认全部通过。

### 5.3 评测与保留门槛（RN 单端）

- [x] 运行定向单测 + 135 条冻结回放（输出 `$outDir/p1a-135.json`）+ 仓库 13 条回放（`$outDir/p1a-repo.json`）。
- [x] **保留门槛（全部满足，已独立提交 `fafa48564`）**：
  - 135 条回放 RN Top 1 净增 **≥ +3**、Top 5 净增 **≥ +3**、Recall@5 净增 **≥ +3**；
  - `edge-french-chest-press`、`final-1-photo-shoulder-press`、`prompt-b-2-hinted-chest-press`、`prompt-b-2-photo-shoulder-press` 全部救回；
  - P1 现行 90 条子集 Top 1 / Top 5 无净退化，错器械首位不增加；
  - 空结果误报 `0/2`，`88/88` golden 全部通过、`wrong-high = 0`。

---

## 6. Stage 2（P1-B）：受控查询松弛 + `lying`/`stack` 变体识别

### 6.1 生产改动

- [ ] **`frontend/src/lib/exercise-ai-search.js`**：
  1. 在 `UNSUPPORTED_VARIANT_GROUPS` 增补 2 项（沿用 `primaryName` / `nameEn` / `hintText` 豁免逻辑）：
     ```js
     { en: /\blying\b/, zh: ['仰卧', '俯卧', '躺姿'] },
     { en: /\bstack\b/, zh: ['配重片', '插销式'] },
     ```
  2. 新增显式白名单剥离表 `STRIPPABLE_MODIFIER_PATTERNS`（仅作用于非 CJK 查询）：
     - 加载/商用包装词：`plate[\s-]+loaded`、`pin[\s-]+loaded`、`selectorized`、`converging`、`iso[\s-]?lateral`、`commercial`、`gym`、`machine`、`station`、`apparatus`
     - 低区分度体位词：`seated`
     - **严禁剥离**：任何未知词以及 `incline`、`decline`、`reverse`、`single arm`、`one arm`、`single leg`、`one leg`、`close grip`、`wide grip`、`narrow`、`overhead`、`bent over`、`standing`、`lying`、`bulgarian`、`romanian`、`sumo`、`stiff leg`、`rear`、`front`、`lateral` 等语义变式词。
  3. 新增器械前缀映射表 `EQUIPMENT_QUERY_PREFIX`（仅对合法 `validCandidateEquipment` 生效）：
     - `'leverage machine': 'lever'`、`'sled machine': 'sled'`、`'smith machine': 'smith'`、`'cable': 'cable'`、`'barbell': 'barbell'`、`'dumbbell': 'dumbbell'`、`'kettlebell': 'kettlebell'`
  4. 新增 `isCleanQueryHit(hit, validCandidateEquipment, validCandidateBodyPart)`：
     - `hit.exact === true`，或 `(!validCandidateEquipment || hit.equipmentMatch) && (!validCandidateBodyPart || hit.bodyPartMatch) && hit.unsupportedVariants === 0`。
  5. 在 `matchOne` 原始查询（`english` + `primary`）循环结束后：
     - 若已触发 `exactConflict` 且无 `exact` 命中：直接按硬冲突拒绝，**禁止进入松弛**。
     - 若 `!isCleanQueryHit(best, ...)`：调用 `deriveRelaxedQueries(queries, validCandidateEquipment, genericWords)` 派生最多 **2 条**去重松弛查询：
       - 剥离后必须通过安全闸门 `wordsOf(stripped, genericWords).length >= 1`（至少保留 1 个非泛化动作核心词）；
       - 派生 1：`stripped`（与全部原查询不同时加入）；
       - 派生 2：若存在 `EQUIPMENT_QUERY_PREFIX[validCandidateEquipment]` 且 `stripped` 开头不含该前缀，加入 `${prefix} ${stripped}`。
     - 松弛查询复用 `searchScored` + `pickQueryHit`，发诊断事件 `queryOrigin: 'relaxed'`，命中挂 `relaxed: true`。
     - 比较优先级：原查询 `exact` 绝对优先于任何松弛命中；否则按 `equipmentMatch` → `bodyPartMatch` → `unsupportedVariants` 升序 → 非 `relaxed` 优先 → `score` 降序。
     - 置信度保护：`levelFor` 对 `relaxed: true` 最高返回 `'medium'`（绝不给 `'high'`），最终输出前剥离内部字段 `relaxed`。
- [ ] **`api/agent-runtime/exercise-search-diagnostics.js`**：
  - 第 33 行将 `QUERY_ORIGINS` 更新为 `new Set(['primary', 'english', 'relaxed'])`（其余字段与 `schemaVersion: 1` 不变）。

### 6.2 单元测试

- [ ] **`frontend/src/lib/exercise-ai-search.test.js`**：
  - `"seated machine chest press"`（无 `nameEn`）松弛命中 `0576` 且 `level !== 'high'`；
  - `"plate-loaded shoulder press"`（无 `nameEn`）松弛命中 `0603`；
  - `"seated leg press"`（`equipment: 'sled machine'`）松弛命中 `0739`；
  - `"seated shoulder press"` 原查询已干净命中 `1454` 时不触发 `'relaxed'` 召回事件；
  - 语义变式（`incline`、`reverse`、`single arm`）不被剥离；
  - 幻觉/泛化边界（`levitating barbell bench press`、`quantum flux squat machine`、`plate of pasta`、`seated machine`）保持空结果；
  - 硬冲突精确名（`push-up` + `smith machine`）不经松弛绕过。
- [ ] **`api/test/exercise-search-diagnostics.test.js`**：
  - 验证 `queryOrigin: 'relaxed'` 被正确投影输出，非法 `queryOrigin` 仍被丢弃。

### 6.3 评测与保留门槛（RN 单端）

- [x] 运行单测 + 135 条回放（`$outDir/p1b-135.json`）+ 仓库 13 条回放（`$outDir/p1b-repo.json`）+ P0-B 3× 30 条真实响应回放（`$outDir/p1b-p0b30.json`）。
- [ ] **保留门槛（未全部满足，已按单变量原则 `git checkout --` 完整回退并保留失败对照数据）**：相对 Stage 1 仅 Top 1 `+3`（< `+4`）、Top 5 `+2`（< `+3`）、`wrongEquipment +1`，`prompt-a-3-hinted-chest-press`/`hinted-chest-press`/`final-3-photo-leg-press` 未救回，且 `"seated machine"` 边界单测命中 `1452`。
  - 相对 Stage 1，135 条回放 RN Top 1 再净增 **≥ +4** 或 Top 5 再净增 **≥ +3**；
  - `quality-no-recall-chest`、`prompt-a-3-hinted-chest-press`、`hinted-chest-press`、`final-3-photo-leg-press` 等无理想 `nameEn` 样本被救回；
  - `hinted-shoulder-press` 保持 Top 1 命中；
  - P0-B 3× 30 条回放 Top 1 / Top 5 零退化；
  - 空结果误报 `0/2`，RN matcher P95 延迟 ≤ 180ms，`88/88` golden 通过、`wrong-high = 0`。

---

## 7. Stage 3（P1-C）：共享词法同义词补强 + 分族器械硬冲突矩阵

### 7.1 生产改动

- [x] **`frontend/src/lib/exercise-search.js`**：
  - 在 `SYNONYMS` 精准补齐无歧义商业器械与复合连写词（不动短词、不改评分公式）：
    - `selectorized` / `pinloaded` / `converging` / `isolateral` → `['lever', 'machine']`
    - `plateloaded` → `['plate loaded', 'lever']`
    - `pecdeck` → `['pec deck']`、`tbar` → `['t-bar']`
    - `latpulldown` → `['lat pulldown']`、`chestpress` → `['chest press']`、`shoulderpress` → `['shoulder press']`、`legpress` → `['leg press']`、`legextension` → `['leg extension']`、`legcurl` → `['leg curl']`、`hipthrust` → `['hip thrust']`
- [x] **`frontend/src/lib/exercise-ai-search.js`**：
  - 将 `conflictFor(hint, exercise)` 升级为分族器械硬冲突矩阵（仅在 `hint` 为合法 `candidate.equipment` 时生效）：
    - 保留：**负重/器械组** vs **徒手/弹力带组**（`body weight`、`band`、`resistance band`）冲突（已验证 `body weight` hint 反向拦截 `FIXED_MACHINES` / `FREE_WEIGHTS` 对 golden 与回放零回归并启用）；
    - 新增：**固定商用器械组**（`leverage machine`、`sled machine`、`smith machine`）与 **自由重量组**（`barbell`、`ez barbell`、`olympic barbell`、`trap bar`、`dumbbell`、`kettlebell`、`weight plate`）互斥；
    - 明确不互斥：`leverage machine` ↔ `sled machine`、`barbell` ↔ `olympic barbell` / `ez barbell` / `trap bar`、`cable` ↔ `FIXED_MACHINES`（由软排序处理，避免混合缆绳商用机误杀）。

### 7.2 单元测试

- [x] **`frontend/src/lib/exercise-ai-search.test.js`**：
  - 验证 `FIXED_MACHINES` vs `FREE_WEIGHTS` 双向冲突（如 `hack squat` + `equipment: 'sled machine'` 拒绝 `0046 barbell hack squat` 并选中 `0743 sled hack squat`）；
  - 验证 `leverage machine` ↔ `sled machine` 兼容不误杀。
- [x] **`frontend/src/lib/library-search-rn.test.ts`**：
  - 验证共享引擎新增同义词（`pecdeck`、`tbar`、`selectorized`、`latpulldown`）在 RN 常规搜索命中且无回归。

### 7.3 评测与保留门槛（RN 单端）

- [x] 运行单测（含常规搜索全套 `exercise-search-rn.test.js`、`library-search-rn.test.ts`、`exercises.test.js`）+ 135 条回放（`$outDir/p1c-135.json`）+ 仓库 13 条回放（`$outDir/p1c-repo.json`）+ P0-B 3× 30 条回放。
- [x] **保留门槛（全部满足，已独立提交 `6fc84f294`）**：
  - 相对 Stage 2，135 条回放 RN Top 1 / Top 5 不退化且**错器械首位下降或持平**（`FIXED_MACHINES` vs `FREE_WEIGHTS` 零误杀正例）；
  - P0-B 3× 30 条回放零退化；
  - 常规搜索单测 100% 通过，`88/88` golden 通过、`wrong-high = 0`。

---

## 8. 最终全量回归与验收交付

在最终保留 HEAD 上运行以下命令（要求退出码全 `0`）：

```powershell
# API 构建与 Agent / 诊断单测
npm.cmd --prefix api run build
node --test api/test/agent-exercise-search.test.js api/test/agent-providers.test.js api/test/agent-runtime.test.js api/test/exercise-search-diagnostics.test.js
npm.cmd --prefix api run test:nest -- test/nest/agent.test.js test/nest/agent-exercise-search.test.js

# Frontend 共享搜索、AI matcher（含 88 golden）、评估 CLI 与构建
npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/exercise-search-rn.test.js src/lib/library-search-rn.test.ts src/lib/exercises.test.js
npm.cmd --prefix frontend run test:ai-search-eval
npm.cmd --prefix frontend run build

# Mobile-RN 全套静态检查
npm.cmd --prefix mobile-rn run check
git diff --check
```

- [x] 新增脱敏验收报告 `docs/ai-exercise-search/eval/P1_RESULTS.md`，记录：基线与 P1-A / P1-B / P1-C 逐阶段 RN 指标、P1 现行 90 条与历史 45 条拆分、P0-B 3× 30 条回放对照、逐样本增退表、保留/回退判定及回归退出码。
- [x] 勾选更新本执行文档 TODO 状态；原始 `.codex/ai-search-eval/p1/` 报告保留在本地 git 忽略目录不提交；合并主分支需用户另行确认。

## 9. 止损与重规划条件

出现以下任一情况立即暂停并重规划，不做临时凑分：
1. 任意阶段导致 `88/88` golden 中 `ambiguous` / `conflict` / `boundary` 任一失败或 `wrong-high > 0`；
2. 135 条回放出现 `空结果误报 > 0/2`；
3. P1 现行 90 条子集 Top 1 或 Top 5 相对 P0-A 出现净退化；
4. `exercise-search.js` 同义词改动导致 `exercises.test.js` 或 `exercise-search-rn.test.js` 常规搜索回归。
