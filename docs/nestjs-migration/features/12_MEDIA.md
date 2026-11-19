# 12 · 私有媒体

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 3（媒体、扩展和生命周期）
- 依赖：[05 会话与访问控制](05_SESSION_AND_ACCESS.md)、[07 账户设置](07_ACCOUNT_SETTINGS.md)、[11 同步](11_SYNC.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §5
- 代码落点：`api/src/media/`
- 自有路由：4
- 状态：待执行

## 1. 背景与目标

媒体是训练照片、自定义动作视频等私有文件，必须按账号隔离，并以流式方式处理大文件。迁移必须保持：

- `PUT /api/media/{hash}` 只接受已登录、有限额额度的账号，流式校验哈希、类型、大小，先写临时文件再原子替换。
- `GET /api/media/{hash}` 只允许文件所属账号读取，流式返回并保留安全头。
- 相同哈希重复上传按旧行为处理；跨账号读取拒绝。
- 上传中断、客户端断开、临时文件、清理宽限期和引用登记都不能泄漏。
- 状态提交后登记引用；清理任务只删除满足旧条件的未引用文件。
- Nginx 的媒体代理缓冲 / 上传限制 / 超时设置保持不变。

## 2. 路由清单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `PUT` | `/api/media/{hash}` | 上传原始字节 |
| `GET` | `/api/media/{hash}` | 下载 / 预览 |
| `POST` | `/api/media/missing` | 检查缺失哈希 |
| `POST` | `/api/media/sweep` | 触发清理 |

## 3. 现状与兼容点

### 3.1 上传

- 只有 `MEDIA_UPLOADS=1` 时路由存在；关闭时四个路由均 404。
- 先完成会话、CSRF、限流、每小时上传额度检查，再把原始请求流交给 `media.js`。
- `hash` 是 64 位小写十六进制，必须与文件内容 SHA-256 一致。
- 允许类型：JPEG / PNG / GIF / MP4（以 `MEDIA_TYPES` 为准）；视频时长上限。
- 大小上限：图片 / GIF / 视频分别按 `MEDIA_IMAGE_MAX_MB`、`MEDIA_GIF_MAX_MB`、`MEDIA_VIDEO_MAX_MB`。
- 先写临时文件，校验通过后原子替换；失败删除临时文件。
- 同一账号并发上传有 `MAX_INFLIGHT` 限制；额度不足返回旧错误。
- 客户端断开后未完成的上传 / 清理计入在途集合；关闭时由 17 排空或回收。
- 上传路由调用 `allowSlowBody()`，使用媒体自己的空闲计时器（默认 60 秒）。

### 3.2 下载

- 按账号目录授权；其他账号即使知道哈希也读不到。
- 流式返回，保留 `Content-Type`、`Content-Length`、`Content-Disposition`、`Cache-Control: private, no-store`、`X-Content-Type-Options: nosniff`、sandbox CSP、`Cross-Origin-Resource-Policy: same-origin`、`X-Robots-Tag: noindex`、`Access-Control-Expose-Headers: Content-Length`。
- 不支持 Range / ETag，整文件流式返回（旧入口如此）。
- 文件缺失返回旧状态码 / JSON；不要返回目录列表。
- 文件名 / 哈希不拼进路径，避免路径穿越。

### 3.3 引用和清理

- JSON 状态保存 `MediaRef`；状态提交后调用 `noteState(uid, prev, next)` 登记引用。
- 后台清理任务：
  - 只处理满足宽限期（默认 14 天）的未引用文件。
  - 状态文件不可读或清理标记异常时跳过该账号。
  - 不删除仍被引用的文件。
- `POST /api/media/sweep` 是用户主动“重置”，使用 `graceMs: 0` 立即删除当前状态未引用的文件；受独立 `MEDIA_SWEEPS` 限流，状态不可读时删除 0 个。
- 账户删除调用 `removeUser(uid)`，只删该账号目录。
- 启动时清理上次进程留下的临时上传文件。
- 每小时清理计时器由 17 启动，不在 Service 构造函数里启动。

### 3.4 Nginx

- `web/nginx.conf.template` 的 `/api/media/` 块：
  - `client_max_body_size ${MEDIA_UPLOAD_MAX}`。
  - `proxy_request_buffering off`、`proxy_buffering off`。
  - 300 秒读写超时。
- 迁移不修改这些设置；A5 验证上传限制和流式传输。

## 4. 执行步骤

### 4.1 MediaService

- [ ] 新增 `api/src/media/media.service.ts`，包装 [media.js](../../../api/media.js) 的 `createMediaStore`：
  - `limits`、`config()`、`receive`、`send`、`missing`、`sweep`、`noteState`、`removeUser`。
  - `readState` 回调指向 `StateStore.read`，用于引用检查。
  - 临时目录 / 用户目录按旧布局。
- [ ] `MEDIA_UPLOADS=0` 时 `createMediaStore` 不启用，Controller 不注册。
- [ ] 复用 `HASH_RE`、`MEDIA_TYPES`、`sniffMedia`、`mp4Info`、`referencedHashes`；不要重写嗅探逻辑。
- [ ] 媒体根目录、用户目录、临时文件命名和权限与旧入口一致。

### 4.2 上传 Controller

- [ ] 新增 `MediaController` 的 `PUT :hash`：
  - 校验 `hash` 格式（64 位小写十六进制）；不符合返回 404。
  - 会话 Guard、CSRF、限流、上传额度。
  - 调用 `BodyTimeout.allowSlowBody(req)`。
  - 把 `req` 原始流交给 `MediaService.receive`。
  - 成功后返回旧状态码 / JSON / 头；重复哈希按旧行为。
  - 失败清理临时文件；客户端断开标记 `clientGone`。
- [ ] 不要用 `@Body()` 或全局 body parser 读取上传内容。
- [ ] 上传过程中不要缓冲整个文件到内存；按流式校验。

### 4.3 下载 Controller

- [ ] `GET :hash`：
  - 会话 Guard；按用户目录查找。
  - 文件不存在 / 无权限返回旧状态码，不泄露其他账号是否存在该哈希。
  - 设置旧安全头；使用 `res` 流式输出。
  - 客户端断开时销毁流，释放文件句柄。
- [ ] `POST /api/media/missing`：
  - 读取 `{ hashes: [...] }`，最多 1000 个；全部为 64 位小写十六进制。
  - 返回缺失列表；格式与旧入口一致。
- [ ] `POST /api/media/sweep`：
  - 读取请求体，走独立限流；`graceMs: 0`，立即清理当前状态未引用文件。
  - 返回旧结果结构；状态不可读时删除 0 个；清理失败只记录，不影响响应。

### 4.4 引用与清理

- [ ] `SyncService` 提交成功后调用 `MediaService.noteState(uid, prev, next)`；阶段 2 可先调用现有 `media.js`。
- [ ] 清理任务读取状态文件；异常时跳过该账号。
- [ ] 账户删除调用 `MediaService.removeUser(uid)`；只删该账号目录。
- [ ] 启动时删除临时上传文件；不删除已完成的媒体。
- [ ] 每小时清理计时器由 17 启动；关闭时等待在途清理。

### 4.5 账户删除 / 生命周期

- [ ] 07 / 08 的账户删除调用媒体清理路径。
- [ ] 关闭应用时保留用户媒体，不调用会清除用户记录的 `clearUser`。
- [ ] 在途上传、断流清理和临时文件回收计入 17 的在途集合。

## 5. 测试

### 5.1 现有测试

- `server-media.test.js`：上传 / 下载、鉴权、哈希、类型、大小、重复、清理、超时。
- `media-receive.test.js`、`media-sniff.test.js`、`media-refs.test.js`、`media-gc.test.js`、`media-damaged.test.js`、`media-samples.mjs`。
- `set-video-privacy.test.js`：视频 / 隐私边界。
- `server-account-delete.test.js`：账户媒体清理。
- RN `photos.ts` / Web `media-sync.js` 相关回归记录。

### 5.2 新增测试

- [ ] RN 上传进度照片，Web 读取同一媒体；Web 上传视频，RN 读取。
- [ ] 同账号重复上传同哈希按旧行为处理。
- [ ] 其他账号读取被拒绝（403 / 404 按旧入口）。
- [ ] 文件实际 SHA-256 与路径哈希一致；篡改后拒绝。
- [ ] 上传中断 / 客户端断开后临时文件被清理，不留下半文件。
- [ ] 仍被状态引用的文件在清理后保留；未引用且超过宽限期的文件被删除。
- [ ] 状态文件损坏时清理跳过该账号，不误删。
- [ ] 配额、每小时上传次数、并发上传限制。
- [ ] 容器内存限制下大文件流式传输不 OOM。
- [ ] Nginx 上传限制 / 缓冲 / 超时；`MEDIA_UPLOADS=0` 时四个路由 404。
- [ ] 账户删除只删除该账号目录。

### 5.3 命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-media.test.js test/media-receive.test.js test/media-gc.test.js test/media-refs.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 媒体路由在 `MEDIA_UPLOADS=1/0` 下的存在性和响应与旧入口一致。
- [ ] 上传、下载、缺失检查、清理的 JSON / 状态码 / 头一致。
- [ ] 文件与哈希一致，跨账号拒绝，重复上传行为一致。
- [ ] 断流清理、临时文件、配额、并发限制、宽限期正确。
- [ ] 状态提交后引用登记；清理不误删被引用文件。
- [ ] Nginx 媒体代理设置未改变，大文件流式传输通过。
- [ ] 账户删除只清理该账号媒体。
- [ ] A4 通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| 全局 body parser 缓冲大文件 | Controller 使用原始 `req` 流；`bodyParser: false`；大文件用例 |
| 临时文件 / 断流泄漏 | 在途集合 + 启动清理；A4 / A10 |
| 清理误删被引用文件 | 状态不可读时跳过；引用登记；宽限期 |
| 跨账号读取 | 用户目录隔离；双账号用例 |
| Nginx 配置漂移 | 不改模板；A5 验证上传限制 / 缓冲 |

## 8. 验收记录

```text
状态：待执行
代码版本：
媒体上传 / 下载 / 清理证据：
A4 结果：
遗留问题：
```
