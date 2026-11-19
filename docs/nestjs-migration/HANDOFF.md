# NestJS 阶段 4 执行交接单

从已迁移的服务端接着完成四项工作，依次为 Linux 基线、默认入口与 CI、镜像与客户端验证、数据卷回滚。交付点是本地候选提交、构建制品与验收记录。自托管正式切换、向远端推送和发布镜像须按用户另行给出的范围执行。[执行方案 §4](EXECUTION.md#阶段-4--切换入口制品ci-和升级演练) · [验收记录](ACCEPTANCE.md)

## 接手输入

| 输入 | 本机位置或版本 |
| --- | --- |
| 迁移起点 | Windows 仓库 `D:\dev\open-gym` 的本地分支 `handoff/nestjs-phase4`。源快照为 `a1023c4caa935bcec74d8235065fb0b6ce98aba7`，分支顶端包含本交接单和文档入口。 |
| 旧镜像来源 | `94777b4ada915c622baf5813af673646c123ebb9` 的 `api/Dockerfile`。用该提交构建本地旧镜像，记录镜像 ID。对目标部署做兼容演练时，另按该实例实际 digest 选择旧镜像。 |
| Linux | WSL 2 的 `Ubuntu`，现有普通用户 `zjzjn`。已确认 Linux Git、curl 可用。Linux Node、Docker、Nix 待配，当前 PATH 里的 Windows `npm` 不能作为 Linux 工具链。 |
| RN | Windows 上使用专用 Android 模拟器。APK 为 `D:\dev\open-gym\mobile-rn\dist\openGym-RN-0.1.6-five-tab.apk`，SHA-256 为 `A03A936B6C4197CD3BC308AEE89D3A45BC0588C3A28F7F61A124BE9F3F341DEF`。SDK 位于 `%LOCALAPPDATA%\OpenGymRnToolchain\android-sdk`。 |
| 已有证据 | Windows 双入口对照、91 路由和显式停机有记录。Linux 双入口、`SIGTERM` / `SIGINT` 和候选镜像结果待验证。[验收记录 §1–2](ACCEPTANCE.md) |

先阅读仓库 [AGENTS.md](../../AGENTS.md)、[执行方案](EXECUTION.md)、[契约测试](features/18_CONTRACT_TESTS.md) 和 [交付与回滚](features/19_DELIVERY_AND_ROLLBACK.md)。以下命令从 PowerShell 执行。Linux 检出、临时数据和日志保存在 Ubuntu 自己的文件系统内。

```powershell
function Invoke-OpenGymLinux([string] $Command) {
    wsl.exe -d Ubuntu --cd '~' -- bash -lc ($Command.Replace("`r`n", "`n"))
    if ($LASTEXITCODE -ne 0) { throw "WSL 命令退出码为 $LASTEXITCODE" }
}

Invoke-OpenGymLinux @'
set -euo pipefail
test "$(id -u)" -ne 0
git clone --no-local --depth 3 --single-branch --branch handoff/nestjs-phase4 \
  /mnt/d/dev/open-gym "$HOME/open-gym-stage4"
cd "$HOME/open-gym-stage4"
git merge-base --is-ancestor a1023c4caa935bcec74d8235065fb0b6ce98aba7 HEAD
git switch -c nestjs-phase4-work
git rev-parse HEAD
git status --short
'@
```

首次安装 Linux Node 时使用已核对的 Node 24.18.0 x64 官方包。后续 Linux 命令先设置同一个 `PATH`。Docker 可复用可用的 daemon，或按 [Docker Desktop WSL 指南](https://docs.docker.com/desktop/features/wsl/) 启用 Ubuntu 集成。Nix 在打包阶段按 [Nix 安装文档](https://nix.dev/install-nix) 准备。遇到系统授权或缺少凭据时，向用户说明具体提示，其余能执行的工作可继续。

```powershell
Invoke-OpenGymLinux @'
set -euo pipefail
node_root="$HOME/.local/opt/node-v24.18.0-linux-x64"
if [ ! -x "$node_root/bin/node" ]; then
  tmp="$(mktemp -d)"
  cd "$tmp"
  curl -fSsLO https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz
  curl -fSsLO https://nodejs.org/dist/v24.18.0/SHASUMS256.txt
  sha256sum --ignore-missing --check SHASUMS256.txt
  mkdir -p "$HOME/.local/opt"
  tar -xJf node-v24.18.0-linux-x64.tar.xz -C "$HOME/.local/opt"
