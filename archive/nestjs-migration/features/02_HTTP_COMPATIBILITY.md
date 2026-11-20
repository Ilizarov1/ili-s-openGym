# 02 · HTTP 兼容层

- 上级方案：[EXECUTION.md](../EXECUTION.md)
- 所属阶段：阶段 1（构建、启动和 HTTP 骨架）
- 依赖：[01 构建与启动](01_BUILD_AND_BOOTSTRAP.md)
- 对应设计：[DESIGN.md](../DESIGN.md) §3
- 代码落点：`api/src/common/http/`、`api/src/main.ts`
- 自有路由：0（作用于全部 91 个路由）
- 状态：待执行

## 1. 背景与目标

旧入口在 [server.js](../../../api/server.js) 的 `http.createServer` 里先处理 CORS、预检、请求目标校验和路由查找，再由 `readBody`、`json` 和末尾的 `try/catch` 统一处理请求体、响应和错误。Nest 的路由、异常过滤器和 NodeAdapter 都有自己的默认行为，必须在它们前面加一层兼容层，保证：

- 相同请求得到相同的状态码、响应头、JSON 结构和日志行为。
- 未知路径、错误方法、尾斜杠、`HEAD`、非法请求目标不会被 Nest 的默认行为“修正”。
- 媒体上传的流式读取和普通请求体的 5 MiB 限制不会被全局 body parser 破坏。
- 业务代码只处理业务错误，HTTP 兼容逻辑集中在一处。

## 2. 范围

### 2.1 包含

- `NodeAdapter.setOnRequestHook` 的 CORS / 预检 / 请求目标校验。
- 尾斜杠和 `HEAD` 到 `GET` 的 NodeAdapter 回退处理。
- `BodyReader`、`BODY_TIMEOUT_MS`、`allowSlowBody`。
- 全局异常过滤器、JSON 响应工具、媒体响应头。
- 未知路由 / 错误方法的 `404 { error: 'not found' }`。
- `requestTimeout`、`headersTimeout` 和客户端断开处理。

### 2.2 不包含

- 认证、CSRF、限流和权限；见 05。
- 媒体业务校验；见 12。
- 具体 Controller 的业务状态码；由各功能文档负责。
- 修改 Nginx 的代理配置。

## 3. 现状与必须保留的行为

| 行为 | 旧入口位置 | 兼容要求 |
| --- | --- | --- |
| CORS 反射 | `server.js:3032` 附近 | 有 `Origin` 时反射该 Origin，设置 `Vary: Origin`；不设置 `Allow-Credentials` |
| `OPTIONS` | `server.js:3040` | 任意路径返回 `204`，带固定方法 / 头 / `Max-Age`；仅 App WebView 来源返回 PNA 头 |
| 请求目标校验 | `server.js:3057` | `//`、`//api%2Fhealth` 等返回 `400 { error: 'bad request' }`，进程不退出 |
| 尾斜杠 | 路由表精确匹配 | `/api/health/` 不是 `/api/health`，按旧入口返回 `404` |
| `HEAD` | 路由表精确匹配 | 旧入口没有 `HEAD` 路由，返回 `404`；不能因为 NodeAdapter 回退到 `GET` 而变成 `200` |
| 媒体路径 | `server.js:3071` | 只匹配 `/api/media/<64 位小写十六进制>`，映射到 `/api/media/{hash}` |
| 请求体 | `readBody`，`server.js:817` | 5 MiB；空体 `{}`；`application/json`；`400/413/415`；超限后读掉数据再断开 |
| 请求时限 | `BODY_TIMEOUT_MS` | 普通路由 5 分钟；已授权媒体上传改用媒体空闲计时器 |
| JSON 响应 | `json`，`server.js:805` | `Content-Type: application/json`、`Cache-Control: no-store`、可追加多个头 / `Set-Cookie` |
| 错误映射 | `server.js:3099` 附近 | `HttpError` / `MediaError` / `BusyError` / `clientGone` / 未知 500 |
| 未知路由 | `server.js:3074` | `404 { error: 'not found' }`，不是 Nest 默认错误体 |

## 4. 执行步骤

### 4.1 请求钩子

