<#
.SYNOPSIS
  校验 openGym 子系统路由治理规则：
  1. AGENTS.md、docs/README.md 与 docs/subsystem/*/README.md 均不超过 300 行；
  2. 核心路由、规范与技能文档内的本地相对链接全部真实存在（自动跳过代码块）；
  3. .agent/lessons.md 中不存在累计次数 >= 3 但仍处于 tracking 未升格的规则。
#>
[CmdletBinding()]
param(
  [int]$MaxRouterLines = 300
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$failures = New-Object 'System.Collections.Generic.List[string]'

function Get-RepoRelativePath([string]$FullPath) {
  $prefix = $repoRoot.TrimEnd('\', '/') + '\'
  if ($FullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $FullPath.Substring($prefix.Length)
  }
  return $FullPath
}

Write-Host "== [1/3] 检查路由 README 行数上限 (<= $MaxRouterLines 行) ==" -ForegroundColor Cyan
$routerFiles = @(
  (Join-Path $repoRoot 'AGENTS.md'),
  (Join-Path $repoRoot 'docs\README.md')
)
$subsystemReadmes = Get-ChildItem -Path (Join-Path $repoRoot 'docs\subsystem') -Filter 'README.md' -Recurse
$routerFiles += $subsystemReadmes.FullName

foreach ($file in $routerFiles) {
  if (-not (Test-Path $file)) {
    $failures.Add("缺失路由文件: $file")
    continue
  }
  $lineCount = @(Get-Content -LiteralPath $file -Encoding UTF8).Count
  $rel = Get-RepoRelativePath $file
  if ($lineCount -gt $MaxRouterLines) {
    $failures.Add("行数超限 ($lineCount > $MaxRouterLines): $rel")
    Write-Host "  [FAIL] $rel ($lineCount lines)" -ForegroundColor Red
  } else {
    Write-Host "  [OK]   $rel ($lineCount lines)" -ForegroundColor Green
  }
}

Write-Host "`n== [2/3] 检查治理、路由与技能文档相对链接有效性 ==" -ForegroundColor Cyan
$docTargets = @()
$docTargets += $routerFiles
$docTargets += @(
  (Join-Path $repoRoot 'README.md'),
  (Join-Path $repoRoot 'docs\code-standards.md'),
  (Join-Path $repoRoot 'docs\RN_UI_DESIGN_SYSTEM.md'),
  (Join-Path $repoRoot 'docs\RN_UI_SCREEN_MIGRATION.md'),
  (Join-Path $repoRoot 'docs\RN_UI_VISUAL_TESTING.md'),
  (Join-Path $repoRoot '.agent\lessons.md'),
  (Join-Path $repoRoot '.agent\notes\README.md'),
  (Join-Path $repoRoot '.agent\scripts\README.md')
)
$skillDocs = Get-ChildItem -Path (Join-Path $repoRoot '.agent\skill') -Filter '*.md' -Recurse -ErrorAction SilentlyContinue
if ($skillDocs) { $docTargets += $skillDocs.FullName }

$linkRegex = [regex]'!?\[[^\]]*\]\(([^)]+)\)'
$checkedLinks = 0

foreach ($doc in ($docTargets | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $doc)) { continue }
  $dir = Split-Path -Parent $doc
  $relDoc = Get-RepoRelativePath $doc
  $inFence = $false
  $lineNo = 0
  foreach ($line in (Get-Content -LiteralPath $doc -Encoding UTF8)) {
    $lineNo++
    if ($line -match '^\s*`{3,}') {
      $inFence = -not $inFence
      continue
    }
    if ($inFence) { continue }
    # Strip inline code spans before matching links
    $cleanLine = [regex]::Replace($line, '`[^`]*`', '')
    foreach ($m in $linkRegex.Matches($cleanLine)) {
      $rawTarget = $m.Groups[1].Value.Trim()
      if ($rawTarget -match '^(https?:|mailto:|tel:|conversation:|file:|#)') { continue }
      $pathPart = ($rawTarget -split '#')[0].Trim()
      if ([string]::IsNullOrWhiteSpace($pathPart)) { continue }
      $checkedLinks++
      $resolved = Join-Path $dir $pathPart
      if (-not (Test-Path -LiteralPath $resolved)) {
        $failures.Add("断链 ($relDoc`:$lineNo): '$rawTarget'")
        Write-Host "  [FAIL] $relDoc`:$lineNo -> $rawTarget" -ForegroundColor Red
      }
    }
  }
}
Write-Host "  已扫描本地链接数: $checkedLinks" -ForegroundColor Green

Write-Host "`n== [3/3] 检查 .agent/lessons.md 满 3 次脱水升格门禁 ==" -ForegroundColor Cyan
$lessonsPath = Join-Path $repoRoot '.agent\lessons.md'
if (-not (Test-Path -LiteralPath $lessonsPath)) {
  $failures.Add("缺失复盘账本: .agent/lessons.md")
} else {
  $pendingPromotions = 0
  foreach ($line in (Get-Content -LiteralPath $lessonsPath -Encoding UTF8)) {
    if ($line -match '^\|\s*`(L-\d+)`\s*\|') {
      $cols = $line.Trim('|') -split '\|'
      if ($cols.Count -ge 6) {
        $id = $cols[0].Trim().Trim('`')
        $countText = $cols[4].Trim()
        $statusText = $cols[5].Trim().Trim('`')
        $countVal = 0
        if ([int]::TryParse($countText, [ref]$countVal)) {
          if ($countVal -ge 3 -and $statusText -eq 'tracking') {
            $pendingPromotions++
            $failures.Add("lessons.md 条目 $id 累计已达 $countVal 次但仍处于 tracking，请脱水压缩为 1~2 句祈使句升格至 docs/code-standards.md")
            Write-Host "  [FAIL] $id (次数=$countVal, 状态=$statusText) 待升格" -ForegroundColor Red
          }
        }
      }
    }
  }
  if ($pendingPromotions -eq 0) {
    Write-Host "  [OK]   所有满 3 次规则均已升格至 docs/code-standards.md" -ForegroundColor Green
  }
}

if ($failures.Count -gt 0) {
  Write-Host "`n治理校验未通过 ($($failures.Count) 项问题):" -ForegroundColor Red
  foreach ($f in $failures) { Write-Host " - $f" -ForegroundColor Red }
  exit 1
}

Write-Host "`n全部治理门禁校验通过！" -ForegroundColor Green
exit 0
