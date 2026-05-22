#!/usr/bin/env bash
# ==============================================================================
# Lumina Edge — Linux Pre-launch System Optimizer
# Maximizes llama.cpp inference performance on Linux/Intel hardware
# Safe to run without root — root-only optimizations are attempted but skipped
# ==============================================================================

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[Lumina Edge] Linux system optimizer starting..."

# ── 1. CPU GOVERNOR ────────────────────────────────────────────────────────────
# Check current governor; if not 'performance', try to set it
# cpupower is the cleanest method; fallback is writing to each CPU's sysfs
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
# Some BIOS/power managers disable turbo — force it on for max inference perf
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
# THP allows 2MB pages instead of 4KB — reduces TLB misses during inference
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

    # Defrag policy: defer+madvise avoids allocation-time latency spikes
    THP_DEFRAG="/sys/kernel/mm/transparent_hugepage/defrag"
    if [ -f "$THP_DEFRAG" ]; then
        echo "defer+madvise" | sudo -n tee "$THP_DEFRAG" &>/dev/null || true
    fi
fi

# ── 4. SWAPPINESS ──────────────────────────────────────────────────────────────
# Default swappiness=60 means kernel starts swapping at 40% RAM usage
# For inference, we want model weights in RAM as long as possible
# swappiness=10 means kernel only swaps under extreme memory pressure
CURRENT_SWAPPINESS=$(cat /proc/sys/vm/swappiness 2>/dev/null || echo "60")
if [ "$CURRENT_SWAPPINESS" -gt "10" ]; then
    echo "10" | sudo -n tee /proc/sys/vm/swappiness &>/dev/null && \
        echo "[MEM] ✓ Swappiness set to 10 (was $CURRENT_SWAPPINESS)" || \
        echo "[MEM] ⚠ Could not set swappiness (sudo required, was $CURRENT_SWAPPINESS)"
else
    echo "[MEM] ✓ Swappiness already optimal: $CURRENT_SWAPPINESS"
fi

# ── 5. DIRTY PAGE WRITEBACK ────────────────────────────────────────────────────
# Reduce writeback frequency to avoid I/O contention during model load
echo "500" | sudo -n tee /proc/sys/vm/dirty_writeback_centisecs &>/dev/null || true
echo "20" | sudo -n tee /proc/sys/vm/dirty_ratio &>/dev/null || true

# ── 6. INTEL iGPU: ENABLE VULKAN ENVIRONMENT ───────────────────────────────────
# Mesa/ANV Vulkan env vars for Intel Iris Plus — read by llama-server at init
export MESA_VK_DEVICE_SELECT_FORCE_DEFAULT_DEVICE=1
export ANV_QUEUE_THREAD_DISABLE=0

if command -v vulkaninfo &>/dev/null; then
    gpu_name=$(vulkaninfo 2>/dev/null | grep "deviceName" | head -1 | awk -F'=' '{print $2}' | xargs) || gpu_name="unknown"
    if [ -n "$gpu_name" ]; then
        echo "[GPU] ✓ Vulkan device: $gpu_name"
    else
        echo "[GPU] ⚠ Vulkan available but no device detected"
    fi
else
    echo "[GPU] ℹ vulkaninfo not installed (apt install vulkan-tools to verify)"
fi

# ── 7. FILE DESCRIPTOR LIMITS ──────────────────────────────────────────────────
# llama-server opens many FDs during model load — the default 1024 can be too low
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
echo "1" | sudo -n tee /proc/sys/vm/compact_memory &>/dev/null && \
    echo "[MEM] ✓ Memory compacted" || \
    echo "[MEM] ⚠ Memory compaction skipped (sudo required)"

# ── 9. SCHEDULER TUNING ────────────────────────────────────────────────────────
if command -v chrt &>/dev/null; then
    echo "[SYS] ✓ chrt available for process scheduling"
fi

echo ""
echo "[Lumina Edge] ✓ Linux optimization complete"
echo "[Lumina Edge] ✓ Environment ready for llama-server"
