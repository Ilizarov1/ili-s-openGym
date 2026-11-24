# AI 动作检索上游 VLM Prompt 优化设计（`vlm-prompt-v2`）

> 所属子系统：`ai-agent` · 交接基线：[VLM_PROMPT_HANDOFF.md](VLM_PROMPT_HANDOFF.md) · Iter1 对比：[ITER1_COMPARISON.md](ITER1_COMPARISON.md) · 执行计划：[VLM_PROMPT_EXECUTION.md](VLM_PROMPT_EXECUTION.md) · 子系统路由：[ai-agent/README.md](../../../../docs/subsystem/ai-agent/README.md)

## 1. 背景与实测失误归因

在 Iter1（[DESIGN.md](DESIGN.md) / [ITER1_COMPARISON.md](ITER1_COMPARISON.md)）完成服务端 `v2` 精排与领域护栏纠偏后，下游检索侧自身过自信已清零（`detailed` `Wrong-High = 0/32`、`repo13` `Top-1 = 90.9% / Top-5 = 100%`）。对 Iter1 实测日志与 `v1-vs-v2` 冻结 `*-replay.json` 逐样本复核后，确认剩余误差几乎全部来自上游 `deepseek-flash` VLM 识别输出：

### 1.1 四类 Prompt 可直接修复的上游错误

| 误差类型 | 典型样本（Iter1 实测） | 失误现场 | 修复机制 |
|---|---|---|---|
| **① 观察与候选自相矛盾** | `machine_002`（上斜推胸）、`machine_005`（腿屈伸）、`machine_023`（蝴蝶机）、`machine_026`（高位反握下拉） | `002` 写出“双手握住手柄向上向前推杠杆臂”却输出 `sled leg press (high)`；`005` 写出“座垫前方低位水平黑色圆柱滚轴（小腿垫）”却输出 `lever pec deck fly (high)`；`023` 写出“向前内收弧形运动”却将 `chest press (high)` 排在 `pec deck fly` 前；`026` 写出“杠杆臂朝使用者方向拉下”却输出 `lever standing chest press` | 规则 4 强制「驱动机构 → 人体接触垫与发力肢体 → 运动方向」顺序观测，并强制 `candidates` 与已写出的接触垫/发力方向严格一致（禁止无踏板出 `leg press`、见小腿滚轴出 `pec deck`/`chest press`、下拉臂出 `chest press`） |
| **② 明确卧姿/上斜姿势未写入英文名** | `machine_020`（仰卧推胸，`photo-only`/`simple`/`alias` 三档全 `Wrong-High`）、`machine_016`（上斜推胸）、`machine_025`（俯卧腿弯举） | `020` 在 `understanding` 中明确写出“带黑色平凳、用户以仰卧姿势躺在平凳上”，却只输出通用 `lever chest press (high)` 导致错配坐姿推胸 `0576`；`016` 写出“30–40° 倾斜背垫”却输出 `lever shoulder press` | 规则 4 + `Names` 明确要求：清晰可辨的平凳仰卧/俯卧（`lying`）或约 30–45° 斜靠背（`incline`）必须保留在英文候选名中（`lever lying chest press` / `lever incline chest press` / `lever lying leg curl`），未可核实时才省略 |
| **③ 易混几何与多用途器械过自信 `high`** | `machine_005`、`013`、`020`、`023`、`024`（`simple` 输入“深蹲卧推”）、`025`、`027`（`near_ood`） | 纯图或多用途器械（史密斯机）/ 双义几何下仍给出 `level: 'high'`，绕过下游 VLM 硬上限护栏造成 `Wrong-High`（`photo-only` `4/32`、`simple` `4/32`、`alias` `2/32`） | 规则 6 明确 `level` 封顶 `medium`（严禁 `high`）条件：两类近亲动作/方向均说得通（推胸 vs 推肩、推胸 vs 夹胸、腿屈伸 vs 坐姿腿弯举 vs 提踵、髋内收 vs 外展、哈克 vs 倒蹬、坐姿 vs 仰卧/上斜）或无单一明确动作线索的多用途器械，并配对比型 `clarifications` |
| **④ 废片/特写/多器械全景强猜 `medium`** | `machine_022`（逆光多器械全景）、`029` / `030`（局部特写）、`031`（严重运动模糊） | `022` 已自述“逆光剪影、成排器械无法锁定单一动作”，`031` 自述“照片模糊”，仍吐出 `lever seated row` / `sled hack squat` 等 `medium` 候选，导致四档 `BadImage-FP` 恒为 `4/6` | 规则 4 与规则 6 补充拒识条款：严重模糊、严重逆光/暗光、仅见局部挂片杆/垫边/铭牌缺少完整动作几何、或同框 `>= 3` 台器械无单一主体，且 `hintText` 无实质动作线索（“这是什么”“帮我认一下”等泛化问句不计）时返回 `candidates: []`；同时明示单台轻度遮挡/侧拍前景器械仍正常出候选，防误拒正例 |

