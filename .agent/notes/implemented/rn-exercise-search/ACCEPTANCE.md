# RN 动作检索执行验收记录

记录日期 2026-11-20。源码基线 `42411be33` 加本次工作区改动。结论：01–05 的代码和自动化检查已完成；Android 模拟器已补检索、筛选、候选和训练添加/替换证据，计划添加、账号别名同步、收藏分页和断网耗时仍待验证。

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| 01 入口基线 | 设备部分通过 | 动作库选择、训练添加和训练替换已验证；计划添加、收藏/分页待补 |
| 02 Web 检索复用 | 自动化 + 设备部分通过 | 中文、英文、错字查询和 Metro 装载已验证；计划入口待补 |
| 03 已有别名 | 自动化通过 | 读取、覆盖、清除和隔离有测试；真实账号同步待补 |
| 04 组合筛选 | 自动化 + 设备部分通过 | 背阔肌/绳索/单侧交集和零结果截图已验证；逐项清筛和旧自建资料待补 |
| 05 Fuse 候选 | 自动化 + 设备部分通过 | 零结果候选、筛选池、正常结果隐藏和训练添加/替换选择已验证；计划添加、断网耗时待补 |

## 环境

| 项目 | 值 |
| --- | --- |
| 系统 | Windows 11 x64 |
| Node | v24.18.0 |
| Web 测试 | `frontend` / Vitest 4.1.12 |
| RN | Expo 55、React Native 0.83.10、TypeScript 5.9 |
| Fuse.js | `7.5.0`，写入 `mobile-rn/package.json` 与 `package-lock.json` |
| Android 设备 | `openGymRnQa` / `emulator-5554`，Android 16（API 36），1080×2400 |
| 设备操作 | `agent-device` 0.21.41，测试 IME 输入中文；Metro 8081 |

### 模拟器验收（2026-11-20）

| 条目 | 结果 | 证据 |
| --- | --- | --- |
| 01-A 动作库入口 | 通过 | 动作库同时显示内置动作和自建「自定义划船」；选择「绳索单臂高位下拉」后进入训练并带正确动作 |
| 01-B 计划/训练添加 | 训练添加通过；计划添加待补 | 训练「胸部与肩部训练 A」从 3 个动作增加到 4 个，导航到 4/4 显示「绳索单臂高位下拉」 |
| 01-C 替换索引 0 | 通过 | 第一项「杠铃卧推」替换后变为「绳索单臂高位下拉」，动作总数仍为 4 |
| 01-D 筛选与收藏 | 部分通过 | 部位、器械、目标肌群、仅单侧和清除查询已验证；收藏筛选、加载更多待补 |
| 02-B 中英文查询 | 通过 | 中文「绳索单臂高位下拉」返回 1 条；英文 `cable one arm lat pulldown` 返回 3 条并包含 `1204` |
| 02-C 错字 | 通过 | `dumbell` 返回哑铃动作列表 |
| 04-A 组合筛选 | 通过 | 「背阔肌 + 绳索 + 仅单侧」空查询返回 8 条，包含「绳索单臂高位下拉」，列表均为背部/绳索/单侧 |
| 04-E 筛选 UI | 部分通过 | 筛选面板、已选 3 项、零结果和候选区正常；详情返回待补 |
| 05-A 候选触发 | 通过 | `高位下啦` 正常结果为 0，显示「你可能在找」3 条，包含 `1204` 家族且无重复 |
| 05-B 正常结果隐藏 | 通过 | 输入「高位下拉」后返回 3 条正常结果，候选区消失 |
| 05-C 筛选池隔离 | 通过 | 候选列表全部为当前「背部 + 绳索 + 单侧」池内动作 |
| 05-D 短词/空查询 | 部分通过 | 空查询和「卧堆」不显示候选；工作区快速切换待补 |
| 05-E 四入口选择 | 三入口通过；计划添加待补 | 动作库候选、训练添加和索引 0 替换均选中候选；计划编辑添加待补 |
| 05-F 断网耗时 | 待补 | 未执行断网和耗时记录 |

