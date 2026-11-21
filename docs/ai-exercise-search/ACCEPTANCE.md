# AI 动作检索验收记录

[需求](REQUIREMENTS.md) · [技术设计](DESIGN.md) · [执行计划](EXECUTION.md)

状态：fixture 离线项与 RN 设备项已完成；真实视觉模型 smoke 因 OpenCode 账户余额/免费额度阻塞，待账户恢复后补跑。所有命令在 `D:\dev\open-gym-agent-runtime`（分支 `feat/agent-runtime`）执行，Windows PowerShell。

## 环境

| 项 | 实际值 | 记录时间 |
|---|---|---|
| 工作树 | `D:\dev\open-gym-agent-runtime` | 2026-11-21 |
| 分支 | `feat/agent-runtime` | 2026-11-21 |
| 实施基线 commit | `871d3d74b` | 2026-11-21 |
| Node | `v24.18.0` | 2026-11-21 |
| npm | `11.16.0` | 2026-11-21 |
| Java | `%LOCALAPPDATA%\RnToolchain\jdk-17.0.21+9`（Temurin 17.0.21） | 2026-11-21 |
| adb / SDK | `%LOCALAPPDATA%\RnToolchain\android-sdk`，Android 36 | 2026-11-21 |
| Gradle | 9.0.0（`GRADLE_USER_HOME=%LOCALAPPDATA%\RnToolchain\gradle`） | 2026-11-21 |
| Expo CLI | `58.1.21`（项目锁定 Expo 55） | 2026-11-21 |
| 设备 | `emulator-5556`（`openGymRnQa`，Android 16，x86_64），本任务冷启动并声明 | 2026-11-21 |

## 基线检查

基线 commit `871d3d74b` 的前端与 RN 结果沿用 [agent-runtime ACCEPTANCE](../agent-runtime/ACCEPTANCE.md) 2026-11-21 第二轮记录（同一 worktree，功能开工前）；API 构建在本需求改动后复跑。

| 工作目录 | 命令 | 预期 | 实际 | 证据 |
|---|---|---|---|---|
| `api` | `npm.cmd run build` | 构建成功 | `build: dist ready`，含 `dist/agent-runtime/tasks/` | 终端输出；2026-11-21 |
| `frontend` | `npm.cmd run build` | 构建成功 | 基线 Vite 构建成功（agent-runtime ACCEPTANCE 第二轮） | agent-runtime ACCEPTANCE |
| `mobile-rn` | `npm.cmd run check` | 通过或既有失败已记录 | 基线 lint/typecheck/design:check 通过，2 条既有 lint warning | agent-runtime ACCEPTANCE |

## 实施记录

| 阶段 | 命令或证据 | 结果 | 日期 |
|---|---|---|---|
| 1 共享核心 | `node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js test/agent-exercise-search.test.js` | 51 pass / 0 fail | 2026-11-21 |
| 2 共享任务 | `node --test test/agent-exercise-search.test.js` | 11 pass / 0 fail；词表与 Web/RN 目录一致 | 2026-11-21 |
| 3 匹配与 golden | `npm.cmd test -- src/lib/exercise-ai-search.test.js` | 14 pass；88 例 golden 全达标，常量 60/25/15/0.60/3/0.12 | 2026-11-21 |
| 4 服务端 | `npm.cmd run test:nest -- test/nest/agent.test.js test/nest/agent-exercise-search.test.js` | 13 pass / 0 fail | 2026-11-21 |
| 4 OpenAPI | `node --test test/openapi-routes.test.js test/nest/routes.test.js`；`node scripts/build-api-docs.mjs` | 5 pass / 0 fail；108 endpoints / 44 schemas | 2026-11-21 |
| 5 Web | `npm.cmd test -- src/components/ExerciseAiSearch.test.jsx src/views/Library.test.jsx src/views/AgentSetup.test.jsx` | 62 pass / 0 fail | 2026-11-21 |
| 5 Web 构建 | `npm.cmd run build` | 478 modules，Library/AgentSetup 独立 chunk | 2026-11-21 |
| 6 RN 静态 | `npm.cmd run check` | lint 仅 2 条既有 warning；typecheck/design:check 通过 | 2026-11-21 |
| 6 Metro | `npx.cmd expo export --platform android --output-dir .expo-ai-search-export` | `index-5bc2874abf9dbaf39806878a5a2bb08e.hbc`，SHA-256 `AE63FCF932EA031616788F9B915D65DFC77056C9D10E65E4525CCC726656D6DD` | 2026-11-21 |
| 6 RN 设备 | `emulator-5556`（openGymRnQa，Android 16） | A1 本机/服务端、A2、A3、A6、A8、A15 通过；截图见下 | 2026-11-21 |
| 6 APK | `app-release.apk`；`apksigner verify`；`Get-FileHash` | v2 签名通过；SHA-256 `D112588C4449A8B78CE7F716B18A23D416C6A220F445FAF678F0970562586BC3` | 2026-11-21 |
| 7 真实视觉 smoke | `test_pic/` 5 张 | **阻塞**：OpenCode 402 `Insufficient balance` / 免费模型 429 `FreeUsageLimitError` | 2026-11-21 |

