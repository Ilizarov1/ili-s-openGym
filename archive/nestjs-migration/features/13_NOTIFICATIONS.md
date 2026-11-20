# 13 · 通知、提醒与年度总结

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 3（媒体、扩展和生命周期）
- 依赖：[05 会话与访问控制](05_SESSION_AND_ACCESS.md)、[09 审计与在线态](09_AUDIT_AND_PRESENCE.md)、[03 持久化](03_PERSISTENCE.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§5
- 代码落点：`api/src/notifications/`
- 自有路由：8
- 状态：待执行

## 1. 背景与目标

通知功能包括 Web Push 订阅、测试推送、组间休息计时、训练日提醒、催练检查和年度总结。迁移必须保持：

- 订阅保存 / 删除 / 状态 / 设备过滤与旧入口一致。
- VAPID 密钥从 `DATA_DIR/vapid.json` 读取，跨重启身份不变。
- 组间休息计时器按用户 + 设备隔离，取消 / 完成训练时清除。
- 训练日提醒按账号时区触发；在线训练时抑制催练。
- 年度总结只发一次，失败不重复打扰。
- 所有计时器在 `app.listen()` 后启动，在关闭时停止并等待在途推送。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/push/public-key` | 返回 VAPID 公钥 |
| `POST` | `/api/push/subscribe` | 保存 Push 订阅 |
| `GET` | `/api/push/status` | 当前账号订阅状态 |
| `POST` | `/api/push/unsubscribe` | 删除订阅 |
| `POST` | `/api/push/test` | 发送测试通知 |
| `POST` | `/api/push/rest-timer` | 安排组间休息提醒 |
| `POST` | `/api/push/rest-timer/cancel` | 取消休息提醒 |
| `GET` | `/api/nudge-check` | 客户端检查催练 |

## 3. 现状与兼容点

### 3.1 Push 订阅

- `vapid.json` 缺失时生成；公钥返回给客户端。
- 订阅保存在 `db.subs`：`userId`、endpoint、keys、设备 id、创建时间等。
- 同一 endpoint 重新订阅是 upsert，保留原 `created`；endpoint 属于其他账号且 keys 不匹配时返回 `409`，防止把他人设备改绑到自己的账号。
- 每个账号最多 20 条订阅（`MAX_SUBS_PER_USER`）；超过时按旧逻辑淘汰最旧的行。
- `GET /api/push/status` 只返回当前账号的订阅 / 设备状态。
- `POST /api/push/unsubscribe` 删除当前账号的订阅；不能删除他人。
- 推送端点 URL 校验、大小限制、私网 / 域名安全由 `net-guard.js` / `push-messages.js` 处理。
- 推送失败按旧规则清理失效订阅；不要因为一次 404 删除所有订阅。

### 3.2 测试推送

- `POST /api/push/test` 需要会话；限流 / 冷却按旧入口。
- 发送一条测试通知，返回旧结构。
- 设备 id 过滤与订阅保存一致。

### 3.3 组间休息

- `POST /api/push/rest-timer`：`{ seconds, deviceId?, lang? }`；按 `userId:deviceId` 存定时器。
- 到点发送通知；取消 / 完成训练 / 重开时清除。
- 同一设备重复安排要取消旧计时器。
- 进程重启后计时器丢失，客户端重新安排；不持久化。
- 计时器由 17 统一停止；发送中的 Promise 计入在途。

### 3.4 训练日提醒 / 催练

- 训练日提醒按账号设置（星期、时间、时区）触发；`userNow(tz)` 复用旧逻辑。
- `GET /api/nudge-check` 供客户端检查是否应催练；在线态来自 09 的 `PresenceService.getLive`。
- 在线训练时抑制催练；隐藏超时 / 心跳过期后恢复。
- 提醒规则在 [nudge.js](../../../api/nudge.js)、文案在 `nudge-copy.js`；不要复制一份规则。
- 发送失败记录，不阻断其他用户。

### 3.5 年度总结

- `wrapped.js` / `wrapped-copy.js` 生成年度总结；每年只发一次。
- 状态摘要通过 `StateStore.summary`；训练量 / 连续周等规则复用旧模块。
- 时区边界按旧实现；不要用服务器本地时区替代账号时区。
- 失败不重复推送；成功写入已发送标记（按旧存储位置）。

## 4. 执行步骤

### 4.1 NotificationsService

- [ ] 新增 `api/src/notifications/notifications.service.ts`：
  - `publicKey()`、`subscribe(user, body)`、`status(user)`、`unsubscribe(user, body)`、`test(user, body)`。
  - `sendPush(userId, payload, deviceId?)`：复用 `sendPush` / `push-messages.js`。
  - `scheduleRestTimer(userId, deviceId, sec, lang)`、`cancelRestTimer(userId, deviceId)`。
  - 休息计时器 Map 只在 Service 内；进程重启丢失。
- [ ] VAPID 从 `Keys.loadVapid()` 读取；初始化失败时按旧入口记录并禁用推送，不阻断其他功能。
- [ ] 订阅保存 / 删除走 `AccountStore.save()`；设备 id 校验复用旧规则。
- [ ] 推送失败清理失效订阅；不要删除其他设备。

### 4.2 路由 Controller

- [ ] 新增 `PushController`：
  - `GET /api/push/public-key` 是公开路由，不需要会话。
  - 订阅、状态、退订、测试、休息计时器安排 / 取消需要会话。
  - 使用 `BodyReader` 和 `reply`。
  - 设备 id 可选；缺省按旧行为。
- [ ] `MEDIA` / `COACH` 等开关不影响 Push 路由存在性（按旧入口）。
- [ ] 错误码、限流、`Retry-After` 与旧入口一致。

### 4.3 提醒调度

- [ ] 新增 `ReminderService`：
  - 读取用户列表、`stateSummary`、`userNow(tz)`。
  - 训练日提醒按旧规则计算；不重复发送同一天 / 同一时段。
  - 与 `PresenceService.getLive` 联动，在线时抑制催练。
  - 计时器由 17 启动 / 停止；tick 间隔与旧 `REMINDER_TICK_MS` 一致，测试可覆盖。
- [ ] `GET /api/nudge-check` 调用同一套规则，不复制判断。
- [ ] 提醒发送 / 失败写日志；不写敏感训练内容到日志。

### 4.4 年度总结

- [ ] 新增 `WrappedService`，复用 `wrapped.js` / `wrapped-copy.js`：
  - 按账号时区判断年度边界。
  - 使用 `StateStore.summary` 或读取状态；不要每次全量解析。
  - 已发送标记按旧存储方式保存；失败不标记成功。
  - 由 17 启动的周期任务调用。
- [ ] 测试跨年 / 时区 / 无训练数据 / 发送失败重试边界。

### 4.5 生命周期

- [ ] 所有计时器在 `app.listen()` 后由 17 启动。
- [ ] 关闭时停止提醒、休息计时器、年度总结任务；等待在途推送。
- [ ] 关闭后不得重新调度；计时器句柄由协调器保存。

## 5. 测试

### 5.1 现有测试

- `server-push-status.test.js`、`server-push-device.test.js`、`server-push-filter.test.js`、`server-push-size.test.js`、`server-push-prune-save.test.js`、`server-push-allowed-private.test.js`。
- `server-reminder.test.js`、`server-nudge.test.js`、`server-nudge-check.test.js`、`server-wrapped-push.test.js`。
- `push-messages.test.js`、`nudge.test.js`、`nudge-copy.test.js`、`wrapped.test.js`、`queue.test.js`。
- `server-presence.test.js`：在线时抑制催练。

### 5.2 新增测试

- [ ] 旧订阅保存在 Nest 入口下可读、可推送、可退订。
- [ ] VAPID 公钥跨重启一致；订阅身份不丢。
- [ ] 测试推送成功 / 失败 / 失效订阅清理。
- [ ] 休息计时器按 `userId:deviceId` 隔离；重复安排取消旧计时器；取消 / 完成训练清除。
- [ ] 训练日提醒按时区触发；同一天不重复。
- [ ] 在线训练时 `nudge-check` 不催练；离线 / 隐藏超时后恢复。
- [ ] 年度总结跨年 / 时区 / 无数据 / 发送失败。
- [ ] 关闭时停止所有计时器，在途推送完成或超时；重启后不残留。
- [ ] 推送端点大小 / 私网 / URL 校验与旧入口一致。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-push-status.test.js test/server-reminder.test.js test/server-nudge-check.test.js test/server-wrapped-push.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 8 个路由的请求 / 响应与旧入口一致。
- [ ] 旧 VAPID、旧订阅、旧设备 id 继续可用。
- [ ] 休息计时器、训练日提醒、催练、年度总结按旧规则运行。
- [ ] 在线训练抑制催练；重启后在线态由新心跳恢复。
- [ ] 关闭时计时器停止、在途推送排空；不残留调度。
- [ ] Push 失效订阅清理不误删其他设备。
- [ ] A6、A8 的通知部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 计时器在关闭后重新启动 | 17 统一门禁；句柄保存；A10 |
| 订阅身份 / VAPID 变化导致旧客户端失效 | 读取旧 `vapid.json`；旧订阅回读 |
| 时区计算错误导致提醒偏移 | 复用 `userNow`；固定时钟 / 时区测试 |
| 在线态第二实例导致催练误发 | 共用 09 的 `PresenceService` |
| 年度总结重复推送 | 已发送标记；失败不标记；跨年测试 |

## 8. 验收记录

```text
状态：待执行
代码版本：
Push / 提醒 / 年度总结验收：
A6 / A8 证据：
遗留问题：
```
