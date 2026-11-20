param(
  [string]$Serial = 'emulator-5556',
  [ValidateSet('old-incomplete', 'old-complete', 'rest-running')]
  [string]$Scenario = 'old-incomplete',
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist\workout-set-ui\draft')
)

$ErrorActionPreference = 'Stop'
$adb = Join-Path $env:LOCALAPPDATA 'OpenGymRnToolchain\android-sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found: $adb" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & $adb -s $Serial @Args
  if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Args -join ' ')" }
}

& $adb -s $Serial shell run-as dev.opengym.rn true 2>$null
if ($LASTEXITCODE -ne 0) { throw 'The installed app is not debuggable. Install the Debug APK first.' }

$base = Join-Path $OutDir 'opengym-rn-base.db'
$db = Join-Path $OutDir "opengym-rn-$Scenario.db"
& node (Join-Path $PSScriptRoot 'make-ui-fixture.mjs') $base
if ($LASTEXITCODE -ne 0) { throw 'base fixture generation failed' }
& node (Join-Path $PSScriptRoot 'workout-set-ui-fixture.mjs') $base $db $Scenario
if ($LASTEXITCODE -ne 0) { throw 'draft fixture generation failed' }

Invoke-Adb shell am force-stop dev.opengym.rn | Out-Null
Invoke-Adb push $db /data/local/tmp/opengym-rn.db | Out-Null
Invoke-Adb shell run-as dev.opengym.rn mkdir '-p' databases | Out-Null
Invoke-Adb shell run-as dev.opengym.rn mkdir '-p' files/SQLite | Out-Null
Invoke-Adb shell run-as dev.opengym.rn cp /data/local/tmp/opengym-rn.db databases/opengym-rn.db | Out-Null
Invoke-Adb shell run-as dev.opengym.rn cp /data/local/tmp/opengym-rn.db files/SQLite/opengym-rn.db | Out-Null
Invoke-Adb shell run-as dev.opengym.rn rm '-f' databases/opengym-rn.db-wal databases/opengym-rn.db-shm | Out-Null
Invoke-Adb shell run-as dev.opengym.rn rm '-f' files/SQLite/opengym-rn.db-wal files/SQLite/opengym-rn.db-shm | Out-Null
Invoke-Adb shell rm -f /data/local/tmp/opengym-rn.db | Out-Null

Write-Output "draft fixture installed: $Scenario ($db)"