- [ ] 在 `api/src/common/http/request-hook.ts` 实现 `installRequestHook(adapter, config)`：
  - 读取原始 `req.url`、`req.method` 和 `req.headers`。
  - 有 `Origin` 时设置 `Access-Control-Allow-Origin` 和 `Vary: Origin`。
  - `OPTIONS` 立即返回 `204`，写入旧入口的 `Access-Control-Allow-Methods`、`Access-Control-Allow-Headers`、`Access-Control-Max-Age`。
  - PNA：仅 `https://localhost`、`capacitor://localhost`、`http://localhost` 且 `Access-Control-Request-Private-Network: true` 时返回 `Access-Control-Allow-Private-Network: true`。
  - 解析 `new URL(req.url, 'http://x')`；解析失败返回 `400 { error: 'bad request' }`。
  - 比较 `req.url.split('?')[0]` 与 `url.pathname`；不一致返回 `400`。
  - 记录规范化后的 path 和 method，供后续 Guard / Controller 使用。
- [ ] 在钩子中显式处理尾斜杠：如果原始 path 以 `/` 结尾且不是合法路由，直接返回旧入口的 `404`，不要交给 NodeAdapter 的宽松路由。
- [ ] 在钩子中显式处理 `HEAD`：旧入口没有 `HEAD` 路由时返回 `404`；若未来需要 `HEAD`，必须逐个路由声明，不能全局回退。
- [ ] 媒体路径只在钩子中记录 `mediaHash`，不要在这里做账号授权；授权见 12。
- [ ] 钩子必须同步完成，不能 `await` 业务逻辑；需要异步的地方交给 Controller / Service。

### 4.2 请求体读取

- [ ] 在 `api/src/common/http/body-reader.ts` 实现 `BodyReader.read(req)`：
  - 监听 `data` / `end` / `error`。
  - 累计超过 `5 * 1024 * 1024` 时先拒绝 `413 body too large`；继续读掉后续数据，超过两倍上限才 `req.destroy()`。
  - 空请求体 resolve `{}`。
  - `Content-Type` 必须是 `application/json`（允许 `; charset=...`），否则 `415 content-type must be application/json`。
  - `JSON.parse` 失败、`null`、数组、字符串、数字都返回 `400 invalid json`。
  - `req` 的 `error` 标记 `clientGone`，由过滤器只记一行日志。
- [ ] 错误类型使用 `HttpError(status, message)`，不要在每个 Controller 里手写状态码和 JSON。
- [ ] 只在需要 JSON 的 Controller 调用 `BodyReader`；不要注册全局 `bodyParser`。

### 4.3 请求体时限

- [ ] 在 `api/src/common/http/body-timeout.ts` 实现 `BODY_TIMEOUT_MS`（默认 300000）：
  - 请求到达时启动计时器。
  - `req.complete` 为真或收到 `end` 时清除。
  - 超时后销毁 socket，行为与旧入口一致。
- [ ] 提供 `allowSlowBody(req)`：媒体路由在会话和额度检查通过后调用，取消普通 body 计时器，把超时交给媒体存储的 60 秒空闲计时器。
- [ ] 不要在 Nest 全局中间件里统一读取 body；媒体上传需要原始流。

### 4.4 响应工具

- [ ] 在 `api/src/common/http/reply.ts` 实现：
  - `json(res, status, body, extraHeaders?)`：`JSON.stringify`、`Content-Type`、`Cache-Control: no-store`、合并额外头。
  - `appendCookie(res, cookie)`：使用 `res.appendHeader('Set-Cookie', ...)` 或数组，不覆盖其他 Cookie。
  - `mediaHeaders(...)`：由 12 号文档定义，但是工具函数放在同一层，避免媒体 Controller 重复拼头。
  - 已发送头部时不再写响应；返回值便于测试。
- [ ] 所有 JSON 成功 / 错误响应都经过该工具，禁止 Controller 直接 `res.end(JSON.stringify(...))`（除媒体流）。

### 4.5 全局异常过滤器

- [ ] 在 `api/src/common/http/http-exception.filter.ts` 实现 `@Catch()` 过滤器：
  - `HttpError` → `status`、`{ error: message }`。
  - `MediaError` → `status`、`{ error, code, ...extra }`、媒体响应头。
  - `BusyError` → `503`、`{ error: 'the server is busy, try again in a moment', code: 'busy' }`、`Retry-After: 2`。
  - `clientGone` → 只记一行 `console.warn`，不写 500。
  - 未知错误 → `console.error` 后 `500 { error: 'server error' }`，不泄露堆栈。
  - `res.headersSent` 为真时不要再写第二个响应。
