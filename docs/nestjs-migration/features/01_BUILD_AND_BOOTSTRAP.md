# 01 · 构建与 Nest 启动入口

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 1（构建、启动和 HTTP 骨架）
- 依赖：[EXECUTION.md](../EXECUTION.md) 阶段 0 基线
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§5、§6
- 代码落点：`api/package.json`、`api/package-lock.json`、`api/tsconfig.json`、`api/tsconfig.build.json`、`api/scripts/build-api.mjs`、`api/src/main.ts`、`api/src/app.module.ts`
- 自有路由：0
- 状态：待执行

## 1. 背景与目标

当前 `api/` 的入口是 [server.js](../../../api/server.js)，由 Node 直接执行，使用 ESM，不经过编译。新增 Nest 入口不能改变 `npm start`、`PORT=0`、启动日志和容器内的启动方式，因此需要先建立一套可重复、可校验、运行时不依赖源码树的构建产物：

- 编译入口固定为 `api/dist/src/main.js`。
- `dist` 内同时包含复用的根级 ESM 模块、`coach/`、`integrations/` 和运行期资源。
- 开发期仍可用旧 `server.js` 作为对照；Nest 入口通过 `node dist/src/main.js` 启动。
- 构建在干净检出中可完成，不依赖开发机已有的 `dist` 或 `node_modules`。

## 2. 范围

### 2.1 包含

- NestJS 12.5.1 运行时依赖和 TypeScript 开发依赖。
- NodeNext / ESM / 装饰器配置。
- `api/dist/src/main.js` 构建产物和资源复制。
- Nest 启动、全局前缀、关闭钩子的最小实现。
- `package.json` 的 `build`、`start:nest` 脚本。
- `api/.dockerignore`、仓库 `.gitignore` 的 `api/dist/`。

### 2.2 不包含

- 具体路由、Controller、Guard、Provider；从 02 开始。
- 镜像构建和 CI 发布；见 19。
- 修改 `api/coach/core/` 的共享目录位置。
- 把 `server.js` 改为薄入口；阶段 4 才做，见 19。

## 3. 执行步骤

### 3.1 固定依赖与锁文件

- [ ] 先做版本可用性探针：`npm.cmd view @nestjs/core@12.5.1 version`、`npm.cmd view @nestjs/platform-node@12.5.1 version`。如果 12.5.1 或其 peer 依赖不可用，停止并回到设计评审更新基线，不要静默换成其他版本。
- [ ] 更新 `api/package.json`，运行时依赖锁定：
  - `@nestjs/common@12.5.1`
  - `@nestjs/core@12.5.1`
  - `@nestjs/platform-node@12.5.1`
  - `reflect-metadata`
  - `rxjs`（按 Nest 12 的 peer 范围锁定）
- [ ] 开发依赖：`typescript`、`@types/node`。
- [ ] 不引入 `@nestjs/cli`、SWC、Webpack、dotenv、`@nestjs/config` 或数据库相关包。
- [ ] 阶段 4 将 `@types/node` 对齐到 24.x，在 Linux / Node.js 24 下更新 `api/package-lock.json`，并用同一工具链验证干净安装。
- [ ] 确认 `npm ci --omit=optional` 能安装，`@anthropic-ai/claude-agent-sdk` 仍为可选依赖。

### 3.2 配置 TypeScript 和构建输出

- [ ] 新增 `api/tsconfig.json`：
  - `module: "NodeNext"`、`moduleResolution: "NodeNext"`。
  - `target` 保持 ES2022，`lib` 保持 ES2023，在 Node.js 24 下验证编译产物。
  - `experimentalDecorators: true`、`emitDecoratorMetadata: true`。
  - `strict: true`、`noEmitOnError: true`。
  - `rootDir: "."`、`outDir: "dist"`。
  - `allowJs: true`、`checkJs: false`。
  - `include: ["src/**/*.ts"]`；运行期 JS 由构建脚本复制。
  - `exclude: ["node_modules", "dist", "test", "scripts"]`。
- [ ] 所有 TS 相对导入写 `.js` 后缀；不要使用路径别名、`baseUrl` 或 bundler 解析。
- [ ] 新增 `api/tsconfig.build.json`，继承基础配置，关闭声明文件和 sourcemap，保证入口是 `dist/src/main.js`。
- [ ] 写一个最小的 `src/main.ts` 类型检查，确认 NodeNext 能解析 `../durable.js`、`../coach/config.js` 这类相对导入。

### 3.3 构建脚本

- [ ] 新增 `api/scripts/build-api.mjs`，顺序固定：
  1. 删除 `api/dist`。
  2. 执行 `tsc -p tsconfig.build.json`。
  3. 复制根级运行期 `*.js`，但排除 `server.js`（阶段 4 的入口由源码直接使用）。
  4. 复制 `coach/`、`integrations/`、`*.mjs` 及运行期非 JS 资源（例如 `coach/fixture-cli.mjs`）。
  5. 校验 `dist/src/main.js`、`dist/durable.js`、`dist/media.js`、`dist/coach/fixture-cli.mjs`、`dist/integrations/index.js` 存在。
  6. 任何一步失败都以非零码退出，不留下半成品 `dist`。
