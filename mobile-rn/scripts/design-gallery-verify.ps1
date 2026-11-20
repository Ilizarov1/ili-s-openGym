param(
  [string]$Serial = 'emulator-5556',
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist\ui')
)

$ErrorActionPreference = 'Stop'
$adb = Join-Path $env:LOCALAPPDATA 'RnToolchain\android-sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found: $adb" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$xmlPath = Join-Path $OutDir 'window.xml'

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & $adb -s $Serial @Args
  if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Args -join ' ')" }
}

function Read-Ui {
  Invoke-Adb shell uiautomator dump /sdcard/window.xml | Out-Null
  Invoke-Adb pull /sdcard/window.xml $xmlPath | Out-Null
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
  $x = [int](($m.Groups[1].Value -as [int]) + ($m.Groups[3].Value -as [int])) / 2
  $y = [int](($m.Groups[2].Value -as [int]) + ($m.Groups[4].Value -as [int])) / 2
  Invoke-Adb shell input tap ([int]$x) ([int]$y)
}

function Tap-Text {
  param([string]$Text)
  $node = Find-Node (Read-Ui) $Text
  if (-not $node) { throw "text not found: $Text" }
  Tap-Bounds $node.bounds
}

function Wait-Text {
  param([string]$Text, [int]$Seconds = 30)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $node = Find-Node (Read-Ui) $Text
    if ($node) { return $node }
    Start-Sleep -Milliseconds 700
  }
  throw "timed out waiting for: $Text"
}

function Scroll-Down {
  Invoke-Adb shell input swipe 540 1900 540 500 350 | Out-Null
  Start-Sleep -Milliseconds 500
}

function Ensure-Text {
  param([string]$Text, [int]$Scrolls = 15)
  for ($i = 0; $i -le $Scrolls; $i++) {
    $node = Find-Node (Read-Ui) $Text
    if ($node) { return $node }
    Scroll-Down
  }
  throw "text not found after scrolling: $Text"
}

function Screenshot {
  param([string]$Name)
  $remote = "/sdcard/$Name.png"
  $local = Join-Path $OutDir "$Name.png"
  & $adb -s $Serial shell screencap -p $remote | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "adb screencap failed: $Name" }
  Invoke-Adb pull $remote $local | Out-Null
  Invoke-Adb shell rm $remote | Out-Null
  Write-Output "screenshot: $local"
}

Write-Output "device: $Serial"
Invoke-Adb shell getprop ro.product.model
Invoke-Adb reverse tcp:8081 tcp:8081 | Out-Null
Invoke-Adb shell am force-stop dev.opengym.rn | Out-Null
Invoke-Adb shell am start -n dev.opengym.rn/.MainActivity | Out-Null

Wait-Text '首页' 90 | Out-Null
Tap-Text '设置'
$dev = Ensure-Text '设计系统预览'
Tap-Bounds $dev.bounds
Wait-Text '设计系统' 30 | Out-Null
Screenshot 'gallery-dark'

Tap-Text '浅色'
Start-Sleep -Milliseconds 1800
Screenshot 'gallery-light'
Tap-Text '深色'
Start-Sleep -Milliseconds 1200

Ensure-Text '图标（126）' 20 | Out-Null
Ensure-Text '肌群图' 20 | Out-Null
Screenshot 'gallery-body-map'

$sheetButton = Ensure-Text '打开底部弹出层' 20
Tap-Bounds $sheetButton.bounds
Wait-Text '筛选动作' 15 | Out-Null
Screenshot 'gallery-sheet'
Tap-Text '完成'
Start-Sleep -Milliseconds 500

Ensure-Text 'TabBar 静态预览' 20 | Out-Null
Write-Output 'PASS: design gallery rendered, theme switch and sheet verified'
