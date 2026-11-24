# 16 · AI Coach

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 3（媒体、扩展和生命周期）
- 依赖：[05 会话与访问控制](05_SESSION_AND_ACCESS.md)、[13 通知](13_NOTIFICATIONS.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§5
- 代码落点：`api/src/coach/`，复用 `api/coach/`
- 自有路由：18
- 状态：待执行

## 1. 背景与目标

Coach 是可选功能，涉及用户界面、管理界面、任务队列、定时调度、provider 适配器、凭据加密和提案通知。迁移必须保持：

- 未配置 / 未连接 / `COACH_DISABLED=1` 时，用户界面和管理界面看到的状态与旧入口一致。
- 旧 `coach.json`、`coach/<uid>.json`、凭据目录和加密格式可读。
- 任务中断后按 `recoverOnBoot` 结束，已有提案保留。
- 提案只在有实际变更时推送；失败 / `nochange` 静默。
- Coach 共享核心 `api/coach/core/` 继续供 Web / Capacitor 构建导入。
- provider 子进程的权限、超时、日志和凭据隔离不变。

## 2. 路由清单

### 2.1 用户接口（12）

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/coach/disclosure` |
| `GET` | `/api/coach/status` |
| `POST` | `/api/coach/plan` |
| `POST` | `/api/coach/review` |
| `POST` | `/api/coach/debrief` |
| `POST` | `/api/coach/ask` |
| `POST` | `/api/coach/adapt` |
| `GET` | `/api/coach/cohort` |
| `POST` | `/api/coach/cohort/share` |
| `POST` | `/api/coach/pending/resolve` |
| `POST` | `/api/coach/forget` |
| `GET` | `/api/coach/account` |

### 2.2 管理接口（6）

| 方法 | 路径 |
| --- | --- |
| `GET` | `/api/admin/coach` |
| `POST` | `/api/admin/coach/config` |
| `POST` | `/api/admin/coach/test` |
| `POST` | `/api/admin/coach/models` |
| `POST` | `/api/admin/coach/connect` |
| `POST` | `/api/admin/coach/disconnect` |

## 3. 现状与兼容点

### 3.1 开关与状态

- `COACH_DISABLED=1` 是最高优先级 kill switch；路由存在但按旧入口返回禁用状态。
- 实例未连接 provider：用户路由返回未配置 / 未连接状态；管理接口引导配置。
- 用户模块开关 `state.modules.coach === false` 时暂停用户功能；设置保留。
- `GET /api/coach/status` 返回 job / pending / consent / cadence 等状态。
- `GET /api/coach/disclosure` 需要会话，不向未登录用户泄露 provider 信息。
- `GET /api/config` 在已登录时始终返回 `coach` 键；未启用 / 未连接时为 `null`，未登录时不存在（见 04）。

### 3.2 配置与凭据

- `api/coach/config.js`：
  - 读取 `coach.json`。
  - 用 `DATA_DIR/secret` 加密保存凭据。
  - 实例级 / 账号级 provider 凭据；`COACH_CREDENTIAL_DIR` 默认 `/coach-auth`。
  - provider 选择、模型、options、绑定用户。
  - `clearProfileAuth(uid)` 清理个人凭据。
- 旧密文、密钥派生、文件权限必须可读；不要换成新的加密格式。
- `coach` 用户的权限、`jobEnv`、子进程工作目录和日志脱敏不变。
- `publicConfig()` 只返回公开字段（provider 名称、模型、能力），不返回密钥。

### 3.3 任务队列

- `api/coach/jobs.js`：
  - `enqueue(uid, { kind, trigger })`。
  - `status(uid)`、`readUser(uid)`、`writeUser(uid)`。
  - `recoverOnBoot()`：把中断任务标记为 `failed`，`errorClass: 'restart'`。
  - `setProposalHook(fn)`：提案就绪回调。
  - `clearUser(uid)`：用户主动忘记时清理；不要用于应用关闭。
  - 任务超时、历史上限、提案过期。
- 任务文件在 `COACH_DIR`；每个 uid 一个 JSON；写入原子。
- 队列串行 / 并发规则按旧实现；不要在 Nest 里重新实现一份。

### 3.4 调度和 warmup

- `api/coach/cadence.js`：
  - 60 秒 tick；只在启用 / 连接时运行。
  - 跳过未同意、模块关闭、已有 job / pending、未到时间的用户。
  - 时区来自账号状态；`isDue` 复用。
- `api/coach/warmup.js`：
  - 启动 5 秒后首次 warmup，之后每 30 分钟。
  - 失败只记录，不影响服务。
  - 需要同时保存首次延迟任务和周期任务句柄，关闭时都停止。
- 计时器由 17 启动 / 停止，不在模块加载时启动。

### 3.5 提案与通知

- `setProposalHook` 由生命周期协调器连接到 `NotificationsService`。
- 只在 `pending.changes.length > 0` 时推送；标题 / 文案与旧入口一致。
- 失败 / `nochange` 静默，不推送。
- 账号删除时清理个人凭据；是否清理任务文件按旧入口（`clearUser` 只在“忘记”时调用）。
- 关闭应用时不要调用 `clearUser`；未完成任务保留给 `recoverOnBoot`。

### 3.6 共享核心

- `api/coach/core/` 被 Web / Capacitor 构建导入（`frontend/src/lib/coach-local.js`）。
- 不要把 core 移到 `src/` 或改为仅服务端可用。
- `api/scripts/check-core-loadable.mjs` 必须继续通过。
- 构建 `dist` 时复制 `coach/core/`、`prompts.js`、`fixture-cli.mjs` 等资源。

## 4. 执行步骤

### 4.1 CoachModule 与 Service

- [ ] 新增 `api/src/coach/coach.module.ts`，导入 Auth / Persistence；提案通知由 `AppModule` 的生命周期协调器连接到 `NotificationsService`，Coach 不反向导入 Notifications。
- [ ] 新增 `api/src/coach/coach.service.ts`，包装现有模块：
  - `status(uid)`、`disclosure(uid)`、`account(uid)`。
  - `enqueue(uid, kind, body)`。
  - `resolvePending(uid, body)`、`forget(uid)`。
  - `cohort(uid)`、`shareCohort(uid, body)`。
- [ ] Service 不复制 `jobs.js` / `config.js` / `core/` 的业务逻辑；只做请求参数校验、权限和编排。
- [ ] 用户接口要求会话；管理接口要求 Admin（Owner 也是 Admin），连接 / 断开同样使用 Admin Guard。

### 4.2 用户 Controller

- [ ] 新增 `CoachController`：
  - disclosure、status、plan、review、debrief、ask、adapt、cohort、share、pending/resolve、forget、account。
  - 读取 JSON body；使用 02 的 `BodyReader`。
  - 返回结构与旧入口一致；错误码 / 状态码一致。
- [ ] `plan` / `review` / `debrief` / `ask` / `adapt` 的任务入队、限流、配额、同意检查按旧入口。
- [ ] `pending/resolve` 接受 / 拒绝 / 忽略提案；保存训练状态；通知 / 审计按旧规则。
- [ ] `forget` 调用 `jobs.clearUser`，清理个人数据；不能误删其他账号。
- [ ] `cohort` / `share` 只返回 / 共享脱敏数据；按旧规则。

### 4.3 管理 Controller

- [ ] 新增 `AdminCoachController`：
  - 查看配置、更新配置、测试 provider、列出模型、连接、断开。
  - 权限：Admin（Owner 也是 Admin）；连接 / 断开同样使用 Admin Guard，不额外要求 Owner。
- [ ] 配置更新写入 `coach.json`；凭据加密；不返回密钥明文。
- [ ] `test` / `models` 可能调用外部 provider；设置超时、错误映射、审计；不要阻塞事件循环。
- [ ] `connect` / `disconnect` 更新连接状态；写审计；影响 `/api/config` 的 `coach` 块。

### 4.4 启动与恢复

- [ ] 启动时调用 `jobs.recoverOnBoot()`；把中断任务标记为 `restart` 失败。
- [ ] 连接 `setProposalHook` 到 `NotificationsService`。
- [ ] 由 17 启动 `startCadence` 和 `startWarmup`；保存所有计时器 / 延迟任务句柄。
- [ ] 关闭时停止 cadence / warmup，关闭队列门禁；等待在途任务或预算到期。
- [ ] 关闭时不要调用 `clearUser`；任务文件保留。

### 4.5 凭据与权限

- [ ] 读取旧 `coach.json` / 账号凭据；密钥来自 `DATA_DIR/secret`。
- [ ] `COACH_CREDENTIAL_DIR`、`coach` 用户、文件权限、子进程 sandbox 不变。
- [ ] 个人凭据清理只在账户删除 / 忘记时调用；不要影响实例级凭据。
- [ ] provider 失败 / 超时 / 无权限 / 未连接的错误分类与旧入口一致。
- [ ] 日志不包含 prompt 全文、密钥、训练数据敏感内容（按旧规则）。

### 4.6 构建与共享

- [ ] 构建脚本复制 `coach/core/`、`coach/prompts.js`、`coach/fixture-cli.mjs` 等运行期资源。
- [ ] `npm run build` 后 `node api/scripts/check-core-loadable.mjs` 仍通过。
- [ ] Web / Capacitor 构建继续从 `api/coach/core/` 导入；不新增 Vite-only 导入。
- [ ] `coach` 镜像包含 Agent SDK / Codex；`default` 镜像不包含（见 19）。

## 5. 测试

### 5.1 现有测试

- `coach-ask.test.js`、`coach-adapt.test.js`、`coach-limits.test.js`。
- `jobs.test.js`、`warmup.test.js`、`cadence-weekly.test.js`、`queue.test.js`。
- `review-window.test.js`、`review-routine-cap.test.js`、`review-repair.test.js`、`review-followup-context.test.js`、`refine-change-list.test.js`。
- `prompts.test.js`、`prompt-split.test.js`、`payload.test.js`、`payload-parity.test.js`、`payload-bounds.test.js`、`validate.test.js`、`parse.test.js`、`cohort.test.js`。
- `routes.test.js`、`e2e-apikey.test.js`：路由 / provider 协议。
- `server-wrapped-push.test.js`：提案 / 年度总结通知边界。

### 5.2 新增测试

- [ ] 未配置、未连接、`COACH_DISABLED=1`、模块关闭四种状态下的用户 / 管理接口。
- [ ] 旧 `coach.json` / 账号凭据可读；密文格式不变。
- [ ] 任务入队、状态、历史、提案、`pending/resolve`、`forget`。
- [ ] `recoverOnBoot` 把中断任务标记为 `restart`，已有提案保留。
- [ ] 提案 hook 只在有变更时推送；失败 / `nochange` 静默。
- [ ] cadence 跳过未同意 / 模块关闭 / 已有 job / 未到期；时区边界。
- [ ] warmup 首次 5 秒 / 30 分钟；关闭时两个句柄都停止。
- [ ] provider 超时 / 错误 / 无权限 / 子进程清理；日志脱敏。
- [ ] 账户删除清理个人凭据；实例凭据不受影响。
- [ ] `check-core-loadable`、Web 共享构建通过。
- [ ] `default` / `coach` 镜像的 AI 运行时取舍（见 19）。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/coach-ask.test.js test/coach-adapt.test.js test/jobs.test.js test/warmup.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 18 个 Coach 路由的状态、错误和响应结构与旧入口一致。
- [ ] 未配置 / 未连接 / 禁用 / 模块关闭状态正确。
- [ ] 旧 `coach.json`、账号凭据、任务文件可读。
- [ ] 任务恢复、调度、warmup、提案通知按旧规则。
- [ ] 个人凭据清理不影响实例凭据；关闭不调用 `clearUser`。
- [ ] 共享 core 可被 Web / Capacitor 构建导入。
- [ ] `default` / `coach` 镜像的权限和运行时正确。
- [ ] A6 的 Coach 部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 复制一份 Coach 业务逻辑导致漂移 | 复用 `coach/` 模块；Controller 只编排 |
| 关闭时清空任务 / 提案 | 不调用 `clearUser`；`recoverOnBoot` 处理中断 |
| 提案通知重复 / 无变更也推送 | 只按 `changes.length` 推送；测试 |
| 凭据加密格式变化 | 读取旧 `secret` / 旧格式；不做迁移脚本 |
| cadence / warmup 计时器残留 | 17 统一保存句柄；A10 |
| 共享 core 被 Nest 特有导入污染 | `check-core-loadable`；Web 构建 |

## 8. 验收记录

```text
状态：待执行
代码版本：
Coach 路由 / 任务 / 恢复验收：
A6 证据：
遗留问题：
```
