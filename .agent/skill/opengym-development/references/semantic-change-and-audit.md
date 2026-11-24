# 语义级变更声明、改后四步核对与错题升格规范

本手册为 [`/opengym-development`](../SKILL.md) 第 2、5、7 阶段的执行模板与判定标准。

---

## 1. 改前「语义级变更声明」标准模板

修改任何业务代码前，按**每个受影响子系统**填写以下结构（多子系统联改时，按子系统分块列出接口与状态边界）：

```markdown
## 语义级变更声明（Semantic Change Declaration）

### 子系统：`<mobile-rn | web-client | api-sync | ai-agent | catalogue | wearables | infra-ops>`
- **涉及模块与真实入口**：
  - 入口路由 / 页面 / 命令：`<如 opengym://library、POST /api/sync、Library.jsx>`
  - 拟改动源码与对偶文件：`<列出主文件及如 sync-merge.js <-> sync-stamps.js 等对偶项>`
- **触发条件（Trigger）**：
  - `<写清在什么前置状态、什么输入/点击/网络/配置条件下会触发本逻辑>`
- **改前 / 改后行为（Before / After）**：
  - **Before**：`<当前实际可观察到的行为、输出或缺陷现象>`
  - **After**：`<修改后预期的外部可观察行为、状态落点与用户反馈>`
- **接口 / 状态 / 兼容性变化（Contract, State & Compatibility）**：
  - **接口契约**：`<OpenAPI schema、组件 Props、Agent 任务契约或深链参数是否有增删改>`
  - **状态与持久化**：`<Zustand gym_state_v1、RN SQLite、DATA_DIR JSON 字段变化>`
  - **兼容性与迁移**：`<旧版存档读取兼容、Web <-> RN 双向 409 同步字段时间戳兼容>`
- **失败模式与降级兜底（Failure Modes & Fallback）**：
  - `<断网离线、请求超时、409 版本冲突、空结果、权限拒绝或异常脏数据时的回退表现>`
- **实测证据（Empirical Evidence）**：
  - **改前基线 / 复现证据**：`<复现命令输出、报错日志、基线评测指标或问题录屏>`
  - **改后闭环实测证据**（实施后必填）：`<单测/集成测试实跑结果 + GUI 真实操作 GIF 路径 evidence/xxx.gif>`
```

### 合格与不合格判定
- **不合格（退回重写）**：只写“修改 `foo.js` 的 `handleSave` 函数增加空值判断”，未交代上层触发场景、持久化与双端同步影响、失败降级及实测证据。
- **合格**：任何未读过本次 diff 的审查者仅凭声明即可明确知晓“什么条件下触发、用户体验与数据契约发生了什么变化、异常时如何兜底、靠什么实测证据证明”。

---

## 2. 改后「四步核对」逐项检查表

代码编辑完成后、宣布完成前，必须逐项完成以下四步核对并输出简明核对记录：

```markdown
## 改后四步核对记录（Post-Edit 4-Step Verification）

1. **① 受影响子系统与真实运行时路径**：
   - 已核实子系统：`<ID 列表>`
   - 运行时入口链路：`<入口 -> 控制器/视图 -> 领域函数/存储>`（已确认挂载在真实生效分支，且跨端刻意双写文件已同步检查）
2. **② 调用链行外副作用追踪**：
   - 上游调用方（Callers）：`<列举所有调用方及传参假设是否仍成立>`
   - 下游与共享状态副作用：`<列举受影响的 Store 订阅者、SQLite 表、缓存键、重渲染或并发锁>`
3. **③ 契约文档与源码链接反向同步**：
   - 子系统路由与设计文档：`<已核对 docs/subsystem/*/README.md 及相关规范文档链接无断链>`
   - 自动契约门禁：`<如 build-api-docs.mjs --check / catalogue/build.mjs --check / build-coach-assets.mjs --check 结果>`
4. **④ 测试真实覆盖度核验**：
   - 正常行为覆盖：`<具体测试文件与用例名，断言了哪些真实状态/输出>`
   - 失败模式覆盖：`<具体异常/边界测试用例名，确认非纯 Mock 自循环>`
```

---

## 3. `lessons.md` 脱水升格示例（满 3 次 → `docs/code-standards.md`）

当 `.agent/lessons.md` 中某条 `tracking` 规则的 `次数` 累加至 `3` 时：

- **升格前（`lessons.md` 详尽排障形态）**：
  - **规则**：模拟器执行 `uiautomator dump` 超时拿不到控件树时，在深链后附加 `?e2e=1`（或 `&e2e=1`）冻结训练计时与休息倒计时后再采样。
  - **原因**：训练页每秒刷新的用时计时器与休息倒计时动画使 Android Accessibility 持续判定窗口非空闲，导致 `dump` 阻塞超时。
  - **次数**：`3`
- **脱水升格后（写入 `docs/code-standards.md` 的 1~2 句祈使句）**：
  - `[L-004]` 在 Android 模拟器抓取训练页或休息态控件树前，通过深链附加 `e2e=1` 冻结实时计时器，避免 `uiautomator dump` 因动画刷新超时。
