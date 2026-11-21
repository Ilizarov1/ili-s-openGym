# openGym Agent 运行环境验收记录

[需求](REQUIREMENTS.md) · [技术设计](DESIGN.md) · [执行计划](EXECUTION.md)

状态：首期已实现，自动化测试和 RN 模拟器验收通过；真实供应商兼容性另行记录。所有命令在 `feat/agent-runtime` 工作树中执行，Windows PowerShell。

## 环境

| 项 | 实际值 | 记录时间 |
|---|---|---|
| 工作树 | `D:\dev\open-gym-agent-runtime` | 2026-11-20 |
| 分支 | `feat/agent-runtime` | 2026-11-20 |
| 基线 commit | `413e9d3b8` | 2026-11-20 |
| Node | `v24.18.0` | 2026-11-20 |
| npm | `11.16.0` | 2026-11-20 |
| Java | `%LOCALAPPDATA%\RnToolchain\jdk-17.0.21+9`（Temurin 17.0.21） | 2026-11-20 |
| adb / SDK | `%LOCALAPPDATA%\RnToolchain\android-sdk`，Android 36；设备 `emulator-5560`（Android 16） | 2026-11-20 |
| Gradle | 9.0.0（`GRADLE_USER_HOME=%LOCALAPPDATA%\RnToolchain\gradle`） | 2026-11-20 |
| Expo CLI | `58.1.21`（`npx expo --version`；项目锁定 Expo 55） | 2026-11-20 |

## 基线检查

| 工作目录 | 命令 | 预期 | 实际 | 证据 |
|---|---|---|---|---|
| `api` | `npm.cmd ci` | 安装成功 | 183 packages，成功 | 终端输出 |
| `api` | `npm.cmd run build` | 构建成功 | `build: dist ready` | `api/dist` |
| `frontend` | `npm.cmd ci` | 安装成功 | 211 packages，成功 | 终端输出 |
| `frontend` | `npm.cmd run build` | 构建成功 | Vite 构建成功，Agent 页面独立 chunk | `frontend/dist` |
| `mobile-rn` | `npm.cmd ci` | 安装成功 | 850 packages，成功 | 终端输出 |
| `mobile-rn` | `npm.cmd run check` | 通过或已有失败已记录 | typecheck/lint/design:check 通过；lint 仅 2 条既有 key 警告 | 终端输出 |

`api` 全量 `npm.cmd test` 在 Windows 检出上仍有 12 条与权限、CRLF 生成文件或 admin socket 有关的基线失败（`prompts`、`wrapped-copy`、`nudge-copy`、unwritable-data、recover 等）。`frontend` 全量 `npm.cmd test` 为 7830 pass / 26 fail，失败项为 Windows 路径分隔符、CRLF、app icon 和 audit 源文件读取等既有检查。这些与本需求无关，Agent 相关测试全部通过。

## 实施记录

| 阶段 | 命令或证据 | 结果 | 日期 |
|---|---|---|---|
| 0.4 桩数据 | `node -e "import('./api/test/agent-fixtures.mjs').then(m => console.log(Object.keys(m)))"` | 导出 ACCOUNTS、WORKSPACES、TARGETS、UNSYNCED_RECORD、PNG_1X1、fixtureModel | 2026-11-20 |
| 1 共享核心 | `node --test api/test/agent-runtime.test.js api/test/agent-providers.test.js api/test/agent-portability.test.js` | 27 pass / 0 fail | 2026-11-20 |
| 1.15 API 构建 | `npm.cmd run build`；`node -e "import('./api/dist/agent-runtime/index.js')"` | dist 构建成功，60 个导出 | 2026-11-20 |
| 2 API 集成 | `npm.cmd run test:nest -- test/nest/agent.test.js` | 4 pass：配置/幂等/提案/记忆/取消、回退开关、回退后数据可读、重启中断 | 2026-11-20 |
| 3 Web | `npx vitest run src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx` | 12 pass | 2026-11-20 |
| 3 Web 设置 | `npx vitest run src/views/settings-pages.test.jsx` | 36 pass（修正测试对 CRLF 的读取） | 2026-11-20 |
| 4 RN 静态 | `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run design:check` | 通过；lint 仅有 2 条既有 warning | 2026-11-20 |
| 4 RN 打包 | `npx.cmd expo export --platform android --output-dir .expo-agent-export` | Android bundle `index-c61275d6da07dcbbe6fb9224c80e6d88.hbc`，SHA-256 `E1847205F298966F7BAC21DF440381A27B8A6CC7EF09B3CD392F042204824566` | 2026-11-20 |
| 4 RN 设备 | `emulator-5560` / `openGymRnQaWorker`，Android 16 | A1 本机文本运行 completed；A4 提案确认 version 2；A5 记忆保存/删除；会话写入 2 条消息；A7 取消后晚到结果未覆盖 cancelled | `docs/agent-runtime/evidence/local-text.png`、`proposal.png`、`cancelled.png`、`session.png` |
| 4 RN APK | `app-release.apk`；`apksigner verify`；SHA-256 | APK 构建成功，Debug 证书签名，包名 `dev.opengym.rn`，versionCode 7，arm64-v8a/x86_64 | 见下方产物 |
| 5 最终检查 | 命令矩阵 | 除上述 Windows 基线失败外通过 | 2026-11-20 |