- [ ] 处理 Nest 未匹配路由抛出的 `NotFoundException`，统一输出 `{ error: 'not found' }`。
- [ ] 处理 Nest 默认的 405 / 404 差异：旧入口按“路由表中没有这个 METHOD + path”返回 404，不返回 405。

### 4.6 服务器超时与连接

- [x] 在 `start-api.ts` 的 `listen` 前配置 `requestTimeout = 30 * 60000`、`headersTimeout = 60000`，由 `shutdown.test.js` 在运行的 HTTP 服务器上确认。
- [ ] 确认 NodeAdapter 使用原始 `req` / `res`，媒体上传不经过 Nest 的响应序列化。
- [ ] 客户端中断时，释放 `BodyReader` 的监听器和计时器；不要留下悬挂 Promise。
- [ ] 关闭应用时由 17 号文档的协调器拒绝新请求；本层只提供 `closing` 检查和连接释放。

### 4.7 路由匹配辅助

- [ ] 为 Controller 提供统一的路径声明约定：`app.setGlobalPrefix('api')`，Controller 不重复 `api/`。
- [ ] 为 `{hash}` 路径提供参数校验：小写 64 位十六进制；不符合的请求返回 404，而不是进入媒体 Controller。
- [ ] 写一个 `requestKey(req)` 工具，返回 `METHOD /api/path`，供测试、审计和路由矩阵复用。

## 5. 测试

### 5.1 现有测试

以下测试改为 `API_ENTRY=dist/src/main.js` 后应通过：

- `server-cors.test.js`
- `server-url.test.js`
- `server-body-errors.test.js`
- `server-bad-input.test.js`
- `server-media.test.js` 中请求体时限相关用例

### 5.2 新增用例

- [ ] `OPTIONS /api/anything` 返回 `204`，头字段与旧入口一致。
- [ ] `OPTIONS` 来自普通网页不返回 PNA；来自 `https://localhost` 且声明私网时返回 PNA。
- [ ] `//`、`//api%2Fhealth` 返回 400，进程继续响应后续请求。
- [ ] `/api/health/` 返回 404，`HEAD /api/health` 返回 404。
- [ ] 未知路径、错误方法返回 `{ error: 'not found' }`。
- [ ] 空请求体、`null`、数组、字符串、数字、无 `Content-Type`、`text/plain`、无效 JSON 的状态码。
- [ ] 5 MiB 边界：刚好通过、超过返回 413、超过两倍断开、客户端继续写完时不收到 TCP reset 而是 413。
- [ ] 慢速请求体在 `BODY_TIMEOUT_MS` 后被切断；已授权媒体上传不被普通时限切断。
- [ ] 多条 `Set-Cookie` 同时存在时都保留。
- [ ] 媒体响应不经过 JSON 工具，长度 / 类型 / 缓存头由 12 号文档测试。

### 5.3 运行命令

```powershell
Set-Location D:\dev\open-gym\api
npm.cmd run build
$env:API_ENTRY = 'dist/src/main.js'
node --test test/server-cors.test.js test/server-url.test.js test/server-body-errors.test.js test/server-bad-input.test.js
Remove-Item Env:API_ENTRY
```

## 6. 验收目标

- [ ] 91 个路由的 CORS / 预检 / 错误外壳与旧入口一致。
- [ ] 非法请求目标、尾斜杠、`HEAD` 不会进入业务 Controller。
- [ ] 请求体上限、类型、JSON 解析和超时行为与旧入口一致。
- [ ] 未知路由 / 错误方法返回旧 JSON，不出现 Nest 默认错误页。
- [ ] 媒体上传仍可流式读取，不被全局 body parser 截断。
- [ ] 所有错误只写一次响应，客户端断开始终只记一行日志。
- [ ] 对应 A5 中的代理 / 请求限制检查可以通过。

## 7. 风险与回退

| 风险 | 应对 |
| --- | --- |
| NodeAdapter 对尾斜杠 / `HEAD` 的默认行为与旧入口不同 | 钩子显式拦截；真实 HTTP 测试；不改业务 Controller |
| 全局 body parser 误开启 | `NestFactory.create(..., { bodyParser: false })`；启动测试上传大文件 |
| 异常过滤器重复写响应 | 每次写前检查 `res.headersSent`；媒体流单独处理 |
| 413 时继续读数据导致 socket 重置 | 按旧逻辑读到两倍上限才 destroy；用例覆盖 |

## 8. 验收记录

```text
状态：待执行
代码版本：
HTTP 兼容用例：
产物 / 请求日志：
遗留问题：
```
