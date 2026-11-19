# 04 · System 路由（health / config）

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 1（构建、启动和 HTTP 骨架）
- 依赖：[02 HTTP 兼容层](02_HTTP_COMPATIBILITY.md)、[03 持久化](03_PERSISTENCE.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§3
- 代码落点：`api/src/system/`
- 自有路由：2
- 状态：待执行

## 1. 背景与目标

`/api/health` 和 `/api/config` 是客户端、容器健康检查和登录页最早依赖的两个接口。它们必须：

- 在数据目录不可写时让健康检查返回 `503`，而不是“进程活着就算健康”。
- 不泄露未登录用户不该看到的 Coach / 集成配置。
- 在功能关闭时保持字段“缺席”，而不是返回 `null` 或空对象。
- 健康探针有 5 秒缓存，避免未认证请求变成磁盘写放大。

## 2. 路由清单

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/health` | 存活 + 数据目录可写探针 |
| `GET` | `/api/config` | 公开配置、已登录时的 Coach / 集成配置 |

## 3. 现状与兼容点

### 3.1 `GET /api/health`

- 成功：`200 { ok: true, users: <db.users.length>, writable: true }`。
- 失败：`503 { ok: false, writable: false }`。
- 探针：在 `DATA_DIR` 写入并删除 `.health-<pid>`；失败输出 `health: cannot write to <dir>: <message>`。
- 结果缓存 5 秒；缓存命中时即使目录刚恢复可写，也可能继续返回上一次的 `503`。
- `wget --spider` 只读状态码，所以 `503` 是容器健康检查的失败信号。

### 3.2 `GET /api/config`

公开字段：

- `invite_only`、`allow_guest`。
- `password_login`：仅 `PASSWORD_LOGIN` 开启时存在。
- `default_lang`：仅配置了默认语言时存在。
- `media`：仅媒体开启时存在；内容来自 `mediaConfig(mediaLimits)`。

仅有会话时：

- `coach`：已登录时始终存在；实例未启用或未连接 provider 时为 `null`；未登录时不存在该键。
- `integrations`：仅实例配置了集成且请求已登录时存在。

兼容要求：

- 未知字段不要增加；字段顺序不重要，但 JSON 结构必须一致。
- 会话判断使用 05 的会话服务；阶段 1 可先注入一个 `SessionReader` 接口，阶段 2 替换为真实 Guard / Service。
- 不要把 `coach` 的 provider 名称泄露给未登录用户。

## 4. 执行步骤

### 4.1 HealthService

- [ ] 在 `api/src/system/health.service.ts` 实现：
  - `dataWritable()`：5 秒缓存；写 `.health-<pid>`，成功后删除。
  - 失败记录 `health: cannot write to <DATA_DIR>: <message>`，不要输出密钥或用户数据。
  - 返回 `{ ok, writable }`，Controller 负责状态码。
- [ ] 缓存使用进程内字段，不落盘；重启后第一次请求重新探测。
- [ ] 不要在每次健康请求上写入敏感文件；探针文件为空且立即删除。

### 4.2 HealthController

- [ ] 在 `api/src/system/health.controller.ts`：
  - `@Get('health')`（全局前缀 `api` 后为 `/api/health`）。
  - `dataWritable()` 为真：`200 { ok: true, users: <count>, writable: true }`。
  - 为假：`503 { ok: false, writable: false }`。
  - 使用统一 `reply` 工具，保留 `Cache-Control: no-store`。
- [ ] 用户数从 `AccountStore` 的只读快照读取，不要在健康路由里触发 `saveDb()`。

### 4.3 ConfigService / ConfigController

- [ ] 在 `api/src/system/config.service.ts` 组装公开配置：
  - `invite_only`、`allow_guest`。
  - 条件字段：`password_login`、`default_lang`、`media`。
  - 已登录：`coach`、`integrations`。
- [ ] 在 `api/src/system/config.controller.ts`：
  - `@Get('config')`。
  - 读取会话（阶段 1 通过 `SessionReader`，阶段 2 注入真实 `SessionService`）。
  - 不读取请求体，不写数据库。
- [ ] `coach` 配置通过 `CoachConfig.publicConfig()` 获取，不要复制一份 provider / model 映射；已登录时即使返回 `null` 也保留 `coach` 键，未登录时不添加该键。
- [ ] `integrations` 通过 `IntegrationsHub.publicConfig()` 获取；未配置或返回空时 Controller 不添加该键。
- [ ] `media` 通过 `MediaService.config()` 获取；`MEDIA_UPLOADS=0` 时不添加该键。

### 4.4 模块注册

- [ ] 新增 `SystemModule`，导入 `PersistenceModule`，导出 `SystemService`（如需要）。
- [ ] `AppModule` 在阶段 1 只注册 `SystemModule`；其他 Controller 不提前注册。
- [ ] 确认全局前缀只加一次，`/api/health`、`/api/config` 没有变成 `/api/api/...`。

## 5. 测试

### 5.1 现有测试

- `server-health-writable.test.js`：
  - 可写目录返回 200 和 `writable: true`。
  - 目录改为只读后返回 503。
  - 5 秒缓存：恢复可写后下一次请求仍可能 503。
  - 日志包含 `health: cannot write to`。
- `server-config-session.test.js`：
  - 未登录时没有 `coach` / `integrations`。
  - 登录后按配置出现。
  - `PASSWORD_LOGIN` / `MEDIA_UPLOADS` 关闭时字段缺席。
- `server-cors.test.js` 中的 `/api/config` 请求仍带旧 CORS 头。

### 5.2 新增测试

- [ ] 健康探针不会在每次请求都写盘：连续请求只触发一次探针写入（可用文件 mtime 或 mock 计数）。
- [ ] `DATA_DIR` 不存在或不可写时，启动行为和健康响应符合预期。
- [ ] `default_lang`、`media`、`integrations` 的“字段缺席”与旧入口逐项比较；`coach` 在已登录且未连接时为 `null`，未登录时不存在。
- [ ] 未登录请求 `/api/config` 不触发 Coach 配置解密或 provider 调用。
- [ ] `/api/health` 在 `PORT=0` 的实际端口上可访问。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-health-writable.test.js test/server-config-session.test.js test/server-cors.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] `/api/health` 在可写 / 不可写目录下分别返回 200 / 503，JSON 与旧入口一致。
- [ ] 健康探针 5 秒缓存生效，失败日志可操作。
- [ ] `/api/config` 的公开字段与功能开关矩阵一致；未登录不泄露 Coach / 集成。
- [ ] 登录后 Coach / 集成字段按连接状态出现。
- [ ] 两个路由都处于全局前缀 `api` 下，且仍返回 `Cache-Control: no-store`。
- [ ] A5 中“数据盘不可写时健康检查 503”和“公开配置符合开关”通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 健康探针变成未认证写盘入口 | 5 秒缓存；空文件；立即删除 |
| `/api/config` 泄露 provider / 集成信息 | 只在会话存在时调用 `publicConfig()`；未登录用例 |
| 字段“缺席”被写成 `null` | 用展开条件对象，与旧入口逐项比较 |
| 全局前缀重复 | 路由矩阵断言 `/api/...`，不在 Controller 重复写 `api/` |

## 8. 验收记录

```text
状态：待执行
代码版本：
health / config 对照结果：
开关矩阵：
遗留问题：
```