## 验收对照

| 编号 | 需求 | 场景 | 结果 | 证据 |
|---|---|---|---|---|
| A1 | R1 | 服务端默认配置、服务端用户配置、本机配置 | 服务端两条路径和 RN 本机 fixture 均通过；RN 设备实测 `completed` | `api/test/nest/agent.test.js`；`evidence/local-text.png` |
| A2 | R2 | 越权引用、预算裁剪、未同步数据 | 共享用例和 API 越权引用通过；RN 本机任务读取当前 `LocalState`（含 queue） | `api/test/agent-runtime.test.js`；`mobile-rn/src/agent/tasks.ts` |
| A3 | R3、R4 | 未知工具、参数错误、越界目标、当前步骤禁用 | 四类拒绝均未执行底层工具 | `api/test/agent-runtime.test.js` |
| A4 | R4 | 未确认、并发确认、目标变化 | 写入 0/1/0；重复确认返回原结果；RN 设备确认后 version 2 | 共享/API 测试；`evidence/proposal.png` |
| A5 | R5 | 跨 scope、删除记忆、运行中删除会话 | 服务端与共享测试通过；RN 设备保存/删除记忆通过 | 共享/API/Web 测试；RN 设备记录 |
| A6 | R6 | 响应丢失重试、requestId 冲突 | 同一请求返回原作业；不同输入 409 | `api/test/nest/agent.test.js` |
| A7 | R6 | 取消后晚到结果、重启中断 | 晚到结果不写提案；重启后 open run 为 interrupted；RN 设备取消后保持 cancelled | `api/test/agent-runtime.test.js`；`api/test/nest/agent.test.js`；`evidence/cancelled.png` |

## 构建产物

| 项 | 值 |
|---|---|
| APK | `mobile-rn/android/app/build/outputs/apk/release/app-release.apk`（工作树内，`android/` 被忽略） |
| SHA-256 | `E2B0CD6368F233D93C09189A0C626D5E43E07056CFFBA988959C0D37370B2FEC` |
| 签名 | `CN=Android Debug`，证书 SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c` |
| 包名 / 版本 | `dev.opengym.rn` / versionCode 7 / versionName 0.1.6 |
| 架构 | `arm64-v8a`、`x86_64` |
| 设备 | `emulator-5560`（`openGymRnQaWorker`，Android 16），验收后已 `agent-device close` |

## 待验项

- 真实供应商兼容性：首期只用 fixture 和可控 HTTP 替身验证，真实 OpenAI 兼容端点单独记录。
- Docker 镜像：本机没有 `docker` 命令，`docker build` 未执行；`api/dist/agent-runtime/index.js` 已由构建脚本验证。
- Windows 检出上的 12 条 API 和 26 条 Web 基线失败：与 CRLF 生成文件、路径分隔符、app icon 和文件权限断言有关，未在本需求范围内修改。
- 评审整改（见 [REVIEW.md](REVIEW.md)）后的 RN 设备复验：模块级运行注册表、requestId 重试语义和 kv 版本联动已由静态检查与 Metro 打包覆盖，模拟器上的取消/提案复跑待下一轮设备验收一并执行。

## 评审整改

2026-11-21，按 [REVIEW.md](REVIEW.md) 的 A–F 清单完成对提交 `3024072ff` 的整改。

| 工作目录 | 命令 | 结果 |
|---|---|---|
| `api` | `npm.cmd run build` | `build: dist ready` |
| `api` | `node --test test/agent-runtime.test.js test/agent-providers.test.js test/agent-portability.test.js` | 28 pass / 0 fail（含新增 shared.d.ts 守卫） |
| `api` | `node --test test/agent-crypto.test.js`（dist） | 4 pass / 0 fail（EXECUTION 2.4 判据） |
| `api` | `npm.cmd run test:nest -- test/nest/agent.test.js` | 4 pass / 0 fail（新增并发重试、附件越权、fixture:image、profile 删除后重试用例） |
| `api` | `node --test test/openapi-routes.test.js test/nest/routes.test.js` | 5 pass / 0 fail |
| 仓库根 | `node scripts/build-api-docs.mjs` | `website/api.html` 重生成（108 endpoints） |
| `frontend` | `npx vitest run src/agent/api.test.js src/views/Agent.test.jsx src/views/AgentSetup.test.jsx` | 16 pass / 0 fail |
| `frontend` | `npm.cmd run build` | Vite 构建成功，Agent 页面独立 chunk |
| `mobile-rn` | `npm.cmd run check` | lint（仅 2 条既有警告）、lint:rules、typecheck、design:check 全过 |
| `mobile-rn` | `npx.cmd expo export --platform android --output-dir .expo-agent-export` | `index-a2b568ac57c95eb848b11ac59a9f125f.hbc`，共享核心（含本轮修改）随包解析 |

Windows 基线失败项与上一节记录一致，Agent 相关测试全部通过。
