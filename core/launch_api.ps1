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
# If script is in core/, go up one level to project root
$RootDir = if ($ScriptDir -match '[\\/]core$') { Split-Path -Parent $ScriptDir } else { $ScriptDir }
Set-Location $RootDir

# Reads a config.json value with dot-notation support and fallback default
function Get-ConfigValue {
    param(
        [string]$Key,
        [object]$Default
    )

    try {
        $config = Get-Content "config.json" -Raw | ConvertFrom-Json
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

# Read configuration from config.json
$ConfigModel = Get-ConfigValue -Key "model" -Default ""
# FIX: Use backend_port (not api_port) for llama-server
$ConfigPort = Get-ConfigValue -Key "backend_port" -Default 8091
$CtxSize = Get-ConfigValue -Key "ctx_size" -Default 4096
$NGpuLayers = Get-ConfigValue -Key "n_gpu_layers" -Default 0
$BatchSize = Get-ConfigValue -Key "batch_size" -Default 256
$UbatchSize = Get-ConfigValue -Key "ubatch_size" -Default 256
$FlashAttn = Get-ConfigValue -Key "flash_attn" -Default $true
$MinP = Get-ConfigValue -Key "min_p" -Default 0.05
# FIX: top_k default should be 40 to match config.json
$TopK = Get-ConfigValue -Key "top_k" -Default 40
$TopP = Get-ConfigValue -Key "top_p" -Default 0.9
$RepeatPenalty = Get-ConfigValue -Key "repeat_penalty" -Default 1.1
$HttpThreads = Get-ConfigValue -Key "http_threads" -Default 2
$ContBatching = Get-ConfigValue -Key "cont_batching" -Default $true
$KvCacheQuant = Get-ConfigValue -Key "kv_cache_quant" -Default "q4_0"
# FIX: --mlock is not supported on Windows; default to false
$UseMlock = Get-ConfigValue -Key "use_mlock" -Default $false
$NoMmap = Get-ConfigValue -Key "no_mmap" -Default $true
$MoeModel = Get-ConfigValue -Key "moe_model" -Default $false
$MoeOverride = Get-ConfigValue -Key "moe_override_tensor" -Default ""
$KvCacheTypeK = Get-ConfigValue -Key "kv_cache_type_k" -Default "q4_0"
$KvCacheTypeV = Get-ConfigValue -Key "kv_cache_type_v" -Default "q4_0"

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

# Resolve model path correctly — only prepend models\ if not already absolute
if ([System.IO.Path]::IsPathRooted($FinalModel) -or
    $FinalModel -match '^models[\\/]' -or
    $FinalModel -match '^\.[\\/]' -or
    $FinalModel -match '^\.\.' ) {
    $ModelPath = $FinalModel
} else {
    $ModelPath = Join-Path $RootDir "models" $FinalModel
}
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

Write-Host "Model: $ModelPath" -ForegroundColor Green
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
# FIX: Use $ModelPath (resolved absolute path) instead of a relative string
$Arguments = @(
    "-m", $ModelPath,
    "--port", $FinalPort,
    "--host", "127.0.0.1",  # localhost only — don't expose externally
    "--ctx-size", $CtxSize,
    "--n-gpu-layers", $NGpuLayers,
    "--batch-size", $BatchSize,
    "--ubatch-size", $UbatchSize,
    "--min-p", $MinP,
    "--top-k", $TopK,
    "--top-p", $TopP,
    "--repeat-penalty", $RepeatPenalty,
    "--threads-http", $HttpThreads,
    "--jinja"  # Jinja2 chat template support
)

# Add conditional boolean flags
if ($FlashAttn) { $Arguments += "--flash-attn" }
# FIX: --mlock is not supported on Windows; skip it entirely
# if ($UseMlock) { $Arguments += "--mlock" }
if ($NoMmap) { $Arguments += "--no-mmap" }
if ($ContBatching) { $Arguments += "--cont-batching" }

# Add KV quantization flags from config (default q4_0)
$Arguments += @("--cache-type-k", $KvCacheTypeK, "--cache-type-v", $KvCacheTypeV)

# Add MoE flags for Mixture of Experts model support
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

# Start the server with separate stdout/stderr log files
# (PowerShell crashes if both go to same file)
$Process = $null
try {
    $ErrorLogFile = "$LogFile.err"
    $Process = Start-Process -FilePath $BinaryPath -ArgumentList $Arguments -RedirectStandardOutput $LogFile -RedirectStandardError $ErrorLogFile -WindowStyle Hidden -PassThru -PriorityClass High

    Write-Host "Server started with PID: $($Process.Id)" -ForegroundColor Green
    Write-Host "Waiting for server to initialize..." -ForegroundColor Yellow

    # Wait for server to be ready (poll /v1/models up to 30 seconds)
    $MaxWait = 30
    $Waited = 0
    $Ready = $false

    while ($Waited -lt $MaxWait) {
        Start-Sleep -Seconds 1
        $Waited++

        if ($Process.HasExited) {
            Write-Error "Server process exited unexpectedly!`nCheck log: $LogFile"
            exit 1
        }

        try {
            $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$FinalPort/v1/models" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
            if ($Response.StatusCode -eq 200) {
                $Ready = $true
                break
            }
        } catch {
            # Not ready yet, keep waiting
        }

        if ($Waited % 5 -eq 0) {
            Write-Host "  ... waiting ($Waited/$MaxWait seconds)" -ForegroundColor DarkGray
        }
    }

    if ($Ready) {
        Write-Host "`nOK: Server is ready!" -ForegroundColor Green
        Write-Host "  API URL: http://127.0.0.1:$FinalPort" -ForegroundColor Cyan
        Write-Host "  Docs:  http://127.0.0.1:$FinalPort/docs" -ForegroundColor Cyan
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
