param([Parameter(Mandatory=$true)][string]$RuntimeRoot)
$ErrorActionPreference='Stop'
$RuntimeRoot=[IO.Path]::GetFullPath($RuntimeRoot)
$pidDir=Join-Path $RuntimeRoot 'pids'
$pgBin=Join-Path $RuntimeRoot 'postgres\pgsql\bin'
$pgData=Join-Path $RuntimeRoot 'data\postgres'
$pythonRoot=(Join-Path $RuntimeRoot 'python312')+[IO.Path]::DirectorySeparatorChar

function Test-ProcessIdentity($Live,$Identity) {
    return $Live -and $Live.ExecutablePath -and
        [IO.Path]::GetFullPath($Live.ExecutablePath) -eq [IO.Path]::GetFullPath($Identity.ExecutablePath) -and
        $Live.CommandLine -eq $Identity.CommandLine -and
        ([DateTime]$Live.CreationDate).ToUniversalTime().Ticks -eq [long]$Identity.StartUtcTicks
}

function Stop-OwnedProcess([string]$Name,$Identity) {
    $filter="ProcessId = $($Identity.Pid)"
    $live=Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue
    if (-not $live) { return }
    if (-not (Test-ProcessIdentity $live $Identity)) {
        throw "PID identity mismatch for $Name; refusing to stop an unrelated process."
    }
    Stop-Process -Id $Identity.Pid -Force
    $deadline=[DateTime]::UtcNow.AddSeconds(15)
    do {
        $remaining=Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue
        $listener=Get-NetTCPConnection -State Listen -OwningProcess $Identity.Pid -ErrorAction SilentlyContinue
        if (-not (Test-ProcessIdentity $remaining $Identity) -and -not $listener) { return }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Owned $Name process or listener did not exit within 15 seconds; PID record retained."
}

foreach ($name in @('api','model')) {
    $pidFile=Join-Path $pidDir "$name.pid"
    if (-not (Test-Path -LiteralPath $pidFile)) { continue }
    $owner=Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    if ($name -eq 'model') {
        if ($owner.Worker) {
            Stop-OwnedProcess 'model worker' $owner.Worker
        } else {
            # A Windows venv launcher can own a child Python before the worker PID has been recorded.
            $parent=Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.Pid)" -ErrorAction SilentlyContinue
            if (Test-ProcessIdentity $parent $owner) {
                $workers=Get-CimInstance Win32_Process -Filter "ParentProcessId = $($owner.Pid)" | Where-Object {
                    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($pythonRoot,[StringComparison]::OrdinalIgnoreCase) -and
                    $_.CommandLine -like '*uvicorn*main:app*--port*8765*'
                }
                foreach ($worker in $workers) {
                    Stop-OwnedProcess 'model worker' @{
                        Pid=$worker.ProcessId
                        StartUtcTicks=([DateTime]$worker.CreationDate).ToUniversalTime().Ticks
                        ExecutablePath=$worker.ExecutablePath
                        CommandLine=$worker.CommandLine
                    }
                }
            }
        }
    }
    Stop-OwnedProcess $name $owner
    Remove-Item -LiteralPath $pidFile
}

$pgPidFile=Join-Path $pidDir 'postgres.pid'
if (Test-Path -LiteralPath $pgPidFile) {
    $owner=Get-Content -LiteralPath $pgPidFile -Raw | ConvertFrom-Json
    $live=Get-CimInstance Win32_Process -Filter "ProcessId = $($owner.Pid)" -ErrorAction SilentlyContinue
    if ($live) {
        $pgCommandLine=$live.CommandLine -replace '\\','/'
        $pgDataArgument=$pgData -replace '\\','/'
        if (-not (Test-ProcessIdentity $live $owner) -or $live.ExecutablePath -notmatch '\\postgres\.exe$' -or
            $pgCommandLine -notmatch [regex]::Escape($pgDataArgument)) {
            throw 'PostgreSQL PID identity mismatch; refusing to stop an unrelated process.'
        }
        & (Join-Path $pgBin 'pg_ctl.exe') -D $pgData -m fast -w stop
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL graceful stop failed.' }
    }
    Remove-Item -LiteralPath $pgPidFile
}
$legacyPasswordFile=Join-Path $RuntimeRoot 'data\pg-password.tmp'
if (Test-Path -LiteralPath $legacyPasswordFile) { Remove-Item -LiteralPath $legacyPasswordFile -Force }
Write-Host "Stopped processes owned by $RuntimeRoot."
