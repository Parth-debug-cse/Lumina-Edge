# ==============================================================================
# LUMINA EDGE :: Unified Launcher (PowerShell)
# All-in-one entry point for chat, API, and multi-model modes
# Usage: .\lumina-launcher.ps1 -Mode {api|core|router} -Gpu {vulkan|nvidia} [-Benchmark]
# ==============================================================================

param(
    [ValidateSet("api", "core", "router")]
    [string]$Mode = "",
    [ValidateSet("vulkan", "nvidia", "mlx")]
    [string]$Gpu = "",
    [string]$Model = "",
    [switch]$Benchmark,
    [switch]$JsonOutput,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# ==================================================
# HELP
# ==================================================
if ($Help -or ($Mode -eq "")) {
    Write-Host ""
    Write-Host "  LUMINA EDGE :: Unified Launcher" -ForegroundColor Cyan
    Write-Host "  ================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Usage: .\lumina-launcher.ps1 -Mode <mode> -Gpu <gpu> [options]"
    Write-Host ""
    Write-Host "  Required:"
    Write-Host "    -Mode      api | core | router"
    Write-Host "    -Gpu       vulkan | nvidia"
    Write-Host ""
    Write-Host "  Optional:"
    Write-Host "    -Benchmark      Run inference benchmark after launch"
    Write-Host "    -JsonOutput     Output in JSON format"
    Write-Host "    -Help           Show this help"
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

# Run system optimizer for dynamic configuration
$OptimizerScript = Join-Path $ScriptsDir "system_optimizer.py"
if ((Test-Path $OptimizerScript) -and (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "  Running system optimizer for dynamic configuration..." -ForegroundColor Cyan
    try {
        $OptimizerResult = python $OptimizerScript 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✓ System optimization completed" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ System optimizer failed, using fallback detection" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "  ⚠ System optimizer failed, using fallback detection" -ForegroundColor Yellow
    }
}

# Load config
$Config = @{}
if (Test-Path $ConfigFile) {
    $Config = Get-Content $ConfigFile -Raw | ConvertFrom-Json -AsHashtable
}

# Detect physical vs logical cores for optimal thread tuning - fully dynamic
try {
    # Try multiple methods for CPU detection
    $Processor = Get-WmiObject Win32_Processor -ErrorAction SilentlyContinue
    if ($Processor) {
        $PhysicalCores = $Processor.NumberOfCores
        $LogicalCores = $Processor.NumberOfLogicalProcessors
    } else {
        # Fallback to CIM instance
        $Processor = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue
        if ($Processor) {
            $PhysicalCores = $Processor.NumberOfCores
            $LogicalCores = $Processor.NumberOfLogicalProcessors
        }
    }
    
    # Additional fallback methods
    if (-not $PhysicalCores -or $PhysicalCores -lt 1) {
        $PhysicalCores = (Get-Counter "\Processor(_Total)\% Processor Time" -ErrorAction SilentlyContinue).CounterSamples.Count
        if (-not $PhysicalCores -or $PhysicalCores -lt 1) {
            $PhysicalCores = $env:NUMBER_OF_PROCESSORS
        }
    }
    if (-not $LogicalCores -or $LogicalCores -lt 1) {
        $LogicalCores = $env:NUMBER_OF_PROCESSORS
    }
    
    # Final validation - ensure minimum values
    if (-not $PhysicalCores -or $PhysicalCores -lt 1) { $PhysicalCores = 1 }
    if (-not $LogicalCores -or $LogicalCores -lt 1) { $LogicalCores = $PhysicalCores }
    
    # Ensure logical >= physical
    if ($LogicalCores -lt $PhysicalCores) { $LogicalCores = $PhysicalCores }
    
} catch {
    # Last resort - use environment variable
    $PhysicalCores = if ($env:NUMBER_OF_PROCESSORS) { [int]$env:NUMBER_OF_PROCESSORS } else { 1 }
    $LogicalCores = $PhysicalCores
}

# Use physical cores for main threads, logical for batch processing
$Threads = $PhysicalCores
$ThreadsBatch = $LogicalCores

# Dynamic batch size based on available memory
try {
    $ComputerInfo = Get-ComputerInfo -ErrorAction SilentlyContinue
    $TotalMemoryGB = [math]::Round($ComputerInfo.TotalPhysicalMemory / 1GB, 0)
    
    if ($TotalMemoryGB -ge 16) {
        $DefaultBatchSize = 1024
    } elseif ($TotalMemoryGB -ge 8) {
        $DefaultBatchSize = 512
    } elseif ($TotalMemoryGB -ge 4) {
        $DefaultBatchSize = 256
    } else {
        $DefaultBatchSize = 128
    }
} catch {
    $DefaultBatchSize = 256  # Conservative fallback
}

# Dynamic context size based on available memory
if ($TotalMemoryGB -ge 32) {
    $DefaultCtxSize = 16384
} elseif ($TotalMemoryGB -ge 16) {
    $DefaultCtxSize = 8192
} elseif ($TotalMemoryGB -ge 8) {
    $DefaultCtxSize = 4096
} elseif ($TotalMemoryGB -ge 4) {
    $DefaultCtxSize = 2048
} else {
    $DefaultCtxSize = 1024
}

# Dynamic thread counts based on physical cores
if ($PhysicalCores -ge 16) {
    $DefaultHttpThreads = 8
    $DefaultParallelSlots = 4
} elseif ($PhysicalCores -ge 8) {
    $DefaultHttpThreads = 4
    $DefaultParallelSlots = 2
} else {
    $DefaultHttpThreads = 2
    $DefaultParallelSlots = 1
}

$CtxSize = if ($Config.ctx_size) { $Config.ctx_size } else { $DefaultCtxSize }
$BatchSize = if ($Config.batch_size) { $Config.batch_size } else { $DefaultBatchSize }
$UbatchSize = if ($Config.ubatch_size) { $Config.ubatch_size } else { $DefaultBatchSize }
$GpuLayers = if ($Config.n_gpu_layers) { $Config.n_gpu_layers } else { "auto" }
$Temperature = if ($Config.temperature) { $Config.temperature } else { 0.7 }
$TopP = if ($Config.top_p -ne $null) { $Config.top_p } else { 0.9 }
$RepeatPenalty = if ($Config.repeat_penalty -ne $null) { $Config.repeat_penalty } else { 1.1 }
$FlashAttn = if ($Config.flash_attn) { "on" } else { "off" }
$UseMlock = if ($Config.use_mlock) { $true } else { $false }
$KvCacheQuant = if ($Config.kv_cache_quant) { $Config.kv_cache_quant } else { "q8_0" }
$SplitMode = if ($Config.split_mode) { $Config.split_mode } else { "row" }
$DefragThold = if ($Config.defrag_thold) { $Config.defrag_thold } else { 0.1 }
$MinP = if ($Config.min_p) { $Config.min_p } else { 0.05 }
$TopK = if ($Config.top_k) { $Config.top_k } else { 20 }
$HttpThreads = if ($Config.http_threads) { $Config.http_threads } else { $DefaultHttpThreads }
$ContBatching = if ($Config.cont_batching) { $true } else { $false }
$ParallelSlots = if ($Config.parallel_slots) { $Config.parallel_slots } else { $DefaultParallelSlots }
$NumaMode = if ($Config.numa_mode) { $Config.numa_mode } else { "none" }

# ==================================================
# VALIDATE ENVIRONMENT
# ==================================================
Write-Host ""
Write-Host "  LUMINA EDGE :: Unified Launcher" -ForegroundColor Cyan
Write-Host "  ================================" -ForegroundColor Cyan
Write-Host ""

# Find llama-server
$LlamaServer = Join-Path $BinDir "llama-server.exe"
if (-not (Test-Path $LlamaServer)) {
    Write-Host "  ERROR: llama-server.exe not found in $BinDir" -ForegroundColor Red
    Write-Host "  Please download llama.cpp and place binaries in the bin/ directory" -ForegroundColor Yellow
    exit 1
}

# Ensure models directory exists
if (-not (Test-Path $ModelsDir)) {
    New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
    Write-Host "  Created models directory: $ModelsDir" -ForegroundColor Gray
}

# ==================================================
# FIND MODELS
# ==================================================
if ($Model -and (Test-Path $Model)) {
    # Model was pre-selected via -Model flag
    $SelectedModel = Get-Item $Model
    if (-not $SelectedModel.Exists) {
        Write-Host "  ERROR: Model file not found: $Model" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Selected: $($SelectedModel.Name)" -ForegroundColor Green
} else {
    # Interactive model selection
    $ModelFiles = Get-ChildItem -Path $ModelsDir -Filter "*.gguf" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending
    if ($ModelFiles.Count -eq 0) {
        Write-Host "  ERROR: No .gguf model files found in $ModelsDir" -ForegroundColor Red
        Write-Host "  Use the model manager to download models first" -ForegroundColor Yellow
        exit 1
    }

    Write-Host "  Available Models:" -ForegroundColor White
    for ($i = 0; $i -lt $ModelFiles.Count; $i++) {
        $size = [math]::Round($ModelFiles[$i].Length / 1GB, 2)
        Write-Host "    [$($i+1)] $($ModelFiles[$i].Name) ($size GB)" -ForegroundColor Gray
    }

    # Select model
    $SelectedIndex = 0
    if ($ModelFiles.Count -gt 1) {
        Write-Host ""
        $choice = Read-Host "  Select model [1-$($ModelFiles.Count)] (default: 1)"
        if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $ModelFiles.Count) {
            $SelectedIndex = [int]$choice - 1
        }
    }

    $SelectedModel = $ModelFiles[$SelectedIndex]
    Write-Host ""
    Write-Host "  Selected: $($SelectedModel.Name)" -ForegroundColor Green
}

# ==================================================
# BUILD COMMAND
# ==================================================
$ModelPath = $SelectedModel.FullName

# Resolve GPU layers with comprehensive dynamic detection
if ($GpuLayers -eq "auto" -or $GpuLayers -eq "") {
    $VramMB = 0
    $EffectiveGpuLayers = 0
    
    if ($Gpu -eq "nvidia") {
        # NVIDIA GPU detection - multiple methods
        try {
            $VramMB = nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>$null
            if ($VramMB) { $VramMB = [int]$VramMB.Split()[0] }
        } catch {}
        
        # Fallback method
        if (-not $VramMB -or $VramMB -lt 1) {
            try {
                $NvidiaInfo = nvidia-smi -q -d MEMORY 2>$null
                if ($NvidiaInfo) {
                    $Match = $NvidiaInfo | Select-String "Total.*:\s*(\d+)"
                    if ($Match) { $VramMB = [int]$Match.Matches[0].Groups[1].Value }
                }
            } catch {}
        }
    } elseif ($Gpu -eq "vulkan") {
        # Vulkan/iGPU detection - estimate based on system memory
        try {
            $ComputerInfo = Get-ComputerInfo
            $TotalMemoryMB = [math]::Round($ComputerInfo.TotalPhysicalMemory / 1MB, 0)
            # Estimate VRAM as 25% of system RAM for iGPU
            $VramMB = [math]::Round($TotalMemoryMB / 4, 0)
            
            # Cap at reasonable limits for iGPU
            if ($VramMB -gt 4096) { $VramMB = 4096 }
            if ($VramMB -lt 512) { $VramMB = 512 }
        } catch {
            $VramMB = 2048  # Conservative fallback
        }
    }
    
    # Dynamic GPU layer calculation based on actual VRAM
    if ($VramMB -gt 0) {
        # More granular VRAM-based layer calculation (matching Linux logic)
        if ($VramMB -lt 512) {
            $EffectiveGpuLayers = 0  # Not enough VRAM
        } elseif ($VramMB -lt 1024) {
            $EffectiveGpuLayers = 5   # ~500MB models
        } elseif ($VramMB -lt 2048) {
            $EffectiveGpuLayers = 12  # ~1GB models  
        } elseif ($VramMB -lt 4096) {
            $EffectiveGpuLayers = 25  # ~2GB models
        } elseif ($VramMB -lt 6144) {
            $EffectiveGpuLayers = 35  # ~3GB models
        } elseif ($VramMB -lt 8192) {
            $EffectiveGpuLayers = 45  # ~4GB models
        } elseif ($VramMB -lt 12288) {
            $EffectiveGpuLayers = 60  # ~6GB models
        } elseif ($VramMB -lt 16384) {
            $EffectiveGpuLayers = 80  # ~8GB models
        } else {
            $EffectiveGpuLayers = 99  # Max offloading
        }
        Write-Host "  Detected VRAM: $VramMB MB -> GPU layers: $EffectiveGpuLayers" -ForegroundColor Gray
    } else {
        # Fallback based on system memory
        try {
            $ComputerInfo = Get-ComputerInfo
            $TotalMemoryGB = [math]::Round($ComputerInfo.TotalPhysicalMemory / 1GB, 0)
            
            if ($TotalMemoryGB -ge 32) {
                $EffectiveGpuLayers = 35
            } elseif ($TotalMemoryGB -ge 16) {
                $EffectiveGpuLayers = 25
            } elseif ($TotalMemoryGB -ge 8) {
                $EffectiveGpuLayers = 15
            } elseif ($TotalMemoryGB -ge 4) {
                $EffectiveGpuLayers = 8
            } else {
                $EffectiveGpuLayers = 0
            }
            Write-Host "  VRAM detection failed, using system memory fallback: $EffectiveGpuLayers layers" -ForegroundColor Yellow
        } catch {
            $EffectiveGpuLayers = 8  # Very conservative fallback
            Write-Host "  All detection failed, using minimal GPU layers: $EffectiveGpuLayers" -ForegroundColor Red
        }
    }
} else {
    # Use user-specified value
    $EffectiveGpuLayers = $GpuLayers
}

if ($Gpu -eq "vulkan") {
    Write-Host "  GPU Backend: Vulkan (iGPU)" -ForegroundColor Yellow
} elseif ($Gpu -eq "nvidia") {
    Write-Host "  GPU Backend: NVIDIA CUDA" -ForegroundColor Green
}

Write-Host "  Physical Cores: $PhysicalCores (threads: $Threads)" -ForegroundColor Gray
Write-Host "  Logical Cores:  $LogicalCores (batch threads: $ThreadsBatch)" -ForegroundColor Gray

# CPU Frequency Governor Integration (Windows)
try {
    # Check if running with admin privileges for power plan changes
    $isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")
    
    if ($isAdmin) {
        # Set power plan to High Performance
        $HighPerformanceGuid = "8c5e7fda-e8bf-4a96-9a85-a6e23a98c45d"
        try {
            & powercfg /setactive $HighPerformanceGuid | Out-Null
            Write-Host "  ✓ Power plan set to High Performance" -ForegroundColor Green
        } catch {
            Write-Host "  ⚠ Could not set power plan (requires admin privileges)" -ForegroundColor Yellow
        }
        
        # Disable CPU idle states
        try {
            & powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR IDLEDEMOTE 0 | Out-Null
            & powercfg /setdcvalueindex SCHEME_CURRENT SUB_PROCESSOR IDLEDEMOTE 0 | Out-Null
            Write-Host "  ✓ CPU idle states disabled for maximum performance" -ForegroundColor Green
        } catch {
            Write-Host "  ⚠ Could not disable CPU idle states" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  ⚠ CPU optimizations require administrator privileges" -ForegroundColor Yellow
        Write-Host "    Run as administrator to enable power plan optimizations" -ForegroundColor Gray
    }
} catch {
    Write-Host "  ⚠ CPU optimization setup failed" -ForegroundColor Yellow
}

# Initialize Performance Monitoring
$MonitorScript = Join-Path $ScriptsDir "performance_monitor.py"
$MonitorLog = Join-Path $RootDir "cache\performance_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"
$MonitorPid = $null

if ((Test-Path $MonitorScript) -and (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "  Starting performance monitor..." -ForegroundColor Cyan
    $MonitorProcess = Start-Process -FilePath "python" -ArgumentList @($MonitorScript, "--log-file", $MonitorLog, "--update-interval", "2.0") -PassThru
    $MonitorPid = $MonitorProcess.Id
    Write-Host "  Performance monitor PID: $MonitorPid" -ForegroundColor Gray
    Write-Host "  Log file: $MonitorLog" -ForegroundColor Gray
}

# Check llama.cpp version freshness
try {
    $VersionOutput = & $LlamaServer --version 2>&1 | Select-Object -First 5
    if ($VersionOutput) {
        Write-Host "  llama.cpp version check:" -ForegroundColor Gray
        $VersionOutput | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        
        # Check if build mentions build date and warn if old
        if ($VersionOutput -match "build") {
            Write-Host "  ⚠ llama.cpp build age check: Consider rebuilding from source for latest optimizations if build is older than 30 days." -ForegroundColor Yellow
        }
    }
} catch {
    # Version check failed, continue silently
}

# ==================================================
# LAUNCH
# ==================================================
Write-Host ""
Write-Host "  Starting Lumina Edge..." -ForegroundColor Cyan
Write-Host "  Mode: $Mode | GPU: $Gpu | Model: $($SelectedModel.Name)" -ForegroundColor Gray
Write-Host ""

$ApiPort = if ($Config.api_port) { $Config.api_port } else { 1234 }

switch ($Mode) {
    "api" {
        $args = @(
            "-m", $ModelPath,
            "--port", $ApiPort.ToString(),
            "--host", "127.0.0.1",
            "--ctx-size", $CtxSize.ToString(),
            "--n-gpu-layers", $EffectiveGpuLayers.ToString(),
            "--threads", $Threads.ToString(),
            "--threads-batch", $ThreadsBatch.ToString(),
            "--batch-size", $BatchSize.ToString(),
            "--ubatch-size", $UbatchSize.ToString(),
            "--flash-attn", $FlashAttn,
            "--defrag-thold", $DefragThold.ToString(),
            "--warmup",
            "--ctx-shift",
            "--min-p", $MinP.ToString(),
            "--top-k", $TopK.ToString(),
            "--top-p", $TopP.ToString(),
            "--repeat-penalty", $RepeatPenalty.ToString(),
            "--threads-http", $HttpThreads.ToString()
        )
        if ($UseMlock) { $args += "--mlock" }
        if ($ContBatching) { $args += "--cont-batching"; $args += "--parallel"; $args += $ParallelSlots.ToString() }
        if ($NumaMode -ne "none") { $args += "--numa"; $args += $NumaMode }
        if ($KvCacheQuant) { $args += "--cache-type-k", $KvCacheQuant; $args += "--cache-type-v", $KvCacheQuant }
        
        # GPU-specific optimizations
        if ($Gpu -eq "nvidia") {
            $args += "--split-mode", "layer"
        } elseif ($Gpu -eq "vulkan") {
            $args += "--split-mode", "row"
            $args += "--no-kv-offload"
            $args += "--device", "vulkan0"
        }

        Write-Host "  Command: $LlamaServer $($args -join ' ')" -ForegroundColor DarkGray
        Write-Host ""
        
        try {
            & $LlamaServer @args
        } finally {
            # Cleanup performance monitor
            if ($MonitorPid) {
                try {
                    Stop-Process -Id $MonitorPid -Force -ErrorAction SilentlyContinue
                    Write-Host "  ✓ Performance monitor stopped" -ForegroundColor Green
                } catch {
                    Write-Host "  ⚠ Could not stop performance monitor" -ForegroundColor Yellow
                }
            }
        }
    }
    "core" {
        $LlamaCli = Join-Path $BinDir "llama-cli.exe"
        if (-not (Test-Path $LlamaCli)) {
            Write-Host "  ERROR: llama-cli.exe not found" -ForegroundColor Red
            exit 1
        }
        $args = @(
            "-m", $ModelPath,
            "--n-gpu-layers", $EffectiveGpuLayers.ToString(),
            "--ctx-size", $CtxSize.ToString(),
            "--threads", $Threads.ToString(),
            "--threads-batch", $ThreadsBatch.ToString(),
            "--batch-size", $BatchSize.ToString(),
            "--ubatch-size", $UbatchSize.ToString(),
            "--temp", $Temperature.ToString(),
            "--top-p", $TopP.ToString(),
            "--repeat-penalty", $RepeatPenalty.ToString(),
            "--flash-attn",
            "--defrag-thold", $DefragThold.ToString(),
            "--warmup",
            "--ctx-shift",
            "--min-p", $MinP.ToString(),
            "--top-k", $TopK.ToString(),
            "-n", "128"
        )
        if ($UseMlock) { $args += "--mlock" }
        if ($KvCacheQuant) { $args += "--cache-type-k", $KvCacheQuant; $args += "--cache-type-v", $KvCacheQuant }
        
        # GPU-specific optimizations
        if ($Gpu -eq "nvidia") {
            $args += "--split-mode", "layer"
        } elseif ($Gpu -eq "vulkan") {
            $args += "--split-mode", "row"
            $args += "--no-kv-offload"
            $args += "--device", "vulkan0"
        }
        
        # NUMA optimization
        if ($NumaMode -ne "none") {
            $args += "--numa", $NumaMode
        }

        Write-Host "  Command: $LlamaCli $($args -join ' ')" -ForegroundColor DarkGray
        Write-Host ""
        
        try {
            & $LlamaCli @args
        } finally {
            # Cleanup performance monitor
            if ($MonitorPid) {
                try {
                    Stop-Process -Id $MonitorPid -Force -ErrorAction SilentlyContinue
                    Write-Host "  ✓ Performance monitor stopped" -ForegroundColor Green
                } catch {
                    Write-Host "  ⚠ Could not stop performance monitor" -ForegroundColor Yellow
                }
            }
        }
    }
    "router" {
        $PythonCmd = "python"
        $VenvPython = Join-Path $RootDir "venv\Scripts\python.exe"
        if (Test-Path $VenvPython) { $PythonCmd = $VenvPython }

        $RouterScript = Join-Path $ScriptsDir "model-router.py"
        $args = @(
            $RouterScript, "load", $ModelPath,
            "--bin-path", $BinDir,
            "--scripts", $ScriptsDir,
            "--models-dir", $ModelsDir
        )

        Write-Host "  Command: $PythonCmd $($args -join ' ')" -ForegroundColor DarkGray
        Write-Host ""
        & $PythonCmd @args
    }
}
