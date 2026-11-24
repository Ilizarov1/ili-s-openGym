<#
.SYNOPSIS
  在 .agent/notes/proposed/<Slug>/ 下创建标准需求与语义级变更声明脚手架。
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z0-9][a-z0-9-]{1,48}$')]
  [string]$Slug,

  [Parameter(Mandatory = $true)]
  [ValidateSet('mobile-rn', 'web-client', 'api-sync', 'ai-agent', 'catalogue', 'wearables', 'infra-ops')]
  [string]$Subsystem,

  [string]$Title = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$targetDir = Join-Path $repoRoot ".agent\notes\proposed\$Slug"
$evidenceDir = Join-Path $targetDir 'evidence'
$proposalFile = Join-Path $targetDir 'PROPOSAL.md'

if (Test-Path -LiteralPath $proposalFile) {
  throw "提案文件已存在: $proposalFile"
}

New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
$heading = if ([string]::IsNullOrWhiteSpace($Title)) { $Slug } else { $Title }
$today = (Get-Date).ToString('yyyy-MM-dd')

$template = @"
# $heading

- **创建日期**：$today
- **主属子系统**：[``$Subsystem``](../../../../docs/subsystem/$Subsystem/README.md)
- **当前阶段**：`proposed`（验收通过后整体迁入 `.agent/notes/implemented/$Slug/`）

## 1. 需求背景与验收条件

- **用户场景**：
- **编号验收条件**：
  - `A1`：前置条件 → 操作动作 → 可观察结果

## 2. 语义级变更声明（改代码前必填）

### 子系统：`$Subsystem`
- **涉及模块与真实入口**：
- **触发条件（Trigger）**：
- **改前 / 改后行为（Before / After）**：
  - **Before**：
  - **After**：
- **接口 / 状态 / 兼容性变化**：
- **失败模式与降级兜底**：
- **实测证据（Empirical Evidence）**：
  - **改前基线 / 复现证据**：
  - **改后闭环实测证据**：（测试命令输出 + 若涉及 GUI 变更须附 `evidence/<flow>.gif`）

## 3. UI 九维检查记录（如涉及用户可见界面）

- [ ] Token 与原语合规（零裸色值/字号/间距）
- [ ] 间距节奏、基线与 `tabular-nums` 数字防抖对齐
- [ ] 文本截断、多行折行、多语言词长膨胀与大字号适配
- [ ] 移动端触摸热区（≥ 44dp/px）与滑动手势解耦
- [ ] 视口宽度变化与软键盘弹出/收起时的输入框焦点及草稿保持
- [ ] 顶底安全区与浮动栏（TabBar / RestDock）留白避让
- [ ] 五态完备（空态 / 加载 / 常规与极值 / 离线异常 / 防连点）
- [ ] 暗色/浅色双主题对比度与减动效兼容
- [ ] 长列表虚拟化与滚动流畅度

## 4. 改后四步核对记录（改代码后必填）

1. **① 受影响子系统与真实运行时路径**：
2. **② 调用链行外副作用追踪**：
3. **③ 契约文档与源码链接反向同步**：
4. **④ 测试真实覆盖度核验**：

## 5. 前端硬验收证据（GUI 变更强制附真实操作 GIF）

<!-- 示例：![操作演示](evidence/demo.gif) -->
"@

[System.IO.File]::WriteAllText($proposalFile, $template, [System.Text.UTF8Encoding]::new($false))
Write-Host "已初始化提案目录与模板: $proposalFile" -ForegroundColor Green
