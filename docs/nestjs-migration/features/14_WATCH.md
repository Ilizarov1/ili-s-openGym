# 14 · Zepp 手表中继

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 3（媒体、扩展和生命周期）
- 依赖：[05 会话与访问控制](05_SESSION_AND_ACCESS.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§5
- 代码落点：`api/src/watch/`
- 自有路由：9
- 状态：待执行

## 1. 背景与目标

Zepp OS 手表不能直接使用网页 Cookie，也不能安全保存长期网页会话。现有协议是：

1. 网页生成手表配对码。
2. 手表 App 的 Side Service 兑换成手表 token。
3. 网页与手表通过该账号的 mailbox 交换快照和事件。

迁移必须保持：

- 手表 token 只能访问 mailbox 路由，不能获得网页会话或管理权限。
- 配对码一次性、短时有效、按账号隔离。
- 快照、事件、确认、box 读写协议与 `docs/ZEPP_OS.md` 和 `watch-zepp/` 客户端一致。
- `watch-<uid>.json` 的格式、权限和清理规则不变。
- `logout/all`、禁用、删除账户使手表 token 失效。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/watch/pair` | 网页生成手表配对码 |
| `POST` | `/api/watch/redeem` | 手表兑换配对码 |
| `GET` | `/api/watch/links` | 列出手表链接 |
| `POST` | `/api/watch/unlink` | 解除手表链接 |
| `PUT` | `/api/watch/snapshot` | 网页写入最新快照 |
| `GET` | `/api/watch/events` | 手表拉取事件 / 心跳 |
| `POST` | `/api/watch/ack` | 手表确认事件 |
| `GET` | `/api/watch/box` | 读取 mailbox |
| `POST` | `/api/watch/box` | 写入 mailbox |

## 3. 现状与兼容点

### 3.1 配对

- `POST /api/watch/pair`：
  - 需要网页会话；旧入口只要求会话，不要求 `proveOwner`。
  - 生成一次性 code，默认 10 分钟有效，存内存 Map；按 uid 隔离；新 code 替换该账户旧 code。
  - 返回 code / 过期信息；审计。
- `POST /api/watch/redeem`：
  - 手表提交 code；校验、消费、签发 `ogw_...` 手表 token。
  - token 哈希存储；不产生网页会话。
  - 账户必须存在、未禁用。
- 配对码过期 / 已消费 / 跨账号拒绝；错误码与手表客户端兼容。

### 3.2 链接

- `GET /api/watch/links`：网页会话；返回该账号的手表链接（不返回 token 明文）。
- `POST /api/watch/unlink`：网页会话；按 `id` 删除指定手表链接；该链接 token 立即失效。
- 手表邮箱、链接 id、创建时间、最后活动时间按旧字段。
- 一个账号最多 5 个手表链接（`WATCH_LINKS_MAX`）；超过时淘汰最久未活动的链接；90 天未活动的链接会被清理。

### 3.3 快照 / 事件

- `PUT /api/watch/snapshot`：网页会话；写入最新训练快照到 `watch-<uid>.json`；没有手表链接时返回 `409 no-watch`。
- `GET /api/watch/events`：网页会话；返回待处理事件、`paired` 数量和 `seen` 时间，供页面侧消费。
- `POST /api/watch/ack`：网页会话；确认页面已读事件，删除已确认事件。
- `GET/POST /api/watch/box`：手表 token；读取快照 / 写入手表事件。手表 token 只打开这两个 box 路由，不打开 events / ack。
- 快照上限 64 KB；单事件上限 4 KB；每次最多 50 个事件；队列上限 500；事件超过 14 天丢弃。规则复用 `watch-relay.js`。
- 手表 token 只匹配 mailbox 路由；不能访问 `/api/data`、`/api/me` 等。

### 3.4 文件

- `watch-<uid>.json`：快照、链接、事件队列、box；重写整个文件。
- 0600 权限；原子写入。
- 账户删除删除该文件；`logout/all` 使链接失效（按旧规则）。
- 文件损坏时按旧逻辑处理（空 box / 重建，不 500）。

## 4. 执行步骤

### 4.1 WatchService

- [ ] 新增 `api/src/watch/watch.service.ts`，包装 [watch-relay.js](../../../api/watch-relay.js)：
  - `createPairCode(uid)`、`redeem(code)`、`links(uid)`、`unlink(uid, id)`。
  - `writeSnapshot(uid, body)`、`events(uid, token, query)`、`ack(uid, token, body)`。
  - `readBox(uid)`、`writeBox(uid, body)`。
  - `findLink(token)`、`touchLink(link)`、`dropLinks(uid)`、`dropCodes(uid)`。
- [ ] code / token 只存哈希；不记录明文。
- [ ] 链接查找校验账户未禁用、`sv` 有效；`logout/all` 后旧链接失效。
- [ ] 文件读写走 `atomicWrite` 和 0600；损坏时按旧逻辑恢复。
- [ ] 10 分钟 code 清理计时器由 17 启动。

### 4.2 网页 Controller

- [ ] `WatchController` 的网页路由要求会话：
  - `pair`、`links`、`unlink`、`snapshot`、`events`、`ack`。
  - 按 05 的 CSRF / 权限规则。
- [ ] `pair` 只要求会话，不要求 `proveOwner`；按旧入口。
- [ ] `snapshot` 只写当前账号的 mailbox；没有手表链接时返回 `409 no-watch`。
- [ ] `unlink` 删除指定链接；写审计。

### 4.3 手表 Controller

- [ ] `redeem`、`box`（GET / POST）使用手表 Bearer，不走网页 SessionGuard。
- [ ] `box` 的超时、返回结构、空结果与旧协议一致；`redeem` 成功后返回 token、链接 id、账号名。
- [ ] 手表 token 不能访问网页路由（包括 `events` / `ack`）；用负向测试固定。
- [ ] `redeem` 走 CSRF 豁免 / 限流；成功后返回 token 和账号信息（按旧结构）。

### 4.4 清理与联动

- [ ] `logout/all` 调用 `WatchService.dropLinks(uid)` / 使链接失效。
- [ ] 禁用 / 删除账户调用 `dropLinks` / `dropCodes`，删除 `watch-<uid>.json`。
- [ ] 账户删除复用 07 / 08 的清理流程。
- [ ] 在线态 / 配对码清理不替代手表链接清理。

### 4.5 客户端兼容

- [ ] 对照 `docs/ZEPP_OS.md` 和 `watch-zepp/` 的请求 / 响应字段。
- [ ] 手表 App 用旧协议连接 Nest 入口，完成配对、快照、事件、确认。
- [ ] 旧手表 token 在升级后继续可用（按设计兼容基线）。

## 5. 测试

### 5.1 现有测试

- `server-watch-relay.test.js`：配对、兑换、mailbox、链接、权限、注销。
- `watch-relay.test.js`：纯模块行为、事件队列、过期。
- `server-pairing.test.js`：网页配对与 `logout/all` 联动。
- `server-account-delete.test.js`：手表文件清理。
- `server-token-refresh.test.js`：会话版本与手表链接。

### 5.2 新增测试

- [ ] 网页生成 code → 手表兑换 → 手表 token 读写 box / 事件。
- [ ] code 一次性、10 分钟过期、跨账号拒绝。
- [ ] 网页快照写入后手表能读到；手表事件网页能读到；ack 后删除。
- [ ] 手表 token 不能访问 `/api/me`、`/api/data`、`/api/watch/events`、`/api/watch/ack` 或管理接口。
- [ ] `logout/all`、禁用、删除后手表 token 失效。
- [ ] `unlink` 只删除指定链接，其他手表不受影响。
- [ ] `watch-<uid>.json` 权限 0600，损坏时按旧逻辑恢复。
- [ ] mailbox 内容 / 大小限制；事件队列有界。
- [ ] 多账号隔离。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-watch-relay.test.js test/watch-relay.test.js test/server-pairing.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 9 个手表路由的协议与旧入口一致。
- [ ] 配对、兑换、快照、事件、确认、box 全流程可用。
- [ ] 手表 token 权限最小化，不能访问网页 / 管理接口。
- [ ] `logout/all`、禁用、删除后链接失效。
- [ ] `watch-<uid>.json` 格式、权限、损坏恢复一致。
- [ ] 旧 Zepp 客户端无需修改即可连接。
- [ ] A6 的手表部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 手表 token 越权访问网页接口 | 独立 Guard；负向测试；路由清单 |
| code / token 明文落盘或日志 | 只存哈希；审计脱敏 |
| 事件队列无界 / 重复确认 | 复用旧队列规则；有界测试 |
| 注销后手表仍可读 | `logout/all` 使链接失效；A6 |
| 文件损坏导致 500 | 旧恢复逻辑；损坏文件测试 |

## 8. 验收记录

```text
状态：待执行
代码版本：
配对 / mailbox / 注销验收：
旧 Zepp 客户端证据：
遗留问题：
```
