---
name: opengym-development
description: >-
  openGym 仓库全子系统持续开发与治理主技能。适用于 mobile-rn、web-client、api-sync、ai-agent、catalogue、wearables、infra-ops
  任意子系统的需求规划、功能开发、重构、Bug 排查与验收交付。强制执行子系统路由导航、改前语义级变更声明、改后四步核对、UI 设计系统九维审查、真实操作 GIF 前端硬验收，以及 lessons.md 至 code-standards.md 的查错升格机制。
---

# openGym 持续开发规程（`/opengym-development`）

Windows 环境统一使用 PowerShell。普通问答仅读资料与源码，不运行测试；用户仅要求规划或设计时，停在指定阶段等待确认。

## 0. 子系统路由与规范预读（严禁盲搜全仓）

1. 先读根目录 [`AGENTS.md`](../../../AGENTS.md)（或 [`docs/README.md`](../../../docs/README.md)），识别本次任务命中的子系统（`mobile-rn` / `web-client` / `api-sync` / `ai-agent` / `catalogue` / `wearables` / `infra-ops`）。
2. 进入对应子系统的 `docs/subsystem/<subsystem>/README.md` 获取代码入口、核心契约、跨端双写文件与验证命令，并阅读 [`docs/code-standards.md`](../../../docs/code-standards.md) 与 [`.agent/lessons.md`](../../lessons.md)。
3. 探索代码时优先调用 `codegraph_explore` 与 `tokless skeleton` 定位符号及行号区间，再按行号精准读取源码。
4. 新增或调整子系统职责、文档路由时，必须保持 `AGENTS.md`、`docs/README.md` 及每个 `docs/subsystem/*/README.md` 长度 **≤ 300 行**。

## 1. 需求笔记生命周期（`.agent/notes/`）

所有需求相关文档统一归入 `.agent/notes/`，不再散落于 `docs/` 根目录：

- **立项与设计（`proposed/`）**：可用 `.\.agent\scripts\new-proposal.ps1 -Slug <feature-slug> -Subsystem <id>` 一键初始化 `.agent/notes/proposed/<feature-slug>/PROPOSAL.md` 与 `evidence/` 目录（大需求可拆分为 `REQUIREMENTS.md`、`DESIGN.md`、`EXECUTION.md`、`ACCEPTANCE.md`）。
- **已验收交付（`implemented/`）**：代码合入、四步核对与实测证据（含 GUI 真实操作 GIF）齐全后，将目录移至 `.agent/notes/implemented/<feature-slug>/`，并同步更新所属 `docs/subsystem/<id>/README.md`。
- **历史淘汰（`archived/`）**：被后续方案完全替代或封版归档的历史文档迁入 `.agent/notes/archived/`。

## 2. 改前硬门槛：按子系统提交「语义级变更声明」

**未完成语义级变更声明前，严禁编辑业务源码。** 声明须写入当前 `.agent/notes/proposed/<slug>/` 文档（小修补亦须在动手前显式输出并留档），按**每一个受影响子系统**逐项写清（完整模板见 [`references/semantic-change-and-audit.md`](references/semantic-change-and-audit.md)）：

1. **受影响子系统与真实入口（Subsystem & Entrypoints）**：子系统 ID、模块路径及跨端对偶文件。
2. **触发条件（Trigger）**：触发该行为的具体用户动作、路由/深链、API 请求、定时器或状态前置条件。
3. **改前 / 改后行为（Before / After）**：从外部可观察语义对比改前与改后的精确表现（拒绝贴行号级代码改写流水账）。
4. **接口 / 状态 / 兼容性变化（Contract, State & Compatibility）**：HTTP OpenAPI、本地存储（`localStorage` / SQLite）、409 同步修订号与字段级时间戳、旧版本数据迁移及向后兼容性。
5. **失败模式与降级兜底（Failure Modes & Fallback）**：离线、超时、并发冲突、空结果、权限拒绝、非法输入下的行为变化与恢复路径。
6. **实测证据（Empirical Evidence）**：改前复现/基线实测记录，以及改后必须交付的命令日志、数据快照或交互 GIF 清单（实施后回填真实产物路径与哈希）。

## 3. UI 改动专项审查（设计系统 + 九维必检）

凡涉及 Web 或 RN 界面增改，**编码前**必须先查阅设计系统规范（RN 读 [`docs/RN_UI_DESIGN_SYSTEM.md`](../../../docs/RN_UI_DESIGN_SYSTEM.md) 与 [`docs/RN_UI_VISUAL_TESTING.md`](../../../docs/RN_UI_VISUAL_TESTING.md)；Web 读 `frontend/src/index.css` `:root` 变量与 `frontend/src/components/`），并逐项核验以下九维清单（完整细则见 [`references/ui-design-and-visual-gate.md`](references/ui-design-and-visual-gate.md)）：

