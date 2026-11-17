#requires -Version 7.0
<#
.SYNOPSIS
    End-to-end superset smoke test for the five-tab openGym RN Debug build.

.DESCRIPTION
    Installs the Debug APK, writes the superset fixture (see make-ui-fixture.mjs), then:
      1. edits an existing superset name/rest in 计划 → 训练计划, saves and reopens it;
      2. runs A1 → B1 → A2 with a 73-second round rest and no intra-round rest;
      3. force-stops during the draft and checks the next set survives;
      4. checks the group in 统计 history and the 73-second countdown as real time;
      5. runs a group without sgRest and expects the longest member rest (40 s, not 25 s);
      6. creates a group from two ungrouped exercises through the plan editor, reopens it and
         starts the workout.

    The APK must be a Debug build: the fixture is copied into the app's private SQLite database
    with `run-as`. Metro must be running and reachable; the script installs `adb reverse 8081`.

    The countdown is read with the same UiAutomation dumper as android-regression.ps1, because
    `uiautomator dump` can time out while the rest text updates every second. The full 73-second
    expiry wait is opt-in (`-RealtimeRest`) and otherwise reported as a manual item; it is never
    reported as passed when it was not run. The 40-second member rest is asserted from its start
    value and a short live decrement, not a full expiry wait.

.PARAMETER Apk
    Debug APK path. Defaults to android/app/build/outputs/apk/debug/app-debug.apk.

.PARAMETER Serial
    Dedicated emulator serial, for example emulator-5556.

.PARAMETER OutDir
    Screenshot, XML and failure-log directory. Defaults to mobile-rn/dist/ui/superset.

.PARAMETER SkipInstall
    Reuse an already installed Debug APK instead of installing -Apk.

.PARAMETER RealtimeRest
    Also wait out the complete 73-second rest and assert it expires. This makes the script about
    one minute slower. Without it, only the start value and a 3-second decrement are asserted.

