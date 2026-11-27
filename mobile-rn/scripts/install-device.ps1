[CmdletBinding()]
param(
  [string]$Apk,
  [string]$Serial,
  [switch]$Launch,
  [string]$PackageName = 'dev.opengym.rn'
)

$ErrorActionPreference = 'Stop'

function Resolve-SdkRoot {
  if ($env:ANDROID_HOME -and (Test-Path -LiteralPath $env:ANDROID_HOME)) {
    return (Resolve-Path -LiteralPath $env:ANDROID_HOME).Path
  }
  $fallback = Join-Path $env:LOCALAPPDATA 'RnToolchain\android-sdk'
  if (Test-Path -LiteralPath $fallback) {
    return (Resolve-Path -LiteralPath $fallback).Path
  }
  throw "Android SDK not found. Set ANDROID_HOME or install RnToolchain at $fallback."
}

function Resolve-Tool {
  param(
    [string]$SdkRoot,
    [string]$Kind
  )
  if ($Kind -eq 'adb') {
    $candidate = Join-Path $SdkRoot 'platform-tools\adb.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
    $cmd = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "adb.exe not found under $SdkRoot\platform-tools or PATH."
  }

  $buildToolsRoot = Join-Path $SdkRoot 'build-tools'
  if (-not (Test-Path -LiteralPath $buildToolsRoot)) {
    throw "build-tools directory not found under $SdkRoot."
  }
  $versions = Get-ChildItem -LiteralPath $buildToolsRoot -Directory | Sort-Object -Descending {
    $v = $null
    if ([version]::TryParse($_.Name, [ref]$v)) { $v } else { [version]'0.0' }
  }
  $fileName = if ($Kind -eq 'apksigner') { 'apksigner.bat' } else { 'aapt.exe' }
  foreach ($dir in $versions) {
    $toolPath = Join-Path $dir.FullName $fileName
    if (Test-Path -LiteralPath $toolPath) { return $toolPath }
  }
  throw "$fileName not found under $buildToolsRoot."
}

function Resolve-ApkPath {
  param([string]$ExplicitApk)
  if ($ExplicitApk) {
    if (-not (Test-Path -LiteralPath $ExplicitApk)) {
      throw "APK file not found: $ExplicitApk"
    }
    $resolved = (Resolve-Path -LiteralPath $ExplicitApk).Path
    if ([IO.Path]::GetExtension($resolved) -ne '.apk') {
      throw "Not an .apk file: $resolved"
    }
    return $resolved
  }

  $mobileRnRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
  $candidates = @()
  $distDir = Join-Path $mobileRnRoot 'dist'
  if (Test-Path -LiteralPath $distDir) {
    $candidates += Get-ChildItem -LiteralPath $distDir -Filter '*.apk' -File | Where-Object {
      $_.Name -notmatch '(^|[-_])debug([-_.]|$)'
    }
  }
  $releaseApk = Join-Path $mobileRnRoot 'android\app\build\outputs\apk\release\app-release.apk'
  if (Test-Path -LiteralPath $releaseApk) {
    $candidates += Get-Item -LiteralPath $releaseApk
  }
  $latest = $candidates | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  if (-not $latest) {
    throw "No release APK found in mobile-rn/dist/ or android/app/build/outputs/apk/release/. Pass -Apk <path>."
  }
  return $latest.FullName
}

function Get-ConnectedDevices {
  param([string]$AdbPath)
  $raw = & $AdbPath devices -l
  if ($LASTEXITCODE -ne 0) { throw "Failed to query adb devices." }
  $devices = @()
  foreach ($line in $raw) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('List of devices') -or $trimmed.StartsWith('*')) { continue }
    if ($trimmed -match '^(\S+)\s+(device|unauthorized|offline|authorizing|recovery|sideload)\b(.*)$') {
      $id = $Matches[1]
      $state = $Matches[2]
      $meta = $Matches[3].Trim()
      $model = ''
      if ($meta -match '\bmodel:(\S+)') { $model = $Matches[1] }
      $devices += [PSCustomObject]@{
        Id = $id
        State = $state
        Model = $model
        IsEmulator = ($id -like 'emulator-*')
        Raw = $trimmed
      }
    }
  }
  return $devices
}

