<#
.SYNOPSIS
  start-goose.ps1 — Single-command entry point for the full agentic workflow.
   1. Starts Lumina Edge API server on port 8090
   2. Waits for it to be ready
   3. Launches Goose (connected to local LLM)

.DESCRIPTION
  Usage: .\start-goose.ps1
         .\start-goose.ps1 -Model "models\model.gguf"
#>

[CmdletBinding()]
param(
  [string]$Model = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Scripts = Join-Path $Root "scripts"
Set-Location $Root

function Write-Log    { Write-Host "[start-goose] $($args[0])" }
function Write-LogOk  { Write-Host "[start-goose] $($args[0])" -ForegroundColor Green }
function Write-LogErr { Write-Host "[start-goose] $($args[0])" -ForegroundColor Red }

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
function Get-ConfigValue {
  param([string]$Key, $Default)
  try {
    $config = Get-Content "config.json" -Raw | ConvertFrom-Json
    $parts = $Key -split '\.'
    $value = $config
    foreach ($part in $parts) {
      $value = $value.$part
    }
    return if ($null -eq $value) { $Default } else { $value }
  } catch {
    return $Default
  }
}

function Wait-Port {
  param([int]$Port, [int]$MaxSeconds = 60)
  for ($i = 0; $i -lt $MaxSeconds; $i++) {
    try {
      $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -TimeoutSec 2 -ErrorAction SilentlyContinue
      if ($resp -and $resp.data) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

# ------------------------------------------------------------------
# Determine model path
# ------------------------------------------------------------------
$ModelPath = if ($Model) { $Model } else { Get-ConfigValue "startup.default_model" "" }
if (-not $ModelPath) { $ModelPath = Get-ConfigValue "model" "" }
if (-not $ModelPath) {
  $gguf = Get-ChildItem "models\*.gguf" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($gguf) { $ModelPath = $gguf.FullName }
}
if (-not $ModelPath) {
  Write-LogErr "No model found. Place a .gguf file in models\ or specify -Model"
  exit 1
}

if (-not [System.IO.Path]::IsPathRooted($ModelPath)) {
  $ModelPath = Join-Path $Root $ModelPath
}

Write-Log "Model: $ModelPath"

# ------------------------------------------------------------------
# Start Lumina Edge API server
# ------------------------------------------------------------------
Write-Log "Starting Lumina Edge API server on port 8090..."

$LLAMA_SERVER = Join-Path $Root "bin" "llama-server.exe"
if (-not (Test-Path $LLAMA_SERVER)) {
  Write-LogErr "llama-server.exe not found at $LLAMA_SERVER"
  exit 1
}

$CtxSize = Get-ConfigValue "ctx_size" 16384
$NGpuLayers = Get-ConfigValue "n_gpu_layers" 99

$Arguments = @(
  "-m", $ModelPath,
  "--port", "8090",
  "--host", "127.0.0.1",
  "--ctx-size", $CtxSize,
  "--n-gpu-layers", $NGpuLayers
)

$LuminaProcess = Start-Process -FilePath $LLAMA_SERVER `
  -ArgumentList $Arguments `
  -NoNewWindow `
  -PassThru
Write-Log "  llama-server PID: $($LuminaProcess.Id)"

# ------------------------------------------------------------------
# Wait for server to be ready
# ------------------------------------------------------------------
Write-Log "Waiting for server to be ready..."
if (Wait-Port -Port 8090 -MaxSeconds 60) {
  Write-LogOk "Lumina Edge API ready at http://127.0.0.1:8090/v1"
} else {
  Write-LogErr "Lumina Edge API failed to start within 60 seconds"
  Stop-Process -Id $LuminaProcess.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

# ------------------------------------------------------------------
# All set — print instructions for Goose Desktop
# ------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================"
Write-Host "  Lumina Edge API is ready for Goose"
Write-Host "============================================================"
Write-Host ""
Write-LogOk "Lumina Edge API ready at http://localhost:8090/v1"
Write-Host "Open Goose Desktop and select: Lumina Edge -> Qwen3-4B-Instruct-2507-4bit"
Write-Host "Press Ctrl+C to stop the API server."
Write-Host ""

# Trap Ctrl+C for clean shutdown
$cleanup = {
  Write-Host ""
  Write-Log "Shutting down..."
  Stop-Process -Id $LuminaProcess.Id -Force -ErrorAction SilentlyContinue
  Write-LogOk "Done"
  exit 0
}
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $cleanup | Out-Null

# Wait for the Lumina server process
$LuminaProcess.WaitForExit()
