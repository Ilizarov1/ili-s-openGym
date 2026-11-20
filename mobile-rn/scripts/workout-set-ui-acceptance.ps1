#requires -Version 7.0
<#
.SYNOPSIS
    Android acceptance for the workout set-row and drop-set change (V01-V11).

.DESCRIPTION
    Drives the dedicated Debug emulator with the UI fixture and screenshots:
      V01 narrow table row, direct weight/reps entry, invalid-input fallback
      V02 rating column, stored scale, warm-up slot, mixed/off scales
      V03 exercise vs set menus, search/replace lock
      V04 warm-up conversion, copy, delete, rest-dock remap
      V05 drop-set sheet create/cancel/validation/save and auto-expand
      V06 quick add, edit/delete segments, revert to a plain set
      V07 ordered per-segment completion, focus layout, single rest, undo
      V08 drop set inside a superset round
      V09 legacy drafts, restart recovery, undo-rest isolation
      V10 finish/history projection and API sync (optional)
      V11 legacy rest-pause compatibility

    Evidence is written to mobile-rn/dist/workout-set-ui/acceptance.
#>
[CmdletBinding()]
param(
    [string]$Apk = (Join-Path $PSScriptRoot '..\android\app\build\outputs\apk\debug\app-debug.apk'),
    [ValidatePattern('^emulator-\d+$')][string]$Serial = 'emulator-5556',
    [string]$Adb,
    [string]$OutDir = (Join-Path $PSScriptRoot '..\dist\workout-set-ui\acceptance'),
    [ValidateSet('V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08', 'V09', 'V10', 'V11', 'All')]
    [string[]]$Case = @('All'),
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$appId = 'dev.opengym.rn'
$apkPath = (Resolve-Path -LiteralPath $Apk).Path
if (!$SkipInstall -and (![IO.File]::Exists($apkPath) -or [IO.Path]::GetExtension($apkPath) -ne '.apk')) {
    throw 'Supply the Debug APK file.'
}
if (!$Adb) {
    $candidates = @()
    if ($env:ANDROID_HOME) { $candidates += Join-Path $env:ANDROID_HOME 'platform-tools\adb.exe' }
    if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'RnToolchain\android-sdk\platform-tools\adb.exe' }
    $found = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (!$found) { $found = (Get-Command adb.exe).Source }
    $Adb = $found
}
$Adb = (Resolve-Path -LiteralPath $Adb).Path
$sdk = Split-Path (Split-Path $Adb)
$toolchainJdk = Join-Path $env:LOCALAPPDATA 'RnToolchain\jdk-17.0.21+9'
if (!$env:JAVA_HOME -and (Test-Path (Join-Path $toolchainJdk 'bin\javac.exe'))) {
    $env:JAVA_HOME = $toolchainJdk
}
$javac = if ($env:JAVA_HOME) {
    Join-Path $env:JAVA_HOME 'bin\javac.exe'
} elseif (Test-Path (Join-Path $toolchainJdk 'bin\javac.exe')) {
    Join-Path $toolchainJdk 'bin\javac.exe'
} else {
    (Get-Command javac.exe).Source
}
$platformJar = Join-Path $sdk 'platforms\android-36\android.jar'
$d8 = Join-Path $sdk 'build-tools\36.0.0\d8.bat'
$node = (Get-Command node.exe).Source
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$buildDirectory = Join-Path ([IO.Path]::GetTempPath()) "opengym-workout-set-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $buildDirectory | Out-Null
$uiFile = Join-Path $OutDir 'window.xml'
$remoteDumper = "/data/local/tmp/$([IO.Path]::GetFileName($buildDirectory)).dex"
$remoteUi = "/data/local/tmp/$([IO.Path]::GetFileName($buildDirectory)).xml"
$screenWidth = 1080
$screenHeight = 2400
$density = 420
$results = [System.Collections.Generic.List[object]]::new()

function Invoke-Adb {
    $output = & $Adb -s $Serial @args 2>&1
    if ($LASTEXITCODE -ne 0 -and ($output -join ' ') -match 'cannot connect to daemon|daemon still not running') {
        & $Adb start-server | Out-Null
        $output = & $Adb -s $Serial @args 2>&1
    }
    if ($LASTEXITCODE -ne 0) { throw "ADB failed: $($args -join ' ') on ${Serial}: $($output -join ' ')" }
    $output
}

function Read-Display {
    $size = (Invoke-Adb shell wm size | Select-Object -Last 1)
    if ($size -match '(\d+)x(\d+)') {
        $script:screenWidth = [int]$Matches[1]
        $script:screenHeight = [int]$Matches[2]
    }
    $d = Invoke-Adb shell wm density | Select-Object -Last 1
    if ($d -match '(\d+)') { $script:density = [int]$Matches[1] }
    $script:screenWidth, $script:screenHeight, $script:density | Out-Null
}

function Read-Ui {
    $dump = & $Adb -s $Serial shell "CLASSPATH=${remoteDumper}:/system/framework/uiautomator.jar" app_process /system/bin DumpActiveWindow $screenWidth $screenHeight $remoteUi 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    $pull = & $Adb -s $Serial pull $remoteUi $uiFile 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    $content = Get-Content -LiteralPath $uiFile -Raw -Encoding utf8
    if (!$content) { return $null }
    [xml]$content
}

