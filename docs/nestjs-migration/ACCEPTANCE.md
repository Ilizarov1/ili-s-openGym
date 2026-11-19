# NestJS 迁移验收记录

- 记录时间：2026-11-19
- 代码版本：阶段 0–3 基线 `94777b4ada915c622baf5813af673646c123ebb9`；阶段 4 候选见 §6。
- 本机环境：Windows 11 + WSL 2 Ubuntu，Node v24.18.0，npm 11.16.0。
- 测试数据：独立临时数据目录和合成账号。
- 结论：阶段 0–3、Linux 双入口基线和默认入口切换通过；Docker 镜像与 Nix 打包受本机工具链限制，见 §9。RN 配对、同步和离线补传已在专用模拟器通过。

## 1. 本机验收

| 验收 | 环境 | 结果 |
| --- | --- | --- |
| API 构建 | Windows / Node 24 | 通过。产出 Nest 入口、Coach 与集成运行资源、`dist/recover.js` 和 `dist/admin-socket.js` |
| A1 / A2 双入口对照 | Windows / Node 22、24 | 分别启动 `server.js` 和 `dist/src/main.js`。健康、配置、旧侧续期的 Bearer、旧格式 Cookie、条件写入、`409` 和磁盘差异检查通过 |
| 路由与持久化 | Windows / Node 22、24 | Controller 元数据与 OpenAPI 91/91 一致。备份回退、状态损坏和缓存失效检查通过 |
| A10 显式关闭 | Windows / Node 22、24 | 纳入的训练写入在预算内提交，新请求返回 503。预算到期后关闭慢速上传并删除临时文件，停止测试 outbox 后续投递，回收 Coach 测试子进程和工作目录。重建 outbox 后同 ID 继续投递，Coach 启动恢复保留已有提案。测试使用 1.2 秒排空预算 |
| A10 进程信号 | Linux | 增加真实 Nest 入口的 `SIGTERM`、`SIGINT` 用例。Windows 跳过，待 Linux CI 记录 |
| MCP 回归 | Windows / Node 22 | 137 通过，1 个 POSIX 权限用例跳过。包含 5 个启动 Nest 的端到端用例。普通 Node 模块加载检查通过 |
| 恢复制品 | Windows / Node 24 | Dockerfile 静态检查两项通过，覆盖工作目录里的 `recover.js` 及相对依赖。镜像 CI 已接入容器内 socket 冒烟，实际执行待 Linux / Docker |

## 2. 全量双入口回归

同一工作区、同一 Windows Node 24 环境，按测试文件和测试名称比较失败集合。

| 入口 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| 旧版 `server.js` | 787 | 13 | 0 |
| `dist/src/main.js` | 793 | 13 | 2 |

两份报告的失败集合差集为 0。Nest 增加 6 个通过的专项用例，另有两个 Unix 信号用例在 Windows 跳过。两个入口的全量命令均返回退出码 1。

| 两侧共同失败 | 数量 | 相关用例文件 |
| --- | ---: | --- |
| POSIX 权限、写入失败前置 | 7 | `credential`、`durable`、`integrations`、`server-db-unreadable`、`server-health-writable`、`server-media`、`server-push-prune-save` |
| 生成资源和源码契约断言 | 4 | `nudge-copy`、`openapi-routes`、`prompts`、`wrapped` |
| Unix 管理 socket | 2 | `server-recovery` |

历史汇总曾记录 31 个失败。本次修正 Coach fixture 的 Windows URL 路径后，先前的 18 个 fixture 用例均通过。本轮结论来自两份实际运行的 JSONL，Linux 结果仍由 CI 验收。

```powershell
Set-Location api
npm.cmd run build
$report = Join-Path ([IO.Path]::GetTempPath()) ('opengym-api-compare-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $report | Out-Null
$files = Get-ChildItem test -Filter '*.test.js' -File | ForEach-Object { Join-Path 'test' $_.Name }
$reporter = '--test-reporter=../scripts/ci/node-test-reporter.mjs'
$env:API_ENTRY = 'server.js'
node --test --test-concurrency=6 $reporter "--test-reporter-destination=$report/legacy.jsonl" @files
npm.cmd run test:nest -- --test-concurrency=6 $reporter "--test-reporter-destination=$report/nest.jsonl"
Remove-Item Env:API_ENTRY
```

