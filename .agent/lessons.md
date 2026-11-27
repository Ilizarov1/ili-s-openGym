# 查错与高耗时复盘账本（`lessons.md`）

每次用户要求查错（Bug 排查、构建失败、测试标红、设备联调异常），或执行过程中出现**明显返工 / 耗时偏长**的步骤时，必须在收尾前登记或累加本账本。

## 1. 登记与升格规则

1. **查重累加**：先检索下方追踪表是否已有同类问题。若命中，将该行的 `次数` **+1**，并在 `最近记录` 追加日期与简短现场；若未命中，分配新编号 `L-XXX` 新增一行（初始 `次数` 为 `1`，`状态` 为 `tracking`）。
2. **必填三要素**：每条记录必须写清 **规则（怎么做）** + **原因（为什么错或为什么慢）** + **次数（累计发生几次）**。
3. **满 3 次脱水升格**：当任意 `tracking` 条目的 `次数 >= 3` 时，**立即**将其规则剥离背景故事，脱水压缩为 **1~2 句祈使句**，写入 [`docs/code-standards.md`](../docs/code-standards.md) 对应子系统章节（保留 `[L-XXX]` 标记），随后将本表中的 `状态` 更新为 `promoted`。
4. **门禁检查**：运行 `.\.agent\scripts\verify-governance.ps1` 会自动扫描是否存在 `次数 >= 3` 但仍处于 `tracking` 未升格的条目。

## 2. 复盘记录表

