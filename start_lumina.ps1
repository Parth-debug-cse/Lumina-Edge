# ==============================================================================
# Lumina Edge — Full Stack Launcher (Windows PowerShell)
# Optimizes system → starts llama-server → starts API server → launches UI
# ==============================================================================

[CmdletBinding()]
param(
    [string]$Model = ""
)

$ErrorActionPreference = "Stop"

# Get script directory and set paths
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$Root = $ScriptDir
$Scripts = Join-Path $Root "scripts"
$UIDir = Join-Path $Root "ui"
$API_PORT = if ($env:LUMINA_API_PORT) { $env:LUMINA_API_PORT } else { "8090" }
$MLX_PORT = if ($env:LUMINA_MLX_PORT) { $env:LUMINA_MLX_PORT } else { "8091" }
$UI_PORT = if ($env:LUMINA_UI_PORT) { $env:LUMINA_UI_PORT } else { "5173" }
$OW_PORT = if ($env:LUMINA_OW_PORT) { $env:LUMINA_OW_PORT } else { "8080" }

$MODEL_PATH = $Model

$RUNDIR = Join-Path $Root ".lumina_run"
if (-not (Test-Path $RUNDIR)) {
    New-Item -ItemType Directory -Path $RUNDIR -Force | Out-Null
}
$PID_FILE = Join-Path $RUNDIR "pids.txt"

function Write-Log {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$timestamp] [Lumina] $Message"
    Write-Host $logMessage
    Add-Content -Path (Join-Path $RUNDIR "startup.log") -Value $logMessage
}

function Write-LogOk {
    param([string]$Message)
    Write-Log "✓ $Message"
}

function Write-LogErr {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logMessage = "[$timestamp] [Lumina] ✗ $Message"
    Write-Host $logMessage -ForegroundColor Red
    Add-Content -Path (Join-Path $RUNDIR "startup.log") -Value $logMessage
}

function Stop-Existing {
    Write-Log "Stopping any existing Lumina processes..."
    
    # Kill by PID file
    if (Test-Path $PID_FILE) {
        $pids = Get-Content $PID_FILE
        foreach ($line in $pids) {
            if ($line -match "^(\d+)\s+(.+)$") {
                $pid = $matches[1]
                $process = Get-Process -Id $pid -ErrorAction SilentlyContinue
                if ($process) {
                    Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
                }
            }
        }
        Clear-Content $PID_FILE -Force
    }
    
    # Fallback: kill by process name
    Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*api-server.js*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process -Name "vite" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    
    Start-Sleep -Seconds 1
}

function Get-Config {
    param([string]$Key, [string]$Default = "")
    
    $configFile = Join-Path $Root "config.json"
    if (Test-Path $configFile) {
        try {
            $config = Get-Content $configFile -Raw | ConvertFrom-Json
            $parts = $Key -split '\.'
            $value = $config
            foreach ($part in $parts) {
                if ($value.PSObject.Properties.Name -contains $part) {
                    $value = $value.$part
                } else {
                    return $Default
                }
            }
            return $value
        } catch {
            return $Default
        }
    }
    return $Default
}

function AutoFind-Model {
    # Try startup.default_model first
    $configModel = Get-Config "startup.default_model" ""
    if ($configModel -and (Test-Path $configModel)) {
        return $configModel
    }

    # Fall back to top-level "model" key (used by launch_api.ps1 for consistency)
    $configModel = Get-Config "model" ""
    if ($configModel -and (Test-Path $configModel)) {
        return $configModel
    }
    
    # Auto-detect first model in models/ directory
    $modelsDir = Join-Path $Root "models"
    if (Test-Path $modelsDir) {
        # Check for .gguf files first
        $ggufFiles = Get-ChildItem -Path $modelsDir -Filter "*.gguf" | Sort-Object Name
        if ($ggufFiles.Count -gt 0) {
            return $ggufFiles[0].FullName
        }
        
        # Check for subdirectories
        $modelDirs = Get-ChildItem -Path $modelsDir -Directory | Sort-Object Name
        if ($modelDirs.Count -gt 0) {
            return $modelDirs[0].FullName
        }
    }
    
    return $null
}

# ==============================================================================
# STEP 1: System Optimization (Windows)
# ==============================================================================
function Optimize-System {
    Write-Log "Optimizing system for inference..."
    
    $optimizerScript = Join-Path $Scripts "windows_prelaunch.ps1"
    if (Test-Path $optimizerScript) {
        Write-Log "  Running Windows system optimizer..."
        try {
            & powershell -ExecutionPolicy Bypass -File $optimizerScript *>&1 | Out-File -FilePath (Join-Path $RUNDIR "optimizer.log") -Append
            Write-LogOk "Windows optimization complete"
        } catch {
            Write-Log "  Optimizer had warnings (non-fatal)"
        }
    } else {
        Write-Log "  Skipping optimizer (not found: $optimizerScript)"
    }
}

