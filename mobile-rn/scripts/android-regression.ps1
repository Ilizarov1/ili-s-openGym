#requires -Version 7.0
# Run against a dedicated, already running Android emulator with its window visible.
# -ResetAppData clears openGym RN data on the named emulator before the run.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Apk,
    [Parameter(Mandatory)][ValidatePattern('^emulator-\d+$')][string]$Serial,
    [string]$Adb,
    [switch]$ResetAppData,
    [switch]$FeatureChecks,
    [switch]$P1Checks,
    [switch]$SupersetChecks
)

$ErrorActionPreference = 'Stop'
$appId = 'dev.opengym.rn'
$apiDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\api')).Path
$fixtureRunner = Join-Path $PSScriptRoot 'loopback-api.mjs'
$apkPath = (Resolve-Path -LiteralPath $Apk).Path
if (![IO.File]::Exists($apkPath) -or [IO.Path]::GetExtension($apkPath) -ne '.apk') {
    throw 'Supply the candidate APK file.'
}
$node = (Get-Command node.exe).Source
if (!(Test-Path -LiteralPath (Join-Path $apiDirectory 'node_modules'))) {
    throw 'Install the API dependencies with npm.cmd ci in api/ before running this regression.'
}
if (!$Adb) {
    if ($env:ANDROID_HOME) { $Adb = Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
    else { $Adb = (Get-Command adb.exe).Source }
}
$Adb = (Resolve-Path -LiteralPath $Adb).Path
$sdk = Split-Path (Split-Path $Adb)
$javac = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\javac.exe' } else { (Get-Command javac.exe).Source }
$platformJar = Join-Path $sdk 'platforms\android-36\android.jar'
$d8 = Join-Path $sdk 'build-tools\36.0.0\d8.bat'
if (!(Test-Path -LiteralPath $platformJar) -or !(Test-Path -LiteralPath $d8)) {
    throw 'Install Android SDK platform and build-tools 36 before running this regression.'
}

function Invoke-Adb {
    $output = & $Adb -s $Serial @args 2>&1
    if ($LASTEXITCODE -ne 0 -and ($output -join ' ') -match 'cannot connect to daemon|daemon still not running') {
        & $Adb start-server | Out-Null
        $output = & $Adb -s $Serial @args 2>&1
    }
    if ($LASTEXITCODE -ne 0) { throw "ADB failed: $($args[0]) $($args[1]) on ${Serial}: $($output -join ' ')" }
    $output
}

if ((Invoke-Adb shell getprop ro.kernel.qemu).Trim() -ne '1') {
    throw 'This regression requires a dedicated Android emulator.'
}
if ((Invoke-Adb shell getprop sys.boot_completed).Trim() -ne '1') {
    throw 'Wait for the Android emulator to finish booting.'
}
$installed = Invoke-Adb shell pm list packages $appId
if ($installed -contains "package:$appId" -and !$ResetAppData) {
    throw 'Existing app data detected. Use a clean emulator or pass -ResetAppData for this emulator.'
}

$tempRoot = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).Path
$runDirectory = Join-Path $tempRoot "opengym-rn-regression-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$uiFile = Join-Path $runDirectory 'ui.xml'
$remoteDumper = "/data/local/tmp/$([IO.Path]::GetFileName($runDirectory)).dex"
$remoteUi = "/data/local/tmp/$([IO.Path]::GetFileName($runDirectory)).xml"
$remoteScreenshot = "/sdcard/$([IO.Path]::GetFileName($runDirectory)).png"
$remoteBackup = "/sdcard/Download/$([IO.Path]::GetFileName($runDirectory)).json"
$server = $null
$reversePort = $null
$reverseInstalled = $false
$passed = $false