| ID | 子系统 | 规则 | 原因 | 次数 | 状态 | 最近记录 |
|---|---|---|---|---:|---|---|
| `L-001` | `mobile-rn` | RN Android 原生构建一律在 `D:\wt\<短名>` 短路径 worktree 下执行，不使用默认深层 worktree 或 `subst` 虚拟盘。 | Windows 版 CMake/Ninja 编译 `expo-modules-core` 等新架构 C++ 模块受 250 字符对象路径限制；`subst` 混用真实路径会导致 codegen 头文件丢失。 | 3 | `promoted` | 2026-11-24 已脱水升格至 `docs/code-standards.md` |
| `L-002` | `mobile-rn` | RN 页面样式一律使用 `src/design` 语义 Token 与基础原语组件，不在页面内写裸色值或裸尺寸。 | 页面手写色值与字号会导致暗色/浅色主题失配并在 `npm.cmd run design:check` 门禁阶段返工。 | 3 | `promoted` | 2026-11-24 已脱水升格至 `docs/code-standards.md` |
| `L-003` | `mobile-rn` | UI 布局与弹窗/键盘交互先用 Debug + Metro 热更新调通，最后只跑一次双架构 `assembleRelease`。 | 每次微小布局调整直接重编全量 Release APK 会耗费数分钟 Gradle 原生构建与打包时间。 | 3 | `promoted` | 2026-11-24 已脱水升格至 `docs/code-standards.md` |
| `L-004` | `mobile-rn` | 模拟器 `uiautomator dump` 超时拿不到控件树时，通过深链附加 `e2e=1` 冻结训练计时器与休息倒计时后再采样。 | 训练页实时跳秒和休息倒计时动画持续刷新 UI 帧，导致 Android Accessibility 空闲等待超时卡住验收脚本。 | 1 | `tracking` | 2026-11-24 基线建档 |
| `L-005` | `ai-agent` | 迁移或重命名评测文档目录时，同步核查 `frontend/scripts/ai-search-eval*.mjs` 及测试中的 `manifest.json` 相对路径常量。 | `ai-search-eval.test.mjs` 硬编码了仓库内真实评测清单路径，仅挪文档目录会导致离线回放测试直接报文件缺失。 | 1 | `tracking` | 2026-11-24 迁移 `.agent/notes` 时命中预防 |
| `L-006` | `infra-ops` | 仓库 PowerShell 脚本须兼容 Windows PowerShell 5.1（显式传 `-Encoding UTF8`，避免使用 `[IO.Path]::GetRelativePath` 与 `??` 空合并运算符，且勿直接用 `Start-Process -PassThru` 的 `.ExitCode`）。 | Windows 默认 `powershell.exe` 运行在 .NET Framework 4.x / PS 5.1 上，除 PS7 API 外，`Start-Process -PassThru` 未读取 `.Handle` 时 `.ExitCode` 恒为 `$null`，导致 `Start-Retrieval.ps1:53` 冷启动 PG 误报失败（需改用 `pwsh` 或原生进程等待）。 | 2 | `tracking` | 2026-11-24 `Start-Retrieval.ps1:53` 在 PS 5.1 下 `$pgStartup.ExitCode` 为 `$null` 触发误抛（`pwsh` 正常） |
| `L-007` | `ai-agent` | PostgreSQL 批量 `UNNEST` 查询必须用 `EXPLAIN (ANALYZE, BUFFERS)` 实测执行计划，严禁在单次 `JOIN` 条件中将数组表列直接混入多路 `OR`（`=/%/@@`）谓词。 | 将 `UNNEST` 结果表直接 `JOIN ... ON (... OR ...)` 会导致 PG 优化器放弃 B-Tree/GIN 索引回落为 `Seq Scan`（`153ms`）；拆成 `CROSS JOIN LATERAL (... UNION ...)` 才真正命中全部索引（`43ms`）。 | 1 | `tracking` | 2026-11-24 `p50-latency-v2` `textRecall` `EXPLAIN ANALYZE` 实测调优 |
| `L-008` | `web-client` | 构造或校验 openGym 训练日志数据时，已完成组必须写 `done: true`（热身写 `phase: 'warmup'`），严禁误写 `ok: true` / `warm: true`；协议层 `cleanChangeValue` 须保留 `string[]` 以放行 `reorder` 提案。 | `workout-model.js` 的 `hasCompletedWork` 严格读取 `set.done === true`，错误字段会导致趋势图与肌群负荷全部水合为空；`cleanChangeValue` 丢弃数组会导致合法 `reorder` 提案被 `validateReview` 误拒。 | 1 | `tracking` | 2026-11-26 `coach-genui-v2` 真实界面联调定位并修复 |
| `L-009` | `ai-agent` | 向要求结构化 NDJSON 输出的大模型传入多轮 `assistant` 历史时，每条历史回复必须同样序列化为合法 NDJSON，严禁拼接 `[Shown trend: ...]` / `[Proposal: ...]` 等方括号伪文本摘要。 | 上下文学习（in-context learning）会使模型直接模仿历史 `AIMessage` 的格式，将本应以 JSON 节点输出的卡片退化为纯文本方括号占位符导致前端不渲染。 | 1 | `tracking` | 2026-11-26 `coach-genui-v2` 多轮对话真实 DeepSeek 联调定位并修复 |
| `L-010` | `api-sync` | 凡为同步状态引入“清空/删除”语义（如 `chatClearedAt`），必须一次性打通 5 条路径：`update` 写入、`mergeStates` 双向合并、`stampPut`（含 `stamped: true`）服务端单调防回滚、`useStore` 全入口（`adopt`/`loadState`/`persist`/`syncFromSaved`）守卫，以及异步流式回调的代次隔离。 | 仅修补 `mergeCoach` 单一入口会导致旧标签页或服务端直接采纳路径短暂回流历史数据，表现为“清完再发消息时流式期间闪现旧记录、输出完后才消失”，造成连续返工。 | 2 | `tracking` | 2026-11-27 `coach-genui-v2`「新对话」清空历史连续两次返工定位并全链路加固 |
| `L-011` | `ai-agent` | 涉及真实大模型 + 有状态同步的交互功能，严禁仅靠单测 Mock 或单轮 Happy Path 放行；交付前必须在真实浏览器 + 真实模型下跑完「多意图矩阵 + 至少 3 轮连续对话 + 清空/修改后等待同步并 `F5` 刷新 + 双标签页并发中间态采样」。 | Mock 无法暴露真实 LLM 多轮格式漂移、工具误调、字段习惯，单轮验收也测不出 Turn 2+ 退化与跨标签页同步闪现，把本应在开发自检期拦截的缺陷全部漏给了用户。 | 1 | `tracking` | 2026-11-27 `coach-genui-v2` 复盘建档 |
| `L-012` | `mobile-rn` | 跨端共享的 GenUI 节点若在 Web 侧经过 `t()` 翻译，RN 端必须为同一批展示名提供本地映射（如 18 个肌群名与 slug）；瞬时状态（`TOOL_CALL_START`→`TOOL_CALL_RESULT` 同毫秒返回）必须保留一个可见的“已完成”态，不能依赖单帧渲染。 | RN 无 i18n 运行时导致肌群名以英文泄漏；本地词库检索在同一 tick 返回使工具状态行从未绘制，单测与静态门禁均无法发现，只有在真实模拟器逐帧截图/录屏时才暴露，造成验收返工。 | 1 | `tracking` | 2026-11-27 `rn-coach-genui` Phase 4 模拟器验收发现并修复 |