### 1.2 本轮边界（Out of Scope）
- **不改 JSON Schema 与截断上限**：保持 `EXERCISE_SEARCH_INPUT_SCHEMA`、`EXERCISE_SEARCH_OUTPUT_SCHEMA`、`MAX_UNDERSTANDING = 400`、`MAX_CANDIDATES = 5` 及全部后处理清洗函数零改动。
- **不改服务端检索/精排逻辑与 `v1` 匹配器**：保持 `api/src/agent/retrieval/`、`frontend/src/lib/exercise-ai-search.js`、`services/retrieval-model/main.py` 零改动，使本轮 A/B 严格隔离 Prompt 改动净效应。
- **不引入 Node 内置依赖**：`api/agent-runtime/tasks/exercise-search.js` 严格维持纯 ESM 跨端共享红线（供 RN Metro 打包与 NestJS 共用）。

---

## 2. Prompt v2 精简改造方案

仅修改 `D:\wt\og-retrieval\api\agent-runtime\tasks\exercise-search.js` 中 `PROMPT` 的 **规则 4、规则 6 与 `## Names` 末句**（严格控制增量篇幅，防止规则过长诱发轻量 VLM 幻觉或推理变慢）。

### 2.1 目标 Prompt 文本（规则 4、规则 6 与 `Names`）

- **规则 4（结构化观测顺序 + 观察-候选强一致 + 废片拒识）**：
  ```text
  4. `fallback` is mandatory, honest, and written before `candidates`. In
     `fallback.understanding`, first record the objective visible or stated evidence in
     order: (a) drive mechanism (plate-loaded lever arms, angled rail/sled carriage,
     cable/pulley stack, or free weight), (b) body-contact pads and driving limb —
     shin/ankle cylindrical roller, thigh pad, large angled footplate, or shoulder pads
     indicate lower-body (`upper legs`/`lower legs`) unless clear upper-body press/pull
     handles dictate otherwise; distinguish chest-support pad (facing forward to pull/row/
     reverse fly), upright backrest (seated press/fly/leg extension), angled ~30–45°
     backrest (incline press), and flat/prone bench (lying press or lying leg curl),
     (c) movement path/direction (push, pull, inward arc/fly, kick/extend, or curl) and
     legible machine label text. Then generate `candidates` strictly consistent with
     those written observations: never emit `leg press` when handles are pushed by hand
     with no footplate, never emit `pec deck`/`chest press` when a shin/ankle roller is
     present, and never emit a pressing exercise when the lever pulls toward the user.
     If the photo is unreadable (severely motion-blurred, heavily backlit/dark, tightly
     cropped to a partial pad/horn/label without full operating geometry, or a cluttered
     gym panorama with 3+ machines and no single clear foreground subject) and `hintText`
     gives no actionable exercise cue (generic prompts like "这是什么"/"帮我认一下" do
     not count), return `candidates: []` and explain what is missing and how to reshoot in
     `fallback.understanding`. When you found no candidates, the fallback is the whole
     answer — make it useful.
  ```

