# RN 动作检索执行基线

记录日期 2026-11-20。源码基线为 `42411be33` 加本次改动前的工作区。设备证据缺失：当前 Windows 环境没有 `adb`、`ANDROID_HOME` 或 `ANDROID_SDK_ROOT`，无法执行 [01 项](01_ENTRY_BASELINE.md)要求的模拟器安装、点选和截图。本文件保留代码级入口基线，供之后补设备证据时对照。

## 入口与回调

| 入口 | 打开方式 | 选择回调 | 原有搜索与分页 |
| --- | --- | --- | --- |
| 动作库 Tab | `App.tsx` 直接渲染 `ExerciseLibraryScreen` | `startWithExercise`：有草稿时打开训练，否则新建只含该动作的训练 | 英文名 + 中文名子串匹配；部位、器械、仅收藏取交集；收藏置顶；每页 100 |
| 计划编辑 | `PlanEditorScreen` 的 `picking` 分支 | `addExercise` 后关闭选择器 | 同上 |
| 训练添加 | `WorkoutScreen` 的「添加动作」→ `App.tsx` 打开 `panel.kind='library'` | `pickForWorkout(target, undefined)` 后关闭面板 | 同上 |
| 训练替换 | 训练动作行菜单「搜索替换动作」→ `panel.replaceIndex` | `pickForWorkout(target, replaceIndex)` 后关闭面板；只改目标槽位 | 同上 |

取消路径：动作库 Tab 的详情返回不清空列表；计划编辑和训练面板的返回/关闭不提交选择；训练替换取消时原槽位不变。

## 搜索与筛选基线

| 项目 | 基线行为 |
| --- | --- |
| 查询 | `query.trim().toLowerCase()` 后对英文 `n` 和中文显示名做 `includes` |
| 部位 | `exercise.bp === bodyPart`，自定义动作同样按 `bp` |
| 器械 | `exercise.eq === equipment` |
| 仅收藏 | `Profile.favEx`，收藏项在分页前置顶 |
| 空查询 | 自定义动作在前，目录动作在后，收藏组再置顶 |
| 计数 | 独立遍历完整候选集，不受当前 `limit` 影响 |
| 加载更多 | 每次增加 100；查询、筛选或工作区变化时重置 |
| 详情 | 目录动作走 `catalogueExercise`，自定义动作走 `profile.customEx` |
| 自定义动作 | 名称、部位、器械可搜索；编辑后重新进入列表 |

## 回归数据

- 内置动作：`1204`（`cable one arm lat pulldown`，中文「绳索单臂高位下拉」，`bp=back`、`eq=cable`、`tg=lats`）。
- 自建动作：名称唯一、带 `bp`/`eq`，并额外保存 `aliases` 与 `tg` 覆盖旧资料和别名场景。
- 训练草稿：第一项未记组，用于替换索引 `0`。
- 分页查询：选择能超过 100 条的中英文查询，记录首屏 ID、总数和加载更多后的 ID。

设备补齐时把每条入口的实际查询、筛选、回调、结果数量和截图路径追加到下节。

## 设备验收记录

2026-11-20 在 `openGymRnQa` / `emulator-5554`（Android 16）用 `agent-device` 和测试 IME 执行。

| 编号 | 状态 | 证据 |
| --- | --- | --- |
| 01-A | 通过 | 动作库同时显示内置动作和自建「自定义划船」；选择「绳索单臂高位下拉」进入训练 |
| 01-B | 训练通过，计划待补 | 训练动作数从 3 增至 4，4/4 为「绳索单臂高位下拉」；计划编辑添加未执行 |
| 01-C | 通过 | 索引 `0` 的「杠铃卧推」替换为「绳索单臂高位下拉」，总数仍为 4 |
| 01-D | 部分通过 | 部位、器械、目标肌群、单侧和清除查询已验证；收藏、加载更多待补 |

截图：`mobile-rn/dist/ui/search-cn.png`、`search-filters.png`、`search-replace.png`。自动化替代证据见 [执行验收记录](ACCEPTANCE.md)。
