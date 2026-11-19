# 10 · 手机配对

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 2（账户、认证、审计、在线态和同步）
- 依赖：[05 会话与访问控制](05_SESSION_AND_ACCESS.md)、[06 认证入口](06_AUTHENTICATION.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §3
- 代码落点：`api/src/auth/pairing.service.ts`、`api/src/auth/pairing.controller.ts`
- 自有路由：2
- 状态：待执行

## 1. 背景与目标

RN 不能直接在手机里完成 WebAuthn，所以配对流是：网页端登录后生成一次性配对码，RN 扫码或手动输入，兑换账户信息和长期令牌。迁移必须保留：

- 生成配对码需要已登录会话和 Owner 二次确认（`proveOwner`），防止被盗 Cookie 直接生成新设备令牌。
- 配对码一次性、短时有效、内存存储，进程重启后失效。
- `logout/all` 清除该账户所有未消费配对码，避免“退出所有会话”后旧码仍能换新 token。
- 兑换成功后签发与网页会话相同格式的 Bearer；RN 的账户、角色、档案定位与 Web 一致。
- 配对码不能跨账户使用；错误码和过期行为与旧客户端兼容。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/pair/create` | Web 端生成一次性配对码 |
| `POST` | `/api/pair/redeem` | RN 兑换配对码，返回账户信息和令牌 |

## 3. 现状与兼容点

### 3.1 生成

- 需要会话；`proveOwner` 二次确认（Passkey / 密码 / 设备链接按旧入口）。
- 返回 code、过期时间等旧字段；code 格式与旧入口一致（便于 RN 扫码 / 手动输入）。
- 只存内存 Map：`code -> { uid, exp }`；默认 5 分钟有效。
- code 为 8 位大写字母 / 数字（去掉 `0/O/1/I` 等易混字符），无分隔符；兑换时 `trim` 后统一大写。
- 生成时写审计；不在日志中输出完整 code（按旧规则）。
- 同一账户只保留最新一个未消费 code；新 code 生成时删除该账户旧 code，避免 Map 无界增长。

### 3.2 兑换

- 请求体中的 code 先 `trim` 再统一大写，兑换不区分大小写。
- 检查存在、未过期、未消费；消费后立即从 Map 删除。
- 账户必须存在、未禁用；签发 `makeSession(user)`（Bearer）。
- 返回 `{ user, token }` 或旧结构；`user` 使用 `publicUser`，包含 `admin` / `owner`。
- 失败返回旧状态码：无效 / 过期 / 已消费 / 账户禁用。
- 兑换成功写审计；不记录 token 明文。

### 3.3 生命周期

- 60 秒清理过期 code 的计时器由 17 的协调器启动；也可在读取时惰性清理。
- `POST /api/logout/all` 调用 `PairingService.dropUser(uid)`，清除该账户全部 code。
- 禁用 / 删除账户也清除 code。
- 进程重启后 Map 为空；RN 重新生成 code，不需要持久化。
- 配对码不是会话，不能访问其他路由；只有兑换接口接受。

### 3.4 QR 配对

- 网页生成的 code 被编码进 QR；RN 扫码解析后调用兑换。
- QR 解析在 `mobile-rn/src/pairing/`，不在服务端；服务端只接收 code 字符串。
- 服务端不生成图片、不依赖前端框架。
- 兼容 `docs/rn-p2/import-sharing-connection/03_QR_PAIRING.md` 的字段。

## 4. 执行步骤

### 4.1 PairingService

- [ ] 新增 `api/src/auth/pairing.service.ts`：
  - `create(user, req)`：生成 code，删除该账户旧 code，存 `{ uid, exp }`，写审计。
  - `redeem(code, req)`：校验、消费、返回账户和 token。
  - `dropUser(uid)`：清除该账户全部 code。
  - `sweep(now)`：清理过期 code。
  - 不需要 `count`：同一账户只保留最新一个 code。
- [ ] 使用 `SessionService.makeSession` 签发 token；不要复制签名逻辑。
- [ ] code 生成使用加密安全随机源；避免易混淆字符（按旧格式）。
- [ ] Map 只在进程内；不写 `db.json`、不落盘。
- [ ] 计时器由 17 启动，Service 构造时不启动。

### 4.2 create 路由

- [ ] `POST /api/pair/create`：
  - 需要会话。
  - 调用 `proveOwner`；失败返回旧状态码，不生成 code。
  - `proveOwner` 是异步的；返回后再次读取会话，确认仍是同一用户（期间可能被注销 / 禁用 / 重置）。
  - 返回 code、过期时间；字段名与旧入口一致。
  - 写审计。
  - CSRF 按 05 的 Cookie 规则处理。

### 4.3 redeem 路由

- [ ] `POST /api/pair/redeem`：
  - 公开路由，但走 CSRF 豁免 / 限流（按旧入口）。
  - 读取 code；空 / 类型错误返回旧错误。
  - 调用 `PairingService.redeem`。
  - 返回 `{ token, user }`，不设置 Cookie；RN 保存 Bearer。
  - 写审计；失败计入地址限流（如果旧入口如此）。

### 4.4 与注销 / 删除联动

- [ ] `POST /api/logout/all`（05）调用 `PairingService.dropUser`。
- [ ] 禁用 / 删除账户（07 / 08）调用 `dropUser`。
- [ ] 恢复链接签发时增加目标 `sv`，清理该账户配对码、设备链接和在线态（与 08 的恢复码生成一致）。
- [ ] 在线态清理不依赖配对码清理。

### 4.5 RN 回归

- [ ] 确认 `mobile-rn/src/pairing/` 的 QR 解析字段与服务端返回一致。
- [ ] 确认 RN 兑换成功后保存 token，并在后续请求使用 `Authorization: Bearer`。
- [ ] 模拟“Web 生成 code → RN 兑换 → RN 拉取 `/api/data`”全流程。
- [ ] 模拟过期 code、已消费 code、跨账户 code、禁用账户 code。

## 5. 测试

### 5.1 现有测试

- `server-pairing.test.js`：生成、兑换、过期、注销联动、Owner 二次确认。
- `server-anon-flood.test.js`：匿名配对生成限流。
- `server-token-refresh.test.js`：配对 token 的 `sv` / 续期边界。
- `server-password.test.js`：Owner 二次确认的密码路径。

### 5.2 新增测试

- [ ] Web 生成 code 后 RN 兑换成功，返回的 user / token 可用于 `/api/me` 和 `/api/data`。
- [ ] code 一次性：第二次兑换返回旧错误。
- [ ] 同一账户生成新 code 后，旧 code 立即失效。
- [ ] 过期 code 被拒绝；`sweep` 后 Map 不残留。
- [ ] `logout/all` 后旧 code 不能兑换；新 code 可兑换。
- [ ] 禁用 / 删除账户后 code 不能兑换。
- [ ] 跨账户 code 不影响其他账户；token 指向正确 uid。
- [ ] 仅 Cookie 无 `proveOwner` 时生成失败。
- [ ] 配对码生成 / 兑换的审计事件存在，且不记录完整 code / token。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-pairing.test.js test/server-anon-flood.test.js test/server-token-refresh.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] Web 生成、RN 扫码 / 手动兑换全流程可用。
- [ ] code 一次性、5 分钟过期、进程重启失效。
- [ ] `logout/all`、禁用、删除后 code 不可兑换。
- [ ] 兑换得到的 Bearer 与旧 RN 令牌格式一致，旧 RN 客户端无需修改。
- [ ] 生成需要 Owner 二次确认，不能仅凭 Cookie。
- [ ] 账户隔离正确，token 不指向其他账户。
- [ ] A1 的配对部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| code 被暴力枚举 | 加密随机 + 地址限流 + 短有效期 |
| 退出全部会话后旧 code 仍可换 token | `logout/all` 清理 Map；A1 用例 |
| 配对码落盘导致重启后可重放 | 只存内存；重启清空 |
| QR 字段与服务端不一致 | 复用旧字段；RN 真机 / 模拟器验收 |
| 兑换 token 权限错误 | 用 `publicUser` + 实时角色；`/api/me` 断言 |

## 8. 验收记录

```text
状态：待执行
代码版本：
配对全流程证据：
过期 / 注销 / 删除用例：
遗留问题：
```
