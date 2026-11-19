# openGym 服务端 NestJS 迁移执行方案

- 依据：[NestJS 迁移设计](./DESIGN.md)（2026-11-19 修订，设计基线 `a00970b68`）
- 当前工作区基线：`94777b4ad`，执行开始时以实际 `git rev-parse HEAD` 重新记录
- 适用代码：`api/`、`api/test/`、`.github/workflows/test.yml`、`api/Dockerfile`、Compose / Helm / Kubernetes / Nix 部署文件
- 状态：阶段 0–3 的评审修订已落地，Linux 双入口回归和 A10 信号验收待验证。阶段 4 的入口切换、镜像与升级演练以这些证据为前置。见 [ACCEPTANCE.md](./ACCEPTANCE.md)。
- 阶段 4 运行时：Nest API 的交付和发布验收统一使用 Linux / Node.js 24 LTS，取代原设计中的 Node.js 22 目标。当前配置和历史结果见 [BASELINE.md](./BASELINE.md) 与 [ACCEPTANCE.md](./ACCEPTANCE.md)。

本文把设计稿拆成可以独立提交、独立测试、独立回退的阶段。每个阶段结束时必须通过该阶段的退出条件，未通过不得进入下一阶段；生产实例只在阶段 4 完成后整体切换。

**文档结构**：第 1 节背景与兼容基线；第 2 节策略与目标结构；第 3 节阶段 0–4 执行步骤；第 4 节提交拆分；第 5 节测试；第 6 节验收目标；第 7 节风险；第 8 节切换与回滚；第 9–10 节交付物和附录。

功能点的细分执行文档见 [features/README.md](./features/README.md)。

从现有迁移工作区接续阶段 4 时，先读 [执行交接单](./HANDOFF.md) 获取固定代码版本、本机命令和回滚演练输入。

## 1. 背景

### 1.1 当前服务端

`api/` 是单进程 Node.js HTTP 服务，入口为 [server.js](../../api/server.js)，约 3,150 行、191 KB，主要事实如下：