1. **Token 与原语合规**：零硬编码色值、字号、圆角、阴影或裸间距；复用设计系统组件，新增通用模式先入 Gallery。
2. **间距节奏与基线对齐**：核对容器内边距、同级间距、图标与单/多行文字对齐、分割线缩进，以及动态数字列 `tabular-nums` 等宽防抖。
3. **截断、换行与多语言/大字号**：长动作名、20 语种词长膨胀、RTL（阿拉伯语）镜像、`flexShrink: 1` / `minWidth: 0` 防撑破，以及系统字体放大不裁切核心数值。
4. **移动端触摸热区与手势防冲突**：可点击目标热区 ≥ `44×44 dp/px`（小图标配 `hitSlop`），压态/禁用态反馈明确，左滑删组/横向 Chip 与纵向滚动、底部 Sheet 下拉手势不打架。
5. **宽度变化与软键盘焦点保持**：窗口宽度/断点切换、分屏旋转、受控输入刷新或列表重排时，严禁卸载重建输入框导致失焦、光标跳位或草稿丢失；软键盘弹出时输入框与主按钮自动避让可见。
6. **安全区与浮层留白**：适配顶栏状态栏/刘海、底部手势条、底部 `TabBar` 与休息倒计时 `RestDock` 叠加高度，列表末项可完整滚出。
7. **五态完备性**：空状态（Empty）、加载态（Loading 防布局跳动）、常规与极限数据态（Populated）、错误/离线可恢复态（Error/Offline）、提交中防连点态（Pending/Disabled）。
8. **双主题对比度与动效无障碍**：核验 Dark / Light 主题及自定义强调色下的表面层级与文本对比度，兼容 `prefers-reduced-motion` / 系统减动效。
9. **渲染与滚动性能**：长列表（如 5,600+ 动作库与历史记录）保持虚拟化/分页稳定，避免滚动帧内重度同步计算。

## 4. 隔离实施与平台构建

- 每个独立需求优先使用带需求标识的独立分支与 Git Worktree，保护主工作区已有未提交改动。
- **RN Android 专项规程**：Windows 原生构建必须在短路径 Worktree（如 `git worktree add D:\wt\<短名> -b <分支>`）下进行；界面调试坚持「先 Debug + Metro 热更新，确认通过后单次双架构 Release 构建与验签」；共享模拟器严格通过 `agent-device` 原子申领与 `finally` 释放。操作细节见 [`references/rn-android-env.md`](references/rn-android-env.md)。

## 5. 改后四步强核对（Post-Edit 4-Step Audit）

每次代码修改完成后，**必须按顺序逐条执行并记录以下四步核对**（核对表见 [`references/semantic-change-and-audit.md`](references/semantic-change-and-audit.md)）：

1. **① 定位受影响子系统和真实运行时路径**：确认所有受改动波及的子系统（含 `sync-merge.js` ↔ `sync-stamps.js` 等刻意双写文件），从真实用户操作 / HTTP 路由 / 深链入口核实代码处于实际生效链路，而非死分支或单端遗漏。
2. **② 顺着调用链追踪改动行之外的副作用**：沿上游 Callers 与下游 Callees、Zustand / SQLite 持久化状态、缓存失效、异步取消与并发重入链路，排查未直接修改但语义受影响的相邻逻辑。
3. **③ 反向检查契约文档和源码链接是否同步更新**：核查 `docs/subsystem/*/README.md`、`api/openapi.yaml`（运行 `node scripts/build-api-docs.mjs --check`）、`catalogue` / `coach` 资产检查及 `.agent/notes/` 文档中的契约描述与源码文件链接，确保零过期契约与零断链。
4. **④ 核验测试是否真实覆盖了宣称的行为**：对照第 2 步「语义级变更声明」的 Trigger、After 与 Failure Modes，逐一检查单测/集成测试是否真实执行了目标代码分支并断言了核心状态变化，剔除仅测 Mock 或无实质断言的“假绿”用例。

## 6. 前端硬验收：真实操作 GIF 强门禁

> **核心原则：单测全绿不等于视觉过关（Tests alone do not establish visual acceptance）。**

- 凡改动任何**用户可见 GUI 行为**（布局、样式、弹窗/Sheet、列表交互、搜索筛选、动画过渡、软键盘避让、状态提示等）的任务或 PR，**强制在真实运行环境中录制真实交互操作 GIF**（可使用 `.\.agent\scripts\record-gif.ps1` 或浏览器录屏转 GIF）。
- GIF 必须连续完整呈现 **「触发前初始态 → 真实点击/输入/滑动过程 → 变更后终态」**，禁止以单张静态截图拼接或仅贴终端测试日志替代。
- 产物统一存入对应需求目录的 `evidence/<flow-name>.gif`，并在需求验收文档与变更声明中以相对路径引用说明（详见 [`references/ui-design-and-visual-gate.md`](references/ui-design-and-visual-gate.md)）。

## 7. 查错复盘、升格与交付自检

1. **查错必记 `lessons.md`**：凡用户要求查错（排障修复），或执行中遭遇报错返工、超时重试、高耗时卡点，必须在 [`.agent/lessons.md`](../../lessons.md) 新增或累加记录，写明 **规则 + 原因 + 累计次数**。
2. **满 3 次脱水升格**：当某条规则累计达到 **3 次**时，立即将其脱水压缩为 **1~2 句祈使句**升格写入 [`docs/code-standards.md`](../../../docs/code-standards.md)，并将 `.agent/lessons.md` 中该项状态更新为 `promoted`。
3. **治理门禁收尾**：交付前执行 `.\.agent\scripts\verify-governance.ps1`，确保所有路由 `README.md` 均 ≤ 300 行、文档链接全部有效、且无漏升格的满 3 次复盘规则。