截图位于 `mobile-rn/dist/ui/`（gitignored）：`search-cn.png`、`search-filters.png`、`search-fuse.png`、`search-replace.png`。

## 02 · 共享检索

实现：

- 新增 [共享搜索内核](../../frontend/src/lib/exercise-search.js)，包含多词、同义词、词形、错字、连写名称、相关度排序、并列优先项和相似动作规则。
- [Web 适配](../../frontend/src/lib/exercises.js)保留 `searchExercises`、`matchExercise`、`similarExercises`、`normalizeStr` 导出；语言、别名和缓存版本仍由 Web 提供。
- [RN 适配](../../mobile-rn/src/librarySearch.ts)把内置动作和自建动作放进同一候选池，使用中文名 + 英文名、中文部位/器械/肌群标签和同一套经典动作 ID 排序。
- [目录数据](../../mobile-rn/src/catalogueData.js)与媒体分离，搜索模块不再加载 `require()` 媒体。

命令与结果：

```powershell
npm.cmd --prefix .\frontend test -- src/lib/exercises.test.js src/lib/search-typo.test.js src/lib/search-popular.test.js src/lib/exercise-names.test.js src/lib/exercise-aliases.test.js src/search-count.test.jsx src/search-clear.test.jsx
```

7 个文件、146 个测试通过。另用 `git show HEAD:frontend/src/lib/exercises.js` 的旧实现与抽取后的实现逐条比对 18 个查询（精确词、连写、连字符、多词、英文错字、部位词、无结果查询）的完整命中 ID 和相似结果顺序，输出 `web parity OK`，未发现差异。

补充契约测试 [exercise-search-rn.test.js](../../frontend/src/lib/exercise-search-rn.test.js) 验证：

- `绳索单臂高位下拉`、`cable one arm lat pulldown`、`cable pulldown` 都包含 `1204`。
- `dumbell` 继承 Web 英文错字容错；中文部位词可搜索。
- 保存/清除别名立即影响结果。
- 自建动作名称与别名可搜索。
- 单侧判定使用原始英文名，自建动作不参与。

## 03 · 已有别名

实现：

- [Profile](../../mobile-rn/src/training.ts)新增可选 `exAliases`；[CustomExercise](../../mobile-rn/src/training.ts)新增可选 `aliases`、`tg`、`cat`。
- RN 适配层使用 Web 的 `normalizeAliases` 语义：`Profile.exAliases` 覆盖自建动作自身 `aliases`，缺字段、空数组和非法值降级为空。
- 别名进入正常计数、排序和分页，并与筛选池共用同一来源。
- 同步路径核对：[server.ts](../../mobile-rn/src/server.ts)读取 `/api/data` 后以整个 profile 为基础合并，`exAliases` 和自建 `aliases` 原样透传；本地工作区同样保存完整 profile，不需要数据迁移。

自动化证据：[library-search-rn.test.ts](../../frontend/src/lib/library-search-rn.test.ts)覆盖内置别名、自建别名和清除后结果消失。账号 A/B 的真实同步与工作区切换仍待设备或配对环境验证。

## 04 · 组合筛选

实现：

- 目录 `tg` 生成目标肌群选项；选项值保持原始 slug，显示名来自 [catalogueData.js](../../mobile-rn/src/catalogueData.js) 的中文词表。
- 筛选面板新增「目标肌群」和「仅单侧」；主筛选栏显示已选条件和清除入口，筛选计数包含两项。
- 部位、器械、目标肌群、仅收藏和单侧统一取交集，再执行共享搜索和分页。
- 单侧判定复用 [isOneLimbExercise](../../frontend/src/lib/exercise-search.js)，内置动作读取原始英文名，自建动作和未知动作不通过该筛选。
- 自建动作有 `tg` 时可按目标肌群命中；缺 `tg` 时开启目标肌群筛选不纳入。

