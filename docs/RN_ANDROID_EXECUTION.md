# RN Android 实施与验收

1. 初始化 `mobile-rn/` 的 Expo TypeScript 工程和 Android 配置。使用独立包名，提交依赖锁文件。
2. 接通本地训练、历史和 SQLite，再实现手动配对与同步。用上游接口约定核对训练字段和冲突重试。
3. 运行类型检查和 Android JS 打包，生成安装包，校验签名和内置的 JS bundle。有设备或模拟器时，安装后验证本地持久化和配对同步。

## Windows 构建

本次使用 Expo SDK 55、JDK 17 和 Android SDK 36，APK 包含 ARM64 与 x86_64。本机工具链位于 `%LOCALAPPDATA%\OpenGymRnToolchain`。配置 `JAVA_HOME` 和 `ANDROID_HOME` 后，在 `mobile-rn/` 执行：

```powershell
npm.cmd ci
npm.cmd run check
npx.cmd expo prebuild --platform android --no-install
Set-Location android
.\gradlew.bat :app:assembleRelease
```

Gradle 输出位于 `mobile-rn/android/app/build/outputs/apk/release/app-release.apk`。本次交付复制到 `mobile-rn/dist/openGym-RN-0.1.0.apk`，采用开发签名，供侧载体验。

## 验证结果

- 类型检查、Gradle Release 构建、APK 签名及内置 JS 检查通过。
- Android 36 模拟器已验证断网训练、重启恢复和历史。配对本地 openGym 实例后，断开连接记录的训练可以在恢复连接后上传。
- 使用独立的上游 API 实例验证 `409` 重试、重复上传去重和保留网页端修改。

## 本轮开发

| 项目 | 实现和验收 |
| --- | --- |
| 组间休息 | 记组后还有未完成组时，把结束时间存进训练草稿。动作设置优先，其次是账号设置，默认 90 秒。验收自动开始、取消、回前台和重开恢复。 |
| 上次重量 | 开始训练时，从历史和待同步记录中取同一动作最近一次可比较的正式组重量。可手动修改，无可用记录时沿用计划重量。 |
| 核心回归 | 将断网记组、重开恢复和联网补传固化为 PowerShell + ADB 脚本，使用可见模拟器和独立本地 API。 |

在仓库根目录用 PowerShell 7 执行。先安装 `api/` 的依赖，配置 JDK 17、Android SDK 36 和 Build Tools 36.0.0，启动专用 Android 模拟器并保持窗口可见。用 `adb devices` 查序列号。`-ResetAppData` 会清空该模拟器里的 RN App 数据。

```powershell
.\mobile-rn\scripts\android-regression.ps1 -Apk .\mobile-rn\dist\openGym-RN-0.1.2.apk -Serial emulator-5556 -ResetAppData -FeatureChecks
```

### 0.1.1 验收结果

2026-11-15，使用 Android 36 可见模拟器和独立本地 API 验收 `mobile-rn/dist/openGym-RN-0.1.1.apk`。类型检查、APK 签名及内置 JS 校验通过。

- **倒计时**。验证默认 90 秒和动作级配置覆盖账号设置。切到后台再回来仍按实际时间递减，强制停止重开后可以继续，取消休息后已记的组保留。
- **重量预填**。手动记录 `37.5 kg × 8`，结束训练后下次进入时预填 `37.5 kg`。逻辑检查覆盖无历史时用计划重量、排除热身组、保留零重量、待同步记录单位换算和避免重复记录影响取值。
- **核心回归**。断开模拟器到本地 API 的连接后，记录显示待同步，服务端是零条。恢复连接后服务端收到一条 `25 kg × 8`，再次同步仍为同一条。真机验收待完成。

## P0 收尾

- **设计**。备选动作只替换训练草稿中的力量动作，保留组数、次数、休息和热身配置。重量按备选动作自己的历史预填。已经记组的动作保留原记录。
- **验收**。2026-11-17，类型检查、Gradle Release 构建、APK 验签和内置 JS 检查通过。可见 Android 36 模拟器和独立 API 通过 `-FeatureChecks`，覆盖倒计时、上次重量、增删组、热身组和离线补传。备选动作能切换和换回，保留目标组数和次数，历史与同步使用实际动作 ID，原计划保持原样。真机验收待完成。
- **安装包**。`mobile-rn/dist/openGym-RN-0.1.2.apk` 由 `50ab7f24e` 上的 RN 工作区构建。SHA-256 为 `8B431BCB5AAA65202FD2BDDF2C7EB577E20BE738617C6D16D1064A3700A53362`。

## P1 执行计划

1. **数据写入**。在 SQLite 保存待同步变更。重连时基于最新服务器状态逐项应用，沿用 `baseRev`、`baseWid` 和冲突重试。验收网页端对其他记录的修改能保留，删除的记录不会因重试复活。
2. **训练和管理**。复用训练编辑界面处理历史纠错、补录和自由训练。计划、周排程、轮换和自定义动作使用上游的数据格式和排程规则。验收双向可读、动作历史和有氧计时数据。
3. **备份和提醒**。通过 Android 文件选择和分享处理 JSON 备份。恢复按 ID 合并，可将本机练习导入当前服务器账号。通过本地通知提醒组间休息结束，取消或完成训练时清除尚未触发的通知。
4. **候选包验收**。构建 Release，验签并在可见 Android 模拟器回归 P0 与 P1。真机锁屏和震动按设备可用情况单独记录。

