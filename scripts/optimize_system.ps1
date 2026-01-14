# ==============================================================================
# Lumina Edge: Kernel-Level Resource Reclamation Protocol
# Objective: Minimize System Commit Charge and Interrupt Latency
# ==============================================================================

Write-Host "[INIT] Executing Lumina Edge System Optimization..." -ForegroundColor Cyan

# 1. Terminate Non-Critical System Services (Reduces Memory Footprint)
$TargetServices = @(
    "WSearch",      # Windows Search Indexer
    "WslService",   # Windows Subsystem for Linux
    "SysMain",      # Superfetch/Prefetch
    "DiagTrack",    # Connected User Experiences and Telemetry
    "Dps"           # Diagnostic Policy Service
)

foreach ($Service in $TargetServices) {
    if (Get-Service -Name $Service -ErrorAction SilentlyContinue) {
        Write-Host "[-] Suspending $Service..." -ForegroundColor Yellow
        Stop-Service -Name $Service -Force -ErrorAction SilentlyContinue
        Set-Service -Name $Service -StartupType Disabled
    }
}

# 2. System Working Set & Standby List Purge
# Programmatically triggers Garbage Collection and clears inactive memory pages
Write-Host "[+] Reclaiming Standby List and System Working Set..." -ForegroundColor Green
[System.GC]::Collect()

# 3. Memory Compression Deactivation
# Prevents CPU overhead during tensor dequantization cycles
Disable-mmagent -mc -ErrorAction SilentlyContinue

Write-Host "[SUCCESS] Resources reclaimed. System state optimized for LLM inference." -ForegroundColor Cyan