function Test-VisibleBounds($Node) {
    $bounds = [regex]::Match($Node.GetAttribute('bounds'), '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
    $bounds.Success -and ([int]$bounds.Groups[3].Value - [int]$bounds.Groups[1].Value -ge 8) -and
        ([int]$bounds.Groups[4].Value - [int]$bounds.Groups[2].Value -ge 8)
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

function Wait-Id([string]$Id, [switch]$Scroll, [int]$Seconds = 20) {
    Wait-Node { $_.GetAttribute('resource-id') -eq $Id } "testID $Id" -Scroll:$Scroll -Seconds $Seconds
}

function Wait-Label([string]$Label, [switch]$Field, [switch]$Enabled, [switch]$Scroll) {
    Wait-Node {
        $description = $_.GetAttribute('content-desc')
        $matchesLabel = $description -eq $Label -or (!$Field -and $_.GetAttribute('text') -eq $Label)
        $matchesLabel -and (!$Enabled -or $_.GetAttribute('enabled') -eq 'true')
    } $Label -Scroll:$Scroll
}

function Wait-Text([string]$Text, [switch]$Scroll, [int]$Seconds = 25) {
    Wait-Node { $_.GetAttribute('text') -eq $Text } "text $Text" -Scroll:$Scroll -Seconds $Seconds
}

function Tap-Node($node, [string]$Label) {
    $bounds = [regex]::Match($node.GetAttribute('bounds'), '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
    if (!$bounds.Success) { throw "Missing screen bounds for $Label" }
    $x = [int](([int]$bounds.Groups[1].Value + [int]$bounds.Groups[3].Value) / 2)
    $y = [int](([int]$bounds.Groups[2].Value + [int]$bounds.Groups[4].Value) / 2)
    Invoke-Adb shell input tap $x $y | Out-Null
}

function Tap-Id([string]$Id, [switch]$Scroll) {
    Tap-Node (Wait-Id $Id -Scroll:$Scroll) $Id
}

function Tap-Label([string]$Label, [switch]$Field, [switch]$Scroll) {
    Tap-Node (Wait-Label $Label -Field:$Field -Enabled -Scroll:$Scroll) $Label
}

function Tap-Text([string]$Text, [switch]$Scroll) {
    Tap-Node (Wait-Text $Text -Scroll:$Scroll) $Text
}

function Scroll-ToTop {
    $x = [int]($screenWidth / 2)
    $fromY = [int]($screenHeight * 0.55)
    $toY = [int]($screenHeight * 0.92)
    1..4 | ForEach-Object { Invoke-Adb shell input swipe $x $fromY $x $toY 200 | Out-Null }
}

function Hide-Keyboard {
    # ENTER on a single-line field blurs it and hides the IME without Android Back,
    # which would collapse a workout or close a sheet. Check the IME state first and
    # fall back to Back only if the keyboard really is still up.
    $ime = Invoke-Adb shell dumpsys input_method | Select-String -Pattern 'mInputShown=true|mIsInputViewShown=true'
    if (!$ime) { return }
    Invoke-Adb shell input keyevent 66 | Out-Null
    Start-Sleep -Milliseconds 300
    $ime = Invoke-Adb shell dumpsys input_method | Select-String -Pattern 'mInputShown=true|mIsInputViewShown=true'
    if ($ime) {
        Invoke-Adb shell input keyevent 4 | Out-Null
        Start-Sleep -Milliseconds 300
    }
}

function Set-Field([string]$Id, [string]$Value) {
    Tap-Id $Id
    Invoke-Adb shell input keycombination 113 29 | Out-Null
    Invoke-Adb shell input keyevent 67 | Out-Null
    Invoke-Adb shell input text $Value | Out-Null
    Start-Sleep -Milliseconds 250
    Hide-Keyboard
    Wait-Node {
        $_.GetAttribute('resource-id') -eq $Id -and $_.GetAttribute('text') -eq $Value
    } "${Id}: $Value" | Out-Null
}

function Get-Text([string]$Id) {
    $node = Wait-Id $Id
    $node.GetAttribute('text')
}

function Get-Bounds([string]$Id) {
    $node = Wait-Id $Id
    $m = [regex]::Match($node.GetAttribute('bounds'), '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
    if (!$m.Success) { throw "No bounds for $Id" }
    [pscustomobject]@{
        Left = [int]$m.Groups[1].Value; Top = [int]$m.Groups[2].Value
        Right = [int]$m.Groups[3].Value; Bottom = [int]$m.Groups[4].Value
        Width = [int]$m.Groups[3].Value - [int]$m.Groups[1].Value
        Height = [int]$m.Groups[4].Value - [int]$m.Groups[2].Value
    }
}

function Assert-MinTouch([string[]]$Ids, [int]$Dp = 44) {
    $min = [int][math]::Floor($Dp * $density / 160) - 1
    foreach ($id in $Ids) {
        $b = Get-Bounds $id
        if ($b.Width -lt $min -or $b.Height -lt $min) {
            throw "$id is $($b.Width)x$($b.Height)px, expected at least ${min}px ($Dp dp at $density dpi)"
        }
    }
}

function Assert-RowAligned([string[]]$Ids) {
    $boxes = $Ids | ForEach-Object { Get-Bounds $_ }
    for ($i = 1; $i -lt $boxes.Count; $i++) {
        if ($boxes[$i].Left -le $boxes[$i - 1].Right) {
            throw "$($Ids[$i - 1]) and $($Ids[$i]) overlap horizontally"
        }
        $topDelta = [math]::Abs($boxes[$i].Top - $boxes[0].Top)
        if ($topDelta -gt 8) { throw "$($Ids[$i]) is not aligned with $($Ids[0]) (top delta $topDelta)" }
    }
}

function Assert-NoText([string]$Text, [string]$Context) {
    $ui = Read-Ui
    $node = $ui.SelectSingleNode("//node[@text='$Text']")
    if ($node) { throw "$Context unexpectedly contains $Text" }
}

function Assert-NoId([string]$Id, [string]$Context) {
    $ui = Read-Ui
    if ($ui.SelectSingleNode("//node[@resource-id='$Id']")) { throw "$Context unexpectedly contains $Id" }
}

function Assert-Rest([switch]$Absent) {
    $ui = Read-Ui
    $dock = $ui.SelectSingleNode("//node[@text='组间休息']")
    if ($Absent -and $dock) { throw 'A rest dock is visible but should not be' }
    if (!$Absent -and !$dock) { throw 'Expected a rest dock' }
}

function Hide-LogBox {
    try {
        $ui = Read-Ui
        if (!$ui) { return }
        $toast = $ui.SelectSingleNode("//node[starts-with(@content-desc,'!, Open debugger')]")
        if (!$toast) { return }
        $m = [regex]::Match($toast.GetAttribute('bounds'), '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
        if (!$m.Success) { return }
        $left, $top, $right, $bottom = 1..4 | ForEach-Object { [int]$m.Groups[$_].Value }
        $close = $ui.SelectNodes("//node[@clickable='true']") | Where-Object {
            $b = [regex]::Match($_.GetAttribute('bounds'), '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
            $b.Success -and
                [int]$b.Groups[1].Value -ge $left -and [int]$b.Groups[3].Value -le $right -and
                [int]$b.Groups[2].Value -ge $top -and [int]$b.Groups[4].Value -le $bottom -and
                ([int]$b.Groups[3].Value - [int]$b.Groups[1].Value) -lt 100
        } | Select-Object -First 1
        if ($close) { Tap-Node $close 'LogBox close' }
    } catch {
        # A warning toast is debug-only evidence noise, never an assertion.
    }
}

function Save-Screenshot([string]$Name) {
    Hide-LogBox
    $path = Join-Path $OutDir "$Name.png"
    $process = Start-Process -FilePath $Adb `
        -ArgumentList @('-s', $Serial, 'exec-out', 'screencap', '-p') `
        -RedirectStandardOutput $path -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -ne 0 -or -not (Test-Path $path) -or (Get-Item $path).Length -lt 1000) {
        throw "screenshot failed: $Name"
    }
    Write-Output "screenshot: $path"
}

function Save-Ui([string]$Name) {
    Read-Ui | Out-Null
    Copy-Item -LiteralPath $uiFile -Destination (Join-Path $OutDir "$Name.xml") -Force
}

function Install-Db([string]$Db) {
    Invoke-Adb shell am force-stop $appId | Out-Null
    Invoke-Adb push $Db /data/local/tmp/opengym-rn.db | Out-Null
    Invoke-Adb shell run-as $appId mkdir '-p' databases | Out-Null
    Invoke-Adb shell run-as $appId mkdir '-p' files/SQLite | Out-Null
    Invoke-Adb shell run-as $appId cp /data/local/tmp/opengym-rn.db databases/opengym-rn.db | Out-Null
    Invoke-Adb shell run-as $appId cp /data/local/tmp/opengym-rn.db files/SQLite/opengym-rn.db | Out-Null
    Invoke-Adb shell run-as $appId rm '-f' databases/opengym-rn.db-wal databases/opengym-rn.db-shm | Out-Null
    Invoke-Adb shell run-as $appId rm '-f' files/SQLite/opengym-rn.db-wal files/SQLite/opengym-rn.db-shm | Out-Null
    Invoke-Adb shell rm -f /data/local/tmp/opengym-rn.db | Out-Null
}

function New-BaseFixture([string]$Name = 'opengym-rn.db') {
    $db = Join-Path $OutDir $Name
    & $node (Join-Path $PSScriptRoot 'make-ui-fixture.mjs') $db | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }
    $db
}

function Start-Clean([string]$FixtureScenario = '') {
    Invoke-Adb shell am force-stop $appId | Out-Null
    Invoke-Adb shell pm clear $appId | Out-Null
    if ($FixtureScenario) {
        $base = New-BaseFixture 'opengym-rn-base.db'
        $draft = Join-Path $OutDir "opengym-rn-$FixtureScenario.db"
        & $node (Join-Path $PSScriptRoot 'workout-set-ui-fixture.mjs') $base $draft $FixtureScenario | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'draft fixture generation failed' }
        Install-Db $draft
    } else {
        Install-Db (New-BaseFixture)
    }
    Invoke-Adb shell monkey -p $appId -c android.intent.category.LAUNCHER 1 | Out-Null
    if ($FixtureScenario) {
        Wait-Node { $_.GetAttribute('content-desc') -eq '完成训练' -or $_.GetAttribute('text') -eq '完成训练' } 'Draft workout screen' -Seconds 90 | Out-Null
    } else {
        Wait-Node { $_.GetAttribute('text') -eq '首页' } 'Home screen' -Seconds 90 | Out-Null
    }
    Hide-LogBox
}

function Open-Workout([string]$Routine) {
    Invoke-Adb shell "am start -W -a android.intent.action.VIEW -d 'opengym://workout?e2e=1\&routine=$Routine'" | Out-Null
    Wait-Node { $_.GetAttribute('content-desc') -eq '完成训练' -or $_.GetAttribute('text') -eq '完成训练' } "Workout $Routine" -Seconds 60 | Out-Null
    Start-Sleep -Milliseconds 500
    Hide-LogBox
}

function Set-Display([int]$WidthDp, [int]$HeightDp, [int]$Dpi) {
    Invoke-Adb shell wm size "$($WidthDp * $Dpi / 160)x$([int]($HeightDp * $Dpi / 160))" | Out-Null
    Invoke-Adb shell wm density $Dpi | Out-Null
    Start-Sleep -Seconds 3
    Read-Display
}

function Reset-Display {
    Invoke-Adb shell wm size reset | Out-Null
    Invoke-Adb shell wm density reset | Out-Null
    Invoke-Adb shell settings put system font_scale 1.0 | Out-Null
    Start-Sleep -Seconds 3
    Read-Display
}

function Restart-App {
    Invoke-Adb shell am force-stop $appId | Out-Null
    Invoke-Adb shell monkey -p $appId -c android.intent.category.LAUNCHER 1 | Out-Null
    Wait-Node { $_.GetAttribute('content-desc') -eq '完成训练' -or $_.GetAttribute('text') -eq '首页' } 'App after restart' -Seconds 90 | Out-Null
}

function Complete-DropSet([int]$Exercise, [int]$Set, [int]$Segments) {
    Tap-Id "set-expand-$Exercise-$Set"
    Tap-Id "set-main-done-$Exercise-$Set"
    for ($i = 0; $i -lt $Segments - 1; $i++) {
        Tap-Id "drop-done-$Exercise-$Set-$i"
    }
}

function Ensure-RowExpanded([int]$Exercise, [int]$Set) {
    $ui = Read-Ui
    if ($ui -and $ui.SelectSingleNode("//node[@resource-id='drop-done-$Exercise-$Set-0']")) { return }
    Tap-Id "set-expand-$Exercise-$Set"
    Start-Sleep -Milliseconds 400
}

function Open-SetMenu([int]$Exercise, [int]$Set) {
    Tap-Id "set-menu-$Exercise-$Set"
    Wait-Node { $_.GetAttribute('content-desc') -in @('复制这一组', '删除这一组', '设为热身组', '改为正式组', '编辑分段') } 'Set action sheet' | Out-Null
}

function Step([string]$Text) {
    Write-Output "  > $Text"
}

function Record([string]$Id, [string]$Status, [string]$Detail) {
    $results.Add([pscustomobject]@{ Id = $Id; Status = $Status; Detail = $Detail })
    Write-Output "$Id [$Status] $Detail"
}

function Invoke-Case([string]$Id, [scriptblock]$Body) {
    try {
        & $Body
        Record $Id 'PASS' 'all assertions passed'
    } catch {
        Save-Screenshot "$Id-failure" | Out-Null
        Save-Ui "$Id-failure" | Out-Null
        Record $Id 'FAIL' $_.Exception.Message
    }
}

function Case-V01 {
    Reset-Display
    Set-Display 320 692 320
    Start-Clean
    Open-Workout 'fixture-upper'
    Save-Screenshot 'v01-320-cards'
    Save-Ui 'v01-320-cards'
    Assert-RowAligned @(
        'set-weight-0-0-input', 'set-reps-0-0-input', 'set-rating-0-0', 'set-done-0-0', 'set-menu-0-0'
    )
    Assert-MinTouch @('set-weight-0-0-input', 'set-reps-0-0-input', 'set-rating-0-0', 'set-done-0-0')
    # The row menu is a 36dp IconButton whose hitSlop reaches the 44dp target.
    $menuBounds = Get-Bounds 'set-menu-0-0'
    if ($menuBounds.Width -lt [int](36 * $density / 160) - 1) { throw "row menu is too narrow: $($menuBounds.Width)px" }

    Tap-Id 'set-weight-0-0-input'
    Invoke-Adb shell input keycombination 113 29 | Out-Null
    Invoke-Adb shell input text '62.5' | Out-Null
    Start-Sleep -Milliseconds 300
    Save-Screenshot 'v01-weight-keyboard'
    Hide-Keyboard
    if ((Get-Text 'set-weight-0-0-input') -ne '62.5') { throw 'weight decimal input did not commit' }

    Tap-Id 'set-reps-0-0-input'
    Invoke-Adb shell input keycombination 113 29 | Out-Null
    Invoke-Adb shell input text '9' | Out-Null
    Start-Sleep -Milliseconds 300
    Hide-Keyboard
    if ((Get-Text 'set-reps-0-0-input') -ne '9') { throw 'reps integer input did not commit' }

    Tap-Id 'set-reps-0-0-input'
    Invoke-Adb shell input keycombination 113 29 | Out-Null
    Invoke-Adb shell input keyevent 67 | Out-Null
    Hide-Keyboard
    Tap-Label '第 1 组重量'
    Start-Sleep -Milliseconds 300
    Hide-Keyboard
    if ((Get-Text 'set-reps-0-0-input') -ne '9') { throw 'empty reps did not fall back to the committed value' }

    foreach ($layout in @('列表', '紧凑', '卡片')) {
        Tap-Label '训练菜单'
        Wait-Text $layout | Out-Null
        Tap-Text $layout
        Start-Sleep -Milliseconds 600
        Save-Screenshot "v01-$($layout)320"
        Assert-RowAligned @('set-weight-0-0-input', 'set-reps-0-0-input', 'set-rating-0-0', 'set-done-0-0')
        Assert-MinTouch @('set-weight-0-0-input', 'set-reps-0-0-input', 'set-rating-0-0', 'set-done-0-0')
    }

    Invoke-Adb shell settings put system font_scale 1.3 | Out-Null
    Start-Sleep -Seconds 3
    Save-Screenshot 'v01-font-1.3'
    Save-Ui 'v01-font-1.3'
    Assert-RowAligned @('set-weight-0-0-input', 'set-reps-0-0-input', 'set-rating-0-0', 'set-done-0-0')
    Invoke-Adb shell settings put system font_scale 1.0 | Out-Null

    Start-Clean 'modes'
    Save-Screenshot 'v01-modes-cardio'
    Wait-Label '第 1 组速度' | Out-Null
    Wait-Label '第 1 组分钟' | Out-Null
    Tap-Label '下一个'
    Wait-Text '平板支撑' | Out-Null
    Wait-Label '第 1 组重量' | Out-Null
    Wait-Label '第 1 组秒' | Out-Null
    Save-Screenshot 'v01-modes-time'
}

function Case-V02 {
    Reset-Display
    Start-Clean
    Step 'open workout'
    Open-Workout 'fixture-upper'
    Step 'rate 8'
    Tap-Id 'set-rating-0-0'
    Wait-Id 'effort-preset-8' | Out-Null
    Tap-Id 'effort-preset-8'
    Tap-Id 'effort-save'
    Start-Sleep -Milliseconds 800
    $label = (Wait-Id 'set-rating-0-0').GetAttribute('content-desc')
    if ($label -notmatch 'RPE 8') { throw "rating did not show RPE 8: $label" }
    Save-Screenshot 'v02-rating-8'

    Step 'clear rating'
    Tap-Id 'set-rating-0-0'
    Start-Sleep -Milliseconds 500
    Tap-Id 'effort-clear'
    Start-Sleep -Milliseconds 800
    if ((Wait-Id 'set-rating-0-0').GetAttribute('content-desc') -notmatch '未评分') { throw 'cleared rating still reads as rated' }

    Step 'edit 7.5'
    Tap-Id 'set-rating-0-0'
    Start-Sleep -Milliseconds 500
    Tap-Label 'RPE 精确值' -Field
    Invoke-Adb shell input keycombination 113 29 | Out-Null
    Invoke-Adb shell input text '7.5' | Out-Null
    Hide-Keyboard
    Tap-Id 'effort-save'
    Start-Sleep -Milliseconds 400
    if ((Wait-Id 'set-rating-0-0').GetAttribute('content-desc') -notmatch 'RPE 7.5') { throw 'edited rating did not save' }

    Open-SetMenu 0 0
    Tap-Text '设为热身组'
    Start-Sleep -Milliseconds 500
    Wait-Label '热身第 1 组重量' | Out-Null
    if (!((Read-Ui).SelectSingleNode("//node[@content-desc='热身第 1 组评分不可用']"))) {
        throw 'warm-up row does not expose a disabled rating slot'
    }
    Save-Screenshot 'v02-warmup-slot'
    Open-SetMenu 0 0
    Tap-Text '改为正式组'
    Start-Sleep -Milliseconds 500
    if ((Wait-Id 'set-rating-0-0').GetAttribute('content-desc') -notmatch '未评分') {
        throw 'warm-up conversion kept the old rating'
    }

    # Stored per-set RPE + profile RIR: the header is mixed, each row keeps its scale.
    Start-Clean 'mixed-effort'
    Save-Screenshot 'v02-mixed-scale'
    Save-Ui 'v02-mixed-scale'
    if (!((Read-Ui).SelectSingleNode("//node[@text='评分']"))) { throw 'mixed-scale header is not 评分' }
    $rpeRow = (Wait-Id 'set-rating-0-1').GetAttribute('content-desc')
    if ($rpeRow -notmatch 'RPE 8') { throw "stored RPE row lost its scale: $rpeRow" }

    Start-Clean 'effort-none'
    Save-Screenshot 'v02-effort-none'
    Assert-NoText 'RPE' 'effort-off card'
    Assert-NoId 'set-rating-0-0' 'effort-off card'
}

function Case-V03 {
    Reset-Display
    Start-Clean
    Open-Workout 'fixture-upper'
    Tap-Label '杠铃卧推菜单'
    $search = Wait-Text '搜索替换动作'
    if ($search.GetAttribute('enabled') -ne 'true') { throw 'search/replace is not tappable before any work' }
    Invoke-Adb shell input keyevent 4 | Out-Null
    Start-Sleep -Milliseconds 400

    Tap-Id 'set-done-0-0'
    Start-Sleep -Milliseconds 600
    # With no replace and no superset action left, the exercise menu is disabled.
    $menu = Wait-Node {
        $_.GetAttribute('content-desc') -eq '杠铃卧推菜单' -and $_.GetAttribute('enabled') -eq 'false'
    } 'disabled exercise menu after a recorded set'
    Assert-NoText '搜索替换动作' 'exercise card after a recorded set'
    Save-Screenshot 'v03-locked-menu'

    Tap-Id 'set-menu-0-1'
    Start-Sleep -Milliseconds 300
    Assert-NoText '搜索替换动作' 'set menu'
    Save-Screenshot 'v03-set-menu'
    Invoke-Adb shell input keyevent 4 | Out-Null
    Start-Sleep -Milliseconds 400

    Start-Clean
    Open-Workout 'fixture-advanced'
    Tap-Id 'set-expand-0-0'
    Tap-Id 'set-main-done-0-0'
    Start-Sleep -Milliseconds 500
    Wait-Node {
        $_.GetAttribute('content-desc') -eq '杠铃卧推菜单' -and $_.GetAttribute('enabled') -eq 'false'
    } 'disabled exercise menu with a partial drop set' | Out-Null
    Assert-NoText '搜索替换动作' 'exercise card with a partial drop set'
    Save-Screenshot 'v03-partial-lock'
}

function Case-V04 {
    Reset-Display
    Start-Clean
    Open-Workout 'fixture-upper'
    Open-SetMenu 0 0
    Tap-Text '设为热身组'
    Start-Sleep -Milliseconds 500
    Wait-Label '热身第 1 组重量' | Out-Null
    Save-Screenshot 'v04-warmup'
    Open-SetMenu 0 0
    Tap-Text '改为正式组'
    Start-Sleep -Milliseconds 600
    Wait-Label '第 1 组完成' | Out-Null

    Tap-Id 'set-done-0-0'
    Start-Sleep -Milliseconds 700
    Assert-Rest
    Open-SetMenu 0 1
    Tap-Text '复制这一组'
    Start-Sleep -Milliseconds 600
    Assert-Rest
    if ((Get-Text 'set-weight-0-2-input') -ne '60') { throw 'copied row did not keep the weight' }
    $copied = Wait-Id 'set-done-0-2'
    if ($copied.GetAttribute('checked') -eq 'true') { throw 'copied row is already complete' }

    Open-SetMenu 0 0
    Assert-NoText '删除这一组' 'completed set menu'
    Invoke-Adb shell input keyevent 4 | Out-Null
    Save-Screenshot 'v04-copy-rest'

    # A completed set keeps its tick through warm-up conversion and back.
    Open-SetMenu 0 0
    Tap-Text '设为热身组'
    Start-Sleep -Milliseconds 500
    Wait-Label '热身第 1 组完成' | Out-Null
    Assert-Rest
    Open-SetMenu 0 0
    Tap-Text '复制这一组'
    Start-Sleep -Milliseconds 500
    Wait-Label '热身第 2 组重量' | Out-Null
    if ((Wait-Label '热身第 2 组完成').GetAttribute('checked') -eq 'true') {
        throw 'warm-up copy is already complete'
    }
    Open-SetMenu 0 0
    Tap-Text '改为正式组'
    Start-Sleep -Milliseconds 500
    if ((Wait-Id 'set-done-0-1').GetAttribute('checked') -ne 'true') {
        throw 'completed set lost its tick after the warm-up round trip'
    }
    Assert-Rest
    Save-Screenshot 'v04-completed-conversion'

    # Copying a partially recorded drop set starts a fresh 0/N row.
    Start-Clean
    Open-Workout 'fixture-advanced'
    Tap-Id 'set-expand-0-0'
    Tap-Id 'set-main-done-0-0'
    Start-Sleep -Milliseconds 400
    Open-SetMenu 0 0
    Tap-Text '复制这一组'
    Start-Sleep -Milliseconds 500
    if ((Wait-Id 'set-done-0-1').GetAttribute('content-desc') -notmatch '0/3') {
        throw 'copied drop set did not start at 0/3'
    }
    if ((Wait-Id 'set-done-0-0').GetAttribute('content-desc') -notmatch '1/3') {
        throw 'copying a drop set changed the original progress'
    }
    Save-Screenshot 'v04-copy-dropset'
}

function Case-V05 {
    Reset-Display
    Start-Clean
    Open-Workout 'fixture-upper'
    Open-SetMenu 0 0
    Tap-Text '改为递减组'
    Wait-Id 'dropset-sheet-save' | Out-Null
    Save-Screenshot 'v05-sheet'
    Tap-Id 'dropset-sheet-weight-0'
    Invoke-Adb shell input keycombination 113 29 | Out-Null
    Invoke-Adb shell input keyevent 67 | Out-Null
    Hide-Keyboard
    Tap-Id 'dropset-sheet-save'
    Wait-Text '请输入有效重量' | Out-Null
    Save-Screenshot 'v05-error'
    Tap-Id 'dropset-sheet-cancel'
    Start-Sleep -Milliseconds 500
    Assert-NoId 'set-main-done-0-0' 'cancelled drop-set card'
    Assert-Rest -Absent

    Open-SetMenu 0 0
    Tap-Text '改为递减组'
    Wait-Id 'dropset-sheet-save' | Out-Null
    Tap-Id 'dropset-sheet-save'
    Start-Sleep -Milliseconds 600
    Wait-Id 'set-main-done-0-0' | Out-Null
    Assert-Rest -Absent
    Save-Screenshot 'v05-saved'
    Open-SetMenu 0 0
    Tap-Text '编辑分段'
    Wait-Id 'dropset-sheet-save' | Out-Null
    Set-Field 'dropset-sheet-reps-0' '9'
    Tap-Id 'dropset-sheet-save'
    Start-Sleep -Milliseconds 600
    if ((Get-Text 'drop-reps-0-0-0-input') -ne '9') { throw 'edited drop reps did not save' }
    Save-Screenshot 'v05-edited'
}

function Case-V06 {
    Reset-Display
    Start-Clean
    Open-Workout 'fixture-advanced'
    Tap-Id 'set-expand-0-0'
    Tap-Id 'set-main-done-0-0'
    Tap-Id 'drop-done-0-0-0'
    Start-Sleep -Milliseconds 500
    Tap-Id 'drop-add-0-0'
    Start-Sleep -Milliseconds 600
    $progress = (Wait-Id 'set-done-0-0').GetAttribute('content-desc')
    if ($progress -notmatch '2/4') { throw "quick add did not grow to 2/4: $progress" }
    if ((Wait-Id 'set-main-done-0-0').GetAttribute('checked') -ne 'true') { throw 'quick add lost the main tick' }
    if ((Wait-Id 'drop-done-0-0-0').GetAttribute('checked') -ne 'true') { throw 'quick add lost the first drop tick' }
    Save-Screenshot 'v06-added'

    Open-SetMenu 0 0
    Tap-Text '编辑分段'
    Wait-Id 'dropset-sheet-save' | Out-Null
    Tap-Label '删除降重1'
    Wait-Text '删除已勾选的分段？' | Out-Null
    Tap-Text '取消'
    Start-Sleep -Milliseconds 300
    Tap-Label '删除降重3'
    Start-Sleep -Milliseconds 300
    Tap-Id 'dropset-sheet-save'
    Start-Sleep -Milliseconds 500
    if ((Wait-Id 'set-done-0-0').GetAttribute('content-desc') -notmatch '2/3') {
        throw 'deleting an unchecked drop did not keep 2/3 progress'
    }
    if ((Wait-Id 'set-main-done-0-0').GetAttribute('checked') -ne 'true' ||
        (Wait-Id 'drop-done-0-0-0').GetAttribute('checked') -ne 'true') {
        throw 'deleting a drop lost the existing ticks'
    }
    Save-Screenshot 'v06-deleted'

    # Confirm deleting a ticked drop.
    Open-SetMenu 0 0
    Tap-Text '编辑分段'
    Wait-Id 'dropset-sheet-save' | Out-Null
    Tap-Label '删除降重1'
    Wait-Text '删除已勾选的分段？' | Out-Null
    Tap-Text '删除'
    Start-Sleep -Milliseconds 300
    Tap-Id 'dropset-sheet-save'
    Start-Sleep -Milliseconds 500
    if ((Wait-Id 'set-done-0-0').GetAttribute('content-desc') -notmatch '1/2') {
        throw 'confirming a ticked-drop delete did not leave 1/2'
    }

    # Deleting the last pending drop would implicitly finish the set: refused.
    Open-SetMenu 0 0
    Tap-Text '编辑分段'
    Wait-Id 'dropset-sheet-save' | Out-Null
    Tap-Label '删除降重1'
    Wait-Text '至少保留一个待完成段' | Out-Null
    Tap-Text 'OK'
    Tap-Id 'dropset-sheet-cancel'
    Start-Sleep -Milliseconds 500

    Open-SetMenu 0 0
    Tap-Text '改为普通组'
    Wait-Text '改为普通组？' | Out-Null
    Tap-Text '改为普通组'
    Start-Sleep -Milliseconds 600
    Assert-NoId 'set-main-done-0-0' 'reverted set'
    if ((Wait-Id 'set-done-0-0').GetAttribute('checked') -ne 'true') { throw 'reverted set lost the main completion' }
    Assert-Rest -Absent
    Save-Screenshot 'v06-reverted'
}

function Case-V07 {
    Reset-Display
    Start-Clean
    Open-Workout 'fixture-advanced'
    Tap-Id 'set-expand-0-0'
    # Out-of-order taps are disabled before the main segment.
    if ((Wait-Id 'drop-done-0-0-1').GetAttribute('enabled') -ne 'false') {
        throw 'the last drop is tappable before the main segment'
    }
    Tap-Id 'set-main-done-0-0'
    Start-Sleep -Milliseconds 400
    if ((Wait-Id 'drop-done-0-0-0').GetAttribute('enabled') -ne 'true') {
        throw 'the first drop is not tappable after the main segment'
    }
    if ((Wait-Id 'drop-done-0-0-1').GetAttribute('enabled') -ne 'false') {
        throw 'the last drop is tappable before the first drop'
    }
    Tap-Id 'drop-done-0-0-0'
    Start-Sleep -Milliseconds 500
    Assert-Rest -Absent
    if ((Wait-Id 'drop-done-0-0-1').GetAttribute('enabled') -ne 'true') {
        throw 'the last drop is not tappable after the first drop'
    }
    Save-Screenshot 'v07-2of3'

    # The last ticked segment can be undone while the set is still in progress.
    Tap-Id 'drop-done-0-0-0'
    Start-Sleep -Milliseconds 500
    if ((Wait-Id 'set-done-0-0').GetAttribute('content-desc') -notmatch '1/3') {
        throw 'undoing the last ticked partial segment did not return to 1/3'
    }
    if ((Wait-Id 'set-main-done-0-0').GetAttribute('checked') -ne 'true') {
        throw 'undoing a drop also cleared the main segment'
    }
    Tap-Id 'drop-done-0-0-0'
    Start-Sleep -Milliseconds 500
    if ((Wait-Id 'set-done-0-0').GetAttribute('content-desc') -notmatch '2/3') {
        throw 're-ticking the partial drop did not restore 2/3'
    }

    Tap-Label '训练菜单'
    Wait-Text '专注' | Out-Null
    Tap-Text '专注'
    Start-Sleep -Milliseconds 800
    Wait-Node { $_.GetAttribute('text') -like '已勾 2/3*' } 'focus progress 2/3' | Out-Null
    Save-Ui 'v07-focus-2of3'
    Save-Screenshot 'v07-focus-2of3'
    Tap-Label '第 1 组完成'
    Start-Sleep -Milliseconds 800
    Assert-Rest
    $rest = (Read-Ui).SelectSingleNode("//node[@text='组间休息']")
    Save-Screenshot 'v07-focus-complete-rest'

    Tap-Label '训练菜单'
    Wait-Text '卡片' | Out-Null
    Tap-Text '卡片'
    Start-Sleep -Milliseconds 800
    $done = (Wait-Id 'set-done-0-0').GetAttribute('content-desc')
    if ($done -notmatch '3/3') { throw "completed drop set lost its progress: $done" }
    Save-Screenshot 'v07-complete'

    # The whole set rates once from the main row, after completion.
    Tap-Id 'set-rating-0-0'
    Wait-Id 'effort-preset-8' | Out-Null
    Tap-Id 'effort-preset-8'
    Tap-Id 'effort-save'
    Start-Sleep -Milliseconds 700
    if ((Wait-Id 'set-rating-0-0').GetAttribute('content-desc') -notmatch 'RPE 8') {
        throw 'completed drop set did not accept a main-row rating'
    }
    Assert-Rest
    Save-Screenshot 'v07-rated'

    Ensure-RowExpanded 0 0
    Tap-Id 'drop-done-0-0-1'
    Start-Sleep -Milliseconds 600
    Assert-Rest -Absent
    $undone = (Wait-Id 'set-done-0-0').GetAttribute('content-desc')
    if ($undone -notmatch '2/3') { throw "undo did not return to 2/3: $undone" }
    Ensure-RowExpanded 0 0
    Tap-Id 'drop-done-0-0-1'
    Start-Sleep -Milliseconds 600
    Assert-Rest
    Save-Screenshot 'v07-recomplete'
}

function Case-V08 {
    Reset-Display
    Start-Clean
    Open-Workout 'fixture-superset'
    # Give the second member a second set so both sides have two.
    Open-SetMenu 1 0
    Tap-Text '复制这一组'
    Start-Sleep -Milliseconds 500
    Open-SetMenu 0 0
    Tap-Text '改为递减组'
    Wait-Id 'dropset-sheet-save' | Out-Null
    Tap-Id 'dropset-sheet-save'
    Start-Sleep -Milliseconds 600
    Tap-Id 'set-main-done-0-0'
    Start-Sleep -Milliseconds 500
    Assert-Rest -Absent
    Save-Screenshot 'v08-mid-drop'
    Tap-Id 'drop-done-0-0-0'
    Start-Sleep -Milliseconds 700
    # The first member only rotates the round; the rest starts after the second member.
    Assert-Rest -Absent
    Save-Screenshot 'v08-member-two'
    Tap-Id 'set-done-1-0' -Scroll
    Start-Sleep -Milliseconds 800
    Assert-Rest
    Save-Screenshot 'v08-round-rest'
}

function Case-V09 {
    Reset-Display
    Start-Clean 'old-incomplete'
    Save-Screenshot 'v09-old-incomplete'
    if ((Wait-Id 'set-done-0-2').GetAttribute('content-desc') -notmatch '0/3') { throw 'legacy unfinished drop set is not 0/3' }
    Tap-Id 'set-expand-0-2'
    Tap-Id 'set-main-done-0-2'
    Start-Sleep -Milliseconds 500
    Restart-App
    if ((Wait-Id 'set-done-0-2').GetAttribute('content-desc') -notmatch '1/3') { throw 'partial drop progress did not survive a restart' }

    Start-Clean 'old-complete'
    Save-Screenshot 'v09-old-complete'
    $old = (Wait-Id 'set-done-0-2').GetAttribute('content-desc')
    if ($old -notmatch '3/3') { throw "legacy completed drop set is not 3/3: $old" }
    Tap-Id 'set-menu-0-2'
    Wait-Text '复制这一组' | Out-Null
    Assert-NoText '编辑分段' 'completed drop-set menu'
    Assert-NoText '改为普通组' 'completed drop-set menu'
    Assert-NoText '删除这一组' 'completed drop-set menu'
    Invoke-Adb shell input keyevent 4 | Out-Null
    Start-Sleep -Milliseconds 400
    Save-Screenshot 'v09-completed-menu'
    Tap-Id 'set-expand-0-2'
    Tap-Id 'drop-done-0-2-1'
    Start-Sleep -Milliseconds 600
    Assert-Rest -Absent
    if ((Wait-Id 'set-done-0-2').GetAttribute('content-desc') -notmatch '2/3') { throw 'undoing the legacy last segment did not return to 2/3' }
    Restart-App
    if ((Wait-Id 'set-done-0-2').GetAttribute('content-desc') -notmatch '2/3') { throw 'legacy undo did not persist' }
    Save-Screenshot 'v09-legacy-undo'

    Start-Clean 'rest-running'
    Start-Sleep -Seconds 1
    Assert-Rest
    Tap-Id 'set-expand-0-2'
    Tap-Id 'set-main-done-0-2'
    Start-Sleep -Milliseconds 400
    Tap-Id 'set-main-done-0-2'
    Start-Sleep -Milliseconds 600
    Assert-Rest
    Save-Screenshot 'v09-rest-isolation'
}

function Case-V11 {
    Reset-Display
    Start-Clean
    Open-Workout 'fixture-advanced'
    Assert-NoText '改为休息暂停' 'normal set entry points'
    Tap-Text '下一个'
    Wait-Text '杠铃上斜卧推' | Out-Null
    $restPause = Wait-Node { $_.GetAttribute('content-desc') -like '*休息暂停组，*' } 'rest-pause summary' -Scroll
    Save-Screenshot 'v11-restpause'
    Tap-Id 'set-menu-1-1' -Scroll
    Wait-Node { $_.GetAttribute('content-desc') -in @('复制这一组', '删除这一组') } 'Rest-pause set menu' | Out-Null
    Assert-NoText '编辑分段' 'rest-pause set menu'
    Assert-NoText '改为普通组' 'rest-pause set menu'
    Assert-NoText '改为递减组' 'rest-pause set menu'
    Invoke-Adb shell input keyevent 4 | Out-Null
    Tap-Id 'set-expand-1-1'
    Start-Sleep -Milliseconds 600
    Wait-Node { $_.GetAttribute('content-desc') -like '*休息暂停组，*已展开*' } 'expanded rest-pause summary' | Out-Null
    Save-Screenshot 'v11-restpause-expanded'
    Tap-Id 'set-done-1-1' -Scroll
    Start-Sleep -Milliseconds 600
    Assert-Rest

    Tap-Label '完成训练'
    Wait-Text '提前结束？' | Out-Null
    Tap-Text '结束并保存'
    Wait-Text '训练完成' | Out-Null
    Tap-Text '完成'
    Start-Sleep -Milliseconds 700
    Wait-Text '首页' | Out-Null
    Invoke-Adb shell am force-stop $appId | Out-Null
    $stateDb = Join-Path $OutDir 'v11-state.db'
    $capture = Start-Process -FilePath $Adb `
        -ArgumentList @('-s', $Serial, 'exec-out', 'run-as', $appId, 'cat', 'files/SQLite/opengym-rn.db') `
        -RedirectStandardOutput $stateDb -NoNewWindow -Wait -PassThru
    if ($capture.ExitCode -ne 0) { throw 'could not read the rest-pause history state' }
    $check = & $node -e @"
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
const state = JSON.parse(db.prepare('select state from workspace').get().state);
const workouts = [...(state.queue ?? []).map(item => item.workout), ...(state.profile.workouts ?? [])];
const workout = workouts.sort((a, b) => (b._ts ?? 0) - (a._ts ?? 0))[0];
const entry = (workout.entries ?? []).find(item => item.id === '0047');
const row = (entry.sets ?? []).find(item => item.type === 'restpause');
if (!row) throw new Error('saved history has no rest-pause row');
if (row.done !== true) throw new Error('saved rest-pause row is not done');
if (!Array.isArray(row.clusters) || row.clusters.length !== 4) throw new Error('rest-pause clusters were rewritten');
if (row.clusters.some(cluster => 'at' in cluster || 'key' in cluster)) throw new Error('draft cluster fields leaked into history');
console.log(JSON.stringify({ workoutId: workout.id, restPause: row }));
"@ $stateDb
    if ($LASTEXITCODE -ne 0) { throw "rest-pause history projection failed: $check" }
    Write-Output "  > rest-pause history: $check"
}

function Sync-V10([string]$WorkoutId) {
    $apiDirectory = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\api')).Path
    $runDirectory = Join-Path $OutDir "api-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    New-Item -ItemType Directory -Force -Path $runDirectory | Out-Null
    $apiOut = Join-Path $runDirectory 'api.log'
    $apiErr = Join-Path $runDirectory 'api-error.log'
    $server = Start-Process -FilePath $node -ArgumentList @((Join-Path $PSScriptRoot 'loopback-api.mjs'), $runDirectory) `
        -WorkingDirectory $apiDirectory -WindowStyle Hidden -RedirectStandardOutput $apiOut -RedirectStandardError $apiErr -PassThru
    $reversePort = 0
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            if ($server.HasExited) { throw 'The isolated API exited before it was ready.' }
            $startup = Select-String -LiteralPath $apiOut -Pattern 'gym-api on :(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($startup) { $reversePort = [int]$startup.Matches[0].Groups[1].Value; break }
            Start-Sleep -Milliseconds 200
        } while ([DateTime]::UtcNow -lt $deadline)
        if (!$reversePort) { throw 'The isolated API did not report its listening port.' }

        $baseUrl = "http://127.0.0.1:$reversePort"
        $name = "Workout Set $([guid]::NewGuid().ToString('N').Substring(0, 6))"
        $password = [guid]::NewGuid().ToString('N')
        Invoke-RestMethod "$baseUrl/api/register/password" -Method Post -ContentType 'application/json' `
            -Body (@{ name = $name; password = $password } | ConvertTo-Json -Compress) `
            -SessionVariable apiSession -TimeoutSec 10 | Out-Null
        $pairing = Invoke-RestMethod "$baseUrl/api/pair/create" -Method Post -ContentType 'application/json' -WebSession $apiSession `
            -Body (@{ current = $password } | ConvertTo-Json -Compress) -TimeoutSec 10
        if ($pairing.code -notmatch '^[A-Z0-9]+$') { throw 'The isolated API did not return a pairing code.' }

        Invoke-Adb reverse "tcp:$reversePort" "tcp:$reversePort" | Out-Null
        Invoke-Adb shell "am start -W -a android.intent.action.VIEW -d 'opengym://settings?e2e=1'" | Out-Null
        Wait-Label '设置' | Out-Null
        Scroll-ToTop
        Wait-Label '服务器地址' -Field | Out-Null
        Tap-Label '服务器地址' -Field
        Invoke-Adb shell input keycombination 113 29 | Out-Null
        Invoke-Adb shell input text $baseUrl | Out-Null
        Hide-Keyboard
        Tap-Label '配对码' -Field -Scroll
        Invoke-Adb shell input text $pairing.code | Out-Null
        Hide-Keyboard
        Tap-Label '连接服务器' -Scroll
        Wait-Node { $_.GetAttribute('text') -like "*$name*" } 'Paired account' -Scroll -Seconds 30 | Out-Null
        Save-Screenshot 'v10-paired'

        # The paired account starts empty; merge the practice workspace that holds
        # the just-finished workout, then sync it.
        Invoke-Adb shell "am start -W -a android.intent.action.VIEW -d 'opengym://settings?e2e=1'" | Out-Null
        Wait-Label '设置' | Out-Null
        Tap-Label '合并本机练习' -Scroll
        Wait-Text '合并本机练习？' | Out-Null
        Tap-Text '合并'
        Start-Sleep -Milliseconds 1200
        try { Tap-Text 'OK' } catch {
            try { Tap-Text '确定' } catch { }
        }
        try { Tap-Label '立即同步' -Scroll } catch { }
        $deadline = [DateTime]::UtcNow.AddSeconds(45)
        $workout = $null
        do {
            try {
                $state = (Invoke-RestMethod "$baseUrl/api/data" -WebSession $apiSession -TimeoutSec 10).state
                $workout = @($state.workouts | Where-Object { $_.id -eq $WorkoutId }) | Select-Object -First 1
            } catch { }
            if ($workout) { break }
            Start-Sleep -Milliseconds 500
        } while ([DateTime]::UtcNow -lt $deadline)
        if (!$workout) { throw 'The synced workout did not reach the isolated API.' }
        $row = @($workout.entries | Where-Object { $_.id -eq '0025' } | ForEach-Object { $_.sets } | Where-Object { $_.type -eq 'dropset' }) | Select-Object -First 1
        if (!$row -or $row.done -ne $true) { throw 'The API workout has no completed dropset row.' }
        if (@($row.drops).Count -ne 2) { throw 'The API dropset row does not have two drops.' }
        if ($row.PSObject.Properties.Name -contains 'mainAt' -or @($row.drops | Where-Object { $_.PSObject.Properties.Name -contains 'at' }).Count -gt 0) {
            throw 'Draft segment fields leaked into the API payload.'
        }
        $syncedIds = @($state.workouts | ForEach-Object { $_.id })
        if (@($syncedIds | Where-Object { $_ -eq $WorkoutId }).Count -ne 1) { throw 'The workout was synced more than once.' }
        Save-Screenshot 'v10-api-synced'
    } finally {
        if ($reversePort) { & $Adb -s $Serial reverse --remove "tcp:$reversePort" 2>$null | Out-Null }
        if ($server -and !$server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    }
}

function Case-V10 {
    Reset-Display
    Start-Clean
    Open-Workout 'fixture-upper'
    # Plain set first.
    Tap-Id 'set-done-0-0'
    Start-Sleep -Milliseconds 500
    # Build 60x7 -> 50x8 -> 40x9 on set 2.
    Open-SetMenu 0 1
    Tap-Text '改为递减组'
    Wait-Id 'dropset-sheet-save' | Out-Null
    Set-Field 'dropset-sheet-weight-0' '50'
    Set-Field 'dropset-sheet-reps-0' '8'
    Tap-Id 'dropset-sheet-save'
    Start-Sleep -Milliseconds 500
    Tap-Id 'drop-add-0-1'
    Start-Sleep -Milliseconds 500
    Set-Field 'drop-weight-0-1-1-input' '40'
    Set-Field 'drop-reps-0-1-1-input' '9'
    Set-Field 'set-reps-0-1-input' '7'
    Set-Field 'set-weight-0-1-input' '60'
    Tap-Id 'set-main-done-0-1'
    Tap-Id 'drop-done-0-1-0'
    Tap-Id 'drop-done-0-1-1'
    Start-Sleep -Milliseconds 700
    # Another partial drop set that must be saved as not done.
    Open-SetMenu 0 2
    Tap-Text '改为递减组'
    Wait-Id 'dropset-sheet-save' | Out-Null
    Tap-Id 'dropset-sheet-save'
    Start-Sleep -Milliseconds 500
    Ensure-RowExpanded 0 2
    Tap-Id 'set-main-done-0-2'
    Start-Sleep -Milliseconds 400
    Tap-Label '完成训练'
    Wait-Text '提前结束？' | Out-Null
    Wait-Text '部分勾选的递减组不会计为已完成组；分段进度只保留在草稿中。' | Out-Null
    Save-Screenshot 'v10-partial-confirm'
    Tap-Text '继续训练'
    Start-Sleep -Milliseconds 400
    Tap-Label '完成训练'
    Wait-Text '提前结束？' | Out-Null
    Tap-Text '结束并保存'
    Wait-Text '训练完成' | Out-Null
    Save-Screenshot 'v10-summary'
    $summaryText = (Read-Ui).OuterXml
    if ($summaryText -notmatch '1,660') { throw 'summary volume is not 1,660 kg (1180 drop-set + 480 plain)' }
    Tap-Text '完成'
    Start-Sleep -Milliseconds 800
    Wait-Text '首页' | Out-Null

    Invoke-Adb shell am force-stop $appId | Out-Null
    $stateDb = Join-Path $OutDir 'v10-state.db'
    $capture = Start-Process -FilePath $Adb `
        -ArgumentList @('-s', $Serial, 'exec-out', 'run-as', $appId, 'cat', 'files/SQLite/opengym-rn.db') `
        -RedirectStandardOutput $stateDb -NoNewWindow -Wait -PassThru
    if ($capture.ExitCode -ne 0) { throw 'could not read the saved local state' }
    $check = & $node -e @"
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1]);
const state = JSON.parse(db.prepare('select state from workspace').get().state);
const workouts = [...(state.queue ?? []).map(item => item.workout), ...(state.profile.workouts ?? [])];
const workout = workouts.sort((a, b) => (b._ts ?? 0) - (a._ts ?? 0))[0];
const entry = (workout.entries ?? []).find(item => item.id === '0025');
const row = (entry.sets ?? []).find(item => item.type === 'dropset');
if (!row) throw new Error('saved history has no dropset row');
if (row.done !== true) throw new Error('saved dropset row is not done');
if (!Array.isArray(row.drops) || row.drops.length !== 2) throw new Error('saved dropset does not have two drops');
if ('mainAt' in row || row.drops.some(drop => 'at' in drop)) throw new Error('draft-only segment fields leaked into history');
const volume = row.w * row.r + row.drops.reduce((sum, drop) => sum + drop.w * drop.r, 0);
if (volume !== 1180) throw new Error('dropset volume is ' + volume + ', expected 1180');
console.log(JSON.stringify({ workoutId: workout.id, sets: entry.sets, volume }));
"@ $stateDb
    if ($LASTEXITCODE -ne 0) { throw "history projection failed: $check" }
    Write-Output "  > history: $check"
    Save-Screenshot 'v10-home-after-save'
    $history = $check | ConvertFrom-Json
    Sync-V10 $history.workoutId
}

$cases = if ($Case -contains 'All') { @('V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08', 'V09', 'V11', 'V10') } else { $Case }

try {
    if ((Invoke-Adb shell getprop ro.kernel.qemu).Trim() -ne '1') {
        throw 'This acceptance requires a dedicated Android emulator.'
    }
    if ((Invoke-Adb shell getprop sys.boot_completed).Trim() -ne '1') {
        throw 'Wait for the Android emulator to finish booting.'
    }
    Read-Display
    & $javac --release 8 -classpath $platformJar -d $buildDirectory (Join-Path $PSScriptRoot 'DumpActiveWindow.java')
    if ($LASTEXITCODE -ne 0) { throw 'Could not compile the emulator UI dumper.' }
    & $d8 --min-api 26 --lib $platformJar --output $buildDirectory (Join-Path $buildDirectory 'DumpActiveWindow.class')
    if ($LASTEXITCODE -ne 0) { throw 'Could not package the emulator UI dumper.' }
    Invoke-Adb push (Join-Path $buildDirectory 'classes.dex') $remoteDumper | Out-Null

    if (!$SkipInstall) {
        Write-Output "Installing Debug APK: $apkPath"
        Invoke-Adb install -r $apkPath | Out-Null
    }
    & $Adb -s $Serial shell run-as $appId true 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'The installed app is not debuggable. Install the Debug APK before running this acceptance.' }
    Invoke-Adb reverse tcp:8081 tcp:8081 | Out-Null

    foreach ($name in $cases) {
        $command = Get-Command "Case-$name" -CommandType Function -ErrorAction SilentlyContinue
        if (!$command) { throw "Unknown case $name" }
        Invoke-Case $name $command.ScriptBlock
    }
} finally {
    Reset-Display
    $summary = $results | Format-Table -AutoSize | Out-String
    Write-Output $summary
    $results | ConvertTo-Json | Set-Content (Join-Path $OutDir 'results.json')
    $failed = $results | Where-Object Status -eq 'FAIL'
    if ($failed) { exit 1 }
}
