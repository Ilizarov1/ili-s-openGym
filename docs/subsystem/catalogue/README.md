# 子系统路由：`catalogue`（动作词库、多语言翻译与媒体管线）

> 返回总路由：[AGENTS.md](../../../AGENTS.md) · [docs/README.md](../../README.md) · 工程规范：[code-standards.md](../../code-standards.md)

## 1. 职责与边界

负责 openGym 内置 5,600+ 标准训练动作的原始结构化元数据、多语言名称与动作要领翻译、多分辨率（180px / 240px / 360px）演示动画资产、按部位浏览目录，以及将词库编译分发至 [`web-client`](../web-client/README.md)、[`mobile-rn`](../mobile-rn/README.md) 与 [`ai-agent`](../ai-agent/README.md) 受控词表的构建管线。

## 2. 代码入口与目录映射

| 路径 | 职责说明 |
|---|---|
| `catalogue/exercises/<id>.json` | 单动作权威数据源（目标肌群、协同肌、器械分类、动作类型、单侧属性与步骤说明） |
| `catalogue/i18n/` | 各语种动作名称与说明翻译包 |
| `catalogue/media/` | 独立许可的动作演示动画资源（详见 `catalogue/media/NOTICE.md`） |
| `catalogue/browse/` | 按身体部位（胸、背、肩、上下肢、核心、有氧等）生成的 Markdown 浏览索引 |
| `scripts/catalogue/build.mjs` | 词库主构建器：校验 schema 并生成前端 `exercises-data.js`、多语言分包与浏览索引 |
| `scripts/catalogue/stage-media.mjs` | Capacitor 移动端打包时的动作媒体分阶段拷贝工具 |
| `mobile-rn/scripts/generate-catalogue-content.mjs`、`stage-catalogue-media.mjs` | RN 客户端词库内容生成与媒体资源暂存脚本 |

## 3. 核心契约与不变式

1. **单一数据源（Single Source of Truth）**：修改任何内置动作的名称、目标肌群、器械枚举或步骤说明，只能在 `catalogue/` 原文件中修改并重跑构建脚本；严禁直接手工修改 `frontend/src/lib/exercises-data.js`、`frontend/src/locales/` 下的生成产物或 `mobile-rn` 生成目录。
2. **受控词表联动**：器械（`EQUIPMENT_SLUGS`）或身体部位（`BODY_PART_SLUGS`）枚举若发生增删，必须同步检查 [`ai-agent`](../ai-agent/README.md) 中的 `api/agent-runtime/` 词表快照与检索匹配器。
3. **媒体许可边界**：动作演示媒体遵循独立许可协议（`NOTICE.md` 与 `catalogue/media/NOTICE.md`），与主仓库 AGPL-3.0 代码区分管理。

## 4. 常用验证命令（PowerShell）

```powershell
# 校验 catalogue 源文件与构建产物是否完全同步（CI 门禁）
node scripts/catalogue/build.mjs --check

# 重新生成前端动作词库与浏览目录
node scripts/catalogue/build.mjs

# RN 端同步生成词库索引
cd mobile-rn; npm.cmd run catalogue:generate
```

## 5. 文档与需求笔记路由

- [动作词库数据结构、字段规范与构建说明](../../../catalogue/README.md)
- [葡语与瑞典语动作翻译术语表](../../../catalogue/i18n-glossary-pt-sv.md)
- [动作演示媒体版权与许可说明](../../../catalogue/media/NOTICE.md)
- [按肌群分类的动作浏览总入口](../../../catalogue/browse/README.md)
- **关联检索需求笔记**：[RN 常规动作检索、别名与 Fuse 零结果候选](../../../.agent/notes/implemented/rn-exercise-search/DESIGN.md)
