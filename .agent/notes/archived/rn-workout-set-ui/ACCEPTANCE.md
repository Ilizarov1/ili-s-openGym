# RN 训练组行与递减组验收记录

验收日期 2026-11-20。设计见 [DESIGN.md](DESIGN.md)，执行步骤见 [EXECUTION.md](EXECUTION.md)。本轮采用设计 §4 的暂定规则作为确认版本：整组完成后只允许改重量、次数和评分；展开后取消最后一段勾选回到进行中；撤销只清除本组所属休息。

## 1. 环境与基线

| 项 | 实际值 |
|---|---|
| 源码基线 | `42411be33` 之上的工作区改动；`git rev-parse --short HEAD` 仍为 `42411be33` |
| 设备 | `emulator-5556`，Android 36（API 36），x86_64 |
| 默认窗口 | 1080 × 2400，420 dpi |
| 窄屏窗口 | 640 × 1385，320 dpi（320 dp 宽），系统字体 1.0 / 1.3 |
| 客户端 | Debug APK（fixture 依赖 `run-as`），Metro 端口 8081 |
| 测试账户 | 本机练习；V10 另起隔离 `loopback-api.mjs` 实例 |
| 工具 | PowerShell 7、`adb`、`uiautomator` 窗口 dumper、Node `node:sqlite` |

工作区在验收期间还包含独立的动作检索改动（`librarySearch.ts`、`fuse.js` 等）。本次验收只覆盖训练组行与递减组，未对动作检索做结论。

## 2. 静态检查

```powershell
Set-Location D:\dev\open-gym\mobile-rn
npm.cmd run check
```

结果：`lint`、`lint:rules`、`typecheck`、`design:check` 全部退出 0。仅保留仓库原有的 2 条 `react/no-array-index-key` warning（`PlanScreen.tsx:205`、`StatsScreen.tsx:276`）。

## 3. 自动化验收

```powershell
Set-Location D:\dev\open-gym\mobile-rn
.\scripts\workout-set-ui-acceptance.ps1 -Serial emulator-5556 -Case All -SkipInstall
```

脚本写入 `mobile-rn/dist/workout-set-ui/acceptance/`：每个用例的 PNG、UI XML、`results.json` 和 V10 的本地/API 证据。`-Case All` 在一次连续运行中 11 项全部 PASS。

| ID | 结果 | 主要断言与证据 |
|---|---|---|
| V01 | PASS | 320 dp 卡片/列表/紧凑布局无重叠；重量和次数为 44 dp 以上行内输入；小数/整数键盘；空值失焦回退；字体 1.3 无重叠；有氧显示“速度/分钟”，计时显示“秒”。证据 `v01-320-cards.png`、`v01-*-320.png`、`v01-font-1.3.png`、`v01-modes-cardio.png`、`v01-modes-time.png` |
| V02 | PASS | RPE 8 保存、7.5 修改、清除；热身评分位禁用；混合尺度表头“评分”且行内保留 RPE/RIR；关闭评分且无已存评分时省略整列。证据 `v02-rating-8.png`、`v02-warmup-slot.png`、`v02-mixed-scale.png`、`v02-effort-none.png` |
| V03 | PASS | 搜索替换只在动作菜单；记录一组后动作菜单锁定且无搜索；组尾菜单无替换；递减组主段勾选后同样锁定。证据 `v03-locked-menu.png`、`v03-set-menu.png`、`v03-partial-lock.png` |
| V04 | PASS | 正式↔热身转换；完成状态保留；复制正式/热身/部分递减组；完成组隐藏删除；运行中的休息条在转换和复制后仍指向原组。证据 `v04-warmup.png`、`v04-copy-rest.png`、`v04-completed-conversion.png`、`v04-copy-dropset.png` |
| V05 | PASS | 递减组底部面板初始一段、非法值留面板报错、取消无副作用、保存后自动展开 `0/2` 且无新休息、编辑段同步。证据 `v05-sheet.png`、`v05-error.png`、`v05-saved.png`、`v05-edited.png` |
| V06 | PASS | `2/3` 快速加段到 `2/4` 且原勾选保留；删除未勾段保持进度；删除已勾段需确认；删除最后一个待完成段被拒绝；`改为普通组` 保留主段完成和数值且不启动休息。证据 `v06-added.png`、`v06-deleted.png`、`v06-reverted.png` |
| V07 | PASS | 只能按显示顺序勾选；主段/中间段不启动休息；专注布局显示 `2/3` 并完成最后一段；整组只产生一次休息；完成后主行补填 RPE 8；取消最后一段回到 `2/3` 并清除本组休息，再勾选重新开始。证据 `v07-2of3.png`、`v07-focus-2of3.png`、`v07-focus-complete-rest.png`、`v07-complete.png`、`v07-rated.png`、`v07-recomplete.png` |
| V08 | PASS | 超级组第一成员递减组完成后只轮转到第二成员、不休息；第二成员完成后才按轮次休息。证据 `v08-mid-drop.png`、`v08-member-two.png`、`v08-round-rest.png` |
| V09 | PASS | 旧未完成草稿 `0/3`，勾主段后重启仍 `1/3`；旧已完成草稿 `3/3`，取消最后一段回到 `2/3` 且重启保留；完成组菜单只保留复制；另一组休息时撤销本组不清除其他组休息。证据 `v09-old-incomplete.png`、`v09-old-complete.png`、`v09-completed-menu.png`、`v09-legacy-undo.png`、`v09-rest-isolation.png` |
| V10 | PASS | 部分勾选的递减组在结束确认中明确说明且不计完成；完成组训练量 1180 kg；历史一条 `type: dropset` 记录、两段、无 `mainAt`/分段 `at`；隔离 API 回读同一记录且无重复。证据 `v10-partial-confirm.png`、`v10-summary.png`（总量 1,660 kg = 480 + 1180）、`v10-api-synced.png`、`v10-state.db` |
| V11 | PASS | 无新建/转换休息暂停入口；既有休息暂停摘要按需展开；整组勾选完成并进入休息；历史保留 `type: restpause` 和四段 `r/restSec`，未写入草稿键。证据 `v11-restpause.png`、`v11-restpause-expanded.png`、`v11-state.db` |

