#!/usr/bin/env python3
# ==============================================================================
# LUMINA EDGE :: System Optimizer (Cross-Platform)
# Objective: Free system memory before LLM inference
# Supports: Linux (systemd), Windows, macOS
# ==============================================================================

import sys
import os
import platform
import subprocess
import json
from pathlib import Path

class Colors:
    """ANSI color codes"""
    CYAN = '\033[0;36m'
    GREEN = '\033[0;32m'
    YELLOW = '\033[1;33m'
    RED = '\033[0;31m'
    GRAY = '\033[0;90m'
    NC = '\033[0m'

def log_info(msg: str):
    """Info message"""
    print(f"{Colors.CYAN}[INFO]{Colors.NC} {msg}")

def log_success(msg: str):
    """Success message"""
    print(f"{Colors.GREEN}[+]{Colors.NC} {msg}")

def log_warn(msg: str):
    """Warning message"""
    print(f"{Colors.YELLOW}[WARN]{Colors.NC} {msg}")

def log_error(msg: str):
    """Error message"""
    print(f"{Colors.RED}[ERROR]{Colors.NC} {msg}")

def get_platform() -> str:
    """Get OS name"""
    return platform.system().lower()

def get_memory_stats() -> int:
    """Get available memory in MB"""
    system = get_platform()
    
    try:
        if system == 'linux':
            with open('/proc/meminfo', 'r') as f:
                for line in f:
                    if line.startswith('MemAvailable'):
                        return int(line.split()[1]) // 1024
        elif system == 'windows':
            import ctypes
            windll = getattr(ctypes, 'windll', None)
            if windll is None:
                return 0
            kernel32 = windll.kernel32
            c_ulong = ctypes.c_ulong
            class MemoryStatus(ctypes.Structure):
                _fields_ = [
                    ("dwLength", c_ulong),
                    ("dwMemoryLoad", c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullExtendedVirtual", ctypes.c_ulonglong),
                ]
            stat = MemoryStatus()
            stat.dwLength = ctypes.sizeof(MemoryStatus)
            if kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
                return stat.ullAvailPhys // (1024 * 1024)
        elif system == 'darwin':
            result = subprocess.run(['vm_stat'], capture_output=True, text=True)
            # Parse darwin memory (simplified)
            for line in result.stdout.split('\n'):
                if 'Pages free' in line:
                    pages_free = int(line.split(': ')[1].split('.')[0])
                    return (pages_free * 4) // 1024  # 4KB pages
    except Exception as e:
        log_warn(f"Could not read memory: {e}")
    
    return 0

def optimize_linux() -> int:
    """Optimize Linux system"""
    log_info("Optimizing Linux system...")
    
    mem_before = get_memory_stats()

    
    # Check for root
    have_root = os.geteuid() == 0 if hasattr(os, 'geteuid') else True
    
    if not have_root:
        log_warn("Not running as root. Some optimizations will be skipped.")
        log_warn("Re-run with sudo for full memory reclamation.")
    
    # Dropping caches is a system-wide tradeoff: opt in explicitly and run as root.
    if os.environ.get('LUMINA_DROP_CACHES') == '1' and have_root:
        try:
            log_success("Syncing filesystem and dropping reclaimable caches...")
            subprocess.run(['sync'], check=False)
            with open('/proc/sys/vm/drop_caches', 'w') as f:
                f.write('3')
            log_info("Reclaimable page cache, dentries, and inodes dropped.")
        except Exception as e:
            log_warn(f"Cache drop failed: {e}")
    else:
        log_info("Skipping cache drop (set LUMINA_DROP_CACHES=1 and run as root to opt in).")
    
    system_tuning_enabled = os.environ.get('LUMINA_SYSTEM_TUNING') == '1'

    # Host-level tuning is opt-in. Service management is intentionally left to
    # the operator so we never stop unrelated host services or need a restore file.
    if system_tuning_enabled and have_root:
        compact_path = Path('/proc/sys/vm/compact_memory')
        if compact_path.exists():
            try:
                log_success("Compacting memory...")
                with open(compact_path, 'w') as f:
                    f.write('1')
            except Exception as e:
                log_warn(f"Memory compaction failed: {e}")

        thp_path = Path('/sys/kernel/mm/transparent_hugepage/enabled')
        if thp_path.exists():
            try:
                log_success("Setting Transparent Huge Pages to madvise...")
                with open(thp_path, 'w') as f:
                    f.write('madvise')
            except Exception as e:
                log_warn(f"THP setting failed: {e}")

        try:
            result = subprocess.run(
                ['cpupower', 'frequency-set', '-g', 'performance'],
                capture_output=True,
            )
            if result.returncode == 0:
                log_success("CPU frequency governor set to performance")
            else:
                log_warn("Could not set CPU frequency governor (cpupower may not be installed)")
        except Exception as e:
            log_warn(f"CPU frequency governor setup failed: {e}")

        swappiness_path = Path('/proc/sys/vm/swappiness')
        if swappiness_path.exists():
            try:
                log_success("Reducing swappiness to prefer RAM over swap...")
                with open(swappiness_path, 'w') as f:
                    f.write('10')
            except Exception as e:
                log_warn(f"Swappiness reduction failed: {e}")
    else:
        log_info("Host tuning skipped (set LUMINA_SYSTEM_TUNING=1 and run as root to opt in).")

    numa_path = Path('/sys/devices/system/node/node1')
    if numa_path.exists():
        log_info("Multi-socket NUMA system detected; review NUMA placement for inference.")

    mem_after = get_memory_stats()
    mem_freed = max(0, mem_after - mem_before)

    print()
    log_success("System inspection complete.")
    if mem_freed > 0:
        log_info(f"Approximately {mem_freed} MB freed.")
    log_info("No host services were stopped.")
    
    return 0

def optimize_windows() -> int:
    """Inspect Windows state; host power changes require explicit opt-in."""
    log_info("Inspecting Windows system...")

    mem_before = get_memory_stats()
    if os.environ.get('LUMINA_SYSTEM_TUNING') == '1':
        try:
            log_info("Applying opt-in power settings...")
            subprocess.run(
                ['powercfg', '-setacvalueindex', 'scheme_current', 'sub_processor', 'CPMINCORES', '100'],
                capture_output=True,
            )
            subprocess.run(
                ['powercfg', '/setactive', '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c'],
                capture_output=True,
            )
        except Exception as e:
            log_warn(f"Windows power tuning failed: {e}")
    else:
        log_info("Host power settings unchanged (set LUMINA_SYSTEM_TUNING=1 to opt in).")

    mem_after = get_memory_stats()
    mem_freed = max(0, mem_after - mem_before)

    print()
    log_success("System inspection complete.")
    if mem_freed > 0:
        log_info(f"Approximately {mem_freed} MB freed.")

    return 0

def optimize_macos() -> int:
    """Optimize macOS system"""
    log_info("Optimizing macOS system...")
    
    mem_before = get_memory_stats()
    
    try:
        if os.environ.get('LUMINA_PURGE_MEMORY') == '1':
            log_info("Purging memory (explicitly enabled)...")
            subprocess.run(['purge'], capture_output=True, check=False)
        else:
            log_info("Memory purge skipped (set LUMINA_PURGE_MEMORY=1 to opt in).")

        # MLX upgrade reminder
        log_info("Recommendation: Run 'pip install --upgrade mlx mlx-lm' for latest Metal shader improvements")
        
    except Exception as e:
        log_error(f"macOS optimization failed: {e}")
        return 1
    
    mem_after = get_memory_stats()
    mem_freed = max(0, mem_after - mem_before)
    
    print()
    log_success("System inspection complete.")
    if mem_freed > 0:
        log_info(f"Approximately {mem_freed} MB freed.")
    
    return 0

def main():
    """Main entry point"""
    system = get_platform()
    
    print()
    log_info(f"Executing Lumina Edge System Optimization ({system})...")
    print()
    
    if system == 'linux':
        return optimize_linux()
    elif system == 'windows':
        return optimize_windows()
    elif system == 'darwin':
        return optimize_macos()
    else:
        log_error(f"Unsupported platform: {system}")
        return 1

if __name__ == '__main__':
    sys.exit(main())
