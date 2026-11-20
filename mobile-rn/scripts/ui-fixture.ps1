param(
  [string]$Serial = 'emulator-5556',
  [string]$OutDir = (Join-Path $PSScriptRoot '..\dist\ui')
)

$ErrorActionPreference = 'Stop'
$adb = Join-Path $env:LOCALAPPDATA 'RnToolchain\android-sdk\platform-tools\adb.exe'
if (-not (Test-Path $adb)) { throw "adb not found: $adb" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & $adb -s $Serial @Args
  if ($LASTEXITCODE -ne 0) { throw "adb failed: $($Args -join ' ')" }
}

# Fixture data is written into the debuggable app's private SQLite database.
# A release APK cannot be accessed with run-as, so install the Debug APK first.
& $adb -s $Serial shell run-as dev.opengym.rn true 2>$null
if ($LASTEXITCODE -ne 0) {
  throw 'The installed app is not debuggable. Install the Debug APK before using -Fixture.'
}

$db = Join-Path $OutDir 'opengym-rn.db'
& node (Join-Path $PSScriptRoot 'make-ui-fixture.mjs') $db
if ($LASTEXITCODE -ne 0) { throw 'fixture generation failed' }

Invoke-Adb shell am force-stop dev.opengym.rn | Out-Null
Invoke-Adb push $db /data/local/tmp/opengym-rn.db | Out-Null
Invoke-Adb shell run-as dev.opengym.rn mkdir '-p' databases | Out-Null
Invoke-Adb shell run-as dev.opengym.rn mkdir '-p' files/SQLite | Out-Null
Invoke-Adb shell run-as dev.opengym.rn cp /data/local/tmp/opengym-rn.db databases/opengym-rn.db | Out-Null
Invoke-Adb shell run-as dev.opengym.rn cp /data/local/tmp/opengym-rn.db files/SQLite/opengym-rn.db | Out-Null
Invoke-Adb shell run-as dev.opengym.rn rm '-f' databases/opengym-rn.db-wal databases/opengym-rn.db-shm | Out-Null
Invoke-Adb shell run-as dev.opengym.rn rm '-f' files/SQLite/opengym-rn.db-wal files/SQLite/opengym-rn.db-shm | Out-Null
Invoke-Adb shell rm -f /data/local/tmp/opengym-rn.db | Out-Null

Write-Output "fixture installed: $db"
