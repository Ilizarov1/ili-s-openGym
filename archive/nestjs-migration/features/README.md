# openGym 服务端 NestJS 迁移 · 功能点执行文档索引

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 设计依据：[DESIGN.md](../DESIGN.md)
- 状态：阶段 0–3 已实现待验证（见 [ACCEPTANCE.md](../ACCEPTANCE.md)）；阶段 4 待执行

本目录把迁移方案拆成可以单独开发、单独评审、单独验收的功能点。每个文档只覆盖一个功能域，包含该域的现状、兼容点、执行步骤、测试和验收目标。阶段顺序仍以上级方案为准，本文档只细化“每个功能点具体怎么做”。

## 1. 使用方式

1. 先读 [EXECUTION.md](../EXECUTION.md) 的阶段 0–4 和兼容基线，再看本文档的依赖图。
2. 按文档编号顺序推进；01–03 先于业务文档完成，18 贯穿测试，19 在最后。
3. 每完成一个文档中的步骤，更新该文档的复选框和“验收记录”小节，并在 PR 描述中链接对应文档。
4. 文档中的路由清单必须与 `api/openapi.yaml` 的 91 个 operation 保持一一对应；新增或遗漏路由先改 OpenAPI，再改 Controller。
5. 完成顺序只由依赖和阶段门禁决定。

## 2. 文档清单

| 文档 | 功能点 | 阶段 | 依赖 | 自有路由 | 主要验收 |
| --- | --- | --- | --- | --- | --- |
| [01_BUILD_AND_BOOTSTRAP.md](01_BUILD_AND_BOOTSTRAP.md) | Nest 依赖、TypeScript 构建、`dist` 产物、启动入口 | 1 | 阶段 0 基线 | 0 | G1、G7、A11 |
| [02_HTTP_COMPATIBILITY.md](02_HTTP_COMPATIBILITY.md) | 请求钩子、CORS、预检、请求体、超时、错误、404、响应头 | 1 | 01 | 0（作用于全部） | G2、A5 |
| [03_PERSISTENCE.md](03_PERSISTENCE.md) | 配置、路径、密钥、原子写入、账户库、状态缓存 | 1–2 | 01 | 0 | G3、G5、A3、A9 |
| [04_SYSTEM.md](04_SYSTEM.md) | `/api/health`、`/api/config` | 1 | 02、03 | 2 | G1、A5 |
| [05_SESSION_AND_ACCESS.md](05_SESSION_AND_ACCESS.md) | 会话、Cookie / Bearer、CSRF、限流、Guard、`/api/me`、注销 | 2 | 03、09 | 3 | A1、A9 |
| [06_AUTHENTICATION.md](06_AUTHENTICATION.md) | Passkey、密码登录、注册、重置登录、设备链接入口 | 2 | 03、05 | 9 | A1 |
| [07_ACCOUNT_SETTINGS.md](07_ACCOUNT_SETTINGS.md) | 账户密码 / 邮箱 / Passkey 管理、设备链接、账户删除 | 2 | 05、06 | 12 | A1、A4 |
| [08_ADMIN_AND_INVITES.md](08_ADMIN_AND_INVITES.md) | 管理用户、角色、Owner、邀请、恢复、审计接口 | 2 | 05、06、07、09 | 13 | A1、A9 |
| [09_AUDIT_AND_PRESENCE.md](09_AUDIT_AND_PRESENCE.md) | 审计记录和在线训练态 | 2 | 03 | 1 | A8、A9 |
| [10_PAIRING.md](10_PAIRING.md) | Web 生成配对码、RN 兑换、账户隔离 | 2 | 05、06 | 2 | A1 |
| [11_SYNC.md](11_SYNC.md) | `GET/PUT /api/data`、修订查询、`409`、缓存、`stampPut` | 2 | 03、05 | 3 | A2、A3 |
| [12_MEDIA.md](12_MEDIA.md) | 媒体上传、下载、缺失、清理 | 3 | 05、07、11 | 4 | A4 |
| [13_NOTIFICATIONS.md](13_NOTIFICATIONS.md) | Push、提醒、年度总结、`nudge-check` | 3 | 03、05、09 | 8 | A6、A8 |
| [14_WATCH.md](14_WATCH.md) | Zepp 配对、设备令牌、快照、事件队列 | 3 | 05 | 9 | A6 |
| [15_INTEGRATIONS.md](15_INTEGRATIONS.md) | Webhook 连接、事件入队、持久 outbox、重试 | 3 | 03、11 | 7 | A6、A10 |
| [16_COACH.md](16_COACH.md) | Coach 用户 / 管理接口、任务、调度、凭据、提案通知 | 3 | 05、13 | 18 | A6 |
| [17_LIFECYCLE_AND_RECOVERY.md](17_LIFECYCLE_AND_RECOVERY.md) | 启动顺序、排空、信号、计时器、恢复 socket / CLI | 3 | 09、12–16 | 0 | A10、A6 |
| [18_CONTRACT_TESTS.md](18_CONTRACT_TESTS.md) | `API_ENTRY`、差异对照、路由矩阵、源码断言、CI | 0–4 | 01、02 | 0 | G2、G3、A11 |
| [19_DELIVERY_AND_ROLLBACK.md](19_DELIVERY_AND_ROLLBACK.md) | 镜像、CI、Nix、Helm / K8s、文档、切换 / 回滚 | 4 | 01–18 | 0 | A5、A7、A11 |

