# ==============================================================================
# LUMINA EDGE :: Multi-Model Router Launcher (PowerShell)
# Launches multiple models in parallel with configurable routing policy
# Usage: .\lumina-multi-model.ps1 [-Gpu {vulkan|nvidia}] [-Policy {round-robin|load-balanced|first-available}]
# ==============================================================================

param(
    [ValidateSet("vulkan", "nvidia")]
    [string]$Gpu = "vulkan",
    [ValidateSet("round-robin", "load-balanced", "first-available")]
    [string]$Policy = "round-robin",
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host ""
    Write-Host "  LUMINA EDGE :: Multi-Model Router Launcher" -ForegroundColor Cyan
    Write-Host "  ==========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Usage: .\lumina-multi-model.ps1 [options]"
    Write-Host ""
    Write-Host "  Options:"
    Write-Host "    -Gpu       vulkan | nvidia (default: vulkan)"
    Write-Host "    -Policy    round-robin | load-balanced | first-available (default: round-robin)"
    Write-Host "    -Help      Show this help"
    Write-Host ""
    exit 0
}

# ==================================================
# PATHS & CONFIG
# ==================================================
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
$ModelsDir = Join-Path $RootDir "models"
$BinDir = Join-Path $RootDir "bin"
$ScriptsDir = Join-Path $RootDir "scripts"
$ConfigFile = Join-Path $RootDir "config.json"

# Load config
$Config = @{}
if (Test-Path $ConfigFile) {
    $Config = Get-Content $ConfigFile -Raw | ConvertFrom-Json -AsHashtable
}

$BasePort = if ($Config.multi_model.base_port) { $Config.multi_model.base_port } else { 8000 }
$StartupTimeout = if ($Config.multi_model.startup_timeout) { $Config.multi_model.startup_timeout } else { 60 }

# ==================================================
# VALIDATE ENVIRONMENT
# ==================================================
Write-Host ""
Write-Host "  LUMINA EDGE :: Multi-Model Router" -ForegroundColor Cyan
Write-Host "  ==================================" -ForegroundColor Cyan
Write-Host ""

$LlamaServer = Join-Path $BinDir "llama-server.exe"
if (-not (Test-Path $LlamaServer)) {
    Write-Host "  ERROR: llama-server.exe not found in $BinDir" -ForegroundColor Red
    exit 1
}

# ==================================================
# DISCOVER MODELS
# ==================================================
$ModelFiles = Get-ChildItem -Path $ModelsDir -Filter "*.gguf" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
if ($ModelFiles.Count -eq 0) {
    Write-Host "  ERROR: No .gguf model files found in $ModelsDir" -ForegroundColor Red
    exit 1
}

Write-Host "  Available Models:" -ForegroundColor White
for ($i = 0; $i -lt $ModelFiles.Count; $i++) {
    $size = [math]::Round($ModelFiles[$i].Length / 1GB, 2)
    Write-Host "    [$($i+1)] $($ModelFiles[$i].Name) ($size GB)" -ForegroundColor Gray
}

# ==================================================
# SELECT MODELS
# ==================================================
Write-Host ""
Write-Host "  Select models to load (comma-separated, e.g. 1,3 or 1-3):" -ForegroundColor White
$selection = Read-Host "  Selection"

# Parse selection
$SelectedIndices = @()
if ($selection -match '-') {
    # Range: 1-3
    $parts = $selection.Split('-')
    $start = [int]$parts[0]
    $end = [int]$parts[1]
    $SelectedIndices = $start..$end
} elseif ($selection -match ',') {
    # Comma-separated: 1,3,5
    $SelectedIndices = $selection.Split(',') | ForEach-Object { [int]($_.Trim()) }
} else {
    $SelectedIndices = @([int]$selection)
}

# Validate and collect selected models
$SelectedModels = @()
foreach ($idx in $SelectedIndices) {
    if ($idx -ge 1 -and $idx -le $ModelFiles.Count) {
        $SelectedModels += $ModelFiles[$idx - 1]
    } else {
        Write-Host "  WARNING: Index $idx out of range, skipping" -ForegroundColor Yellow
    }
}

if ($SelectedModels.Count -eq 0) {
    Write-Host "  ERROR: No valid models selected" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Selected $($SelectedModels.Count) model(s):" -ForegroundColor Green
foreach ($m in $SelectedModels) {
    Write-Host "    - $($m.Name)" -ForegroundColor Gray
}

# ==================================================
# CONFIGURE ROUTING
# ==================================================
Write-Host ""
Write-Host "  Routing Policy: $Policy" -ForegroundColor Cyan
Write-Host "  Base Port: $BasePort" -ForegroundColor Gray
Write-Host "  GPU: $Gpu" -ForegroundColor Gray

# Update config with selected policy
if (Test-Path $ConfigFile) {
    $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json -AsHashtable
    $cfg.routing_policy = $Policy
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $ConfigFile
}

# ==================================================
# LAUNCH VIA PYTHON ROUTER
# ==================================================
$PythonCmd = "python"
$VenvPython = Join-Path $RootDir "venv\Scripts\python.exe"
if (Test-Path $VenvPython) { $PythonCmd = $VenvPython }

$RouterScript = Join-Path $ScriptsDir "model-router.py"
$ModelPaths = ($SelectedModels | ForEach-Object { $_.FullName }) -join ","

Write-Host ""
Write-Host "  Launching multi-model router..." -ForegroundColor Cyan

$args = @(
    $RouterScript, "load",
    $ModelPaths.Split(","),
    "--bin-path", $BinDir,
    "--scripts", $ScriptsDir,
    "--models-dir", $ModelsDir
)

& $PythonCmd @args
