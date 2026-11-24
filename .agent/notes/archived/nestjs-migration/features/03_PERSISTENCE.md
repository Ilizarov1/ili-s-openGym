# 03 · 持久化基础设施

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 1 建立基础设施，阶段 2 接入账户库
- 依赖：[01 构建与启动](01_BUILD_AND_BOOTSTRAP.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§4
- 代码落点：`api/src/config/`、`api/src/common/persistence/`
- 自有路由：0
- 状态：待执行

## 1. 背景与目标

服务端的所有状态都在一个 `DATA_DIR` 中：`db.json`、`db.json.bak`、`secret`、`vapid.json`、`state-<uid>.json`、`watch-<uid>.json`、`audit.log`、`uploads/`、`integrations/`、Coach 文件。迁移不能改变这些文件的命名、字段、权限和写入顺序。

本功能点的目标是提供唯一的一组持久化 Provider：

- 账户库只有一个进程内实例，所有修改走同一个 `saveDb()`。
- 训练状态读取有严格模式和缓存模式；缓存有界、有有效期，写入后必须失效。
- 所有账户库和训练状态写入经过 `durable.js` 的 `atomicWrite`，保证刷盘、rename 和目录 fsync。
- 密钥、VAPID、路径和清洗规则集中管理，避免各模块各写一份。

## 2. 范围

### 2.1 包含

- `RuntimeConfig`：环境变量快照、路径、功能开关。
- `paths`：`DATA_DIR`、`stateFile`、`watchFile`、`dbFile`、`auditFile`、`uploads`、`integrations`、Coach 路径。
- `keys`：`secret`、`vapid.json` 的创建、读取和权限。
- `atomicWrite`：包装 `durable.js`。
- `AccountStore`：加载、损坏回退、保存、备份、单实例。
- `StateStore`：读取、严格读取、客户端过滤、缓存、摘要。
- 持久化 Provider 的单元测试。

### 2.2 不包含

- 账户角色、会话和配对业务；见 05–08、10。
- 同步的 `stampPut` 和 `409` 分支；见 11。
- 媒体文件的流式写入和清理；见 12。
- Coach / 集成 / 手表文件的业务语义；分别见 16、15、14。

## 3. 现状与必须保留的行为

| 数据 / 行为 | 旧实现 | 兼容要求 |
| --- | --- | --- |
| 数据目录 | `DATA = process.env.DATA_DIR || '/data'` | 不改变默认值和路径解析 |
| 密钥 | `secret` 缺失时生成 32 字节随机 hex，0600 | 已存在时只读取，不覆盖；权限失败按旧行为处理 |
| VAPID | `vapid.json` 缺失时生成 | Push 身份跨重启保持 |
| 账户库 | `loadDb` / `saveDb`，`server.js:121` | 缺失文件启动空库；损坏时旁置 `.unreadable-*` 并回退 `.bak`；两者都坏则拒绝启动 |
| 账户库备份 | 先写 `db.json`，再写 `db.json.bak` | `.bak` 是最近一次成功保存的副本，不是被替换的旧版本 |
| 账户库权限 | 0600 | 不能因为 Nest 写入而放宽 |
| 状态文件 | `state-<uid>.json`，uid 清洗 | 文件名、字段、`_rev/_wid/_wids/_ts` 全保留 |
| 状态读取 | `readState` / `readStateStrict` | 普通读取失败按旧逻辑返回 null / 空；严格读取失败返回 503 |
| 客户端过滤 | `forClient` | 过滤 `_unstamped`、`_prior`；不要把服务端内部字段发给客户端 |
| 状态缓存 | `stateCache`，最多 64 个，默认 10 分钟，mtime + size 失效 | 同大小快速写入仍要靠显式失效保证正确 |
| 摘要 / 提醒读取 | `readStateCached`、`stateSummary` | 热路径不重复解析完整文档 |
| 原子写入 | `durable.js` 的 `atomicWrite` | 临时文件、fsync、rename、目录 fsync 顺序不变 |

## 4. 执行步骤

### 4.1 RuntimeConfig

- [ ] 新增 `api/src/config/runtime-config.ts`：
  - `dataDir`：`DATA_DIR` 或 `/data`。
  - `port`、`origin`、`rpId`、`trustProxy`。
  - 功能开关：`passwordLogin`、`mediaEnabled`、`integrations`、`coachDisabled`、`inviteOnly`、`allowGuest`、`firstUserAdmin`。
  - 审计：`auditOn`、`auditMax`、`auditDays`、`auditIp`。
  - 媒体：`mediaLimits`（复用 `media.js` 的解析）和 `mediaConfig`。
  - 超时：`bodyTimeoutMs`、`requestTimeoutMs`、`headersTimeoutMs`。
  - 生成只读快照；新代码只能读快照，不再直接散读 `process.env`。
- [ ] 已有模块仍在导入时读取 `process.env`，所以 `main.ts` 不能在导入这些模块前修改环境；Config Provider 只做读取和归一化。

### 4.2 路径

- [ ] 新增 `api/src/common/persistence/paths.ts`：
  - `dbFile`、`dbBackupFile`、`secretFile`、`vapidFile`、`auditFile`。
  - `stateFile(uid)`、`watchFile(uid)`：复用 `uid.replace(/[^a-zA-Z0-9_-]/g, '')`。
  - `uploadsDir`、`uploadUserDir(uid)`、`integrationsDir`、`coachDir`。
  - `dataProbeFile(pid)` 用于健康检查。
- [ ] 所有路径从 `RuntimeConfig.dataDir` 派生；测试通过临时 `DATA_DIR` 覆盖，不写死 `/data`。

### 4.3 密钥和 VAPID

- [ ] 新增 `api/src/common/persistence/keys.ts`：
  - `ensureSecret()`：缺失时生成 `crypto.randomBytes(32).toString('hex')`，写 0600；存在时只读。
  - `loadVapid()`：缺失时按 `web-push.generateVAPIDKeys()` 生成并写 0600；存在时解析。
  - 失败时给出明确错误：不能读取密钥、不能写密钥、VAPID 格式损坏。
- [ ] 保持旧入口的启动顺序：先准备 `DATA_DIR`、`secret`，再初始化集成 / Coach / Push；任何依赖密钥的模块不得在密钥准备好之前构造。

### 4.4 原子写入

- [ ] 新增 `api/src/common/persistence/atomic-write.ts`：
  - 直接导入 `durable.js` 的 `atomicWrite`。
  - 提供 `writeJson(file, value, mode = 0o600)`，负责 `JSON.stringify`。
  - 提供 `writeText(file, text, mode)`。
- [ ] 禁止在持久化 Provider 之外直接 `fs.writeFileSync` 覆盖 `db.json`、`state-*.json` 或审计文件。
- [ ] 保留 `durable.js` 的 fsync / rename / 目录 fsync 顺序；不要用 `fs.promises` 改写这段逻辑。

### 4.5 AccountStore

- [ ] 新增 `api/src/common/persistence/account-store.ts`：
  - `load()`：与旧 `loadDb` 等价。
    - `ENOENT` → 空库 `{ users: [], creds: [], subs: [], invites: [], deviceLinks: [] }`。
    - 解析失败 → 复制为 `db.json.unreadable-<timestamp>`，记录日志，尝试 `db.json.bak`。
    - `.bak` 也失败 → 输出可操作错误并以非零码退出（由启动层处理）。
  - `save()`：先 `writeJson(dbFile, db, 0o600)`，再写 `db.json.bak`；`.bak` 失败只记录，不阻断主写入。
  - `db` 归一化：`users/creds/subs/invites/deviceLinks` 缺失时补空数组。
  - 提供只读快照或明确访问器；不要让 Controller 直接替换整个 `db` 对象。
- [ ] 保证 Provider 是单例；`AccountsModule`、`AuthModule` 等都导入同一个实例。
- [ ] `save()` 的调用点必须覆盖所有修改：注册、登录会话版本、Passkey、邀请、订阅、设备链接、角色、禁用、恢复。
- [ ] 测试中通过临时 `DATA_DIR` 构造损坏 `db.json` / `.bak`，验证回退和启动失败。

### 4.6 StateStore

- [ ] 新增 `api/src/common/persistence/state-store.ts`：
  - `read(uid)`：文件不存在或不可读按旧逻辑返回 null；不要抛到路由层。
  - `readStrict(uid)`：不可读或 JSON 损坏返回一个可识别的 `UNREADABLE` 结果，由同步 Controller 映射为 `503`。
  - `forClient(state)`：移除 `_unstamped`、`_prior`，保留客户端需要的字段。
  - `readCached(uid)`：有界 Map，记录 `mtimeMs`、`size`、`hitAt`、`state`；命中条件与旧 `stateCache` 一致。
  - `summary(uid)`：按 `mtimeMs`、`size` 缓存 `{ rev, rem, consent, settled }`，供提醒 / 年度总结使用。
  - `invalidate(uid)`：同步写入成功后调用。
- [ ] 缓存上限和有效期沿用旧实现；不要无界增长。缓存键只用清洗后的 uid。
- [ ] 缓存读取不能在每次轮询时重新解析完整文档；`GET /api/data/rev` 和提醒 tick 必须走缓存路径。
- [ ] 写入状态成功后先写盘，再 `invalidate(uid)`；失败时不要提前失效或返回成功。
- [ ] `stateFile` 的 JSON 字段原样保留，包括 `_rev`、`_wid`、`_wids`、`_ts`、删除标记和未知字段。

### 4.7 Provider 模块

- [ ] 新增 `PersistenceModule`，导出 `RuntimeConfig`、`AccountStore`、`StateStore`、`Keys`、`AtomicWrite`。
- [ ] `SystemModule`、`AuditModule`、`PresenceModule` 只通过 `PersistenceModule` 使用路径和存储，不各自拼路径。
- [ ] 提供 `PersistenceModule` 的初始化检查：`DATA_DIR` 可访问、`secret` 可读、`db` 可加载；失败在 `app.listen` 前退出。

## 5. 测试

### 5.1 单元测试

- [ ] `atomicWrite`：fsync 临时文件 → rename → fsync 目录；目标文件内容、权限正确。
- [ ] `AccountStore`：
  - 缺失 `db.json` → 空库。
  - 损坏 `db.json` + 可用 `.bak` → 回读账号并保留 `.unreadable-*`。
  - 两者都损坏 → 启动失败（断言错误信息）。
  - `save()` 写主文件和 `.bak`，主文件权限 0600。
  - 修改后重新加载能读回。
- [ ] `StateStore`：
  - 缺失文件 → null / 空。
  - 损坏文件 → 严格读取返回不可读，普通读取按旧行为。
  - 缓存命中 / 失效 / 有界 / 有效期。
  - 同大小、同 mtime 的写入必须靠 `invalidate` 立刻可见。
  - `forClient` 移除 `_unstamped` / `_prior`，保留未知字段。
- [ ] `keys`：`secret` 缺失生成 0600；已有不覆盖；VAPID 缺失生成。

### 5.2 现有测试

以下测试改为 `API_ENTRY=dist/src/main.js` 后应通过：

- `durable.test.js` 的运行时部分。
- `server-db-unreadable.test.js`。
- `server-state-cache-bounds.test.js`。
- `server-state-read-cost.test.js` 的 HTTP 并发 / 缓存部分。
- `sync-stamps.test.js`（纯函数，保持原样）。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/durable.test.js test/server-db-unreadable.test.js test/server-state-cache-bounds.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] `DATA_DIR` 的文件命名、权限、字段和写入顺序与旧入口一致。
- [ ] `db.json` 损坏时有 `.bak` 可回读，无 `.bak` 时启动失败。
- [ ] `state-<uid>.json` 损坏时严格读写返回 `503`，普通读取按旧行为。
- [ ] 状态缓存有界、有有效期，写入后下一次修订查询立即可见。
- [ ] 所有账户库、训练状态写入经过 `atomicWrite`。
- [ ] 账户库、状态缓存各只有一个实例；不出现跨模块重复 Provider。
- [ ] A3 的缓存 / 损坏数据部分可以通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 账户库在 Nest 内被多次加载，内存状态分叉 | 单例 Provider；模块 `exports`；A9 检查 |
| `db.json.bak` 写成被替换的旧版本 | 先写主文件再写 `.bak`；用旧 `saveDb` 语义测试 |
| 缓存无界或失效遗漏 | 复用旧上限 / TTL；写入后显式 `invalidate`；同大小写入用例 |
| 直接覆盖状态文件导致半文件 | 所有写入走 `atomicWrite`；禁止异步文件 API 改写同步临界区 |
| 测试读到真实 `DATA_DIR` | 所有 Provider 测试用 `mkdtemp`；不读取生产目录 |

## 8. 验收记录

```text
状态：待执行
代码版本：
单元 / HTTP 测试结果：
数据卷回读证据：
遗留问题：
```
