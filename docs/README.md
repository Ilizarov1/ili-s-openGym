# openGym 文档总路由

本文件仅作为全仓库**子系统级路由入口**（长度严格保持 ≤ 300 行）。具体模块架构、源码映射、契约不变式、验证命令及功能指南，请进入对应子系统的 `README.md` 查看。

## 1. 七大子系统路由

| 子系统 | 路由入口 | 管辖源码与核心职责 |
|---|---|---|
| **RN Android 客户端与设计系统** | [`docs/subsystem/mobile-rn/README.md`](subsystem/mobile-rn/README.md) | `mobile-rn/`（不含共享 Agent 核）：Expo Android 五 Tab 页面、SQLite、`src/design/` 设计系统、模拟器与真机视觉脚本 |
| **Web / PWA / Capacitor 与领域引擎** | [`docs/subsystem/web-client/README.md`](subsystem/web-client/README.md) | `frontend/`：React 19 + Vite 页面、上游 CSS Tokens、`src/lib/` 纯函数训练引擎、i18n 多语言与 Capacitor 手机壳 |
| **后端 API、认证、存储与同步** | [`docs/subsystem/api-sync/README.md`](subsystem/api-sync/README.md) | `api/`（核心网关与同步）：NestJS 路由、`openapi.yaml`、Passkeys/配对、`DATA_DIR` 原子存储、409 字段级同步与 Webhook 集成 |
| **AI Agent、多模态检索、Coach 与 MCP** | [`docs/subsystem/ai-agent/README.md`](subsystem/ai-agent/README.md) | `api/agent-runtime/`、`api/src/agent/`、`api/coach/`、`frontend/src/agent/`、`mobile-rn/src/agent/`、`mcp/` 与检索评测 CLI |
| **动作词库、多语言与媒体管线** | [`docs/subsystem/catalogue/README.md`](subsystem/catalogue/README.md) | `catalogue/`、`scripts/catalogue/`：5,600+ 动作元数据、译文、演示动画许可及前端/RN 词库生成管线 |
| **穿戴与手表客户端** | [`docs/subsystem/wearables/README.md`](subsystem/wearables/README.md) | `watch-zepp/`、`frontend/android/wear/`、`frontend/garmin/`、`frontend/ios/App/Watch*` 及手表/健康双向同步桥 |
| **部署运维、容器、官网与 CI** | [`docs/subsystem/infra-ops/README.md`](subsystem/infra-ops/README.md) | `docker-compose.yml`、`web/`、`helm/`、`kubernetes/`、`contrib/nix/`、`website/`、`cloudflare/`、`.github/` 与 `scripts/` |

## 2. 工程治理与 Agent 协作入口

| 入口 | 说明 |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | Agent 顶层路由、工作流铁律与环境守则 |
| [`docs/code-standards.md`](code-standards.md) | 全仓库强制编码与架构标准（含由错题本满 3 次脱水升格的祈使句规则） |
| [`.agent/lessons.md`](../.agent/lessons.md) | 查错与高耗时瓶颈复盘账本（记录规则 + 原因 + 命中次数，满 3 次升格） |
| [`.agent/notes/`](../.agent/notes/README.md) | 需求文档生命周期目录：`proposed/`（待实施）→ `implemented/`（已验收）→ `archived/`（归档） |
| [`.agent/skill/opengym-development/`](../.agent/skill/opengym-development/SKILL.md) | `/opengym-development` 持续开发主技能（语义级变更声明、改后四步核对、UI 规范与 GIF 硬验收） |
