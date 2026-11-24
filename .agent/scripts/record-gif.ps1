<#
.SYNOPSIS
  录制 Android 模拟器/真机真实交互或将浏览器录屏 (.webm/.mp4) 转换为高清晰度调色板 GIF，用于前端硬验收证据落盘。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Out,

  [string]$Serial = '',

  [ValidateRange(2, 60)]
  [int]$Seconds = 8,

  [string]$InputVideo = '',

  [ValidateRange(240, 1080)]
  [int]$Width = 420,

  [ValidateRange(6, 24)]
  [int]$Fps = 12
)

$ErrorActionPreference = 'Stop'

$ffmpegCmd = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ffmpegCmd) {
  throw '未检测到 ffmpeg（PATH 中不存在 ffmpeg），请先安装 ffmpeg（如 winget install Gyan.FFmpeg）后再转换 GIF。'
}

$outFull = [System.IO.Path]::GetFullPath($Out)
$outDir = Split-Path -Parent $outFull
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$tempVideo = $null
try {
  if (-not [string]::IsNullOrWhiteSpace($InputVideo)) {
    if (-not (Test-Path -LiteralPath $InputVideo)) {
      throw "输入视频文件不存在: $InputVideo"
    }
    $sourceVideo = (Resolve-Path -LiteralPath $InputVideo).Path
  } elseif (-not [string]::IsNullOrWhiteSpace($Serial)) {
    $adb = 'adb'
    $rnAdb = Join-Path $env:LOCALAPPDATA 'RnToolchain\android-sdk\platform-tools\adb.exe'
    if (Test-Path -LiteralPath $rnAdb) { $adb = $rnAdb }
    $remoteMp4 = "/sdcard/opengym_accept_$([guid]::NewGuid().ToString('N').Substring(0,8)).mp4"
    $tempVideo = Join-Path ([System.IO.Path]::GetTempPath()) "opengym_capture_$([guid]::NewGuid().ToString('N').Substring(0,8)).mp4"
    Write-Host "开始在设备 $Serial 录制真实交互 ($Seconds 秒)..." -ForegroundColor Cyan
    & $adb -s $Serial shell screenrecord --time-limit $Seconds --bit-rate 4000000 $remoteMp4
    if ($LASTEXITCODE -ne 0) { throw "adb screenrecord 失败 (exit=$LASTEXITCODE)" }
    & $adb -s $Serial pull $remoteMp4 $tempVideo | Out-Null
    & $adb -s $Serial shell rm -f $remoteMp4 | Out-Null
    $sourceVideo = $tempVideo
  } else {
    throw '必须提供 -Serial <Android序列号> 实时录制，或提供 -InputVideo <视频路径> 进行转换。'
  }

  $vf = "fps=$Fps,scale=${Width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
  & $ffmpegCmd.Source -y -loglevel error -i $sourceVideo -vf $vf -loop 0 $outFull
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg GIF 转换失败 (exit=$LASTEXITCODE)" }

  $bytes = [System.IO.File]::ReadAllBytes($outFull)
  if ($bytes.Length -lt 6) { throw '生成的 GIF 文件异常为空' }
  $header = [System.Text.Encoding]::ASCII.GetString($bytes, 0, 6)
  if ($header -notin @('GIF89a', 'GIF87a')) {
    throw "输出文件头非法 ($header)，非有效 GIF"
  }
  $sizeKb = [math]::Round($bytes.Length / 1KB, 1)
  Write-Host "真实操作 GIF 已生成: $outFull ($sizeKb KB)" -ForegroundColor Green
} finally {
  if ($tempVideo -and (Test-Path -LiteralPath $tempVideo)) {
    Remove-Item -Force -LiteralPath $tempVideo -ErrorAction SilentlyContinue
  }
}
