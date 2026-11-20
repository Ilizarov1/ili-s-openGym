# 03 · 读取已有用户别名

状态为已实现，自动化验收通过；配对账号同步与工作区切换待补。对应 [总设计 S3](DESIGN.md#功能契约)。证据见 [验收记录](ACCEPTANCE.md#03--已有别名)。

## 依赖与执行范围

- [第 02 项](02_REUSE_WEB_SEARCH.md) 已通过。复用 [Web 别名规则](../../frontend/src/lib/exercise-aliases.js) 和 [Web 表单的存储结构](../../frontend/src/components/ExerciseAliases.jsx)。
- RN 只读工作区已有的 `Profile.exAliases` 和 `CustomExercise.aliases`。涉及 [类型](../../mobile-rn/src/training.ts)、[同步入口](../../mobile-rn/src/server.ts)、[本地工作区](../../mobile-rn/src/storage.ts) 及 RN 搜索适配层。默认别名词表与别名编辑属于后续范围。

## 执行步骤

1. 通过 Web 在测试账号 A 给内置动作 `1204` 保存一个目录里没有的别名，给一个自建动作保存另一个独有别名。准备账号 B 或无别名的本地工作区。记录期望 ID，确认实际同步状态能读到 `exAliases` 和自建动作 `aliases`；也可以用含相同结构的独立 fixture 验证本地读取。
2. 核对 RN 工作区持久化和同步响应对这两个字段的透传路径，收紧搜索适配层的可选类型。读取别名时显式传当前 `Profile.exAliases` 给现有规则，保留 Web 的规范化与覆盖语义。缺字段或坏值安全降级为空。已存放的别名保持原样。
3. 把规范化后的文本别名交给共享引擎，走正常计数、排序和分页。在同步更新、切换工作区和自建动作发生变化时，用当前数据刷新缓存。供第 05 项复用同一来源。
4. 执行下列回归。用配对的独立测试账号验证 Web 保存后 RN 同步读取，用可调试 fixture 补旧资料、异常字段和切换场景。

## 测试验收标准

```powershell
npm.cmd --prefix .\frontend test -- src/lib/exercise-aliases.test.js src/sheets.aliases.test.jsx
npm.cmd --prefix .\mobile-rn run check
```

| 编号 | 操作 | 通过标准 |
| --- | --- | --- |
| 03-A | Web 保存内置动作和自建动作的独有别名，RN 同步后搜索 | 各自返回正确 ID，结果计入正常检索；修改别名后再次同步可查新值 |
| 03-B | 从账号 A 切换到 B 或本地，再切回 A | 别名随当前工作区变化，B 或本地不显示 A 专用别名；切回能恢复 |
| 03-C | 读取无字段、空数组和非法值的资料，再搜已有名称 | 搜索正常，已有名称仍可命中；无有效别名的资料不会意外产生别名匹配 |

完成条件为 03-A 至 03-C 通过。记录账号切换结果和同步证据，使用测试账号标记，不记录凭据。
