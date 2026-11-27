# 子系统路由：`mobile-rn`（RN Android 客户端与设计系统）

> 返回总路由：[AGENTS.md](../../../AGENTS.md) · [docs/README.md](../../README.md) · 工程规范：[code-standards.md](../../code-standards.md)

## 1. 职责与边界

负责 Expo SDK 55 / React Native 0.83 新架构下的 Android 原生客户端：五 Tab 主界面、训练会话执行、计划与历史编辑、进度趋势与肌群图、身体指标与进度照片、训练提醒、配对扫码、第三方导入导出，以及 `mobile-rn/src/design/` 设计系统与模拟器自动化验收脚本。

- **不直接持有**：服务端 HTTP 实现（归属 [`api-sync`](../api-sync/README.md)）、上游 Web 视图层（归属 [`web-client`](../web-client/README.md)）、动作词库原始 JSON（归属 [`catalogue`](../catalogue/README.md)）。
- **跨子系统共享**：直接复用 `frontend/src/lib/` 中的纯领域函数（如 `muscles.js`、`body-paths.js`、检索评分逻辑）以及 `api/agent-runtime/` 契约（Metro 已配置跨目录解析，参见 [`ai-agent`](../ai-agent/README.md)）。

## 2. 代码入口与目录映射

| 路径 | 职责说明 |
|---|---|
| `mobile-rn/App.tsx`、`mobile-rn/app.json` | 应用根组件、深链路由（`opengym://`）与 Expo 原生配置 |
| `mobile-rn/src/` | 首页、训练、计划、历史、动作库、设置、SQLite 本地持久化、备份与服务端同步 |
| `mobile-rn/src/design/` | RN 设计系统：`tokens.ts`、`themes.ts`、`icons/`、基础原语 `components/`、业务模式 `patterns/` 与开发画廊 `gallery/` |
| `mobile-rn/src/progress/` | PR 个人纪录、估算 1RM、训练趋势与肌群负荷投影 |
| `mobile-rn/src/body/` | 体重记录、围度追踪与私有进度照片归档/同步 |
| `mobile-rn/src/sharing/` | FitNotes / Strong / Hevy 历史导入、计划 JSON 分享与上游兼容层 |
| `mobile-rn/src/pairing/` | 设备配对二维码解析与确认兑换 |
| `mobile-rn/src/reminders/` | Android 60 天本地训练提醒排程、通知频道与点击深链跳转 |
| `mobile-rn/src/agent/` | 本机 Agent 执行器、SQLite 会话/记忆、SecureStore 密钥与 AI 动作匹配桥（跨入 [`ai-agent`](../ai-agent/README.md)） |
| `mobile-rn/eslint.config.js` | ESLint 规则与跨模块导入边界约束 |
| `mobile-rn/scripts/` | 模拟器 fixture 注入、深链拼图截图、五 Tab 冒烟、自定义设计检查与真机保数据安装脚本 |

## 3. 核心契约与不变式

1. **设计系统强约束**：仅 `tokens.ts`、`themes.ts`、`color.ts` 允许定义原始色值/字号/间距/圆角；业务屏严禁手写十六进制色值或裸像素，禁止恢复旧 `ui.tsx`。
2. **SQLite 双路径注意**：Expo SDK 55 实际读取 `files/SQLite/opengym-rn.db`，注入测试 fixture 时须按脚本规范同步写入并先停止进程。
3. **Windows 短路径原生编译**：涉及 Gradle / CMake 构建时必须在短路径 worktree（如 `D:\wt\<slug>`）内执行，规避 Windows 250 字符对象路径上限。
4. **GUI 变更硬验收**：任何用户可见界面或交互改动，除通过 `npm.cmd run check` 外，必须在模拟器/真机录制真实操作 GIF 并归入对应需求文档的 `evidence/` 目录。

## 4. 常用验证命令（PowerShell）

```powershell
# 静态门禁（ESLint + 边界规则测试 + TypeScript + 设计系统检查）
cd mobile-rn; npm.cmd run check

# 视觉快速截图与拼图（需 Debug APK + Metro + 已申领模拟器）
.\mobile-rn\scripts\ui-capture.ps1 -Serial emulator-5556 -Fixture

# 真机保数据覆盖安装（已构建并验签的 Release APK）
.\mobile-rn\scripts\install-device.ps1 -Launch
```

## 5. 文档与历史需求路由

### 架构与规范文档
- [RN 设计系统架构与 Token 规范](../../RN_UI_DESIGN_SYSTEM.md)
- [RN 页面五 Tab 重构设计](../../RN_UI_SCREEN_MIGRATION.md)
- [RN 视觉测试流程、深链与 Fixture 指南](../../RN_UI_VISUAL_TESTING.md)
- [RN 自动化与真机脚本索引](../../../mobile-rn/scripts/README.md)

### 进行中 / 待归档提案（`.agent/notes/proposed/`）
- [RN 客户端接入 AI Coach GenUI（设计）](../../../.agent/notes/proposed/rn-coach-genui/DESIGN.md) · [执行计划](../../../.agent/notes/proposed/rn-coach-genui/EXECUTION.md) · [验收报告与实操演示](../../../.agent/notes/proposed/rn-coach-genui/ACCEPTANCE.md)

### 已实施需求笔记（`.agent/notes/implemented/`）
- [RN 与 Web 交互对齐](../../../.agent/notes/implemented/rn-web-interaction-parity/README.md)
- [RN 常规动作检索与组合筛选](../../../.agent/notes/implemented/rn-exercise-search/DESIGN.md)（含 [基线](../../../.agent/notes/implemented/rn-exercise-search/BASELINE.md) · [验收记录](../../../.agent/notes/implemented/rn-exercise-search/ACCEPTANCE.md)）
- [RN P2 功能集（进度/身体/导入分享/配对/提醒）](../../../.agent/notes/implemented/rn-p2/README.md)

### 历史归档（`.agent/notes/archived/`）
- [RN 迁移状态与待验清单](../../../.agent/notes/archived/RN_MIGRATION_STATUS.md)
- [RN Android 0.1.x 实施与验收](../../../.agent/notes/archived/RN_ANDROID_EXECUTION.md)
- [RN 设计系统首轮实施记录](../../../.agent/notes/archived/RN_UI_EXECUTION.md)
- [训练组行与递减组 UI](../../../.agent/notes/archived/rn-workout-set-ui/DESIGN.md) · [替换动作选择器](../../../.agent/notes/archived/rn-replacement-picker/DESIGN.md) · [P2 高级训练与动作库早期归档](../../../.agent/notes/archived/rn-p2-training-library/README.md)
