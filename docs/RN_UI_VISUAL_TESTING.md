# RN 视觉测试与设计系统约束

本文规定 RN 界面变更的视觉验收流程。设计系统本身见 [RN_UI_DESIGN_SYSTEM.md](RN_UI_DESIGN_SYSTEM.md)，页面重构见 [RN_UI_SCREEN_MIGRATION.md](RN_UI_SCREEN_MIGRATION.md)。

## 1. 硬性约束

任何 UI 变更或功能增改必须：

1. 先读 `docs/RN_UI_DESIGN_SYSTEM.md` 和 `docs/RN_UI_SCREEN_MIGRATION.md`。
2. 使用 `mobile-rn/src/design` 的 token 和组件，不在页面里写十六进制颜色、字号、圆角或间距。
3. 优先复用 `Button`、`Card`、`ListRow`、`Header`、`Screen`、`Segmented`、`Chip`、`Sheet`、`TextField`、`Stepper`、`ActionSheet` 等现有组件；新增模式先加入 Gallery。
4. 不恢复旧 `src/ui.tsx`，不新建平行的第二套 UI 工具层。
5. 改完运行：
   ```powershell
   cd mobile-rn
   npm.cmd run check
   ```
6. 涉及布局、颜色、字号、图标或页面结构时，补一次视觉截图验收；功能逻辑改动再补对应 smoke/regression。

## 2. 快速视觉验收

推荐顺序：**深链直达 + fixture 数据 + 一次截图 + 拼图查看**，不要逐个页面手动截图。

### 2.1 准备 Debug APK

fixture 使用 `run-as` 写入 Debug 应用的 SQLite，因此需要 Debug APK：

```powershell
$env:JAVA_HOME = 'C:\Users\zjzjn\AppData\Local\OpenGymRnToolchain\jdk-17.0.21+9'
$env:ANDROID_HOME = 'C:\Users\zjzjn\AppData\Local\OpenGymRnToolchain\android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:GRADLE_USER_HOME = 'C:\Users\zjzjn\AppData\Local\OpenGymRnToolchain\gradle'

cd mobile-rn
npx.cmd expo prebuild --platform android --no-install
cd android
.\gradlew.bat :app:assembleDebug
```

安装 Debug APK，并启动 Metro：

```powershell
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
adb reverse tcp:8081 tcp:8081
npx.cmd expo start
```

### 2.2 一次生成所有截图

```powershell
.\mobile-rn\scripts\ui-capture.ps1 -Serial emulator-5556 -Fixture
```

脚本会：

- 生成三套计划、三条历史和一个自定义动作，并写入 Debug 应用数据库。
- 通过深链依次打开首页、设置、计划、计划编辑、统计、动作库、筛选、开始 Sheet、训练、休息 dock。
- 使用 `adb exec-out screencap` 直接保存截图。
- 生成 3 张 contact sheet：
  - `mobile-rn/dist/ui/contact-sheet-1.png`
  - `mobile-rn/dist/ui/contact-sheet-2.png`
  - `mobile-rn/dist/ui/contact-sheet-3.png`

平时只看 contact sheet；只有发现异常时才打开对应的单张图。

常用参数：

```powershell
# 清空应用数据后截空状态
.\mobile-rn\scripts\ui-capture.ps1 -ResetAppData

# 只截图，不生成拼图
.\mobile-rn\scripts\ui-capture.ps1 -Fixture -NoContactSheet
```

`-Fixture` 与 `-ResetAppData` 同时出现时以 `-Fixture` 为准。

### 2.3 Fixture 数据

生成/安装 fixture：

```powershell
.\mobile-rn\scripts\ui-fixture.ps1 -Serial emulator-5556
```

fixture 内容：

- 三套计划：胸部与肩部、腿部与臀部、背部与手臂。
- 今日训练、最近 3 条训练历史、1 个自定义动作。
- 覆盖首页周条、计划列表、统计概览、动作库和编辑面板。
- 训练截图通过深链启动 `fixture-upper` 计划，避免手动创建训练。

fixture 同时写入 `databases/opengym-rn.db` 和 `files/SQLite/opengym-rn.db`；Expo SDK 55 实际读取后者，只写前者不会生效。安装后会强制停止应用，下次启动才读到新数据。

不提供模拟器快照方案。`-Snapshot` 加载曾使 `emulator-5556` 进入 offline，固定数据统一用 fixture。

## 3. 深链

App 支持 `opengym://` scheme，用于跳过 Tab/滚动：

```text
opengym://home
opengym://plan
opengym://stats
opengym://library
opengym://settings
opengym://start-sheet
opengym://workout?routine=fixture-upper
opengym://gallery
```

加 `e2e=1` 会冻结训练页用时和休息倒计时，保证 `uiautomator dump` 能拿到 idle：

```powershell
adb shell "am start -W -a android.intent.action.VIEW -d 'opengym://workout?e2e=1&routine=fixture-upper'"
```

URL 必须整条加单引号，否则 `adb shell` 会把 `&routine` 截断。深链启动训练要求本地工作区已加载且当前没有草稿。

`opengym://gallery` 仅在 Debug 构建的 `__DEV__` 中显示设置入口；直接深链仍会打开设计画廊。

## 4. 什么时候截什么

| 阶段 | 做什么 | 不做什么 |
| --- | --- | --- |
| 开发中 | `check`、必要的 `uiautomator` 断言 | 每改一行就截图 |
| 完成一个页面/阶段 | 深链打开该页面，截 1 张；跑一次 smoke | 截图每个点击步骤 |
| 完成一组页面 | `ui-capture` 生成 contact sheet，只看拼图 | 逐张读全分辨率图 |
| 功能改动 | `five-tab-smoke.ps1` 或对应回归 | 用截图证明数据写入 |
| 交付前 | Release APK + 关键截图 + APK 验签/哈希 | 只交 Debug 截图 |

## 5. 功能冒烟脚本

```powershell
# 五 Tab、设置、计划、计划编辑、统计、动作库、筛选、开始 Sheet
.\mobile-rn\scripts\five-tab-smoke.ps1 -Serial emulator-5556 -ResetAppData

# 设计系统 Gallery
.\mobile-rn\scripts\design-gallery-verify.ps1 -Serial emulator-5556
```

`five-tab-smoke.ps1` 使用默认数据里的 `全身力量 A`，所以先跑 smoke，再跑 `ui-capture.ps1 -Fixture`；两者都会改动应用数据。

训练页计时器在 `e2e=1` 下冻结；没有 `e2e=1` 时不要依赖 `uiautomator dump`，改用截图或 logcat。

## 6. 旧回归脚本

`android-regression.ps1` 仍使用旧三 Tab 标签和直接“开始训练”按钮。五 Tab 重构后先使用 `five-tab-smoke.ps1`；在重跑旧数据回归前，需要把脚本改成：

- `训练` → `计划` / `首页`
- `历史` → `统计`
- `服务器` → 首页齿轮 → `设置`
- `开始训练` → 计划行 `更多` → `开始训练`
- 训练页新增 `Stepper`、`ActionSheet` 和 `用时` 文本

## 7. 验收记录

截图和日志放在 `mobile-rn/dist/ui/`（gitignore）。交付记录写：

- 模拟器序列号、Android 版本、分辨率/密度。
- `check`、smoke 脚本结果。
- contact sheet 或单张截图路径。
- APK 路径、版本、`apksigner` 结果和 SHA-256。
- 已知问题：例如浅色主题状态栏、fixture 依赖 Debug APK、旧 regression 未适配。
