param([Parameter(Mandatory=$true)][string]$RuntimeRoot)
$ErrorActionPreference = 'Stop'
$RuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$config = Join-Path $RuntimeRoot 'retrieval.env'
New-Item -ItemType Directory -Force -Path $RuntimeRoot,"$RuntimeRoot\downloads","$RuntimeRoot\postgres","$RuntimeRoot\pgvector","$RuntimeRoot\data","$RuntimeRoot\logs","$RuntimeRoot\models","$RuntimeRoot\cache","$RuntimeRoot\pids" | Out-Null
if (-not (Test-Path $config)) {
    $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36)).TrimEnd('=').Replace('+','x').Replace('/','y')
    @"
EXERCISE_SEARCH_VERSION=v2
EXERCISE_SEARCH_PG_URL=postgresql://opengym_retrieval:$password@127.0.0.1:55432/opengym_retrieval
EXERCISE_SEARCH_EMBEDDING_BACKEND=local
EXERCISE_SEARCH_RERANK_BACKEND=local
EXERCISE_SEARCH_LOCAL_MODEL_URL=http://127.0.0.1:8765
EXERCISE_SEARCH_EMBEDDING_TIMEOUT_MS=5000
EXERCISE_SEARCH_PG_TIMEOUT_MS=3000
EXERCISE_SEARCH_RERANK_TIMEOUT_MS=15000
RETRIEVAL_RUNTIME_ROOT=$($RuntimeRoot.Replace('\','/'))
RETRIEVAL_EMBEDDING_MODEL=BAAI/bge-m3
RETRIEVAL_RERANK_MODEL=BAAI/bge-reranker-v2-m3
RETRIEVAL_BATCH_SIZE=32
PORT=13000
DATA_DIR=$($RuntimeRoot.Replace('\','/'))/api-data
ORIGIN=http://localhost:15173
PASSWORD_LOGIN=1
# Set the instance Agent credential in this runtime file.
# DEEPSEEK_API_KEY=
# DEEPSEEK_MODEL=deepseek-flash
"@ | Set-Content -LiteralPath $config -Encoding utf8
    Write-Host "Created configuration at $config; review API/VLM settings before starting the API."
}
$pgZip = Join-Path $RuntimeRoot 'downloads\postgresql-18.1-1-windows-x64-binaries.zip'
if (-not (Test-Path $pgZip)) { Invoke-WebRequest 'https://get.enterprisedb.com/postgresql/postgresql-18.1-1-windows-x64-binaries.zip' -OutFile $pgZip }
$pgBin = Join-Path $RuntimeRoot 'postgres\pgsql\bin'
if (-not (Test-Path (Join-Path $pgBin 'initdb.exe'))) { Expand-Archive -LiteralPath $pgZip -DestinationPath "$RuntimeRoot\postgres" -Force }
$pgConfig = Join-Path $pgBin 'pg_config.exe'
$env:PGROOT = Split-Path $pgBin -Parent
if (-not (Test-Path (Join-Path $pgBin 'pg_config.exe'))) { throw "PostgreSQL ZIP did not contain pg_config: $pgBin" }
& $pgConfig --version
$extensionDir=Join-Path ((& $pgConfig --sharedir).Trim()) 'extension'
$vectorDll=Join-Path ((& $pgConfig --pkglibdir).Trim()) 'vector.dll'
$vectorControl=Join-Path $extensionDir 'vector.control'
$vectorInstalled=(Test-Path -LiteralPath $vectorDll) -and
    (Test-Path -LiteralPath (Join-Path $extensionDir 'vector--0.8.7.sql')) -and
    (Test-Path -LiteralPath $vectorControl) -and
    ((Get-Content -LiteralPath $vectorControl -Raw) -match "(?m)^default_version\s*=\s*'0\.8\.7'\s*$")
if (-not $vectorInstalled) {
    $includeDir=(& $pgConfig --includedir-server).Trim()
    if (-not (Test-Path -LiteralPath (Join-Path $includeDir 'postgres.h'))) {
        throw "The PostgreSQL server headers were not found in $includeDir."
    }
    $vectorZip=Join-Path $RuntimeRoot 'downloads\pgvector-v0.8.7.zip'
    $vectorRoot=Join-Path $RuntimeRoot 'pgvector\pgvector-0.8.7'
    if (-not (Test-Path -LiteralPath $vectorZip)) {
        Invoke-WebRequest 'https://github.com/pgvector/pgvector/archive/refs/tags/v0.8.7.zip' -OutFile $vectorZip
    }
    if (-not (Test-Path -LiteralPath (Join-Path $vectorRoot 'Makefile.win'))) {
        Expand-Archive -LiteralPath $vectorZip -DestinationPath (Join-Path $RuntimeRoot 'pgvector') -Force
    }
    $vcvars=Join-Path $env:ProgramFiles 'Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path -LiteralPath $vcvars)) {
        $vcvars='D:\dev\.tools\VSBuildTools\VC\Auxiliary\Build\vcvars64.bat'
    }
    if (-not (Test-Path -LiteralPath $vcvars)) { throw 'Visual Studio x64 Build Tools are required to compile pgvector.' }
    $build="call `"$vcvars`" && set `"PGROOT=$env:PGROOT`" && nmake /F Makefile.win && nmake /F Makefile.win install"
    Push-Location -LiteralPath $vectorRoot
    try {
        & $env:ComSpec /d /s /c $build
        if ($LASTEXITCODE -ne 0) { throw 'pgvector 0.8.7 did not compile/install for PostgreSQL 18.' }
    } finally { Pop-Location }
}
$configText=Get-Content -LiteralPath $config -Raw
$embeddingSetting=[regex]::Match($configText,'(?m)^EXERCISE_SEARCH_EMBEDDING_BACKEND=(.*)$')
$rerankSetting=[regex]::Match($configText,'(?m)^EXERCISE_SEARCH_RERANK_BACKEND=(.*)$')
$loadEmbedding=if($embeddingSetting.Success){$embeddingSetting.Groups[1].Value.Trim() -eq 'local'}else{$true}
$loadRerank=if($rerankSetting.Success){$rerankSetting.Groups[1].Value.Trim() -eq 'local'}else{$true}
$pyInstall = Join-Path $RuntimeRoot 'python312'
$env:UV_PYTHON_INSTALL_DIR = $pyInstall
$env:UV_CACHE_DIR = Join-Path $RuntimeRoot 'cache\uv'
$uv = (Get-Command uv.exe -ErrorAction Stop).Source
if ($loadEmbedding -or $loadRerank) {
    & $uv python install --install-dir $pyInstall --no-registry 3.12.16
    if ($LASTEXITCODE -ne 0) { throw 'uv could not install isolated Python 3.12' }
    $env:UV_PROJECT_ENVIRONMENT = Join-Path $RuntimeRoot 'venv'
    $env:HF_HOME = Join-Path $RuntimeRoot 'models\huggingface'
    New-Item -ItemType Directory -Force -Path $env:UV_PROJECT_ENVIRONMENT,$env:HF_HOME | Out-Null
    Push-Location (Join-Path $PSScriptRoot '..\..\services\retrieval-model')
    try {
        & $uv sync --locked --inexact --python (Join-Path $pyInstall 'cpython-3.12.16-windows-x86_64-none\python.exe') --no-install-package torch
        if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed; see ROCm compatibility and uv output.' }
        $python = Join-Path $env:UV_PROJECT_ENVIRONMENT 'Scripts\python.exe'
        & $uv pip install --python $python https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_core-7.2.1-py3-none-win_amd64.whl https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_devel-7.2.1-py3-none-win_amd64.whl https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm_sdk_libraries_custom-7.2.1-py3-none-win_amd64.whl https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/rocm-7.2.1.tar.gz
        if ($LASTEXITCODE -ne 0) { throw 'AMD ROCm runtime component installation failed.' }
        & $uv pip install --python $python --no-deps 'https://repo.radeon.com/rocm/windows/rocm-rel-7.2.1/torch-2.9.1%2Brocm7.2.1-cp312-cp312-win_amd64.whl'
        if ($LASTEXITCODE -ne 0) { throw 'AMD PyTorch wheel installation failed.' }
        & $uv run --no-sync python -c "import torch; print('torch',torch.__version__,'cuda_available',torch.cuda.is_available(),'hip',torch.version.hip)"
        if ($LASTEXITCODE -ne 0) { throw 'PyTorch import/device probe failed' }
        $modelStatements=@()
        if($loadEmbedding){$modelStatements += "snapshot_download('BAAI/bge-m3', revision='5617a9f61b028005a4858fdac845db406aefb181')"}
        if($loadRerank){$modelStatements += "snapshot_download('BAAI/bge-reranker-v2-m3', revision='953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e')"}
        $modelCode='from huggingface_hub import snapshot_download; '+($modelStatements -join '; ')
        & $uv run --no-sync python -c $modelCode
        if ($LASTEXITCODE -ne 0) { throw 'Pinned BAAI model download failed.' }
    } finally { Pop-Location }
    Write-Host "PostgreSQL 18, pgvector 0.8.7, isolated Python/ROCm and selected pinned models are prepared under $RuntimeRoot."
} else {
    Write-Host "PostgreSQL 18 and pgvector 0.8.7 are prepared under $RuntimeRoot; both inference backends are remote, so local Python/model dependencies were skipped."
}
