# 17 · 生命周期、停机与本地恢复

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 3（媒体、扩展和生命周期）
- 依赖：[09 审计与在线态](09_AUDIT_AND_PRESENCE.md)、[12 媒体](12_MEDIA.md)、[13 通知](13_NOTIFICATIONS.md)、[14 手表](14_WATCH.md)、[15 集成](15_INTEGRATIONS.md)、[16 Coach](16_COACH.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §5
- 代码落点：`api/src/lifecycle/`、`api/src/start-api.ts`、`api/admin-socket.js`
- 自有路由：0
- 状态：已实现。Windows 显式关闭已验证，Linux 信号与部署验收待验证。

## 1. 背景与目标

旧入口在模块加载时启动若干计时器和回调，没有统一的排空协议。迁移后所有后台任务必须在 `app.listen()` 成功后统一启动，并在关闭时按固定顺序停止、排空和回收资源。同时保留管理员恢复 CLI：

- 新业务请求被拒绝后，已接纳的请求仍可完成写入。
- 计时器、队列、Coach cadence / warmup、媒体清理、在线态和审计维护全部停止。
- 在途 HTTP、媒体上传 / 断流清理、Push、Webhook、Coach 任务被跟踪，默认 8 秒预算。
- 预算到期后中止剩余流 / provider 调用 / 子进程，保留可恢复的队列和任务。
- Linux 的 `SIGTERM` / `SIGINT` 和 Windows 的显式 `app.close()` 走同一条路径。
- 关闭时不得调用 `clearUser` 或删除用户数据。
- 管理员恢复 CLI 通过 Unix socket 请求运行中的服务写入账户库，不能在 Windows 启动。

## 2. 启动 / 停止顺序

### 2.1 启动

1. 进程环境已由父进程设置好；`main.ts` 不修改 `process.env`。
2. 加载 `RuntimeConfig`、`DATA_DIR`、`secret`、`db`、VAPID、Coach 配置。
3. 构造 Nest 应用；`onApplicationBootstrap` 只做初始化，不启动计时器。
4. `await app.listen(PORT)`。
5. `LifecycleCoordinator.startAll()`：
   - 提醒 / 训练日 / 年度总结。
   - 集成 outbox。
   - Coach cadence / warmup。
   - 媒体清理。
   - 在线态清理。
   - 审计压缩。
   - 管理员本地 socket。
6. 打印启动行，取得实际端口。Coach 提案通知由 `RuntimeWiringService` 在组装应用时连接。

### 2.2 停止

1. 设置 `closing = true`，请求钩子拒绝新业务请求。
2. 停止本地恢复 socket 接收新命令。
3. 停止所有计时器、队列调度、Coach cadence / warmup、媒体清理、在线态清理、审计压缩。
4. 关闭 Coach 队列继续出队门禁、Webhook 后续批次调度。
5. 跟踪并等待在途 HTTP、媒体上传及断流清理、Push、Webhook、Coach 任务。
6. 默认等待 8 秒。到期后通过 `AbortSignal` 和请求钩子中止剩余调用、子进程和请求流，最多再等待 1 秒清理。
7. 关闭剩余 socket / 网络资源。
8. `onModuleDestroy` 等待同一个关闭 Promise；关闭后任何回调不得重新启动调度。

### 2.3 资源保留

- Webhook：保留未完成队列和投递 ID，下次启动继续。
- Coach：保留中断任务和已有提案，下次启动 `recoverOnBoot` 标记失败。
- 媒体：保留已完成的用户媒体；回收临时上传文件。
- 用户数据：任何情况下不调用 `clearUser`、不删除账户 / 状态 / 媒体。

## 3. 执行步骤

### 3.1 LifecycleCoordinator

- [ ] 新增 `api/src/lifecycle/lifecycle.coordinator.ts`：
  - `closing` 标志和幂等 `stop()`；多次调用返回同一个 Promise。
  - `start()` 保存所有计时器 / 队列句柄。
  - `track(promise)`：登记在途 HTTP、媒体、Push、Webhook、Coach Promise。
  - `drain(ms = 8000)`：等待全部在途或超时。
  - `abortRemaining()`：中止流、provider 调用、受管理子进程。
  - `closeSockets()`。
- [ ] `stop()` 顺序固定：拒绝新请求 → 停 socket → 停计时器 → 停队列 → 等待在途 → 超时回收 → 关 socket。
- [ ] 关闭后设置 `stopped`，计时器回调、队列完成回调、Coach 回调检查该标志，拒绝重新调度。
- [ ] 导出 `isClosing()` 给 02 的请求钩子使用。

### 3.2 计时器与队列句柄

- [ ] 提醒：`ReminderService.start()/stop()`，返回句柄。
- [ ] 年度总结：`WrappedService.start()/stop()`。
- [ ] 集成 outbox：扩展 `stop()` 停止后续批次并等待当前 `run()`。
- [ ] Coach cadence：`startCadence` 返回 timer；`stop()` 清除。
- [ ] Coach warmup：`startWarmup` 需要同时保存首次 5 秒 `setTimeout` 和周期 `setInterval`，两者都可停止。
- [ ] 媒体清理：每小时 timer。
- [ ] 在线态清理：30 秒 timer。
- [ ] 审计压缩：每小时 timer。
- [ ] 限流 sweep：1 分钟 timer。
- [ ] 所有 timer 使用 `unref()`（按旧入口），但不依赖进程退出清理；显式停止。

### 3.3 在途跟踪

- [ ] 请求钩子 / 中间件为每个已接纳业务创建 `track` Promise；响应结束 / 连接关闭时 resolve。
- [ ] 媒体上传和断流清理单独 `track`；客户端断开后的清理也算在途。
- [ ] Push 发送、Webhook 投递、Coach 任务在启动时登记；完成 / 失败 / 中止时 resolve。
- [ ] 关闭时新请求直接 503 / 拒绝，不进入业务。
- [ ] 预算到期后中止剩余流和子进程；不要等待无限期。

### 3.4 信号与 Windows

- [x] Linux：由 Nest 处理 `SIGTERM` / `SIGINT`，在销毁钩子中等待协调器。信号验收要求进程退出前已回收上传文件。
- [ ] Windows：不注册 Unix socket；通过测试 / 管理入口显式 `app.close()` 进入同一路径。
- [ ] 不要在多个模块里各自注册信号处理器；只由入口 / 协调器注册一次。
- [ ] 信号重复到达时复用同一个关闭 Promise，不重复执行。
- [ ] 关闭过程中打印可诊断日志：开始、在途数量、超时、完成。

### 3.5 部署宽限

- [ ] Compose `api` 服务增加 `stop_grace_period: 10s` 或更长。
- [ ] Helm / Kubernetes 设置 `terminationGracePeriodSeconds: 15`，大于 8 秒排空预算。
- [ ] 保持单副本 `Recreate`；不因 Nest 改为多副本。
- [ ] 文档说明调整预算时要同步调整部署宽限。

### 3.6 管理员恢复 socket / CLI

- [ ] 启动成功后调用 `startAdminSocket`：
  - Linux 才启动；Windows 返回 null。
  - 目录 0700、socket 0600，检查属主和符号链接。
  - 只接受本地同用户连接。
- [ ] 恢复命令接到 `AccountsService.issueRecovery`：
  - 支持按 name / id 查找。
  - 多个同名时返回候选，要求 `--id`。
  - 禁用账户拒绝；Owner 也允许通过 CLI 恢复。
  - 返回 code / 过期时间；写审计。
- [ ] 关闭时停止 socket 接收新命令，等待当前命令完成。
- [ ] 验证 `node recover.js <name>` 在运行中的 Nest 实例上工作。
- [ ] `recover.js` 不直接编辑 `db.json`；仍通过 socket 让运行中的进程写入。

## 4. 测试

### 4.1 停机用例

- [ ] 慢速上传期间关闭：新请求拒绝、上传被中止或完成、临时文件回收。
- [ ] 在途 Webhook 期间关闭：停止后续批次、等待当前投递或超时、队列保留。
- [ ] 排队 Coach 任务期间关闭：停止出队、在途任务结束或超时、任务文件保留。
- [ ] 预算内完成的训练写入可回读。
- [ ] 超过 8 秒的请求 / 子进程被中止，进程在部署宽限内退出。
- [ ] 关闭后无残留计时器 / 监听 / 子进程。
- [ ] Linux `SIGTERM` / `SIGINT` 和 Windows `app.close()` 都通过。
- [ ] 重复 `stop()` 只执行一次，返回同一个 Promise。

### 4.2 恢复 CLI

- [ ] Linux 上 `node recover.js <name>` 返回恢复码。
- [ ] 多个同名 / 禁用 / 不存在 / 已删除账户的错误。
- [ ] socket 权限 0700 / 0600；其他用户不能连接。
- [ ] Windows 不启动 socket，CLI 提示不可用（按旧行为）。
- [ ] 恢复操作写审计；不直接写 `db.json`。

### 4.3 回归

- [ ] `server-recovery.test.js`。
- [ ] `server-media.test.js` 的上传超时 / 断流。
- [ ] `server-integrations.test.js` 的队列。
- [ ] `jobs.test.js` / `warmup.test.js`。
- [ ] A10 全用例。

### 4.4 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
npm.cmd run test:nest -- test/nest/shutdown.test.js test/server-recovery.test.js test/server-media.test.js test/server-integrations.test.js
```

## 5. 验收目标

- [ ] 所有后台任务只在 `listen` 后启动。
- [ ] 关闭时新请求被拒绝，计时器 / 队列停止，在途业务按 8 秒预算排空。
- [ ] 超时资源被回收，Webhook / Coach 可恢复状态保留。
- [ ] Linux 信号 / Windows `app.close()` 都能干净退出，无残留句柄。
- [ ] 关闭不删除用户数据、不调用 `clearUser`。
- [ ] 恢复 CLI 在 Linux 可用，权限正确，不直接编辑账户库。
- [ ] Compose / K8s 宽限大于排空预算。
- [ ] A10 通过；A6 的恢复 CLI 部分通过。

## 6. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 计时器在关闭后重新启动 | `closing` / `stopped` 门禁；句柄统一停止；A10 |
| 在途 Promise 未跟踪，进程提前退出 | `track()` 覆盖 HTTP / 媒体 / Push / Webhook / Coach |
| 超时后子进程残留 | 中止受管理子进程；检查进程表 / 退出码 |
| 关闭时清空任务 / 提案 | 不调用 `clearUser`；保留任务文件 |
| socket 权限不安全 | 0700 / 0600；属主检查；Linux-only |
| Windows 没有 socket 导致恢复不可用 | 保持旧行为；文档说明 |

## 7. 验收记录

```text
状态：Windows 显式关闭通过，Linux 信号及镜像待验证
代码版本：基于 94777b4ad 的迁移工作区
停机验证：test/nest/shutdown.test.js 覆盖慢速上传、训练写入、测试 outbox 和 Coach 子进程
A10 证据：见 ACCEPTANCE.md
遗留问题：目标 Linux CI 信号结果、部署宽限与容器恢复 CLI
```
