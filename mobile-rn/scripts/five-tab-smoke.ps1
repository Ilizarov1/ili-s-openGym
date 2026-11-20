param(
  [string]$Serial = 'emulator-5556',
  [switch]$ResetAppData,
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist\ui')
)

$ErrorActionPreference = 'Stop'
$adb = Join-Path $env:LOCALAPPDATA 'RnToolchain\android-sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found: $adb" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$xmlPath = Join-Path $OutDir 'smoke-window.xml'

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & $adb -s $Serial @Args
  if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Args -join ' ')" }
}

function Read-Ui {
  Invoke-Adb shell uiautomator dump /sdcard/smoke-window.xml | Out-Null
  Invoke-Adb pull /sdcard/smoke-window.xml $xmlPath | Out-Null
  return [xml](Get-Content -Raw $xmlPath)
}

function Find-Node {
  param($Xml, [string]$Text)
  return $Xml.SelectSingleNode("//node[@text='$Text' or @content-desc='$Text']")
}

function Tap-Bounds {
  param([string]$Bounds)
  $m = [regex]::Match($Bounds, '\[(\d+),(\d+)\]\[(\d+),(\d+)\]')
  if (-not $m.Success) { throw "invalid bounds: $Bounds" }
  $x = [int]((([int]$m.Groups[1].Value) + ([int]$m.Groups[3].Value)) / 2)
  # Tap above the vertical centre: a bottom tab's box reaches into the gesture strip,
  # where the system can swallow the touch even though the app owns the upper part.
  $y = [int]([int]$m.Groups[2].Value + (([int]$m.Groups[4].Value) - ([int]$m.Groups[2].Value)) * 0.38)
  Invoke-Adb shell input tap $x $y
  Start-Sleep -Milliseconds 350
}

function Tap-Text {
  param([string]$Text)
  $node = Find-Node (Read-Ui) $Text
  if (-not $node) { throw "text not found: $Text" }
  # Prefer the pressable ancestor: the text baseline of a bottom tab sits inside the
  # gesture navigation strip, while the tab's own box is comfortably above it.
  $target = $node
  while ($target -and $target.Name -eq 'node' -and $target.clickable -ne 'true') {
    $target = $target.ParentNode
  }
  if (-not $target -or $target.Name -ne 'node') { $target = $node }
  Tap-Bounds $target.bounds
}

# The first tap after closing a full-screen Modal can be consumed by the transition.
# Repeating the tap is harmless on a tab (it stays selected) and makes the shell test
# deterministic on a cold launch.
function Tap-Tab {
  param([string]$Text)
  Tap-Text $Text
  Start-Sleep -Milliseconds 500
  Tap-Text $Text
}

function Wait-Text {
  param([string]$Text, [int]$Seconds = 20)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $node = Find-Node (Read-Ui) $Text
    if ($node) { return $node }
    Start-Sleep -Milliseconds 600
  }
  throw "timed out waiting for: $Text"
}

function Ensure-Text {
  param([string]$Text, [int]$Scrolls = 12)
  for ($i = 0; $i -le $Scrolls; $i++) {
    $node = Find-Node (Read-Ui) $Text
    if ($node) { return $node }
    Invoke-Adb shell input swipe 540 1900 540 600 250 | Out-Null
    Start-Sleep -Milliseconds 300
  }
  throw "text not found after scrolling: $Text"
}

function Screenshot {
  param([string]$Name)
  $remote = "/sdcard/$Name.png"
  $local = Join-Path $OutDir "$Name.png"
  & $adb -s $Serial shell screencap -p $remote | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "screencap failed: $Name" }
  Invoke-Adb pull $remote $local | Out-Null
  Invoke-Adb shell rm $remote | Out-Null
  Write-Output "screenshot: $local"
}

Write-Output "device: $Serial"
Invoke-Adb reverse tcp:8081 tcp:8081 | Out-Null
if ($ResetAppData) { Invoke-Adb shell pm clear dev.opengym.rn | Out-Null }
Invoke-Adb shell am force-stop dev.opengym.rn | Out-Null
Invoke-Adb shell am start -n dev.opengym.rn/.MainActivity | Out-Null

Wait-Text '首页' 90 | Out-Null
foreach ($tab in @('计划', '统计', '动作库')) {
  if (-not (Find-Node (Read-Ui) $tab)) { throw "missing tab: $tab" }
}
Screenshot 'five-tab-home'

Tap-Text '设置'
Wait-Text '设置' 20 | Out-Null
Ensure-Text '服务器地址' | Out-Null
Ensure-Text '配对码' | Out-Null
Screenshot 'five-tab-settings'
Invoke-Adb shell input keyevent 4 | Out-Null
Wait-Text '首页' 15 | Out-Null
Start-Sleep -Seconds 1

Tap-Tab '计划'
Wait-Text '训练计划' 15 | Out-Null
Tap-Text '训练计划'
Wait-Text '新训练日' 15 | Out-Null
Ensure-Text '全身力量 A' | Out-Null
Screenshot 'five-tab-plan'
Tap-Text '全身力量 A'
Wait-Text '编辑计划' 15 | Out-Null
Screenshot 'five-tab-plan-editor'
Invoke-Adb shell input keyevent 4 | Out-Null
Wait-Text '训练计划' 15 | Out-Null
Start-Sleep -Seconds 1

Tap-Tab '统计'
Wait-Text '训练记录与进步' 15 | Out-Null
Screenshot 'five-tab-stats'

Tap-Tab '动作库'
Wait-Text '5632 个动画动作 + 0 个自建' 15 | Out-Null
Ensure-Text '5632 个动画动作 + 0 个自建' | Out-Null
Screenshot 'five-tab-library'
Tap-Text '筛选'
Wait-Text '筛选' 15 | Out-Null
Screenshot 'five-tab-library-filter'
Tap-Text '完成'
Wait-Text '5632 个动画动作 + 0 个自建' 15 | Out-Null

Tap-Text '首页'
Wait-Text '今日训练' 15 | Out-Null
Tap-Text '选择其他训练'
Wait-Text '开始训练' 15 | Out-Null
Screenshot 'five-tab-start-sheet'
Tap-Text '取消'
Wait-Text '最近训练' 15 | Out-Null

Write-Output 'PASS: five-tab shell, home, plan, stats, library, filter and start sheet verified'
