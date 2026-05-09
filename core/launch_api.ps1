# ==============================================================================
# launch_api.ps1 — Lumina Edge API Server Launcher for Windows
# Reads all settings from config.json
# ==============================================================================

param(
    [string]$Model = "",
    [int]$Port = 0,
    [string]$Gpu = "vulkan"
)

$ErrorActionPreference = "Stop"

# Get script directory
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $ScriptDir
Set-Location $RootDir

# Helper function to read from config.json
function Get-ConfigValue {
    param(
        [string]$Key,
        [object]$Default
    )
    
    try {
        $config = Get-Content "config.json" -Raw | ConvertFrom-Json
        $value = $config.$Key
        if ($null -eq $value) { return $Default }
        return $value
    } catch {
        return $Default
    }
}

# Read configuration from config.json
$ConfigModel = Get-ConfigValue -Key "model" -Default ""
$ConfigPort = Get-ConfigValue -Key "api_port" -Default 8090
$CtxSize = Get-ConfigValue -Key "ctx_size" -Default 16384
$NGpuLayers = Get-ConfigValue -Key "n_gpu_layers" -Default 15
$BatchSize = Get-ConfigValue -Key "batch_size" -Default 256
$UbatchSize = Get-ConfigValue -Key "ubatch_size" -Default 256
$FlashAttn = Get-ConfigValue -Key "flash_attn" -Default $true
$MinP = Get-ConfigValue -Key "min_p" -Default 0.05
$TopK = Get-ConfigValue -Key "top_k" -Default 20
$TopP = Get-ConfigValue -Key "top_p" -Default 0.9
$RepeatPenalty = Get-ConfigValue -Key "repeat_penalty" -Default 1.1
$HttpThreads = Get-ConfigValue -Key "http_threads" -Default 2
$ContBatching = Get-ConfigValue -Key "cont_batching" -Default $true
$KvCacheQuant = Get-ConfigValue -Key "kv_cache_quant" -Default "f16"
$UseMlock = Get-ConfigValue -Key "use_mlock" -Default $true
$NoMmap = Get-ConfigValue -Key "no_mmap" -Default $true
$MoeModel = Get-ConfigValue -Key "moe_model" -Default $false
$MoeOverride = Get-ConfigValue -Key "moe_override_tensor" -Default ""
$KvQuant = Get-ConfigValue -Key "kv_quant" -Default "turbo"

# Use command-line parameters or fall back to config
$FinalModel = if ($Model) { $Model } else { $ConfigModel }
$FinalPort = if ($Port -gt 0) { $Port } else { $ConfigPort }

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Lumina Edge API Server Launcher" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Validate model
if (-not $FinalModel) {
    Write-Error "ERROR: No model specified. Add 'model' field to config.json or use -Model parameter"
    exit 1
}

$ModelPath = Join-Path $RootDir "models" $FinalModel
if (-not (Test-Path $ModelPath)) {
    Write-Error "ERROR: Model file not found: $ModelPath"
    Write-Host "`nPlease download a GGUF model and place it in the models/ directory." -ForegroundColor Yellow
    Write-Host "Example models:" -ForegroundColor Yellow
    Write-Host "  - mistral-7b-instruct-v0.2.Q4_K_M.gguf" -ForegroundColor Gray
    Write-Host "  - llama-2-7b-chat.Q4_K_M.gguf" -ForegroundColor Gray
    Write-Host "  - phi-3-mini-4k-instruct.Q4_K_M.gguf" -ForegroundColor Gray
    Write-Host "`nDownload from: https://huggingface.co/TheBloke" -ForegroundColor Cyan
    exit 1
}

Write-Host "Model: $FinalModel" -ForegroundColor Green
Write-Host "Port: $FinalPort" -ForegroundColor Green
Write-Host "GPU Backend: $Gpu" -ForegroundColor Green
Write-Host "Context Size: $CtxSize" -ForegroundColor Green
Write-Host "GPU Layers: $NGpuLayers" -ForegroundColor Green

# Check if port is already in use
$PortCheck = netstat -ano | Select-String -Pattern ":$FinalPort\s"
if ($PortCheck) {
    Write-Warning "Port $FinalPort is already in use!"
    Write-Host "Run: netstat -ano | findstr ':$FinalPort' to see which process is using it" -ForegroundColor Yellow
    exit 1
}

# Ensure logs directory exists
$LogsDir = Join-Path $RootDir "logs"
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}

$LogFile = Join-Path $LogsDir "api_server.log"

# Build llama-server command arguments
$Arguments = @(
    "-m", "models\$FinalModel",
    "--port", $FinalPort,
    "--host", "127.0.0.1",
    "--ctx-size", $CtxSize,
    "--n-gpu-layers", $NGpuLayers,
    "--batch-size", $BatchSize,
    "--ubatch-size", $UbatchSize,
    "--min-p", $MinP,
    "--top-k", $TopK,
    "--top-p", $TopP,
    "--repeat-penalty", $RepeatPenalty,
    "--threads-http", $HttpThreads
)