V10 本地历史断言的实际记录（节选）：

```json
{"w":60,"r":7,"done":true,"type":"dropset","drops":[{"w":50,"r":8},{"w":40,"r":9}]}
```

同一条记录在隔离 API 的 `state.workouts` 中只出现一次，`drops` 仍为 `50×8 → 40×9`。

## 4. 交付包

```powershell
Set-Location D:\dev\open-gym\mobile-rn\android
$env:NODE_ENV = 'production'
.\gradlew.bat :app:assembleRelease
```

| 项 | 实际值 |
|---|---|
| 候选包 | `mobile-rn/android/app/build/outputs/apk/release/app-release.apk` |
| 版本 | `0.1.6`（versionCode 7），minSdk 24，targetSdk 36 |
| 大小 | 270,196,335 bytes |
| SHA-256 | `D72C19821576BC53C992335BBD9AB2B897D9F7F45829C54793ED88EA897EB0CB` |
| 签名 | `apksigner verify` 通过；APK Signature Scheme v2；证书 `CN=Android Debug`，证书 SHA-256 `FAC61745DC0903786FB9EDE62A962B399F7348F0BB6F899B8332667591033B9C` |
| 启动核对 | Release 安装后清空数据并启动，首页正常渲染；`release-launch.png` |

构建使用 Expo 模板的默认 release 签名配置（指向调试 keystore）。这满足本轮内部候选包验签和安装，但生产分发前必须配置独立 release keystore。Debug APK 只用于 fixture 验收，不作为交付包。

## 5. 已知限制

- 320 dp 下 `Header` 的 `compact` 标题仍为单行，长计划名会截断；训练卡片本身和所有交互列无重叠。此行为沿用现有 Header 组件，不在本轮改动内。
- “重复投递同一条最后一段完成命令”的幂等性由数据层 `toggleDraftSegment(expectedDone)` 实现并由实现阶段的模型 harness 覆盖；设备验收覆盖了顺序勾选、重复界面操作和撤销。用户在看到勾选状态更新后再次点按属于明确撤销，不是重复命令。
- 保存失败注入未在设备上执行；`onChange` 返回 false 时面板和完成计数保持、UI 推进在保存成功后执行的代码路径已核对，建议后续专项复验时补一次断点或只读存储注入。
- 验收使用专用 Debug 模拟器和 fixture；Release 候选包只做签名、版本和启动核对，不重复 fixture 流程。