自动化证据：

- `bodyPart=back`、`equipment=cable`、`targetMuscle=lats`、`oneLimb=true`、`favouritesOnly=true` 的结果包含 `1204`。
- 筛选无结果时保留条件；建议候选只来自当前筛选池。
- Web 分侧默认判断回归通过。

## 05 · Fuse.js 候选

实现：

- `npm.cmd --prefix .\mobile-rn install fuse.js --save-exact` 固定 `7.5.0`。
- 仅在查询至少 4 个汉字、当前筛选池非空、共享搜索完整结果为零时触发。
- 索引只含中文名称、已保存别名和动作对象；按筛选条件缓存，输入变化不重建索引。
- 候选取 `ignoreLocation: true`、阈值 `0.4`，按动作 ID 去重并截取 3 条。
- 复用现有动作行、详情和选择回调；查询清空、出现正常结果、筛选或工作区变化后不保留旧候选。

自动化证据：

- `高位下啦` 的正常结果为 0，候选为「高位下拉」动作家族，最多 3 条。
- 增加 `equipment=cable` 后，候选全部属于当前池，且都是「高位下拉」家族。
- 空查询、「卧堆」和可正常命中的「高位下拉」不展示候选。
- [library-search-rn.test.ts](../../frontend/src/lib/library-search-rn.test.ts)用注入的候选索引验证触发条件、筛选池、去重和 3 条上限，避免前端 CI 依赖 RN 的 `node_modules`。
- 真实 Fuse 索引用 `node --no-warnings mobile-rn/scripts/fuse-suggestion-check.mjs` 校准。当前输出：全量池前三为 `0007`、`3326`、`4144`；`equipment=cable` 池前三为 `0007`、`0150`、`1047`，全部属于「高位下拉」家族；`卧堆` 为空。

## 构建与检查

```powershell
npm.cmd --prefix .\mobile-rn run check
npm.cmd exec expo export -- --platform android --output-dir .expo-search-check
```

结果：

- ESLint 0 error（仅既有的 `PlanScreen`、`StatsScreen` 索引 key 警告）。
- 自定义 lint 规则、TypeScript、设计系统检查通过。
- Metro Android 导出成功，生成 Hermes bundle；导出目录已在检查后删除。
- 全量 `npm.cmd --prefix .\frontend test` 在当前 Windows 工作区另有 27 项与检索无关的失败（路径分隔符、缺失构建产物、图标和 CSP）；本文件列出的指定回归套件全部通过。

## 待设备验证

| 条目 | 原因 |
| --- | --- |
| 01-B、01-C、05-E 计划添加与取消 | 从计划编辑真实入口添加同一动作并确认只新增一项；选择器返回取消不提交；替换取消保持原槽位 |
| 01-D、02-D 收藏与分页 | 验证仅收藏、取消收藏、加载更多和改词重置 |
| 02-E 计划入口 | 动作库、训练添加、训练替换已通过；计划编辑入口待补 |
| 03-A、03-B、03-C | 需要配对测试账号 A/B 或带 `exAliases` 的 fixture 验证 Web 保存、RN 同步、切换隔离和坏值降级 |
| 04-B、04-C、04-D | 逐项清除、冲突解除和缺 `tg` 旧自建动作待补 |
| 04-E 详情返回 | 打开筛选结果详情再返回，确认筛选和查询仍保留 |
| 05-D 工作区切换 | 快速切换查询和工作区后的候选残留待补 |
| 05-F 断网耗时 | 断网搜索、首次/重复候选耗时和设备信息待补 |

设备可用后按 [01 项](01_ENTRY_BASELINE.md)准备数据，再按 [05 项](05_FUSE_SUGGESTIONS.md)的脚本顺序补证据，并把结果追加到 [BASELINE.md](BASELINE.md#设备验收记录)。
