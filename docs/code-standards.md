# openGym 编码与工程标准（`code-standards.md`）

本文件汇集全仓库强制执行的精炼工程准则。所有条目均采用 **1~2 句祈使句**表述；由 [`.agent/lessons.md`](../.agent/lessons.md) 累计命中满 **3 次**后脱水升格的条目带有 `[L-XXX]` 溯源标记。

## 1. 全局与工作流标准

- 修改任何代码前，先按受影响子系统提交包含触发条件、改前/改后行为、契约兼容、失败模式与基线证据的语义级变更声明。
- 修改代码后，依次定位真实运行路径、顺调用链排查行外副作用、同步契约文档与源码链接，并核验测试真实断言了目标行为。
- 在 Windows 环境一律使用 PowerShell 执行命令，并主动截断长日志输出以保护上下文缓存。
- 移动或重命名文档、评估清单或静态资源前，先全局检索源码与测试脚本中的相对路径引用并同步更新。

## 2. `mobile-rn`（RN Android 与设计系统）

- `[L-001]` 涉及 RN Android 原生构建时，一律在短路径目录（如 `D:\wt\<slug>`）创建 Git Worktree，严禁在深层路径或 `subst` 虚拟盘下运行 Gradle。
- `[L-002]` 编写或修改 RN 界面时一律消费 `mobile-rn/src/design` 的语义 Token 与基础组件，严禁在业务屏手写十六进制色值、字号、圆角或裸间距。
- `[L-003]` 调试 RN 界面布局与交互时先用 Debug 包配合 Metro 热更新调通验收，确认无误后再执行单次双架构 Release 构建与验签。
- 操作共享 Android 模拟器前，通过 `agent-device open ... --serial <id>` 原子申领设备并在 `finally` 中执行 `agent-device close` 释放声明。
- 向 Expo SDK 55 Debug 应用注入测试数据时先停止应用进程，并同步写入 `files/SQLite/opengym-rn.db`。

## 3. `web-client`（Web / PWA 与领域引擎）

- 凡计算下次训练目标负重/次数或回读已完成训练会话的逻辑，一律实现为 `frontend/src/lib/` 下的纯函数并配套同目录单元测试。
- 新增用户可见英文文案时，同步补齐 `frontend/src/locales/` 全语种词条并通过 `check-locales.mjs` 与 `check-source-strings.mjs --strict` 校验。
- 修改列表或响应式容器时保持输入框组件引用与稳定 `key`，禁止在视口宽度切换、软键盘弹出或受控状态刷新时卸载重建导致失焦。

## 4. `api-sync`（后端、存储与同步）

- 增删改任何 HTTP 路由或请求/响应结构时，同步更新 `api/openapi.yaml` 并执行 `node scripts/build-api-docs.mjs` 保持接口文档字节级一致。
- 修改 `frontend/src/lib/sync-merge.js`、`glyphs.js`、`nudge.js` 或 `queue.js` 时，同步修改 `api/` 下对应的双写文件并通过对偶测试。
- 写入 `DATA_DIR` 下的持久化 JSON 文件时一律采用临时文件加原子重命名（`durable.js`），严禁直接原地覆写。

## 5. `ai-agent`、`catalogue` 与前端视觉门禁

- 严禁手工编辑 `exercises-data.js` 等词库生成产物；所有内置动作变更一律修改 `catalogue/` 源文件并运行构建脚本生成。
- 在智能检索评测报告、终端输出与诊断日志中严禁输出 API 密钥、图片 Base64 数据、私有自定义动作 ID 或原始模型异常文本。
- 凡改动用户可见 GUI 行为，必须在真实浏览器或模拟器/真机上录制完整交互 GIF 存入对应需求文档的 `evidence/` 目录，不得仅凭单测全绿或静态截图放行。
