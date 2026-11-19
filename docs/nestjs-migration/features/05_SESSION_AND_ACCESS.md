# 05 · 会话与访问控制

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 2（账户、认证、审计、在线态和同步）
- 依赖：[03 持久化](03_PERSISTENCE.md)、[09 审计与在线态](09_AUDIT_AND_PRESENCE.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§3
- 代码落点：`api/src/auth/`、`api/src/common/auth/`
- 自有路由：3
- 状态：待执行

## 1. 背景与目标

旧入口把会话、CSRF、登录限流和权限判断写在同一个闭包里。迁移后需要把它们拆成可复用的 Service 和 Guard，同时保证：

- 旧 Web Cookie 和旧 RN Bearer 在升级后继续有效。
- Cookie 名、`sv` 会话版本、HMAC 签名和过期规则不变。
- CSRF、限流和权限的执行顺序不变。
- 未认证管理探测返回 401 且不写 `admin.denied`；普通用户访问管理接口返回 403 并写审计。
- 敏感操作在异步验证后再次确认会话，避免“验证期间被降权 / 删除 / 注销”仍成功。

## 2. 路由清单

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/me` | 当前用户、Bearer 续期 |
| `POST` | `/api/logout` | 结束当前会话 |
| `POST` | `/api/logout/all` | 增加会话版本，结束全部会话并清理配对码 |

## 3. 现状与兼容点

### 3.1 会话格式

- token payload：`uid:exp:sv[:kind]`；新令牌带 `kind`（`c` 浏览器 Cookie，`b` 配对 Bearer），旧令牌没有第四段仍按旧规则接受。
- 有效期：`SESSION_DAYS`，默认 90 天；令牌过期后拒绝，配对 Bearer 可在过半寿命后由 `/api/me` 续期；Cookie 不续期。
- 签名：HMAC-SHA256，密钥为 `DATA_DIR/secret`。
- Cookie：HTTPS 下 `__Host-gymsid`，HTTP 下 `gymsid`；`HttpOnly`、`SameSite=Lax`，HTTPS 时 `Secure`。
- Bearer：`Authorization: Bearer <token>`；RN 配对令牌和 Passkey 会话共用同一签名格式。
- `sv`：账户当前会话版本；`logout/all`、密码 / Passkey 变更、禁用等会使旧 token 失效。
- `/api/me`：
  - 无会话 `401 { error: 'not signed in' }`。
  - 有会话返回 `{ user: { id, name, admin, owner? } }`。
  - Bearer 且剩余寿命小于一半时返回新的 `token`；Cookie 不续期。

### 3.2 Cookie / Bearer 取值顺序

- 同时存在 Cookie 和 Bearer 时，按旧入口的顺序取值；Bearer 必须验签并检查会话版本。
- 重复 Cookie 按旧解析逻辑处理，不能取到攻击者插入的同名值。
- 旧 Cookie 名需要清理，避免升级后留下失效会话。

### 3.3 CSRF

- 只对需要 Cookie 的状态变更路由检查。
- Passkey / 登录 / 设备链接 / 手表兑换等使用请求体凭据的路由按旧集合豁免。
- 有效 Bearer 且无 Cookie 时豁免。
- Origin / `Sec-Fetch-Site` 不匹配时：
  - 无效 Bearer 且无 Cookie 的请求返回 `401 { error: 'not signed in' }`。
  - 其他返回 `403 { error: 'cross-origin request refused', code: 'origin-mismatch', expected: ORIGIN }`。
- 拒绝日志包含 `originHint`，不要把一次 CSRF 失败写成审计事件。

### 3.4 限流

- 密码路由按地址和账户失败计数，返回 `429` 和 `Retry-After`。
- 匿名注册 / 配对按地址限流，避免无限生成配对码。
- `TRUST_PROXY` 开启时按 Nginx / Cloudflare 覆盖后的地址解析；关闭时只信 socket 地址。

### 3.5 权限

- `isAdmin`：`user.admin === true` 或 `ADMIN_UIDS` 包含该 id。
- `isOwner`：Owner 标记优先；没有标记时按 `ADMIN_UIDS` 中第一个有档案的 id，再按最早 admin。
- Owner / Admin 判定每次实时计算，不缓存。
- 未认证 → 401；已认证但权限不足 → 403；403 写审计，401 不写 `admin.denied`。

## 4. 执行步骤

### 4.1 SessionService

- [ ] 新增 `api/src/auth/session.service.ts`：
  - `sign(payload)` / `verify(token)`：与旧 `sign`、`verifySig` 字节兼容。
  - `makeSession(user, kind = 'b')`：写入 `uid:exp:sv:kind`；旧令牌没有 kind 时按旧行为兼容，Bearer 和 Cookie 共用签名。
  - `sessionOf(req)`：解析 Cookie / Bearer，返回 `{ user, exp, sv, bearer, kind }` 或 null。
  - `readSession(req)`：在 `sessionOf` 基础上校验用户存在、未禁用、`sv` 匹配。
  - `sessionCookie(user)`：使用 `makeSession(user, 'c')`，写入 Cookie；`clearCookie()`、`expireCookie(name)`。
  - `renewIfNeeded(session)`：只在 Bearer 且剩余寿命小于 `SESSION_DAYS / 2` 时生成新 token。
- [ ] 使用 `RuntimeConfig.secret`，不要在每个 Service 里重新读取 `secret` 文件。
- [ ] 对 `user.disabled`、`user.sv`、`user.id` 的检查顺序与旧入口一致。
- [ ] 写一个使用真实 `secret` 和固定时间的单元测试，验证签名、过期、`sv` 不匹配和篡改。

### 4.2 Cookie 处理

- [ ] 在 `api/src/auth/cookies.ts` 实现：
  - `cookieValues(header, name)`：返回所有同名值，保持顺序。
  - `cookieToken(req)`：取第一个有效 token。
  - `sessionCookie(user)`、`clearSessionCookies()`：保留 `__Host-` 前缀规则。
  - 旧 `LEGACY_COOKIE` 的清理逻辑。
- [ ] 使用 `reply.appendCookie` 写多个 `Set-Cookie`，不要覆盖其他 Cookie。
- [ ] 测试重复 Cookie、空 Cookie、非法 Cookie、HTTPS / HTTP 两种名称。

### 4.3 CSRF 和来源校验

- [ ] 新增 `api/src/auth/csrf.ts`：
  - `PASSKEY_ROUTES`、`SIGN_IN_ROUTES`、`CSRF_EXEMPT` 集合与旧入口一致。
  - `bearerAuthenticates(req)`。
  - `csrfOk(req, key)`：Origin、`Sec-Fetch-Site`、Bearer、Cookie 综合判断。
  - `originHint(key, origin, expected, secFetchSite)` 日志文本。
- [ ] 在 Guard 中先执行 CSRF，再执行限流，再执行权限；顺序用测试固定。
- [ ] 不要把 CSRF 失败写进审计；它是未认证请求，审计会被刷满。
- [ ] 对 Bearer 无效且无 Cookie 的请求返回 401，而不是 403。

### 4.4 限流

- [ ] 新增 `api/src/auth/throttle.service.ts`，包装 [rate-limit.js](../../../api/rate-limit.js)：
  - `AUTH_BURST`、`ADDR_FAILS`、`ACCOUNT_FAILS`、`FAIL_AUDIT`、`FAIL_AUDIT_ALL`。
  - `limitAddress(req)`：按 `TRUST_PROXY`、`CF-Connecting-IP`、`X-Forwarded-For` 解析。
  - `addressPaused`、`strikeAddress`、`tooMany`。
  - 密码 scrypt 队列的 `BusyError` 由 02 的过滤器映射为 503。
- [ ] 1 分钟 sweep 计时器由 17 的协调器启动；Service 构造时不启动。
- [ ] 限流键包含路由类别，避免登录失败和注册失败互相消耗。

### 4.5 Guard 与元数据

- [ ] 新增装饰器：
  - `@Public()`：跳过会话 Guard。
  - `@AdminOnly()`、`@OwnerOnly()`。
  - `@CsrfExempt()`：仅用于旧入口豁免的路由。
- [ ] 新增 `SessionGuard`、`AdminGuard`、`OwnerGuard`：
  - 从请求上下文取 `SessionService` 的结果。
  - 未认证抛出 401；权限不足抛出 403。
  - Guard 只做拒绝，不写业务审计；403 的审计由 `AccountsService` / `AdminService` 写。
  - 失败响应经 02 的异常过滤器输出旧 JSON。
- [ ] 实现 `recheckSession(req, expectedUser)`：敏感操作在异步验证后再次读取会话和账户，确认 `id`、`sv`、`disabled`、角色未变。
- [ ] 在 `AuthModule` 中导出 `SessionService`、Guard 和 `CsrfService`，供 Accounts / Media / Sync 等模块导入。

### 4.6 路由

- [ ] `GET /api/me`：
  - 无会话 401。
  - 返回 `publicUser`；Owner 标记按 03 / 08 的规则。
  - Bearer 续期只在满足条件时返回 `token`。
- [ ] `POST /api/logout`：
  - 清除当前 Cookie；Bearer 请求不依赖 Cookie。
  - 行为与旧入口一致，不增加会话版本。
- [ ] `POST /api/logout/all`：
  - 增加账户 `sv`，保存账户库。
  - 清理该账户所有未消费配对码（`PairingService` 与 `SessionService` 同属 `AuthModule`，见 10）。
  - 清理该账户未消费的设备链接（见 06）。
  - 清除当前 Cookie。
  - 写审计。
- [ ] 确认 `logout/all` 后旧 Cookie / 旧 Bearer / 旧配对码全部失效。

## 5. 测试

### 5.1 现有测试

- `server-token-refresh.test.js`：Bearer 续期、Cookie 不续期、`sv` 失效。
- `server-login-csrf.test.js`：Origin / CSRF 行为。
- `server-csrf-bearer.test.js`：无效 Bearer 无 Cookie 返回 401。
- `server-anon-flood.test.js`：匿名注册 / 配对限流。
- `server-admin-state.test.js`：管理权限和 401 / 403。
- `server-config-session.test.js`：会话对 `/api/config` 的影响。
- `server-bad-input.test.js`：无会话 / 错误输入的响应。

### 5.2 新增测试

- [ ] 旧 Cookie / 旧 Bearer 在 Nest 入口下可访问 `/api/me`。
- [ ] Cookie 与 Bearer 同时存在时取值顺序正确。
- [ ] 重复 Cookie 不取到伪造值。
- [ ] `logout/all` 后旧 token、旧配对码、旧设备链接都失效；新登录可用。
- [ ] 未认证管理探测返回 401，审计中没有 `admin.denied`。
- [ ] 普通用户管理探测返回 403，审计中有 `admin.denied`。
- [ ] 敏感操作在异步验证期间被注销 / 禁用 / 降权后失败。
- [ ] `TRUST_PROXY=0/1` 下限流地址与审计地址正确。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-token-refresh.test.js test/server-login-csrf.test.js test/server-csrf-bearer.test.js test/server-admin-state.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 旧 Cookie、旧 Bearer、Passkey 会话在升级后可用。
- [ ] `/api/me` 的续期条件和响应结构与旧入口一致。
- [ ] `logout/all` 使所有会话和未消费配对码失效。
- [ ] CSRF 的 401 / 403 分支和响应体与旧入口一致。
- [ ] 限流在 `TRUST_PROXY` 两种配置下地址正确。
- [ ] 401 不写 `admin.denied`，403 写审计。
- [ ] A1、A9 的会话 / 权限部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 新会话签名与旧 token 不兼容 | 直接移植 `sign` / `verifySig`；用旧 token 做验收输入 |
| Guard 顺序改变导致先审计后拒绝 | 固定 CSRF → 限流 → 权限；用 401 / 403 用例检查 |
| `logout/all` 未清理配对码 | 在同一个 Service 中清理；A1 用例 |
| 敏感操作异步验证后被降权仍成功 | `recheckSession`；密码 / Passkey / 删除用例 |
| Cookie 前缀在 HTTP / HTTPS 下错误 | 用 `SECURE` 条件生成；实际 Nginx HTTPS 验收 |

## 8. 验收记录

```text
状态：待执行
代码版本：
旧 token / Cookie 验证：
401 / 403 审计证据：
遗留问题：
```
