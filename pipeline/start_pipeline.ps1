# Lumina Edge Pipeline Startup Script (Windows PowerShell)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = (Get-Item $ScriptDir).Parent.FullName
$ConfigFile = Join-Path $ProjectRoot "config.json"
$LlamaServer = Join-Path $ProjectRoot "bin\llama-server.exe"

function Get-ConfigValue {
    param([string]$Key)
    $config = Get-Content $ConfigFile | ConvertFrom-Json
    $keys = $Key -split '\.'
    $value = $config
    foreach ($k in $keys) {
        $value = $value.$k
    }
    return $value
}

function Test-ModelExists {
    param([string]$ModelPath)
    if (-not $ModelPath.StartsWith("/") -and -not $ModelPath.Contains(":")) {
        $ModelPath = Join-Path $ProjectRoot $ModelPath
    }
    if (-not (Test-Path $ModelPath)) {
        Write-Error "Model file not found: $ModelPath"
        return $false
    }
    Write-Host "Model found: $ModelPath"
    return $true
}

function Wait-ForHealth {
    param([int]$Port, [string]$Name, [int]$MaxAttempts = 30)
    Write-Host "Waiting for $Name to be healthy on port $Port..."
    $attempt = 1
    while ($attempt -le $MaxAttempts) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:$Port/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                Write-Host "$Name ready on port $Port"
                return $true
            }
        } catch {}
        Write-Host "  Attempt $attempt/$MaxAttempts - not ready yet..."
        Start-Sleep -Seconds 2
        $attempt++
    }
    Write-Error "$Name failed to become healthy after $MaxAttempts attempts"
    return $false
}

function Stop-Processes {
    Write-Host ""
    Write-Host "Shutting down pipeline..."
    if ($CleanerPid) { Stop-Process -Id $CleanerPid -Force -ErrorAction SilentlyContinue }
    if ($CategorizerPid) { Stop-Process -Id $CategorizerPid -Force -ErrorAction SilentlyContinue }
    if ($OrchPid) { Stop-Process -Id $OrchPid -Force -ErrorAction SilentlyContinue }
    Write-Host "All processes stopped."
}

$cleanupRegistered = $false
$CleanerPid = $null
$CategorizerPid = $null
$OrchPid = $null

Register-EngineEvent -SourceIdentifier "PowerShell.Exiting" -Action {
    Stop-Processes
} -MaxTermination 0

if (-not (Test-Path $ConfigFile)) {
    Write-Error "config.json not found at $ConfigFile"
    exit 1
}

Write-Host "Loading config from $ConfigFile..."
$CleanerPort = Get-ConfigValue "agents.cleaner.port"
$CategorizerPort = Get-ConfigValue "agents.categorizer.port"
$CleanerModel = Get-ConfigValue "agents.cleaner.model_path"
$CategorizerModel = Get-ConfigValue "agents.categorizer.model_path"
$OrchestratorPort = Get-ConfigValue "api.port"

Write-Host "Cleaner model: $CleanerModel (port $CleanerPort)"
Write-Host "Categorizer model: $CategorizerModel (port $CategorizerPort)"

if (-not (Test-ModelExists $CleanerModel)) { exit 1 }
if (-not (Test-ModelExists $CategorizerModel)) { exit 1 }

if (-not (Test-Path $LlamaServer)) {
    Write-Error "llama-server.exe not found at $LlamaServer"
    exit 1
}

Write-Host ""
Write-Host "=========================================="
Write-Host "Starting Agent 1 (Cleaner) on port $CleanerPort..."
Write-Host "=========================================="
$CleanerLog = "$env:TEMP\lumina_cleaner.log"
$CleanerProcess = Start-Process -FilePath $LlamaServer -ArgumentList @(
    "--model", (Join-Path $ProjectRoot $CleanerModel),
    "--port", $CleanerPort,
    "--host", "0.0.0.0",
    "--threads", "4",
    "--ctx-size", "8192",
    "--batch-size", "256"
) -NoNewWindow -PassThru -RedirectStandardOutput $CleanerLog -RedirectStandardError $CleanerLog
$CleanerPid = $CleanerProcess.Id
Write-Host "Cleaner PID: $CleanerPid"

Write-Host ""
Write-Host "=========================================="
Write-Host "Starting Agent 2 (Categorizer) on port $CategorizerPort..."
Write-Host "=========================================="
$CategorizerLog = "$env:TEMP\lumina_categorizer.log"
$CategorizerProcess = Start-Process -FilePath $LlamaServer -ArgumentList @(
    "--model", (Join-Path $ProjectRoot $CategorizerModel),
    "--port", $CategorizerPort,
    "--host", "0.0.0.0",
    "--threads", "4",
    "--ctx-size", "8192",
    "--batch-size", "256"
) -NoNewWindow -PassThru -RedirectStandardOutput $CategorizerLog -RedirectStandardError $CategorizerLog
$CategorizerPid = $CategorizerProcess.Id
Write-Host "Categorizer PID: $CategorizerPid"

Write-Host ""
Write-Host "Waiting for agents to initialize..."

if (-not (Wait-ForHealth -Port $CleanerPort -Name "Agent 1 (Cleaner)")) { exit 1 }
if (-not (Wait-ForHealth -Port $CategorizerPort -Name "Agent 2 (Categorizer)")) { exit 1 }

Write-Host ""
Write-Host "=========================================="
Write-Host "Starting Orchestrator on port $OrchestratorPort..."
Write-Host "=========================================="
$OrchProcess = Start-Process -FilePath "python" -ArgumentList "orchestrator.py" -NoNewWindow -PassThru -WorkingDirectory $ScriptDir
$OrchPid = $OrchProcess.Id
Write-Host "Orchestrator PID: $OrchPid"

if (-not (Wait-ForHealth -Port $OrchestratorPort -Name "Orchestrator")) { exit 1 }

Write-Host ""
Write-Host "=========================================="
Write-Host "PIPELINE READY"
Write-Host "=========================================="
Write-Host "Agent 1 (Cleaner):  http://localhost:$CleanerPort"
Write-Host "Agent 2 (Categorizer): http://localhost:$CategorizerPort"
Write-Host "Orchestrator:     http://localhost:$OrchestratorPort"
Write-Host ""
Write-Host "OpenWebUI should connect to: http://localhost:$OrchestratorPort"
Write-Host "Model name: lumina-pipeline"
Write-Host ""
Write-Host "Press Ctrl+C to stop the pipeline."

try {
    while ($true) { Start-Sleep -Seconds 1 }
} finally {
    Stop-Processes
}