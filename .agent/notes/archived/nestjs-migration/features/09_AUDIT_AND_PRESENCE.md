# 09 · 审计与在线训练态

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 2（账户、认证、审计、在线态和同步）
- 依赖：[03 持久化](03_PERSISTENCE.md)；`POST /api/activity` 的 Controller 由 `AccountsModule` 承载，鉴权见 [05](05_SESSION_AND_ACCESS.md)，本模块不反向导入 Auth
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§3、§4
- 代码落点：`api/src/audit/`、`api/src/presence/`
- 自有路由：1
- 状态：待执行

## 1. 背景与目标

审计和在线态是两个进程内共享服务：审计负责把安全事件写到 `audit.log`，在线态负责让管理后台和催练推送知道谁正在训练。它们必须：

- 作为单例被 Auth、Accounts、Media、Watch、Integrations 等模块共用。
- 不产生第二个账户库、第二个审计序号或第二个在线态 Map。
- 审计 IP 脱敏、保留期、轮转和清空语义与旧入口一致。
- 在线态不落盘，重启后等待客户端新心跳恢复。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/activity` | 客户端训练活动心跳 |

审计查询 / 清空路由在 08 号文档；本功能提供 `AuditService`，并由 `AccountsModule` 承载查询 Controller。

## 3. 现状与兼容点

### 3.1 审计

- 文件：`DATA_DIR/audit.log`，一行一个 JSON。
- 事件字段：`id`、`ts`、`ev`、`ok`、`user` / `name`、`ip`（按模式）、`msg` 等；具体字段以旧 `audit()` 为准。
- `id` 单调递增；清空日志不重置序号，留下可见缺口。
- `AUDIT_LOG=0` 时不写；`AUDIT_MAX` 条数上限（默认 5000，0 为不限）；`AUDIT_DAYS` 天数上限（默认 90，0 为不限）。
- `AUDIT_IP=off` 不记录地址；`net` 只记录网段；`full` 记录完整地址。
- 读取时也执行保留裁剪；每小时压缩 / 轮转一次。
- 权限拒绝审计：普通用户 403 写 `admin.denied`；未认证 401 不写。
- 审计查询 / 清空权限在 08；清空本身写审计。

### 3.2 在线态

`PresenceService` 维护 `uid -> { name, exIdx, exTotal, setsDone, setsTotal, startedAt, updatedAt, hiddenAt? }`。

`POST /api/activity` 语义：

- 普通心跳：更新训练名称、进度、时间。
- `hidden`：只记录首次隐藏时间；后续心跳清除隐藏标记。
- `navigated`、`closed`、未提供原因的离开：立即移除记录。
- 鉴权后调用；不是公开接口。

`getLive(uid)`：

- 距最后心跳达到 70 秒 → 不在线。
- 隐藏后 45 秒未恢复 → 不在线。
- 读取时也做过期判断；另有 30 秒清理计时器。
- 正在训练时抑制催练推送（13）。
- 禁用、删除、签发恢复链接时清理同一个实例。
- 在线态不落盘；重启后等待客户端新心跳。

## 4. 执行步骤

### 4.1 AuditService

- [ ] 新增 `api/src/audit/audit.service.ts`：
  - `audit(req, ev, fields)`：等价旧 `audit()`。
  - `auditFail(req, ev, fields)`：失败事件辅助。
  - `lines()`、`keep(rows)`、`compact()`。
  - `clear()`：删除 `audit.log`，不重置序号；之后写 `admin.audit.clear`。
  - `clientIp(req)`：按 `TRUST_PROXY`、`CF-Connecting-IP`、`X-Forwarded-For` 解析。
  - IP 脱敏：`off` / `net` / `full`。
- [ ] 初始化时读取已有日志的最大 id，恢复 `auditSeq`；不要从 0 重新开始。
- [ ] 写入使用追加或原子写入，保持旧格式；文件权限按旧入口处理。
- [ ] 条数上限和保留期在写入和读取时都生效；每小时压缩由 17 的协调器启动。
- [ ] 审计写入失败只记录 `console.error`，不能阻断业务响应（按旧行为）。
- [ ] 不在审计中写密码、Passkey 公钥、配对码 / 设备链接明文、恢复码明文。

### 4.2 AuditModule

- [ ] 新增 `AuditModule`，只导入 `PersistenceModule`，导出 `AuditService`。
- [ ] `AuditModule` 不导入 `AuthModule` / `AccountsModule`，避免循环依赖。
- [ ] Auth、Accounts、Media、Watch、Integrations、Coach 通过导入 `AuditModule` 使用同一个实例。
- [ ] 审计查询 / 清空 Controller 放在 `AccountsModule`（08），只调用 `AuditService`。

### 4.3 PresenceService

- [ ] 新增 `api/src/presence/presence.service.ts`：
  - `update(uid, body, now)`：处理普通心跳、`hidden`、`navigated`、`closed`、无原因离开。
  - `getLive(uid, now)`：70 秒 / 隐藏 45 秒判断。
  - `remove(uid)`、`clear()`。
  - `list()`：管理后台需要的在线摘要。
  - 30 秒清理计时器由 17 启动，不在构造函数里启动。
- [ ] 在线态 Map 只存在一个实例；`PresenceModule` 导出 Service，其他模块导入，不重复 `providers`。
- [ ] 心跳时间使用注入的 `now` 或系统时间；测试用 fake clock。
- [ ] 不写 `DATA_DIR`；重启后 Map 为空。

### 4.4 ActivityController

- [ ] 在 `AccountsModule` 新增 `POST /api/activity`：
  - 需要会话；鉴权由 05 提供，本模块不导入 `AuthModule`，Controller 由 `AccountsModule` 承载。
  - 读取请求体；字段缺失按旧逻辑忽略。
  - 调用 `PresenceService.update`。
  - 返回旧响应（`{ ok: true }` 或旧结构）。
- [ ] 禁用 / 删除 / 恢复链接时调用 `PresenceService.remove`。
- [ ] 管理列表 / 详情通过 `PresenceService.getLive` 读取，不缓存第二份。

### 4.5 催练与审计联动

- [ ] `NotificationsModule` 的催练判断使用同一个 `PresenceService`。
- [ ] 在线时抑制催练；离线 / 隐藏超时后恢复。
- [ ] Auth 的登录、配对、权限拒绝事件调用 `AuditService`；不要把审计逻辑复制到 Guard 里。
- [ ] 媒体、手表、集成、Coach 的关键操作按旧入口写审计。

## 5. 测试

### 5.1 现有测试

- `server-presence.test.js`：心跳、隐藏、恢复、过期、离开、禁用 / 删除 / 恢复清理。
- `server-account-delete.test.js`：删除时在线态清理。
- `server-admin-state.test.js`：管理列表读取在线态。
- `server-recovery.test.js`：恢复链接清理在线态。
- `server-nudge.test.js` / `server-nudge-check.test.js`：在线时抑制催练。
- 审计相关：`server-admin-state.test.js`、`server-admin-delete.test.js`、`server-account-delete.test.js`、`server-password.test.js` 中的 `audit.log` 断言。

### 5.2 新增测试

- [ ] 审计 id 从已有日志继续递增；清空后不重置。
- [ ] `AUDIT_LOG=0` 不写文件；`AUDIT_MAX` / `AUDIT_DAYS` 裁剪正确。
- [ ] `AUDIT_IP=off/net/full` 三种输出；`TRUST_PROXY=0/1` 地址来源正确。
- [ ] 普通用户 403 写 `admin.denied`；未认证 401 不写。
- [ ] 审计写入失败不阻断业务响应。
- [ ] 在线态：普通心跳、`hidden`、恢复、45 秒隐藏过期、70 秒心跳过期、`navigated` / `closed` / 无原因离开。
- [ ] 同一个 `PresenceService` 被管理列表和催练共用；重启后在线态为空，新心跳恢复。
- [ ] 禁用 / 删除 / 恢复链接后在线态立即移除。
- [ ] 在线时催练不发送；离线后按旧规则发送。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-presence.test.js test/server-nudge.test.js test/server-nudge-check.test.js test/server-admin-state.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 审计文件格式、id、保留期、IP 模式与旧入口一致。
- [ ] 清空审计不重置序号，并写入 `admin.audit.clear`。
- [ ] 401 / 403 的审计差异符合 A9。
- [ ] 在线态 70 秒 / 隐藏 45 秒规则正确，读取时也判断过期。
- [ ] 管理列表、催练、禁用 / 删除 / 恢复共用同一个在线态实例。
- [ ] 重启后在线态为空，新心跳可恢复。
- [ ] A8、A9 的审计 / 在线态部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 审计序号从 0 重启，id 重复 | 初始化读取最大 id；清空不重置；A9 断言 |
| 审计 IP 在代理后记录错地址 | 复用 `clientIp`；`TRUST_PROXY` 两种配置测试 |
| 在线态出现第二份 Map | 单例 Provider；管理 / 催练共用；A8 检查 |
| 在线态重启后误显示在线 | 不落盘；重启后空 Map；A8 用例 |
| 审计写失败阻断业务 | 写入捕获异常；只记录错误 |

## 8. 验收记录

```text
状态：待执行
代码版本：
审计 / 在线态验收：
A8 / A9 证据：
遗留问题：
```
