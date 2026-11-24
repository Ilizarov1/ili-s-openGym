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
