# 07 · 账户设置与账户删除

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 2（账户、认证、审计、在线态和同步）
- 依赖：[05 会话与访问控制](05_SESSION_AND_ACCESS.md)、[06 认证入口](06_AUTHENTICATION.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§3、§4
- 代码落点：`api/src/accounts/`
- 自有路由：12
- 状态：待执行

## 1. 背景与目标

账户设置是已登录用户管理密码、邮箱、Passkey、设备链接和删除账户的入口。它必须保留旧入口的安全要求：

- 敏感操作需要 Owner 二次确认（`proveOwner`），不能只凭会话 Cookie 完成。
- 修改密码 / 删除 Passkey / 删除账户会使旧会话和旧 token 失效。
- 邮箱和姓名占用检查不泄露给未授权方。
- 删除账户要清理训练状态、Passkey、订阅、设备链接、手表、媒体、集成和 Coach 个人凭据，且不能误删其他账户的数据。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/account/password` | 查询是否已设置密码、邮箱 |
| `POST` | `/api/account/password` | 设置 / 修改密码 |
| `DELETE` | `/api/account/password` | 删除密码 |
| `POST` | `/api/account/email` | 设置 / 修改邮箱 |
| `DELETE` | `/api/account/email` | 删除邮箱 |
| `GET` | `/api/account/passkeys` | 列出 Passkey |
| `POST` | `/api/account/passkeys/options` | 创建新增 Passkey 挑战 |
| `POST` | `/api/account/passkeys/verify` | 验证并保存新 Passkey |
| `POST` | `/api/account/passkeys/rename` | 重命名 Passkey |
| `DELETE` | `/api/account/passkeys` | 删除 Passkey |
| `POST` | `/api/account/device-link` | 生成一次性设备链接 |
| `POST` | `/api/account/delete` | 删除当前账户 |

`/api/device-link/options` 和 `/api/device-link/verify` 属于认证入口，见 06；本功能只负责已登录用户创建链接。

## 3. 现状与兼容点

### 3.1 密码

- `GET`：返回 `{ set, setAt, passkeys, name, nameTaken, email }`（旧入口字段名），仅在 `PASSWORD_LOGIN=1` 时路由存在。
- `POST`：设置或修改密码；旧密码验证、策略检查、哈希、保存、`sv++`、审计。
- `DELETE`：删除密码；没有 Passkey 时返回 `409 last-way-in`，否则先 `proveOwner`，成功后 `sv++`，旧密码登录立即失效。
- 所有敏感操作在异步 scrypt / WebAuthn 之后再次确认会话、账户和权限。
- `PASSWORD_LOGIN=0` 时这些路由按旧入口不存在（404）。

### 3.2 邮箱

- `POST`：规范化邮箱、检查占用、保存、审计；邮箱可用于密码登录。
- `DELETE`：清除邮箱、审计。
- 与姓名占用共享规则：一个名字不能与另一个账户的登录邮箱冲突。
- 错误码 `email-invalid`、`email-taken` 等必须与旧入口一致。

### 3.3 Passkey 管理

- 列表只返回公开字段（id、名称、创建时间、transports 等），不返回公钥或计数器。
- 新增 Passkey 走 06 的挑战 / 验证服务；保存后不使其他会话失效。
- 重命名只改本账户的凭据。
- 删除：Passkey 数 + 可用密码数 ≤ 1 时返回 `409 last-way-in`；删除成功后清理设备链接。
- 新增最多 20 个 Passkey（`MAX_PASSKEYS`），超出返回 `passkey-limit`。

### 3.4 设备链接

- `POST /api/account/device-link` 需要会话和 Owner 二次确认。
- 返回一次性链接 / 代码；服务端只存哈希。
- 链接验证在 06，签发新会话，不提升角色。

### 3.5 账户删除

删除前的要求：

- 请求体必须带 `name`，且与当前账户名完全一致；否则 `400 confirm-name`。
- 最后一个 Admin 在其他 profile 仍存在时不能离开；返回 `409 last-admin`。
- 证明方式：配对 Bearer 且该账户没有可用密码时用设备本身作为 proof；否则 `proveOwner`（Passkey / 密码 / 设备链接）。
- `proveOwner` 是异步的；返回后再次确认会话仍是同一用户，并再次检查“最后一个 Admin”条件。
- 删除自己后清除当前 Cookie（按旧入口行为）。

旧 `removeAccount` 的顺序：

1. 从 `db.users` 删除用户。
2. 删除该用户的 `db.creds`。
3. 删除该用户的 `db.subs`。
4. 删除设备链接、手表链接和手表配对码。
5. 删除在线态。
6. 删除 `state-<uid>.json`、`watch-<uid>.json`。
7. 清除 Coach 个人凭据。
8. 删除 `uploads/<uid>/`。
9. 删除集成连接和 outbox。
10. 保存账户库。

要求：

- 训练状态和媒体目录的删除失败只记录，不回滚已完成的账户库修改（与旧入口一致）。
- 不能删除其他账户的目录或状态文件。
- 管理员删除他人账户见 08；本路由只删除当前账户。
- 删除后旧 Cookie / Bearer / 配对码 / 设备链接 / 手表 token 均失效。

## 4. 执行步骤

### 4.1 AccountSettingsService

- [ ] 新增 `api/src/accounts/account-settings.service.ts`：
  - `getPasswordState(user)`。
  - `setPassword(user, oldPassword, newPassword, req)`。
  - `deletePassword(user, req)`。
  - `setEmail(user, email, req)`。
  - `deleteEmail(user, req)`。
  - `listPasskeys(user)`。
  - `renamePasskey(user, id, name)`。
  - `deletePasskey(user, id, req)`。
  - `createDeviceLink(user)`。
- [ ] 所有方法从 `SessionGuard` 取得当前用户，不接受请求体里的 uid。
- [ ] 修改密码 / 删除密码 / 删除 Passkey / 设置邮箱等敏感操作调用 `recheckSession`（见 05）。
- [ ] 修改安全凭据后增加 `sv`，保存账户库；当前请求可以返回成功，但旧会话在下次请求失效（按旧入口行为）。

### 4.2 密码和邮箱

- [ ] 密码设置 / 修改：
  - 旧密码存在时先验证；没有旧密码时按旧规则允许设置（仅限已登录用户）。
  - 策略检查使用 `passwordProblem`。
  - 哈希使用 `PasswordService`，不要在 Controller 内散写。
  - 保存失败不返回成功；保存后审计。
- [ ] 密码删除：清除 `user.pw`，`sv++`，审计；保留 Passkey 登录能力。
- [ ] 邮箱设置：规范化、占用检查、保存、审计；占用检查要覆盖其他账户的姓名。
- [ ] 邮箱删除：清除 `user.email`，审计。

### 4.3 Passkey 管理

- [ ] 列表：按 `user.id` 过滤 `db.creds`，只返回公开字段；排序与旧入口一致。
- [ ] 新增：复用 06 的 `PasskeyService`，保存后返回新列表或凭据 id。
- [ ] 重命名：只允许修改自己的凭据；名称长度 / 空值处理与旧入口一致。
- [ ] 删除：只允许删除自己的凭据；删除最后一个登录方式时按旧规则拒绝或要求先设置其他方式。
- [ ] 所有操作在异步 WebAuthn 后再次确认会话和凭据仍属于当前用户。

### 4.4 设备链接创建

- [ ] `POST /api/account/device-link` 要求 `proveOwner`；不接受仅 Cookie 的请求。
- [ ] 生成链接并只在数据库中存哈希；返回明文给当前会话。
- [ ] 审计事件与旧入口一致；不记录明文链接。
- [ ] 与 06 的验证服务共享 `DeviceLinkService`。

### 4.5 账户删除

- [ ] 新增 `api/src/accounts/account-deletion.service.ts`：
  - 校验 `body.name` 与当前账户名一致，否则 `400 confirm-name`。
  - 检查最后一个 Admin 条件，返回 `409 last-admin`。
  - 配对 Bearer 且无可用密码时跳过 `proveOwner`，使用设备本身作为 proof；否则执行 `proveOwner`。
  - `proveOwner` 返回后再次确认会话用户未变，并再次检查最后一个 Admin。
  - 按 3.5 的顺序调用清理接口。
  - 账户库保存一次；各扩展清理失败单独记录。
  - 在线态清理调用 09 的 `PresenceService`。
  - 媒体清理调用 12 的 `MediaService.removeUser`；阶段 2 可先调用现有 `media.js`。
  - 集成清理调用 15 的 `IntegrationsHub.removeUser`；阶段 2 可先调用现有实例。
  - Coach 个人凭据清理调用 16 的 `CoachConfig.clearProfileAuth`；阶段 2 可先调用现有模块。
  - 手表链接 / 邮箱清理调用 14 的服务；阶段 2 可先调用现有 `watch-relay.js`。
- [ ] 清理顺序与旧 `removeAccount` 一致；不要在删除用户记录之前删除状态文件（避免失败后无法定位）。
- [ ] 删除完成后使当前请求的 Cookie 失效（按旧入口是否返回清除头）。
- [ ] 写审计；不要记录密码、Passkey 公钥或链接明文。

### 4.6 Controller

- [ ] 新增 `AccountSettingsController`，所有路由要求会话。
- [ ] `GET /api/account/password`、`POST/DELETE ...` 仅在 `PASSWORD_LOGIN=1` 时注册；关闭时 404。
- [ ] 邮箱路由与密码路由同属 `passwordRoutes`，`PASSWORD_LOGIN=0` 时也不注册（404）。
- [ ] Passkey 路由始终可用（Passkey 是默认登录方式）。
- [ ] 设备链接创建和账户删除要求 CSRF / 权限 Guard；按 05 的豁免集合处理。

## 5. 测试

### 5.1 现有测试

- `server-password.test.js`：密码设置 / 修改 / 删除、旧密码、限流。
- `server-email.test.js`：邮箱设置 / 删除、占用、规范化。
- `server-passkeys.test.js`：列表、新增、重命名、删除、最后一个凭据。
- `server-account-delete.test.js`：账户删除清理范围。
- `server-token-refresh.test.js`：密码 / 会话变更后的 token 行为。
- `server-admin-delete.test.js`：管理员删除他人账户的清理边界（与 08 共享）。

### 5.2 新增测试

- [ ] 旧密码 hash 可以在 Nest 入口下验证和重哈希。
- [ ] 修改密码后旧 Cookie / Bearer 失效，新密码可登录。
- [ ] 删除密码后 Passkey 仍可登录；无其他登录方式时按旧规则处理。
- [ ] 邮箱占用检查覆盖姓名冲突；错误码一致。
- [ ] 最后一个登录方式：删除密码或 Passkey 返回 `409 last-way-in`；有另一种登录方式时允许。
- [ ] 设备链接创建需要 Owner 二次确认；明文只返回一次，数据库只有哈希。
- [ ] 删除需要输入账户名；名字不匹配返回 `400 confirm-name`。
- [ ] 最后一个 Admin 在其他 profile 存在时不能删除自己，返回 `409 last-admin`。
- [ ] 配对 Bearer 且无密码时可用设备本身作为 proof；浏览器 Cookie 不能跳过 `proveOwner`。
- [ ] `proveOwner` 期间被注销 / 删除 / 降权后删除失败。
- [ ] 账户删除后 `state-*`、`watch-*`、`uploads/<uid>/`、集成 / Coach 凭据被清理，其他账户不受影响。
- [ ] 删除过程中某个扩展清理失败仍保存账户库，并记录错误。
- [ ] 删除后旧 token / 旧配对码 / 旧设备链接 / 手表 token 全部失效。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-password.test.js test/server-email.test.js test/server-passkeys.test.js test/server-account-delete.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 密码、邮箱、Passkey 的设置 / 修改 / 删除行为与旧入口一致。
- [ ] 敏感操作需要 Owner 二次确认，异步验证后再次确认会话。
- [ ] 旧密码、旧 Passkey、旧设备链接在升级后仍可用。
- [ ] 账户删除的清理范围完整，其他账户不受影响。
- [ ] 密码 / 安全凭据变更后旧会话失效。
- [ ] A1 的账户设置部分、A4 的账户媒体清理部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 密码修改后旧会话未失效 | 增加 `sv` 并保存；旧 token 用例 |
| 删除账户误删其他用户目录 | uid 清洗 + 只操作当前 uid；双账号测试 |
| 最后一个登录方式被删除导致锁死 | 复用旧策略；Passkey / 密码组合测试 |
| 设备链接明文落盘 | 只存哈希；审计不记录明文 |
| 扩展清理失败导致账户库未保存 | 按旧顺序：清理失败记录，账户库仍保存 |

## 8. 验收记录

```text
状态：待执行
代码版本：
账户设置 / 删除验收：
旧凭据兼容证据：
遗留问题：
```