- **规则 6（易混/多用途封顶 `medium` + 拒识不硬凑 + 单主体轻度遮挡保护）**：
  ```text
  6. Candidates are ranked by confidence. `level` is one of `high`, `medium`, `low`:
     `high` — you can name the specific exercise (or a close standard variant) with
     certainty; `medium` — a well-matched class of exercises where the exact one depends
     on equipment or setup you cannot see; `low` — a plausible guess only. Cap `level` at
     `medium` (never `high`) whenever two sibling movements or directions plausibly fit
     the visible geometry (e.g., chest press vs shoulder press, chest press vs pec deck
     fly, leg extension vs seated leg curl vs calf raise, hip adduction vs hip abduction,
     hack squat vs leg press, seated vs lying/incline press), or when the apparatus is
     multi-function (such as a Smith machine or cable tower) without `hintText`
     confirming one exact movement — and provide contrastive `clarifications`. Return at
     most 5 candidates and drop anything you would call lower than `low`; do not force
     `medium` guesses on unreadable, cropped, or multi-machine panorama photos without an
     actionable cue (if a single foreground machine is reasonably visible despite mild
     occlusion or side angle, still output candidates at `medium`/`low`). When the angle,
     the grip or whether the movement is one-sided is not verifiable, prefer the more
     general exercise and omit the variant you cannot support — one solid candidate beats
     padded guesses. For a multi-function apparatus, name only the movements its visible
     geometry plausibly supports.
  ```

- **`## Names` 末句（明确可辨卧姿/上斜保留在英文检索名中）**：
  ```text
  Put an angle or a posture into the
  English name when it is clearly discernible and separates this movement from its
  siblings (e.g., use "lying" for a flat lying/prone bench and "incline" for a ~30–45°
  angled backrest: "lever lying chest press", "lever incline chest press", "lever lying
  leg curl"), and omit it when not verifiable.
  ```

### 2.2 必保的单测字符串契约（`api/test/agent-exercise-search.test.js` L198–L210）

改写后 `task.instructions()` 必须**逐字原样包含**以下全部子串：
- `Output is JSON and nothing else`
- ``Emit `fallback` first and `candidates` second``
- ``written before `candidates` ``
- `drive mechanism`
- `clarifications`
- `Never invent, guess or reference catalogue`
- `## Allowed body part slugs`、`## Allowed equipment slugs`、`leverage machine`
- `lever", "sled" or "cable"`
- `Output is JSON`

同时在 `api/test/agent-exercise-search.test.js` 新增 Prompt 回归断言，锁住「人体接触结构与发力肢体」「观察-候选一致约束」「废片返回空 `candidates`」「易混封顶 `medium`」四项核心指令不被后续改动误删。

---

## 3. 语义级变更声明（Semantic Change Declaration）

### 子系统：`ai-agent`

- **涉及模块与真实入口**：
  - 入口路径 / 命令：
    - 服务端在线检索：`D:\wt\og-retrieval\api\src\agent\agent.service.ts` → `createExerciseSearchTask()` / `createExerciseSearchV2Task()`（通过 `api/dist/agent-runtime/tasks/exercise-search.js` 生效）；
    - 客户端本机直连：`D:\wt\og-retrieval\mobile-rn\src\agent\ai-search.ts`（直接引入共享 `api/agent-runtime/index.js`）；
    - 评测流水线：`D:\wt\og-retrieval\frontend\scripts\ai-search-eval.mjs`（`--mode e2e --include-server-v2` 调用共享 `createExerciseSearchTask()` 驱动真实 `deepseek-flash` VLM）。
  - 拟改动源码：
    - `D:\wt\og-retrieval\api\agent-runtime\tasks\exercise-search.js`（仅更新 `PROMPT` 规则 4、规则 6 与 `## Names` 末句）；
    - `D:\wt\og-retrieval\api\test\agent-exercise-search.test.js`（补充 Prompt v2 核心指令契约断言）；
    - 同步产物：`D:\wt\og-retrieval\api\dist\agent-runtime\tasks\exercise-search.js`（通过 `npm.cmd --prefix api run build` 自动刷新）。
- **触发条件（Trigger）**：
  - 任何经由 `exercise-search.v1`（Web/RN 本机直连或服务端 v1）或 `exercise-search.v2`（服务端混合检索）发起的文本、拍照或图文动作识别请求，以及运行 `ai-search-eval.mjs --mode e2e` 实况 VLM 评测时触发。