function Resolve-TargetDevice {
  param(
    [array]$Devices,
    [string]$RequestedSerial
  )
  if ($RequestedSerial) {
    $match = $Devices | Where-Object { $_.Id -eq $RequestedSerial } | Select-Object -First 1
    if (-not $match) {
      throw "Device '$RequestedSerial' is not connected. Run 'adb devices -l' to verify."
    }
    if ($match.State -ne 'device') {
      throw "Device '$RequestedSerial' is in state '$($match.State)'. Unlock phone and accept USB debugging prompt."
    }
    return $match
  }

  $physical = @($Devices | Where-Object { -not $_.IsEmulator })
  $ready = @($physical | Where-Object { $_.State -eq 'device' })
  if ($ready.Count -eq 0) {
    $pending = @($physical | Where-Object { $_.State -ne 'device' })
    if ($pending.Count -gt 0) {
      $summary = ($pending | ForEach-Object { "$($_.Id) ($($_.State))" }) -join ', '
      throw "Physical device not ready: $summary. Unlock the phone and allow USB debugging."
    }
    throw "No physical Android device detected (emulators are excluded unless passed via -Serial)."
  }
  if ($ready.Count -gt 1) {
    $list = ($ready | ForEach-Object { "  - $($_.Id) ($($_.Model))" }) -join "`n"
    throw "Multiple physical devices connected. Pass -Serial <id>:`n$list"
  }
  return $ready[0]
}

$sdkRoot = Resolve-SdkRoot
$adb = Resolve-Tool -SdkRoot $sdkRoot -Kind 'adb'
$apksigner = Resolve-Tool -SdkRoot $sdkRoot -Kind 'apksigner'
$aapt = Resolve-Tool -SdkRoot $sdkRoot -Kind 'aapt'
$apkPath = Resolve-ApkPath -ExplicitApk $Apk
$sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $apkPath).Hash

Write-Host "APK: $apkPath"
Write-Host "SHA256: $sha256"

# Verify APK signature and package metadata before touching the device.
$sigOutput = & $apksigner verify --verbose $apkPath 2>&1
if ($LASTEXITCODE -ne 0) {
  $sigText = ($sigOutput | Out-String).Trim()
  throw "APK signature verification failed:`n$sigText"
}

$badging = & $aapt dump badging $apkPath 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "aapt dump badging failed for $apkPath"
}
$pkgLine = ($badging | Select-String -Pattern "^package:" | Select-Object -First 1).Line
if (-not $pkgLine -or $pkgLine -notmatch "name='([^']+)'") {
  throw "Unable to read package name from $apkPath"
}
$apkPackage = $Matches[1]
if ($apkPackage -ne $PackageName) {
  throw "Package mismatch: expected '$PackageName', got '$apkPackage'."
}
$verName = if ($pkgLine -match "versionName='([^']+)'") { $Matches[1] } else { '?' }
$verCode = if ($pkgLine -match "versionCode='([^']+)'") { $Matches[1] } else { '?' }
Write-Host "Verified: $apkPackage v$verName ($verCode)"

$devices = @(Get-ConnectedDevices -AdbPath $adb)
$target = Resolve-TargetDevice -Devices $devices -RequestedSerial $Serial
$label = if ($target.Model) { "$($target.Id) ($($target.Model))" } else { $target.Id }
Write-Host "Target device: $label"

# Upgrade install (-r) preserves existing user data; never auto-uninstall on conflict.
$installOutput = (& $adb -s $target.Id install -r $apkPath 2>&1 | Out-String).Trim()
Write-Host $installOutput
if ($LASTEXITCODE -ne 0 -or $installOutput -match 'INSTALL_FAILED_') {
  if ($installOutput -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE') {
    throw "Install blocked by signing key mismatch (INSTALL_FAILED_UPDATE_INCOMPATIBLE). Local app data was left untouched."
  }
  throw "adb install -r failed (exit $LASTEXITCODE). Check phone screen for USB install confirmation."
}

$pkgInfo = & $adb -s $target.Id shell dumpsys package $PackageName |
  Select-String -Pattern 'versionCode=|versionName=|lastUpdateTime=' |
  ForEach-Object { $_.Line.Trim() }
Write-Host "Installed package state:"
$pkgInfo | ForEach-Object { Write-Host "  $_" }

if ($Launch) {
  Write-Host "Launching $PackageName..."
  & $adb -s $target.Id shell monkey -p $PackageName -c android.intent.category.LAUNCHER 1 | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to launch $PackageName on $($target.Id)."
  }
}