GitHub Actions 的 API 作业从同一检出运行两套回归，产物为 `test-results.jsonl`、`junit.xml`、`nest-results.jsonl` 和 `nest-junit.xml`。MCP 作业从构建产物启动 Nest，API 源码、锁文件和构建配置变化均会触发。

## 3. 架构核对

- 账户库、训练状态缓存、审计、在线态、媒体存储和集成 hub 仍通过共享 Provider 使用。同步读盘、比较、合并和原子写入在同一个同步段完成。
- 停机协调器先停计时器和出队。请求钩子追踪连接，拦截器追踪业务直到清理结束。超时取消请求流、provider 调用和受管理的子进程，最多追加 1 秒清理，然后由适配器关闭剩余连接。
- 配对码保存在内存，尚未兑换的旧码随切换失效。已兑换 RN Bearer、原 Cookie、Passkey 和设备链接继续按原契约验收。

## 4. 剩余门禁

1. 阶段 3 在 Linux CI 验证双入口全量、MCP 集成与 A10 信号停机，并保存各项结果。
2. 阶段 4 在 Linux / Node.js 24 更新 `@types/node` 和锁文件，从干净检出构建候选制品。镜像和 Nix 包按清单保留 `recover.js` 及 `admin-socket.js`，在 `default`、`coach` 容器内验证原恢复命令。
3. 锁定旧镜像和候选镜像 digest，用脱敏卷完成 A7 的旧版 → Nest → 旧版。读回 Nest 写入的训练及媒体后继续写入。完成 A1–A11 发布验收后交付默认入口切换。

## 5. 证据入口

- [双入口夹具](../../api/test/nest/parity.mjs) · [兼容性测试](../../api/test/nest/smoke.test.js)
- [停机和重启测试](../../api/test/nest/shutdown.test.js) · [路由矩阵](../../api/test/nest/routes.test.js)
- [镜像文件检查](../../api/test/dockerfile-copy.test.js) · [CI 作业](../../.github/workflows/test.yml)
- [基线](BASELINE.md) · [阶段 4 执行与回滚](EXECUTION.md)

---

# 阶段 4 验收（2026-11-19，Windows 11 + WSL 2 Ubuntu）

## 6. 本地候选

| 项目 | 值 |
| --- | --- |
| 工作分支 | `nestjs-phase4-work`（从 `handoff/nestjs-phase4` @ `045647b95` 创建） |
| Linux 检出 | `~/open-gym-stage4`（Ubuntu 文件系统） |
| 候选提交（代码） | `c62e6ed5cb0f39d4e042a831d50cfe478e39a087` |
| 候选提交（本记录） | 见文末「候选记录提交」 |
| 旧版检出 | `git worktree` @ `94777b4ada915c622baf5813af673646c123ebb9` |
| Windows 候选导出 | `D:\dev\open-gym-stage4-windows`（`git archive f131c3e3`，用于 RN 脚本的 Windows 侧路径） |
| Windows 主工作区 | `D:\dev\open-gym` 未改动，仍在原分支与原有未提交改动上 |
| Node / npm | v24.18.0 / 11.16.0（Linux 官方包，SHA-256 校验通过；Windows 同版本） |
| 数据 | 全部为合成账号与临时目录，无真实用户数据或凭据 |

入口切换后的构建命令：

```bash
export PATH="$HOME/.local/opt/node-v24.18.0-linux-x64/bin:$PATH"
cd ~/open-gym-stage4/api
npm ci --omit=optional
npm run build
```

## 7. Linux 双入口基线（切换前）

同一份检出、同一次依赖安装，报告目录 `~/open-gym-stage4-baseline-1`。

| 入口 | 通过 | 失败 | 跳过 | 退出码 |
| --- | ---: | ---: | ---: | ---: |
| 旧版 `server.js`（迁移前代码） | 800 | 0 | 0 | 0 |
| `dist/src/main.js` | 808 | 0 | 0 | 0 |

- 失败集合差集为 0（两侧都没有失败）；Nest 多出的 8 个用例是 `test/nest/` 专项。
- `test/nest/shutdown.test.js` 在 Linux 实际执行并通过：
  - `app.close drains an admitted write and cancels uploads, outbox work and Coach children`
  - `SIGTERM on the real server.js entry cleans a slow upload before exit`
  - `SIGINT on the real server.js entry cleans a slow upload before exit`
- `mcp/` 以 `API_ENTRY=dist/src/main.js` 运行：5 个文件、138 个用例全部通过。
- 对照：Windows 候选在本机有 2 个 POSIX mode 断言失败（`durable`、`server-media`），Linux 不受影响。