- **改前 / 改后行为（Before / After）**：
  - **Before**：现行 `PROMPT` 仅泛泛要求记录驱动机构与轨迹，未强调人体接触垫/发力肢体先判、观察与候选强一致、可辨卧姿/上斜名称保留及废片拒识；实测导致 `deepseek-flash` 在 `photo-only` 下出现写对结构猜错动作（`002`/`005`/`023`/`026`）、平凳漏写 `lying`（`020` 三档 `Wrong-High`）、废片强吐 `medium` 候选（`BadImage-FP = 4/6`）及易混器械误标 `high`（`Wrong-High = 4/32`）。
  - **After**：VLM 先按「驱动机构 → 人体接触垫与发力肢体 → 运动方向」客观记述，再生成与观测严格一致的 `candidates`（明晰卧姿/上斜保留在 `nameEn` 中）；对易混双义几何与未指明动作的多用途器械封顶 `medium` 并附对比型 `clarifications`；对无实质 `hintText` 的模糊/暗光/特写/全景废片诚实返回 `candidates: []` 与补拍建议，使下游 `v2` 与 `v1` 均可直接回落安全拒识。
- **接口 / 状态 / 兼容性变化（Contract, State & Compatibility）**：
  - **接口契约**：`EXERCISE_SEARCH_INPUT_SCHEMA`、`EXERCISE_SEARCH_OUTPUT_SCHEMA`、`EXERCISE_SEARCH_V2_OUTPUT_SCHEMA` 与 `api/openapi.yaml` 零字段增删改；输出仍严格校验为 `{ fallback, candidates, clarifications? }`。
  - **状态与持久化**：不修改 PostgreSQL 索引与表结构、`DATA_DIR` 存储、RN SQLite 或客户端状态树。
  - **兼容性与迁移**：纯 ESM 零 Node 内置依赖，100% 兼容 NestJS 与 Expo/Metro 打包；所有旧单测字符串契约全量保留；不修改既有冻结 replay 文件，新实测结果输出到独立目录 `vlm-prompt-v2/`。
- **失败模式与降级兜底（Failure Modes & Fallback）**：
  - 若模型因指令增加出现极端情况下的空候选（误拒）：单主体轻度遮挡/侧拍保护句显式要求继续产出 `medium`/`low` 候选，且评测阶段将在 `photo-only` / `simple` / `alias` / `detailed` / `repo13` 全量核对 `Coverage` 与 `cross_domain_occlusion` 切片无退化；
  - 若 `deepseek-flash` 返回非合法 JSON 或触发网络超时，仍由 `parseOutput` 与 `AgentError` 既有兜底链路处理；
  - 若实测发现某条约束引起副作用（例如某档 `Top-1` 或 `Coverage` 倒退），允许在 `VLM_PROMPT_EXECUTION.md` 的受控微调轮（Iter2b）中收敛文案并保留完整前后对比数据。
- **实测证据（Empirical Evidence）**：
  - **改前基线（Iter1 + 现行 Prompt）**：[VLM_PROMPT_HANDOFF.md](VLM_PROMPT_HANDOFF.md) §2 与 [ITER1_COMPARISON.md](ITER1_COMPARISON.md)（`photo-only` `v2` Top-1 `36.0% (9/25)` / Top-5 `52.0%` / `Wrong-High 4/32` / `BadImage-FP 4/6`；`simple` `76.0% / 88.0% / 4/32`；`alias` `88.0% / 96.0% / 2/32`；`detailed` `84.0% / 92.0% / 0/32`；`repo13` `90.9% / 100.0% / 0/13`）。
  - **改后闭环实测证据**（执行完成后回填于 [VLM_PROMPT_EXECUTION.md](VLM_PROMPT_EXECUTION.md) 与 `VLM_PROMPT_COMPARISON.md`）：`api` 构建与全部单测、`test:ai-search-eval`，以及 `D:\dev\.tools\opengym-retrieval\eval-runs\vlm-prompt-v2\` 下 `photo-only`、`simple`、`alias`、`detailed`（及 `repo13`）真实 `deepseek-flash` E2E 评测报告与 Iter1→Iter2 逐指标/逐样本前后对比表。