- 路由表从 [server.js:2078](../../api/server.js#L2078) 开始，按 `'METHOD /api/path'` 字符串分派；`server.js`、`api/coach/routes.js`、`api/integrations/routes.js` 合计注册 91 个唯一路由，与 [openapi.yaml](../../api/openapi.yaml) 的 91 个 operation 一一对应。
- HTTP 监听、请求体读取、CORS / 预检、CSRF、限流、Cookie / Bearer 会话、审计、在线态、同步、媒体和后台任务都集中在入口及其闭包中；可独立复用的领域模块已有 `durable.js`、`media.js`、`sync-stamps.js`、`watch-relay.js`、`queue.js`、`password.js`、`passkeys-store.js`、`device-link.js`、`rate-limit.js`、`net-guard.js`、`admin-socket.js`、`api/coach/`、`api/integrations/` 等。
- 测试以 `node:test` 为主，共 100 个 `*.test.js` 文件；大量用例启动真实的 `server.js` 子进程，通过 `PORT=0` 和启动行 `gym-api on :<port> (rpID=..., origin=...)` 获取实际端口。
- 部署由 Compose / Nginx 组成：Nginx 只把 `/api` 和 `/api/media` 转发给 API，API 使用单一 `DATA_DIR`，`db.json`、`state-<uid>.json`、`uploads/`、`integrations/`、Coach 文件都是磁盘上的兼容基线。
- API 镜像分为 `default` 和 `coach` 两个 target；CI 会实际启动镜像，检查健康检查、Nginx 代理和 AI 运行时的取舍。

### 1.2 迁移要解决的问题

设计稿选择 NestJS 的目标是把“路由、HTTP 兼容层、认证、领域服务和后台任务”拆成明确模块，使请求处理、鉴权、持久化和生命周期不再混在同一个闭包里。迁移本身的成功标准不是引入框架，而是：

1. 对外 HTTP 契约、认证语义和错误结构不变。
2. 现有 `DATA_DIR` 文件格式、权限和单写者模型不变。
3. 现有 RN、Web、Capacitor、Zepp、MCP 和恢复 CLI 不需要改调用方式。
4. 部署、升级和回滚路径可演练、可重复。
5. 迁移后的测试能继续保护原子写入、缓存、超时、流式媒体和停机排空等非功能要求。

### 1.3 范围

- 把 `api/server.js` 的路由、请求处理、业务编排和后台任务迁移到 `api/src/` 的 NestJS 应用。
- 引入 NestJS 12.5.1、`@nestjs/platform-node` 的 `NodeAdapter`、TypeScript、ESM 和 `api/` 内的独立构建。
- 保留 `api/openapi.yaml` 作为契约来源，保留 `api/coach/core/` 供 Web / Capacitor 构建继续导入。
- 改造 API 测试、CI 路径过滤、镜像构建、Nix 打包和部署停机宽限。
- 在阶段 4 将 API 构建、镜像运行时、API / MCP 集成 CI 和 Nix API 包对齐到 Node.js 24 LTS。
- 完成一次旧版 → NestJS → 旧版的数据卷接管和回滚演练。

### 1.4 非目标

- 不修改 `/api` 的 URL、请求/响应字段、状态码和业务错误码。
- 不改变 `db.json`、`state-<uid>.json`、媒体目录、集成 outbox、Coach 文件的格式。
- 不引入数据库、ORM、消息队列、Redis、外部会话存储或多副本写入。
- 不改变 Web、RN、Capacitor、Zepp、MCP 的业务逻辑；只为本地回归入口补齐构建前置和 loopback 绑定。
- 不在迁移中增加新功能、调整推荐算法、改 UI 或改训练数据模型。
- 不把 `api/coach/core/` 移到 `api/src/`；Web 构建仍从原路径导入。

### 1.5 兼容基线

| 基线 | 要求 |
| --- | --- |
| HTTP 契约 | 91 个 `METHOD /api/...` 与 OpenAPI 一致；未知路径、错误方法、尾斜杠、`HEAD` 的行为与旧入口一致 |
| 请求体 | 5 MiB 上限；空请求体为 `{}`；仅接受 `application/json`；无效 JSON 为 `400`；不支持类型为 `415`；超限为 `413`；常规请求体时限与已授权媒体上传时限分开 |
| 会话 | 沿用数据卷中的签名密钥、`sv` 会话版本、Cookie 名、Bearer 续期、Passkey、可选密码、设备链接和配对码语义 |
| 权限 | Owner / Admin 判定、CSRF、登录限流、`TRUST_PROXY` 地址解析和敏感操作的二次确认保持旧顺序与旧结果 |
| 同步 | `GET /api/data`、`GET /api/data/rev`、`PUT /api/data` 的 `rev` / `wid`、`409`、`stampPut`、缓存失效和旧客户端分支保持一致 |
| 存储 | `db.json` / `.bak` 回退、`state-<uid>.json`、`secret`、`vapid.json`、`watch-<uid>.json`、`audit.log`、`uploads/`、`integrations/`、Coach 文件及权限不变 |
| 媒体 | `PUT/GET /api/media/{hash}` 的流式校验、哈希、临时文件、断流清理、额度、引用登记、清理宽限期和 Nginx 缓冲设置不变 |
| 部署 | 单副本、单写者；Compose / Nginx 的地址、前缀、转发头、健康检查和数据卷挂载不变 |
| 启动 | `npm start` 仍可启动；`PORT=0` 仍打印实际监听端口；启动失败仍以非零码退出 |
| 停机 | 新请求被拒绝、计时器和队列停止、在途业务排空、预算到期后回收资源；默认排空预算 8 秒，部署宽限至少 10 秒 |

### 1.6 成功标准摘要

- **G1 构建**：没有 `dist` 的干净检出可以安装、编译，并由 `api/dist/src/main.js` 启动。
- **G2 路由**：91/91 路由与 OpenAPI 一致；未知路由和错误方法的响应与旧入口一致。
- **G3 测试**：现有 100 个 API 测试文件在 Nest 入口下全部通过，或按第 5.6 节完成有等价断言替换。
- **G4 认证**：旧 Cookie、旧 Bearer、旧 Passkey 和旧设备链接在升级后继续可用。
- **G5 数据**：Nest 写出的档案可以被旧服务再次读取和同步；旧服务写出的档案可以被 Nest 读取。
- **G6 扩展**：媒体、Push、手表、集成、Coach、在线态和审计在开 / 关两种配置下均与旧入口对齐。
- **G7 部署**：`default` / `coach` 镜像从预期入口启动，Nginx 链路、健康检查和恢复 CLI 可用。
- **G8 回退**：使用数据卷副本完成旧版 → NestJS → 旧版演练，并读回 Nest 阶段产生的有效写入。

## 2. 总体策略与目标结构

### 2.1 执行策略

采用“冻结基线、平行实现、复用测试、单点切换”：

1. **冻结旧入口**。阶段 0–3 期间 `api/server.js` 保持可运行，只接受阻断性修复；它是行为对照的 oracle，不作为新功能的落点。
2. **平行实现**。Nest 应用在 `api/src/` 内按领域推进，复用已有 ESM 模块；每个领域完成后再进入下一个领域，避免一次性重写 91 个路由。
3. **复用测试**。先让现有 HTTP 测试通过 `API_ENTRY` 选择入口，再逐步把同一批用例跑到 Nest 入口；新增差异对照测试补足现有测试没有覆盖的响应头和磁盘结果。
4. **单点切换**。阶段 4 才把 `api/server.js` 改为启动编译产物的入口，并把镜像、CI、文档和部署入口一起切换；阶段 1–3 不发布生产镜像。
5. **分支与提交**。在 `feat/nestjs-api` 长分支上按阶段合并 PR；每个 PR 只包含一个可验证的领域或一层基础设施，PR 描述中写明本阶段门禁和测试命令。最终切换 PR 才合入 `main` 并发布。

不采用“旧服务与 Nest 同时接收线上流量”的方案：本项目的 `DATA_DIR` 是单写者 JSON 文件，双进程会破坏原子写入和账户库内存一致性。也不采用“一次性替换后靠回滚兜底”的方案：91 个路由和后台任务无法在一次评审中可靠验证。

### 2.2 目标目录

```text
api/
  server.js                       阶段 4 起为启动编译产物的薄入口
  package.json                    唯一依赖与锁文件
  tsconfig.json
  tsconfig.build.json
  .dockerignore
  scripts/
    build-api.mjs                 清理 dist、编译、复制运行期资源、校验产物
    test-nest.mjs                 以 API_ENTRY=dist/src/main.js 运行 node:test
  src/
    main.ts                       NodeAdapter、关闭全局 body parser、监听、启动行
    app.module.ts                 组合模块与生命周期协调器
    config/                       环境变量快照、功能开关、路径
    common/
      http/                       请求钩子、响应工具、错误过滤器、请求体读取、超时
      auth/                       SessionGuard、AdminGuard、OwnerGuard、CSRF、限流
      persistence/                账户库、状态文件、密钥、原子写入、缓存
    system/                       /api/health、/api/config
    audit/                        AuditService
    presence/                     PresenceService
    auth/                         会话、Passkey、密码、设备链接、配对
    accounts/                     账户、邀请、角色、审计查询、活动心跳、恢复
    sync/                         GET/PUT /api/data、/api/data/rev
    media/                        媒体流、额度、引用、清理
    notifications/                Push、提醒、年度总结、nudge-check
    watch/                        Zepp 配对、快照、事件队列
    integrations/                 Webhook 配置、事件入队、持久 outbox
    coach/                        Coach 路由、任务、调度、warmup、提案通知
    lifecycle/                    启动顺序、停止门禁、排空和资源回收
  test/
    helpers.mjs                   API_ENTRY、boundPort、tempData 等共享工具
    nest/                         差异对照、路由矩阵、验收场景
  coach/                          继续供 Web / Capacitor 导入，构建时复制进 dist
  integrations/                   构建时复制进 dist
  dist/                           构建产物，不提交
    src/main.js
    durable.js
    media.js
    coach/
    integrations/
```

### 2.3 模块与依赖

模块职责沿用设计稿第 2 节，执行时遵守以下所有权：

| 模块 | 导出的共享 Provider / Service | 导入方向 |
| --- | --- | --- |
| `PersistenceModule` | 账户库、状态存储、密钥、原子写入、版本缓存 | 被所有需要磁盘的模块导入 |
| `SystemModule` | 健康探针、公开配置 | 只依赖 Persistence |
| `AuditModule` | `AuditService` | 只依赖 Persistence；不导入 Auth / Accounts |
| `PresenceModule` | `PresenceService` | 只维护内存状态；不导入 Auth / Accounts |
| `AuthModule` | 会话、角色判定、Guard | 导入 Persistence / Audit / Presence |
| `AccountsModule` | 账户管理、配对、活动心跳、审计查询、账户删除 | 导入 Auth / Persistence / Audit / Presence，并调用 Media / Watch / Integrations / Coach / Notifications 导出的账户清理接口 |
| `SyncModule` | 训练状态读写 | 导入 Auth / Persistence / Media / Integrations |
| `MediaModule` | 媒体存储和清理 | 导入 Auth / Persistence |
| `NotificationsModule` | Push、提醒、年度总结 | 导入 Auth / Persistence / Presence |
| `WatchModule` | 手表配对和事件队列 | 导入 Auth / Persistence |
| `IntegrationsModule` | 连接、outbox、投递 | 导入 Persistence；由 Sync 调用入队 |
| `CoachModule` | Coach 路由、任务、调度 | 导入 Auth / Persistence；提案通知由 `AppModule` 的生命周期协调器连接到 `NotificationsService` |

账户库、训练状态缓存、审计序号和在线态各只能有一个进程内实例。禁止在多个模块的 `providers` 中重复声明同一个有状态服务；共享实例通过模块 `exports` 提供，必要时使用 `forwardRef` 的地方必须先证明不存在更单向的拆分方式。

### 2.4 关键实现约定

1. **HTTP 适配器**。使用 `NodeAdapter`，不引入 Express；创建应用时关闭全局 body parser，由 `BodyReader` 在需要的路由上读取。
2. **请求钩子**。在路由匹配前用 `NodeAdapter.setOnRequestHook` 完成 CORS 反射、`OPTIONS 204`、原始请求目标校验、尾斜杠 / `HEAD` 回退的显式处理，保证 `/api/media/{hash}` 只匹配小写 SHA-256。
3. **响应写法**。登录、配对、媒体等需要精确控制头部的路由注入原始 `req` / `res`，通过统一 `reply` 工具写状态码、`Content-Type`、`Cache-Control: no-store`、多条 `Set-Cookie` 和媒体安全头；简单只读路由可以使用 Nest 返回值，但必须经过统一拦截器补齐头部。
4. **错误映射**。全局异常过滤器把业务 `HttpError`、`MediaError`、`BusyError` 映射为旧 JSON；`clientGone` 只记一行日志；未识别异常仍是 `500 { error: 'server error' }`；未知路由和错误方法统一为 `{ error: 'not found' }`。
5. **访问策略顺序**。已匹配路由按“CSRF → 入口限流 → 路由权限”执行；Guard 只负责拒绝并抛出异常，审计写入仍由业务服务完成，避免 401 管理探测产生 `admin.denied`。
6. **同步临界区**。`PUT /api/data` 在读取请求体后，用一个不包含 `await` 的同步段完成读盘、比较、合并、原子写入；不要在这段里使用异步文件 API。版本缓存只在成功写入后失效。
7. **生命周期**。`onApplicationBootstrap` 只做初始化；`app.listen()` 成功后由 `LifecycleCoordinator` 统一启动提醒、队列、Coach、媒体清理、在线态和审计计时器。关闭时先设置 `closing`，再排空，再关 socket；`onModuleDestroy` 等待同一个关闭 Promise。
8. **配置读取**。新代码通过 `RuntimeConfig` 读取环境变量并生成快照；已有模块仍在导入时读取 `process.env`，所以入口不得在导入这些模块前修改环境。不要在模块加载时启动计时器。
9. **日志兼容**。保留启动行 `gym-api on :<port> (rpID=..., origin=...)`、健康探针的 `health: cannot write to ...`、媒体清理的 `media noteState` 等测试或运维依赖的文本；Nest 自身启动日志只保留必要错误。
10. **构建产物**。`dist/src/main.js` 通过相对路径引用 `dist/*.js`、`dist/coach/`、`dist/integrations/`；构建脚本负责复制这些资源，运行镜像不依赖源码树。

## 3. 执行步骤

执行顺序为阶段 0 → 1 → 2 → 3 → 4。阶段 0–3 在 `feat/nestjs-api` 分支完成，阶段 4 的切换 PR 合入 `main` 后发布。

每个阶段的完成情况同步到 [features/README.md](./features/README.md) 对应文档的状态块；设计决策变化先更新 [DESIGN.md](./DESIGN.md)，再更新本文件和受影响的 features 文档，避免三处口径漂移。

### 阶段 0 · 基线、测试入口和对照夹具

**目标**：在不改变生产代码行为的前提下，建立可重复的旧服务基线、可切换入口的测试工具和差异对照夹具。

#### 0.1 记录部署与代码基线

- [ ] 在仓库根目录记录 `git rev-parse HEAD`、当前分支、Node / npm 版本和 `api/package-lock.json` 的 hash。
- [ ] 记录目标自托管实例的镜像 tag / digest、Compose 项目名、`DATA_DIR` 路径、`ORIGIN`、`RP_ID`、`BASE_PATH`、`TRUST_PROXY`、`INTEGRATIONS`、`COACH_DISABLED`、`MEDIA_UPLOADS`、`PASSWORD_LOGIN`、`AUDIT_*` 和 `/coach-auth` 挂载情况；写入 `docs/nestjs-migration/BASELINE.md`，不要把真实密钥写入仓库。
- [ ] 备份一份脱敏后的数据卷结构用于演练：`db.json`、`db.json.bak`、`secret`、`vapid.json`、`state-<uid>.json`、`watch-<uid>.json`、`audit.log`、`uploads/`、`integrations/`、Coach 文件。真实用户数据只放在本机临时目录。
- [ ] 记录当前 `api/` 的测试数量、通过率和耗时：`Set-Location api; npm.cmd ci --omit=optional; npm.cmd test`。
- [ ] 记录 91 个路由的 `METHOD /api/path` 清单，作为后续路由矩阵测试的初始快照。

**产出**：基线记录、脱敏数据卷副本、旧测试全绿记录。

#### 0.2 让现有测试可以选择入口

- [ ] 在 [api/test/helpers.mjs](../../api/test/helpers.mjs) 增加 `export const API_ENTRY = process.env.API_ENTRY || 'server.js';`。
- [ ] 把 `api/test/*.test.js` 中所有 `spawn(process.execPath, ['server.js'], ...)` 改为使用 `API_ENTRY`；带 `--import ./test/fake-clock.mjs` 的用例改为 `['--import', './test/fake-clock.mjs', API_ENTRY]`。
- [ ] 保留每个测试自己的 `startServer` / `start` 函数和清理逻辑，不做大规模重构；本步只替换入口字面量，降低测试本身引入回归的风险。
- [ ] 增加 `api/scripts/test-nest.mjs`：用 `API_ENTRY=dist/src/main.js` 启动 `node --test`，默认同时运行 `test/*.test.js` 与 `test/nest/*.test.js`；用 `fs` 列出文件，避免 Windows 不展开通配符，并把额外参数透传给测试运行器。
- [ ] 在 `api/package.json` 增加 `"test:nest": "node scripts/test-nest.mjs"`；`"test"` 保持旧行为。
- [ ] 分别在 `API_ENTRY` 未设置和设置为 `server.js` 的情况下运行全量测试，确认替换没有行为差异。

**验证**：

```powershell
Set-Location api
npm.cmd ci --omit=optional
npm.cmd test
$env:API_ENTRY = 'server.js'
npm.cmd test
Remove-Item Env:API_ENTRY
```

**产出**：入口可切换的测试基线；后续所有 Nest 测试复用同一套用例。

#### 0.3 建立差异对照工具

- [ ] 新增 `api/test/nest/parity.mjs`，提供：
  - `seedData(dir, scenario)`：按场景生成独立 `DATA_DIR`，至少包含一个 Owner、一个 Admin、一个普通成员、一个禁用成员、Passkey、Push 订阅、邀请、`state-*` 和媒体引用。
  - `startBoth(scenario)`：用同一份种子分别启动固定的 `server.js` 和 `dist/src/main.js`，返回两个实际入口标识、地址、进程和数据目录。旧侧独立于 `API_ENTRY`。切换前保存旧制品 digest 和对照结果。
  - `normalizeResponse(res)`：按规则处理 `Date`、`Set-Cookie` 的值、随机 token、`now`、`ts`、`audit id`、`_wid` 等易变字段；不忽略状态码、业务错误码、关键响应头和 JSON 结构。
  - `compareJson(a, b)` 与 `compareDisk(aDir, bDir)`：对最终 `db.json`、`state-*.json`、媒体目录做规范化比较。
- [ ] 新增 `api/test/nest/smoke.test.js`：先让旧入口与旧入口自身对照，验证夹具、端口获取、清理和规范化逻辑可靠；此步不依赖 Nest。
- [ ] 把差异对照场景按领域拆分文件：`auth.test.js`、`sync.test.js`、`media.test.js`、`extensions.test.js`，每个场景只覆盖一组状态码和磁盘结果。
- [ ] 在 `.gitignore` 增加 `api/dist/`，避免构建产物进入提交。

**验证**：`node --test test/nest/smoke.test.js` 在旧入口下稳定通过；重复运行不会留下临时目录。

#### 0.4 建立场景与配置矩阵

- [ ] 定义至少以下配置矩阵，后续每个阶段按需扩展：
  - 默认：`INVITE_ONLY=0`、`PASSWORD_LOGIN=1`、`MEDIA_UPLOADS=1`、`INTEGRATIONS=webhook`、`COACH_DISABLED=0`。
  - 精简：`PASSWORD_LOGIN=0`、`MEDIA_UPLOADS=0`、`INTEGRATIONS=''`、`COACH_DISABLED=1`。
  - 审计：`AUDIT_LOG=1`、`AUDIT_IP=net`、`AUDIT_MAX` / `AUDIT_DAYS` 取小值，便于在测试中观察轮转。
  - 代理：`TRUST_PROXY=0` / `1`，配合不同 `X-Forwarded-For` / `CF-Connecting-IP`。
- [ ] 为每个矩阵准备最小种子数据，不在测试中读取真实 `DATA_DIR`。
- [ ] 记录当前 `/api/config` 在每种矩阵下的公开字段，作为后续对照的 golden 值。

**阶段 0 退出条件**：

- 旧入口全量测试通过，测试入口替换没有改变结果。
- 差异对照工具能在旧入口上自洽运行。
- 已记录代码、部署、数据卷和配置基线。
- 生产代码除测试工具的 `API_ENTRY` 外没有改动。

### 阶段 1 · 构建、启动和 HTTP 骨架

**目标**：让 Nest 入口在干净检出中可编译、可启动，并先对齐健康检查、公开配置、CORS、预检、请求目标校验、请求体错误和 404 等不涉及账户数据的 HTTP 行为。

#### 1.1 引入 Nest 依赖和构建

- [ ] 先验证 NestJS 12.5.1 及其 peer 依赖在 npm 可用；不可用时停止并更新设计基线，不要静默换版本。
- [ ] 在 `api/package.json` 增加运行时依赖，版本按同一 Nest 基线精确锁定：
  - `@nestjs/common@12.5.1`
  - `@nestjs/core@12.5.1`
  - `@nestjs/platform-node@12.5.1`
  - `reflect-metadata`、`rxjs`（以 Nest 12 的 peer 范围为准确认后锁定）
- [ ] 增加开发依赖：`typescript`、`@types/node`。不要引入 `@nestjs/cli`、SWC、Webpack 或额外的 dotenv 包；构建由 `tsc` 加显式复制脚本完成。阶段 4 将 `@types/node` 对齐到 24.x，并在 Linux / Node.js 24 环境更新、验证 `api/package-lock.json`。
- [ ] 新增 `api/tsconfig.json`：
  - `module` / `moduleResolution` 使用 `NodeNext`。保留 `target: "ES2022"` 和 `lib: ["ES2023"]`，在 Node.js 24 上验证编译产物。
  - 打开 `experimentalDecorators`、`emitDecoratorMetadata`、`strict`、`noEmitOnError`。
  - `rootDir: "."`、`outDir: "dist"`、`allowJs: true`、`checkJs: false`，只把 `src/**/*.ts` 作为入口编译，运行期 JS 由构建脚本复制。
  - 排除 `node_modules`、`dist`、`test`、`scripts`。
  - 所有 TS 相对导入写 `.js` 后缀（NodeNext / ESM），不使用路径别名或 bundler 解析；导入现有 JS 模块时保持相对路径。
- [ ] 新增 `api/tsconfig.build.json`，继承基础配置并禁止声明文件 / sourcemap 以外的额外产物，保证输出路径固定为 `api/dist/src/main.js`。
- [ ] 新增 `api/scripts/build-api.mjs`：
  1. 删除 `api/dist`。
  2. 执行 `tsc -p tsconfig.build.json`。
  3. 复制根级运行期 `*.js`（`server.js` 除外，阶段 4 的入口由源码直接使用）、`coach/`、`integrations/`、`*.mjs` 和运行期需要的非 JS 资源。
  4. 校验 `dist/src/main.js`、`dist/durable.js`、`dist/media.js`、`dist/coach/fixture-cli.mjs`、`dist/integrations/index.js` 存在，缺一即失败。
- [ ] 在 `api/package.json` 增加：
  - `"build": "node scripts/build-api.mjs"`
  - `"start:nest": "node dist/src/main.js"`
  - 保留 `"start": "node server.js"`，直到阶段 4。
- [ ] 新增 `api/.dockerignore`，至少排除 `node_modules`、`dist`、`test`、`coverage`、`*.log`，避免多阶段构建把开发产物带进上下文。

**验证**：

```powershell
Set-Location api
npm.cmd install --package-lock-only
npm.cmd ci --omit=optional
npm.cmd run build
Test-Path .\dist\src\main.js
```

在没有 `api/dist` 的干净检出中重复一次。

#### 1.2 建立 Nest 启动入口

- [ ] 先用一个最小 Controller 验证 `NodeAdapter.setOnRequestHook` 的实际行为（`OPTIONS`、非法目标、尾斜杠、`HEAD`）；与设计不一致时先更新 02，再继续业务迁移。
- [ ] 新增 `api/src/main.ts`：
  - 首先导入 `reflect-metadata`。
  - 创建 `NodeAdapter`，在 `NestFactory.create(AppModule, adapter, { bodyParser: false })` 前安装请求钩子。
  - 使用 `app.setGlobalPrefix('api')`；Controller 只声明相对路径（例如 `@Controller('data')`），路由矩阵和 OpenAPI 校验统一加 `/api` 前缀。不要同时在 Controller 路径里重复写 `api/`。
  - 在 `listen` 前设置 `httpServer.requestTimeout = 30 * 60000`、`headersTimeout = 60000`，保留旧入口对慢上传和其他请求的区别。
  - `await app.listen(PORT)` 后读取 `app.getHttpServer().address().port`，打印与旧入口完全一致的启动行。
  - 启动失败时关闭已取得的资源并以非零码退出；不要让未处理的 Promise 静默退出。
- [ ] 新增 `api/src/app.module.ts` 和 `config/`、`common/` 的空模块，先只注册 `SystemModule`；不要为了占位注册未实现的路由。
- [ ] 确认 `PORT=0` 时输出实际端口；确认 `app.close()` 可以让进程退出。
- [ ] 确认 `dist/src/main.js` 的导入路径只落在 `dist/` 内，不引用 `api/src` 或 `api/server.js`。

**验证**：

```powershell
$env:PORT = '0'
$env:DATA_DIR = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('gym-nest-' + [guid]::NewGuid()))).FullName
node .\dist\src\main.js
```

另起终端读取启动行并用 `curl.exe` 请求 `/api/health`。

#### 1.3 请求钩子、CORS 和预检

- [ ] 在 `src/common/http/request-hook.ts` 实现与 [server.js:3032](../../api/server.js#L3032) 等价的钩子：
  - 原始 `Origin` 存在时反射 `Access-Control-Allow-Origin` 并设置 `Vary: Origin`。
  - `OPTIONS` 一律返回 `204`，带旧的 `Access-Control-Allow-Methods`、`Access-Control-Allow-Headers` 和 `Access-Control-Max-Age`。
  - 仅当来源属于 `https://localhost`、`capacitor://localhost`、`http://localhost` 且请求声明私网访问时，返回 `Access-Control-Allow-Private-Network: true`。
  - 原始请求目标无法解析、或 URL 解析后的 path 与发送的 path 不一致时返回 `400 { error: 'bad request' }`。
  - 显式处理尾斜杠和 `HEAD`：旧入口的行为是精确匹配路由表，Nest / NodeAdapter 若接受尾斜杠或把 `HEAD` 回退到 `GET`，必须在钩子里改写为旧入口的 `404` 结果。
  - `/api/media/{hash}` 只接受小写 64 位十六进制路径段。
- [ ] 保留 Cloudflare Access 请求头 `CF-Access-Client-Id` / `CF-Access-Client-Secret` 的预检允许列表。
- [ ] 为钩子写单元测试和真实子进程测试，覆盖正常路径、非法目标、预检、PNA、尾斜杠和 `HEAD`。

**验证**：`server-cors.test.js`、`server-url.test.js` 在 `API_ENTRY=dist/src/main.js` 下通过。

#### 1.4 请求体、超时和错误过滤器

- [ ] 在 `src/common/http/body-reader.ts` 移植 [server.js:817](../../api/server.js#L817) 的语义：
  - 5 MiB 上限；超限后先返回 `413`，继续读掉后续数据，超过两倍上限才销毁 socket。
  - 空请求体解析为 `{}`。
  - `Content-Type` 必须是 `application/json`（允许参数），否则 `415`。
  - 无效 JSON、`null`、数组、字符串、数字都返回 `400 invalid json`。
  - 客户端中断标记为 `clientGone`，不输出 500 堆栈。
- [ ] 在 `src/common/http/body-timeout.ts` 实现 `BODY_TIMEOUT_MS`：常规请求体默认 5 分钟；媒体上传在会话和额度检查通过后调用 `allowSlowBody()`，改用媒体自己的 60 秒空闲计时器。
- [ ] 在 `src/common/http/http-exception.filter.ts` 实现：
  - `HttpError` → 对应状态和 `{ error }`。
  - `MediaError` → 状态、`code`、`extra` 和媒体响应头。
  - `BusyError` → `503 { error: 'the server is busy, try again in a moment', code: 'busy' }` 与 `Retry-After: 2`。
  - 未知错误只记日志，返回 `500 { error: 'server error' }`。
  - 已发送头部后不再写第二个响应。
- [ ] 在 `src/common/http/reply.ts` 实现 JSON 响应：`Content-Type: application/json`、`Cache-Control: no-store`、可追加多个 `Set-Cookie` 和媒体头。
- [ ] 实现未知路由 / 错误方法的统一 404：优先使用全局异常过滤器处理 Nest 路由抛出的 `NotFoundException`，不要在每个 Controller 里重复写。

**验证**：`server-body-errors.test.js`、`server-bad-input.test.js`、`server-url.test.js` 在 Nest 入口通过；补一个 `HEAD /api/health` 和 `/api/health/` 的显式用例。

#### 1.5 持久化基础设施

- [ ] 新增 `src/config/runtime-config.ts`：集中读取 `DATA_DIR`、`PORT`、`ORIGIN`、`RP_ID`、`TRUST_PROXY`、功能开关、媒体额度、审计保留、`BODY_TIMEOUT_MS` 等；生成不可变快照，供新代码使用。
- [ ] 新增 `src/common/persistence/paths.ts`：`stateFile(uid)`、`watchFile(uid)`、`dbFile`、`auditFile`、`uploads/`、`integrations/`、Coach 路径；保留 uid 清洗规则和 0600 权限。
- [ ] 新增 `src/common/persistence/atomic-write.ts`，包装 [durable.js](../../api/durable.js) 的 `atomicWrite`；所有新代码必须通过它写入，禁止直接 `fs.writeFileSync` 覆盖账户库或训练状态。
- [ ] 新增 `src/common/persistence/keys.ts`：`secret` 缺失时生成并写入 0600，`vapid.json` 缺失时按旧逻辑生成；初始化顺序与旧入口一致。
- [ ] 新增 `src/common/persistence/state-store.ts`：`readState`、`readStateStrict`、`forClient`、`readStateCached`、`stateSummary`；保留有界缓存、有效期、mtime + size 失效和 `_unstamped` / `_prior` 过滤。
- [ ] 新增 `src/common/persistence/account-store.ts`：`loadDb` 的 `.bak` 回退、不可读时旁置副本、无备份拒绝启动；`saveDb` 先写主文件再写 `.bak`；默认空库、`users/creds/subs/invites/deviceLinks` 归一化。
- [ ] 写 Provider 单元测试：原子写入、`.bak` 回退、状态文件损坏返回 503、缓存边界、同大小快速写入。

**验证**：`durable.test.js` 的运行时部分、`server-db-unreadable.test.js`、`server-state-cache-bounds.test.js` 在 Nest 入口通过。

#### 1.6 System 路由

- [ ] 在 `src/system/` 实现 `GET /api/health`：写入并删除 `DATA_DIR/.health-<pid>`，5 秒缓存；成功 `200 { ok: true, users, writable: true }`，失败 `503 { ok: false, writable: false }`，同时输出 `health: cannot write to ...`。
- [ ] 实现 `GET /api/config`：按旧逻辑输出 `invite_only`、`allow_guest`、`password_login`（仅开启时）、`default_lang`、`media`（仅开启时）、`coach`（仅登录时）、`integrations`（仅登录且配置时）。
- [ ] 暂不实现 `/api/me`；它属于认证模块。`/api/config` 的会话判断先通过一个临时的 `SessionReader` 接口，阶段 2 替换为正式会话服务。

**验证**：`server-health-writable.test.js`、`server-config-session.test.js` 中的公开配置部分在 Nest 入口通过。

#### 1.7 把构建接入 CI

- [ ] 在 `.github/workflows/test.yml` 的 `api` 作业中，`npm ci` 后增加 `npm run build`；测试仍在源码树启动旧入口。
- [x] 在同一 Linux `api` 作业增加 Nest 测试步骤，复用安装和构建。旧入口与 Nest 各自保留 JSONL 和 JUnit 报告，任一侧失败均使作业失败。
- [x] `mcp` 作业构建后用 `API_ENTRY=dist/src/main.js` 执行集成回归。路径过滤覆盖 API 源码和构建配置。
- [ ] 在 `images` 作业的 API 构建前确保源码路径过滤包含 `api/src/**`、`api/tsconfig*.json`、`api/scripts/build-api.mjs`。

**阶段 1 退出条件**：

- NestJS 12.5.1 版本可用；`NodeAdapter` 请求钩子的实际行为已验证并记录。
- 干净检出可 `npm ci`、`npm run build`、`node dist/src/main.js` 启动。
- `/api/health` 可发现数据卷不可写。
- 已迁移路由的路径、预检、内容类型、状态码和错误结构通过 `server-cors`、`server-url`、`server-body-errors`、`server-bad-input`、`server-health-writable` 等用例。
- 旧入口仍为默认 `npm start`；镜像尚未切换。

### 阶段 2 · 账户、认证、审计、在线态和同步

**目标**：迁移所有账户与训练状态相关路由，使旧 Cookie、旧 RN Bearer、Passkey、设备链接、配对、管理接口和 `PUT /api/data` 在 Nest 入口下可用，并完成 A1、A2、A3、A8、A9 的核心验收。

#### 2.1 账户库与角色

- [ ] 完成 `AccountStore` 的进程内单实例：所有账户、凭据、订阅、邀请、设备链接读写都走同一个 Provider；所有更改调用 `saveDb()`。
- [ ] 实现 `ownerId()` / `isAdmin()` / `isOwner()`：Owner 标记、`ADMIN_UIDS` 回退、最早 admin 回退；每次实时计算，不缓存。
- [ ] 实现 `FIRST_USER_ADMIN`：空实例第一个注册用户成为 Owner；保留已有实例不追溯提升的行为。
- [ ] 实现邀请、账户删除、禁用、角色变更、Owner 交接、恢复链接的账户库写入；账户删除必须调用后续模块提供的清理接口，而不是只删 `db.users`。
- [ ] 写 Provider 测试：`.bak` 回退、空实例、Owner 判定、邀请消费、删除后凭据和会话版本处理。

#### 2.2 会话、CSRF、限流和 Guard

- [ ] 在 `src/auth/session.service.ts` 移植 `sign`、`verifySig`、`makeSession`、`readSession`、`sessionOf`、`sessionUser`：
  - HMAC-SHA256 与数据卷 `secret` 一致；payload 的 `uid:exp:sv` 格式不变。
  - Cookie 名在 HTTPS 下为 `__Host-gymsid`，否则 `gymsid`；保留旧 Cookie 清理和重复 Cookie 处理。
  - Bearer 与 Cookie 同时出现时按旧顺序取值；Bearer 必须校验签名和会话版本。
  - `/api/me` 的 Bearer 续期条件、`token` 返回和 Cookie 不续期行为不变。
- [ ] 在 `src/auth/csrf.ts` 移植 `csrfOk`：Passkey / 登录路由的豁免集合、Bearer 豁免、Origin / Sec-Fetch-Site 判断、`origin-mismatch` 响应和 `expected` 字段。
- [ ] 在 `src/auth/throttle.ts` 复用 `rate-limit.js`：`AUTH_BURST`、地址失败、账户失败、密码队列；`TRUST_PROXY` 下的 `clientIp` 与 Nginx 覆盖头规则一致。
- [ ] 实现 `SessionGuard`、`AdminGuard`、`OwnerGuard` 和 `@Public()`、`@AdminOnly()`、`@OwnerOnly()` 元数据；Guard 抛出的异常由全局过滤器转换为旧 JSON。
- [ ] 对密码设置 / 删除、Passkey 变更、账户删除、角色变更等敏感操作，在异步验证（scrypt、WebAuthn、外部调用）完成后再次确认会话和权限，沿用旧入口的二次确认行为。
- [ ] 保证未认证的管理探测返回 `401` 且不写 `admin.denied`；已认证普通用户返回 `403` 并写审计。此差异用 A9 用例固定。

#### 2.3 审计和在线态

- [ ] 在 `src/audit/audit.service.ts` 移植 [server.js:908](../../api/server.js#L908)：
  - `audit.log` 的 JSON Lines 格式、序号递增、保留期和条数上限、轮转、`AUDIT_IP=off/net/full`。
  - IP 脱敏、`auditKeep`、`compactAudit`、清空后序号不重置。
  - 审计查询 / 清空路由放在 `AccountsModule` 的 Controller / Guard 中，`AuditService` 本身不导入 Auth / Accounts。
- [ ] 在 `src/presence/presence.service.ts` 移植 [server.js:870](../../api/server.js#L870)：
  - `POST /api/activity` 更新训练名称、进度、时间；`hidden` 只记首次隐藏时间，后续心跳清除隐藏；`navigated` / `closed` / 无原因离开立即移除。
  - `getLive(uid)`：70 秒无心跳或隐藏 45 秒未恢复即不视为在线；30 秒清理计时器；读取时也做过期判断。
  - 禁用、删除、签发恢复链接时清理同一个实例；在线态不落盘。
- [ ] 让 `NotificationsModule` 的催练判断使用同一个 `PresenceService` 实例，不能新建第二个 Map。

#### 2.4 注册、登录、配对和管理接口

- [ ] 迁移 `POST /api/register/options`、`/register/verify`、`/login/options`、`/login/verify`、`/logout`、`/logout/all`：Passkey challenge 存内存、`RP_ID` / `ORIGIN` 校验、会话版本递增、审计记录。
- [ ] 迁移可选密码路由（仅 `PASSWORD_LOGIN=1` 时注册）：登录、注册、设置 / 修改 / 删除、邮箱、管理员重置、重置登录；复用 [password.js](../../api/password.js) 和 scrypt 队列。关闭时这些路由必须表现为不存在（`404`）。
- [ ] 迁移设备链接：`POST /api/account/device-link`、`POST /api/device-link/options`、`POST /api/device-link/verify`；一次性链接、哈希存储、过期和会话版本规则不变。
- [ ] 迁移配对：`POST /api/pair/create`、`POST /api/pair/redeem`、`POST /api/watch/pair`、`POST /api/watch/redeem`；配对码内存 Map、5 分钟有效期、消费后拒绝、RN 扫码 / 手动兑换都覆盖。
- [ ] 迁移账户设置：`GET/POST/DELETE /api/account/password`、`POST/DELETE /api/account/email`、Passkey 列表 / 选项 / 验证 / 重命名 / 删除、`POST /api/account/delete`。
- [ ] 迁移管理接口：`GET /api/admin/users`、`GET /api/admin/user`、恢复、禁用、删除、角色、Owner；邀请列表 / 新建 / 撤销；审计查询 / 清空；`POST /api/activity`。
- [ ] 账户删除按旧顺序清理：训练状态、Passkey、密码 / 邮箱、Push 订阅、设备链接、手表链接和邮箱、媒体目录、集成连接和 outbox、Coach 个人凭据；失败按旧规则单独记录，不回滚已完成的删除步骤。阶段 2 的媒体、Push、集成和 Coach 模块尚未迁移时，先调用现有 ESM 模块的清理函数；阶段 3 再替换为对应 Provider，接口和行为保持不变。

#### 2.5 训练同步

- [ ] 在 `src/sync/sync.controller.ts` 迁移：
  - `GET /api/data`：`readStateStrict`，损坏返回 `503`；返回 `{ state, rev }`，按 `forClient` 过滤 `_unstamped` / `_prior`。
  - `GET /api/data/rev`：`readStateCached`，返回 `{ rev, wid? }`；同大小快速写入、mtime 不变时仍以显式失效保证正确。
  - `PUT /api/data`：读取 `{ state, baseRev, baseWid }`；认证主体定位档案；同步段完成读盘、比较、合并、原子写入。
- [ ] 保留分支：
  - `baseRev` 不匹配或 `baseWid` 符合旧检查条件 → `409` + 当前公开状态。
  - 没有 `baseRev` 的旧客户端 / 备份替换语义。
  - `stamped` 客户端的合并分支、`stampPut` 的删除记录、重置标记、历史更新和遗漏字段。
  - `_wid`、`_wids`（最多 50 个祖先）、`_rev`、`_ts` 的推进规则。
  - 进行中的训练草稿在写入时剔除。
- [ ] 写入成功后使版本缓存失效，再执行媒体引用登记和集成入队；维护失败只记录，不影响已提交的训练写入回执。阶段 2 可先直接调用现有 `media.js` / `integrations` 实例，阶段 3 再替换为 Provider；两步之间的顺序和失败处理不变。
- [ ] 训练状态只校验请求外壳和旧业务入口要求的字段，不引入完整 schema 校验，避免拒绝旧客户端合法数据。

#### 2.6 测试与门禁

- [ ] 把阶段 2 涉及的现有测试通过 `API_ENTRY=dist/src/main.js` 运行：`server-passkeys`、`server-password`、`server-pairing`、`server-token-refresh`、`server-admin-state`、`server-admin-delete`、`server-account-delete`、`server-presence`、`server-data-*`、`server-db-unreadable`、`server-login-csrf`、`server-csrf-bearer`、`server-anon-flood`。
- [ ] 新增差异场景：旧 Cookie / 旧 Bearer 跨入口、过期 / 已消费配对码、`409` 后重试、`baseWid` 分支、删除标记保留、并发条件写入、损坏状态 `503`、账户库 `.bak` 回退。
- [ ] 运行 A1、A2、A3、A8、A9 的最小自动化版本；需要人工浏览器 / 模拟器的部分在阶段 4 完成完整验收。

**阶段 2 退出条件**：

- 旧服务签发的 Cookie、RN Bearer、Passkey 和设备链接可继续使用。
- RN 与 Web 交叉写入、`409` 重试、离线补传和旧数据回读达到第 6 节 A1–A3 标准。
- 在线态和审计通过 A8、A9 的自动化部分。
- 账户、认证、同步相关测试在 Nest 入口全部通过。
- `AuditModule`、`PresenceModule` 不导入 `AuthModule` / `AccountsModule`；依赖方向经代码评审确认。

### 阶段 3 · 媒体、扩展和生命周期

**目标**：迁移媒体、Push、手表、集成、Coach 和恢复 CLI，并把启动 / 停止顺序统一到生命周期协调器，完成 A4、A6、A10 的核心验收。

#### 3.1 媒体

- [ ] 在 `src/media/media.service.ts` 包装 [media.js](../../api/media.js) 的 `createMediaStore`；媒体根目录按账号拆分，额度、类型、大小、视频时长和每小时上传次数沿用旧配置。`MEDIA_UPLOADS=0` 时不注册媒体 Controller，四个媒体路由均按旧入口返回 `404`。
- [ ] 迁移 `PUT /api/media/{hash}`：
  - 先完成会话、CSRF、限流和上传额度检查，再把原始请求流交给媒体存储。
  - 流式校验哈希、文件类型和大小；先落临时文件，成功后原子替换；重复哈希按旧行为处理。
  - 调用 `allowSlowBody()`，由媒体自己的空闲计时器处理断流；断流清理和临时文件回收计入在途集合。
- [ ] 迁移 `GET /api/media/{hash}`：按账号目录授权，流式响应，保留长度、类型、`Content-Disposition`、`Cache-Control`、`nosniff`、sandbox CSP 等安全头。
- [ ] 迁移 `POST /api/media/missing`、`POST /api/media/sweep`；状态提交后登记引用，清理任务只处理满足宽限期和旧条件的未引用文件，状态不可读或清理标记异常时跳过该账号。
- [ ] 启动时处理上次进程留下的临时上传文件；每小时清理计时器由生命周期协调器启动。
- [ ] 不改 [web/nginx.conf.template](../../web/nginx.conf.template) 的媒体代理缓冲、上传限制和超时设置；在 A5 中验证。
- [ ] 账户删除调用媒体清理路径；关闭应用时保留用户媒体，不调用清除用户记录语义的 `clearUser`。

#### 3.2 通知和提醒

- [ ] 在 `src/notifications/` 迁移 Push 路由：`GET /api/push/public-key`、`POST /api/push/subscribe`、`GET /api/push/status`、`POST /api/push/unsubscribe`、`POST /api/push/test`、`POST /api/push/rest-timer`、`POST /api/push/rest-timer/cancel`。
- [ ] 复用 [push-messages.js](../../api/push-messages.js)、[queue.js](../../api/queue.js)、[nudge.js](../../api/nudge.js)、[wrapped.js](../../api/wrapped.js) 和 `web-push`；保留订阅设备过滤、VAPID 身份、消息大小限制、测试推送和组间休息计时器。
- [ ] 迁移 `GET /api/nudge-check`、训练日提醒、年度总结和催练抑制；`PresenceService.getLive(uid)` 与阶段 2 是同一个实例。
- [ ] 所有计时器在 `app.listen()` 后启动，在关闭门禁设置后停止；等待在途推送 Promise。

#### 3.3 手表

- [ ] 在 `src/watch/` 迁移 `POST /api/watch/pair`、`POST /api/watch/redeem`、`GET /api/watch/links`、`POST /api/watch/unlink`、`PUT /api/watch/snapshot`、`GET /api/watch/events`、`POST /api/watch/ack`、`GET /api/watch/box`、`POST /api/watch/box`。
- [ ] 复用 [watch-relay.js](../../api/watch-relay.js)：设备令牌哈希、邮箱、快照、事件队列、确认和过期；保留手表 Bearer 不产生网页会话的行为。
- [ ] 保留 `watch-<uid>.json` 的格式和 0600 权限；账户删除时清理手表邮箱和链接。

#### 3.4 集成

- [ ] 在 `src/integrations/` 包装 [integrations/index.js](../../api/integrations/index.js) 的 `createIntegrations`；连接配置、密文、outbox、重试、去重和失败记录复用现有模块。
- [ ] 迁移 7 个集成路由：列表、连接、更新、断开、测试、重试、日志；未启用时保持旧响应（列表为空或开关错误）。
- [ ] `SyncService` 提交训练状态后调用 `onStateWrite` 入队；账户删除调用 `dropUser`；连接断开调用 `dropConnection`。
- [ ] 扩展 `outbox.stop()`：停止后续批次调度、等待本轮投递结束；关闭时保留未完成队列和投递 ID，下次启动继续。
- [ ] 保留 `sleep` / 重试 / 退避 / 暂停连接的 `defer` 语义；不要在新代码里重放入队。

#### 3.5 Coach

- [ ] 在 `src/coach/` 迁移 18 个 Coach 路由：披露、状态、plan、review、debrief、ask、adapt、cohort、share、pending resolve、forget、admin 配置 / 测试 / 模型 / 连接 / 断开、账号。
- [ ] 复用 `api/coach/config.js`、`jobs.js`、`cadence.js`、`warmup.js`、`core/` 和 adapters；不要复制一份业务逻辑到 `src/`。
- [ ] 启动时执行 `recoverOnBoot()`，把中断任务标记为 `restart` 失败；已有提案保留可读。
- [ ] `setProposalHook` 连接到 `NotificationsService`，只在有实际变更时发推送；失败和 `nochange` 静默。
- [ ] `startCadence` 和 `startWarmup` 的计时器、首次延迟任务和周期任务句柄都由生命周期协调器保存；关闭时全部停止。
- [ ] 保留 Coach 的 `COACH_DISABLED`、未连接、无权限和文件权限行为；`coach` 用户的凭据目录和 `jobEnv` 不改。
- [ ] 继续验证 `api/coach/core/` 可被 Web / Capacitor 构建导入，`api/scripts/check-core-loadable.mjs` 通过。

#### 3.6 恢复 CLI 和本地 socket

- [ ] 启动后调用 `startAdminSocket`，把恢复命令接到 `AccountsService.issueRecovery`；Linux 下 socket 权限、目录 0700、socket 0600 不变。
- [ ] Windows 不启动 socket，保持旧行为；关闭应用时停止接收新命令，等待当前命令完成。
- [ ] 验证 `node recover.js <name>` 在运行中的 Nest 实例上返回恢复码，并写入审计。

#### 3.7 生命周期协调器

- [ ] 新增 `src/lifecycle/lifecycle.coordinator.ts`：
  - `start()`：在 `app.listen()` 成功后按固定顺序启动提醒、集成 outbox、Coach cadence / warmup、媒体清理、在线态清理和审计维护。
  - `stop()`：幂等；设置 `closing` 后请求钩子拒绝新业务请求；停止本地恢复 socket；停止所有计时器；停止 outbox 后续批次；关闭 Coach 队列门禁。
  - 跟踪在途 HTTP 业务、媒体上传及断流清理、推送、Webhook 投递和 Coach 任务；等待完成或 8 秒预算到期。
  - 预算到期后统一取消剩余请求流、provider 调用和受管理的子进程，最多再等待 1 秒清理。保留 Webhook 队列和 Coach 中断任务。响应连接结束与处理器清理分别跟踪。
  - 关闭剩余 socket 和网络资源；关闭后任何计时器、队列回调或任务回调不得重新启动调度。
- [ ] 在 Linux 注册 `SIGTERM` / `SIGINT` 停机钩子；Windows 和进程内回归通过显式 `app.close()` 进入同一路径。不要在模块里各自注册信号处理器。
- [ ] 在 `onModuleDestroy` 等待协调器的关闭 Promise；不要在多个模块的 `onModuleDestroy` 中提前关闭共享依赖。
- [ ] 给 Compose 的 `api` 服务增加 `stop_grace_period: 10s` 或更长；Kubernetes / Helm 设置 `terminationGracePeriodSeconds: 15`，确保大于 8 秒排空预算。
- [ ] 扩充 `outbox.stop()`、Coach `pump()` 门禁、warmup 句柄；关闭应用时不得调用 `clearUser`。

#### 3.8 测试与门禁

- [ ] 用 `API_ENTRY=dist/src/main.js` 运行 `server-media`、`server-push-*`、`server-reminder`、`server-nudge*`、`server-wrapped-push`、`server-watch-relay`、`server-integrations`、`coach-*`、`jobs`、`queue`、`server-recovery`。
- [ ] 增加媒体大文件 / 断流、重复哈希、跨账号读取、清理宽限期、额度、临时文件回收用例。
- [ ] 增加 Webhook 重启恢复、投递 ID 保留、连接断开和重试用例。
- [ ] 增加停机用例 A10：慢速上传、在途 Webhook、排队 Coach 任务期间关闭；验证新请求被拒绝、队列停止、训练写入可回读、超时资源被回收，重启后状态符合设计。
- [ ] 验证扩展开关关闭时路由和后台任务行为与旧入口一致；Coach 未连接、集成未配置、媒体关闭分别覆盖。

**阶段 3 退出条件**：

- 媒体流和清理通过 A4 自动化部分；两版在扩展开关开启 / 关闭场景下对齐。
- 任务重启恢复、Coach 权限、共享构建通过。
- A6 的 Coach、Push、Webhook、Zepp、MCP、恢复 CLI 自动化部分通过。
- A10 在 Linux 信号和 Windows 显式 `app.close()` 下通过，关闭后无残留调度或监听。
- 所有模块只通过共享 Provider 使用账户库、审计和在线态。

### 阶段 4 · 切换入口、制品、CI 和升级演练

**目标**：把旧入口收敛为启动编译产物的薄入口，交付 `default` / `coach` 镜像，完成 CI、文档、Nix 和部署改造，并使用数据卷副本完成升级与回滚演练。

先完成阶段 3 的 A10 并保存旧镜像 digest。在 Linux / Node.js 24 的同一份干净检出中对照旧入口和 Nest 入口，把回归差异记入验收记录，再为演练构建含薄入口的候选制品。候选制品通过 A7 后交付默认入口。Windows 本机可以用 WSL 2 的 Ubuntu，把干净检出和演练数据卷放在 Ubuntu 文件系统中。RN 回归使用 Windows 上的 Android 模拟器，确认请求发往 Nest API。

#### 4.1 切换 `api/server.js`

- [ ] 将 `api/server.js` 替换为薄入口：
  - 保留 `npm start` 的调用方式。
  - 动态 `import('./dist/src/main.js')`，让启动行、`PORT=0`、错误退出和信号处理都由 Nest 入口负责。
  - 不在入口里再读取环境变量或启动任何计时器。
- [ ] 确认 `node server.js`、`npm start`、`node dist/src/main.js` 三种方式启动结果一致；`PORT=0` 时都打印实际端口。
- [ ] 更新 `mobile-rn/scripts/loopback-api.mjs`：
  - 继续 monkeypatch `http.Server.prototype.listen`，显式绑定 `127.0.0.1`，兼容 Nest 可能传入的 `(port, host, callback)` 形式。
  - 保留 `Connection: close` 的断网回归行为。
  - 如 Nest 入口有独立环境变量，默认仍指向最终 `api/server.js`，不改变调用方。
- [ ] 更新 `mcp/test/log-workout.e2e.test.js` 的启动入口说明；如需 `API_ENTRY`，默认仍为 `server.js`。
- [ ] 删除旧 `server.js` 中的路由表、请求处理、闭包和后台启动代码；确认没有业务逻辑只存在于旧入口。

#### 4.2 改写源码断言和路由契约测试

- [ ] 先做元数据探针，确认 `ModulesContainer` / `PATH_METADATA` / `METHOD_METADATA` 在测试进程可用；不可用时退回显式路由清单，但仍与 OpenAPI 双向比较。
- [ ] 把 `openapi-routes.test.js` 改为读取 Nest Controller 的 `PATH_METADATA` / `METHOD_METADATA`，展开 Controller 前缀和方法路径，与 `openapi.yaml` 的 91 个 operation 比较；媒体 `:hash` 归一化为 `{hash}`。
- [ ] 把 `durable.test.js` 的源码断言从 `server.js` 的 `atomicWrite` 行改为断言持久化 Provider 调用 `durable.js`，保留实际的 fsync / rename 运行时测试。
- [ ] 把 `server-state-read-cost.test.js` 的源码扫描改为 Provider / Service 单元测试：`GET /api/data/rev` 走 `readStateCached`，`GET/PUT /api/data` 走 `readStateStrict`；保留并发和缓存失效的 HTTP 测试。
- [ ] 切换入口时移除 `server-media.test.js` 的旧源码断言。`test/nest/shutdown.test.js` 已从实际运行的 HTTP 服务器验证两项超时设置。
- [ ] 把 `dockerfile-copy.test.js` 改为检查 `dist` 产物树及 Dockerfile 的 `COPY`，其中工作目录里的 `recover.js` 和其相对依赖 `admin-socket.js` 都是运行期制品。
- [ ] 改写 `routes.test.js`、`e2e-apikey.test.js` 等直接调用 `coachRoutes` 的测试：改为调用 Nest Controller / Service 的测试夹具，或通过真实 HTTP 入口驱动；保留 provider 协议形状和提案落盘断言。
- [ ] 把 `test/nest/` 的差异对照转为 Nest 单入口的回归场景；旧入口不再作为 CI 的必需对照，但保留历史基线记录。

#### 4.3 镜像和制品

- [ ] 重构 `api/Dockerfile` 为多阶段：
  - API 构建和运行阶段使用同一个固定版本的 Node.js 24 Alpine 基础镜像。
  - `build` 阶段安装完整依赖（含 dev），复制源码，运行 `npm run build`。
  - `default` 运行阶段复制 `package.json`、`package-lock.json`、`server.js`、`recover.js`、`admin-socket.js` 和 `dist`，执行 `npm ci --omit=dev --omit=optional`，然后删除 npm / npx。
  - `coach` 运行阶段复制同样的产物，执行 `npm ci --omit=dev`，安装 bubblewrap 和 Codex，保留 `/coach-auth` 权限。
  - `CMD` 保持 `node server.js`；健康检查仍请求 `/api/health`；`EXPOSE` 和 `PORT` 不变。
- [ ] 确认 `dist` 包含 `coach/`、`integrations/`、`fixture-cli.mjs` 等运行期资源；`default` 不包含 Agent SDK，`coach` 包含。
- [ ] 构建并启动 `default`、`coach` 和无 target 的发布镜像。验证健康、配置、Nginx 和启动日志。在两个 target 里实际运行 `node recover.js <测试账号>`，核对 socket 和审计。
- [ ] 更新 `contrib/nix/api.nix`。构建和 `makeWrapper` 均使用 `nodejs_24`，安装 `dist`、`server.js`、`recover.js`、`admin-socket.js`、`package.json` 和运行期依赖。保留 `NODE_ENV=production`，验证包装入口的 Node 主版本和启动结果。
- [ ] 在 `.github/workflows/docker-publish.yml` 的发布路径中确认镜像 target 和构建上下文没有变化；发布 tag 仍对应同一版本。

#### 4.4 CI

- [ ] `api` 作业归档切换前的两份报告并修订依赖旧源码的用例，然后保留 Nest 全量回归和报告。
- [ ] `mcp` 作业：安装 API 依赖 → `npm run build` → 运行 MCP 集成回归；确保 `log-workout.e2e.test.js` 启动的是编译产物或最终 `server.js`。
- [ ] 将 GitHub Actions 和 GitLab CI 中运行 API 构建、API 回归与 MCP 集成回归的作业对齐到 Node.js 24。在对应作业内指定版本，避免通过共享变量同时升级独立的前端和移动端构建。
- [ ] `images` 作业：从干净检出构建 `default`、`coach` 和发布镜像；保留 AI 运行时断言、启动断言和 Nginx 链路断言。
- [ ] 更新 `.github/workflows/test.yml` 的路径过滤：
  - API 作业覆盖 `api/src/**`、`api/tsconfig*.json`、`api/scripts/build-api.mjs`、`api/package*.json`。
  - MCP 作业覆盖其集成回归依赖的 API 源码、构建配置和包文件。
  - 镜像作业覆盖 `api/src/**`、构建配置、`api/Dockerfile` 和运行期资源。
- [ ] 保持 `scripts/build-api-docs.mjs --check`、`api/scripts/check-core-loadable.mjs`、Coach 生成资源检查通过。
- [ ] 在 Linux / Node.js 24 的干净检出（没有 `dist`、没有 `node_modules`）上依次运行 `npm ci --omit=optional`、`npm run build`、`npm run test:nest`，再运行 MCP 集成与镜像验证。记录 Node / npm 版本、锁文件 hash、结果和镜像 digest。

#### 4.5 文档和部署清单

- [ ] 更新 `docs/ARCHITECTURE.md` 的服务端章节：入口、模块、构建产物、单写者和停机协议。
- [ ] 更新 `docs/API.md` 中关于实现位置的说明；`api/openapi.yaml` 仍是契约来源。
- [ ] 更新 `docs/SELF_HOSTING.md` 的构建前置、镜像升级、备份和回滚说明（如行为有变化）。
- [ ] 更新 `docs/README.md` 和 `AGENTS.md` 的文档索引，加入 NestJS 设计与执行方案。
- [ ] 在 `docs/RN_MIGRATION_STATUS.md` 或对应迁移记录中写明 API 入口变化对 RN 本地回归的影响。
- [ ] 保持 Helm / Kubernetes 的 `replicas: 1` 和 `Recreate` 策略，不因 NestJS 改为多副本；只增加停机宽限并更新说明。检查 `contrib/nix/` 的打包产物。

#### 4.6 升级和回滚演练

- [ ] 使用阶段 0 的脱敏数据卷副本，启动旧镜像，记录健康、登录、RN 拉取、媒体读取和一笔测试写入。
- [ ] 停止旧容器，复制完整 `DATA_DIR` 和部署配置，启动 Nest 镜像；验证：
  - `/api/health`、`/api/config`。
  - 旧 Cookie、旧 RN Bearer、Passkey 登录。
  - `GET /api/data`、`GET /api/data/rev`、一次测试训练写入和媒体读取。
  - MCP 直接读取新写入的档案，恢复 CLI 在 Linux 上可用。
- [ ] 在 Nest 阶段新增一笔训练和一条媒体引用，停止 Nest，切回旧镜像；验证旧服务能读取并继续写入这些数据。
- [ ] 记录停机时间、恢复时间、健康检查结果、已配对客户端结果、持久任务状态和镜像 digest。
- [ ] 按 A7 和 A11 填写演练报告；若失败，修复后重新从数据卷副本开始，不在同一份卷上反复试错。

#### 4.7 自托管实例切换

按设计稿第 8 节执行，顺序不可颠倒：

1. **记录部署输入**：镜像 tag / digest、Compose 项目、数据卷路径、`ORIGIN`、`RP_ID`、`BASE_PATH`、代理设置、功能开关、`/coach-auth` 挂载。
2. **演练**：数据卷副本 + 受控 Webhook 接收端，验证凭据、账号、档案、媒体和持久任务；锁定待部署 digest。
3. **切换**：维护窗口内让旧 API 完成在途写入并退出，备份完整 `DATA_DIR` 与配置，把同一数据卷交给 Nest 镜像；通过原域名检查健康、配置、Web 登录、已配对 RN 拉取和一次测试账号写入。
4. **回滚**：出现旧客户端鉴权、同步、写入或媒体阻断问题时，停止 Nest，用记录的旧镜像和配置接管当前数据卷；优先验证并保留切换后已提交的写入。若数据卷损坏，先保全当前卷，核对切换后写入，再按备份恢复和补录。

**阶段 4 退出条件**：

- OpenAPI 与实际 Nest 路由一致，91/91 通过。
- `default` 和 `coach` 镜像从预期入口启动，Nginx 链路和健康检查通过。
- Linux / Node.js 24 的干净检出构建、API 回归和 MCP 集成通过。RN loopback 连接 Nest API 通过，API 镜像和 Nix 包均从 Node.js 24 启动。
- A1–A11 有发布验收记录。阶段 3 提供 A10 的 Linux 信号和 Windows 显式关闭证据，阶段 4 在候选镜像与目标部署链路复核停机，对启用的扩展执行实机验收。
- 旧入口不再承载业务逻辑，回滚路径已演练。

### 阶段退出门禁汇总

| 阶段 | 必须通过 | 不得进入下一阶段的条件 |
| --- | --- | --- |
| 0 | 旧测试全绿、入口可切换、基线记录完成 | 测试工具本身改变了旧行为，或没有可重复的数据夹具 |
| 1 | 干净构建、Nest 启动、健康 / 配置 / CORS / body / 404 对齐 | 启动行、`PORT=0`、错误结构或超时行为不一致 |
| 2 | A1、A2、A3、A8、A9 自动化部分；账户 / 同步套件全绿 | 旧凭据失效、`409` 分支错误、审计或在线态出现第二实例 |
| 3 | A4、A6 自动化部分，A10 在 Linux 信号与 Windows 显式关闭下通过，扩展开 / 关对齐 | 媒体断流泄漏、队列无法停止、Coach 任务无法恢复，或缺少停机证据 |
| 4 | A1–A11 有结论，镜像恢复命令、CI、文档和回滚演练完成 | 镜像只靠源码树可启动，恢复 CLI 缺失，或回滚无法读回 Nest 写入 |

## 4. 提交拆分

建议的 PR 拆分：

| PR | 内容 | 依赖 | 主要测试 | 功能文档 |
| --- | --- | --- | --- | --- |
| PR-0 | 基线记录、`API_ENTRY`、差异夹具、配置矩阵 | 无 | 旧全量 + smoke | [18](features/18_CONTRACT_TESTS.md) |
| PR-1 | Nest 依赖、tsconfig、构建脚本、空入口 | PR-0 | 干净构建 + 启动冒烟 | [01](features/01_BUILD_AND_BOOTSTRAP.md) |
| PR-2 | 请求钩子、CORS、body、错误、持久化、System | PR-1 | CORS / URL / body / health / config | [02](features/02_HTTP_COMPATIBILITY.md)、[03](features/03_PERSISTENCE.md)、[04](features/04_SYSTEM.md) |
| PR-3 | 审计、在线态、会话、CSRF、限流、Guard | PR-2 | session / presence / audit | [05](features/05_SESSION_AND_ACCESS.md)、[09](features/09_AUDIT_AND_PRESENCE.md) |
| PR-4 | 认证、账户设置、配对、账户删除 | PR-3 | passkey / password / pairing / account-delete | [06](features/06_AUTHENTICATION.md)、[07](features/07_ACCOUNT_SETTINGS.md)、[10](features/10_PAIRING.md) |
| PR-5 | 管理接口、邀请、同步读写 | PR-4 | admin / data / rev / 409 / cache | [08](features/08_ADMIN_AND_INVITES.md)、[11](features/11_SYNC.md) |
| PR-6 | 媒体、Push、提醒、年度总结 | PR-5 | media / push / nudge / wrapped | [12](features/12_MEDIA.md)、[13](features/13_NOTIFICATIONS.md) |
| PR-7 | 手表、集成、Coach、恢复 CLI | PR-6 | watch / integrations / coach / recovery | [14](features/14_WATCH.md)、[15](features/15_INTEGRATIONS.md)、[16](features/16_COACH.md) |
| PR-8 | 生命周期、停机、部署宽限 | PR-7 | A10、句柄 / 信号 | [17](features/17_LIFECYCLE_AND_RECOVERY.md) |
| PR-9 | 入口切换、断言迁移、镜像、CI、Nix、文档 | PR-8 | 全量 + A5 / A7 / A11 | [18](features/18_CONTRACT_TESTS.md)、[19](features/19_DELIVERY_AND_ROLLBACK.md) |

## 5. 测试

### 5.1 测试分层

| 层级 | 目的 | 运行方式 |
| --- | --- | --- |
| 构建与静态检查 | 确认 ESM / 装饰器 / 产物路径 / 资源复制正确 | `npm run build`、`node --check`、`check-core-loadable`、文档生成检查 |
| 单元测试 | 保留纯函数和模块行为 | 现有 `node:test` 中不启动服务器的用例；新增 Provider / Guard / 解析器测试 |
| Provider 测试 | 账户库、状态缓存、原子写入、审计、在线态 | 独立临时 `DATA_DIR`，不启动 HTTP |
| HTTP 集成测试 | 状态码、响应头、JSON、磁盘结果 | 子进程启动 `API_ENTRY`，`PORT=0`，从启动行获取端口 |
| 差异对照测试 | 旧入口与 Nest 入口对同一场景的输出 | `test/nest/` 双进程、规范化比较 |
| 端到端部署测试 | 镜像、Nginx、MCP、RN loopback | Docker / Compose、真实 curl、MCP vitest、RN 脚本 |
| 非功能测试 | 并发、超时、断流、缓存、停机排空 | 慢速 socket、并发 PUT、信号关闭、句柄检查 |

### 5.2 入口切换测试工具

在 `api/test/helpers.mjs` 中统一：

```js
export const API_ENTRY = process.env.API_ENTRY || 'server.js';
```

所有启动服务器的测试使用该常量：

```js
const child = spawn(process.execPath, [API_ENTRY], {
  cwd: API,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
});
```

带 fake clock 的用例：

```js
spawn(process.execPath, ['--import', './test/fake-clock.mjs', API_ENTRY], ...)
```

运行 Nest：

```powershell
Set-Location api
npm.cmd run build
npm.cmd run test:nest
```

运行单个 Nest 用例：

```powershell
npm.cmd run test:nest -- test/server-data-rev.test.js
```

`test:nest` 只负责设置 `API_ENTRY=dist/src/main.js`，不复制测试逻辑；默认 `npm test` 仍运行旧入口，便于阶段性对照。

### 5.3 分阶段测试矩阵

| 阶段 | 旧入口 | Nest 入口 | 重点 |
| --- | --- | --- | --- |
| 0 | 全量 | 未启用 | 测试工具自身不改变结果 |
| 1 | 全量 | 构建 / 启动 / CORS / URL / body / health / config | HTTP 骨架和产物路径 |
| 2 | 全量 | 账户、认证、审计、在线态、同步、`409`、旧凭据 | 数据和安全语义 |
| 3 | 全量 | 媒体、Push、手表、集成、Coach、恢复、停机 | 流、队列、生命周期 |
| 4 | 仅演练用旧镜像 | 全量 | 切换、镜像、CI、升级 / 回滚 |

阶段 2–3 的 PR 在同一 Linux `api` 作业中运行旧入口和 Nest 两个步骤。两份报告按文件和测试名称复核。阶段 4 切换后保留 Nest 全量步骤。

### 5.4 常用命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd ci --omit=optional
npm.cmd run build
npm.cmd test
npm.cmd run test:nest
node --test test/server-data-rev.test.js
```

差异对照：

```powershell
node --test test/nest
```

MCP 集成回归：

```powershell
Set-Location D:\dev\open-gym\mcp
npm.cmd ci
npm.cmd --prefix ..\api run build
npx.cmd vitest run test/log-workout.e2e.test.js
```

RN loopback：

```powershell
Set-Location D:\dev\open-gym
npm.cmd --prefix .\api run build
node .\mobile-rn\scripts\loopback-api.mjs (Resolve-Path .\tmp-rn-data)
```

镜像：

```powershell
docker build --target default -t opengym-api:test .\api
docker build --target coach -t opengym-api:coach-test .\api
docker run --rm -e DATA_DIR=/data -e PORT=3000 -p 3000:3000 opengym-api:test
```

Nginx / Compose：

```powershell
docker compose build api web
docker compose up -d api web
curl.exe -fsS http://localhost:8080/api/config
```

### 5.5 测试数据和隔离

- 每个测试文件使用独立 `mkdtemp` 目录；`secret` 用 32 字节随机值或固定测试值，`mode 0600`。
- 需要旧数据兼容的测试，使用阶段 0 生成的脱敏夹具；不要在测试中读取真实 `DATA_DIR`。
- 通过 `PORT=0` 启动子进程，从 `gym-api on :<port>` 获取端口；不要预先挑选端口，避免并发测试争抢。
- 需要固定时间的用例继续使用 `api/test/fake-clock.mjs`；Presence、审计、提醒和 Coach 时间窗口必须用固定时钟或显式时间注入。
- 测试结束删除临时目录；Windows 上先恢复目录权限再删除，避免只读文件阻止清理。
- 测试数据中的 token、Cookie、配对码、审计 ID、`_wid` 和 `now` 在比较前规范化，不按固定值断言。
- 大文件媒体测试使用 `media-samples.mjs` 生成的样本，不提交真实用户照片或视频。

### 5.6 需要改写的源码断言

| 现有测试 | 现在保护什么 | 迁移后的等价断言 |
| --- | --- | --- |
| `durable.test.js` | `server.js` 的 `atomicWrite` 包装 | 持久化 Provider 调用 `durable.js`；保留 fsync / rename 运行时测试 |
| `server-state-read-cost.test.js` | 三个热路径都走 `readStateCached` | `StateStore` 的调用方单元测试 + 并发 HTTP 测试 |
| `server-media.test.js` | `server.requestTimeout` 至少 30 分钟 | 启动后读取 `httpServer.requestTimeout` / `headersTimeout` |
| `openapi-routes.test.js` | 旧路由表与 OpenAPI 一一对应 | Nest Controller 反射元数据与 OpenAPI 一一对应 |
| `dockerfile-copy.test.js` | Dockerfile `COPY` 包含旧入口依赖 | `dist` 产物清单 + Dockerfile `COPY` 只依赖交付文件 |
| `routes.test.js` / `e2e-apikey.test.js` | `coachRoutes` 的路由闭包 | Nest Controller / Service 夹具或真实 HTTP |

改写的原则是保留原测试保护的“刷盘、缓存、超时、文件完整性、协议形状”，而不是保留对某个文件名的引用。

### 5.7 CI 改造

```yaml
# api 作业（阶段 1–3）
- run: npm ci --omit=optional
  working-directory: api
- run: npm run build
  working-directory: api
- name: API tests (legacy entry)
  working-directory: api
  run: node --test test/*.test.js

# 同一个 api 作业的 Nest 步骤（阶段 1–3）
- name: API tests (Nest)
  working-directory: api
  run: npm run test:nest
```

阶段 4 归档旧入口步骤的最后一轮报告。MCP 以编译产物启动子进程，镜像从干净上下文构建。路径过滤覆盖 API 源码、构建配置和运行期资源。

### 5.8 验收用例的测试归属

| 用例 | 自动化位置 | 需要人工 / 真实环境的部分 |
| --- | --- | --- |
| A1 登录与设备 | `test/nest/auth.test.js`、passkey / pairing 套件 | 真实浏览器 Passkey、HTTPS、实际 RN 扫码 |
| A2 冲突与离线 | `test/nest/sync.test.js`、`server-data-*` | RN 模拟器断网补传、Web 并发编辑 |
| A3 数据与缓存 | `test/nest/sync.test.js`、`server-db-unreadable` | 损坏卷备份恢复演练 |
| A4 媒体 | `test/nest/media.test.js`、`server-media` | RN 照片、Web 视频、容器内存限制 |
| A5 部署链路 | 无 | Nginx / Compose / TLS / LAN / 镜像 |
| A6 扩展 | `test/nest/extensions.test.js`、Coach / MCP 套件 | 真实 Push、Webhook 接收端、Zepp、恢复 CLI |
| A7 重启与回滚 | 无 | 数据卷副本、镜像切换 |
| A8 在线态 | `test/nest/presence.test.js`、`server-presence` | 管理后台观察、真实通知抑制 |
| A9 模块与审计 | `test/nest/audit.test.js`、`routes` 路由矩阵 | 管理界面审计查询 |
| A10 停机 | `test/nest/shutdown.test.js` | Linux 信号、Compose / K8s 停机 |
| A11 构建入口 | CI、`test/nest/build.test.js` | 干净检出、镜像启动、路径过滤 |

## 6. 验收目标

### 6.1 总体验收标准

同时满足以下条件才算迁移完成：

1. **构建**：没有 `dist` 的干净检出可以 `npm ci`、`npm run build`，并由 `api/dist/src/main.js` 启动；镜像只依赖交付文件启动。
2. **契约**：91/91 路由与 `api/openapi.yaml` 一致；未知路径、错误方法、尾斜杠、`HEAD`、CORS、预检、错误结构和响应头与旧入口一致。
3. **认证**：旧 Web Cookie、已兑换的 RN Bearer、旧 Passkey 和旧设备链接在升级后继续可用。未兑换的旧配对码随进程重启失效，切换后可生成并使用新配对码。注销全部会话、禁用账号、普通用户访问管理接口返回旧客户端可识别的状态。
4. **数据**：旧服务写出的 `db.json`、`state-*.json`、媒体目录和扩展文件可被 Nest 读取；Nest 写出的档案可被旧服务再次读取和同步；没有格式迁移脚本。
5. **同步**：并发条件写入只有一个成功；`409` 返回当前公开状态；`baseRev` / `baseWid` / `stamped` / 旧客户端分支、删除标记和字段合并符合 A2 / A3。
6. **扩展**：媒体、Push、手表、集成、Coach、在线态和审计在开 / 关两种配置下均与旧入口对齐；后台任务重启后按原规则恢复。
7. **停机**：新请求被拒绝，计时器和队列停止，在途业务在 8 秒预算内排空；预算到期后资源和子进程被回收；重启后 Webhook 和 Coach 状态符合设计。
8. **回退**：使用数据卷副本完成旧版 → NestJS → 旧版演练，并读回 Nest 阶段产生的有效写入；停机、健康检查和已配对客户端结果有记录。
9. **文档与 CI**：OpenAPI 文档生成、Coach 资源检查、Coach core 可加载、Nix / Helm / Kubernetes / Compose 和 CI 路径过滤全部更新并通过。
10. **代码质量**：`AuditModule` / `PresenceModule` 不反向依赖 Auth / Accounts；有状态 Provider 只有一个实例；同步临界区没有异步文件操作；关闭路径没有残留计时器。

### 6.2 发布验收用例

| 用例 | 操作和可观察结果 | 证据 |
| --- | --- | --- |
| **A1 · 登录与设备** | 旧 Cookie 和已兑换 Bearer 可访问各自档案，原 Passkey 可重新登录。未兑换旧码在重启后失效，新码可由 RN 手动输入或扫码兑换。已消费或过期码被拒绝。注销、禁用及管理接口权限的行为兼容 | HTTP 状态与响应体、浏览器 / RN 记录、审计行 |
| **A2 · 冲突与离线** | RN 断网记录、重启后联网补传；Web 在离线期间修改计划；Web 在 RN `GET` 与 `PUT` 之间写入触发 `409` 并重试；Web 计划和 RN 训练均可回读；重复补传只产生一条训练；覆盖相同 `rev`、不同 `wid` 的恢复分支和旧客户端写入后保留新字段 / 删除标记 | 两端最终状态、`state-<uid>.json`、请求日志 |
| **A3 · 数据和缓存** | 同一档案两个并发条件写入只有一个匹配旧版本的请求提交；成功写入后修订号查询立即可见（含同大小快速写入）；损坏档案读写返回 `503`；账户库损坏时有备份则回读账号，无备份则启动失败 | 状态码、磁盘文件、启动日志 |
| **A4 · 媒体** | RN 上传进度照片、Web 上传自定义视频，另一端可回读；同账号去重；其他账号读取被拒绝；实际文件与哈希一致；上传中断清理；仍被引用文件保留；容器内存限制下流式传输 | 媒体文件 hash、响应头、清理日志、容器内存 |
| **A5 · 部署链路** | 经实际 Nginx 验证根路径或子路径、HTTPS Passkey、LAN 连接、转发头和媒体上传限制；`/api/config` 公开字段符合开关；数据盘不可写时健康检查 `503`；两种 API 镜像从预期入口启动 | curl、响应头、镜像启动日志、浏览器 Passkey |
| **A6 · 扩展** | Web Coach 共享代码可构建；启用实例可恢复任务和读取凭据；Push 可接收测试通知和按时区触发训练提醒；Webhook 待投递任务重启后按原规则处理；Zepp 邮箱可继续读写；MCP 能读到新写入档案并继续记录训练；Linux 恢复 CLI 可用 | Coach / Push / Webhook / MCP / CLI 日志与文件 |
| **A7 · 重启与回滚** | 使用数据卷副本升级，新增一笔训练和一条媒体引用，再切回旧镜像验证读取和继续写入；记录停机 / 恢复时间、健康检查、已配对客户端结果和持久任务状态 | 演练报告、镜像 digest、数据 diff |
| **A8 · 在线训练态** | 活动心跳在管理后台读回，并抑制对应账号催练；验证 `hidden` 后恢复、隐藏 45 秒未恢复、最后心跳 70 秒过期、`navigated` / `closed` / 无原因离开，以及禁用、删除、签发恢复链接后的清理；重启后由新心跳重建 | 管理接口、推送记录、日志 |
| **A9 · 模块与审计** | Nest 从根模块启动；账户库、审计、在线态各一个实例；Auth 与 Accounts 单向导入；登录、配对和管理权限拒绝保留审计规则；普通用户 `403` 记审计，未认证管理探测 `401` 不产生 `admin.denied`；审计查询权限、Owner 清空和保留期不变，清空后序号不重置 | 审计日志、DI 图、权限响应 |
| **A10 · 停机** | 慢速上传、在途 Webhook 和排队 Coach 任务期间关闭：新业务被拒绝、队列停止继续出队、预算内训练写入可回读、超时上传和子进程被回收；重启后未完成 Webhook 保留投递 ID 并按原规则重试，Coach 中断任务结束且已有提案保留；分别验证 Linux 信号和 Windows 显式 `app.close()`，关闭后无残留调度或监听 | 进程退出时间、日志、重启后队列 / 任务文件 |
| **A11 · 构建入口** | 从没有 `dist` 的干净检出安装并构建，分别经 API 回归入口、MCP 集成入口和 RN loopback 入口启动；两种镜像只依赖交付文件启动；仅修改 `api/src` 或构建配置时相关 API、MCP 和镜像 CI 作业触发；迁移后的持久化、缓存、超时与制品断言仍覆盖原要求 | CI 运行记录、构建日志、镜像文件清单 |

### 6.3 阶段验收清单

阶段 0：

- [ ] 旧测试全绿，`API_ENTRY=server.js` 结果一致。
- [ ] 基线、数据夹具和配置矩阵可重复生成。
- [ ] 没有生产行为变化。

阶段 1：

- [ ] 干净检出可构建、启动，`PORT=0` 输出实际端口。
- [ ] `/api/health`、`/api/config`、CORS、预检、请求体错误、404 与旧入口一致。
- [ ] 构建产物路径和资源复制通过校验。

阶段 2：

- [ ] A1、A2、A3、A8、A9 自动化部分通过。
- [ ] 旧 Cookie / Bearer / Passkey / 设备链接可用。
- [ ] 账户库、审计、在线态单实例；同步临界区正确。

阶段 3：

- [ ] A4、A6、A10 自动化部分通过。
- [ ] 媒体、Push、手表、集成、Coach 在开 / 关矩阵下对齐。
- [ ] 生命周期停止幂等，无残留计时器。

阶段 4：

- [ ] A1–A11 全量发布验收有结果，启用的扩展实机流程与镜像停机已复核。
- [ ] 91/91 路由、镜像、CI、Nix、文档完成。
- [ ] 回滚演练保留 Nest 阶段有效写入。

### 6.4 证据和记录

在 `docs/nestjs-migration/ACCEPTANCE.md` 记录每轮验收：

```text
日期：
代码版本（git rev-parse HEAD）：
镜像 tag / digest：
Node / npm：
配置摘要（不含密钥）：
数据卷来源 / 是否脱敏：
执行命令：
结果：A1 ... A11（通过 / 失败 / 待验证）
失败项与修复：
日志 / 截图 / 文件 hash：
停机与恢复时间：
```

验收证据至少保留：测试命令输出、`junit.xml` 或测试摘要、路由矩阵 diff、镜像 digest、数据卷 diff、关键 HTTP 响应、停机日志和回滚演练记录。不要提交真实用户数据、密钥、Cookie 或配对码。

## 7. 风险与应对

| 风险 | 影响 | 应对 |
| --- | --- | --- |
| NodeAdapter 与旧 `http.createServer` 在尾斜杠、`HEAD`、错误处理、请求流上行为不同 | 客户端收到不同状态或连接异常 | 阶段 1 先做行为探针；请求钩子显式处理；保留真实子进程测试 |
| ESM / TypeScript / 装饰器构建路径错误 | 镜像启动即 `ERR_MODULE_NOT_FOUND` | `dist/src` 相对路径规则；构建脚本校验产物；干净检出和镜像启动测试 |
| 平行实现导致新旧逻辑漂移 | 迁移后行为悄悄变化 | 旧入口冻结；`API_ENTRY` 同套测试；差异对照；每个领域完成后立即合并 |
| 账户库 / 状态文件并发写入损坏 | 用户数据丢失或账户锁死 | 单进程单实例；原子写入；同步临界区不加 `await`；`.bak` 回退演练 |
| 媒体上传断流或临时文件泄漏 | 磁盘占用、健康检查误判 | 复用 `media.js` 空闲计时；在途集合；启动清理；A4 / A10 测试 |
| 停机时队列或计时器重新启动 | 关闭后仍有写入或监听 | 协调器统一关闭；`closing` 门禁；句柄和退出码测试；Compose / K8s 宽限 |
| 审计 / 在线态出现第二个实例 | 后台看不到在线态，审计序号错乱 | 模块 `exports` 单实例；依赖方向评审；A9 检查 |
| 测试改写丢失原有保护 | 回归在 CI 中静默失效 | 按第 5.6 节保留刷盘、缓存、超时、文件完整性断言；PR 对照原测试意图 |
| CI 时间增长 | PR 反馈变慢 | 两套 API 回归复用构建与安装并保存各自报告，缓存 npm 和 Docker 层 |
| 自托管实例配置差异 | 演练通过但现场失败 | 阶段 0 记录现场输入；演练使用同一架构；切换前锁定 digest 和备份 |
| 回滚后旧服务读不懂新写入 | 数据不可用 | A7 双向读写；档案保持旧字段；回滚前保全当前卷 |

## 8. 切换与回滚清单

### 8.1 切换前

- [ ] 目标实例的镜像 digest、Compose 项目、数据卷路径和配置摘要已记录。
- [ ] 完整 `DATA_DIR` 已备份，备份可读、权限正确。
- [ ] 数据卷副本上的旧版 → NestJS → 旧版演练通过。
- [ ] Linux 双入口回归和 A10 均有记录。候选镜像内的恢复命令通过。
- [ ] `default` / `coach` 镜像 digest 已锁定，镜像启动和 Nginx 链路已验证。
- [ ] 维护窗口、回滚负责人和停止条件已确认。

### 8.2 切换

- [ ] 停止旧 API，等待在途写入完成。
- [ ] 备份当前 `DATA_DIR` 和部署配置。
- [ ] 使用记录的新镜像启动单副本 API；确认数据卷挂载、`/coach-auth` 权限和端口。
- [ ] 检查 `/api/health`、`/api/config`、Web 登录、已配对 RN 拉取和一次测试账号写入。
- [ ] 确认 Nginx 解析到新容器后恢复流量；观察错误日志、审计和同步。

### 8.3 回滚

- [ ] 出现旧客户端鉴权、同步、写入或媒体阻断问题时，停止 Nest API。
- [ ] 用记录的旧镜像和配置接管当前数据卷，不删除切换后写入。
- [ ] 验证旧服务能读取 Nest 阶段产生的训练、计划和媒体引用。
- [ ] 若数据卷损坏，先保全当前卷，核对切换后写入，再按备份恢复和补录。
- [ ] 按 A7 重新记录读取、写入、健康检查和客户端结果。

## 9. 交付物

- `api/src/` NestJS 应用和 `api/dist/src/main.js` 构建产物生成脚本。
- `api/server.js` 薄入口、`api/package.json` / 锁文件、tsconfig、`.dockerignore`。
- 迁移后的 `api/test/`、`api/test/nest/`、源码断言和路由契约测试。
- `.github/workflows/test.yml`、`api/Dockerfile`、`api/scripts/build-api.mjs` 的改造。
- Compose / Helm / Kubernetes / Nix 的停机宽限和打包改造。
- `docs/nestjs-migration/EXECUTION.md`、`BASELINE.md`、`ACCEPTANCE.md`。
- `default` / `coach` 镜像及 digest、升级 / 回滚演练报告。
- 更新后的 `docs/ARCHITECTURE.md`、`docs/API.md`、`docs/SELF_HOSTING.md`、`docs/README.md`、`AGENTS.md`。

## 10. 附录

### 10.1 路由规模

按设计模块统计当前路由（以 `api/openapi.yaml` 的 91 个 operation 为准）：

| 前缀 / 领域 | 路由数 | 代表路由 |
| --- | --- | --- |
| `/api/admin` | 19 | 用户、邀请、审计、Coach 管理 |
| `/api/coach` | 12 | plan、review、debrief、ask、adapt、cohort |
| `/api/account` | 12 | 密码、邮箱、Passkey、设备链接、删除 |
| `/api/watch` | 9 | pair、redeem、links、snapshot、events、ack、box |
| `/api/push` | 7 | public-key、subscribe、status、test、rest-timer |
| `/api/integrations` | 7 | 列表、连接、更新、断开、测试、重试、日志 |
| `/api/login`、`/api/register` | 7 | Passkey / 密码注册登录 |
| `/api/media` | 4 | 上传、下载、missing、sweep |
| `/api/data` | 3 | 读取、修订、条件写入 |
| 其他 | 11 | health、config、me、logout、pair、device-link、activity、nudge-check |

### 10.2 配置矩阵

| 变量 | 测试取值 | 影响 |
| --- | --- | --- |
| `PASSWORD_LOGIN` | `0` / `1` | 密码路由是否存在、`/api/config` 是否公开 `password_login` |
| `MEDIA_UPLOADS` | `0` / `1` | 媒体路由、媒体清理计时器、`/api/config.media` |
| `INTEGRATIONS` | `''` / `webhook` | 集成路由、outbox 启动、`/api/config.integrations` |
| `COACH_DISABLED` | `0` / `1` | Coach 路由行为、cadence / warmup、`/api/config.coach` |
| `AUDIT_LOG` | `0` / `1` | 审计写入和查询 |
| `AUDIT_IP` | `off` / `net` / `full` | 审计地址脱敏 |
| `TRUST_PROXY` | `0` / `1` | 限流和审计地址解析 |
| `INVITE_ONLY` | `0` / `1` | 注册和配对流程 |
| `BODY_TIMEOUT_MS` | `400` 等测试值 | 请求体时限 |
| `MEDIA_*` | 测试小额度 | 上传限额、配额、清理宽限 |

### 10.3 执行检查表

- [ ] 设计稿和 OpenAPI 已读，91 个路由清单已记录。
- [ ] 旧入口在阶段 0–3 保持可运行，未把新功能写进旧入口。
- [ ] 每个阶段都有独立 PR、测试命令和退出条件。
- [ ] 每个新增 Provider 都有测试；账户库、训练状态和关键元数据写盘经过 `atomicWrite`，媒体仍按现有流式临时文件规则处理。
- [ ] 每个后台计时器都有启动和停止路径。
- [ ] 每个新 Controller 都有路由矩阵条目和 OpenAPI 对应项。
- [ ] 每个涉及版本、缓存、媒体的测试都保留原保护意图。
- [ ] 阶段 4 前没有生产镜像切换。
- [ ] 切换前完成数据卷副本演练和回滚验证。
