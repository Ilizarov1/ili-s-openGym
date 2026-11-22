# AI 动作检索评估 CLI 与诊断日志 runbook

[执行文档](../EVAL_CLI_EXECUTION.md) · [验收记录](ACCEPTANCE.md) · [需求](../REQUIREMENTS.md) · [技术设计](../DESIGN.md)

离线评估三种模式、样本清单格式、诊断日志开关和按 traceId 查询的入口。CLI 位于 `frontend/scripts/ai-search-eval.mjs`，从仓库根目录用 PowerShell 运行；真实模型需要已授权的密钥，fixture 模式全程离线。

## 前置

```powershell
# 仅当 frontend 依赖未安装时
npm.cmd --prefix frontend ci
```

CLI 通过 frontend 自己的 Vite 以 SSR 方式加载真实的 Web 与 RN 匹配器，因此 frontend 依赖必须先装好。不新增任何 npm 依赖。

## 三种模式

| 模式 | 输入 | 调用模型 | 调用匹配器 | 典型用途 |
|---|---|---|---|---|
| `replay` | 清单里 `replay` 指向的历史结构化输出 | 否（不创建 provider） | Web + RN | 离线复现排序、阈值、筛选判定 |
| `vision` | 清单里 `image` 的已归一化照片 | 是（fixture 或真实） | 否 | 单独评估视觉识别链路 |
| `e2e` | 照片（可带 `hintText`） | 是，每样本一次，同一结构化输出 | Web + RN | 整链路对照 |

照片在提交前已被归一化：CLI 输入是**已归一化的附件**（≤1 MiB 的 jpg/jpeg/png/webp）。浏览器 Canvas、Expo 相机与相册的预处理属于客户端边界，分别在 Web 组件与 RN 屏幕内验证；CLI 报告只覆盖模型与匹配阶段，并明确不评估客户端预处理。

## 命令

```powershell
# 离线回放（无网络、无密钥）
npm.cmd --prefix frontend run eval:ai-search -- --mode replay --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/replay.json

# fixture 视觉模式（离线）
$env:OPEN_GYM_EVAL_PROVIDER = 'fixture'
npm.cmd --prefix frontend run eval:ai-search -- --mode vision --group photo-only --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/fixture-vision.json

# fixture 整链路（离线，一次模型 + 两端匹配）
npm.cmd --prefix frontend run eval:ai-search -- --mode e2e --group photo-only --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/fixture-e2e.json
Remove-Item Env:OPEN_GYM_EVAL_PROVIDER
```

真实模型（需已授权配置，默认不提交产物）：

```powershell
$env:OPEN_GYM_EVAL_PROVIDER = 'opencode'   # openai | compatible | opencode
$env:OPEN_GYM_EVAL_MODEL = 'deepseek-v4.1-flash'
$env:OPEN_GYM_EVAL_API_KEY = '<受控密钥>'    # opencode 可回退 OPENCODE_API_KEY
npm.cmd --prefix frontend run eval:ai-search -- --mode vision --sample photo-chest-press --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/real-vision.json
npm.cmd --prefix frontend run eval:ai-search -- --mode e2e --sample photo-chest-press --sample hinted-chest-press --manifest docs/ai-exercise-search/eval/manifest.json --out .codex/ai-search-eval/real-e2e.json
Remove-Item Env:OPEN_GYM_EVAL_PROVIDER; Remove-Item Env:OPEN_GYM_EVAL_MODEL; Remove-Item Env:OPEN_GYM_EVAL_API_KEY
```

`compatible` 必须提供 `OPEN_GYM_EVAL_BASE_URL`；`opencode` 端点固定为共享 provider 的 Go 端点；`openai` 缺省官方端点。临时 profile 只存在于本次进程内存，不写入任何账号配置。缺配置时 CLI 在发出任何样本请求前以退出码 2 结束。

### 参数

| 参数 | 说明 |
|---|---|
| `--mode replay\|vision\|e2e` | 必填 |
| `--manifest <路径>` | 必填；相对路径按调用目录（npm 下为 INIT_CWD，即仓库根）解析 |
| `--out <路径>` | 必填；先写同目录临时文件再 rename；不得与任何输入重合 |
| `--sample <id>` / `--group <名称>` | 可重复；同类取并集、两类取交集；未知值、空交集、选定样本不适用当前模式均为使用错误 |
| `--web-locale en\|zh` | 匹配器语言，默认 `zh` |
| `--include-queries` | 默认 false；仅显式开启时报告才携带受控查询文本 |
| `--save-replay <路径>` | 仅 vision/e2e；写 `{ results: [{ id, structured }] }`，供下次回放 |
| `--help` | 用法说明 |

未显式选择样本时，按模式跳过不适用项并写入报告的 `skippedIds`。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 运行成功（允许命中率低） |
| 1 | 报告已写出，但存在样本级错误 |
| 2 | 参数、清单、配置或整体执行/写入失败 |

stdout 只输出报告路径与计数；错误只输出固定说明和安全错误码，不打印异常对象、JSON 原文、密钥或图片路径。

## 样本清单

[manifest.json](manifest.json) 顶层只有 `schemaVersion: 1` 与 `samples`。每个样本：`id`（唯一）、`group`、`expectation`（`match`/`empty`）、`expectedIds`（保留前导零的字符串数组）、`expectedEquipment`（slug 数组）、`family`，以及按模式的 `image`、`hintText`、`replay: { path, index }`（path 相对清单文件，index 从 0 开始）。`match` 样本必须有公开 ID 和至少一个器械；`empty` 样本两组数组均为空。

