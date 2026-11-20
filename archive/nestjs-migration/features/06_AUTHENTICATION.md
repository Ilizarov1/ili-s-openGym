# 06 · 认证入口（Passkey / 密码 / 设备链接）

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 2（账户、认证、审计、在线态和同步）
- 依赖：[05 会话与访问控制](05_SESSION_AND_ACCESS.md)、[03 持久化](03_PERSISTENCE.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §3、§4
- 代码落点：`api/src/auth/`、`api/src/accounts/`
- 自有路由：9
- 状态：待执行

## 1. 背景与目标

认证入口是升级兼容的核心：旧 Web 会话、旧 RN Bearer 和旧 Passkey 必须继续工作，同时新注册、密码登录、重置和设备链接的行为不能变化。认证入口还负责：

- 生成和消费 Passkey challenge。
- 处理邀请码、`INVITE_ONLY`、`FIRST_USER_ADMIN`。
- 对密码做 scrypt 哈希、重哈希和限流。
- 生成 / 验证一次性设备链接。
- 给成功登录签发与旧入口相同的会话 Cookie / Bearer。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/register/options` | 创建 Passkey 注册挑战 |
| `POST` | `/api/register/verify` | 验证 Passkey 注册 |
| `POST` | `/api/login/options` | 创建 Passkey 登录挑战 |
| `POST` | `/api/login/verify` | 验证 Passkey 登录 |
| `POST` | `/api/login/password` | 密码登录（仅 `PASSWORD_LOGIN=1`） |
| `POST` | `/api/register/password` | 密码注册（仅 `PASSWORD_LOGIN=1`） |
| `POST` | `/api/login/password-reset` | 用重置码登录并设置新密码 |
| `POST` | `/api/device-link/options` | 生成一次性设备链接 |
| `POST` | `/api/device-link/verify` | 验证设备链接并签发会话 |

管理员的 `POST /api/admin/user/password-reset` 由 08 号文档负责，但必须复用本功能的密码重置服务。

## 3. 现状与兼容点

### 3.1 Passkey

- 使用 `@simplewebauthn/server`，挑战存内存 `Map`，5 分钟过期、最多 20000 条，60 秒清理一次。
- `RP_ID`、`ORIGIN` 必须与部署配置一致；HTTPS / LAN 下不能混用。
- 注册：
  - 需要邀请码或开放注册；`INVITE_ONLY` 时邀请码消费一次。
  - 空实例第一个用户按 `FIRST_USER_ADMIN` 成为 Owner。
  - 用户名去重、长度限制、邮箱可选。
- 登录：
  - 按用户名 / 邮箱找目标；不泄露“用户是否存在”。
  - 验证签名、挑战、计数器、`sv`；失败计入限流和审计。
- challenge 和配对码一样，进程重启后由客户端重新发起，不落盘。

### 3.2 密码

- 仅在 `PASSWORD_LOGIN=1` 时注册路由；关闭时这些路由必须表现为不存在（404）。
- 哈希使用 [password.js](../../../api/password.js) 的 scrypt 参数和队列。
- 旧 hash 参数升级时在原密码可用的情况下重哈希。
- 失败按地址 / 账户计数；`BusyError` 返回 503 和 `Retry-After: 2`。
- 密码注册仍要检查邀请码、姓名和邮箱占用；不能因为密码路径绕过邀请限制。

### 3.3 重置码

- 管理员或恢复 CLI 生成一次性重置码；哈希存储，一天有效。
- `/api/login/password-reset` 用重置码登录并设置新密码。
- 重置成功后使旧会话失效（增加 `sv`），并清理未消费的重置码。
- 旧的密码、Passkey、设备链接行为不能因重置而被绕过。

### 3.4 设备链接

- `/api/device-link/options` 需要会话和 Owner 二次确认（`proveOwner`）。
- `/api/device-link/verify` 使用请求体中的一次性链接，不依赖 Cookie。
- 链接哈希存储、过期、消费后拒绝；验证成功后签发新会话。
- 设备链接不产生管理权限；角色仍由账户决定。

## 4. 执行步骤

### 4.1 PasskeyService

- [ ] 新增 `api/src/auth/passkey.service.ts`，包装 [passkeys-store.js](../../../api/passkeys-store.js)：
  - `createRegistrationOptions(user, invite, req)`。
  - `verifyRegistration(response, challenge, req)`。
  - `createLoginOptions(target, req)`。
  - `verifyLogin(response, challenge, req)`。
  - 挑战 Map（5 分钟过期、最多 20000 条）、60 秒清理、`RP_ID` / `ORIGIN` 校验。
  - 计数器更新、凭据保存、`MAX_PASSKEYS` 限制。
- [ ] challenge 只存内存；进程重启后客户端重新请求。
- [ ] 失败错误使用旧业务码 / 文案；不要把 WebAuthn 原始错误直接返回给客户端。
- [ ] 注册 / 登录成功后调用 `SessionService.makeSession`，Cookie / Bearer 规则由 05 负责。

### 4.2 RegistrationService

- [ ] 新增 `api/src/auth/registration.service.ts`：
  - 解析姓名、邮箱、邀请码。
  - `INVITE_ONLY` 检查、邀请码消费、地址限流。
  - `FIRST_USER_ADMIN`：空实例第一个用户成为 Owner。
  - 姓名 / 邮箱占用检查；邮箱规范化。
  - 创建用户、审计、会话。
- [ ] 邀请码消费必须与用户创建在同一个保存流程中；失败不能烧掉邀请码，除非旧入口就是如此。
- [ ] 新用户默认字段与旧入口一致（`created`、`sv`、`admin`、`owner` 等）。

### 4.3 LoginService

- [ ] 新增 `api/src/auth/login.service.ts`：
  - 按用户名 / 邮箱定位目标，不泄露存在性。
  - Passkey 登录、密码登录共用会话签发和审计。
  - 禁用账户返回旧状态码 / 文案。
  - 失败计入限流；成功清除失败计数。
- [ ] 保留 `WRONG = { error: 'wrong name or password', code: 'bad-credentials' }` 等旧响应。
- [ ] 密码登录在异步 scrypt 完成后再次确认用户、密码记录和会话版本未变（见 05 的 `recheckSession`）。

### 4.4 PasswordService

- [ ] 新增 `api/src/auth/password.service.ts`，包装 [password.js](../../../api/password.js)：
  - `hash`、`verify`、`needsRehash`、`passwordProblem`、`normalizeEmail`。
  - scrypt 队列和 `BusyError`。
  - 密码策略错误码与旧入口一致。
- [ ] 密码注册 / 登录 / 重置共用该 Service，禁止在 Controller 内直接调用 scrypt。
- [ ] 重哈希只在密码验证成功且记录未变时保存。

### 4.5 DeviceLinkService

- [ ] 新增 `api/src/auth/device-link.service.ts`，包装 [device-link.js](../../../api/device-link.js)：
  - `createLink(user)`：生成一次性链接，哈希存储，返回明文给调用方。
  - `verifyLink(code)`：哈希查找、过期、消费、账户有效。
  - `dropLinks(uid)`：账户删除 / 注销全部时清理。
- [ ] `/api/device-link/options` 需要 Owner 二次确认；`/verify` 不需要 Cookie，但仍走 CSRF 豁免和限流。
- [ ] 设备链接成功后签发会话，不提升角色。

### 4.6 路由与可选注册

- [ ] 新增 `AuthController`（或按注册 / 登录拆成两个 Controller）。
- [ ] `PASSWORD_LOGIN=0` 时通过动态模块不注册密码 Controller；不要只返回 404 的 handler，避免路由矩阵出现不存在的路由。
- [ ] 所有认证路由使用 `@Public()` / `@CsrfExempt()` 的旧豁免集合；不要给需要 Cookie 的路由错误豁免。
- [ ] 注册 / 登录审计事件、IP 处理、失败计数由 `AuditService` 和 `ThrottleService` 完成。

### 4.7 与账户设置、管理的边界

- [ ] 本功能不处理已登录用户的密码修改、Passkey 增删、邮箱修改；见 07。
- [ ] 本功能不处理管理员为他人生成重置码；见 08，但复用 `PasswordResetService`。
- [ ] 本功能不处理 Web 配对码；见 10。

## 5. 测试

### 5.1 现有测试

- `server-passkeys.test.js`：注册、登录、挑战、Passkey 管理边界。
- `server-password.test.js`：密码登录 / 注册 / 重置 / 限流。
- `server-email.test.js`：邮箱占用和规范化（与 07 共享）。
- `server-login-csrf.test.js`：登录路由的 CSRF 豁免。
- `server-first-user-admin.test.js`：空实例第一个用户成为 Owner。
- `passkeys-store.test.js`、`password.test.js`、`device-link.test.js`：纯模块行为。
- `soft-passkey.mjs` / `soft-passkey` 辅助：真实 WebAuthn 注册 / 断言。

### 5.2 新增测试

- [ ] 旧 Passkey 凭据在 Nest 入口下可登录。
- [ ] 旧浏览器 Cookie / RN Bearer 在认证路由后仍能访问 `/api/me`。
- [ ] `PASSWORD_LOGIN=0` 时密码路由全部 404，且 `/api/config` 不返回 `password_login`。
- [ ] 邀请码消费一次；失败注册不烧码（按旧行为）。
- [ ] 已消费 / 过期设备链接被拒绝；链接不能提升角色。
- [ ] 重置码一天有效、一次性、重置后旧会话失效。
- [ ] `RP_ID` / `ORIGIN` 不匹配时 Passkey 验证失败，响应与旧入口一致。
- [ ] 密码队列满载时返回 503 + `Retry-After: 2`。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-passkeys.test.js test/server-password.test.js test/server-first-user-admin.test.js test/passkeys-store.test.js test/password.test.js test/device-link.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 旧 Passkey、旧密码、旧设备链接可用。
- [ ] 新注册、登录、重置、设备链接的状态码和 JSON 与旧入口一致。
- [ ] `INVITE_ONLY`、`FIRST_USER_ADMIN`、`PASSWORD_LOGIN` 开关行为正确。
- [ ] 密码哈希 / 重哈希 / 队列与旧入口一致。
- [ ] 登录成功签发的会话可被 05 的 Guard 识别，旧 token 不被误判。
- [ ] 认证失败不会泄露账户存在性；限流和审计生效。
- [ ] A1 的登录、Passkey、设备链接部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| WebAuthn challenge / RP_ID 行为变化 | 复用 `@simplewebauthn/server` 和旧配置；真实软 Passkey 测试 |
| 旧密码 hash 无法验证 | 直接复用 `password.js`；导入旧数据夹具做登录 |
| 邀请码在失败路径被消费 | 复用旧顺序；失败注册用例 |
| 重置码 / 设备链接绕过会话版本 | 重置后 `sv++`；旧 token 失效用例 |
| 可选密码路由仍被注册 | 动态模块；路由矩阵和 `/api/config` 双重检查 |

## 8. 验收记录

```text
状态：待执行
代码版本：
Passkey / 密码 / 设备链接验收：
旧凭据兼容证据：
遗留问题：
```