“依赖”表示执行顺序和验证前置，不全是 Nest 模块的 import 方向；模块 import 方向仍以 `EXECUTION.md` 第 2.3 节为准。

## 3. 依赖顺序

```text
01 构建与启动
 └─ 02 HTTP 兼容层
     ├─ 03 持久化
     │   ├─ 04 System
     │   └─ 09 审计与在线态
     └─ 05 会话与访问控制（依赖 03、09）
         └─ 06 认证
             ├─ 07 账户设置
             │   └─ 08 管理接口（另依赖 09）
             ├─ 10 配对
             └─ 11 同步
                 ├─ 12 媒体
                 ├─ 13 通知
                 ├─ 14 手表
                 ├─ 15 集成
                 └─ 16 Coach（依赖 05、13）
17 生命周期与恢复（依赖 09、12–16）
18 契约测试贯穿 01–17
19 交付与回滚在 01–18 之后
```

图中的缩进表示建议顺序，不全是硬依赖；硬依赖以第 2 节表格为准。`11` 在阶段 2 可以先直接调用现有 `media.js` / `integrations` 实例；`12`、`15` 迁移后再替换为 Provider。`16` 的提案通知由生命周期协调器连接，不由 Coach 反向导入 Notifications。

## 4. 路由覆盖核对

各功能文档的路由合计必须为 91：

| 文档 | 路由数 | 路由摘要 |
| --- | --- | --- |
| 01 构建与启动 | 0 | 无 HTTP 路由 |
| 02 HTTP 兼容层 | 0 | 作用于全部路由 |
| 03 持久化 | 0 | 无 HTTP 路由 |
| 04 System | 2 | health、config |
| 05 会话与访问 | 3 | me、logout、logout/all |
| 06 认证 | 9 | register / login / password / password-reset / device-link 入口 |
| 07 账户设置 | 12 | account password、email、passkeys、device-link、delete |
| 08 管理与邀请 | 13 | admin users、roles、invites、audit、password-reset |
| 09 审计与在线态 | 1 | activity |
| 10 配对 | 2 | pair/create、pair/redeem |
| 11 同步 | 3 | data、data/rev、PUT data |
| 12 媒体 | 4 | media PUT / GET、missing、sweep |
| 13 通知 | 8 | push 7 个、nudge-check |
| 14 手表 | 9 | watch pair / redeem / links / unlink / snapshot / events / ack / box |
| 15 集成 | 7 | integrations 列表 / 连接 / 更新 / 断开 / 测试 / 重试 / 日志 |
| 16 Coach | 18 | coach 用户 12、admin coach 6 |
| 17 生命周期与恢复 | 0 | 无 HTTP 路由 |
| 18 契约测试 | 0 | 无 HTTP 路由 |
| 19 交付与回滚 | 0 | 无 HTTP 路由 |
| **合计** | **91** | 与 `api/openapi.yaml` 一致 |

每次改动 Controller 后运行第 18 号文档中的路由矩阵测试；数字不匹配时先修 OpenAPI 或 Controller，不要修改这里的合计来掩盖差异。

## 5. 文档模板

每个功能文档至少包含：

1. **背景与目标**：该功能点保护的用户行为、现有实现位置和迁移目标。
2. **范围与兼容点**：包含 / 不包含的路由或后台任务，旧行为中不能改变的部分。
3. **执行步骤**：按可独立提交的顺序列出文件、Provider、Controller、Guard、计时器和清理路径。
4. **测试**：现有测试、需要新增的测试、运行命令和测试数据。
5. **验收目标**：可观察结果和对应 A 用例 / G 目标。
6. **风险与回退**：该功能点独有的失败模式和回退方式。

## 6. 状态记录

在每份文档末尾维护：

```text
状态：待执行 / 进行中 / 已实现待验证 / 已验收
代码版本：
测试命令与结果：
验收证据：
遗留问题：
```

状态只在对应阶段的退出条件通过后改为“已验收”；代码完成但未跑完 A 用例时写“已实现待验证”。