function Read-Ui {
    Invoke-Adb shell "CLASSPATH=${remoteDumper}:/system/framework/uiautomator.jar" app_process /system/bin DumpActiveWindow $screenWidth $screenHeight $remoteUi | Out-Null
    Invoke-Adb pull $remoteUi $uiFile | Out-Null
    $content = Get-Content -LiteralPath $uiFile -Raw -Encoding utf8
    if (!$content) { return $null }
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

function Get-RestSeconds {
    $timer = Wait-Node { $_.GetAttribute('text') -match '^\d+:\d\d$' } 'Running rest countdown'
    $minutes, $seconds = $timer.GetAttribute('text').Split(':')
    [int]$minutes * 60 + [int]$seconds
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

function Open-Home {
    Tap-Label '首页'
    Wait-Label '首页' | Out-Null
    Scroll-ToTop
}

function Open-Settings {
    Open-Home
    Tap-Label '设置'
    Wait-Label '设置' | Out-Null
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

function Tap-PlanAction([string]$Name, [string]$Label) {
    Open-PlanList
    Tap-Label "$Name 更多操作" -Scroll
    Tap-Label $Label
}

function Start-Routine([string]$Name) {
    Tap-PlanAction $Name '开始训练'
    Wait-Label '完成训练' | Out-Null
}

# The finish panel and summary (06): live workouts save through "结束并保存",
# then the summary's "完成" returns Home.
function Finish-Workout {
    $donePrompt = (Read-Ui).SelectSingleNode("//node[@text='全部完成！']")
    if (!$donePrompt) { Tap-Label '完成训练' -Scroll }
    Tap-Label '结束并保存'
    Wait-Label '训练完成' | Out-Null
    Tap-Label '完成'
}

function Finish-ToStats {
    Finish-Workout
    Open-Stats
}

function Open-PlanEditor([string]$Name) {
    Tap-PlanAction $Name '编辑计划'
    Wait-Label '编辑计划' | Out-Null
}

function Wait-Workout([string]$Name) {
    Wait-Node {
        $description = $_.GetAttribute('content-desc')
        $description -like "$Name*" -and ($description -like '*展开详情*' -or $description -like '*收起详情*')
    } "$Name workout row" -Scroll | Out-Null
}

function Tap-Workout([string]$Name) {
    $node = Wait-Node {
        $description = $_.GetAttribute('content-desc')
        $description -like "$Name*" -and ($description -like '*展开详情*' -or $description -like '*收起详情*')
    } "$Name workout row" -Scroll
    Tap-Node $node "$Name workout row"
}

function Tap-ExerciseHistory {
    $node = Wait-Node {
        $_.GetAttribute('content-desc') -like '*，查看动作历史'
    } 'Exercise history row' -Scroll
    Tap-Node $node 'Exercise history row'
}

function Tap-Switch([string]$Label) {
    $node = Wait-Node {
        $_.GetAttribute('content-desc') -eq $Label -and
            ($_.GetAttribute('checkable') -eq 'true' -or $_.GetAttribute('class') -like '*Switch*')
    } $Label -Scroll
    Tap-Node $node $Label
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

function Tap-SystemLabel([string]$Label) {
    Tap-Node (Wait-Node { $_.GetAttribute('text') -eq $Label -or $_.GetAttribute('content-desc') -eq $Label } $Label -System) $Label
}

function Confirm-MergeResult {
    Wait-Label '已合并' | Out-Null
    $button = Wait-Node { $_.GetAttribute('text') -in @('OK','确定') } 'Backup merge confirmation' -System
    Tap-Node $button 'Backup merge confirmation'
}

function Set-Field([string]$Label, [string]$Value, [switch]$Scroll) {
    Tap-Label $Label -Field -Scroll:$Scroll
    Invoke-Adb shell input keycombination 113 29 | Out-Null
    Invoke-Adb shell input text ($Value.Replace(' ', '%s')) | Out-Null
    Invoke-Adb shell input keyevent KEYCODE_BACK | Out-Null
    Wait-Node { $_.GetAttribute('content-desc') -eq $Label -and $_.GetAttribute('text') -eq $Value } "${Label}: $Value" | Out-Null
}

function Get-ApiData {
    Invoke-RestMethod "$baseUrl/api/data" -WebSession $apiSession -TimeoutSec 10
}

function Sync-App {
    Open-Settings
    Tap-Label '立即同步' -Scroll
    Wait-Node { $_.GetAttribute('text') -like '0 条待同步*' } 'P1 changes synced' | Out-Null
    Wait-Label '立即同步' -Enabled | Out-Null
    Scroll-ToTop
    Tap-Label '返回'
    Wait-Label '首页' | Out-Null
    (Get-ApiData).state
}

function Start-App {
    Invoke-Adb shell am start -W -n "$appId/.MainActivity" | Out-Null
    # A saved draft opens straight into the workout, where the tab bar is not mounted.
    Wait-Node {
        $_.GetAttribute('text') -eq '首页' -or $_.GetAttribute('content-desc') -eq '训练菜单'
    } 'App shell' -Seconds 75 | Out-Null
}

function Add-Reverse([int]$Port) {
    Invoke-Adb reverse --no-rebind "tcp:$Port" "tcp:$Port" | Out-Null
    $script:reverseInstalled = $true
}

function Remove-Reverse {
    Invoke-Adb reverse --remove "tcp:$reversePort" | Out-Null
    $script:reverseInstalled = $false
}

try {
    $screenSize = Invoke-Adb shell wm size | Select-Object -Last 1
    if ($screenSize -notmatch '(\d+)x(\d+)') { throw 'Could not read emulator display size.' }
    $screenWidth, $screenHeight = $Matches[1], $Matches[2]
    & $javac --release 8 -classpath $platformJar -d $runDirectory (Join-Path $PSScriptRoot 'DumpActiveWindow.java')
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the emulator UI dumper.' }
    & $d8 --min-api 26 --lib $platformJar --output $runDirectory (Join-Path $runDirectory 'DumpActiveWindow.class')
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the emulator UI dumper.' }
    Invoke-Adb push (Join-Path $runDirectory 'classes.dex') $remoteDumper | Out-Null

    Write-Host 'Installing candidate and checking offline practice'
    Invoke-Adb install -r $apkPath | Out-Null
    if ($ResetAppData) {
        if ((Invoke-Adb shell pm clear $appId) -ne 'Success') { throw "Unable to clear test app data on $Serial" }
    }
    Start-App
    Start-Routine '全身力量 A'
    Tap-Label '第 1 组重量' -Field
    Invoke-Adb shell input keyevent KEYCODE_MOVE_END KEYCODE_DEL | Out-Null
    Invoke-Adb shell input text '37.5' | Out-Null
    Invoke-Adb shell input keyevent KEYCODE_BACK | Out-Null
    Tap-Label '第 1 组完成'
    Wait-Label '已完成 1 组' | Out-Null
    if ($FeatureChecks) {
        Wait-Label '组间休息' | Out-Null
        $before = Get-RestSeconds
        if ($before -le 0 -or $before -gt 90) { throw 'The default rest countdown is outside its 90-second window.' }
        Invoke-Adb shell input keyevent KEYCODE_HOME | Out-Null
        Start-Sleep -Seconds 3
        Invoke-Adb shell am start -W -n "$appId/.MainActivity" | Out-Null
        if ((Get-RestSeconds) -ge $before) { throw 'Rest countdown did not advance while the app was in the background.' }
    }
    Invoke-Adb shell am force-stop $appId | Out-Null
    Invoke-Adb shell am start -W -n "$appId/.MainActivity" | Out-Null
    Wait-Label '已完成 1 组' | Out-Null
    if ($FeatureChecks) {
        Wait-Label '组间休息' | Out-Null
        Tap-Label '取消休息'
        $ui = Read-Ui
        if (!$ui -or $ui.SelectSingleNode("//node[@text='组间休息']")) {
            throw 'Cancelling rest did not hide the countdown.'
        }
        Wait-Label '已完成 1 组' | Out-Null
    }
    Finish-ToStats
    Invoke-Adb shell am force-stop $appId | Out-Null
    Start-App
    Open-Stats
    Tap-Workout '全身力量 A'
    Wait-Label '37.5 kg × 8' | Out-Null
    if ($FeatureChecks) {
        Open-PlanList
        Start-Routine '全身力量 A'
        Wait-Node { $_.GetAttribute('content-desc') -eq '第 1 组重量' -and $_.GetAttribute('text') -eq '37.5' } 'Recent weight prefilled as 37.5 kg' | Out-Null
        # The workout hides the tabs, so release the draft before pairing the account.
        Tap-Label '放弃训练' -Scroll
        Tap-Label '放弃'
        Wait-Label '计划' | Out-Null
    }

    Write-Host 'Starting isolated openGym API and checking device pairing'
    $apiOut = Join-Path $runDirectory 'api.log'
    $apiErr = Join-Path $runDirectory 'api-error.log'
    $apiData = Join-Path $runDirectory 'data'
    $server = Start-Process -FilePath $node -ArgumentList ('"{0}" "{1}"' -f $fixtureRunner, $apiData) `
        -WorkingDirectory $apiDirectory -WindowStyle Hidden -RedirectStandardOutput $apiOut -RedirectStandardError $apiErr -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    do {
        if ($server.HasExited) { throw 'The isolated API exited before it was ready.' }
        $startup = Select-String -LiteralPath $apiOut -Pattern 'gym-api on :(\d+)' | Select-Object -First 1
        if ($startup) { $reversePort = [int]$startup.Matches[0].Groups[1].Value; break }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    if (!$reversePort) { throw 'The isolated API did not report its listening port.' }

    $baseUrl = "http://127.0.0.1:$reversePort"
    $name = 'RN Regression'
    $routineName = 'Regression routine'
    $password = [guid]::NewGuid().ToString('N')
    $user = @{ name = $name; password = $password } | ConvertTo-Json -Compress
    Invoke-RestMethod "$baseUrl/api/register/password" -Method Post -ContentType 'application/json' `
        -Body $user -SessionVariable apiSession -TimeoutSec 10 | Out-Null
    $fixtureExercise = @{ id = '0025'; sets = 1; reps = 8; weight = 25 }
    if ($FeatureChecks) {
        $fixtureExercise.sets = 2
        $fixtureExercise.restSec = 45
        $fixtureExercise.warmupSets = 1
        $fixtureExercise.subs = @('0047')
    }
    $state = @{ unit = 'kg'; restSec = 60; routines = @(@{ id = 'rn-regression'; name = $routineName; ex = @(
        $fixtureExercise
    ) }); workouts = @() }
    Invoke-RestMethod "$baseUrl/api/data" -Method Put -ContentType 'application/json' -WebSession $apiSession `
        -Body (@{ state = $state; baseRev = 0 } | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec 10 | Out-Null
    $pairing = Invoke-RestMethod "$baseUrl/api/pair/create" -Method Post -ContentType 'application/json' -WebSession $apiSession `
        -Body (@{ current = $password } | ConvertTo-Json -Compress) -TimeoutSec 10
    if ($pairing.code -notmatch '^[A-Z0-9]+$') { throw 'The isolated API did not return a pairing code.' }

    Add-Reverse $reversePort
    Open-Settings
    Tap-Label '服务器地址' -Field
    Invoke-Adb shell input text $baseUrl | Out-Null
    Tap-Label '配对码' -Field -Scroll
    Invoke-Adb shell input text $pairing.code | Out-Null
    Tap-Label '连接服务器' -Scroll
    Wait-Node { $_.GetAttribute('text') -like "*$name*" } 'Paired account' | Out-Null
    Open-PlanList
    Wait-Label $routineName | Out-Null
    Start-Routine $routineName

    Write-Host 'Checking offline completion, reconnect and duplicate prevention'
    Remove-Reverse
    Tap-Label '第 1 组完成'
    Wait-Label '已完成 1 组' | Out-Null
    if ($FeatureChecks) {
        Tap-Label '删除第 2 组'
        Tap-Label '添加正式组' -Scroll
        Wait-Label '第 2 组完成' | Out-Null
        $seconds = Get-RestSeconds
        if ($seconds -le 0 -or $seconds -gt 45) { throw 'The exercise rest should override the profile default.' }
        Tap-Label '热身第 1 组完成'
        Wait-Label '已完成 2 组' | Out-Null
    }
    Finish-ToStats
    $offlineState = Invoke-RestMethod "$baseUrl/api/data" -WebSession $apiSession -TimeoutSec 10
    if ($offlineState.state.workouts.Count -ne 0) { throw 'The workout reached the API while the emulator was offline.' }
    Wait-Node {
        $_.GetAttribute('text') -eq '待同步' -or $_.GetAttribute('content-desc') -like '*待同步*'
    } 'Offline workout pending sync' | Out-Null

    Add-Reverse $reversePort
    Open-Settings
    Tap-Label '立即同步' -Scroll
    Wait-Node { $_.GetAttribute('text') -like '0 条待同步*' } 'Sync queue is empty' | Out-Null
    $firstSync = (Invoke-RestMethod "$baseUrl/api/data" -WebSession $apiSession -TimeoutSec 10).state.workouts
    $savedSets = $firstSync[0].entries[0].sets
    $workingSets = @($savedSets | Where-Object { $_.phase -ne 'warmup' })
    if ($firstSync.Count -ne 1 -or !$firstSync[0].id -or $workingSets.Count -ne 1 -or $workingSets[0].w -ne 25 -or $workingSets[0].r -ne 8) {
        throw 'The server did not receive exactly one 25 kg × 8 workout.'
    }
    if ($FeatureChecks -and ($savedSets.Count -ne 2 -or $savedSets[0].phase -ne 'warmup' -or $firstSync[0].vol -ne 200)) {
        throw 'The synced workout should preserve the warm-up phase and count only work volume by default.'
    }
    Tap-Label '立即同步'
    Wait-Label '立即同步' -Enabled | Out-Null
    $nextSync = (Invoke-RestMethod "$baseUrl/api/data" -WebSession $apiSession -TimeoutSec 10).state.workouts
    if ($nextSync.Count -ne 1 -or $nextSync[0].id -ne $firstSync[0].id) { throw 'Repeated sync changed the stored workout list.' }
    Scroll-ToTop
    Tap-Label '返回'
    Open-Stats
    Tap-Workout $routineName
    if ($FeatureChecks) {
        Wait-Node { $_.GetAttribute('text') -like '热身 * · 25 kg × 8' } 'Warm-up and work in history' | Out-Null

        Write-Host 'Checking planned backup exercise and saved exercise identity'
        Open-PlanList
        Start-Routine $routineName
        Tap-Label '替换为 杠铃上斜卧推'
        Wait-Label '杠铃上斜卧推' | Out-Null
        Tap-Label '替换为 杠铃卧推'
        Wait-Label '杠铃卧推' | Out-Null
        Tap-Label '替换为 杠铃上斜卧推'
        Wait-Label '热身第 1 组完成' | Out-Null
        Wait-Label '第 2 组完成' | Out-Null
        Wait-Node { $_.GetAttribute('content-desc') -eq '第 1 组次数' -and $_.GetAttribute('text') -eq '8' } 'Backup kept 8 planned reps' | Out-Null
        Wait-Node { $_.GetAttribute('content-desc') -eq '第 1 组重量' -and $_.GetAttribute('text') -eq '0' } 'Backup did not inherit bench weight' | Out-Null
        Tap-Label '第 1 组完成'
        Wait-Label '已完成 1 组' | Out-Null
        Finish-ToStats
        Open-Settings
        Tap-Label '立即同步' -Scroll
        Wait-Node { $_.GetAttribute('text') -like '0 条待同步*' } 'Backup workout synced' | Out-Null
        $backupState = (Invoke-RestMethod "$baseUrl/api/data" -WebSession $apiSession -TimeoutSec 10).state
        $backupWorkout = @($backupState.workouts | Where-Object id -ne $firstSync[0].id)
        if ($backupState.workouts.Count -ne 2 -or $backupWorkout.Count -ne 1) {
            throw 'Expected one original workout and one backup workout.'
        }
        $entry = $backupWorkout[0].entries[0]
        if ($entry.id -ne '0047' -or $entry.sets[0].r -ne 8 -or $entry.target.sets -ne 2) {
            throw 'The backup workout should record the actual exercise with the original planned sets and reps.'
        }
        $slot = $backupState.routines[0].ex[0]
        if ($slot.id -ne '0025' -or $slot.subs[0] -ne '0047' -or $slot.sets -ne 2 -or $slot.reps -ne 8) {
            throw 'The planned slot and its backup should stay unchanged on the server.'
        }
        Scroll-ToTop
        Tap-Label '返回'
        Open-Stats
        Tap-Workout $routineName
        Wait-Label '杠铃上斜卧推' | Out-Null
    } else {
        Wait-Label '25 kg × 8' | Out-Null
    }

    if ($P1Checks) {
        Write-Host 'Checking exercise history, offline correction, concurrent profile changes and deletion'
        Tap-ExerciseHistory
        Wait-Label '动作历史' | Out-Null
        Tap-Label '返回'
        Tap-Label '训练操作' -Scroll
        Tap-Label '编辑训练'
        Remove-Reverse
        Set-Field '训练名称' 'Corrected session'
        Set-Field '训练日期' '2024-03-11'
        Set-Field '次数' '9'
        Tap-Label '保存训练修改' -Scroll
        Wait-Workout 'Corrected session'
        $other = Get-ApiData
        $other.state.routines[0].name = 'Edited on web'
        Invoke-RestMethod "$baseUrl/api/data" -Method Put -ContentType 'application/json' -WebSession $apiSession `
            -Body (@{ state = $other.state; baseRev = $other.rev; baseWid = $other.state._wid } | ConvertTo-Json -Depth 30 -Compress) -TimeoutSec 10 | Out-Null
        Add-Reverse $reversePort
        $edited = Sync-App
        $corrected = $edited.workouts | Where-Object name -eq 'Corrected session'
        if (!$corrected -or $corrected.d -ne '2024-03-11' -or $corrected.entries[0].sets[0].r -ne 9 -or
            $edited.routines[0].name -ne 'Edited on web') {
            throw 'Offline history correction failed to preserve the web change.'
        }
        Open-Stats
        Tap-Workout 'Corrected session'
        Tap-Label '训练操作' -Scroll
        Tap-Label '删除训练'
        Tap-Label '删除'
        $afterDelete = Sync-App
        if ($afterDelete.workouts.id -contains $corrected.id -or !$afterDelete.deleted.workouts.$($corrected.id)) {
            throw 'Deleted workout still present or missing its tombstone.'
        }
        Write-Output 'PASS P1: exercise history and offline history correction/deletion.'

        Write-Host 'Checking custom exercise, catalogue search and plan scheduling'
        Open-PlanList
        Tap-Label '新训练日'
        Set-Field '计划名称' 'Mixed training'
        Tap-Label '添加计划动作'
        Tap-Label '创建自定义动作'
        Set-Field '动作名称' 'Sample hold'
        Tap-Label '保存'
        Tap-Label '编辑 Sample hold' -Scroll
        Set-Field '动作名称' 'QA Hold'
        Tap-Label '保存'
        Tap-Label '选择 QA Hold'
        Tap-Label '计时'
        Set-Field '组数' '1'
        Set-Field '秒' '32'
        Set-Field '重量' '12.5'
        Tap-Label '添加计划动作' -Scroll
        Set-Field '搜索动作' 'treadmill'
        Tap-Label '选择 跑步机跑步'
        # Both cards stay expanded after adding an exercise; collapse the timed one so "组数"
        # targets the cardio slot instead of the first visible field.
        Scroll-ToTop
        Tap-Label '收起QA Hold' -Scroll
        Set-Field '组数' '1' -Scroll
        Set-Field '分钟' '7.5' -Scroll
        Set-Field '速度' '9.2' -Scroll
        Scroll-ToTop
        Tap-Label '返回'
        $program = Sync-App
        $mixed = $program.routines | Where-Object name -eq 'Mixed training'
        if ($mixed.ex.Count -ne 2 -or $program.customEx[0].n -ne 'QA Hold' -or $mixed.ex[0].id -ne $program.customEx[0].id -or
            $mixed.ex[0].sec -ne 32 -or $mixed.ex[0].sets -ne 1 -or $mixed.ex[0].weight -ne 12.5 -or
            $mixed.ex[1].min -ne 7.5 -or $mixed.ex[1].speed -ne 9.2) {
            throw 'The plan or custom exercise did not round-trip to the API.'
        }
        Open-PlanList
        Tap-Label '训练排程'
        Tap-Label 'Mixed training'
        Tap-Label '保存当天排程' -Scroll
        Wait-Label 'Mixed training' | Out-Null
        Open-Home
        Wait-Label '今日训练' -Scroll | Out-Null
        Wait-Label 'Mixed training' -Scroll | Out-Null
        Open-PlanList
        Tap-Label '训练排程'
        Tap-Label '轮换'
        Tap-Label 'Mixed training'
        Tap-Label 'Edited on web'
        Tap-Label '保存轮换' -Scroll
        Wait-Label 'Mixed training' | Out-Null
        $schedule = Sync-App
        $weekday = $schedule.week.PSObject.Properties | Where-Object { $_.Value -contains $mixed.id }
        if ($schedule.scheduleMode -ne 'rotation' -or $schedule.rotation.sequence[0] -ne $mixed.id -or
            $schedule.rotation.sequence[1] -ne 'rn-regression' -or !$weekday) {
            throw 'Weekday or rotation order failed to round-trip.'
        }

        Write-Host 'Checking cardio and timed training history with the isolated API'
        Open-PlanList
        Start-Routine 'Mixed training'
        Tap-Label '第 1 组完成'
        Wait-Label '已完成 1 组' | Out-Null
        $cardioSet = Wait-Node { $_.GetAttribute('content-desc') -eq '第 1 组完成' -and $_.GetAttribute('checked') -eq 'false' } 'Incomplete cardio set' -Scroll
        Tap-Node $cardioSet 'Incomplete cardio set'
        Finish-ToStats
        Tap-Workout 'Mixed training'
        Wait-Label '32 秒 · 12.5 kg' | Out-Null
        Wait-Label '7.5 分钟 · 速度 9.2' -Scroll | Out-Null
        $mixedLog = (Sync-App).workouts | Where-Object name -eq 'Mixed training'
        if ($mixedLog.entries[0].sets[0].sec -ne 32 -or $mixedLog.entries[0].sets[0].w -ne 12.5 -or
            $mixedLog.entries[1].sets[0].min -ne 7.5 -or $mixedLog.entries[1].sets[0].speed -ne 9.2) {
            throw 'Timed/cardio sets were not persisted as recorded.'
        }
        Open-Home
        Wait-Label '今日训练' -Scroll | Out-Null
        Wait-Label 'Edited on web' -Scroll | Out-Null
        Open-PlanList
        Write-Output 'PASS P1: custom exercise versions, catalogue search, weekday/rotation and recommendation, timed/cardio history and sync.'

        Write-Host 'Checking plan edits, deletion, freestyle, arbitrary substitution and backfill'
        Open-PlanEditor 'Mixed training'
        Set-Field '计划名称' 'Revised plan'
        Scroll-ToTop
        Tap-Label '返回'
        $revised = (Sync-App).routines | Where-Object id -eq $mixed.id
        if ($revised.name -ne 'Revised plan' -or $revised.ex.Count -ne 2) { throw 'Plan edits did not sync.' }
        Tap-PlanAction 'Revised plan' '删除计划'
        Tap-Label '删除'
        $withoutPlan = Sync-App
        if ($withoutPlan.routines.id -contains $mixed.id -or $withoutPlan.rotation.sequence -contains $mixed.id) {
            throw 'Deleted plan or its rotation reference remains.'
        }
        # Start from the library so a single recommended rotation day cannot bypass the start
        # sheet and auto-start a planned workout instead.
        Tap-Label '动作库'
        Wait-Label '动作库' | Out-Null
        Tap-Label '选择 QA Hold' -Scroll
        Wait-Label '完成训练' | Out-Null
        Tap-Label '搜索替换动作' -Scroll
        Set-Field '搜索动作' 'barbell bench press'
        Tap-Label '选择 杠铃卧推'
        Wait-Label '杠铃卧推' | Out-Null
        Tap-Label '第 1 组完成'
        Finish-ToStats
        $free = (Sync-App).workouts | Where-Object name -eq '自由训练'
        if ($free.routineId -or $free.entries[0].id -ne '0025') { throw 'Freestyle replacement was not saved.' }
        Open-Stats
        Tap-Label '补录训练'
        Tap-Label '添加动作' -Scroll
        Tap-Label '选择 QA Hold'
        Wait-Label '完成训练' | Out-Null
        Set-Field '补录名称' 'Backfilled session'
        Set-Field '补录日期' '2024-03-12'
        Tap-Label '第 1 组完成' -Scroll
        Tap-Label '完成训练' -Scroll
        Wait-Stats
        $backfill = (Sync-App).workouts | Where-Object name -eq 'Backfilled session'
        if ($backfill.d -ne '2024-03-12' -or !$backfill.start -or $backfill.entries[0].sets[0].at -gt $backfill.end) {
            throw 'Backfilled workout did not retain the past date and set timestamp.'
        }
        Write-Output 'PASS P1: plan update/deletion, arbitrary exercise substitution, freestyle and backfilled history.'

        Write-Host 'Checking device notification permission and rest expiration on the locked emulator'
        $shortRest = Get-ApiData
        $shortRest.state.routines[0].ex[0] | Add-Member -NotePropertyName restSec -NotePropertyValue 12 -Force
        $shortRest.state.routines[0].ex[0].sets = 2
        Invoke-RestMethod "$baseUrl/api/data" -Method Put -ContentType 'application/json' -WebSession $apiSession `
            -Body (@{ state = $shortRest.state; baseRev = $shortRest.rev; baseWid = $shortRest.state._wid } | ConvertTo-Json -Depth 30 -Compress) -TimeoutSec 10 | Out-Null
        Sync-App | Out-Null
        Open-Settings
        Tap-Switch '组间休息通知'
        $notificationPermission = {
            $_.GetAttribute('resource-id') -like '*:id/permission_allow_button' -or
                ($_.GetAttribute('content-desc') -eq '组间休息通知' -and $_.GetAttribute('checked') -eq 'true')
        }
        Wait-Node $notificationPermission 'Android notification permission' -System | Out-Null
        foreach ($attempt in 1..3) {
            Start-Sleep -Milliseconds 500
            $choice = Wait-Node $notificationPermission 'Android notification permission' -System
            if ($choice.GetAttribute('content-desc') -eq '组间休息通知') { break }
            Tap-Node $choice 'Allow notifications'
        }
        Wait-Label '闹钟与提醒设置' -Scroll | Out-Null
        Invoke-Adb shell appops set $appId SCHEDULE_EXACT_ALARM allow | Out-Null
        Scroll-ToTop
        Tap-Label '返回'
        Wait-Label '首页' | Out-Null
        Open-PlanList
        Start-Routine 'Regression routine'
        Tap-Label '第 1 组完成'
        Invoke-Adb shell input keyevent KEYCODE_SLEEP | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(25)
        $notification = $null
        do {
            $notification = Invoke-Adb shell dumpsys notification --noredact | Select-String "NotificationRecord.*pkg=$appId.*channel=rest-timer"
            if ($notification) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
        Invoke-Adb shell input keyevent KEYCODE_WAKEUP | Out-Null
        Invoke-Adb shell wm dismiss-keyguard | Out-Null
        if (!$notification) { throw 'Rest expiry notification was not posted while the emulator was locked.' }
        Tap-Label '放弃训练' -Scroll
        Tap-Label '放弃'
        Write-Output 'PASS P1: local rest notification posted while the emulator was locked.'

        Write-Host 'Checking local practice merge, backup file import and export share sheet'
        Open-Settings
        Tap-Label '合并本机练习' -Scroll
        Tap-Label '合并'
        Confirm-MergeResult
        Wait-Label '设置' | Out-Null
        Scroll-ToTop
        Tap-Label '返回'
        Wait-Label '首页' | Out-Null
        $merged = Sync-App
        if (($merged.workouts | Where-Object name -eq '全身力量 A').entries[0].sets[0].w -ne 37.5) {
            throw 'Practice workout was not merged into the paired account.'
        }
        $backup = Join-Path $runDirectory ([IO.Path]::GetFileName($remoteBackup))
        $backupState = @{ unit = 'lb'; workouts = @(@{ id = 'rn-backup-fixture'; name = 'Restored file'; d = '2024-03-10';
            start = 1710072000000L; end = 1710072600000L; entries = @(@{ id = '0025'; sets = @(@{ w = 100; r = 5; done = $true }) }) }) }
        $backupState | ConvertTo-Json -Depth 10 -Compress | Set-Content -LiteralPath $backup -Encoding utf8
        Invoke-Adb push $backup $remoteBackup | Out-Null
        Invoke-Adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://$remoteBackup" | Out-Null
        foreach ($attempt in 1..2) {
            Open-Settings
            Tap-Label '恢复备份' -Scroll
            $fileName = [IO.Path]::GetFileName($remoteBackup)
            Tap-SystemLabel $fileName
            Tap-Label '合并'
            Confirm-MergeResult
            Wait-Label '设置' | Out-Null
            Scroll-ToTop
            Tap-Label '返回'
            Wait-Label '首页' | Out-Null
            $restored = @( (Sync-App).workouts | Where-Object id -eq 'rn-backup-fixture' )
            if ($restored.Count -ne 1 -or $restored[0].entries[0].sets[0].w -ne 45.36) {
                throw 'Backup import did not convert pounds or avoid duplicate records.'
            }
        }
        Open-Settings
        Tap-Label '导出备份' -Scroll
        Wait-Node { $_.GetAttribute('package') -match '(intentresolver|systemui)' -and
            $_.GetAttribute('text') -match 'openGym-.*\.json|Bluetooth|Quick Share' } 'Android JSON sharing' -System | Out-Null
        Invoke-Adb shell input keyevent KEYCODE_BACK | Out-Null
        Wait-Label '设置' | Out-Null
        Scroll-ToTop
        Tap-Label '返回'
        Wait-Label '首页' | Out-Null
        Write-Output 'PASS P1: practice merge, Android file restore with unit conversion/deduplication, and backup sharing.'
    }
    if ($SupersetChecks) {
        Write-Host 'Checking superset pairing, unequal rounds, restart and history'
        $supersetPlan = 'Superset fixture'
        $fixture = Get-ApiData
        $fixture.state.routines = @($fixture.state.routines) + @(@{ id = 'rn-superset'; name = $supersetPlan; ex = @(
            @{ id = '0025'; sets = 2; reps = 8; weight = 25; restSec = 25 }
            @{ id = '0047'; sets = 1; reps = 8; weight = 20; restSec = 40; subs = @('1323') }
        ) })
        Invoke-RestMethod "$baseUrl/api/data" -Method Put -ContentType 'application/json' -WebSession $apiSession `
            -Body (@{ state = $fixture.state; baseRev = $fixture.rev; baseWid = $fixture.state._wid } | ConvertTo-Json -Depth 30 -Compress) -TimeoutSec 10 | Out-Null
        Sync-App | Out-Null
        Open-PlanEditor $supersetPlan
        Tap-Label '展开杠铃上斜卧推' -Scroll
        Tap-Label '与上一动作组成超级组' -Scroll
        Tap-Label '移出超级组' -Scroll
        Tap-Label '与上一动作组成超级组' -Scroll
        Scroll-ToTop
        Set-Field '超级组名称' 'Push pair' -Scroll
        Set-Field '轮间休息秒数' '73' -Scroll
        Scroll-ToTop
        Tap-Label '返回'
        $paired = (Sync-App).routines | Where-Object id -eq 'rn-superset'
        $group = $paired.ex[0].sg
        if (!$group -or $paired.ex[1].sg -ne $group -or $paired.ex[0].sgName -ne 'Push pair' -or
            $paired.ex[1].sgName -ne 'Push pair' -or $paired.ex[1].sgRest -ne 73) {
            throw 'The server did not retain all superset plan fields.'
        }
        Open-PlanList
        Start-Routine $supersetPlan
        # Use the workout exercise ActionSheet, not only the card buttons.
        Tap-Label '杠铃卧推菜单' -Scroll
        Tap-Label '移出超级组'
        Tap-Label '杠铃上斜卧推菜单' -Scroll
        Tap-Label '与上一动作组成超级组'
        Tap-Label '放弃训练' -Scroll
        Tap-Label '放弃'
        Wait-Label '计划' | Out-Null
        Start-Routine $supersetPlan
        Wait-Label '超级组 · Push pair' -Scroll | Out-Null
        Wait-Label '第 1 轮 · 下一组 杠铃卧推' -Scroll | Out-Null
        if ((Wait-Label '杠铃卧推 第 2 组完成').GetAttribute('enabled') -ne 'false') {
            throw 'A future round could be completed before its turn.'
        }
        # Replace the second member before logging it; the group and its rest must survive.
        Tap-Label '替换为 绳索绳把坐姿划船' -Scroll
        Wait-Label '绳索绳把坐姿划船' | Out-Null
        Scroll-ToTop
        Wait-Label '超级组 · Push pair' -Scroll | Out-Null
        Tap-Label '杠铃卧推 第 1 组完成'
        Wait-Label '第 1 轮 · 下一组 绳索绳把坐姿划船' -Scroll | Out-Null
        if ((Read-Ui).SelectSingleNode("//node[@text='组间休息']")) { throw 'An intra-round switch started a rest.' }
        Invoke-Adb shell am force-stop $appId | Out-Null
        Start-App
        Wait-Label '第 1 轮 · 下一组 绳索绳把坐姿划船' -Scroll | Out-Null
        Tap-Label '绳索绳把坐姿划船 第 1 组完成'
        Wait-Label '第 2 轮 · 下一组 杠铃卧推' -Scroll | Out-Null
        $rest = Get-RestSeconds
        if ($rest -lt 69 -or $rest -gt 73) { throw 'Round rest ignored the 73-second group override.' }
        Start-Sleep -Seconds 3
        $remaining = Get-RestSeconds
        $drop = $rest - $remaining
        if ($drop -lt 2 -or $drop -gt 5) { throw 'The 73-second round rest did not count down in real time.' }
        Write-Output "VERIFIED: group round rest read ${rest}s and dropped ${drop}s in three seconds."
        Tap-Label '取消休息'
        Tap-Label '杠铃卧推 第 2 组完成'
        Wait-Node { $_.GetAttribute('content-desc') -eq '杠铃卧推 第 2 组完成' -and $_.GetAttribute('checked') -eq 'true' } 'Last superset set completed' | Out-Null
        if ((Read-Ui).SelectSingleNode("//node[@text='组间休息']")) { throw 'The last set of the workout started a rest.' }
        Finish-ToStats
        Tap-Workout $supersetPlan
        Wait-Label '超级组 · Push pair' | Out-Null
        $savedSuperset = (Sync-App).workouts | Where-Object name -eq $supersetPlan
        if ($savedSuperset.entries.Count -ne 2 -or $savedSuperset.entries[0].id -ne '0025' -or $savedSuperset.entries[1].id -ne '1323' -or
            $savedSuperset.entries[0].sets.Count -ne 2 -or $savedSuperset.entries[1].sets.Count -ne 1 -or
            $savedSuperset.entries[0].sg -ne $group -or $savedSuperset.entries[1].sg -ne $group -or
            $savedSuperset.entries[1].target.sgName -ne 'Push pair' -or $savedSuperset.entries[1].target.sgRest -ne 73 -or
            $savedSuperset.entries[1].target.subs[0] -ne '0047') {
            throw 'Superset history omitted the replacement identity, member order, group metadata or set counts.'
        }
        if ($paired.ex[1].id -ne '0047' -or $paired.ex[1].subs[0] -ne '1323') {
            throw 'The planned superset slot changed when its workout member was replaced.'
        }
        Write-Output 'PASS P2: grouping and unlinking in plan and workout, unequal rounds, restart, group rest, member replacement identity and stored superset history.'
    }
    $passed = $true
    Write-Output 'PASS: offline practice, draft and history after restart, pairing, offline queue, reconnect and duplicate prevention.'
    if ($FeatureChecks) { Write-Output 'PASS: countdown, weight prefill, set changes, warm-ups and planned backup exercises.' }
} catch {
    try {
        Read-Ui | Out-Null
        Invoke-Adb shell screencap -p $remoteScreenshot | Out-Null
        Invoke-Adb pull $remoteScreenshot (Join-Path $runDirectory 'screen.png') | Out-Null
        Invoke-Adb logcat -d -t 300 | Set-Content -LiteralPath (Join-Path $runDirectory 'logcat.txt') -Encoding utf8
    } catch {
        Write-Warning "Could not capture all emulator diagnostics: $_"
    }
    Write-Warning "Regression diagnostics: $runDirectory"
    throw
} finally {
    if ($reverseInstalled) {
        try { Remove-Reverse } catch { Write-Warning "Could not remove the regression port mapping: $_" }
    }
    if ($server -and !$server.HasExited) {
        Stop-Process -InputObject $server -ErrorAction SilentlyContinue
        $server.WaitForExit(5000) | Out-Null
    }
    try {
        Invoke-Adb shell rm -f $remoteDumper $remoteUi $remoteScreenshot $remoteBackup | Out-Null
        $cleanup = if ($passed) { $runDirectory } else { Join-Path $runDirectory 'data' }
        if (Test-Path -LiteralPath $cleanup) {
            $resolved = (Resolve-Path -LiteralPath $cleanup).Path
            if ($resolved -eq $runDirectory -or $resolved -eq (Join-Path $runDirectory 'data')) {
                Remove-Item -LiteralPath $resolved -Recurse -Force
            }
        }
    } catch { Write-Warning "Could not fully clean up the regression fixture: $_" }
}
