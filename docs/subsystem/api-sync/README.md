# 子系统路由：`api-sync`（NestJS 后端、认证、存储、同步与外部集成）

> 返回总路由：[AGENTS.md](../../../AGENTS.md) · [docs/README.md](../../README.md) · 工程规范：[code-standards.md](../../code-standards.md)

## 1. 职责与边界

负责服务端 HTTP API 网关与业务路由（NestJS 架构，`api/server.js` 引导加载编译产物）、WebAuthn Passkeys 与密码认证、移动端一次性配对码/二维码会话签发、基于 `DATA_DIR` 的原子化 JSON 存储、多设备修订号（Revision）与字段级时间戳（Stamp）冲突合并同步、Web Push 通知及外部 Webhook 集成。

- **AI 相关后端模块**（`api/coach/`、`api/agent-runtime/`、`api/src/agent/`）详见 [`ai-agent`](../ai-agent/README.md)。
- **容器化与反向代理部署**详见 [`infra-ops`](../infra-ops/README.md)。

## 2. 代码入口与目录映射

| 路径 | 职责说明 |
|---|---|
| `api/server.js`、`api/src/` | 服务启动入口、NestJS 模块/控制器/守卫与路由分发 |
| `api/openapi.yaml` | **HTTP 接口唯一权威契约**（与实际路由通过 `openapi-routes.test.js` 强绑定校验） |
| `api/durable.js`、`api/media.js` | `DATA_DIR` 下的 `db.json`、`state-<uid>.json` 临时文件写入+原子重命名持久化，以及用户自定义动作媒体存储 |
| `api/sync-stamps.js` | 服务端字段级同步时间戳校验与 409 冲突载荷生成（与 `frontend/src/lib/sync-merge.js` 对偶） |
| `api/integrations/` | 外部集成连接加密存储（`DATA_DIR/integrations/`）、投递队列与签名 Webhook（Home Assistant / n8n / ntfy） |
| `api/test/` | 基于 `node:test` 的接口契约测试、同步对偶测试、鉴权与 NestJS 兼容性回归套件 |

## 3. 核心契约与不变式

1. **OpenAPI 契约先行**：新增、修改或废弃任何 HTTP 路由/字段，必须同步更新 `api/openapi.yaml`，并运行 `node scripts/build-api-docs.mjs` 更新静态 API 文档（CI 执行 `--check` 门禁）。
2. **原子化持久化**：所有落盘状态必须经过 temp-then-rename 写入，严禁原地截断覆写 `db.json` 或 `state-<uid>.json`。
3. **409 同步语义不可破坏**：客户端携带上次已知 `rev` 提交变更；若版本落后必须返回 `409` 及最新文档供客户端按字段级时间戳合并重试，且已删除项的删除墓碑时间戳不得被旧状态复活。
4. **安全与 SSRF 边界**：会话密钥、集成凭据与 AI 密钥严禁进入响应体或审计日志；出站 Webhook 默认拒绝内网与回环地址（仅受 `INTEGRATIONS_ALLOW_LAN` / `ALLOWED_PRIVATE_IPS` 显式白名单控制）。

## 4. 常用验证命令（PowerShell）

```powershell
# 编译后端（如有 TS 改动）并运行后端全量测试
cd api; npm.cmd test

# 校验 openapi.yaml 与生成的官网 API 文档是否同步
node scripts/build-api-docs.mjs --check
```

## 5. 文档与历史需求路由

- [HTTP API 说明](../../API.md) · [OpenAPI 规范源文件](../../../api/openapi.yaml)
- [系统架构与同步协议图解](../../ARCHITECTURE.md)
- [外部服务与 Webhook 集成指南](../../INTEGRATIONS.md)
- [安全模型与漏洞报告规范](../../../SECURITY.md)
- **历史归档**：[NestJS 后端迁移设计、19 项特性对齐与验收记录](../../../.agent/notes/archived/nestjs-migration/ACCEPTANCE.md)（含 [特性目录](../../../.agent/notes/archived/nestjs-migration/features/README.md)）