## 验收对照

fixture 离线项与设备项分开标注。

| 编号 | 需求 | 场景 | 类型 | 结果 | 证据 |
|---|---|---|---|---|---|
| A1 | R1 | 动作库/选择器点 ✨；三种输入；第二张替换第一张 | 离线 + 设备 | 通过：本机文字、纯图（相册）和服务端文字均 `completed`；照片缩略图方向正确；Web 组件覆盖三输入与替换 | `ExerciseAiSearch.test.jsx`；`device-ai-run3.png`、`device-ai-image-result.png`、`device-ai-server.png` |
| A2 | R2 | 发起后独占识别态；文字清空、chips 隐藏、旧筛选不作用 | 离线 + 设备 | 通过：识别态摘要卡置顶，搜索框文字禁用，关键词/筛选被忽略 | `Library.test.jsx`；`device-ai-run3.png` |
| A3 | R3 | 候选 ≤5，含缩略图/名称/依据/等级；详情往返保持 | 离线 + 设备 | 通过：2 个候选、中 Badge、依据；详情返回后结果保持 | `agent-exercise-search.test.js`；`device-ai-detail.png`、`device-ai-back.png` |
| A4 | R3 | 零候选兜底；建议 chip 清空并退出，不恢复快照 | 离线 | 通过：Web 单测覆盖零候选、chip 清空其他筛选并退出且不恢复快照 | `Library.test.jsx` |
| A5 | R3 | 有候选“都不对”展开兜底；x 恢复快照 | 离线 + 设备 | 通过：Web 单测覆盖；RN x 退出恢复空查询与筛选 | `Library.test.jsx`；`device-ai-exit.png` |
| A6 | R4 | 追问替换式；带图追问；运行中旧候选可点；取消保留输入 | 离线 + 设备 | 通过：追问后摘要与候选替换，轮次 5→4；同一本机会话；Web 覆盖取消/保留 | `ExerciseAiSearch.test.jsx`；`device-ai-followup.png` |
| A7 | R4 | 第 5 轮追问后禁用；直接调 API 返回 `turn_limit` | 离线 | 通过：API 第 7 个 run 返回 429 `turn_limit`；Web/RN 客户端限制 6 run | `test/nest/agent-exercise-search.test.js`；`ExerciseAiSearch.test.jsx` |
| A8 | R4 | x 退出删除会话与图片；晚到结果不写回；快照恢复 | 离线 + 设备 | 通过：x 退出恢复快照；API 删除无消息残留；晚到写入受会话删除/版本守卫 | `agent-exercise-search.test.js`；`device-ai-exit.png` |
| A9 | R5 | 无可用配置点 ✨ 不弹 Sheet；EmptyState + 去配置 | 离线 | 通过：Web 单测；RN EmptyState 接 `onOpenAgentProfiles` 并已接入 App.tsx | `ExerciseAiSearch.test.jsx`；`Library.test.jsx`；RN 代码检查 |
| A10 | R5 | 缺图像能力时带图被拒；纯文字不受影响；不换端 | 离线 | 通过：API `image:false` 配置文本 `completed`、图片 `profile_capability_missing`；Web/RN 错误映射 | `test/nest/agent-exercise-search.test.js`；`ExerciseAiSearch.test.jsx` |
| A11 | R5 | `AGENT_RUNTIME_DISABLED` 只关服务端；练习模式本机可用 | 离线 | 部分：API 503/`/api/config` 与 Web 隐藏通过；RN 本机路径在设备上可用；RN 配对服务端隐藏未做设备复验 | `test/nest/agent.test.js`；`ExerciseAiSearch.test.jsx`；设备本机记录 |
| A12 | R6 | 失败文案/重试/修改；离开取消；中断提示 | 离线 | 通过（离线）：Web 单测覆盖失败/重试/中断提示；RN `recovery.ts` 与动作库提示代码 | `ExerciseAiSearch.test.jsx`；`Library.test.jsx` |
| A13 | R1、R5 | Web 与 RN 流程一致；Web 仅服务端；RN 练习模式本机 | 汇总 | 通过：双端同匹配管道；Web 只调 `/api/agent`；RN 本机 fixture 与服务端 fixture 两条路径均跑通 | 本文件实施记录；设备截图 |
| A14 | R2 | 识别态重开 ✨ 取消旧运行并重发；文字禁用、sparkle 可用 | 离线 | 通过（离线）：Web 单测覆盖；RN 代码在识别态保留 sparkle、重开取消旧 run | `ExerciseAiSearch.test.jsx`；`Library.test.jsx` |
| A15 | R1、R2 | 训练替换/添加选择器选中候选后写入，无额外确认 | 离线 + 设备 | 通过：替换选择器选中候选后第一槽位由“杠铃卧推”变为“哑铃坐姿肩部推举”，4 组保留，无额外确认；Web quick 语义单测 | `device-replace-result.png`、`device-replaced.png`；`ExerciseAiSearch.test.jsx` |
| A16 | R4 | 纯文本本机配置追问补图报能力错误；历史不丢、服务端不建空会话 | 离线 | 通过（离线）：API `continue` 缺会话 409 且不建空会话；RN `resolveLaunch` 同位置能力不足报 `profile_capability_missing` 并可显式服务端重发 | `test/nest/agent-exercise-search.test.js`；RN 代码检查 |

