# ==============================================================================
# LUMINA EDGE :: Windows Pre-launch System Optimizer
# Maximizes llama.cpp inference performance on Windows
# Run as Administrator for full optimizations (some silently skip if not elevated)
# ==============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = "Continue"
$Host.UI.RawUI.WindowTitle = "Lumina Edge - Windows System Optimizer"

function Write-Status {
    param([string]$Message, [string]$Status = "info")
    $colors = @{ "ok" = "Green"; "warn" = "Yellow"; "error" = "Red"; "info" = "Cyan" }
    $prefixes = @{ "ok" = "✓"; "warn" = "⚠"; "error" = "✗"; "info" = "ℹ" }
    $color = $colors[$Status]
    $prefix = $prefixes[$Status]
    Write-Host "[$prefix] " -ForegroundColor $color -NoNewline
    Write-Host $Message
}

Write-Host ""
Write-Host "  LUMINA EDGE :: Windows System Optimizer" -ForegroundColor Cyan
Write-Host "  ======================================" -ForegroundColor Cyan
Write-Host ""

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")

# ── 1. POWER PLAN ────────────────────────────────────────────────────────────
Write-Status "Checking power plan..." "info"
try {
    $currentPlan = powercfg /getactivescheme 2>$null
    if ($currentPlan -match "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c") {
        Write-Status "Power plan: High Performance (already set)" "ok"
    } elseif ($currentPlan -match "e9a42b02-d5df-448d-aa00-03f14749eb61") {
        Write-Status "Power plan: Ultimate Performance (already set)" "ok"
    } else {
        if ($isAdmin) {
            # Try to set High Performance
            $highPerfGuid = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
            $result = powercfg /setactive $highPerfGuid 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Status "Power plan set to High Performance" "ok"
            } else {
                Write-Status "Could not set High Performance power plan" "warn"
            }
        } else {
            Write-Status "Run as Administrator to set High Performance power plan" "warn"
        }
    }
} catch {
    Write-Status "Could not check/set power plan: $_" "warn"
}

# ── 2. DISABLE CPU IDLE STATES (Performance boost) ────────────────────────────
Write-Status "Checking CPU idle states..." "info"
try {
    # Check current idle state settings
    $idleDisable = powercfg /query SCHEME_CURRENT SUB_PROCESSOR IDLEDISABLE 2>$null | Select-String "Current AC Power Setting Index"
    if ($idleDisable -match "0x00000001") {
        Write-Status "CPU idle states: Disabled (performance mode)" "ok"
    } else {
        if ($isAdmin) {
            # Disable idle states for AC power
            $result = powercfg /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR IDLEDISABLE 1 2>&1
            powercfg /setactive SCHEME_CURRENT 2>$null | Out-Null
            Write-Status "CPU idle states disabled for AC power" "ok"
        } else {
            Write-Status "Run as Administrator to disable CPU idle states" "warn"
        }
    }
} catch {
    Write-Status "Could not configure CPU idle states: $_" "warn"
}

# ── 3. PROCESS PRIORITY & AFFINITY ───────────────────────────────────────────
Write-Status "Setting process priority for current session..." "info"
try {
    $process = Get-Process -Id $PID
    $process.PriorityClass = "High"
    Write-Status "Process priority set to High" "ok"
} catch {
    Write-Status "Could not set process priority: $_" "warn"
}

# ── 4. MEMORY OPTIMIZATION ──────────────────────────────────────────────────
Write-Status "Checking memory configuration..." "info"
try {
    $computerSystem = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction SilentlyContinue
    $totalGB = [math]::Round($computerSystem.TotalPhysicalMemory / 1GB, 2)
    Write-Status "Total physical memory: $totalGB GB" "info"

    # Check if large pages might be beneficial (typically for 32GB+ systems)
    if ($totalGB -ge 32) {
        Write-Status "Large memory system detected - consider enabling Large Pages in config" "info"
    }
} catch {
    Write-Status "Could not query memory information: $_" "warn"
}

