# 19 · 交付、升级与回滚

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 4（切换入口、制品、CI 和升级演练）
- 依赖：[01–18](README.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §6、§7、§8
- 代码落点：`api/server.js`、`api/Dockerfile`、`.github/workflows/`、`docker-compose.yml`、`helm/`、`kubernetes/`、`contrib/nix/`、`docs/`
- 自有路由：0
- 状态：待执行

阶段 3 的双入口报告和 A10 停机验收是启动本阶段的前置。保存旧镜像 digest，在候选镜像上完成 A7 后交付默认入口。

## 1. 背景与目标

最后一步是把旧入口收敛为启动编译产物的薄入口，并交付 `default` / `coach` 镜像。必须保证：

- `npm start`、`node server.js`、`PORT=0` 和启动行不变。
- 镜像只依赖交付文件启动，不依赖源码树或开发机 `dist`。
- `default` 镜像不包含 AI 运行时；`coach` 镜像包含 Agent SDK / Codex / bubblewrap，并保留 `/coach-auth` 权限。
- Compose / Nginx 链路、健康检查、数据卷、单副本 `Recreate` 不变。
- 使用数据卷副本完成旧版 → NestJS → 旧版演练，并读回 Nest 阶段的有效写入。
- 自托管实例按“记录输入 → 演练 → 维护窗口切换 → 回滚”执行。

## 2. 执行步骤

### 2.1 切换 `api/server.js`

- [ ] 将 `api/server.js` 替换为薄入口：
  - 保留 `npm start` / `node server.js` 的调用方式。
  - 动态 `import('./dist/src/main.js')`。
  - 不读取环境变量、不启动计时器、不注册业务路由。
  - 启动行、`PORT=0`、错误退出和信号处理由 Nest 入口负责。
- [ ] 确认 `node server.js`、`npm start`、`node dist/src/main.js` 三种方式启动结果一致。
- [ ] 删除旧入口中的路由表、`readBody`、`json`、`createServer`、后台启动代码和闭包；确认没有业务逻辑只存在于旧文件。
- [ ] 保留 `api/server.js` 作为镜像入口，避免修改 Compose / MCP / RN 的启动命令。

### 2.2 更新 MCP / RN 本地入口

- [ ] `mobile-rn/scripts/loopback-api.mjs`：
  - 继续 monkeypatch `http.Server.prototype.listen`，显式绑定 `127.0.0.1`。
  - 兼容 Nest 可能使用的 `(port, host, callback)` 形式。
  - 保留 `Connection: close` 的断网回归行为。
  - 默认入口仍为 `../../api/server.js`；构建前置见 18。
- [ ] `mcp/test/log-workout.e2e.test.js`：
  - 默认仍启动 `server.js`；构建后即为 Nest 入口。
  - 如需 `API_ENTRY`，默认保持 `server.js`，不改变 CI 调用方式。
- [ ] 在 README / 开发文档中写明：本地回归前需要 `npm run build`。

### 2.3 镜像

- [ ] 重构 `api/Dockerfile` 为多阶段：
  - 构建和运行阶段使用同一个固定版本的 Node.js 24 Alpine 基础镜像。
  - `build` 阶段安装完整依赖（含 dev），复制源码，运行 `npm run build`。
  - `default` 运行阶段复制 `package.json`、`package-lock.json`、`server.js`、`recover.js`、`admin-socket.js` 和 `dist`，执行 `npm ci --omit=dev --omit=optional`，删除 npm / npx。保留工作目录相对入口，供 `node recover.js` 调用。
  - `coach` 运行阶段复制同样产物，执行 `npm ci --omit=dev`，安装 bubblewrap / Codex，保留 `/coach-auth` 权限。
  - `CMD` 保持 `node server.js`；`EXPOSE`、`PORT`、健康检查不变。
- [ ] 确保 `dist` 包含 `coach/`、`integrations/`、`coach/fixture-cli.mjs` 等运行期资源。
- [ ] 确认 `default` 镜像不包含 `@anthropic-ai/claude-agent-sdk` / Codex / bwrap；`coach` 镜像包含。
- [ ] 构建并启动：
  - `default` target。
  - `coach` target。
  - 无 target 的发布镜像（与 `docker-publish.yml` 一致，最后阶段为 `default`）。
- [ ] 验证 `/api/config`、`/api/health`、Nginx 代理、启动日志、容器健康检查。
- [ ] 在 `api/.dockerignore` 排除 `node_modules`、`dist`、`test`、`coverage`、`*.log`。

### 2.4 CI / 发布

- [ ] `.github/workflows/test.yml`：
  - `api` 作业在 Linux / Node.js 24 下安装 → 构建 → 全量 `test:nest`。
  - `mcp` 作业在 Linux / Node.js 24 下安装 API 依赖 → 构建 → 集成回归。
  - `images` 作业从干净检出构建 `default`、`coach`、发布镜像，保留 AI 运行时 / 启动 / Nginx 断言。
  - 路径过滤覆盖 `api/src/**`、`api/tsconfig*.json`、`api/scripts/build-api.mjs`、`api/Dockerfile`、运行期资源。
- [ ] `.gitlab-ci.yml` 中运行 API 和 MCP 集成回归的作业使用 Node.js 24 镜像，在作业内指定版本。
- [ ] `.github/workflows/docker-publish.yml`：
  - 确认构建上下文、target、tag 和发布阶段未改变。
  - 发布 tag 仍对应同一版本；`default` 是最后阶段。
- [ ] 保留 `scripts/build-api-docs.mjs --check`、`api/scripts/check-core-loadable.mjs`、Coach 资源检查。
- [ ] 干净检出（无 `dist`、无 `node_modules`）跑一次 CI 等价命令。

### 2.5 Nix / 部署清单

> **范围调整（2026-11-19）**：Nix/NixOS 本轮不纳入。`api.nix` 已改为安装 `dist` + 薄入口，但未完成构建验证，且仍使用 `nodejs_22`；本节的 Nix 项不阻塞本轮交付，恢复时逐项补验。

- [ ] ~~更新 `contrib/nix/api.nix`：~~
  - ~~执行构建脚本（`npmBuildScript = "build"` 或等价）。~~
  - ~~安装 `dist`、`server.js`、`recover.js`、`admin-socket.js`、`package.json` 和运行期依赖。~~
  - ~~使用 `nodejs_24` 构建，并通过 `makeWrapper` 启动同一 Node 主版本，保留 `NODE_ENV=production`。~~
  - ~~确认 ESM 包元数据（`type: module`）随 `package.json` 安装。~~
- [ ] Compose：
  - `api` 服务增加 `stop_grace_period: 10s` 或更长。
  - 保持 `DATA_DIR=/data`、`./data:/data`、`./coach-auth:/coach-auth`、`TRUST_PROXY`、`PORT` 不变。
- [ ] Helm / Kubernetes：
  - 保持 `replicas: 1`、`strategy: Recreate`。
  - 增加 `terminationGracePeriodSeconds: 15`（大于 8 秒预算）。
  - 健康检查仍为 `/api/health`。
- [ ] 检查 `web/nginx.conf.template` 的 `/api` / `/api/media` 代理、`client_max_body_size`、缓冲、超时；不要为本迁移修改。
- [ ] 检查 `web/Dockerfile`、`docker-compose.yml` 的 API 端口 / 上游名称未变化。

### 2.6 文档

- [ ] 更新 `docs/ARCHITECTURE.md`：入口、模块、构建产物、单写者、停机协议。
- [ ] 更新 `docs/API.md`：实现位置变化；`api/openapi.yaml` 仍是契约来源。
- [ ] 更新 `docs/SELF_HOSTING.md`：构建前置、镜像升级、备份、回滚。
- [ ] 更新 `docs/README.md`、`AGENTS.md`：NestJS 设计 / 执行 / 功能文档索引。
- [ ] 更新 `docs/RN_MIGRATION_STATUS.md` 或对应记录：API 入口变化对 RN 本地回归的影响。
- [ ] 更新 `CHANGELOG.md`（如项目发布流程要求）。

### 2.7 升级演练

1. **准备**
   - [ ] 使用阶段 0 的脱敏数据卷副本。
   - [ ] 记录旧镜像 digest、Compose 项目、`DATA_DIR`、`ORIGIN`、`RP_ID`、`BASE_PATH`、代理、功能开关、`/coach-auth` 挂载。
   - [ ] 备份完整 `DATA_DIR` 和部署配置。

2. **旧版基线**
   - [ ] 启动旧镜像；验证健康、登录、RN 拉取、媒体读取、一笔测试写入。

3. **切换 Nest**
   - [ ] 停止旧容器，等待在途写入。
   - [ ] 用锁定的 Nest 镜像启动同一数据卷。
   - [ ] 验证 `/api/health`、`/api/config`、旧 Cookie、旧 RN Bearer、Passkey。
   - [ ] 验证 `GET /api/data`、`GET /api/data/rev`、一次训练写入、媒体读取。
   - [ ] 验证 MCP 读取新写入档案、恢复 CLI（Linux）、Nginx 链路。

4. **新增写入**
   - [ ] 在 Nest 阶段新增一笔训练和一条媒体引用。
   - [ ] 停止 Nest，切回旧镜像；验证旧服务能读取并继续写入。
   - [ ] 记录停机 / 恢复时间、健康检查、已配对客户端、持久任务状态、镜像 digest。

5. **失败处理**
   - [ ] 任何 A7 阻断问题：停止 Nest，旧镜像接管当前数据卷，保留切换后写入。
   - [ ] 数据卷损坏：先保全当前卷，核对切换后写入，再按备份恢复 / 补录。
   - [ ] 修复后从数据卷副本重新演练，不在同一份卷上反复试错。

### 2.8 自托管切换

- [ ] 维护窗口内让旧 API 完成在途写入并退出。
- [ ] 备份 `DATA_DIR` 与配置。
- [ ] 部署锁定的 Nest 镜像；确认数据卷、`/coach-auth`、端口。
- [ ] 通过原域名检查健康、配置、Web 登录、已配对 RN 拉取、一次测试账号写入。
- [ ] 确认 Nginx 解析到新容器后恢复流量；观察错误日志、审计、同步。
- [ ] 记录实际停机、恢复、digest 和客户端结果。

## 3. 测试与验收

### 3.1 构建 / 镜像

```powershell
Set-Location D:\dev\open-gym
docker build --target default -t opengym-api:test .\api
docker build --target coach -t opengym-api:coach-test .\api
docker run --rm -e DATA_DIR=/data -e PORT=3000 -p 3000:3000 opengym-api:test
```

- [ ] `default` 启动并返回 `/api/config`。
- [ ] `coach` 启动；Agent SDK / Codex 可加载；`/coach-auth` 权限正确。
- [ ] 无 target 的发布镜像最后阶段仍是 `default`，不含 AI 运行时。
- [ ] 镜像使用交付文件启动。以测试账号在 `default` 和 `coach` 容器内运行 `node recover.js <测试账号>`，验证退出码与审计，验收记录隐去恢复码。

### 3.2 Nginx / Compose

```powershell
docker compose build api web
docker compose up -d api web
curl.exe -fsS http://localhost:8080/api/config
curl.exe -fsS http://localhost:8080/api/health
```

- [ ] `/api` 和 `/api/media` 代理正常。
- [ ] 媒体上传限制 / 缓冲 / 超时与旧配置一致。
- [ ] 数据盘不可写时健康检查 503。
- [ ] `BASE_PATH` / `TRUST_PROXY` / Cloudflare Access 场景。

### 3.3 干净检出

- [ ] 在 Linux / Node.js 24 的干净检出中安装和构建，记录 Node / npm 版本与锁文件 hash。
- [ ] 在 Linux 运行 API 回归和 MCP 集成，用 Windows 上的 RN 模拟器连接 Nest API 跑 loopback 回归。
- [ ] 运行镜像构建与启动。
- [ ] 只改 `api/src` 或构建配置时，API / MCP / 镜像 CI 作业触发。

### 3.4 验收用例

- [ ] A5：部署链路、Nginx、HTTPS Passkey、LAN、转发头、媒体限制、健康 503、两种镜像。
- [ ] A7：数据卷副本升级 / 回滚、新增训练 + 媒体引用、旧服务读回。
- [ ] A11：干净检出构建、API / MCP / RN 入口、镜像交付、路径过滤、源码断言。

## 4. 验收目标

- [ ] `api/server.js` 是薄入口，旧业务逻辑全部迁移。
- [ ] `default` / `coach` 镜像从预期入口启动，健康检查、Nginx 链路通过。
- [ ] 干净检出可构建、测试、启动；镜像不依赖源码树。
- [ ] Compose / Helm / Kubernetes / Nix 的入口、数据卷、单副本、停机宽限正确。
- [ ] 数据卷副本演练完成，旧版 → NestJS → 旧版双向读写通过。
- [ ] 自托管切换和回滚步骤可执行、可记录。
- [ ] 文档索引和部署说明更新。
- [ ] A1–A11 有结论。阶段 3 的 A10 信号验证通过，候选镜像内完成停机和恢复 CLI 复核。

## 5. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 镜像漏复制 `dist` 资源 | 构建脚本校验 + 镜像启动测试；`dockerfile-copy` 迁移 |
| 发布镜像最后阶段变成 coach | CI 断言 `:latest` 无 AI 运行时；保持 `default` 最后 |
| Compose / K8s 停机宽限不足 | 10s / 15s；A10 验证 |
| Nix 包缺 ESM 元数据 | 安装 `package.json`；Nix 构建测试 |
| 回滚后旧服务读不懂新写入 | A7 双向读写；字段保持旧格式 |
| 切换后配置遗漏 | 阶段 0 记录输入；演练使用同一架构 |

## 6. 验收记录

```text
状态：待执行
代码版本：
镜像 tag / digest：
干净检出构建结果：
A5 / A7 / A11 结果：
停机 / 恢复时间：
遗留问题：
```
