# ==============================================================================
# start_api.ps1 — Lumina Edge API Server Launcher (Windows PowerShell)
# All settings read from config.json. No UI launched — API only.
# Usage: .\start_api.ps1 [-Model "models\model.gguf"] [-Port 8090]
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
        $config = Get-Content "config.json" -Raw | ConvertFrom-Json
        $val = $config.$Key
        return if ($null -eq $val) { $Default } else { $val }
    } catch {
        return $Default
    }
}

$ConfigModel = Get-ConfigValue "model" ""
$StartupDefault = Get-ConfigValue "startup.default_model" ""
$ConfigPort = Get-ConfigValue "api_port" 8090

$FinalModel = if ($Model) { $Model } else {
    if ($StartupDefault) { $StartupDefault } else { $ConfigModel }
}
$FinalPort = if ($Port -gt 0) { $Port } else { $ConfigPort }

if (-not $FinalModel) {
    $gguf = Get-ChildItem "models\*.gguf" -ErrorAction SilentlyContinue | Select-Object -First 1
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

$ModelPath = if ([System.IO.Path]::IsPathRooted($FinalModel)) {
    $FinalModel
} else {
    Join-Path $Root "models" $FinalModel
}

if (-not (Test-Path $ModelPath)) {
    Write-Host "ERROR: Model not found: $ModelPath" -ForegroundColor Red
    Write-Host "  Place a .gguf file in models\ and try again."
    exit 1
}

$CtxSize = Get-ConfigValue "ctx_size" 16384
$NGpuLayers = Get-ConfigValue "n_gpu_layers" 15
$BatchSize = Get-ConfigValue "batch_size" 256
$UbatchSize = Get-ConfigValue "ubatch_size" 256
$Temperature = Get-ConfigValue "temperature" 0.7
$TopP = Get-ConfigValue "top_p" 0.9
$TopK = Get-ConfigValue "top_k" 40
$RepeatPenalty = Get-ConfigValue "repeat_penalty" 1.1
$MinP = Get-ConfigValue "min_p" 0.05
$HttpThreads = Get-ConfigValue "http_threads" 2
$FlashAttn = Get-ConfigValue "flash_attn" $true
$UseMlock = Get-ConfigValue "use_mlock" $true
$NoMmap = Get-ConfigValue "no_mmap" $true
$ContBatching = Get-ConfigValue "cont_batching" $true

Write-Host ""
Write-Host "Lumina Edge API Server (Windows)" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host "  Model:       $ModelPath" -ForegroundColor Green
Write-Host "  Port:        $FinalPort" -ForegroundColor Green
Write-Host "  Ctx Size:    $CtxSize" -ForegroundColor Green
Write-Host "  GPU Layers:  $NGpuLayers" -ForegroundColor Green
Write-Host ""

$LLAMA_SERVER = Join-Path $Root "bin" "llama-server.exe"
if (-not (Test-Path $LLAMA_SERVER)) {
    Write-Host "ERROR: llama-server.exe not found in bin\" -ForegroundColor Red
    Write-Host "  Download llama.cpp binaries from: https://github.com/ggml-org/llama.cpp/releases/latest"
    exit 1
}

# Tool calling requires a model with a Jinja chat template that includes
# tool_call support. Recommended: Phi-4-mini, Gemma3-4B, Llama-3.2-3B (GGUF).
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
    "--jinja"
)

if ($FlashAttn -eq $true) { $Arguments += "--flash-attn" }
if ($UseMlock -eq $true) { $Arguments += "--mlock" }
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
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$FinalPort/v1/models" -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($resp.StatusCode -eq 200) {
            $Ready = $true
            break
        }
    } catch { }
}

if ($Ready) {
    Write-Host "Lumina Edge API ready!" -ForegroundColor Green
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
