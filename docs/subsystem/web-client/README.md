# 子系统路由：`web-client`（Web / PWA / Capacitor 客户端与领域引擎）

> 返回总路由：[AGENTS.md](../../../AGENTS.md) · [docs/README.md](../../README.md) · 工程规范：[code-standards.md](../../code-standards.md)

## 1. 职责与边界

负责基于 React 19 + Vite + Zustand 的主 Web / PWA 应用、上游设计源（CSS Tokens、图标与身体路径）、跨端共用的纯函数训练领域引擎（`frontend/src/lib/`），以及 Capacitor 封装的 iOS / Android 壳工程。

- **上游规范源头**：`frontend/src/index.css`（`:root` 设计变量）、`Icon.jsx` 与 `BodyMap.jsx` 是 [`mobile-rn`](../mobile-rn/README.md) 设计系统的唯一上游基准。
- **跨端领域共享**：`frontend/src/lib/` 中的渐进超负荷、1RM、疲劳恢复、热身阶梯、字段级同步合并等纯函数同时服务于 Web、Capacitor 端及部分 RN 复用层。

## 2. 代码入口与目录映射

| 路径 | 职责说明 |
|---|---|
| `frontend/src/App.jsx`、`frontend/src/views/` | 路由入口与各业务页面（Home、Plan、Workout、Library、Progress、Measurements、Settings 等） |
| `frontend/src/sheets.jsx`、`frontend/src/components/` | 底部弹出面板（选动作、配动作、训练详情等）与通用图表/计时器/媒体组件 |
| `frontend/src/store/useStore.js`、`useUI.js` | 持久化业务状态 `S`（`localStorage` + 移动端原生文件镜像 + 服务端防抖推送）与瞬态 UI 状态 |
| `frontend/src/lib/` | **纯函数领域层**（无框架依赖，同目录配对 `*.test.js`）：`progression.js`、`onerm.js`、`finish-workout.js`、`recovery.js`、`warmup-ramp.js`、`workout-model.js`、`supersetFlow.js`、`sync-merge.js`、`measurements.js`、`api.js` |
| `frontend/src/locales/`、`lib/i18n.js` | 20 语言文案包（以英文原文为键，`pt-BR` 继承自 `pt` 并带指纹校验） |
| `frontend/android/`、`frontend/ios/` | 上游 Capacitor Android / iOS 原生工程壳、小组件与原生桥接插件（手表部分详见 [`wearables`](../wearables/README.md)） |
| `frontend/scripts/` | 多语言完整性检查、源码硬编码字符串检查、移动端构建包校验与 PDF 渲染校验 |

## 3. 核心契约与双写对偶警示

1. **纯函数与单测伴生**：凡决定下一次训练负重/次数或解析已完成训练记录的规则，必须写成 `frontend/src/lib/` 下的纯函数并配套同目录 `*.test.js`。
2. **禁止手改生成文件**：`exercises-data.js`、`instr/`、`exercise-names/`、`exercise-desc/` 由 [`catalogue`](../catalogue/README.md) 构建脚本生成，严禁手工编辑。
3. **跨端刻意双写文件（修改必须双端同步）**：
   - `frontend/src/lib/sync-merge.js` ↔ `api/sync-stamps.js`（同步时间戳合并规则，含对偶测试）
   - `frontend/src/lib/glyphs.js` ↔ `api/coach/core/glyphs.js`
   - `frontend/src/lib/nudge.js` ↔ `api/nudge.js`
   - `frontend/src/lib/queue.js` ↔ `api/queue.js`
4. **多语言同步**：新增任何 `t('...')` 键必须补齐全部语言包并通过 `check-locales.mjs` 与 `check-source-strings.mjs --strict`。

## 4. 常用验证命令（PowerShell）

```powershell
# 运行全量或单文件 Vitest 单元测试
cd frontend; npm.cmd test
cd frontend; npx.cmd vitest run src/lib/progression.test.js

# 多语言与源码字符串严格门禁
cd frontend; node scripts/check-locales.mjs; node scripts/check-source-strings.mjs --strict

# 生产构建与 Capacitor 移动端打包校验
cd frontend; npm.cmd run build
```

## 5. 文档路由

- [系统整体架构与数据流图](../../ARCHITECTURE.md)
- [功能模块开关说明（Modules）](../../MODULES.md)
- [Capacitor 手机客户端与服务器连接](../../MOBILE.md)
- [第三方训练与体重数据导入导出](../../DATA_IMPORTS.md)
- [应用商店打包与签名发布](../../APP_STORES.md)
- **特性设计笔记**：[递减组与休息暂停组](../../dev/SET_TYPES.md) · [训练界面卡片/列表布局](../../dev/LIST_VIEW.md) · [合并训练计划规范](../../dev/COMBINE_ROUTINES.md) · [肌群疲劳与恢复模型](../../dev/FATIGUE_SETS_MODEL.md)
