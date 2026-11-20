# 02 · 复用 Web 基础检索

状态为已实现，自动化验收通过；设备已验证中文、英文、错字查询和 Metro 装载，计划入口待补。对应 [总设计 S2](DESIGN.md#功能契约)。证据见 [验收记录](ACCEPTANCE.md#02--共享检索)和[模拟器验收](ACCEPTANCE.md#模拟器验收2026-11-20)。

## 依赖与执行范围

- [第 01 项](01_ENTRY_BASELINE.md) 的入口和数据基线。前端与 RN 各自的锁定依赖、能启动的 Metro 和 Android 模拟器。
- 改动集中在 [Web 检索代码](../../frontend/src/lib/exercises.js)、同目录的共享纯 JS 搜索模块、[RN 目录](../../mobile-rn/src/catalogue.js) 和 [RN 动作库页面](../../mobile-rn/src/screens/ExerciseLibraryScreen.tsx)。Web 页面沿用现有 `searchExercises`、`matchExercise`、`similarExercises` 调用。

## 执行步骤

1. 用相同候选 ID、语言和排序前输入记录现有 Web 输出，覆盖精确词、简称或连字符、多词、英文错字及并列排名。基线至少记录命中 ID 和前 5 名。运行下列现有 Web 回归作为迁移前证据。
2. 沿用 Web 的抽词、近似匹配和排名实现，提取为两端可调用的纯 JS 模块。把名称拼接、语言字段、别名读取和缓存更新上下文交给适配层。同步检查相关度依赖的 `cat`、`tg`、经典动作 ID 和优先级规则。保留 `exercises.js` 的导出及 Web 调用行为，避免两份规则分叉。
3. 在 RN 让自建动作和内置目录形成同一候选池。适配 Web 引擎所需的字段，用 RN 的中英文名称源构造搜索文本。原有部位、器械和仅收藏条件应用于候选池。空查询复用原有浏览与收藏顺序；有效查询采用共享相关度顺序。
4. 保证结果总数和分页来自同一次匹配结果。先算完整结果再截断显示，沿用原有加载更多及切换查询时重置页长的流程。现有页面行、详情和选择动作回调继续接收原动作 ID。
5. 运行 Web 回归，构建 RN，核对相同候选池下的匹配和排名，再从第 01 项四个入口验证。记录抽取前后输出差异和预期内的 RN 行为变化。

## 测试验收标准

从仓库根目录执行：

```powershell
npm.cmd --prefix .\frontend test -- src/lib/exercises.test.js src/lib/search-typo.test.js src/lib/search-popular.test.js src/lib/exercise-names.test.js src/lib/exercise-aliases.test.js src/search-count.test.jsx src/search-clear.test.jsx
npm.cmd --prefix .\mobile-rn run check
```

| 编号 | 操作 | 通过标准 |
| --- | --- | --- |
| 02-A | 比对迁移前后 Web 的输出及已有回归 | 同一输入的命中和排序一致，Web 相关回归通过 |
| 02-B | RN 分别查询「绳索单臂高位下拉」、`cable one arm lat pulldown`、`cable pulldown` | 前两者包含 `1204`；多词满足共享匹配规则；在相同候选输入下 RN 和 Web 核心相对顺序一致 |
| 02-C | 搜索 `dumbell` 或基线记录的 Web 英文错词；使用现有筛选再查 | 继承 Web 原有英文容错，结果只来自当前候选池 |
| 02-D | 大结果集加载更多，再改查询或清空；匹配自建动作 | 计数等于当前条件下的完整结果数，加载无重复，改词重置页长。自建动作仍可选，空查询保持原收藏分组 |
| 02-E | RN 静态检查、实际 Metro 构建及四入口回归 | Metro 成功解析共享模块，01-A 至 01-C 的入口行为成立 |

完成条件为 02-A 至 02-E 通过，并留一份可与后续改动比较的结果记录。
