# 15 · 外部集成与 Webhook

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 3（媒体、扩展和生命周期）
- 依赖：[03 持久化](03_PERSISTENCE.md)、[11 同步](11_SYNC.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§5
- 代码落点：`api/src/integrations/`
- 自有路由：7
- 状态：待执行

## 1. 背景与目标

集成功能让训练事件通过 Webhook 投递到 Home Assistant、n8n、ntfy 等外部服务。它必须在 Nest 中保持：

- 连接配置、密文、outbox 和重试语义与旧入口一致。
- 训练写入成功后才入队；入队失败不影响训练回执。
- Webhook 投递失败按退避重试，跨重启保留未完成队列和投递 ID。
- 未启用 `INTEGRATIONS` 时，路由按旧行为返回空列表 / 开关错误。
- 关闭时停止后续批次、等待在途投递，未完成队列留到下次启动。
- 外部地址安全校验（私网 / 协议 / 大小）不变。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/integrations` | 连接 / 状态列表 |
| `POST` | `/api/integrations/connect` | 连接外部服务 |
| `POST` | `/api/integrations/update` | 更新连接配置 |
| `POST` | `/api/integrations/disconnect` | 断开连接 |
| `POST` | `/api/integrations/test` | 发送测试事件 |
| `POST` | `/api/integrations/retry` | 重试失败队列 |
| `GET` | `/api/integrations/log` | 投递日志 |

## 3. 现状与兼容点

### 3.1 配置与存储

- `createIntegrations({ dataDir, secret, version })` 创建 hub。
- 连接配置 / 密文在 `DATA_DIR/integrations/`；使用 `secret` 派生密钥。
- `db.subs` 不保存集成连接；连接按账号目录隔离。
- 未启用 `INTEGRATIONS` 时：
  - `GET` 返回空列表 / 旧响应。
  - 其他路由返回旧开关错误（404 或业务错误）。
- 配置文件权限、密文格式和密钥派生不变；不要换成新的加密方案。
- `publicConfig()` 只在会话存在时通过 `/api/config` 暴露；未登录不泄露。

### 3.2 入队

- `SyncService` 训练写入成功后调用 `onStateWrite(uid, prev, next)`。
- 事件按连接 / 事件类型去重；`done` 记录投递 ID，避免重复。
- 入队失败只记录，不影响训练写入回执。
- outbox 持久化在 `DATA_DIR/integrations/`；重启后继续。
- 事件内容不包含密码、Passkey、配对码等敏感字段。

### 3.3 投递

- `start()` 启动定时批次（默认 5 秒）和立即 kick。
- `run()` 一轮一个批次，`concurrency` 并发；`running` 防重入。
- 失败按 `backoffDelay`、`retryAfterMs`、`MAX_ATTEMPTS` 退避；最终失败进 `failed`。
- `defer`（暂停连接）不消耗尝试次数。
- 失败记录上限 `FAILED_MAX`；`retry(uid, conn)` 从 0 重新入队。
- 投递使用签名 / 头 / 超时与旧入口一致；外部地址校验复用 `net-guard.js`。
- 404 / 410 等失效端点是否删除连接按旧规则。

### 3.4 停止

- 旧 `outbox.stop()` 只清定时器；迁移必须扩展为：
  - 停止后续批次调度。
  - 等待当前 `run()` 完成。
  - 保留未完成队列和投递 ID。
  - 关闭后不得重新启动调度。
- 关闭时在途投递计入 17 的在途集合；预算到期后中止 HTTP 请求，但保留队列。
- 重启后按原规则继续投递，不重复已完成的投递 ID。

## 4. 执行步骤

### 4.1 IntegrationsHub

- [ ] 新增 `api/src/integrations/integrations.service.ts`，包装 [integrations/index.js](../../../api/integrations/index.js)：
  - `publicConfig()`、`list(uid)`、`connect(uid, body)`、`update`、`disconnect`、`test`、`retry`、`log`。
  - `onStateWrite(uid, prev, next)`。
  - `start()`、`stop()`、`removeUser(uid)`、`dropConnection(uid, conn)`。
- [ ] 构造时读取 `RuntimeConfig.dataDir`、`secret`、`version`；不要重新生成密钥。
- [ ] `INTEGRATIONS=''` 时 hub 仍可构造，但 `publicConfig()` 为空、路由按旧开关响应。
- [ ] 连接配置 / 密文 / outbox 路径与旧入口一致；文件权限不变。

### 4.2 路由 Controller

- [ ] 新增 `IntegrationsController`，全部需要会话：
  - 列表、连接、更新、断开、测试、重试、日志。
  - 读取 JSON body；使用 02 的 `BodyReader` / `reply`。
  - 未启用时的响应与旧入口一致。
  - 错误码 / 业务错误结构一致。
- [ ] `test` 路由按旧规则限流 / 冷却；不无限发送外部请求。
- [ ] `log` 只返回当前账号的投递记录；不泄露其他账号。
- [ ] 所有外部地址经 `net-guard.js` 校验；不允许任意 SSRF。

### 4.3 同步入队

- [ ] `SyncService.write` 成功后调用 `IntegrationsHub.onStateWrite`；阶段 2 可先调用现有实例。
- [ ] 入队失败单独捕获并记录；训练响应不变。
- [ ] 事件去重 / `done` 记录与旧 outbox 一致；不要重复投递同一训练。
- [ ] 测试：同一次训练重复同步只产生一个事件（或按旧去重规则）。

### 4.4 outbox 停止与重启

- [ ] 扩展 outbox `stop()`：
  - 清定时器和 kick。
  - 设置停止门禁，拒绝新批次。
  - 等待当前 `run()` / 在途 `deliver`。
  - 保留 `st.jobs` / `st.failed` / `st.done`。
- [ ] 关闭时由 17 调用；预算到期后中止在途 HTTP，但保留队列。
- [ ] 重启后 `start()` 继续；未完成投递 ID 不重复。
- [ ] 关闭后计时器 / kick 不得重新启动。

### 4.5 账户清理

- [ ] 账户删除调用 `removeUser(uid)`，删除该账号连接、密文、outbox、done 记录。
- [ ] 断开连接调用 `dropConnection(uid, conn)`，清理该连接队列。
- [ ] 不删除其他账号的集成文件。

## 5. 测试

### 5.1 现有测试

- `server-integrations.test.js`：关闭 / 开启、连接、Webhook 投递、签名、私网。
- `integrations.test.js`：hub、crypto、outbox 行为。
- `queue.test.js`：队列 / 退避。
- `server-account-delete.test.js`：账户清理。
- `server-data-*`：训练写入触发事件。

### 5.2 新增测试

- [ ] `INTEGRATIONS=''` 与 `webhook` 两种配置下 7 个路由的响应。
- [ ] 连接 / 更新 / 断开 / 测试 / 重试 / 日志的字段和错误码。
- [ ] 训练写入后事件入队；重复同步不重复投递（按旧去重）。
- [ ] 投递器收到签名正确的事件；外部地址校验拒绝私网 / 非法协议（按配置）。
- [ ] 失败退避 / 最终失败 / `retry` 从 0 重试 / `defer` 不消耗尝试。
- [ ] 关闭时停止后续批次、等待在途；队列和投递 ID 保留。
- [ ] 重启后继续投递，不重复已完成事件。
- [ ] 账户删除只清理该账号集成数据。
- [ ] 入队失败时训练仍成功，错误被记录。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-integrations.test.js test/integrations.test.js test/queue.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 7 个路由在开 / 关配置下的响应与旧入口一致。
- [ ] 旧连接配置 / 密文 / outbox 可读；升级后继续投递。
- [ ] 训练写入成功后才入队；入队失败不影响训练。
- [ ] 投递重试 / 去重 / 退避 / `defer` 与旧入口一致。
- [ ] 关闭时停止调度、等待在途、保留队列；重启后继续。
- [ ] 外部地址安全校验不可绕过；日志不泄露密钥 / 事件敏感内容。
- [ ] A6、A10 的集成部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 停止时仍有批次 / kick 重新启动 | 停止门禁 + 协调器；A10 |
| 重启后重复投递 | 保留 `done` / 投递 ID；去重测试 |
| 入队失败回滚训练 | 入队单独捕获；训练回执以磁盘为准 |
| 外部地址 SSRF | 复用 `net-guard.js`；私网 / 协议测试 |
| 密文密钥重新生成导致旧连接不可读 | 读取旧 `secret`；不替换加密方案 |

## 8. 验收记录

```text
状态：待执行
代码版本：
投递 / 重启 / 关闭验收：
A6 / A10 证据：
遗留问题：
```