- [ ] 校验 `dist/src/main.js` 的相对导入只落在 `dist/` 内，不引用 `api/src`、`api/server.js` 或 `../` 之外的源码。
- [ ] 用 `node --check` 或 `node -e "import('./dist/src/main.js')"` 做入口可加载性的早期检查；真正的启动测试见 3.4。
- [ ] 在 `api/package.json` 增加：
  - `"build": "node scripts/build-api.mjs"`
  - `"start:nest": "node dist/src/main.js"`
  - 保留 `"start": "node server.js"`，直到阶段 4。

### 3.4 Nest 启动入口

- [ ] 在写业务 Controller 前先做最小适配器探针：一个 `GET /api/health` Controller，验证 `setOnRequestHook` 能在路由前处理 `OPTIONS`、非法目标、尾斜杠和 `HEAD`。如果 12.5.1 的实际 API 与设计不同，先更新 02 号文档再继续。
- [ ] 新增 `api/src/main.ts`：
  - 第一行导入 `reflect-metadata`。
  - 创建 `NodeAdapter`，并在创建应用前安装请求钩子占位（具体钩子见 02）。
  - `NestFactory.create(AppModule, adapter, { bodyParser: false })`。
  - `app.setGlobalPrefix('api')`；Controller 只声明相对路径，不在 Controller 里重复写 `api/`。
  - 在 `listen` 前设置 `httpServer.requestTimeout = 30 * 60000`、`headersTimeout = 60000`。
  - `await app.listen(PORT)` 后读取 `app.getHttpServer().address().port`，打印：
    `gym-api on :<port> (rpID=<RP_ID>, origin=<ORIGIN>)`
  - 端口读取失败、监听失败或初始化异常时关闭已取得的资源并以非零码退出。
  - 注册 `app.enableShutdownHooks()`，由 17 的协调器接管实际停止顺序。
- [ ] 新增 `api/src/app.module.ts`，阶段 1 只注册 `SystemModule` 和构建所需的空模块；不要注册未实现路由。
- [ ] 确认 `PORT=0` 时启动行里的端口是实际绑定端口，而不是环境变量原值。
- [ ] 确认 `app.close()` 能让进程退出；关闭时没有未处理的 Promise 或悬挂计时器。

### 3.5 开发与构建卫生

- [ ] 在 `.gitignore` 增加 `api/dist/`。
- [ ] 新增 `api/.dockerignore`，至少排除 `node_modules`、`dist`、`test`、`coverage`、`*.log`。
- [ ] 保留 `api/coach/`、`api/integrations/` 源码位置；构建时复制，不在 `src/` 内复制第二份业务代码。
- [ ] 在 README 或开发文档中写明：Nest 入口用 `npm run build` 后执行 `node dist/src/main.js`，旧入口仍为 `npm start`。

## 4. 测试

### 4.1 构建

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd view @nestjs/core@12.5.1 version
npm.cmd view @nestjs/platform-node@12.5.1 version
npm.cmd ci --omit=optional
npm.cmd run build
Test-Path .\dist\src\main.js
Test-Path .\dist\coach\fixture-cli.mjs
Test-Path .\dist\integrations\index.js
```

在删除 `api/dist`、`api/node_modules` 的干净检出中重复一次。

### 4.2 启动

```powershell
$env:PORT = '0'
$env:DATA_DIR = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('gym-nest-' + [guid]::NewGuid()))).FullName
node .\dist\src\main.js
```

- 断言启动行匹配 `gym-api on :\d+ \(rpID=.*, origin=.*\)`。
- 断言 `curl.exe http://127.0.0.1:<port>/api/health` 能返回响应（具体行为见 04）。
- 断言 `Ctrl+C` / `SIGTERM` 后进程在合理时间内退出，退出码为 0 或约定的非零码。
- 断言没有 `ERR_MODULE_NOT_FOUND`、没有 `Cannot find module`、没有未处理的 rejection。

### 4.3 产物与源码隔离

- [ ] 临时重命名 `api/src`，确认 `dist/src/main.js` 仍能启动；证明运行时不依赖源码树。
- [ ] 临时删除 `api/dist/coach`，确认构建脚本的校验会失败，而不是生成一个启动即坏的镜像。
- [ ] 比较 `api/package-lock.json` 在干净 `npm ci` 前后的 hash，确认没有隐式改写。

## 5. 验收目标

- [ ] 干净检出可以 `npm ci`、`npm run build`。
- [ ] `api/dist/src/main.js` 存在，运行期资源齐全。
- [ ] `node dist/src/main.js`、`npm run start:nest` 都能启动并打印实际端口。
- [ ] 旧 `node server.js` / `npm start` 仍可启动，未被本任务破坏。
- [ ] `api/dist` 不进入提交，Docker 构建上下文不包含开发产物。
- [ ] 构建失败时以非零码退出，不留下可被误启动的半成品。

## 6. 风险与回退

| 风险 | 应对 |
| --- | --- |
| `tsc` 把 TS 输出到错误层级，`dist/src/main.js` 相对导入断裂 | 固定 `rootDir: "."`、`outDir: "dist"`；构建脚本校验入口和资源；干净检出启动 |
| 根级 JS 被误编译或漏复制 | 构建脚本只复制运行期文件并列出必需清单；`node --check` + 启动冒烟 |
| 开发机残留 `dist` 掩盖问题 | CI 从干净检出构建；`api/dist/` 加入 `.gitignore`、`.dockerignore` |
| 启动入口过早接管旧入口 | 阶段 1–3 保留旧 `server.js`；新入口只用于测试和对照 |

## 7. 验收记录

```text
状态：待执行
代码版本：
构建命令与结果：
启动命令与结果：
产物校验：
遗留问题：
```