## 真实模型 smoke

| 项 | 结果 |
|---|---|
| 日期 | 2026-11-21 |
| 提供商 / 模型 | `opencode` / `deepseek-v4.1-flash`（列表名称 DeepSeek V4.1 Flash 1017，canonical id `deepseek/deepseek-v4.1-flash-1017`） |
| 能力 | 模型元数据声明输入 `text,image/jpeg,image/png,image/gif,image/webp`，`structured_output: true` |
| 服务端配置 | 通过 `OPENCODE_API_KEY` 环境变量解析为服务端默认配置；密钥未写入 `agent-<uid>.json`，日志未包含密钥 |
| 结果 | **阻塞**：付费模型 HTTP 402 `Insufficient balance`；免费模型 HTTP 429 `FreeUsageLimitError`；文字/图片请求均未获得模型回答 |
| 证据 | [evidence/smoke-opencode-2026-11-21.json](evidence/smoke-opencode-2026-11-21.json) |
| 后续 | 账户充值或恢复额度后，按 EXECUTION 7.2 的 5 张照片与期望表逐张执行并补截图。照片内容与期望候选已预填；5 张均为竖拍，无 EXIF Orientation 标签，像素本身正向。 |

## 设备记录

- 设备：`emulator-5556` / `openGymRnQa`（Android 16，x86_64），`agent-device` 冷启动并声明。
- APK：`mobile-rn/android/app/build/outputs/apk/release/app-release.apk`，SHA-256 `D112588C4449A8B78CE7F716B18A23D416C6A220F445FAF678F0970562586BC3`；`apksigner verify` v2 通过；`dev.opengym.rn`，versionCode 7 / versionName 0.1.6，`arm64-v8a`/`x86_64`。
- 本机 workspace：fixture 配置，A1 文字/纯图、A2、A3、A6、A8、A15 通过；证据 `evidence/device-ai-run3.png`、`device-ai-followup.png`、`device-ai-exit.png`、`device-ai-image-result.png`、`device-replace-result.png`、`device-replaced.png`。
- 服务端 workspace：临时 fixture API（`http://10.0.2.2:3000`）配对后 A1 文字 `completed`，摘要卡显示“经 Fixture (instance) 检索”，证明首轮固定服务端；证据 `device-pair-filled3.png`、`device-paired.png`、`device-ai-server.png`。
- 设备验收后已 `agent-device close` 释放声明；模拟器保留。

## 待验项

- 真实视觉模型 smoke：账户余额/额度阻塞，见上节。
- A11 RN 配对服务端入口在 `AGENT_RUNTIME_DISABLED=1` 下的隐藏未做设备复验（API 503、Web 隐藏和 RN 本机可用已验）。
- A14 识别态重开 ✨ 与 A12 进程重启提示未做设备复验（Web 单测和 RN 代码已覆盖）。
