param([Parameter(Mandatory=$true)][string]$RuntimeRoot,[switch]$DatabaseOnly,[switch]$ModelsOnly)
$ErrorActionPreference = 'Stop'
$RuntimeRoot=[IO.Path]::GetFullPath($RuntimeRoot); $config=Join-Path $RuntimeRoot 'retrieval.env'
if (-not (Test-Path $config)) { throw "Missing $config; run Initialize-Retrieval.ps1 first." }
Get-Content -LiteralPath $config | Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object { $i=$_.IndexOf('='); [Environment]::SetEnvironmentVariable($_.Substring(0,$i),$_.Substring($i+1),'Process') }
if (-not $env:EXERCISE_SEARCH_EMBEDDING_BACKEND) { $env:EXERCISE_SEARCH_EMBEDDING_BACKEND='local' }
if (-not $env:EXERCISE_SEARCH_RERANK_BACKEND) { $env:EXERCISE_SEARCH_RERANK_BACKEND='local' }
$apiRoot=Split-Path $PSScriptRoot -Parent | Split-Path -Parent
$pidDir=Join-Path $RuntimeRoot 'pids'; $logDir=Join-Path $RuntimeRoot 'logs'; New-Item -ItemType Directory -Force -Path $pidDir,$logDir | Out-Null
function Start-OwnedProcess([string]$Name,[string]$File,[string[]]$Arguments,[string]$WorkingDirectory,[string]$ConfigurationTag='') {
    $pidFile=Join-Path $pidDir "$Name.pid"
    if (Test-Path $pidFile) {
        $old=Get-Content $pidFile -Raw | ConvertFrom-Json
        if ([string]$old.ConfigurationTag -ne $ConfigurationTag) { throw "The recorded $Name process uses different runtime settings; stop it before restarting." }
        $live=Get-CimInstance Win32_Process -Filter "ProcessId = $($old.Pid)" -ErrorAction SilentlyContinue
        if ($live) {
            $started=([DateTime]$live.CreationDate).ToUniversalTime().Ticks
            if ([IO.Path]::GetFullPath($live.ExecutablePath) -eq [IO.Path]::GetFullPath($old.ExecutablePath) -and $live.CommandLine -eq $old.CommandLine -and $started -eq [long]$old.StartUtcTicks) { return }
            throw "PID identity mismatch for recorded $Name process; refusing reuse."
        }
        Remove-Item -LiteralPath $pidFile
    }
    $argumentLine=($Arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' '
    $p=Start-Process -FilePath $File -ArgumentList $argumentLine -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir "$Name.out.log") -RedirectStandardError (Join-Path $logDir "$Name.err.log")
    Start-Sleep -Milliseconds 300
    $live=Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)" -ErrorAction Stop
    $started=([DateTime]$live.CreationDate).ToUniversalTime().Ticks
    [pscustomobject]@{Pid=$p.Id;StartUtcTicks=$started;ExecutablePath=$live.ExecutablePath;CommandLine=$live.CommandLine;ConfigurationTag=$ConfigurationTag} | ConvertTo-Json -Compress | Set-Content -LiteralPath $pidFile -NoNewline
}
$pgBin=Join-Path $RuntimeRoot 'postgres\pgsql\bin'; $pgData=Join-Path $RuntimeRoot 'data\postgres'
if ($env:EXERCISE_SEARCH_VERSION -eq 'v2') {
    if (-not (Test-Path (Join-Path $pgData 'PG_VERSION'))) {
        New-Item -ItemType Directory -Force -Path $pgData | Out-Null
        $pgUrl=[Uri]$env:EXERCISE_SEARCH_PG_URL; $userInfo=[Uri]::UnescapeDataString($pgUrl.UserInfo); $separator=$userInfo.IndexOf(':')
        if($separator -lt 1){throw 'The local PostgreSQL URL must include a username and password.'}
        $passwordFile=Join-Path $RuntimeRoot 'data\pg-password.tmp'
        Set-Content -LiteralPath $passwordFile -Value $userInfo.Substring($separator+1) -NoNewline -Encoding ascii
        try {
            & (Join-Path $pgBin 'initdb.exe') -D $pgData -U opengym_retrieval -A scram-sha-256 --pwfile $passwordFile --encoding=UTF8 --locale-provider=icu --icu-locale=zh-CN
            if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL initdb failed.' }
        } finally { Remove-Item -LiteralPath $passwordFile -Force -ErrorAction SilentlyContinue; $userInfo=$null; $passwordFile=$null }
    }
    $legacyPasswordFile=Join-Path $RuntimeRoot 'data\pg-password.tmp'
    if(Test-Path -LiteralPath $legacyPasswordFile){Remove-Item -LiteralPath $legacyPasswordFile -Force}
    $pgCtl=Join-Path $pgBin 'pg_ctl.exe'
    & $pgCtl -D $pgData status *> $null
    if ($LASTEXITCODE -ne 0) {
        $pgArgs=@('-D',$pgData,'-l',(Join-Path $logDir 'postgres.log'),'-o','-h 127.0.0.1 -p 55432','-w','-t','45','start')
        $argumentLine=($pgArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
        $pgStartup=Start-Process -FilePath $pgCtl -ArgumentList $argumentLine -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $logDir 'postgres-start.out.log') `
            -RedirectStandardError (Join-Path $logDir 'postgres-start.err.log')
        if (-not $pgStartup.WaitForExit(50000) -or $pgStartup.ExitCode -ne 0) {
            throw 'PostgreSQL failed to start; inspect runtime logs.'
        }
    }
    $pgPid=[int](Get-Content (Join-Path $pgData 'postmaster.pid') -TotalCount 1)
    $pgProcess=Get-CimInstance Win32_Process -Filter "ProcessId = $pgPid" -ErrorAction Stop
    $pgCommandLine=$pgProcess.CommandLine -replace '\\','/'
    $pgDataArgument=$pgData -replace '\\','/'
    if ($pgProcess.ExecutablePath -notmatch '\\postgres\.exe$' -or $pgCommandLine -notmatch [regex]::Escape($pgDataArgument)) { throw 'The PostgreSQL PID file does not identify this runtime cluster.' }
    $pgStarted=([DateTime]$pgProcess.CreationDate).ToUniversalTime().Ticks
    [pscustomobject]@{Pid=$pgPid;StartUtcTicks=$pgStarted;ExecutablePath=$pgProcess.ExecutablePath;CommandLine=$pgProcess.CommandLine} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $pidDir 'postgres.pid') -NoNewline
    $pgCtl=Join-Path $pgBin 'pg_isready.exe'; $ready=$false
    for($i=0;$i -lt 40;$i++){ & $pgCtl -h 127.0.0.1 -p 55432 *> $null; if($LASTEXITCODE -eq 0){$ready=$true;break}; Start-Sleep -Milliseconds 500 }
    if(-not $ready){throw 'PostgreSQL did not become ready; inspect runtime logs.'}
    $pgUrl=[Uri]$env:EXERCISE_SEARCH_PG_URL; $credential=$pgUrl.UserInfo.Split(':',2); $env:PGPASSWORD=[Uri]::UnescapeDataString($credential[1])
    $createdb=Join-Path $pgBin 'createdb.exe'; & $createdb -h 127.0.0.1 -p 55432 -U opengym_retrieval opengym_retrieval 2>$null
    $psql=Join-Path $pgBin 'psql.exe'; & $psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 55432 -U opengym_retrieval -d opengym_retrieval -c 'CREATE EXTENSION IF NOT EXISTS vector; CREATE EXTENSION IF NOT EXISTS pg_trgm;' *> $null
    if($LASTEXITCODE -ne 0){throw 'Could not create the retrieval database/extensions; check pgvector installation.'}
    $encoding=& $psql -At -h 127.0.0.1 -p 55432 -U opengym_retrieval -d opengym_retrieval -c 'SHOW server_encoding'
    $trgm=& $psql -At -h 127.0.0.1 -p 55432 -U opengym_retrieval -d opengym_retrieval -c "SELECT cardinality(show_trgm(U&'\5750\59FF\63A8\80F8')) > 0"
    if($encoding.Trim() -ne 'UTF8' -or $trgm.Trim() -ne 't'){throw 'PostgreSQL UTF8/Chinese trigram preflight failed.'}
    if($DatabaseOnly){Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue; Write-Host 'PostgreSQL 18 retrieval database ready on 127.0.0.1:55432 (UTF8, pgvector, pg_trgm, Chinese trigram).'; return}
    Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
    if ($env:EXERCISE_SEARCH_EMBEDDING_BACKEND -eq 'local' -or $env:EXERCISE_SEARCH_RERANK_BACKEND -eq 'local') {
        $loadEmbedding=if($env:EXERCISE_SEARCH_EMBEDDING_BACKEND -eq 'local'){'1'}else{'0'}
        $loadRerank=if($env:EXERCISE_SEARCH_RERANK_BACKEND -eq 'local'){'1'}else{'0'}
        $env:RETRIEVAL_LOAD_EMBEDDING=$loadEmbedding; $env:RETRIEVAL_LOAD_RERANK=$loadRerank
        $env:UV_PROJECT_ENVIRONMENT=Join-Path $RuntimeRoot 'venv'; $env:UV_CACHE_DIR=Join-Path $RuntimeRoot 'cache\uv'; $env:HF_HOME=Join-Path $RuntimeRoot 'models\huggingface'
        $modelDir=Join-Path $apiRoot 'services\retrieval-model'
        $python=Join-Path $RuntimeRoot 'venv\Scripts\python.exe'
        $modelConfigTag="embedding=$loadEmbedding;rerank=$loadRerank"
        Start-OwnedProcess 'model' $python @('-m','uvicorn','main:app','--host','127.0.0.1','--port','8765','--workers','1') $modelDir $modelConfigTag
        $healthy=$false; for($i=0;$i -lt 240;$i++){try{$h=Invoke-RestMethod 'http://127.0.0.1:8765/health' -TimeoutSec 2; $embedOk=($env:EXERCISE_SEARCH_EMBEDDING_BACKEND -ne 'local' -or $h.models.embedding.ready); $rerankOk=($env:EXERCISE_SEARCH_RERANK_BACKEND -ne 'local' -or $h.models.rerank.ready); if($h.status -eq 'ready' -and $embedOk -and $rerankOk){$healthy=$true;break}}catch{}; Start-Sleep -Seconds 2}
        if(-not $healthy){throw 'Model service did not become ready; inspect runtime logs.'}
        $modelPidFile=Join-Path $pidDir 'model.pid'
        $modelOwner=Get-Content -LiteralPath $modelPidFile -Raw | ConvertFrom-Json
        $listeners=@(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort 8765 -ErrorAction Stop |
            Select-Object -ExpandProperty OwningProcess -Unique)
        if ($listeners.Count -ne 1) { throw 'Could not identify the model listener.' }
        if ($listeners[0] -ne $modelOwner.Pid) {
            $worker=Get-CimInstance Win32_Process -Filter "ProcessId = $($listeners[0])" -ErrorAction Stop
            $pythonRoot=(Join-Path $RuntimeRoot 'python312')+[IO.Path]::DirectorySeparatorChar
            if ($worker.ParentProcessId -ne $modelOwner.Pid -or -not $worker.ExecutablePath -or
                -not $worker.ExecutablePath.StartsWith($pythonRoot,[StringComparison]::OrdinalIgnoreCase) -or
                $worker.CommandLine -notlike '*uvicorn*main:app*--port*8765*') {
                throw 'The model listener does not belong to this runtime.'
            }
            $modelOwner | Add-Member -Force -NotePropertyName Worker -NotePropertyValue ([pscustomobject]@{
                Pid=$worker.ProcessId
                StartUtcTicks=([DateTime]$worker.CreationDate).ToUniversalTime().Ticks
                ExecutablePath=$worker.ExecutablePath
                CommandLine=$worker.CommandLine
            })
            $modelOwner | ConvertTo-Json -Compress | Set-Content -LiteralPath $modelPidFile -NoNewline
        }
        if($ModelsOnly){Write-Host "Local model service ready on 127.0.0.1:8765; device=$($h.device), embedding=$($h.models.embedding.name), rerank=$($h.models.rerank.name)."; return}
    } elseif (Test-Path (Join-Path $pidDir 'model.pid')) {
        throw 'A local model process is recorded; stop it before switching both backends to remote.'
    }
    node "--env-file=$config" (Join-Path $apiRoot 'scripts\build-retrieval-index.mjs') --ensure
    if($LASTEXITCODE -ne 0){throw 'Retrieval index ensure failed.'}
}
if (-not (Test-Path (Join-Path $apiRoot 'api\dist\src\main.js'))) { throw 'API build is missing; build API before starting this instance.' }
$node=(Get-Command node.exe -ErrorAction Stop).Source
Start-OwnedProcess 'api' $node @("--env-file=$config",(Join-Path $apiRoot 'api\server.js')) $apiRoot
$apiPort=if($env:PORT){[int]$env:PORT}else{3000}
$apiReady=$false
for($attempt=0;$attempt -lt 30;$attempt++){
    try {
        $health=Invoke-RestMethod "http://127.0.0.1:$apiPort/api/health" -TimeoutSec 2
        if($health.ok){$apiReady=$true;break}
    } catch {}
    Start-Sleep -Milliseconds 400
}
if(-not $apiReady){throw 'API did not become ready; inspect runtime logs.'}
Write-Host "Started retrieval API using $($env:EXERCISE_SEARCH_VERSION) configuration. Runtime logs and PIDs: $RuntimeRoot"