## 8. 切换后的候选回归

`api/server.js` 已是薄入口；以下均在 Linux 候选提交 `c62e6ed5` 上执行。

### 8.1 三种启动方式

| 命令 | 结果 |
| --- | --- |
| `node server.js` | `gym-api on :36929 (rpID=localhost, origin=http://localhost:8080)` |
| `node dist/src/main.js` | `gym-api on :41675 (...)` |
| `npm start` | `gym-api on :46499 (...)` |

三者均以 `PORT=0` 打印实际监听端口，启动行一致。

### 8.2 回归

| 套件 | 结果 |
| --- | --- |
| `node --test test/*.test.js` | 802 通过，0 失败 |
| `node --test test/nest/*.test.js` | 8 通过，0 失败（路由矩阵、持久化、显式关闭、SIGTERM、SIGINT、双入口对照） |
| `mcp`（`CI=1 API_ENTRY=dist/src/main.js npm test`） | 138 通过，0 失败 |
| `node scripts/build-api-docs.mjs --check` | 通过（`website/api.html in sync`） |
| `node scripts/build-coach-assets.mjs --check` | 通过（5632 动作、8 个 prompt） |
| `node api/scripts/check-core-loadable.mjs` | 通过 |
| Windows 候选（`D:\dev\open-gym-stage4-windows`） | 40 个相关用例中 38 通过；2 个失败均为 Windows 不支持的 POSIX 0600/0700 断言 |

路由矩阵：`test/nest/routes.test.js` 反射编译后的 Controller，与 `api/openapi.yaml` 的 91 个 operation 完全一致。`openapi-routes` 的旧 `server.js` 源码扫描已改为 Controller 反射和 `src/auth` 处理器扫描。

### 8.3 镜像载荷演练（无 Docker）

按 `api/Dockerfile` 运行阶段复制同样的文件集到 `~/open-gym-image-dryrun/app`：`package.json`、`package-lock.json`、`server.js`、`dist/`、`dist/recover.js`、`dist/admin-socket.js`，再执行 `npm ci --omit=dev --omit=optional`。

- 目录中没有 `src/`，启动不依赖源码树。
- `/api/health` 返回 `{"ok":true,"users":0,"writable":true}`。
- `/api/config` 返回预期的公开字段。
- `node recover.js --help` 打印原命令用法。

## 9. 镜像、Nix、Nginx 与客户端

| 项 | 状态 | 依据 / 卡点 |
| --- | --- | --- |
| Docker 镜像 `default` / `coach` / published | **待验证（环境阻断）** | Windows 无 `docker.exe`、无 Docker Desktop；Ubuntu 无 docker/podman/nerdctl，`sudo -n` 需要密码。无法构建，未产生镜像 ID。 |
| `docker compose` / Nginx 链路 | **待验证** | 同上，无 daemon。Compose 已加 `stop_grace_period: 15s`，Kubernetes / Helm 已加 `terminationGracePeriodSeconds: 15`。 |
| Nix `opengym-api` | **待验证（环境阻断）** | 无 `nix`、无 `/nix`，`apt-cache` 无 `nix-bin`，官方安装器需要 sudo 创建 `/nix`。`contrib/nix/api.nix` 已改为安装 `dist` + 薄入口，尚未构建。 |
| RN 配对 / 同步 / 离线补传 | **通过** | 专用模拟器 `emulator-5554`（`openGymRnQa`，`ro.kernel.qemu=1`，1080x2400）上运行候选 Windows 导出：`PASS: offline practice, draft and history after restart, pairing, offline queue, reconnect and duplicate prevention.` 工具链位于 `%LOCALAPPDATA%\OpenGymRnToolchain`（JDK 17、AVD、platform 36、build-tools 36.0.0）。 |
| 恢复 CLI（Linux） | **通过** | `server-recovery` 在 Linux 全量中通过；镜像载荷演练中 `node recover.js --help` 可用；Nest 启动后 `src/lifecycle/admin-socket.service.ts` 提供同一命令。 |
| MCP | **通过** | 138/138，端到端用例实际启动编译后的 Nest 入口。 |

Nginx / 子路径 / HTTPS / LAN 的 A5 分项仍按 [19_DELIVERY_AND_ROLLBACK.md](features/19_DELIVERY_AND_ROLLBACK.md) 待有 Docker 的环境执行。