fi
export PATH="$node_root/bin:$PATH"
command -v node npm
node --version
npm --version
'@
```

## 1. Linux 双入口基线

在替换 `server.js` 前，用同一次依赖安装比较两个入口。保存两份报告和各自的退出码。共同失败要逐项解释，新增失败先定位和复测。Windows 上跳过的 `SIGTERM`、`SIGINT` 在 Linux 报告中应实际执行。以 [API 和 MCP CI 作业](../../.github/workflows/test.yml) 的正式参数为准。

```powershell
Invoke-OpenGymLinux @'
set -euo pipefail
export PATH="$HOME/.local/opt/node-v24.18.0-linux-x64/bin:$PATH"
cd "$HOME/open-gym-stage4"
report="$(mktemp -d "$HOME/open-gym-stage4-baseline.XXXXXX")"
printf 'Evidence: %s\n' "$report"
{ git rev-parse HEAD; node -v; npm -v; sha256sum api/package-lock.json; } > "$report/environment.txt"
cd api
npm ci --omit=optional
npm run build
legacy_code=0
nest_code=0
API_ENTRY=server.js node --test --test-concurrency=6 --test-reporter=../scripts/ci/node-test-reporter.mjs \
  "--test-reporter-destination=$report/legacy.jsonl" test/*.test.js || legacy_code=$?
npm run test:nest -- --test-concurrency=6 --test-reporter=../scripts/ci/node-test-reporter.mjs \
  "--test-reporter-destination=$report/nest.jsonl" || nest_code=$?
printf 'Legacy exit=%s\nNest exit=%s\n' "$legacy_code" "$nest_code" | tee "$report/exit-codes.txt"
npm run test:nest -- test/nest/shutdown.test.js | tee "$report/shutdown.txt"
cd ../mcp
npm ci
CI=1 API_ENTRY=dist/src/main.js npm test | tee "$report/mcp.txt"
'@
```

按文件和测试名称比对两个 JSONL 的失败集合。将差异、信号测试是否跳过、MCP 端到端是否实际启动 Nest 写入 `ACCEPTANCE.md`，再进入第 2 项。需要远端 CI 记录时使用获授权的 runner，只有本机结果时注明环境。

## 2. 切换默认入口和 CI

按 [执行方案 §4.1–4.4](EXECUTION.md#41-切换-apiserverjs) 修改工作分支。先归档第 1 项证据，再把 `api/server.js` 收敛为加载 Nest 编译产物的入口，迁移仍绑旧源码的断言。将 API 和 MCP 集成作业、API 的 `@types/node` 与锁文件对齐到 Node 24。

验收 `node server.js`、`npm start` 和 `node dist/src/main.js` 从同一构建启动，`PORT=0` 打印实际端口，OpenAPI 核对 91/91，API 与 MCP 全量通过。提交候选代码并记录 SHA，之后 Windows 和 Linux 都使用这份候选代码。

## 3. 候选镜像、Nix 和客户端

> **范围调整（2026-11-19）**：Nix/NixOS 本轮不纳入。`contrib/nix/api.nix` 已随入口切换更新，但不做构建验收；恢复时按本节原来的 Nix 步骤补验。Docker 与客户端验收不受影响。

- 在候选提交运行 `docker info`、`docker compose version` 确认工具链，构建 `default`、`coach` 和无 target 三个镜像，分别使用本地标签 `opengym-handoff-api:nest-default`、`opengym-handoff-api:nest-coach`、`opengym-handoff-api:nest-published`，另构建 `opengym-handoff-web:test`。用 `docker image inspect` 记录镜像 ID 和可用的仓库 digest。依照镜像 CI 验证健康、Nginx 代理、可选 Coach 依赖和两个 target 的 `node recover.js <测试账号>`。
- ~~在候选提交运行 `nix --extra-experimental-features 'nix-command flakes' build ./contrib/nix#opengym-api`。~~（本轮不纳入；恢复时用独立测试 `DATA_DIR` 启动 `result/bin/opengym-api`，核对 Node 主版本、恢复命令与健康检查。）[Nix 构建说明](../NIX.md)
- 用 WSL 检出的 `git archive <候选 SHA>` 导出到 Windows 新目录，在其中构建 `api/dist`，再用以下脚本验证配对、同步和离线补传。脚本会启动 Windows 上的 Nest loopback，第 4 项另用同一个测试客户端连接 Linux Compose。脚本会安装 APK，指定专用模拟器。需要重置时只清理专用测试设备上的 openGym 数据。[Android 工具与验收](../RN_ANDROID_EXECUTION.md)

```powershell
# 在 Windows 的候选代码目录中执行。
npm.cmd --prefix .\api ci --omit=optional
npm.cmd --prefix .\api run build
$adb = Join-Path $env:LOCALAPPDATA 'OpenGymRnToolchain/android-sdk/platform-tools/adb.exe'
$apk = 'D:\dev\open-gym\mobile-rn\dist\openGym-RN-0.1.6-five-tab.apk'
& $adb devices -l
# 将 <测试模拟器序列号> 替换为实际专用设备，例如 emulator-5564。
.\mobile-rn\scripts\android-regression.ps1 -Apk $apk -Serial '<测试模拟器序列号>' -Adb $adb
```

## 4. 用独立数据卷演练回滚

1. 在 WSL 工作仓库用 `git worktree add --detach "$HOME/open-gym-stage4-legacy" 94777b4ada915c622baf5813af673646c123ebb9` 创建旧版检出。运行 `docker build -t opengym-handoff-api:legacy "$HOME/open-gym-stage4-legacy/api"`。固定旧镜像和候选镜像 ID，整个演练复用同一个 Web 镜像、Origin、RP ID 和配置。
2. 在 Ubuntu 创建独立演练目录。复制候选 `docker-compose.yml` 和 `.env.example` 分别作为该目录的 `docker-compose.yml` 和 `.env`，在其中创建 `data`、`coach-auth`。设置 `WEB_PORT=18080`、`ORIGIN=http://localhost:18080`、`RP_ID=localhost`、`MEDIA_UPLOADS=1` 和 `COACH_DISABLED=1`。用下面的覆盖配置选定本地镜像。这个入口供 A7 使用，A5 的 HTTPS、子路径和 LAN 分项验证并保留代理及客户端证据。[部署验收](features/19_DELIVERY_AND_ROLLBACK.md#32-nginx--compose)
3. 首次用旧镜像启动。通过测试浏览器注册合成账号，用 [WebAuthn 虚拟认证器](https://developer.chrome.com/docs/devtools/webauthn/) 创建可登录的 Passkey，保留该会话和认证器。在 Windows 确认 `http://localhost:18080/api/health` 可访问，然后用 `adb -s <测试模拟器序列号> reverse tcp:18080 tcp:18080` 把专用 RN 模拟器接到 `http://127.0.0.1:18080`，兑换测试配对码。生成一笔训练和一张合成图片，确认训练引用和媒体都可读。[进度照片流程](../rn-p2/progress/07_PROGRESS_PHOTOS.md) · [媒体测试样本](../../api/test/media-samples.mjs)
4. 停止旧 API，备份该测试卷和配置，再让 Nest 镜像接管同一个卷。验证旧 Cookie、已配对 Bearer、Passkey 和媒体仍可用。在 Nest 上保存另一笔带媒体引用的训练。留存训练 ID、媒体文件 SHA-256 和请求结果，凭据留在测试环境。
5. 通过容器正常停机让旧镜像重新接管这份当前卷。旧服务应读到 Nest 新增的训练并取回相同媒体，再成功写入一笔测试数据。任何失败先保存日志和当前测试卷，从备份副本重新演练。一次只启动一个写入该卷的 API。

在演练目录保存 `compose.handoff.yaml`，与基础文件一起使用。

```yaml
services:
  api:
    image: ${OPENGYM_HANDOFF_API_IMAGE:?choose rehearsal image}
    pull_policy: never
  web:
    image: opengym-handoff-web:test
    pull_policy: never
```

通过 `Invoke-OpenGymLinux` 在演练目录运行。项目名可换成未占用的本地名称，同一轮三次启动沿用该名称。每次进入新 shell 时重新设置镜像变量和 Compose 命令。

```bash
export OPENGYM_HANDOFF_API_IMAGE=opengym-handoff-api:legacy
compose=(docker compose -p opengym-nestjs-a7 -f docker-compose.yml -f compose.handoff.yaml)
"${compose[@]}" config
```

核对 `config` 中两个挂载都位于演练目录、镜像名正确后，使用同一组变量运行 `"${compose[@]}" up -d --no-build`。用 `curl -fsS http://localhost:18080/api/health` 验证启动，用 `docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)"` 核对容器镜像 ID。每次切换前运行 `"${compose[@]}" stop -t 15 api` 并保存日志，再更换 `OPENGYM_HANDOFF_API_IMAGE`。候选使用 `opengym-handoff-api:nest-default`，回滚切回旧标签。

将候选 SHA、测试报告、镜像 ID / digest、恢复和停机耗时、数据与媒体证据写入 [ACCEPTANCE.md](ACCEPTANCE.md)。按 [发布验收表 A1–A11](EXECUTION.md#62-发布验收用例) 给出通过、失败或待验证。涉及尚未提供的现场环境、设备或授权时，写明待验证项及所需输入。
