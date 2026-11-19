# 18 · 契约测试、路由矩阵与 CI

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 0–4（贯穿）
- 依赖：[01 构建与启动](01_BUILD_AND_BOOTSTRAP.md)、[02 HTTP 兼容层](02_HTTP_COMPATIBILITY.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §3、§6、§7
- 代码落点：`api/test/`、`api/test/nest/`、`api/scripts/test-nest.mjs`、`.github/workflows/test.yml`
- 自有路由：0
- 状态：待执行

## 1. 背景与目标

迁移不能靠“新入口看起来能跑”验收。现有 100 个测试文件是行为基线，但其中一部分直接扫描旧源码。本功能点负责：

- 让 HTTP 测试通过 `API_ENTRY` 在旧入口和 Nest 入口之间切换。
- 建立旧 / 新入口的差异对照，比较状态码、关键响应头、JSON 结构和最终磁盘结果。
- 把扫描旧路由字面量的测试改为检查 Nest Controller 注册的 HTTP 方法和路径。
- 保留原子写入、缓存、超时、媒体流和制品完整性等非功能断言。
- 把构建前置和 Nest 套件接入 CI。

## 2. 测试工具

### 2.1 `API_ENTRY`

在 `api/test/helpers.mjs` 增加：

```js
export const API_ENTRY = process.env.API_ENTRY || 'server.js';
```

所有启动服务器的测试改为：

```js
const child = spawn(process.execPath, [API_ENTRY], {
  cwd: API,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
});
```

带 fake clock：

```js
spawn(process.execPath, ['--import', './test/fake-clock.mjs', API_ENTRY], ...)
```

要求：

- 默认仍是 `server.js`，阶段 1–3 不影响旧测试。
- Nest 入口用 `dist/src/main.js`；测试脚本必须在启动前完成构建。
- 测试仍从启动行 `gym-api on :<port>` 获取实际端口，不预先挑选端口。
- 每个测试文件独立 `DATA_DIR`，结束后清理。

### 2.2 `test:nest` 脚本

- [ ] 新增 `api/scripts/test-nest.mjs`：
  - 设置 `API_ENTRY=dist/src/main.js`。
  - 用 `fs` 列出 `test/*.test.js` 与 `test/nest/*.test.js`，避免 Windows 不展开通配符。
  - 透传额外参数（例如单个测试文件）。
  - 子进程退出码透传。
- [ ] `api/package.json` 增加 `"test:nest": "node scripts/test-nest.mjs"`。
- [ ] `"test"` 保持 `node --test test/*.test.js`。

### 2.3 差异对照

- [ ] 新增 `api/test/nest/parity.mjs`：
  - `seedData(dir, scenario)`：Owner / Admin / 普通成员 / 禁用成员、Passkey、订阅、邀请、`state-*`、媒体引用。
  - `startBoth(scenario)`：同一份种子分别启动固定的 `server.js` 和 `dist/src/main.js`，并断言实际入口。旧侧独立于 `API_ENTRY`。
  - `normalizeResponse(res)`：忽略 `Date`、随机 token、`now`、`ts`、`audit id`、`_wid` 等易变值；保留状态码、业务错误码、关键响应头和 JSON 结构。
  - `compareJson` / `compareDisk`：比较 `db.json`、`state-*.json`、媒体目录。
- [ ] 场景按领域拆分：`auth.test.js`、`sync.test.js`、`media.test.js`、`extensions.test.js`、`shutdown.test.js`。
- [ ] 先做旧入口对旧入口的 smoke，验证夹具、端口获取、清理和规范化可靠。

## 3. 路由矩阵

### 3.1 目标

用 Nest Controller 的元数据生成 91 个 `METHOD /api/path`，与 `api/openapi.yaml` 比较：

- 每个服务器注册的路由都在 OpenAPI 中。
- OpenAPI 中的每个 operation 都由服务器提供。
- 媒体 `:hash` 归一化为 `{hash}`。
- 可选路由（密码 / 媒体）仍然在 OpenAPI 中；配置关闭只影响运行时注册，不影响契约文档。

### 3.2 实现

- [ ] 先做一个元数据探针：对一个最小 Controller 读取 `PATH_METADATA` / `METHOD_METADATA`，确认 `ModulesContainer` 在测试进程中可用。若不可用，退回显式维护路由清单，但仍必须与 OpenAPI 双向比较；不要猜测路由。
- [ ] 新增 `api/test/nest/routes.test.js`：
  - 从 `@nestjs/common/constants` 导入 `PATH_METADATA`、`METHOD_METADATA`。
  - 从 `@nestjs/common` 的 `RequestMethod` 映射方法名。
  - 遍历 `AppModule` 的 `ModulesContainer`，读取 Controller 类和方法元数据。
  - 加上全局前缀 `/api`，展开 Controller 路径 + 方法路径。
  - 归一化 `:hash` 为 `{hash}`。
- [ ] 解析 `api/openapi.yaml` 的 `paths` / method（沿用旧测试的轻量解析，不引入 YAML 依赖）。
- [ ] 断言：
  - 路由数 > 40（防止扫描失效）。
  - 差集为空（两个方向）。
  - 关键路由存在：`GET /api/health`、`GET /api/data`、`PUT /api/data`、`GET /api/media/{hash}`、`PUT /api/media/{hash}`、`GET /api/coach/status`、`GET /api/integrations`。
- [ ] 阶段 4 用该测试替换 `openapi-routes.test.js` 的旧路由表扫描；阶段 1–3 可并行运行新旧两份，确保迁移中不漂移。

### 3.3 源码断言迁移

| 现有测试 | 迁移后断言 |
| --- | --- |
| `durable.test.js` 的 `server.js` 源码匹配 | 持久化 Provider 调用 `durable.js`；保留 fsync / rename 运行时测试 |
| `server-state-read-cost.test.js` 的源码扫描 | `SyncService` / `StateStore` 调用方单元测试 + 并发 HTTP 测试 |
| `server-media.test.js` 的 `server.requestTimeout` 源码正则 | 启动后读取 `httpServer.requestTimeout` / `headersTimeout` |
| `openapi-routes.test.js` 旧路由表 | Nest Controller 元数据 + OpenAPI |
| `dockerfile-copy.test.js` 旧 `COPY` 行 | `dist` 产物清单 + Dockerfile 只依赖交付文件 |
| `routes.test.js` / `e2e-apikey.test.js` 的 `coachRoutes` 闭包 | Nest Controller / Service 夹具或真实 HTTP |

原则：保留原测试保护的行为（刷盘、缓存、超时、文件完整性、协议形状），不保留对某个文件名的引用。

## 4. CI 改造

### 4.1 阶段 1–3

```yaml
# api 作业
- run: npm ci --omit=optional
  working-directory: api
- run: npm run build
  working-directory: api
- name: API tests (legacy entry)
  working-directory: api
  run: node --test test/*.test.js

# 同一个 api 作业的第二个测试步骤
- name: API tests (Nest)
  working-directory: api
  run: npm run test:nest
```

- [ ] `api` 作业在 `npm ci` 后构建；旧入口测试仍全量。
- [x] `api` 作业运行全量 Nest 套件，两个入口分别保存结果。路径过滤覆盖 `api/**`。
- [x] `mcp` 作业构建后通过 `API_ENTRY=dist/src/main.js` 启动真实 Nest 入口，API 改动也会触发回归。
- [ ] `images` 作业路径过滤加入 `api/src/**`、`api/tsconfig*.json`、`api/scripts/build-api.mjs`。
- [ ] 一次构建供本轮子进程复用；不要在测试内部重复构建。

### 4.2 阶段 4

- [ ] API 回归和 MCP 集成作业使用 Linux / Node.js 24。切换默认入口前，在同一环境对照旧入口和 Nest 入口，记录失败差异。
- [ ] `api` 作业改为安装 → 构建 → 全量 `npm run test:nest`。
- [ ] 归档最后一轮旧入口报告，切换后保留 Nest 测试步骤。
- [ ] 保留 `scripts/build-api-docs.mjs --check`、`api/scripts/check-core-loadable.mjs`、Coach 资源检查。
- [ ] MCP / images 作业从干净检出构建，不依赖开发机 `dist`。
- [ ] 路径过滤确保只改 `api/src` 或构建配置时相关作业会触发。

### 4.3 统计与报告

- [ ] `scripts/ci/test-report.mjs` 继续统计 API 测试；覆盖率不因子进程启动方式改变而丢失（按现有实现）。
- [ ] 路由矩阵 / 差异对照失败时输出可读 diff，而不是只有断言失败。
- [x] 分别保留旧入口与 Nest 的 JSONL、JUnit。对照时按文件及测试名称核对失败差异。

## 5. 测试命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd ci --omit=optional
npm.cmd run build

# 旧入口
npm.cmd test

# Nest 入口全量
npm.cmd run test:nest

# 单个文件
npm.cmd run test:nest -- test/server-data-rev.test.js

# 路由矩阵
node --test test/nest/routes.test.js
```

## 6. 验收目标

- [ ] `API_ENTRY` 切换不改变测试逻辑和清理行为。
- [ ] Nest 入口下现有测试全部通过，或按 3.3 完成等价断言替换。
- [ ] 91/91 路由与 OpenAPI 一致；媒体 `{hash}` 归一化正确。
- [ ] 差异对照覆盖状态码、关键响应头、JSON 结构、磁盘结果。
- [ ] 原子写入、缓存、超时、媒体流、制品完整性断言仍有等价保护。
- [ ] CI 在干净检出上构建并运行旧 / 新入口（阶段 4 后只新入口）。
- [ ] A11 的构建入口 / CI 部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 测试仍依赖源码文件位置 | 按 3.3 迁移断言；删除旧文件前先改测试 |
| 差异对照过度规范化，漏掉真实差异 | 只忽略易变值；状态码 / 关键头 / 结构不忽略 |
| 测试端口 / 临时目录竞争 | `PORT=0` + 启动行；每文件独立 `DATA_DIR` |
| CI 时间增加 | 一次构建；临时作业只跑必要阶段；缓存 |
| 路由矩阵扫描失败但测试仍绿 | 断言路由数 > 40；关键路由存在；两个方向差集 |

## 8. 验收记录

```text
状态：待执行
代码版本：
旧 / 新入口测试结果：
路由矩阵 diff：
遗留问题：
```