# ==============================================================================
# STEP 2: Check / download model
# ==============================================================================
function Check-Model {
    if (-not $MODEL_PATH) {
        Write-Log "  No model specified — auto-detecting..."
        $MODEL_PATH = AutoFind-Model
    }
    
    if (-not $MODEL_PATH) {
        Write-LogErr "No model found. Please place a model in ./models/ or set startup.default_model in config.json"
        throw "No model found"
    }
    
    if (-not (Test-Path $MODEL_PATH)) {
        Write-LogErr "Model not found: $MODEL_PATH"
        throw "Model not found"
    }
    
    Write-Log "Model: $MODEL_PATH"
}

# ==============================================================================
# STEP 3: Start llama-server backend (Windows)
# ==============================================================================
function Start-Backend {
    Write-Log "Starting inference backend..."
    
    $LLAMA_SERVER = Join-Path $Root "bin" "llama-server.exe"
    if (-not (Test-Path $LLAMA_SERVER)) {
        Write-LogErr "llama-server.exe not found at $LLAMA_SERVER"
        throw "llama-server.exe not found"
    }
    
    $CTX_SIZE = Get-Config "ctx_size" "16384"
    $N_GPU_LAYERS = Get-Config "n_gpu_layers" "15"
    $BATCH_SIZE = Get-Config "batch_size" "256"
    $UBATCH_SIZE = Get-Config "ubatch_size" "256"
    $TEMPERATURE = Get-Config "temperature" "0.7"
    $TOP_P = Get-Config "top_p" "0.9"
    $TOP_K = Get-Config "top_k" "40"
    $REPEAT_PENALTY = Get-Config "repeat_penalty" "1.1"
    $MIN_P = Get-Config "min_p" "0.05"
    $HTTP_THREADS = Get-Config "http_threads" "2"
    $FLASH_ATTN = Get-Config "flash_attn" "true"

    $BACKEND_LOG = Join-Path $RUNDIR "llama_server.log"
    Write-Log "  llama-server → port $API_PORT"

    $Arguments = @(
        "-m", $MODEL_PATH,
        "--port", $API_PORT,
        "--host", "127.0.0.1",
        "--ctx-size", $CTX_SIZE,
        "--n-gpu-layers", $N_GPU_LAYERS,
        "--batch-size", $BATCH_SIZE,
        "--ubatch-size", $UBATCH_SIZE,
        "--threads-http", $HTTP_THREADS,
        "--temperature", $TEMPERATURE,
        "--top-p", $TOP_P,
        "--top-k", $TOP_K,
        "--repeat-penalty", $REPEAT_PENALTY,
        "--min-p", $MIN_P
    )
    if ($FLASH_ATTN -eq $true) {
        $Arguments += "--flash-attn"
    }

    $process = Start-Process -FilePath $LLAMA_SERVER -ArgumentList $Arguments -RedirectStandardOutput $BACKEND_LOG -RedirectStandardError $BACKEND_LOG -PassThru
    
    $ll_pid = $process.Id
    Add-Content -Path $PID_FILE -Value "$ll_pid llama_server"
    Write-Log "  llama-server PID: $ll_pid"
    
    Write-Log "  Waiting for llama-server to be ready..."
    for ($i = 1; $i -le 30; $i++) {
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$API_PORT/v1/models" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response -and $response.data) {
                Write-LogOk "llama-server ready on port $API_PORT"
                return
            }
        } catch {
            # Continue waiting
        }
        Start-Sleep -Seconds 1
    }
    
    Write-LogErr "llama-server failed to start. Check $BACKEND_LOG"
    if (Test-Path $BACKEND_LOG) {
        Get-Content $BACKEND_LOG | Select-Object -Last 20
    }
    throw "llama-server failed to start"
}

# ==============================================================================
# STEP 4: Start Node API server (Lumina Core gateway)
# ==============================================================================
function Start-APIServer {
    Write-Log "Starting Lumina Core API gateway..."
    
    $API_LOG = Join-Path $RUNDIR "api_server.log"
    Set-Location $UIDir
    
    $env:MLX_PORT = $MLX_PORT
    $env:LUMINA_API_PORT = $API_PORT
    $env:LUMINA_MLX_PORT = $MLX_PORT
    
    $process = Start-Process -FilePath "node" -ArgumentList "api-server.js" -RedirectStandardOutput $API_LOG -RedirectStandardError $API_LOG -PassThru
    $api_pid = $process.Id
    Add-Content -Path $PID_FILE -Value "$api_pid api_server"
    Write-Log "  API server PID: $api_pid"
    
    # Wait for the Node API server (secondary port 8081 first, then primary)
    Write-Log "  Waiting for API server..."
    for ($i = 1; $i -le 20; $i++) {
        try {
            # Check secondary port (always starts first)
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:8081/api/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response -and $response.status -eq "ok") {
                Write-LogOk "API gateway ready (primary: $API_PORT, mgmt: 8081)"
                return
            }
        } catch {
            # Also accept if primary port is serving (already running from before)
            try {
                $response = Invoke-RestMethod -Uri "http://127.0.0.1:$API_PORT/api/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
                if ($response -and $response.status -eq "ok") {
                    Write-LogOk "API gateway already running (primary: $API_PORT)"
                    return
                }
            } catch {
                # Continue waiting
            }
        }
        Start-Sleep -Seconds 1
    }
    
    Write-LogErr "API server failed to start. Check $API_LOG"
    if (Test-Path $API_LOG) {
        Get-Content $API_LOG | Select-Object -Last 20
    }
    throw "API server failed to start"
}

