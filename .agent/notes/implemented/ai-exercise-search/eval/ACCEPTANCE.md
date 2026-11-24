# AI 动作检索评估 CLI 与诊断日志验收记录

[执行文档](../EVAL_CLI_EXECUTION.md) · [runbook](README.md)

本页保留 2026-11-22 的离线、fixture 与真实模型报告。A5 双进程浏览器拼接和 RN 设备端轨迹按原记录标注。命令在 `D:\dev\open-gym`（`main`，`19b57a8da`）使用 PowerShell 执行。当前真实模型配置见 [评估 CLI](README.md)。

## 环境

| 项 | 实际值 |
|---|---|
| 工作树 | `D:\dev\open-gym`，HEAD `19b57a8da`，本任务改动未提交前记录 |
| Node / npm | v24.18.0 / 11.16.0 |
| frontend 依赖 | 已安装（未重跑 `npm ci`，D14 仅在未装依赖时要求） |
| 真实模型 | 当时网关上的 DeepSeek V4.1 Flash，凭据由彼时的本机环境文件提供 |
| Android | 真机 `10AD3Z1EPU0029R` 在线；本记录未做设备端轨迹（见待验） |

## 命令矩阵

| # | 命令（仓库根目录） | 退出码 | 结果摘要 |
|---|---|---|---|
| 1 | `npm.cmd --prefix frontend run test:ai-search-eval` | 0 | node:test 8/8；子进程回放 ×2 + 参数错误 ×2 + 进程内 fixture vision/e2e；临时文件零残留 |
| 2 | `npm.cmd --prefix frontend run eval:ai-search -- --mode replay --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/replay.json` | 0 | run=10 skipped=5 errors=0；web/rn 双端 10/10；报告 [replay.json](../../../.codex/ai-search-eval/replay.json) |
| 3 | 第二次回放 `--out .codex/ai-search-eval/replay-2.json` | 0 | 除 elapsedMs/gitCommit 外 samples 与 summary 与第一次完全一致（A1 一致性） |
| 4 | `$env:OPEN_GYM_EVAL_PROVIDER='fixture'` + `--mode e2e --group photo-only ... --out .codex/ai-search-eval/fixture-e2e.json` | 0 | run=5 errors=0；web/rn 双端 5/5；每样本一次模型调用 |
| 5 | `node --test api/test/exercise-search-diagnostics.test.js api/test/agent-runtime.test.js api/test/agent-exercise-search.test.js` | 0 | 59/59（诊断 18 + 运行核心 22 + 任务 19） |
| 6 | `npm.cmd --prefix api run test:nest -- test/nest/agent.test.js test/nest/agent-exercise-search.test.js` | 0 | 13/13（服务端绑定回归） |
| 7 | `npm.cmd --prefix frontend test -- src/lib/exercise-ai-search.test.js src/lib/library-search-rn.test.ts src/components/ExerciseAiSearch.test.jsx` | 0 | 56/56（matcher 22、RN 搜索适配 7、Web 组件 27） |
| 8 | `npm.cmd --prefix frontend run build` | 0 | 生产构建通过（跨树诊断模块及其词表 JSON import attribute 入包） |
| 9 | `npm.cmd --prefix mobile-rn run check` | 0 | lint/typecheck/design:check 通过；仅 2 条既有 `react/no-array-index-key` warning（仓库基线，非本任务引入） |
| 10 | `npm.cmd --prefix api run build` | 0 | `dist ready`；`dist/agent-runtime/exercise-search-diagnostics.js` 存在（D03 验收） |
| 11 | `git diff --check` | 0 | 无空白错误 |
| 12 | Metro 打包：`npx.cmd expo export --platform android`（mobile-rn） | 0 | `index-3539bb855ac7ef7070770fecbe67b559.hbc`，SHA-256 `603F65B2D01D6169BC8421B193BB3689267E7697CC57EFEFF32DCA7319F89FFC`；导出目录已清理 |
| 13 | 真实视觉 `--mode vision --sample photo-chest-press` | 0 | 1 样本，模型 15001ms，3 候选，equipment=`leverage machine`。 [历史报告](../../../.codex/ai-search-eval/real-vision.json) |
| 14 | 真实整链路 `--mode e2e --sample photo-chest-press --sample hinted-chest-press` | 0 | hinted 12543ms，双端 `["0576","1301","2659"]`，firstExpectedRank=1。photo-only 18703ms，双端 `["0791","1941"]`，first=null。 [历史报告](../../../.codex/ai-search-eval/real-e2e.json) |

四份生成报告（`real-vision/real-e2e/replay/fixture-e2e.json`）均不含密钥、Data URL、图片路径或文件名（脚本断言 `privacy-ok`）；`.codex/` 已加入 `.gitignore`，报告不提交。

## 验收对照