# Add boolean flags
if ($FlashAttn) { $Arguments += "--flash-attn" }
if ($UseMlock) { $Arguments += "--mlock" }
if ($NoMmap) { $Arguments += "--no-mmap" }
if ($ContBatching) { $Arguments += "--cont-batching" }

# Add KV quantization flags
if ($KvQuant -eq "turbo") {
    $Arguments += @("--flash-attn", "--cache-type-k", "turbo4", "--cache-type-v", "turbo3")
} elseif ($KvQuant -eq "q8_0") {
    $Arguments += @("--cache-type-k", "q8_0", "--cache-type-v", "q8_0")
} elseif ($KvQuant -eq "q4_0") {
    $Arguments += @("--cache-type-k", "q4_0", "--cache-type-v", "q4_0")
}

# Add MoE flags
if ($MoeModel) {
    if ($MoeOverride) {
        $Arguments += @("-ot", $MoeOverride)
    } else {
        $Arguments += "--cpu-moe"
    }
}

# Find llama-server.exe
$BinaryPath = Join-Path $RootDir "bin\llama-server.exe"
if (-not (Test-Path $BinaryPath)) {
    # Try alternative locations
    $AltPaths = @(
        Join-Path $RootDir "llama-server.exe",
        "llama-server.exe"
    )
    foreach ($AltPath in $AltPaths) {
        if (Test-Path $AltPath) {
            $BinaryPath = $AltPath
            break
        }
    }
}

if (-not (Test-Path $BinaryPath)) {
    Write-Error "ERROR: llama-server.exe not found!`nSearched: $BinaryPath`n`nPlease ensure llama.cpp binaries are in bin/ directory."
    exit 1
}

Write-Host "`nStarting llama-server..." -ForegroundColor Cyan
Write-Host "Binary: $BinaryPath" -ForegroundColor Gray
Write-Host "Log file: $LogFile" -ForegroundColor Gray
Write-Host "`nCommand: $BinaryPath $($Arguments -join ' ')" -ForegroundColor DarkGray
Write-Host "`n========================================" -ForegroundColor Cyan

# Start the server
$Process = $null
try {
    $Process = Start-Process -FilePath $BinaryPath -ArgumentList $Arguments -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile -WindowStyle Hidden -PassThru
    
    Write-Host "Server started with PID: $($Process.Id)" -ForegroundColor Green
    Write-Host "Waiting for server to initialize..." -ForegroundColor Yellow
    
    # Wait for server to be ready
    $MaxWait = 30
    $Waited = 0
    $Ready = $false
    
    while ($Waited -lt $MaxWait) {
        Start-Sleep -Seconds 1
        $Waited++
        
        # Check if process is still running
        if ($Process.HasExited) {
            Write-Error "Server process exited unexpectedly!`nCheck log: $LogFile"
            exit 1
        }
        
        # Try to connect to health endpoint
        try {
            $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$FinalPort/health" -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($Response.StatusCode -eq 200) {
                $Ready = $true
                break
            }
        } catch {
            # Not ready yet, continue waiting
        }
        
        # Show progress
        if ($Waited % 5 -eq 0) {
            Write-Host "  ... waiting ($Waited/$MaxWait seconds)" -ForegroundColor DarkGray
        }
    }
    
    if ($Ready) {
        Write-Host "`n✓ Server is ready!" -ForegroundColor Green
        Write-Host "  API URL: http://127.0.0.1:$FinalPort" -ForegroundColor Cyan
        Write-Host "  Health: http://127.0.0.1:$FinalPort/health" -ForegroundColor Cyan
        Write-Host "`nTo test the server, run:" -ForegroundColor Yellow
        Write-Host "  python scripts\check_server.py" -ForegroundColor White
        Write-Host "`nPress Ctrl+C to stop the server" -ForegroundColor Yellow
        
        # Wait for user to press Ctrl+C
        try {
            while ($true) {
                if ($Process.HasExited) {
                    Write-Host "`nServer process exited." -ForegroundColor Red
                    break
                }
                Start-Sleep -Seconds 1
            }
        } catch {
            # Ctrl+C pressed
            Write-Host "`n`nStopping server..." -ForegroundColor Yellow
            if (-not $Process.HasExited) {
                $Process.Kill()
                $Process.WaitForExit()
            }
            Write-Host "Server stopped." -ForegroundColor Green
        }
    } else {
        Write-Error "Server failed to start within $MaxWait seconds.`nCheck log: $LogFile"
        if (-not $Process.HasExited) {
            $Process.Kill()
        }
        exit 1
    }
} catch {
    Write-Error "Failed to start server: $_"
    if ($Process -and -not $Process.HasExited) {
        $Process.Kill()
    }
    exit 1
}
