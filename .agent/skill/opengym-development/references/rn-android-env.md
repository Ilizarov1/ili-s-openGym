# openGym RN Android 工具链、短路径构建与共享设备池规程

## 1. 工具链与短路径构建约束

- **本机工具链基线**：Expo SDK 55 / RN 0.83、JDK 17、Android SDK 36，默认位于 `%LOCALAPPDATA%\RnToolchain`（执行前校验 `JAVA_HOME` 与 `ANDROID_HOME`）。
- **Windows 强制短路径 Worktree**：编译新架构 C++ 原生模块（`expo-modules-core`、`react-native-svg`、`react-native-safe-area-context`）受 Windows CMake/Ninja 250 字符对象路径上限限制。**严禁在深路径 worktree 下运行 Gradle，且不使用 `subst` 虚拟盘**。一律使用短路径创建独立 worktree：
  ```powershell
  git worktree add D:\wt\<短名> -b feat/<短名>
  # 交付并合入后清理：git worktree remove D:\wt\<短名>
  ```
- **先 Debug 热更新，后单次 Release**：UI 与交互改动先用 Debug APK + Metro 热更新（或单架构 `-PreactNativeArchitectures=x86_64`）调通全部用例并录制视觉验收 GIF；最后仅执行**一次**全量 `:app:assembleRelease` 构建、`apksigner verify` 验签、`aapt dump badging` 核验与 `Get-FileHash -Algorithm SHA256` 记录。
- **真机保数据安装**：使用 `.\mobile-rn\scripts\install-device.ps1 [-Apk <路径>] [-Serial <序列号>] [-Launch]` 执行保数据 `adb install -r`；遇签名不兼容立即报错停止，严禁擅自卸载清空用户真机数据。

## 2. 共享模拟器池与 `agent-device` 原子互斥

本机共享两台 Android 36 x86_64 AVD（最多并发 2 个验收会话，第 3 个通过 `--wait` 排队）：

| AVD 名称 | 控制台 / ADB 端口 | 序列号 |
|---|---|---|
| `openGymRnQa` | 5556 / 5557 | `emulator-5556` |
| `openGymRnQaWorker` | 5560 / 5561 | `emulator-5560` |

### 2.1 环境初始化与冷启动（按需）

```powershell
$toolchain = Join-Path $env:LOCALAPPDATA 'RnToolchain'
$env:ANDROID_HOME = Join-Path $toolchain 'android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_AVD_HOME = Join-Path $toolchain 'avd'
$env:PATH = "$($env:ANDROID_HOME)\platform-tools;$($env:ANDROID_HOME)\emulator;$env:PATH"
agent-device doctor
```

若 `doctor` 找不到 `adb`，补齐 `PATH` 后运行一次 `agent-device daemon stop` 让下次调用加载新环境（若其它工作区有活跃会话则勿停 daemon）。若池中无已启动模拟器，先确认目标端口（5556 或 5560）空闲再后台冷启动对应 AVD，轮询 `sys.boot_completed == 1`。

### 2.2 原子申领、执行与 `finally` 释放模板

严禁绕过 `agent-device` 直接对未申领模拟器执行安装或清数据；不传全局 `--session`（默认按当前 worktree `cwd` 自动隔离）：

```powershell
$pool = @('openGymRnQa', 'openGymRnQaWorker')
$waitMs = 600000
agent-device close --json 2>$null | Out-Null

$devices = (agent-device devices --platform android --json | ConvertFrom-Json).data.devices
$candidates = @($devices | Where-Object { $_.kind -eq 'emulator' -and $_.booted -and $pool -contains $_.name })
if ($candidates.Count -eq 0) { throw '设备池无已启动模拟器，请先按固定端口启动 AVD' }

$claims = (agent-device device status --platform android --json | ConvertFrom-Json).data.claims
$busy = @($claims | ForEach-Object { $_.device.id })
$free = @($candidates | Where-Object { $busy -notcontains $_.id })

$claimed = $null
foreach ($d in $free) {
  $raw = agent-device open com.android.settings --platform android --serial $d.id --json 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) { $claimed = $d; break }
  if ($raw -notmatch 'DEVICE_IN_USE') { throw $raw }
}
if (-not $claimed) {
  $target = $candidates | Where-Object { $_.name -eq 'openGymRnQa' } | Select-Object -First 1
  if (-not $target) { $target = $candidates[0] }
  $raw = agent-device open com.android.settings --platform android --serial $target.id --wait $waitMs --json 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "设备排队等待超时或失败：$raw" }
  $claimed = $target
}

$serial = $claimed.id
try {
  # 1. 安装 APK / 写入 fixture / 打开 dev.opengym.rn
  agent-device install dev.opengym.rn $apkPath --platform android --serial $serial
  agent-device open dev.opengym.rn --platform android --serial $serial
  # 2. 执行深链测试、冒烟脚本及 record-gif.ps1 录制真实操作 GIF（倒计时页面控件树采样附加 e2e=1）
} finally {
  agent-device close
}
```

### 2.3 异常残留恢复
若进程意外中断导致本工作区声明残留，先在本工作区执行 `agent-device close`；仍残留时通过 `agent-device device status --platform android --json` 查出 `owner.workspace` 为当前目录的 `owner.session` 执行定向 `close --session <id>`。仅当 `device status --stale` 证明持有进程已死时才允许 `device release --platform android --stale`，绝不强拆他人活跃声明。
