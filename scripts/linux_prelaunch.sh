#!/usr/bin/env bash
# ==============================================================================
# Lumina Edge — Linux Pre-launch System Optimizer
# Maximizes llama.cpp inference performance on Linux/Intel hardware
# Safe to run without root — root-only optimizations are attempted but skipped
# ==============================================================================

set -e  # exit on error
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[Lumina Edge] Linux system optimizer starting..."

# ── 1. CPU GOVERNOR ────────────────────────────────────────────────────────────
# Already 'performance' on this machine — verify and set if not
GOVERNOR=$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor 2>/dev/null || echo "unknown")
if [ "$GOVERNOR" != "performance" ]; then
    echo "[CPU] Setting performance governor..."
    if command -v cpupower &>/dev/null; then
        sudo -n cpupower frequency-set -g performance 2>/dev/null && \
            echo "[CPU] ✓ Governor set to performance" || \
            echo "[CPU] ⚠ Governor unchanged (sudo required)"
    else
        for cpu in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
            echo "performance" | sudo -n tee "$cpu" &>/dev/null || true
        done
    fi
else
    echo "[CPU] ✓ Governor already: performance"
fi

# ── 2. CPU BOOST (Intel Turbo) ─────────────────────────────────────────────────
# Ensure Intel Turbo Boost is enabled — some power managers disable it
BOOST_FILE="/sys/devices/system/cpu/cpufreq/boost"
if [ -f "$BOOST_FILE" ]; then
    BOOST=$(cat "$BOOST_FILE")
    if [ "$BOOST" = "0" ]; then
        echo "1" | sudo -n tee "$BOOST_FILE" &>/dev/null && \
            echo "[CPU] ✓ Intel Turbo Boost enabled" || \
            echo "[CPU] ⚠ Could not enable Turbo Boost (sudo required)"
    else
        echo "[CPU] ✓ Intel Turbo Boost already enabled"
    fi
fi

# ── 3. TRANSPARENT HUGE PAGES ──────────────────────────────────────────────────
# THP allows the kernel to use 2MB pages for large allocations (like model weights)
# This reduces TLB misses during inference — measurable speedup on llama.cpp
THP_FILE="/sys/kernel/mm/transparent_hugepage/enabled"
if [ -f "$THP_FILE" ]; then
    THP=$(cat "$THP_FILE")
    if echo "$THP" | grep -q "\[madvise\]\|\[always\]"; then
        echo "[MEM] ✓ Transparent huge pages: $(cat $THP_FILE)"
    else
        echo "madvise" | sudo -n tee "$THP_FILE" &>/dev/null && \
            echo "[MEM] ✓ Transparent huge pages set to madvise" || \
            echo "[MEM] ⚠ Could not set THP (sudo required)"
    fi
    
    # Also set defrag to defer — reduces latency spikes during allocation
    THP_DEFRAG="/sys/kernel/mm/transparent_hugepage/defrag"
    if [ -f "$THP_DEFRAG" ]; then
        echo "defer+madvise" | sudo -n tee "$THP_DEFRAG" &>/dev/null || true
    fi
fi

# ── 4. SWAPPINESS ──────────────────────────────────────────────────────────────
# Default swappiness=60 means kernel starts swapping when RAM is 40% used
# For inference workloads we want to keep model weights in RAM as long as possible
# Setting to 10 means kernel only swaps under extreme memory pressure
CURRENT_SWAPPINESS=$(cat /proc/sys/vm/swappiness 2>/dev/null || echo "60")
if [ "$CURRENT_SWAPPINESS" -gt "10" ]; then
    echo "10" | sudo -n tee /proc/sys/vm/swappiness &>/dev/null && \
        echo "[MEM] ✓ Swappiness set to 10 (was $CURRENT_SWAPPINESS)" || \
        echo "[MEM] ⚠ Could not set swappiness (sudo required, was $CURRENT_SWAPPINESS)"
else
    echo "[MEM] ✓ Swappiness already optimal: $CURRENT_SWAPPINESS"
fi

# ── 5. DIRTY PAGE WRITEBACK ────────────────────────────────────────────────────
# Reduce dirty page writeback frequency to avoid I/O contention during inference
# This matters during model load when the kernel is reading large files
echo "500" | sudo -n tee /proc/sys/vm/dirty_writeback_centisecs &>/dev/null || true
echo "20" | sudo -n tee /proc/sys/vm/dirty_ratio &>/dev/null || true

# ── 6. INTEL iGPU: ENABLE VULKAN ENVIRONMENT ───────────────────────────────────
# Set Mesa/ANV Vulkan environment variables for Intel Iris Plus
# These are read by llama-server when it initializes Vulkan
export MESA_VK_DEVICE_SELECT_FORCE_DEFAULT_DEVICE=1
export ANV_QUEUE_THREAD_DISABLE=0
# No AMD Vulkan env vars here — linux_prelaunch.sh targets Intel iGPU/Vulkan
# AMD users should use AMD-specific scripts or set RADV flags themselves

# Check if Vulkan is available for Intel
if command -v vulkaninfo &>/dev/null; then
    VULKAN_DEVICE=$(vulkaninfo 2>/dev/null | grep "deviceName" | head -1 | awk -F'=' '{print $2}' | xargs)
    if [ -n "$VULKAN_DEVICE" ]; then
        echo "[GPU] ✓ Vulkan device: $VULKAN_DEVICE"
    else
        echo "[GPU] ⚠ Vulkan available but no device detected"
    fi
else
    echo "[GPU] ℹ vulkaninfo not installed (apt install vulkan-tools to verify)"
fi

# ── 7. FILE DESCRIPTOR LIMITS ──────────────────────────────────────────────────
# llama-server opens many file descriptors during model load
# Default limit (1024) can be hit with large models
CURRENT_NOFILE=$(ulimit -n)
if [ "$CURRENT_NOFILE" -lt "65536" ]; then
    ulimit -n 65536 2>/dev/null && \
        echo "[SYS] ✓ File descriptor limit: 65536" || \
        echo "[SYS] ⚠ Could not increase fd limit (current: $CURRENT_NOFILE)"
else
    echo "[SYS] ✓ File descriptor limit already: $CURRENT_NOFILE"
fi

# ── 8. MEMORY COMPACTION ───────────────────────────────────────────────────────
# Compact memory before model load to create contiguous pages for mmap
# This reduces model load time significantly on fragmented systems
echo "1" | sudo -n tee /proc/sys/vm/compact_memory &>/dev/null && \
    echo "[MEM] ✓ Memory compacted" || \
    echo "[MEM] ⚠ Memory compaction skipped (sudo required)"

# ── 9. SCHEDULER TUNING ────────────────────────────────────────────────────────
# Set scheduler to prioritize throughput over latency for inference workloads
# SCHED_BATCH is ideal for CPU-bound compute tasks like llama.cpp
if command -v chrt &>/dev/null; then
    echo "[SYS] ✓ chrt available for process scheduling"
    # Note: actual chrt is applied per-process in api-server.js, not here
fi

echo ""
echo "[Lumina Edge] ✓ Linux optimization complete"
echo "[Lumina Edge] ✓ Environment ready for llama-server"
