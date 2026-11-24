# openGym Agent 总路由

Windows 环境统一使用 PowerShell。普通问答只读资料和源码，不运行测试。

本文件仅作为**顶层子系统与研发治理路由**（严格保持 ≤ 300 行），不展开具体子系统内部文件清单；开始任何任务前，先按下方路由进入目标子系统的 `README.md`。

## 1. 子系统路由表（唯一模块导航入口）

| 子系统 ID | 子系统路由（各 ≤ 300 行） | 职责边界摘要 |
|---|---|---|
| `mobile-rn` | [`docs/subsystem/mobile-rn/README.md`](docs/subsystem/mobile-rn/README.md) | Expo / RN Android 客户端、`src/design/` 设计系统、本地 SQLite、模拟器与真机视觉验收 |
| `web-client` | [`docs/subsystem/web-client/README.md`](docs/subsystem/web-client/README.md) | React 19 + Vite Web/PWA、上游 CSS 设计源、`frontend/src/lib/` 纯函数训练引擎、Capacitor 壳 |
| `api-sync` | [`docs/subsystem/api-sync/README.md`](docs/subsystem/api-sync/README.md) | NestJS 后端路由、`api/openapi.yaml`、Passkeys/配对、`DATA_DIR` 存储、409 同步与外部集成 |
| `ai-agent` | [`docs/subsystem/ai-agent/README.md`](docs/subsystem/ai-agent/README.md) | 共享 `agent-runtime`、多模态智能动作检索及评测 CLI、AI Coach、本地 MCP 服务 |
| `catalogue` | [`docs/subsystem/catalogue/README.md`](docs/subsystem/catalogue/README.md) | 5,600+ 动作原始词库、多语言翻译、演示媒体与跨端词库代码生成管线 |
| `wearables` | [`docs/subsystem/wearables/README.md`](docs/subsystem/wearables/README.md) | Apple Watch、Wear OS、Garmin、Zepp OS 表端与手机健康/训练快照同步 |
| `infra-ops` | [`docs/subsystem/infra-ops/README.md`](docs/subsystem/infra-ops/README.md) | Docker / Nginx、Helm / K8s / NixOS 自托管、官网 `website/`、Cloudflare 与 CI 发布流水线 |

> 文档侧镜像总入口见 [`docs/README.md`](docs/README.md)；产品概览、路线图与变更历史见 [`README.md`](README.md)、[`ROADMAP.md`](ROADMAP.md)、[`CHANGELOG.md`](CHANGELOG.md)。

## 2. `.agent/` 工程空间与持续开发铁律

所有研发迭代统一遵循 [`/opengym-development`](.agent/skill/opengym-development/SKILL.md) 技能规程与 [`docs/code-standards.md`](docs/code-standards.md)：

- **`.agent/notes/{proposed,implemented,archived}/`**：需求、设计、执行计划与验收证据（见 [说明](.agent/notes/README.md)）。
- **`.agent/skill/`**：项目公共技能（通过 [`.agent/skills.json`](.agent/skills.json) 自动挂载）。
- **`.agent/scripts/`**：治理自检（README 行数 ≤ 300、断链、错题升格提示）与实操录屏转 GIF 脚本。
- **`.agent/lessons.md` → `docs/code-standards.md`**：每次要求查错时，记录出错或高耗时步骤的「规则 + 原因 + 次数」；累计达 **3 次**后脱水压缩成 1~2 句祈使句升格写入 [`docs/code-standards.md`](docs/code-standards.md)。

### 修改代码必经闭环（摘要）

1. **改前语义级变更声明**：按受影响子系统写清触发条件（Trigger）、改前/改后行为（Before/After）、接口/状态/兼容性与失败模式变化，并附复现/基线及实测证据。
2. **改后四步核对**：① 定位受影响子系统和真实运行时路径 → ② 顺着调用链追踪改动行之外的副作用 → ③ 反向检查契约文档和源码链接是否同步更新 → ④ 核验测试是否真实覆盖了宣称的行为。
3. **UI 规范与 GIF 硬验收**：涉及 UI 必查设计系统（间距对齐、截断、触摸热区、宽度变化/软键盘焦点保持等）；单测全绿不等于视觉过关，凡改动用户可见 GUI 行为必须录制真实操作 GIF 存入对应需求文档。

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
