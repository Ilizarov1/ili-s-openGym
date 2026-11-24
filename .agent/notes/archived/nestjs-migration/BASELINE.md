# NestJS 迁移基线记录

记录时间：2026-11-19（执行阶段 0.1）

## 代码与环境

| 项目 | 值 |
| --- | --- |
| 仓库 | `D:\dev\open-gym` |
| 基线提交 | `94777b4ada915c622baf5813af673646c123ebb9` |
| 分支 | `main`（迁移分支约定为 `feat/nestjs-api`） |
| Node（开发机） | v24.18.0（CI / 镜像仍为 Node.js 22） |
| npm | 11.16.0 |
| `api/package-lock.json` SHA-256 | `d82cd91563248535b0752b721ce7dbd0f0ada2b8c3c66ddddf06264612df9a07` |
| API 测试文件数 | 100 |

基线记录的依赖为 `@nestjs/common` / `@nestjs/core` / `@nestjs/platform-node` `12.5.1`、`reflect-metadata ^0.2.2`、`rxjs ^7.8.1`、`typescript ^5.7.2` 和 `@types/node ^22.10.0`。阶段 4 将使用 Linux / Node.js 24 更新和验证锁文件，见 [执行方案](./EXECUTION.md#44-ci)。

## 部署输入

目标自托管实例的镜像 digest、Compose 项目名、数据卷路径与真实密钥不在仓库记录。切换前按 EXECUTION.md 第 8.1 节现场记录，不写入仓库。仓库内的兼容基线：

- 单副本、单写者，单一 `DATA_DIR`。
- `default` 与 `coach` 两个镜像 target。
- Nginx 只代理 `/api` 与 `/api/media`。
- 配置开关：`INVITE_ONLY`、`PASSWORD_LOGIN`、`MEDIA_UPLOADS`、`INTEGRATIONS`、`COACH_DISABLED`、`AUDIT_LOG`、`AUDIT_IP`、`TRUST_PROXY`。

## 路由快照（91）

来源：`api/openapi.yaml` 的 `paths`，与旧入口 `api/server.js`、`api/coach/routes.js`、`api/integrations/routes.js` 的路由表一一对应。

```text
GET /api/health
GET /api/config
GET /api/me
POST /api/register/options
POST /api/register/verify
POST /api/login/options
POST /api/login/verify
POST /api/logout
POST /api/logout/all
POST /api/account/delete
POST /api/pair/create
POST /api/pair/redeem
POST /api/watch/pair
POST /api/watch/redeem
GET /api/watch/links
POST /api/watch/unlink
PUT /api/watch/snapshot
GET /api/watch/events
POST /api/watch/ack
GET /api/watch/box
POST /api/watch/box
POST /api/login/password
POST /api/register/password
POST /api/login/password-reset
GET /api/account/password
POST /api/account/password
DELETE /api/account/password
POST /api/account/email
DELETE /api/account/email
POST /api/admin/user/recovery
POST /api/admin/user/password-reset
GET /api/account/passkeys
DELETE /api/account/passkeys
POST /api/account/passkeys/options
POST /api/account/passkeys/verify
POST /api/account/passkeys/rename
POST /api/account/device-link
POST /api/device-link/options
POST /api/device-link/verify
GET /api/data
PUT /api/data
GET /api/data/rev
GET /api/nudge-check
GET /api/media/{hash}
PUT /api/media/{hash}
POST /api/media/missing
POST /api/media/sweep
GET /api/push/public-key
POST /api/push/subscribe
GET /api/push/status
POST /api/push/unsubscribe
POST /api/push/test
POST /api/push/rest-timer
POST /api/push/rest-timer/cancel
GET /api/integrations
POST /api/integrations/connect
POST /api/integrations/update
POST /api/integrations/disconnect
POST /api/integrations/test
POST /api/integrations/retry
GET /api/integrations/log
POST /api/activity
GET /api/admin/users
GET /api/admin/user
POST /api/admin/user/disable
POST /api/admin/user/delete
POST /api/admin/user/role
POST /api/admin/owner
GET /api/admin/invites
POST /api/admin/invites/new
POST /api/admin/invites/revoke
GET /api/admin/audit
POST /api/admin/audit/clear
GET /api/coach/disclosure
GET /api/coach/status
POST /api/coach/plan
POST /api/coach/review
POST /api/coach/ask
POST /api/coach/adapt
POST /api/coach/debrief
POST /api/coach/pending/resolve
GET /api/coach/cohort
POST /api/coach/cohort/share
GET /api/coach/account
POST /api/coach/forget
GET /api/admin/coach
POST /api/admin/coach/config
POST /api/admin/coach/test
POST /api/admin/coach/models
POST /api/admin/coach/connect
POST /api/admin/coach/disconnect
```

## 测试基线

旧入口全量测试的记录方式：

```powershell
Set-Location api
npm.cmd ci --omit=optional
npm.cmd test
```

阶段 0.2 完成后，`api/test/helpers.mjs` 导出 `API_ENTRY = process.env.API_ENTRY || 'server.js'`；所有启动服务器的用例通过该常量选择入口。`npm test` 仍运行旧入口，`npm run test:nest` 使用编译后的 `dist/src/main.js`。

复核使用 [验收记录](ACCEPTANCE.md#2-全量双入口回归) 的两份报告，按文件和测试名称比较失败项。两侧从同一份工作区、同一依赖和同一 Node 环境启动。兼容性夹具的旧侧固定为 `server.js`。

## 数据卷夹具

测试与演练只使用脱敏数据：`db.json`（账号、凭据、订阅、邀请）、`secret`、`vapid.json`、`state-<uid>.json`、`watch-<uid>.json`、`audit.log`、`uploads/`、`integrations/`、Coach 配置与任务。真实用户数据不提交。夹具由 `api/test/nest/parity.mjs` 的 `seedData` 生成。
