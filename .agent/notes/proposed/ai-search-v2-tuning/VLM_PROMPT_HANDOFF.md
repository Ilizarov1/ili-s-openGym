# AI 动作检索上游 VLM Prompt 优化交接文档（`VLM_PROMPT_HANDOFF`）

> 关联文档：[精排纠偏设计](DESIGN.md) · [Iter1 对比报告](ITER1_COMPARISON.md) · [v2 评测基线交接](../ai-search-eval-v2/HANDOFF.md) · [子系统路由](../../../../docs/subsystem/ai-agent/README.md)

## 1. 工作区与资产地图

| 位置 | 角色 / 分支 | 关键路径与说明 |
|---|---|---|
| `D:\dev\open-gym` | 主仓（样本与文档） | [test_pic/](../../../../test_pic/)（32 样本：`benchmark.json` + 5 份 `manifest-*.json`）；[ai-search-v2-tuning/](.) 全部方案、Iter1 报告与本交接文档 |
| `D:\wt\og-retrieval` | `codex/server-retrieval`（当前已调优 `v2` 与评测器） | **Prompt 主文件**：`api/agent-runtime/tasks/exercise-search.js`（`PROMPT` L33–L101，由 `exercise-search-v2.ts` 与 `v1` Web/RN 共用）；检索排序：`api/src/agent/retrieval/`（`ranking.ts` + `retrieval.service.ts`）；评测 CLI：`frontend/scripts/ai-search-eval*.mjs` |
| `D:\dev\.tools\opengym-retrieval` | 本机依赖与外置评测档案（不入库） | PG `127.0.0.1:55432`、ROCm BGE `127.0.0.1:8765`、`retrieval.env`（含 `DEEPSEEK_API_KEY`）；`eval-runs\v1-vs-v2-iter1\` 保存了本轮调优后 `v2` 的 4 档 + `repo13` 基线报告；`eval-runs\v1-vs-v2\` 保存了旧 VLM 冻结 `*-replay.json` |

> 注：`api/agent-runtime/tasks/exercise-search.js` 必须保持纯 ESM、无 Node 内置模块依赖（Metro / RN 打包红线），且修改后须跑 `npm.cmd --prefix api run build` 同步刷新 `api/dist/agent-runtime/`。

---

## 2. 当前 Iter1 基线（调优后 `v2` + 现行 Prompt）

下表为现有 Prompt（`deepseek-flash` VLM）配合 Iter1 已修复检索器后的实测基线，作为下轮 Prompt 改动 A/B 对照基准：

| 数据集 / 梯度 (样本) | `v2` Top-1 / Strict / Top-5 | `v2` Wrong-High | `v2` BadImage-FP (High-FP) | `v2` NearOOD-FP (High-FP) | `v2` 歧义 `clarNoHigh` / 清晰打扰 | 对应参照报告 |
|---|---|---|---|---|---|---|
| `photo-only` (32) | `9/25 (36.0%)` / `32.0%` / `13/25 (52.0%)` | `4/32 (12.5%)` | `4/6 (66.7%)` (`0/6`) | `1/1` (`1/1`) | `8/9` / `5/9` | [ITER1_COMPARISON.md](ITER1_COMPARISON.md) |
| `simple` (32) | `19/25 (76.0%)` / `72.0%` / `22/25 (88.0%)` | `4/32 (12.5%)` | `4/6 (66.7%)` (`0/6`) | `1/1` (`1/1`) | `6/9` / `2/9` | [ITER1_COMPARISON.md](ITER1_COMPARISON.md) |
| `alias` (32) | `22/25 (88.0%)` / `80.0%` / `24/25 (96.0%)` | `2/32 (6.3%)` | `4/6 (66.7%)` (`0/6`) | `1/1` (`1/1`) | `6/9` / `2/9` | [ITER1_COMPARISON.md](ITER1_COMPARISON.md) |
| `detailed` (32) | `21/25 (84.0%)` / `84.0%` / `23/25 (92.0%)` | `0/32 (0.0%)` | `4/6 (66.7%)` (`0/6`) | `1/1` (`0/1`) | `5/9` / `4/9` | [ITER1_COMPARISON.md](ITER1_COMPARISON.md) |
| `repo13` 回放 (13) | `10/11 (90.9%)` / `72.7%` / `11/11 (100.0%)` | `0/13 (0.0%)` | - | `0/2` (`0/2`) | `12/13` | `v1-vs-v2-iter1\repo13-report.json` |

---

## 3. 上游 VLM 失误诊断（为什么下游检索已触顶，必须改 Prompt）

经对 `photo-only` 16 例正例失误与 7 例异常图逐条核查，上游 `deepseek-flash` 的错误分成两类：

1. **Prompt 可救的一类（观察与结论自相矛盾 + 废片强猜 + 过自信 `high`）**：
   - **看对了结构但猜错动作**：
     - `machine_002`（上斜推胸）：`fallback.understanding` 已明确写出“双手握住手柄，向上并向前推动杠杆臂”，下一句却跳变猜测 `sled leg press (high, upper legs)`；
     - `machine_005`（坐姿腿屈伸）：`understanding` 已写出“座垫前方低位有一根水平黑色圆柱滚轴（小腿垫）”，下一句却忽略小腿滚轴改猜 `lever pec deck fly (high, chest)`。
   - **废片强行脑补 `medium` 候选**：`machine_022`（暗光+多主体）、`machine_029` / `030`（局部裁剪特写）、`machine_031`（严重运动模糊+过曝）下，VLM 仍吐出 `lever chest press` / `lever seated row` 等标准英文名（`medium`），使看不到原图的下游检索层无可拦截（`BadImage-FP = 4/6`）。
   - **纯图下对错动作/库外图给 `high`**：`photo-only` / `simple` 余留的 `4/32` `Wrong-High`（`machine_005`, `020`, `024`, `025`, `027`）100% 源于 VLM 自身给出 `level: 'high'` 且精确命错库内近亲。
2. **纯视觉几何上限（勿对单个 Prompt 强求 100%）**：
   - 如 `machine_017`（仰拍哈克机将肩垫看成上推握把臂）、`machine_014`（正面坐姿划船将前胸垫看成靠背）、`machine_025`（俯卧腿弯举看成坐姿提踵）——轻量 VLM 在底层零件识别本身已出错；规则切忌写太长或强行要求列举不存在的细节，否则会诱发脑补幻觉和输出变慢。

---

## 4. 下轮精简版结构化 Prompt 改造方案

**原则**：只精炼扩充 `D:\wt\og-retrieval\api\agent-runtime\tasks\exercise-search.js` 中 `PROMPT` 的 **规则 4 与规则 6**（约 4–6 行高密度英文指令），**不改 JSON Schema**（`MAX_UNDERSTANDING` 维持 `400`、`candidates` 字段不变），同步保持现有单元测试断言全部成立。

### 三项核心增量设计
1. **人体接触结构与发力肢体先判（Contact & Driver Check）**：
   - 在规则 4 的 `fallback.understanding` 观测顺序中，要求在“驱动机构（lever/sled/cable/free weight）”之后立即定位**人体接触与承载结构**：
     - 看见小腿/脚踝水平圆柱滚轴（shin/ankle roller）、大腿压垫（thigh pad）、大斜面踩踏板（footplate）或双肩顶肩垫（shoulder pads）→ 优先判定为**下肢驱动（`upper legs` / `lower legs`）**，除非另有明确的握把推拉轨迹；
     - 区分**前胸贴靠垫（chest support pad → 划船/反向飞鸟）**、**后背靠背（backrest → 推胸/推肩/腿屈伸）**与**俯卧长垫（prone pad → 俯卧腿弯举）**，并判断推/拉/踢/勾的运动方向。
2. **观察与候选强一致约束（Strict Observation-to-Candidate Consistency）**：
   - 明确规定：`candidates` 的 `bodyPart` 与动作类型**必须与 `fallback.understanding` 刚刚写出的接触结构和发力方向严格一致**。
   - 若描述中已写出“双手推/拉握把”且未见到蹬腿踏板，禁止输出腿举（`leg press`）；若描述中已识别出小腿滚轴/脚踝滚筒，禁止输出夹胸/推胸动作（`pec deck` / `chest press`）。
   - 若两种发力方向在图中同样说得通（如推胸 vs 推肩、腿屈伸 vs 腿弯举、髋内收 vs 髋外展、哈克 vs 倒蹬、平推 vs 仰卧推），最高候选 `level` **不得标 `high`**（封顶 `medium`），并保留对比型 `clarifications`。
3. **废片 / 信息不足拒识条款（Insufficient-Evidence Rejection）**：
   - 在规则 4 与规则 6 补充：当照片存在以下任一情况、且 `hintText` 未提供足够补充动作线索时，**不要硬凑 `candidates`（返回 `candidates: []`）**，只在 `fallback.understanding` 中诚实说明缺失依据与建议补拍方式：
     - 严重模糊、过曝、逆光或极暗（无法辨清驱动结构与发力方向）；
     - 局部特写裁切过大（仅见局部垫子/铭牌/配重片，看不到完整动作几何）；
     - 健身房全景杂乱图（同框 `>= 3` 台不同器械且无单一明确主体）。

### 必保的单测字符串契约（严禁改丢）
`D:\wt\og-retrieval\api\test\agent-exercise-search.test.js` L198–L210 对 `task.instructions()` 做了精确子串强断言，改 `PROMPT` 时**必须原样保留**以下所有片段：
- `Output is JSON and nothing else`
- ``Emit `fallback` first and `candidates` second``
- ``written before `candidates` ``
- `drive mechanism`
- `clarifications`
- `Never invent, guess or reference catalogue`
- `## Allowed body part slugs`、`## Allowed equipment slugs`、`leverage machine`、`lever", "sled" or "cable"`

