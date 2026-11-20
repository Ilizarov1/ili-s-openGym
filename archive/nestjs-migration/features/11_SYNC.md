# 11 · 训练同步

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 2（账户、认证、审计、在线态和同步）
- 依赖：[03 持久化](03_PERSISTENCE.md)、[05 会话与访问控制](05_SESSION_AND_ACCESS.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §4
- 代码落点：`api/src/sync/`
- 自有路由：3
- 状态：待执行

## 1. 背景与目标

训练同步是客户端最敏感的数据路径：RN 离线记账、Web 编辑计划、MCP 写入和备份恢复最终都落到 `PUT /api/data`。迁移必须保持：

- 同一账号的并发条件写入只有一个成功，另一个看到最新状态并返回 `409`。
- 版本缓存写入后立即失效，`GET /api/data/rev` 能看到同大小快速写入。
- `stampPut` 的删除记录、重置标记、历史更新、未知字段保留和 `_wid/_wids` 语义不变。
- 损坏状态文件返回 `503`，不能被当成空档案覆盖。
- 写入成功后登记媒体引用、入队集成事件；失败只记录，不回滚已提交的训练。
- 旧客户端（无 `baseRev`、`stamped`、备份替换）仍可工作。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/data` | 返回 `{ state, rev }`，客户端过滤 |
| `GET` | `/api/data/rev` | 轻量 `{ rev, wid? }` |
| `PUT` | `/api/data` | 条件写入、合并、原子保存 |

## 3. 现状与兼容点

### 3.1 读取

- `GET /api/data`：
  - `readStateStrict(uid)`；文件不可读 / JSON 损坏 → `503`。
  - 返回 `forClient(state)`，过滤 `_unstamped`、`_prior`。
  - 更新 `lastPull`（最多每 10 分钟写一次账户库）。
- `GET /api/data/rev`：
  - 走 `readStateCached`，返回 `{ rev: state._rev, wid?: state._wid }`。
  - 文件不存在时返回空状态 / `rev` 按旧行为。
  - 同大小、同 mtime 的快速写入必须靠 `PUT` 后的显式缓存失效看到。
- 版本缓存有界（最多 64 个）、有有效期（默认 10 分钟）；不能无界增长。

### 3.2 写入

请求体：`{ state, baseRev?, baseWid? }`。

顺序：

1. 认证主体定位 profile；拒绝 body 中的 uid。
2. 读取请求体；校验外壳（`state` 是对象；`workouts` / `routines` 等旧入口要求的字段）。
3. 进入同步临界区：**不包含 `await`**。
   - `readStateStrict(uid)`；不可读 → `503`。
   - 比较 `baseRev` / `baseWid`。
   - `stampPut` 合并。
   - 原子写入。
4. 退出临界区后使缓存失效。
5. 登记媒体引用、入队集成事件；失败只记录。
6. 返回旧回执结构。

### 3.3 冲突

- `baseRev` 与磁盘 `_rev` 不同 → `409`，返回当前公开状态。
- `baseWid` 符合旧检查条件（相同 `rev`、不同写入 ID）→ 按旧逻辑返回 `409` 或恢复分支。
- 没有 `baseRev` 的旧客户端：备份替换语义。
- `stamped` 客户端：走合并分支。
- 写入回执的 `rev` / `wid` 与磁盘一致；`stampPut` 修正客户端档案时，磁盘可能比回执多一步，客户端下一次探测会回读。

### 3.4 `stampPut`

- 删除记录、重置标记、历史更新、遗漏字段、未知字段保留。
- `_wid` 和 `_wids`（最多 50 个祖先）。
- 进行中的训练草稿在写入时剔除。
- 不引入完整 schema 校验；只保留旧业务入口要求的字段检查。

### 3.5 提交后维护

- 媒体引用：`MediaService.noteState(uid, prev, next)`；阶段 2 可先调用现有 `media.js`。
- 集成：`IntegrationsHub.onStateWrite(uid, prev, next)`；阶段 2 可先调用现有实例。
- 两者失败只记录，不影响已提交的训练写入回执。
- 顺序：训练文件已落盘 → 缓存失效 → 媒体引用 → 集成入队。

## 4. 执行步骤

### 4.1 SyncService

- [ ] 新增 `api/src/sync/sync.service.ts`：
  - `read(uid)` / `readRev(uid)`。
  - `write(uid, body, req)`。
  - 版本缓存 / 状态缓存通过 `StateStore`，不在这里新建 Map。
- [ ] 认证用户由 Controller / Guard 注入，不接受请求体 uid。
- [ ] `read` 调用 `notePull`，但每 10 分钟最多写一次账户库。
- [ ] `readRev` 走 `StateStore.readCached`，返回 `wid` 仅当存在。

### 4.2 同步临界区

- [ ] 在 `SyncService.write` 中，读取请求体之后用一个同步函数完成：
  - `readStateStrict`。
  - 版本比较。
  - `stampPut`。
  - `atomicWrite`。
- [ ] 该函数内不得出现 `await`、`fs.promises`、网络调用或事件循环让出；保证同一进程内两个请求不会交错。
- [ ] 如果未来需要异步操作，必须引入按 uid 的互斥锁，并证明不会死锁；当前默认不做。
- [ ] 写入失败时不使缓存失效，不返回成功。

### 4.3 冲突与合并

- [ ] 直接复用 [sync-stamps.js](../../../api/sync-stamps.js) 的 `stampPut`、`mergeDeletions`、`mergeEdits`、`keepUnknown`、`DEL_LISTS`、`STAMPED_MAPS`。
- [ ] 保留 `baseRev` 缺失、`baseWid` 检查、`stamped` 分支。
- [ ] `409` 响应体返回当前公开状态和修订信息，结构由现有测试固定。
- [ ] 保留 `WID_KEEP = 50`、`_wids` 祖先列表、`_rev` 递增规则。
- [ ] 进行中的训练草稿按旧规则剔除；不要把它写进历史。
- [ ] 写单元测试覆盖：删除标记、重置、历史更新、未知字段、同 rev 不同 wid、无 baseRev 的旧客户端。

### 4.4 提交后维护

- [ ] `write` 返回前调用 `MediaService.noteState` 和 `IntegrationsHub.onStateWrite`；如果阶段 3 尚未完成，直接调用现有模块实例。
- [ ] 每个调用单独 `try/catch`，记录错误但不改变响应。
- [ ] 先完成磁盘写入，再做维护；维护失败不能回滚训练文件。
- [ ] 失败的集成事件保留在 outbox 的下次启动 / 下轮批次中（见 15）。

### 4.5 Controller

- [ ] 新增 `SyncController`：
  - `GET /api/data`、`GET /api/data/rev`、`PUT /api/data`。
  - 全部要求会话；Bearer / Cookie 都可用。
  - `PUT` 读取 JSON body，调用 `SyncService.write`。
- [ ] 使用 02 的 `BodyReader` 和响应工具；`503` / `409` 由异常或返回值映射。
- [ ] 不要在 Controller 里直接读写文件或操作 `db`。

### 4.6 客户端兼容回归

- [ ] RN：断网记录、重启、联网补传；重复补传只产生一条训练。
- [ ] Web：版本探针 + 字段级合并；离线修改计划；与 RN 并发写入。
- [ ] MCP：条件提交、写入后读回。
- [ ] 备份替换：无 `baseRev` 的旧客户端仍能替换。
- [ ] 旧服务写出的档案在 Nest 读取；Nest 写出的档案在旧服务读取。

## 5. 测试

### 5.1 现有测试

- `server-data-rev.test.js`、`server-data-rev-endpoint.test.js`、`server-data-wid.test.js`。
- `server-data-reset.test.js`。
- `server-state-read-cost.test.js`（HTTP 并发 + 缓存）。
- `server-state-cache-bounds.test.js`。
- `sync-stamps.test.js`。
- `server-db-unreadable.test.js`（损坏状态 / 账户库）。
- `rest-off-data-safety.test.js`、`small-fixes-data-safety.test.js`。
- MCP `log-workout.e2e.test.js`。

### 5.2 新增测试

- [ ] 同一档案两个并发 `PUT`：只有第一个匹配旧版本的请求成功，第二个返回 `409` 并看到当前状态。
- [ ] 成功写入后 `GET /api/data/rev` 立即可见，包括同大小快速写入。
- [ ] 损坏 `state-<uid>.json` 的 `GET` / `PUT` 返回 `503`，不覆盖文件。
- [ ] `baseWid` 相同 `rev`、不同 `wid` 的恢复分支。
- [ ] 无 `baseRev` 旧客户端、`stamped` 客户端、删除标记、未知字段。
- [ ] 进行中的训练草稿不写入历史。
- [ ] 媒体引用登记 / 集成入队失败时训练仍成功，错误被记录。
- [ ] RN 重复补传只产生一条训练；Web 与 RN 交叉写入后双方可回读。
- [ ] Nest 写出的档案可被旧服务读取并继续写入。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-data-rev.test.js test/server-data-wid.test.js test/server-data-reset.test.js test/sync-stamps.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 三个同步路由的状态码、JSON、修订号和磁盘结果与旧入口一致。
- [ ] 并发条件写入只有一个成功；`409` 返回当前公开状态。
- [ ] 同大小快速写入后修订查询立即正确。
- [ ] 损坏状态返回 `503`，不被空档案覆盖。
- [ ] `stampPut` 的删除、重置、未知字段、`_wid/_wids` 行为一致。
- [ ] 媒体 / 集成提交后维护失败不影响训练写入回执。
- [ ] RN、Web、MCP、旧服务双向读写通过。
- [ ] A2、A3 通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 临界区加入 `await` 导致并发覆盖 | 同步完成读 / 比较 / 合并 / 写；代码评审 + 并发用例 |
| 缓存未失效导致修订号滞后 | 写成功后显式 `invalidate`；同大小写入用例 |
| `stampPut` 分支被简化 | 直接复用旧模块；逐分支测试；旧客户端夹具 |
| 提交后维护失败回滚训练 | 维护单独捕获；训练回执以磁盘为准 |
| 损坏状态被当空档案 | `readStateStrict` + 503；不写空状态 |

## 8. 验收记录

```text
状态：待执行
代码版本：
并发 / 409 / 缓存验收：
RN / Web / MCP 回读证据：
遗留问题：
```
