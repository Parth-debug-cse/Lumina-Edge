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
$LLAMA_SERVER = Join-Path $Root "bin\llama-server.exe"

function Resolve-ThreadCount {
    param([object]$Value)

    if ([string]$Value -ine "auto") {
        try {
            $Count = [int]$Value
            if ($Count -gt 0) { return $Count }
        } catch {}
        Write-Warning "Invalid thread count '$Value'; using 1"
        return 1
    }

    try {
        $PhysicalCores = (Get-CimInstance -ClassName Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum
        if ($PhysicalCores -gt 0) { return [int]$PhysicalCores }
    } catch {}
    return [Math]::Max(1, [Environment]::ProcessorCount)
}

function Resolve-BatchSize {
    param([object]$Value)

    if ([string]$Value -ieq "auto") {
        $AvailableGiB = $null
        try {
            $AvailableBytes = (Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop).AvailableBytes
            if ($AvailableBytes -gt 0) { $AvailableGiB = [double]$AvailableBytes / 1GB }
        } catch {}
        if ($null -eq $AvailableGiB) {
            try {
                $FreeMemoryKB = (Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop).FreePhysicalMemory
                if ($FreeMemoryKB -gt 0) { $AvailableGiB = [double]$FreeMemoryKB / 1MB }
            } catch {}
        }
        if ($null -ne $AvailableGiB) {
            $Detected = [Math]::Max(128, [Math]::Min(1024, [Math]::Floor($AvailableGiB / 2) * 128))
            return [int]$Detected
        }
        return 256
    }

    $Text = [string]$Value
    if ($Text -match '^[1-9][0-9]*$') {
        try { return [int]$Text } catch {}
    }
    Write-Warning "Invalid batch size '$Value'; using 256"
    return 256
}

function Resolve-GpuLayerCount {
    param([object]$Value)

    if ([string]$Value -ieq "auto") {
        if (Test-Path $LLAMA_SERVER) {
            try {
                $DeviceOutput = (& $LLAMA_SERVER --list-devices 2>$null | Out-String)
                if ($DeviceOutput -match '(?im)^\s*([-*]\s*)?(CUDA|Vulkan|ROCm|HIP|SYCL|Metal|OpenCL)[\w-]*\s*:') {
                    return 99
                }
            } catch {}
        }
        Write-Warning "No supported llama.cpp GPU device detected; using CPU layers"
        return 0
    }

    $Text = [string]$Value
    if ($Text -match '^(0|[1-9][0-9]*)$') {
        try { return [int]$Text } catch {}
    }
    Write-Warning "Invalid GPU layer count '$Value'; using 0"
    return 0
}

# Reads a config.json value with dot-notation support and a fallback default
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

# Priority: explicit CLI arg > startup.default_model > model
$FinalModel = if ($Model) { $Model } else {
    if ($StartupDefault) { $StartupDefault } else { $ConfigModel }
}
$FinalPort = if ($Port -gt 0) { $Port } else { $ConfigPort }

# Auto-detect a .gguf if none configured
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
$NGpuLayers = Resolve-GpuLayerCount (Get-ConfigValue "n_gpu_layers" 0)
$BatchSize = Resolve-BatchSize (Get-ConfigValue "batch_size" 256)
$UbatchSize = Resolve-BatchSize (Get-ConfigValue "ubatch_size" 256)
if ([int]$UbatchSize -gt [int]$BatchSize) {
    $UbatchSize = $BatchSize
}
$Temperature = Get-ConfigValue "temperature" 0.7
$TopP = Get-ConfigValue "top_p" 0.9
$TopK = Get-ConfigValue "top_k" 40
$RepeatPenalty = Get-ConfigValue "repeat_penalty" 1.1
$MinP = Get-ConfigValue "min_p" 0.05
$HttpThreads = Get-ConfigValue "http_threads" 2
$Threads = Resolve-ThreadCount (Get-ConfigValue "threads" 4)
$ThreadsBatch = Resolve-ThreadCount (Get-ConfigValue "threads_batch" 4)
$FlashAttn = Get-ConfigValue "flash_attn" $true
if ([int]$NGpuLayers -eq 0) { $FlashAttn = $false }
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
Write-Host "  Threads:     $Threads (Batch: $ThreadsBatch)" -ForegroundColor Green
Write-Host ""
 
# Install Lumina Scout dependencies
$ScoutReqs = Join-Path $Root "lumina_scout\requirements.txt"
if (Test-Path $ScoutReqs) {
    Write-Host "Installing Lumina Scout dependencies..." -ForegroundColor Cyan
    pip install -q -r $ScoutReqs 2>&1 | Out-Null
    Write-Host "  Scout dependencies installed" -ForegroundColor Green
}
 
if (-not (Test-Path $LLAMA_SERVER)) {
    Write-Host "ERROR: llama-server.exe not found in bin\" -ForegroundColor Red
    Write-Host "  Download llama.cpp binaries from: https://github.com/ggml-org/llama.cpp/releases/latest"
    exit 1
}
 
$Arguments = @(
    "-m", $ModelPath,
    "--port", $FinalPort,
    "--host", "127.0.0.1",  # Only listen on localhost — no external exposure
    "--ctx-size", $CtxSize,
    "--n-gpu-layers", $NGpuLayers,
    "--batch-size", $BatchSize,
    "--ubatch-size", $UbatchSize,
    "--threads", $Threads,
    "--threads-batch", $ThreadsBatch,
    "--threads-http", $HttpThreads,
    "--temperature", $Temperature,
    "--top-p", $TopP,
    "--top-k", $TopK,
    "--repeat-penalty", $RepeatPenalty,
    "--min-p", $MinP,
    "--cache-type-k", $KvCacheTypeK,
    "--cache-type-v", $KvCacheTypeV,
    "--jinja"  # Jinja2 template support for chat templates
)

# Only add boolean flags when true (llama-server fails on empty flag args)
if ($FlashAttn -eq $true) {
    $Arguments += @("--flash-attn", "on")
} else {
    $Arguments += @("--flash-attn", "off")
}
if ($NoMmap -eq $true) { $Arguments += "--no-mmap" }
if ($ContBatching -eq $true) { $Arguments += "--cont-batching" }

Write-Host "Starting llama-server..." -ForegroundColor Cyan
Write-Host "  Binary: $LLAMA_SERVER" -ForegroundColor Gray
Write-Host "  Args: $($Arguments -join ' ')" -ForegroundColor DarkGray
Write-Host ""

$proc = Start-Process -FilePath $LLAMA_SERVER -ArgumentList $Arguments -NoNewWindow -PassThru
try { $proc.PriorityClass = "High" } catch {}

# Wait up to 30 seconds for the model endpoint to respond
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