### P1 回归命令

```powershell
.\mobile-rn\scripts\android-regression.ps1 -Apk .\mobile-rn\dist\openGym-RN-0.1.3.apk -Serial emulator-5556 -ResetAppData -FeatureChecks -P1Checks
```

`-P1Checks` 使用临时账号和本地 API。组间提醒测试在专用模拟器授予精确闹钟权限，并检查熄屏时系统发布了到点通知。

### P1 验收结果

Android 36 可见模拟器使用 `0.1.3` 联跑 `-FeatureChecks -P1Checks`，P0 和 P1 全部通过。

- **历史与同步**。验证单动作历史、日期和组数值纠错、离线删除以及指定过去日期补录。真实本地 API 回读保留网页端同时修改的计划，定向检查覆盖 `409` 后重新应用变更。
- **计划与训练**。验证计划增删改、周排程、轮换、今日计划、搜索与自定义动作、自由训练和任意动作替换。计时组负重及有氧组速度保存在历史和服务器。
- **通知与备份**。系统在模拟器熄屏时发布休息通知。已验证合并本机练习、Android JSON 文件导入、单位转换、重复导入去重及导出的系统分享面板。真机锁屏显示与震动待验证。
- **安装包**。`mobile-rn/dist/openGym-RN-0.1.3.apk` 由 `50ab7f24e` 上的 RN 工作区构建，包含 ARM64 和 x86_64，类型检查、Release 构建、签名和内置 JS 校验通过。SHA-256 为 `0D9E9075E45995EF0E5267217F00E0892D72C4DEB3EA68D205C7B4990CBA332D`。

## P2 第一项 · 超级组

1. 在计划表单和未记组的训练中接入相邻动作组合与拆分。连接账号后验证计划保存、动作替换及旧计划读取。
2. 在 Android 专用模拟器用两动作不同组数跑一场训练。检查轮内切换、轮末计时、最后动作完成后的计时和重启恢复。
3. 对照历史和独立 API 验证组标识及动作先后，再回归 P0、P1 的普通训练流程。构建并验签 APK 后更新迁移清单。

### 0.1.4 验收结果

- **超级组**。在可见 Android 36 模拟器验证计划编辑、训练中拆分重组、`A1 → B1 → A2`、轮内无休息、`73` 秒轮末休息和结束时停表。重开后从 B1 继续，历史和独立 API 确认保留组名、动作顺序和组数。定向检查还覆盖热身顺序、默认取最长休息、替换动作保留组关系。
- **回归**。Android `0.1.4` 使用 `-FeatureChecks -P1Checks -SupersetChecks` 联跑，P0、P1 和超级组均通过。
- **安装包**。`mobile-rn/dist/openGym-RN-0.1.4.apk` 通过类型检查、Release 构建、签名和内置 JS 校验。SHA-256 为 `804CDDEA85A0E9FEF83850CDC3C2837A482BC2A0AB78FC3EE09F213CC55AD681`。

### 0.1.5 验收结果（P2 进度、身体数据、导入分享与提醒）

- **静态检查**：`cd mobile-rn && npm.cmd run check` 通过 ESLint、规则回归、TypeScript 和设计图标检查。
- **五 Tab 冒烟**：`five-tab-smoke.ps1 -Serial emulator-5556` 在 Debug 和 Release `0.1.5` 均通过；脚本的底部 Tab 点击改为优先点击可交互父节点并重复一次，避免关闭全屏 Modal 后的首次点击被吞。
- **进度**：`emulator-5556` 用 fixture 验证 PR 最佳纪录 `100 kg × 6`、来源训练、Epley 1RM `120 kg`、周趋势（含空周补零和 5,140/7,660 kg 训练量）以及肌群前后视图和有效组明细。
- **身体数据**：验证体重新增 `79.8 kg` 后日值/周均重算；围度两日历史、腰围曲线和部位切换；照片从系统选择器选图、重编码、保存到当天最新训练的 `media`、缩略图和全屏查看。
- **导入分享与提醒**：验证设置页入口、计划导出到系统分享面板（`opengym-plan-2026-11-18-*.json`）、相机权限与取景页、提醒的权限/时刻/预览和 3 条 `RTC_WAKEUP` 调度；Release 包同时验证了进度、身体、提醒、历史导入、计划分享和扫码深链。
- **待复验**：独立 API 同步和 `409`、二维码实际兑换、真实导入文件、提醒锁屏到达与点击、真机相机/媒体解码。
- **安装包**：`mobile-rn/dist/openGym-RN-0.1.5-five-tab.apk`，versionCode 6，包含 arm64-v8a 和 x86_64，约 258 MB，Debug 证书签名；SHA-256 为 `3E62E167917920E9893DA7A6AB92C27C99B827EA970F5803E8DF87570F38FFA1`。