# ==============================================================================
# STEP 5: Start Vite dev server (Lumina Core UI)
# ==============================================================================
function Start-UI {
    Write-Log "Starting Lumina Core UI..."
    
    $UI_LOG = Join-Path $RUNDIR "vite.log"
    Set-Location $UIDir
    
    $process = Start-Process -FilePath "npm" -ArgumentList "run", "dev" -RedirectStandardOutput $UI_LOG -RedirectStandardError $UI_LOG -PassThru
    $ui_pid = $process.Id
    Add-Content -Path $PID_FILE -Value "$ui_pid vite"
    Write-Log "  Vite PID: $ui_pid"
    
    Write-Log "  Waiting for Vite dev server..."
    for ($i = 1; $i -le 20; $i++) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:$UI_PORT/" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response.Content -match "<html") {
                Write-LogOk "Lumina Core UI ready at http://localhost:$UI_PORT"
                return
            }
        } catch {
            # Continue waiting
        }
        Start-Sleep -Seconds 1
    }
    
    Write-LogErr "Vite dev server failed. Check $UI_LOG"
    if (Test-Path $UI_LOG) {
        Get-Content $UI_LOG | Select-Object -Last 10
    }
    throw "Vite dev server failed"
}

# ==============================================================================
# STEP 6: OpenWebUI setup / launch
# ==============================================================================
function Setup-OpenWebUI {
    Write-Log "Checking OpenWebUI..."
    
    # Check Docker first
    try {
        $dockerContainers = docker ps --format "{{.Names}}" 2>$null
        if ($dockerContainers -contains "open-webui") {
            Write-Log "  OpenWebUI detected via Docker (port $OW_PORT)"
            try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:$OW_PORT/" -TimeoutSec 3 -ErrorAction SilentlyContinue
                if ($response.Content -match "html") {
                    Write-LogOk "OpenWebUI ready at http://127.0.0.1:$OW_PORT"
                    Write-Log "  Configure OpenWebUI to connect to Lumina:"
                    Write-Log "    1. Open http://127.0.0.1:$OW_PORT in your browser"
                    Write-Log "    2. Sign up / log in, then go to Settings → Connections"
                    Write-Log "    3. Set API URL to: http://host.docker.internal:$API_PORT/v1"
                    Write-Log "    4. API Key: any value (Lumina accepts all keys)"
                    Write-Log ""
                    return
                }
            } catch {
                # Continue to local installation check
            }
        }
    } catch {
        # Docker not available or other error
    }
    
    # Check local installation
    $openwebuiExe = Get-Command "openwebui" -ErrorAction SilentlyContinue
    $openwebuiApp = Test-Path "C:\Program Files\OpenWebUI\OpenWebUI.exe"
    $openwebuiHome = Test-Path (Join-Path $env:USERPROFILE "open-webui")
    
    if (-not $openwebuiExe -and -not $openwebuiApp -and -not $openwebuiHome) {
        Write-Log "  OpenWebUI not detected (not installed locally or via Docker)"
        Write-Log "  Install via Docker: docker run -d -p $OW_PORT`:8080 --add-host=host.docker.internal:host-gateway openwebui/openwebui:latest"
        return
    }
    
    # Start local OpenWebUI
    $OW_LOG = Join-Path $RUNDIR "openwebui.log"
    if ($openwebuiHome) {
        Set-Location (Join-Path $env:USERPROFILE "open-webui")
        
        $env:LUMINA_API_KEY = if ($env:LUMINA_API_KEY) { $env:LUMINA_API_KEY } else { "lumina-openai-key" }
        $env:LUMINA_API_URL = "http://127.0.0.1:$API_PORT/v1"
        $env:LUMINA_TITLE = if ($env:LUMINA_TITLE) { $env:LUMINA_TITLE } else { "Lumina Edge" }
        $env:OLLAMA_BASE_URL = $env:LUMINA_API_URL
        $env:OPENAI_API_BASE_URL = $env:LUMINA_API_URL
        $env:OPENAI_API_KEY = $env:LUMINA_API_KEY
        $env:WEBUI_NAME = $env:LUMINA_TITLE
        
        $process = Start-Process -FilePath "python" -ArgumentList @("-m", "uvicorn", "openwebui.main:app", "--host", "127.0.0.1", "--port", $OW_PORT, "--root-path", "/") -RedirectStandardOutput $OW_LOG -RedirectStandardError $OW_LOG -PassThru
        $ow_pid = $process.Id
        Add-Content -Path $PID_FILE -Value "$ow_pid openwebui"
        Write-Log "  OpenWebUI PID: $ow_pid"
        
        Write-Log "  Waiting for OpenWebUI..."
        for ($i = 1; $i -le 30; $i++) {
            try {
                $response = Invoke-WebRequest -Uri "http://127.0.0.1:$OW_PORT/" -TimeoutSec 3 -ErrorAction SilentlyContinue
                if ($response.Content -match "html") {
                    Write-LogOk "OpenWebUI ready at http://127.0.0.1:$OW_PORT"
                    Write-Log "  Configure: Settings → Connections → API Base URL → $env:LUMINA_API_URL"
                    return
                }
            } catch {
                # Continue waiting
            }
            Start-Sleep -Seconds 1
        }
        
        Write-LogErr "OpenWebUI failed to start. Check $OW_LOG"
        if (Test-Path $OW_LOG) {
            Get-Content $OW_LOG | Select-Object -Last 10
        }
    }
}