## 10. A7 回滚演练（文件级，无容器）

同一数据目录由旧版和候选依次接管，每次只运行一个写入者。证据目录 `~/open-gym-stage4-a7`，脚本 `~/a7-rehearsal.mjs`。

| 阶段 | 入口 | 写入前 readback | 新增 | 结果 rev | 最终训练 |
| --- | --- | --- | --- | ---: | --- |
| 1 旧版 | `server.js` @ `94777b4a` | 种子档案 | 训练 `w_legacy_a` + 媒体 `6b7fa434…` | 1 | `w_legacy_a`, `w_parity_1` |
| 2 Nest | 候选 `server.js`（薄入口） | 读到 `w_legacy_a` 与媒体字节 | 训练 `w_nest_b` + 媒体 `4fa89330…` | 2 | `w_legacy_a`, `w_nest_b`, `w_parity_1` |
| 3 旧版 | `server.js` @ `94777b4a` | 读到 `w_nest_b` 与媒体字节 | 训练 `w_legacy_c` | 3 | `w_legacy_a`, `w_legacy_c`, `w_nest_b`, `w_parity_1` |

- 每次 GET `/api/media/<hash>` 返回的字节 SHA-256 与文件名一致：`4fa89330625dff3a6bb86ff9bced6f1f15a92372265307d2d62c1f09814c49a9`、`6b7fa434f92a8b80aab02d9bf1a12e49ffcae424e4013a1c4f68b67e3d2bbcd0`。
- 每次切换前保留 `backup-after-legacy`、`backup-after-nest` 副本。
- 未覆盖：容器停机、镜像 digest、Nginx 前置。Docker 可用后按 HANDOFF §4 重跑并补记镜像 ID。

## 11. 发布验收用例状态

| 用例 | 状态 | 说明 |
| --- | --- | --- |
| A1 登录与设备 | **通过（自动化）** | 旧 Cookie / Bearer / Passkey / 设备链接 / 配对在 Linux 与 Windows 回归中通过 |
| A2 冲突与离线 | **通过（自动化部分）** | `409`、`baseWid`、离线补传的服务端语义通过；RN 设备部分见 §9 |
| A3 数据与缓存 | **通过** | 并发条件写入、同大小快速写入、损坏档案 `503`、`.bak` 回退 |
| A4 媒体 | **通过（自动化部分）** | 上传/下载/去重/跨账号/断流/清理；真实 RN/Web 媒体待设备 |
| A5 部署链路 | **待验证** | 需要 Docker + Nginx / TLS / LAN 环境 |
| A6 扩展 | **通过（自动化部分）** | Push、提醒、手表、集成、Coach、MCP、Linux 恢复 CLI；真实 Push/Webhook/Zepp 待现场 |
| A7 重启与回滚 | **部分通过** | 文件级演练通过；容器镜像切换待 Docker |
| A8 在线训练态 | **通过** | 70 秒 / 45 秒窗口、hidden 恢复、清理 |
| A9 模块与审计 | **通过** | 单实例 Provider、401/403 审计差异、Owner 清空 |
| A10 停机 | **通过** | Linux SIGTERM / SIGINT 与 Windows 显式 `app.close()`；Compose/K8s 宽限已配置 |
| A11 构建入口 | **部分通过** | 干净构建、三种入口、MCP、镜像载荷演练通过；镜像与 Nix 待环境 |

## 12. 需要的输入

1. **Docker**：安装 Docker Desktop 并在 WSL Ubuntu 启用集成，或提供可用的 Linux daemon / sudo 授权。用于三个 API 镜像、Web 镜像、Compose/Nginx 与容器内 A7。
2. **Nix**：sudo 授权安装 Nix，或提供已安装 Nix 的环境。用于 `nix build ./contrib/nix#opengym-api`。
3. **RN**：已用 `%LOCALAPPDATA%\OpenGymRnToolchain` 的 JDK 17 与 AVD `openGymRnQa` 完成配对、同步和离线补传。脚本 `handoff-tools/README.md` 记录了 `JAVA_HOME`、`ANDROID_AVD_HOME` 的启动方式。
4. **远端 CI**：授权推送候选分支后，用 Node 24 runner 记录 API/MCP 作业。
5. **正式切换**：目标实例当前镜像 digest、数据卷路径与维护窗口；本轮不涉及推送、发布和正式切换。

候选记录提交：写入本节后由本地提交记录，见 `git log -1`。
