# 子系统路由：`infra-ops`（部署运维、容器编排、官网与 CI 发布）

> 返回总路由：[AGENTS.md](../../../AGENTS.md) · [docs/README.md](../../README.md) · 工程规范：[code-standards.md](../../code-standards.md)

## 1. 职责与边界

负责 openGym 的自托管容器化交付（Docker Compose、Nginx 同源反向代理）、多平台部署方案（Helm / Kubernetes / NixOS / macOS Colima）、项目官网（`opengym.ch`）与边缘故障切换（Cloudflare），以及 GitHub Actions / GitLab 镜像同步、构建检查与发布流水线。

## 2. 代码入口与目录映射

| 路径 | 职责说明 |
|---|---|
| `docker-compose.yml`、`.env.example` | 自托管标准编排入口与全量环境变量说明 |
| `web/`、`api/Dockerfile` | 前端多阶段构建 + Nginx 静态托管与 `/api` 同源反代（满足 WebAuthn Passkeys 同源要求） |
| `helm/`、`kubernetes/`、`contrib/nix/` | Helm Chart、Kubernetes 清单与原生 NixOS Flake / Module 部署配置 |
| `website/`、`scripts/build-api-docs.mjs` | 官网静态源码与从 `api/openapi.yaml` 确定性生成的 `website/api.html` |
| `cloudflare/` | 官网与公共演示站点的边缘路由与故障切换脚本 |
| `.github/workflows/`、`.gitlab-ci.yml`、`fastlane/` | PR 路径过滤门禁（`test.yml`）、iOS 编译、Docker 镜像双仓发布、GitLab 镜像同步与商店元数据 |
| `scripts/` | 跨模块构建校验、CI 报告统计与发版辅助工具 |

## 3. 核心契约与不变式

1. **Passkeys 同源代理**：`web/` Nginx 容器必须将前端静态资源与 `/api` 聚合在同一 `ORIGIN` 与 `RP_ID` 下，任何反代模板改动不得破坏 WebAuthn 凭据域名绑定。
2. **数据卷唯一持久化点**：容器内 `DATA_DIR` 固定为 `/data`（映射宿主机 `./data`），镜像升级或重建严禁清理或改写宿主机数据目录结构。
3. **确定性构建检查**：`website/api.html` 等生成产物在 CI 中执行 `--check` 字节级比对（读取 `website/index.html` 的 `?v=` 版本号），严禁植入动态时间戳导致无变更分支变红。
4. **GitHub 为唯一主仓**：`.github/workflows/mirror.yml` 单向快进同步至 GitLab 镜像，禁止直接在镜像仓合并产生分叉。

## 4. 常用验证命令（PowerShell）

```powershell
# 本地启动完整自托管容器栈
Copy-Item .env.example .env -ErrorAction SilentlyContinue
docker compose up -d --build

# 运行跨仓构建一致性检查（CI 同款门禁）
node scripts/catalogue/build.mjs --check
node scripts/build-coach-assets.mjs --check
node scripts/build-api-docs.mjs --check
```

## 5. 文档路由

- [Docker 自托管完整指南（含反代、备份与排障）](../../SELF_HOSTING.md)
- [家庭局域网 HTTPS 证书配置](../../SELF_HOSTING_HTTPS.md)
- [macOS（Colima + Tailscale）自托管指南](../../SELF_HOSTING_MAC.md)
- [Kubernetes 部署指南](../../SELF_HOSTING_KUBERNETES.md) · [Helm Chart 参数说明](../../../helm/README.md)
- [NixOS 原生部署指南](../../NIX.md)
- [常见问题解答（FAQ）](../../FAQ.md)
- [构建与发布脚本索引](../../../scripts/README.md) · [官网源码维护说明](../../../website/README.md)
- [贡献指南与 PR 门禁说明](../../../CONTRIBUTING.md) · [安全策略](../../../SECURITY.md)
