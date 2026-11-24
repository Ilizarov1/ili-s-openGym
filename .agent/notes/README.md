# `.agent/notes` — 需求与方案生命周期目录

所有新功能、重构、架构演进和专项排查文档按生命周期存放在以下三个子目录中，不再直接散落在 `docs/` 根目录：

| 目录 | 阶段语义 | 准入条件 |
|---|---|---|
| [`proposed/`](proposed/) | 待评审 / 待实施 | 包含需求分析、按子系统编写的**语义级变更声明**、技术设计与执行计划，尚未合入代码或尚未完成实测验收 |
| [`implemented/`](implemented/) | 已实施并完成验收 | 代码已落地，完成改后四步核对、自动化测试及实测证据（GUI 改动含真实操作 GIF）归档 |
| [`archived/`](archived/) | 历史归档 / 已被替代 | 早期里程碑、一次性迁移记录或已被新方案覆盖的历史执行文档 |

## 流转规则

1. **立项**：在 `proposed/<feature-slug>/` 下新建方案（小需求可单文件，大需求拆分为 `REQUIREMENTS.md` / `DESIGN.md` / `EXECUTION.md` / `ACCEPTANCE.md` 及 `evidence/` 目录），在改代码前必须写妥**语义级变更声明**。
2. **交付**：通过改后四步核对与前端硬验收（含 `evidence/*.gif`）后，将整个 `<feature-slug>/` 目录移入 `implemented/`，并同步更新对应子系统的 `docs/subsystem/<subsystem>/README.md` 路由索引。
3. **归档**：当某项历史方案被后续重构完全取代或封版归档时，移入 `archived/` 并更新子系统路由。
