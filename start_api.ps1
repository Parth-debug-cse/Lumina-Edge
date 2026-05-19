# ==============================================================================
# start_api.ps1 - Lumina Edge Backend Launcher (Windows PowerShell)
# Starts llama-server directly. All settings read from config.json.
# Usage: .\start_api.ps1 [-Model "models\model.gguf"] [-Port 8091]
# ==============================================================================

[CmdletBinding()]
param(
    [string]$Model = "",
    [int]$Port = 0
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Root = $ScriptDir
Set-Location $Root

function Get-ConfigValue {
    param([string]$Key, $Default)
    try {
        $configPath = Join-Path $Root "config.json"
        if (-not (Test-Path $configPath)) { return $Default }
        $config = Get-Content $configPath -Raw | ConvertFrom-Json
        $value = $config
        $Key.Split('.') | ForEach-Object {
            if ($null -ne $value -and $null -ne $value.$_) {
                $value = $value.$_
            } else {
                $value = $null
            }
        }
        if ($null -ne $value) { return $value }
    } catch {}
    return $Default
}

$ConfigModel = Get-ConfigValue "model" ""
$StartupDefault = Get-ConfigValue "startup.default_model" ""
$ConfigPort = Get-ConfigValue "backend_port" 8091

$FinalModel = if ($Model) { $Model } else {
    if ($StartupDefault) { $StartupDefault } else { $ConfigModel }
}
$FinalPort = if ($Port -gt 0) { $Port } else { $ConfigPort }

if (-not $FinalModel) {
    $gguf = Get-ChildItem (Join-Path $Root "models\*.gguf") -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($gguf) {
        $FinalModel = $gguf.FullName
        Write-Host "[Lumina] Auto-detected model: $FinalModel" -ForegroundColor Cyan
    }
}

if (-not $FinalModel) {
    Write-Host "ERROR: No model specified." -ForegroundColor Red
    Write-Host "  Place a .gguf file in models\ and set 'model' in config.json, or:"
    Write-Host "  .\start_api.ps1 -Model models\your-model.gguf"
    exit 1
}

# Resolve model path: only prepend models\ if not already absolute or prefixed
if ([System.IO.Path]::IsPathRooted($FinalModel) -or
    $FinalModel -match '^models[\\/]' -or
    $FinalModel -match '^\.[\\/]' -or
    $FinalModel -match '^\.\.' ) {
    $ModelPath = $FinalModel
} else {
    $ModelPath = Join-Path $Root "models" $FinalModel
}

if (-not (Test-Path $ModelPath)) {
    Write-Host "ERROR: Model not found: $ModelPath" -ForegroundColor Red
    Write-Host "  Place a .gguf file in models\ and try again."
    exit 1
}

$CtxSize = Get-ConfigValue "ctx_size" 4096
$NGpuLayers = Get-ConfigValue "n_gpu_layers" 0
$BatchSize = Get-ConfigValue "batch_size" 256
$UbatchSize = Get-ConfigValue "ubatch_size" 256
$Temperature = Get-ConfigValue "temperature" 0.7
$TopP = Get-ConfigValue "top_p" 0.9
$TopK = Get-ConfigValue "top_k" 40
$RepeatPenalty = Get-ConfigValue "repeat_penalty" 1.1
$MinP = Get-ConfigValue "min_p" 0.05
$HttpThreads = Get-ConfigValue "http_threads" 2
$FlashAttn = Get-ConfigValue "flash_attn" $true
$NoMmap = Get-ConfigValue "no_mmap" $true
$ContBatching = Get-ConfigValue "cont_batching" $true
$KvCacheTypeK = Get-ConfigValue "kv_cache_type_k" "q4_0"
$KvCacheTypeV = Get-ConfigValue "kv_cache_type_v" "q4_0"

Write-Host ""
Write-Host "Lumina Edge Backend (Windows)" -ForegroundColor Cyan
Write-Host "=============================" -ForegroundColor Cyan
Write-Host "  Model:       $ModelPath" -ForegroundColor Green
Write-Host "  Port:        $FinalPort" -ForegroundColor Green
Write-Host "  Ctx Size:    $CtxSize" -ForegroundColor Green
Write-Host "  GPU Layers:  $NGpuLayers" -ForegroundColor Green
Write-Host ""

# Install Lumina Scout dependencies
$ScoutReqs = Join-Path $Root "lumina_scout\requirements.txt"
if (Test-Path $ScoutReqs) {
    Write-Host "Installing Lumina Scout dependencies..." -ForegroundColor Cyan
    pip install -q -r $ScoutReqs 2>&1 | Out-Null
    Write-Host "  Scout dependencies installed" -ForegroundColor Green
}

$LLAMA_SERVER = Join-Path $Root "bin\llama-server.exe"
if (-not (Test-Path $LLAMA_SERVER)) {
    Write-Host "ERROR: llama-server.exe not found in bin\" -ForegroundColor Red
    Write-Host "  Download llama.cpp binaries from: https://github.com/ggml-org/llama.cpp/releases/latest"
    exit 1
}

$Arguments = @(
    "-m", $ModelPath,
    "--port", $FinalPort,
    "--host", "127.0.0.1",
    "--ctx-size", $CtxSize,
    "--n-gpu-layers", $NGpuLayers,
    "--batch-size", $BatchSize,
    "--ubatch-size", $UbatchSize,
    "--threads-http", $HttpThreads,
    "--temperature", $Temperature,
    "--top-p", $TopP,
    "--top-k", $TopK,
    "--repeat-penalty", $RepeatPenalty,
    "--min-p", $MinP,
    "--cache-type-k", $KvCacheTypeK,
    "--cache-type-v", $KvCacheTypeV,
    "--jinja"
)

if ($FlashAttn -eq $true) { $Arguments += "--flash-attn" }
if ($NoMmap -eq $true) { $Arguments += "--no-mmap" }
if ($ContBatching -eq $true) { $Arguments += "--cont-batching" }

Write-Host "Starting llama-server..." -ForegroundColor Cyan
Write-Host "  Binary: $LLAMA_SERVER" -ForegroundColor Gray
Write-Host "  Args: $($Arguments -join ' ')" -ForegroundColor DarkGray
Write-Host ""

$proc = Start-Process -FilePath $LLAMA_SERVER -ArgumentList $Arguments -NoNewWindow -PassThru

$Ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if ($proc.HasExited) {
        Write-Host "ERROR: llama-server exited unexpectedly." -ForegroundColor Red
        exit 1
    }
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$FinalPort/v1/models" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) {
            $Ready = $true
            break
        }
    } catch { }
}

if ($Ready) {
    Write-Host "Lumina Edge backend ready!" -ForegroundColor Green
    Write-Host "  Endpoint:  http://127.0.0.1:$FinalPort" -ForegroundColor Cyan
    Write-Host "  Docs:      http://127.0.0.1:$FinalPort/docs" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Press Ctrl+C to stop." -ForegroundColor Yellow

    try {
        while (-not $proc.HasExited) {
            Start-Sleep -Seconds 1
        }
    } catch {
        Write-Host "Stopping..." -ForegroundColor Yellow
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "ERROR: Server failed to start within 30 seconds." -ForegroundColor Red
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    exit 1
}