.EXAMPLE
    .\mobile-rn\scripts\superset-smoke.ps1 -Serial emulator-5556 `
        -Apk .\mobile-rn\android\app\build\outputs\apk\debug\app-debug.apk
#>
[CmdletBinding()]
param(
    [string]$Apk = (Join-Path $PSScriptRoot '..\android\app\build\outputs\apk\debug\app-debug.apk'),
    [ValidatePattern('^emulator-\d+$')][string]$Serial = 'emulator-5556',
    [string]$Adb,
    [string]$OutDir = (Join-Path $PSScriptRoot '..\dist\ui\superset'),
    [switch]$SkipInstall,
    [switch]$RealtimeRest
)

$ErrorActionPreference = 'Stop'
$appId = 'dev.opengym.rn'
$apkPath = (Resolve-Path -LiteralPath $Apk).Path
if (![IO.File]::Exists($apkPath) -or [IO.Path]::GetExtension($apkPath) -ne '.apk') {
    throw 'Supply the Debug APK file.'
}
if (!$Adb) {
    $candidates = @()
    if ($env:ANDROID_HOME) { $candidates += Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'OpenGymRnToolchain\android-sdk\platform-tools\adb.exe' }
    $found = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (!$found) { $found = (Get-Command adb.exe).Source }
    $Adb = $found
}
$Adb = (Resolve-Path -LiteralPath $Adb).Path
$sdk = Split-Path (Split-Path $Adb)
$javac = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\javac.exe' } else { (Get-Command javac.exe).Source }
$platformJar = Join-Path $sdk 'platforms\android-36\android.jar'
$d8 = Join-Path $sdk 'build-tools\36.0.0\d8.bat'
$node = (Get-Command node.exe).Source
if (!(Test-Path -LiteralPath $platformJar) -or !(Test-Path -LiteralPath $d8)) {
    throw 'Install Android SDK platform and build-tools 36 before running this smoke test.'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$buildDirectory = Join-Path ([IO.Path]::GetTempPath()) "opengym-superset-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $buildDirectory | Out-Null
$uiFile = Join-Path $OutDir 'superset-window.xml'
$remoteDumper = "/data/local/tmp/$([IO.Path]::GetFileName($buildDirectory)).dex"
$remoteScreenshot = "/sdcard/$([IO.Path]::GetFileName($buildDirectory)).png"

function Invoke-Adb {
    $output = & $Adb -s $Serial @args 2>&1
    if ($LASTEXITCODE -ne 0 -and ($output -join ' ') -match 'cannot connect to daemon|daemon still not running') {
        & $Adb start-server | Out-Null
        $output = & $Adb -s $Serial @args 2>&1
    }
    if ($LASTEXITCODE -ne 0) { throw "ADB failed: $($args -join ' ') on ${Serial}: $($output -join ' ')" }
    $output
}

function Read-Ui {
    $dump = Invoke-Adb shell "CLASSPATH=${remoteDumper}:/system/framework/uiautomator.jar" app_process /system/bin DumpActiveWindow $screenWidth $screenHeight
    if (!$dump) { return $null }
    $content = $dump -join [Environment]::NewLine
    Set-Content -LiteralPath $uiFile -Value $content -Encoding utf8
    [xml]$content
}

function Test-VisibleBounds($Node) {
    $bounds = [regex]::Match($Node.GetAttribute('bounds'), '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
    $bounds.Success -and ([int]$bounds.Groups[3].Value - [int]$bounds.Groups[1].Value -ge 8) -and
        ([int]$bounds.Groups[4].Value - [int]$bounds.Groups[2].Value -ge 12)
}

function Wait-Node([scriptblock]$Match, [string]$Context, [switch]$Scroll, [switch]$System, [int]$Seconds = 25) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $ui = Read-Ui
        if ($ui) {
            $nodes = if ($System) { $ui.SelectNodes('//node') } else { $ui.SelectNodes("//node[@package='$appId']") }
            $node = $nodes | Where-Object $Match | Where-Object { Test-VisibleBounds $_ } | Select-Object -First 1
            if ($node) { return $node }
            if ($Scroll -and $nodes.Count -gt 0) {
                $bounds = [regex]::Match($nodes[0].GetAttribute('bounds'), '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
                if ($bounds.Success) {
                    $left, $top, $right, $bottom = 1..4 | ForEach-Object { [int]$bounds.Groups[$_].Value }
                    $x = [int](($left + $right) / 2)
                    $fromY = [int]($top + ($bottom - $top) * 0.78)
                    $toY = [int]($top + ($bottom - $top) * 0.35)
                    Invoke-Adb shell input swipe $x $fromY $x $toY 350 | Out-Null
                }
            }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Expected Android UI: $Context"
}

function Wait-Label([string]$Label, [switch]$Field, [switch]$Enabled, [switch]$Scroll) {
    Wait-Node {
        $description = $_.GetAttribute('content-desc')
        $matchesLabel = $description -eq $Label -or (!$Field -and $_.GetAttribute('text') -eq $Label)
        $matchesLabel -and (!$Enabled -or $_.GetAttribute('enabled') -eq 'true')
    } $Label -Scroll:$Scroll
}

function Tap-Node($node, [string]$Label) {
    $bounds = [regex]::Match($node.GetAttribute('bounds'), '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
    if (!$bounds.Success) { throw "Missing screen bounds for $Label" }
    $x = [int](([int]$bounds.Groups[1].Value + [int]$bounds.Groups[3].Value) / 2)
    $y = [int](([int]$bounds.Groups[2].Value + [int]$bounds.Groups[4].Value) / 2)
    Invoke-Adb shell input tap $x $y | Out-Null
}

function Tap-Label([string]$Label, [switch]$Field, [switch]$Scroll) {
    Tap-Node (Wait-Label $Label -Field:$Field -Enabled -Scroll:$Scroll) $Label
}

function Set-Field([string]$Label, [string]$Value, [switch]$Scroll) {
    Tap-Label $Label -Field -Scroll:$Scroll
    Invoke-Adb shell input keycombination 113 29 | Out-Null
    Invoke-Adb shell input text ($Value.Replace(' ', '%s')) | Out-Null
    Invoke-Adb shell input keyevent KEYCODE_BACK | Out-Null
    Wait-Node { $_.GetAttribute('content-desc') -eq $Label -and $_.GetAttribute('text') -eq $Value } "${Label}: $Value" | Out-Null
}

function Get-RestSeconds {
    $timer = Wait-Node { $_.GetAttribute('text') -match '^\d+:\d\d$' } 'Running rest countdown'
    $minutes, $seconds = $timer.GetAttribute('text').Split(':')
    [int]$minutes * 60 + [int]$seconds
}

function Assert-NoRest([string]$Context) {
    $ui = Read-Ui
    if (!$ui) { throw "Could not read UI to check for a rest dock: $Context" }
    if ($ui.SelectSingleNode("//node[@text='组间休息']")) { throw "$Context started a rest." }
}

function Save-Screenshot([string]$Name) {
    $path = Join-Path $OutDir "$Name.png"
    $process = Start-Process -FilePath $Adb `
        -ArgumentList @('-s', $Serial, 'exec-out', 'screencap', '-p') `
        -RedirectStandardOutput $path -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -ne 0 -or -not (Test-Path $path) -or (Get-Item $path).Length -lt 1000) {
        throw "screenshot failed: $Name"
    }
    Write-Output "screenshot: $path"
}

function Scroll-ToTop {
    $x = [int]($screenWidth / 2)
    $fromY = [int]($screenHeight * 0.30)
    $toY = [int]($screenHeight * 0.85)
    1..3 | ForEach-Object { Invoke-Adb shell input swipe $x $fromY $x $toY 200 | Out-Null }
}

function Wait-Stats {
    Wait-Node {
        $_.GetAttribute('text') -eq '训练次数' -or $_.GetAttribute('text') -eq '还没有训练记录'
    } 'Stats screen' | Out-Null
}

function Open-Stats {
    Tap-Label '统计'
    Wait-Stats
    Scroll-ToTop
}

function Open-PlanList {
    Tap-Label '计划'
    Wait-Label '计划' | Out-Null
    Scroll-ToTop
    Tap-Label '训练计划'
    Wait-Node {
        $_.GetAttribute('text') -in @('新训练日', '新建计划')
    } 'Plan routines' | Out-Null
}

function Open-PlanEditor([string]$Name) {
    Open-PlanList
    Tap-Label "$Name 更多操作" -Scroll
    Tap-Label '编辑计划'
    Wait-Label '编辑计划' | Out-Null
}

function Start-Routine([string]$Name) {
    Open-PlanList
    Tap-Label "$Name 更多操作" -Scroll
    Tap-Label '开始训练'
    Wait-Label '完成训练' | Out-Null
}

function Expand-Exercise([string]$Name) {
    Tap-Label "展开$Name" -Scroll
    Wait-Label "收起$Name" | Out-Null
}

function Tap-Workout([string]$Name) {
    $node = Wait-Node {
        $description = $_.GetAttribute('content-desc')
        $description -like "$Name*" -and ($description -like '*展开详情*' -or $description -like '*收起详情*')
    } "$Name workout row" -Scroll
    Tap-Node $node "$Name workout row"
}

function Assert-PlanField([string]$Label, [string]$Value) {
    Wait-Node {
        $_.GetAttribute('content-desc') -eq $Label -and $_.GetAttribute('text') -eq $Value
    } "${Label}: $Value" | Out-Null
}

function Install-Fixture {
    $db = Join-Path $OutDir 'opengym-rn.db'
    & $node (Join-Path $PSScriptRoot 'make-ui-fixture.mjs') $db
    if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    Invoke-Adb shell am force-stop $appId | Out-Null
    Invoke-Adb push $db /data/local/tmp/opengym-rn-superset.db | Out-Null
    Invoke-Adb shell run-as $appId mkdir '-p' databases | Out-Null
    Invoke-Adb shell run-as $appId mkdir '-p' files/SQLite | Out-Null
    Invoke-Adb shell run-as $appId cp /data/local/tmp/opengym-rn-superset.db databases/opengym-rn.db | Out-Null
    Invoke-Adb shell run-as $appId cp /data/local/tmp/opengym-rn-superset.db files/SQLite/opengym-rn.db | Out-Null
    Invoke-Adb shell run-as $appId rm '-f' databases/opengym-rn.db-wal databases/opengym-rn.db-shm | Out-Null
    Invoke-Adb shell run-as $appId rm '-f' files/SQLite/opengym-rn.db-wal files/SQLite/opengym-rn.db-shm | Out-Null
    Invoke-Adb shell rm -f /data/local/tmp/opengym-rn-superset.db | Out-Null
    Write-Output "fixture installed: $db"
}

function Start-App {
    Invoke-Adb shell am force-stop $appId | Out-Null
    Invoke-Adb shell am start -W -n "$appId/.MainActivity" | Out-Null
    Wait-Node {
        $_.GetAttribute('text') -eq '首页' -or $_.GetAttribute('content-desc') -eq '训练菜单'
    } 'App shell' -Seconds 75 | Out-Null
}

$passed = $false
try {
    if ((Invoke-Adb shell getprop ro.kernel.qemu).Trim() -ne '1') {
        throw 'This smoke test requires a dedicated Android emulator.'
    }
    if ((Invoke-Adb shell getprop sys.boot_completed).Trim() -ne '1') {
        throw 'Wait for the Android emulator to finish booting.'
    }
    $screenSize = Invoke-Adb shell wm size | Select-Object -Last 1
    if ($screenSize -notmatch '(\d+)x(\d+)') { throw 'Could not read emulator display size.' }
    $screenWidth, $screenHeight = $Matches[1], $Matches[2]
    & $javac --release 8 -classpath $platformJar -d $buildDirectory (Join-Path $PSScriptRoot 'DumpActiveWindow.java')
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the emulator UI dumper.' }
    & $d8 --min-api 26 --lib $platformJar --output $buildDirectory (Join-Path $buildDirectory 'DumpActiveWindow.class')
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the emulator UI dumper.' }
    Invoke-Adb push (Join-Path $buildDirectory 'classes.dex') $remoteDumper | Out-Null

    if (!$SkipInstall) {
        Write-Host "Installing Debug APK: $apkPath"
        Invoke-Adb install -r $apkPath | Out-Null
    }
    & $Adb -s $Serial shell run-as $appId true 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'The installed app is not debuggable. Install the Debug APK before running this smoke test.' }
    if ((Invoke-Adb shell pm clear $appId) -ne 'Success') { throw "Unable to clear test app data on $Serial" }
    Install-Fixture
    Invoke-Adb reverse tcp:8081 tcp:8081 | Out-Null
    Start-App

    Write-Host 'Checking plan editor superset name and 73-second round rest'
    Open-PlanEditor '超级组推胸 A'
    Assert-PlanField '超级组名称' 'Push pair'
    Assert-PlanField '轮间休息秒数' '73'
    Save-Screenshot '01-plan-editor-group'
    Set-Field '超级组名称' 'Push pair 73'
    Scroll-ToTop
    Tap-Label '保存'
    Wait-Label '超级组推胸 A' | Out-Null
    Open-PlanEditor '超级组推胸 A'
    Assert-PlanField '超级组名称' 'Push pair 73'
    Assert-PlanField '轮间休息秒数' '73'
    Save-Screenshot '02-plan-editor-reopened'
    Tap-Label '返回'

    Write-Host 'Checking the superset fixture in Stats history'
    Open-Stats
    Tap-Workout '超级组历史样本'
    Wait-Label '超级组 · Push pair' -Scroll | Out-Null
    Save-Screenshot '03-history-fixture'

    Write-Host 'Checking A1 -> B1 -> A2 rotation, no intra-round rest and draft restart'
    Start-Routine '超级组推胸 A'
    Wait-Label '超级组 · Push pair 73' -Scroll | Out-Null
    Wait-Label '第 1 轮 · 下一组 杠铃卧推' -Scroll | Out-Null
    if ((Wait-Label '杠铃卧推 第 2 组完成').GetAttribute('enabled') -ne 'false') {
        throw 'A future round could be completed before its turn.'
    }
    Save-Screenshot '04-workout-round-1'
    Tap-Label '杠铃卧推 第 1 组完成'
    Wait-Label '第 1 轮 · 下一组 杠铃上斜卧推' -Scroll | Out-Null
    Assert-NoRest 'The A1 -> B1 switch'
    Save-Screenshot '05-intra-round-no-rest'

    Invoke-Adb shell am force-stop $appId | Out-Null
    Start-App
    Wait-Label '第 1 轮 · 下一组 杠铃上斜卧推' -Scroll | Out-Null
    Save-Screenshot '06-draft-resumed'

    Tap-Label '杠铃上斜卧推 第 1 组完成'
    Wait-Label '第 2 轮 · 下一组 杠铃卧推' -Scroll | Out-Null
    Wait-Label '组间休息' | Out-Null
    $rest = Get-RestSeconds
    if ($rest -lt 69 -or $rest -gt 73) {
        throw "The 73-second group override was not used; the rest dock read ${rest}s."
    }
    Save-Screenshot '07-rest-73'
    if ($RealtimeRest) {
        $started = Get-Date
        while ($true) {
            $ui = Read-Ui
            if (!$ui -or !$ui.SelectSingleNode("//node[@text='组间休息']")) { break }
            if (((Get-Date) - $started).TotalSeconds -gt 90) { throw 'The 73-second rest did not expire within 90 seconds.' }
            Start-Sleep -Milliseconds 1000
        }
        $elapsed = ((Get-Date) - $started).TotalSeconds
        if ($elapsed -lt 68 -or $elapsed -gt 86) {
            throw "The 73-second rest expired after $([Math]::Round($elapsed, 1))s."
        }
        Write-Output "VERIFIED: the 73-second rest counted down to zero after $([Math]::Round($elapsed, 1))s."
        Write-Output 'MANUAL: confirm the rest-expiry notification separately; this script asserts the dock only.'
    } else {
        Start-Sleep -Seconds 3
        $remaining = Get-RestSeconds
        $drop = $rest - $remaining
        if ($drop -lt 2 -or $drop -gt 5) { throw 'The 73-second round rest did not count down in real time.' }
        Write-Output "VERIFIED: the 73-second rest read ${rest}s and dropped ${drop}s in three seconds."
        Write-Output 'MANUAL: wait out the full 73-second dock and the rest notification; pass -RealtimeRest to assert the expiry instead.'
        Tap-Label '取消休息'
    }
    Tap-Label '杠铃卧推 第 2 组完成'
    Wait-Node { $_.GetAttribute('content-desc') -eq '杠铃卧推 第 2 组完成' -and $_.GetAttribute('checked') -eq 'true' } 'Last superset set' | Out-Null
    Assert-NoRest 'The last set of the workout'
    Save-Screenshot '08-group-complete'
    Tap-Label '完成训练' -Scroll
    Wait-Stats
    Save-Screenshot '09-stats'

    Write-Host 'Checking history rendering and the stored group'
    Tap-Workout '超级组推胸 A'
    Wait-Label '超级组 · Push pair 73' -Scroll | Out-Null
    Save-Screenshot '10-history-recorded'

    Write-Host 'Checking the longest member rest (25/40 -> 40) when the group has no sgRest'
    Start-Routine '超级组长休息 B'
    Wait-Label '第 1 轮 · 下一组 杠铃全蹲' -Scroll | Out-Null
    Tap-Label '杠铃全蹲 第 1 组完成'
    Wait-Label '第 1 轮 · 下一组 杠铃罗马尼亚硬拉' -Scroll | Out-Null
    Assert-NoRest 'The A1 -> B1 switch without sgRest'
    Tap-Label '杠铃罗马尼亚硬拉 第 1 组完成'
    Wait-Label '第 2 轮 · 下一组 杠铃全蹲' -Scroll | Out-Null
    Wait-Label '组间休息' | Out-Null
    $memberRest = Get-RestSeconds
    if ($memberRest -lt 38 -or $memberRest -gt 40) {
        throw "The longest member rest should be 40 seconds; the dock read ${memberRest}s."
    }
    Save-Screenshot '11-rest-40'
    Start-Sleep -Seconds 2
    $memberRemaining = Get-RestSeconds
    if ($memberRest - $memberRemaining -lt 1 -or $memberRest - $memberRemaining -gt 4) {
        throw 'The 40-second member rest did not count down in real time.'
    }
    Tap-Label '取消休息'
    Tap-Label '杠铃全蹲 第 2 组完成'
    Tap-Label '完成训练' -Scroll
    Wait-Stats

    Write-Host 'Checking plan-editor pairing, save/reopen and the new group in training'
    Open-PlanEditor '超级组新建 C'
    Expand-Exercise '杠铃罗马尼亚硬拉'
    Tap-Label '与上一动作组成超级组' -Scroll
    Scroll-ToTop
    Wait-Label '超级组名称' -Field | Out-Null
    Set-Field '超级组名称' 'Super pair C' -Scroll
    Set-Field '轮间休息秒数' '73' -Scroll
    Scroll-ToTop
    Tap-Label '保存'
    Wait-Label '超级组新建 C' | Out-Null
    Open-PlanEditor '超级组新建 C'
    Assert-PlanField '超级组名称' 'Super pair C'
    Assert-PlanField '轮间休息秒数' '73'
    Save-Screenshot '12-created-group'
    Tap-Label '返回'
    Start-Routine '超级组新建 C'
    Wait-Label '超级组 · Super pair C' -Scroll | Out-Null
    Wait-Label '第 1 轮 · 下一组 杠铃全蹲' -Scroll | Out-Null
    Save-Screenshot '13-created-group-workout'
    Tap-Label '放弃训练' -Scroll
    Tap-Label '放弃'
    Wait-Label '计划' | Out-Null

    $passed = $true
    Write-Output 'PASS: superset plan edit/save/reopen, 73-second round rest, A1->B1->A2, wait for the whole group, draft restart, 40-second longest member rest, history and new group creation verified.'
} catch {
    try { Read-Ui | Out-Null } catch { Write-Warning "Could not dump the failure window: $_" }
    try {
        if (Test-Path -LiteralPath $uiFile) {
            Copy-Item -LiteralPath $uiFile -Destination (Join-Path $OutDir 'failure-window.xml') -Force
        }
    } catch { Write-Warning "Could not save the failure window tree: $_" }
    try {
        Invoke-Adb shell screencap -p $remoteScreenshot | Out-Null
        Invoke-Adb pull $remoteScreenshot (Join-Path $OutDir 'failure.png') | Out-Null
    } catch { Write-Warning "Could not save the failure screenshot: $_" }
    try {
        Invoke-Adb logcat -d -t 300 | Set-Content -LiteralPath (Join-Path $OutDir 'logcat.txt') -Encoding utf8
    } catch { Write-Warning "Could not save the failure logcat: $_" }
    Write-Warning "Superset smoke diagnostics: $OutDir"
    throw
} finally {
    try {
        Invoke-Adb shell rm -f $remoteDumper $remoteScreenshot | Out-Null
    } catch { Write-Warning "Could not remove the remote smoke files: $_" }
    if (Test-Path -LiteralPath $buildDirectory) {
        Remove-Item -LiteralPath $buildDirectory -Recurse -Force
    }
    if ($passed) { Write-Output "Screenshots: $OutDir" }
}
