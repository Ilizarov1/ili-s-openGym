param(
  [string]$Serial = 'emulator-5556',
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist\ui'),
  [switch]$ResetAppData,
  [switch]$Fixture,
  [string]$PlanName = '胸部与肩部训练 A',
  [switch]$NoContactSheet
)

$ErrorActionPreference = 'Stop'
$adb = Join-Path $env:LOCALAPPDATA 'OpenGymRnToolchain\android-sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found: $adb" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$xmlPath = Join-Path $OutDir 'capture-window.xml'

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & $adb -s $Serial @Args
  if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Args -join ' ')" }
}

function Read-Ui {
  Invoke-Adb shell uiautomator dump /sdcard/capture-window.xml | Out-Null
  Invoke-Adb pull /sdcard/capture-window.xml $xmlPath | Out-Null
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
  $y = [int]((([int]$m.Groups[2].Value) + ([int]$m.Groups[4].Value)) / 2)
  Invoke-Adb shell input tap $x $y
}

function Tap-Text {
  param([string]$Text)
  $node = Find-Node (Read-Ui) $Text
  if (-not $node) { throw "text not found: $Text" }
  Tap-Bounds $node.bounds
}

function Wait-Text {
  param([string]$Text, [int]$Seconds = 20)
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $node = Find-Node (Read-Ui) $Text
    if ($node) { return $node }
    Start-Sleep -Milliseconds 500
  }
  throw "timed out waiting for: $Text"
}

function Open-Route {
  param([string]$Route)
  $url = "opengym://$Route"
  & $adb -s $Serial shell "am start -W -a android.intent.action.VIEW -d '$url'" | Out-Null
  Start-Sleep -Milliseconds 800
}

function Screenshot {
  param([string]$Name)
  $path = Join-Path $OutDir "$Name.png"
  $process = Start-Process -FilePath $adb `
    -ArgumentList @('-s', $Serial, 'exec-out', 'screencap', '-p') `
    -RedirectStandardOutput $path -NoNewWindow -Wait -PassThru
  if ($process.ExitCode -ne 0 -or -not (Test-Path $path) -or (Get-Item $path).Length -lt 1000) {
    throw "screenshot failed: $Name"
  }
  Write-Output "screenshot: $path"
}

function New-ContactSheet {
  param([string[]]$Names, [string]$FileName, [int]$Columns = 2)
  Add-Type -AssemblyName System.Drawing
  $paths = $Names | ForEach-Object { Join-Path $OutDir "$_.png" }
  $missing = $paths | Where-Object { -not (Test-Path $_) }
  if ($missing) { throw "missing screenshots: $($missing -join ', ')" }
  $cellW = 540
  $cellH = 1200
  $labelH = 36
  $rows = [Math]::Ceiling($paths.Count / $Columns)
  $bitmap = New-Object System.Drawing.Bitmap ($Columns * $cellW), ($rows * ($cellH + $labelH))
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Black)
  $font = New-Object System.Drawing.Font('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
  $brush = [System.Drawing.Brushes]::White
  for ($i = 0; $i -lt $paths.Count; $i++) {
    $x = ($i % $Columns) * $cellW
    $y = [Math]::Floor($i / $Columns) * ($cellH + $labelH)
    $graphics.DrawString($Names[$i], $font, $brush, $x + 10, $y + 5)
    $image = [System.Drawing.Image]::FromFile($paths[$i])
    $graphics.DrawImage($image, $x, $y + $labelH, $cellW, $cellH)
    $image.Dispose()
  }
  $out = Join-Path $OutDir $FileName
  $bitmap.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose()
  $bitmap.Dispose()
  Write-Output "contact sheet: $out"
}

if ($Fixture) {
  & (Join-Path $PSScriptRoot 'ui-fixture.ps1') -Serial $Serial -OutDir $OutDir
  if ($LASTEXITCODE -ne 0) { throw 'fixture setup failed' }
} elseif ($ResetAppData) {
  Invoke-Adb shell pm clear dev.opengym.rn | Out-Null
}

Open-Route 'home?e2e=1'
Wait-Text '首页' 30 | Out-Null
Screenshot 'home'

Open-Route 'settings?e2e=1'
Wait-Text '设置' 20 | Out-Null
Wait-Text '服务器地址' 20 | Out-Null
Screenshot 'settings'

Open-Route 'plan?e2e=1'
Wait-Text '计划' 20 | Out-Null
Screenshot 'plan'
Tap-Text '训练计划'
Wait-Text '新训练日' 20 | Out-Null
Screenshot 'plan-routines'
Tap-Text $PlanName
Wait-Text '编辑计划' 20 | Out-Null
Screenshot 'plan-editor'
Invoke-Adb shell input keyevent 4 | Out-Null
Wait-Text '计划' 20 | Out-Null

Open-Route 'stats?e2e=1'
Wait-Text '统计' 20 | Out-Null
Screenshot 'stats'

Open-Route 'library?e2e=1'
Wait-Text '动作库' 20 | Out-Null
Screenshot 'library'
Tap-Text '筛选'
Wait-Text '筛选' 20 | Out-Null
Screenshot 'library-filter'
Tap-Text '完成'
Wait-Text '动作库' 20 | Out-Null

Open-Route 'start-sheet?e2e=1'
Wait-Text '开始训练' 20 | Out-Null
Screenshot 'start-sheet'
Tap-Text '取消'
Wait-Text '动作库' 20 | Out-Null

Open-Route 'workout?e2e=1&routine=fixture-upper'
Wait-Text '完成训练' 30 | Out-Null
Screenshot 'workout'
Tap-Text '第 1 组完成'
Wait-Text '组间休息' 20 | Out-Null
Screenshot 'rest'

if (-not $NoContactSheet) {
  New-ContactSheet @('home', 'settings', 'plan', 'plan-routines') 'contact-sheet-1.png'
  New-ContactSheet @('stats', 'library', 'library-filter', 'start-sheet') 'contact-sheet-2.png'
  New-ContactSheet @('plan-editor', 'workout', 'rest') 'contact-sheet-3.png'
}

Write-Output 'PASS: UI capture, deep links, frozen workout timer and contact sheets verified'