# ── 5. GPU CHECK (NVIDIA) ───────────────────────────────────────────────────
Write-Status "Checking for NVIDIA GPU..." "info"
try {
    $nvidiaSmi = Get-Command "nvidia-smi" -ErrorAction SilentlyContinue
    if ($nvidiaSmi) {
        $gpuInfo = nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits 2>$null
        if ($gpuInfo) {
            $parts = $gpuInfo.Split(",")
            if ($parts.Count -ge 3) {
                $gpuName = $parts[0].Trim()
                $vramMB = [int]$parts[1].Trim()
                Write-Status "NVIDIA GPU detected: $gpuName ($vramMB MB VRAM)" "ok"
            }
        }
    } else {
        Write-Status "nvidia-smi not found - no NVIDIA GPU or drivers not installed" "info"
    }
} catch {
    Write-Status "Could not query GPU information: $_" "warn"
}

# ── 6. FILE SYSTEM CACHE OPTIMIZATION ────────────────────────────────────────
Write-Status "Optimizing file system cache..." "info"
try {
    if ($isAdmin) {
        # Increase file system cache size for better I/O performance during model load
        # This is a memory trade-off that benefits large file operations
        $result = fsutil behavior set memoryusage 2 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Status "File system cache optimized for applications" "ok"
        } else {
            Write-Status "Could not optimize file system cache" "warn"
        }
    } else {
        Write-Status "Run as Administrator to optimize file system cache" "warn"
    }
} catch {
    Write-Status "Could not optimize file system cache: $_" "warn"
}

# ── 7. DISABLE WINDOWS SEARCH INDEXING (temporarily) ─────────────────────────
Write-Status "Checking Windows Search indexing..." "info"
try {
    $searchService = Get-Service -Name "WSearch" -ErrorAction SilentlyContinue
    if ($searchService -and $searchService.Status -eq "Running") {
        if ($isAdmin) {
            Stop-Service -Name "WSearch" -Force -ErrorAction SilentlyContinue | Out-Null
            Write-Status "Windows Search indexing temporarily stopped" "ok"
            Write-Status "   (Will auto-restart on next boot or can be manually started)" "info"
        } else {
            Write-Status "Run as Administrator to temporarily stop Windows Search" "warn"
        }
    } else {
        Write-Status "Windows Search not running or not installed" "info"
    }
} catch {
    Write-Status "Could not check/stop Windows Search: $_" "warn"
}

# ── 8. NETWORK OPTIMIZATION (for API mode) ────────────────────────────────────
Write-Status "Optimizing network settings..." "info"
try {
    if ($isAdmin) {
        # Disable Nagle's algorithm for better TCP latency (affects local API responsiveness)
        $tcpParams = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" -Name "TcpAckFrequency" -ErrorAction SilentlyContinue
        if (-not $tcpParams) {
            Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters" -Name "TcpAckFrequency" -Value 1 -Type DWord -Force | Out-Null
            Write-Status "TCP latency optimization applied" "ok"
        } else {
            Write-Status "TCP already optimized" "ok"
        }
    } else {
        Write-Status "Run as Administrator to optimize network settings" "warn"
    }
} catch {
    Write-Status "Could not optimize network settings: $_" "warn"
}

# ── 9. TEMP CLEANUP ───────────────────────────────────────────────────────────
Write-Status "Cleaning temporary files..." "info"
try {
    $tempItems = 0
    $tempDirs = @($env:TEMP, "C:\Windows\Temp")
    foreach ($dir in $tempDirs) {
        if (Test-Path $dir) {
            Get-ChildItem -Path $dir -File -Recurse -ErrorAction SilentlyContinue | 
                Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | 
                Remove-Item -Force -ErrorAction SilentlyContinue
            $tempItems++
        }
    }
    Write-Status "Temporary files older than 7 days cleaned" "ok"
} catch {
    Write-Status "Could not clean temporary files: $_" "warn"
}

Write-Host ""
Write-Status "Windows optimization complete" "ok"
if (-not $isAdmin) {
    Write-Status "Run as Administrator for maximum performance gains" "warn"
}
Write-Host ""