初始集合：

| 分组 | 样本 | 说明 |
|---|---|---|
| `hinted` | `hinted-chest-press` 等 5 个 | [smoke 证据](../evidence/smoke-go-2026-11-21.json) 的 5 行：图 + hint + replay |
| `photo-only` | `photo-chest-press` 等 5 个 | 同一批照片，纯图无提示 |
| `edge` | `edge-french-chest-press`、`edge-cjk-leg-press`、`edge-exact-chest-press`、`edge-unrelated`、`edge-out-of-catalogue` | [edge-responses.json](edge-responses.json) 的固定回放：法语名、无 nameEn 的中文名、精确同名、无关节描述、不存在的器械 |

首名错误而正确 ID 排在后面的可重复断言由匹配器测试的注入列表覆盖（`frontend/src/lib/exercise-ai-search.test.js`），不依赖对真实目录固定排名的猜测。

## 报告

顶层 `schemaVersion`、`mode`、`gitCommit`、`catalogueSha256`（对 `frontend/src/lib/exercises-data.js` 计算）、`webLocale`、`skippedIds`、`samples`、`summary`。

每条样本：`id/group/family/expectation`、`recognition`（阶段计数、白名单器械/部位、耗时；`familyAssessment` 固定 `unreviewed`，不计算虚假识别正确率）、`platforms.web/rn`（`recall`、`filter`、`display`、`finalIds`、`fallbackOnly`、`elapsedMs`、`firstExpectedRank`、`wrongEquipment`）与可选 `error: { phase, code }`。

`summary.byPlatform` / `summary.byGroup`（分组内再按平台）的每项指标都是 `{ numerator, denominator }`，无分母时为 `null`：

| 指标 | 分子 / 分母 |
|---|---|
| `top1`、`top5`、`recallAt5` | 命中数 / 成功匹配的 `match` 正例 |
| `wrongEquipment` | 首名器械不在期望内 / 上述正例中有最终首名的 |
| `falsePositive` | 出现最终结果的数 / 成功匹配的 `empty` 样本 |
| `fallbackOnly` | 兜底数 / 全部成功匹配 |
| `failed` | 执行失败数（单列） |
| `latencyP50Ms` / `latencyP95Ms` | nearest-rank；`visionLatency`（模型阶段）与平台匹配延迟分开聚合 |

## 诊断日志与 traceId

所有阶段事件是单行 JSON：`event: "exercise_search"`、`schemaVersion: 1`、`traceId`、`source`、`stage`。合法 traceId 即请求 ID：`req_<8-4-4-4-12 十六进制 UUID>` 或 Web 旧格式 `req_<13 位时间戳>_<1–8 位小写 base36>`；不合法时该事件被忽略，不影响请求本身。媒体选图事件用独立的 UUID 与 `mediaAttemptId`，提交事件携带最近一次成功选图的尝试 ID 供本地串联。

| 端 | 开关 | source | 查询位置 |
|---|---|---|---|
| 服务端（Web 与 RN 配对） | 启动 API 进程前设 `AGENT_EXERCISE_SEARCH_DIAGNOSTICS=1` | `api` | API 进程 stdout |
| Web 客户端 | 浏览器控制台执行 `localStorage.setItem('opengym:ai-search-diagnostics', '1')` | `web` | 浏览器控制台 |
| RN 客户端 | 启动 Metro 或构建包前设 `EXPO_PUBLIC_AGENT_EXERCISE_SEARCH_DIAGNOSTICS=1` | `rn` | RN 日志（`adb logcat` 或 Metro 终端） |
| RN 本机执行 | 同上（`EXPO_PUBLIC_AGENT_EXERCISE_SEARCH_DIAGNOSTICS=1`） | `rn-local` | 同上 |

阶段顺序：`media` → `submit` → `attachments` → `model` → `recognition` → `recall`/`filter`（多条）→ `display` → `end`。客户端与运行时可各有一条 `end`，按 `source` 分开解读；同一 `source` 下同一 trace 最多一条 `end`。检索排序、阈值与输出不受开关影响——开关前后业务输出必须一致。

关闭方式：Web 执行 `localStorage.removeItem('opengym:ai-search-diagnostics')`；服务端与 RN 去掉环境变量后重启/重建。关闭时零日志输出。

## 日志内容边界

事件字段逐字段投影，未声明字段一律丢弃；错误只透传共享错误表中的码（外加 `permission_denied`、`asset_missing`，其余记 `unknown`），从不携带原始错误消息、用户文本、Data URL、图片路径、密钥或自建动作 ID。公开 ID 只有上游用可信目录（Web `CATALOGUE` / RN `custom === false`）判定后才可出现。数组上限：图片 2、候选 5、检索 Top 5（真实前 5 的排序切片，不回填）。查询文本仅评估 CLI 在 `--include-queries` 下才进入报告。

## 自动化验证

```powershell
npm.cmd --prefix frontend run test:ai-search-eval   # node --test scripts/ai-search-eval.test.mjs
```

覆盖：子进程回放两端报告与重复回放一致性、非法参数退出 2、npm prefix 路径解析、fixture vision/e2e（有效图/坏图/失败后继续/每样本一次模型调用/回放可保存）、以及合成敏感词、自建 ID 与 Data URL 不出现在报告、stdout/stderr 与日志的隐私断言。`scripts/ai-search-eval.test.mjs` 使用 node:test，已被 vitest 精确排除，不会混入 `npm test`。

产物报告（`.codex/ai-search-eval/*.json`）与 `--save-replay` 的输出仅限本地受控输入，不提交进仓库。