---

## 5. 下一会话上手与 A/B 实测命令（PowerShell）

> 注意：`ai-search-eval.mjs` 调真实 `deepseek-flash` 需要同时设置 `OPEN_GYM_EVAL_PROVIDER` 与 `OPEN_GYM_EVAL_MODEL`（`DEEPSEEK_API_KEY` 由 `retrieval.env` 提供）。先跑 `photo-only` 与 `simple` 两档验证净收益，确定正向后再补跑 `alias` / `detailed`（每次 `e2e` 32 样本会调用 32 次 `deepseek-flash` VLM）。

```powershell
# 1. 启动/检查检索依赖（55432 PG + 8765 ROCm BGE）
Set-Location D:\wt\og-retrieval
try { Invoke-RestMethod http://127.0.0.1:8765/health } catch { .\scripts\windows\Start-Retrieval.ps1 -RuntimeRoot D:\dev\.tools\opengym-retrieval }

# 2. 修改 api/agent-runtime/tasks/exercise-search.js 后先过编译与全部单测门禁
npm.cmd --prefix api run build
node --test api/test/agent-exercise-search.test.js api/test/retrieval.service.test.js api/test/exercise-search-diagnostics.test.js
node --test api/test/nest/agent-exercise-search.test.js
npm.cmd --prefix frontend run test:ai-search-eval

# 3. 跑实况 VLM + 已调优 v2 对比（先跑 photo-only + simple；若正向再把 alias, detailed 加入列表）
$env:OPEN_GYM_EVAL_PROVIDER = 'deepseek'
$env:OPEN_GYM_EVAL_MODEL = 'deepseek-flash'
$outDir = 'D:\dev\.tools\opengym-retrieval\eval-runs\vlm-prompt-v2'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

foreach ($tier in @('photo-only', 'simple')) {
  node --env-file=D:\dev\.tools\opengym-retrieval\retrieval.env frontend/scripts/ai-search-eval.mjs `
    --mode e2e `
    --manifest "D:\dev\open-gym\test_pic\manifest-$tier.json" `
    --benchmark D:\dev\open-gym\test_pic\benchmark.json `
    --include-server-v2 `
    --save-replay "$outDir\$tier-replay.json" `
    --out "$outDir\$tier-report.json"
}

# 4. 同轮 v1 vs 新 Prompt v2 对照；并可与上一轮 Iter1 报告逐指标对比
node frontend/scripts/ai-search-eval-compare.mjs `
  --input "photo-only=$outDir\photo-only-report.json" `
  --input "simple=$outDir\simple-report.json" `
  --baseline rn `
  --out-md "$outDir\PROMPT_V2_COMPARISON.md" `
  --out-json "$outDir\compare-summary.json"
```

### 下轮验收门槛（相对 Iter1 基线）
- **`photo-only`**：Top-1 由 `36.0% (9/25)` 明显提升（目标 `>= 48%`），`Wrong-High <= 2/32`（目标 `<= 4/32` 且严格低于 Iter1）；
- **拒识安全**：`BadImage-FP` 由 `4/6` 明显下降（目标 `<= 2/6`），`BadImage-High-FP` 保持 `0/6`；
- **无回归防线**：`simple`（`76% / Top-5 88%`）、`alias`（`88% / Top-5 96%`）、`detailed`（`84% / Top-5 92% / Wrong-High 0%`）及 `repo13` 不出现明显退化（`simple` 确认无退化后再全量跑 `alias`、`detailed` 与 `repo13`）。
