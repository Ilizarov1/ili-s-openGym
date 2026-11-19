# NestJS 迁移验收记录

- 记录时间：2026-11-19
- 代码版本：基于 `94777b4ada915c622baf5813af673646c123ebb9` 的迁移工作区，含本次评审修订。
- 本机环境：Windows，Node v24.18.0，npm 11.16.0。专项另使用 Node v22.23.4。
- 测试数据：独立临时数据目录和合成账号。
- 结论：本机已验证停机和双入口对照。阶段 3 仍需 Linux 双入口及信号验收。阶段 4 的镜像、默认入口切换和 A7 演练以此为前置。

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
