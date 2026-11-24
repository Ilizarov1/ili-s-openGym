# 08 · 管理接口、Owner 与邀请

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 2（账户、认证、审计、在线态和同步）
- 依赖：[05 会话与访问控制](05_SESSION_AND_ACCESS.md)、[06 认证入口](06_AUTHENTICATION.md)、[07 账户设置](07_ACCOUNT_SETTINGS.md)、[09 审计与在线态](09_AUDIT_AND_PRESENCE.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §2、§3
- 代码落点：`api/src/accounts/`、`api/src/admin/`
- 自有路由：13
- 状态：待执行

## 1. 背景与目标

管理接口是自托管实例的日常运维入口，涉及账户、角色、邀请、恢复码、审计和密码重置。迁移必须保留：

- Owner / Admin 的权限边界：Admin 不能操作其他 Admin，不能删除 / 禁用 Owner；Owner 可以交接和清理审计。
- 列表和详情路由对历史损坏状态文件有容错，不能因为一个坏文档整页 500。
- 邀请码一次性、可撤销、不可重复消费。
- 恢复码、密码重置码一次性、限流、审计。
- 审计查询和清空只有 Owner 可以清空；清空本身写审计且序号不重置。
- 普通用户 403 写 `admin.denied`；未认证 401 不写。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/users` | 用户列表 + 在线态摘要 |
| `GET` | `/api/admin/user` | 单用户详情（状态摘要、媒体、集成等） |
| `POST` | `/api/admin/user/recovery` | 生成恢复码 |
| `POST` | `/api/admin/user/disable` | 禁用 / 启用账户 |
| `POST` | `/api/admin/user/delete` | 删除他人账户 |
| `POST` | `/api/admin/user/role` | 提升 / 降级 Admin |
| `POST` | `/api/admin/owner` | 交接 Owner |
| `GET` | `/api/admin/invites` | 邀请列表 |
| `POST` | `/api/admin/invites/new` | 新建邀请 |
| `POST` | `/api/admin/invites/revoke` | 撤销邀请 |
| `GET` | `/api/admin/audit` | 审计查询（分页 / 过滤） |
| `POST` | `/api/admin/audit/clear` | 清空审计（Owner） |
| `POST` | `/api/admin/user/password-reset` | 生成密码重置码 |

## 3. 现状与兼容点

### 3.1 权限矩阵

| 操作 | Admin | Owner |
| --- | --- | --- |
| 查看用户列表 / 详情 | 是 | 是 |
| 禁用普通用户 | 是 | 是 |
| 禁用 Admin | 否（任何 Admin 都不能被禁用，包括 Owner 操作） | 否 |
| 删除普通用户 | 是 | 是 |
| 删除其他 Admin | 否 | 是，且不能删除最后一个 Admin |
| 删除 Owner | 否 | 否（先交接） |
| 提升 / 降级 Admin | 否 | 是，不能操作自己或 `ADMIN_UIDS` 中的账号 |
| 交接 Owner | 否 | 是，目标必须已经是 Admin 且未禁用 |
| 邀请新建 / 撤销 | 是 | 是 |
| 生成恢复码 | 目标普通用户：是；目标 Admin：否；目标 Owner：否 | 目标普通用户：是；目标 Admin：是；目标 Owner：否（用 CLI） |
| 生成密码重置码 | 目标普通用户：是；目标 Admin / Owner：否 | 目标普通用户：是；目标 Admin / Owner：否 |
| 查看审计 | 是 | 是 |
| 清空审计 | 否 | 是 |

- Owner 判定沿用 03 / 05：`owner: true` 优先，其次 `ADMIN_UIDS` 中第一个有档案的 id，最后最早 admin。
- 权限判断实时计算，不缓存；删除 / 降级 Owner 后下一次调用立即得到新的 Owner。
- 权限拒绝写 `admin.denied`；未认证不写。

### 3.2 用户列表 / 详情

- 列表返回 `{ users, invite_only, password_login?, now }`；每个用户包含 `publicUser`、`lastPull`、在线态、订阅等旧字段。
- 详情返回用户、`unit`、`lastSync`、`routines`、`bodyweight`、`workouts`；`password` / `email` / `resetUntil` 仅在 `PASSWORD_LOGIN=1` 时出现，`recoveryUntil` 始终出现。工作照片 / 视频引用不返回给管理视图。
- 详情要容忍旧状态文件中的 `null`、非对象、缺失数组；不能因为一个坏 `workouts` / `routines` 抛出 500。
- 在线态来自 09 的 `PresenceService.getLive(uid)`，不能单独维护一份 Map。
- 媒体 / 集成摘要通过 12 / 15 的服务读取；阶段 2 可先调用现有模块。

### 3.3 禁用 / 删除

- 禁用：
  - 任何 Admin 都不能被禁用（包括 Owner 尝试禁用其他 Admin，以及 Owner 自己）；旧入口直接返回 400。
  - 禁用后清理在线态，并删除该账号未消费的设备链接。
  - 旧会话在下次请求失效（依赖 `disabled` 检查）。
  - 返回列表 / 详情所需的字段。
- 删除：
  - 不能删除自己；不能删除 Owner；非 Owner 不能删除 Admin；不能删除最后一个 Admin。
  - 复用 07 的账户删除清理流程，但目标由管理员指定。
  - 清理训练、凭据、订阅、设备链接、手表、媒体、集成、Coach 凭据。
  - 写审计；删除后旧 token 全部失效。

### 3.4 角色与 Owner

- 角色变更只允许 Owner；不能操作自己；不能操作 `ADMIN_UIDS` 中的账号；目标被禁用时先启用；不能把最后一个 Admin / Owner 降级到无人管理。
- 交接 Owner 只能由当前 Owner 发起；目标必须已经是 Admin、存在且未被禁用；不能交接给自己；旧 Owner 保留 Admin 身份。
- 角色变更后旧会话权限立即按新角色计算（实时读账户库）。
- 审计记录操作者和目标。

### 3.5 邀请

- `GET`：列表包含 code、创建者、使用状态、过期 / 撤销状态。
- `POST /new`：生成唯一 code（16 位大写 hex）；管理员可以创建；`INVITE_ONLY` 时注册需要它。
- `POST /revoke`：不能撤销已使用的邀请；撤销后注册拒绝。
- 邀请码统一大写；消费时不区分大小写；消费后不可重复使用。
- 邀请码在创建 / 撤销时按旧行为写入审计 `msg`（管理员审计需要它）；不要在其他日志或响应之外输出。

### 3.6 恢复码 / 密码重置码

- 恢复码：
  - 管理员为普通用户生成；Admin 的恢复码只有 Owner 能生成；Owner 的恢复码只能由本地恢复 CLI 生成（见 17）。
  - 一次性、一天有效、哈希存储、限流。
  - 生成时增加目标 `sv`，清理其配对码、设备链接和在线态，并创建 `kind: 'recovery'` 的一次性设备链接。
  - 消费后签发新 Passkey / 会话；旧会话版本已失效。
- 密码重置码：
  - 仅 `PASSWORD_LOGIN=1` 时可用。
  - 管理员生成；目标只能是普通用户，Admin / Owner 目标直接拒绝（管理员在 Settings 改自己的密码）。
  - 生成时删除目标密码、`sv++`、清理配对码 / 设备链接 / 在线态；一次性、一天有效、哈希存储。
  - 使用 `/api/login/password-reset` 消费（见 06）；生成和消费都写审计。

### 3.7 审计查询 / 清空

- 查询：Admin / Owner；按 id 倒序分页，支持 `limit`、`before`、`cat`；返回 `events`、`total`、`nextBefore`、`enabled`、`ip_mode`、`retention`、`now`。
- 清空：仅 Owner；删除 `audit.log`，重置内存计数但**不重置序号**；清空本身写审计。
- 保留期和条数上限由 09 的 `AuditService` 执行；查询时也要裁剪过期记录。
- IP 显示按 `AUDIT_IP=off/net/full`。

## 4. 执行步骤

### 4.1 AdminService

- [ ] 新增 `api/src/admin/admin.service.ts`：
  - `listUsers()`、`getUser(id)`。
  - `setDisabled(id, disabled, actor)`。
  - `deleteUser(id, actor)`。
  - `setRole(id, admin, actor)`。
  - `transferOwner(id, actor)`。
  - `issueRecovery(id, actor)`：普通用户 / Admin 按权限矩阵；Owner 拒绝。
  - `issuePasswordReset(id, actor)`：只允许普通用户目标；Admin / Owner 拒绝。
- [ ] 所有方法先做权限判定（Admin / Owner），再做目标存在性、角色和 Owner 检查。
- [ ] 权限拒绝写 `admin.denied`；未认证不进入 Service。
- [ ] 目标查找统一使用 id；详情路由读取 `?id=`，不接受姓名作为唯一参数，避免歧义。
- [ ] 所有修改走 `AccountStore.save()`；在线态、媒体、集成清理调用对应服务。

### 4.2 列表 / 详情容错

- [ ] 新增 `api/src/admin/user-view.ts`：
  - 对 `state` 的 `workouts`、`routines`、`bodyweight` 等数组做防御性读取。
  - 缺失 / 非对象 / `null` 按空值处理，不让异常冒泡成 500。
  - 在线态、最后同步、订阅、媒体摘要从对应服务读取。
- [ ] 与旧测试 `server-admin-state.test.js` 对齐：无效状态文件不能让详情 / 禁用按钮失败。
- [ ] 列表不返回密码哈希、Passkey 公钥、恢复码明文。

### 4.3 角色与 Owner

- [ ] 在 `AdminService` 中集中实现 Owner 判定规则，不要在两个 Controller 里各写一份。
- [ ] 角色变更：
  - 非 Owner 拒绝。
  - 不能操作自己、Owner 或 `ADMIN_UIDS` 中的账号。
  - 目标被禁用时先启用；不能把最后一个 Admin 降级（按旧规则）。
- [ ] Owner 交接：
  - 仅 Owner。
  - 目标存在、未禁用、已经是 Admin；不能交接给自己。
  - 清除所有 `owner` 标记，设置目标 `owner: true`；旧 Owner 保留 Admin；保存并写审计。
- [ ] 角色变更后不需要重新签发会话；权限每次实时读取账户库。

### 4.4 邀请

- [ ] 新增 `api/src/admin/invite.service.ts`：
  - `list()`、`create(actor)`、`revoke(code)`。
  - code 生成 / 唯一性 / 大写规范化。
  - 已使用不可撤销；撤销只标记，不删除历史。
  - 审计事件与旧入口一致。
- [ ] 注册流程消费邀请时使用同一 `AccountStore` 实例，避免并发双花。
- [ ] 不把 code 明文写进审计或列表以外的日志。

### 4.5 恢复 / 重置码

- [ ] 复用 06 的 `PasswordResetService` 和 07 的 `DeviceLinkService` / 恢复码逻辑。
- [ ] 生成时检查目标权限、账户状态和现有码；消费时检查一次性、过期、哈希。
- [ ] 生成恢复码时增加目标 `sv`、清理配对码 / 设备链接 / 在线态，并创建 recovery 设备链接。
- [ ] 恢复码消费走 Passkey 注册流程，成功后签发会话并清理码。
- [ ] 密码重置码只允许普通用户目标；生成时删除目标密码、`sv++`、清理配对码 / 设备链接 / 在线态。
- [ ] 重置码消费走 `/api/login/password-reset`，成功后 `sv++` 并清理码。
- [ ] 编码格式（恢复码的分组字符、长度）与旧入口一致。

### 4.6 审计接口

- [ ] 新增 `AdminAuditController`：
  - `GET /api/admin/audit`：Admin / Owner。
  - `POST /api/admin/audit/clear`：Owner。
- [ ] 查询参数解析：`limit` 1–200，默认 100；`before` 数字；`cat` 分类。
- [ ] 使用 09 的 `AuditService` 读取 / 清空；不要在 Controller 里直接读文件。
- [ ] 清空后写 `admin.audit.clear`，序号不重置。
- [ ] 审计查询本身不写审计（按旧入口行为）。

### 4.7 Controller

- [ ] 新增 `AdminController`，所有路由要求 Admin 或 Owner。
- [ ] 使用 `@AdminOnly()` / `@OwnerOnly()` 和 05 的 Guard。
- [ ] 所有错误经 02 的过滤器输出旧 JSON；不要返回 Nest 默认 403。
- [ ] 管理路由的 CSRF 行为与旧入口一致（Cookie 会话需要 Origin 校验）。

## 5. 测试

### 5.1 现有测试

- `server-admin-state.test.js`：列表 / 详情、禁用、无效状态容错、401 / 403。
- `server-admin-delete.test.js`：删除他人账户、Owner / Admin 边界。
- `server-account-delete.test.js`：删除清理范围。
- `server-first-user-admin.test.js`：首个用户 Owner。
- `server-recovery.test.js`：恢复码生成 / 消费 / 本地 CLI。
- `server-password.test.js`：管理员密码重置码。
- `server-anon-flood.test.js`：邀请 / 注册限流。
- `server-email.test.js`：邮箱占用与重置。

### 5.2 新增测试

- [ ] Admin 不能禁用 / 删除 Owner；Admin 不能删除其他 Admin；Owner 可以删除其他 Admin，但任何 Admin 都不能被禁用。
- [ ] 交接 Owner 后旧 Owner 保留 Admin、失去 Owner；新 Owner 获得；目标必须已经是 Admin。
- [ ] 最后一个 Admin 不能被降级 / 删除。
- [ ] 邀请码一次性、撤销后拒绝、已使用不可撤销。
- [ ] 恢复码 / 重置码一次性、过期、权限矩阵、消费后 `sv++`；密码重置码拒绝 Admin / Owner 目标。
- [ ] 审计查询分页 / 分类 / 保留期；清空仅 Owner，清空后序号不重置。
- [ ] 普通用户 403 写 `admin.denied`；未认证 401 不写。
- [ ] 列表 / 详情遇到损坏状态文件不 500，仍可禁用账户。
- [ ] 删除 / 禁用后在线态清理，配对码 / 设备链接 / 手表 token 失效。
- [ ] 审计中不出现密码、恢复码明文；邀请码只在创建 / 撤销审计中按旧规则出现。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-admin-state.test.js test/server-admin-delete.test.js test/server-recovery.test.js test/server-first-user-admin.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 权限矩阵与旧入口一致，Owner / Admin 边界不可绕过。
- [ ] 列表 / 详情对损坏状态文件有容错，不出现 500。
- [ ] 邀请、恢复码、重置码都是一次性、可过期、可审计。
- [ ] 审计查询 / 清空的权限和分页结构一致；清空后序号不重置。
- [ ] 删除 / 禁用账户的清理范围与 07 一致，旧 token 全部失效。
- [ ] 401 / 403 的审计差异符合 A9。
- [ ] A1、A9 的管理部分通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| Admin 越权操作其他 Admin / Owner | 集中权限矩阵；表格用例 |
| 恢复码 / 邀请码并发双花 | 单实例内存 + 账户库保存；并发用例 |
| 审计清空重置序号 | 只清文件 / 计数，不重置 `auditSeq`；断言 id 跳变 |
| 损坏状态让管理页 500 | 防御性读取；`server-admin-state` 用例 |
| 删除目标清理到其他账户 | 目标 uid 清洗；双账号测试 |

## 8. 验收记录

```text
状态：待执行
代码版本：
权限矩阵 / 邀请 / 恢复码验收：
审计证据：
遗留问题：
```