| 编号 | 操作 | 结果 | 证据 |
|---|---|---|---|
| A1 | 断网执行 replay（无客户端界面、无密钥、无网络：replay 不创建 provider） | 通过 | 双端 10/10；两次回放的排名与判定一致（矩阵 #2/#3 + D12 A2/A4 用例）；报告含 attachments/model/recognition/recall/filter/display 全阶段 |
| A2 | 目标在原始第 3 名且最终未出现；零召回样本；首名被拒可区分；开关前后业务输出相同 | 通过 | `hinted-leg-extension`：expectedRanks 5/6/3、finalIds `["5664","5178"]` 不含期望 ID；`edge-out-of-catalogue`：hitCount=0、`no_hit`、fallbackOnly；`edge-cjk-leg-press`：期望 `0739` 名次 1 但 filter `no_name_evidence` 拒绝、finalIds 空；业务一致性：matcher 深度相等用例 + run.js 有/无 sink 结果一致用例 |
| A3 | fixture vision/e2e 含坏图、模型错误与有效图 | 通过 | 有效图每样本恰一次模型调用；坏图不调模型、记 attachments 阶段错误、批继续；模型错误只记安全码、退出码稳定 0/1；fixture-e2e 双端 5/5 |
| A4 | 同一受控照片分别纯图与带提示跑真实模型 e2e | 通过 | 矩阵 #13/#14；分组独立（photo-only vs hinted），最终 ID 入报告；带提示样本双端命中期望 `0576`（rank 1），纯图样本双端一致但未命中期望——CLI 如实呈现纯图路径弱于带提示 |
| A5 | 三条应用运行路径按同一 traceId 查到提交、模型与最终匹配 | 通过（Web 服务端路径含双进程实跑） | **双进程实跑**：本地 dist API（`AGENT_EXERCISE_SEARCH_DIAGNOSTICS=1`）+ vite dev + 真实浏览器，fixture 配置发起文字检索——浏览器控制台捕获 `req_606783e4-f676-4108-bec2-95bf3d39a9bf` 的完整 web 事件（submit → recall×2 → filter×2 → display → end completed/phase match），API 进程 stdout 同一 traceId 的 api 事件（attachments → model → recognition → end）；前三轮 `req_351180e6/req_91066dfd/req_b3967fed` 亦逐条同 trace 串联。坏图、重试、取消、迟到归属由 D02/D05/D06/D12 自动化用例覆盖。RN 本机（`rn-local`/`rn`）设备端轨迹按待验记录（见下） |
| A6 | 合成敏感文本、自建 ID、图片字段与模拟 provider 异常的隐私断言 | 通过 | D01 用例（假密钥/路径/Data URL 不出现在输出、未知字段与错误消息剥离）；D02 用例（原始响应文本不入日志）；D12 B3（`sk-TESTSECRET123`、自建 ID、Data URL 不出现在报告/stdout/stderr，受控查询仅 `--include-queries` 时出现）；四份真实报告扫描 `privacy-ok` |
| A7 | matcher golden、Web 组件、RN 搜索适配、共享任务测试、RN 静态检查与 API 构建 | 通过 | 矩阵 #5/#6/#7/#8/#9/#10；基线匹配结果与会话行为不变（matcher 22/22 含 16 条既有 golden 全绿；2 条 lint warning 为仓库既有） |

## 待验项

- **A5 RN 设备端轨迹**：真机在线但本记录未做安装与 UI 驱动。Metro 打包（矩阵 #12）已证明跨树诊断模块可进 RN bundle；RN 本机绑定与服务端共用同一 `createExerciseSearchTrace` + run.js 钩子，服务端路径已双进程实跑证明。复核：设 `EXPO_PUBLIC_AGENT_EXERCISE_SEARCH_DIAGNOSTICS=1` 后 `npx expo run:android`，练习模式 fixture 配置发起文字/图片检索，`adb logcat` 按 `traceId` 过滤 `exercise_search` 行，核对 `media`(rn) → `submit`(rn) → `attachments/model/recognition/end`(rn-local) → 匹配后 `end`(rn)。
- **坏图/取消/权限拒绝的设备端复现**（相机权限拒绝、选图取消、EXIF 旋转分支）依赖真机相机与相册，自动化用例已覆盖代码路径，设备端行为随上一条一并复核。

## 实跑观察（非本任务回归）

双进程实跑（Web 路径）时发现：dev 模式下 `frontend/src/main.jsx` 的 `<StrictMode>` 会对 effect 做挂载期双调用，`ExerciseAiSearch` 既有卸载清理（`alive.current = false`，本任务未改动该模式）在双调用后不会复位，导致 **dev 模式**下识别态的异步续体被静默丢弃（检索提交后 UI 停在「正在识别…」并自动取消 run）。该行为在改动前的代码同样存在，生产构建不做 effect 双调用、vitest 不启用 StrictMode，均不受影响；本记录的 Web 端实跑证据通过临时移除 StrictMode（验证后已 `git restore` 还原，未进提交）取得。建议后续单独修复该 dev-only 问题（卸载清理里对 StrictMode 双调用复位 alive，或改用标准 isMounted 模式）。