# ==============================================================================
# Print startup summary
# ==============================================================================
function Print-Summary {
    Write-Host ""
    Write-Host "============================================================"
    Write-Host "  Lumina Edge — All systems ready" -ForegroundColor Green
    Write-Host "============================================================"
    Write-Host ""
    Write-Host "  Model:       $MODEL_PATH"
    Write-Host "  Backend:     http://127.0.0.1:$API_PORT"
    Write-Host "  Lumina Core: http://localhost:$UI_PORT"
    Write-Host ""
    Write-Host "  Logs:        $RUNDIR"
    Write-Host "  PIDs:        $PID_FILE"
    Write-Host ""
    Write-Host "  To stop:     Stop-Process -Id (Get-Content $PID_FILE | ForEach-Object { ($_ -split ' ')[0] })"
    Write-Host "============================================================"
    Write-Host ""
    
    # Open browser automatically
    try {
        Start-Process "http://localhost:$UI_PORT"
    } catch {
        # Ignore if browser fails to open
    }
}

# ==============================================================================
# MAIN
# ==============================================================================
function Main {
    # Clear startup log
    Clear-Content -Path (Join-Path $RUNDIR "startup.log") -ErrorAction SilentlyContinue
    
    Write-Log "============================================================"
    Write-Log "  Lumina Edge Launcher (Windows)"
    Write-Log "============================================================"
    Write-Log "  Root:     $Root"
    Write-Log "  Platform: $((Get-WmiObject -Class Win32_OperatingSystem).Caption) $((Get-WmiObject -Class Win32_Processor).Architecture)"
    Write-Log "  Model:    $(if ($MODEL_PATH) { $MODEL_PATH } else { 'not set' })"
    Write-Log ""
    
    try {
        Stop-Existing
        
        Optimize-System
        
        Check-Model
        
        Start-Backend
        
        Start-APIServer
        
        Start-UI
        
        Setup-OpenWebUI
        
        Print-Summary
        
        Write-Log "Startup complete. Press Ctrl+C to stop all services."
        
        # Wait for all processes
        while ($true) {
            Start-Sleep -Seconds 1
        }
        
    } catch {
        Write-LogErr "Startup failed: $_"
        exit 1
    }
}

# ==============================================================================
# Help / minimal usage
# ==============================================================================
function Show-Help {
    Write-Host "Lumina Edge Launcher (Windows PowerShell)"
    Write-Host ""
    Write-Host "Usage: .\start_lumina.ps1"
    Write-Host "       .\start_lumina.ps1 -Model C:\path\to\model  (optional — auto-detects if missing)"
    Write-Host ""
    Write-Host "Environment variables:"
    Write-Host "  LUMINA_API_PORT   Backend/API port (default: 8090)"
    Write-Host "  LUMINA_MLX_PORT   MLX backend port (default: 8091)"
    Write-Host "  LUMINA_UI_PORT    Vite dev server port (default: 5173)"
    Write-Host "  LUMINA_OW_PORT    OpenWebUI port (default: 8080)"
    Write-Host ""
    Write-Host "Model auto-detection: looks for first model in ./models/ or startup.default_model in config.json"
    Write-Host ""
}

if ($args -contains "--help" -or $args -contains "-h") {
    Show-Help
    exit 0
}

Main
