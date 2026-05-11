#!/usr/bin/env python3
"""
Resource Monitor
Real-time monitoring of CPU, RAM, iGPU/GPU utilization for LLM inference.
"""

import os
import sys
import json
import time
import argparse
import platform
import subprocess
from pathlib import Path


def get_cpu_info():
    """Get CPU utilization and frequency info - cross-platform."""
    result = {
        "usage_pct": 0,
        "cores": 0,
        "freq_mhz": 0,
        "model": "unknown"
    }

    system = platform.system()

    if system == "Linux":
        try:
            # CPU usage from /proc/stat
            with open('/proc/stat', 'r') as f:
                line1 = f.readline()
            fields = line1.split()
            idle1 = int(fields[4])
            total1 = sum(int(x) for x in fields[1:])

            time.sleep(0.1)

            with open('/proc/stat', 'r') as f:
                line2 = f.readline()
            fields = line2.split()
            idle2 = int(fields[4])
            total2 = sum(int(x) for x in fields[1:])

            diff_idle = idle2 - idle1
            diff_total = total2 - total1
            result["usage_pct"] = round((1 - diff_idle / diff_total) * 100, 1) if diff_total > 0 else 0
        except Exception:
            pass

        try:
            with open('/proc/cpuinfo', 'r') as f:
                for line in f:
                    if line.startswith('processor'):
                        result["cores"] += 1
                    if line.startswith('model name'):
                        result["model"] = line.split(':')[1].strip()
        except Exception:
            pass

        try:
            with open('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'r') as f:
                result["freq_mhz"] = round(int(f.read().strip()) / 1000)
        except Exception:
            pass

    elif system == "Darwin":  # macOS
        try:
            # Get CPU model
            result["model"] = subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip()
            result["cores"] = int(subprocess.check_output(['sysctl', '-n', 'hw.physicalcpu'], text=True).strip())
        except Exception:
            pass

        try:
            # Try to get CPU usage via top command
            top_output = subprocess.check_output(['top', '-l', '1', '-n', '0'], text=True, timeout=2)
            for line in top_output.split('\n'):
                if 'CPU usage:' in line:
                    # Parse "CPU usage: 10.0% user, 5.0% sys, 85.0% idle"
                    parts = line.split(',')
                    if len(parts) >= 3:
                        user = float(parts[0].split('%')[0].split()[-1])
                        sys = float(parts[1].split('%')[0].split()[-1])
                        result["usage_pct"] = round(user + sys, 1)
                    break
        except Exception:
            pass

    elif system == "Windows":
        try:
            import psutil
            result["usage_pct"] = psutil.cpu_percent(interval=0.1)
            result["cores"] = psutil.cpu_count(logical=False)
            freq = psutil.cpu_freq()
            if freq:
                result["freq_mhz"] = round(freq.current)
        except ImportError:
            # Fallback without psutil
            result["cores"] = os.cpu_count()
            result["model"] = platform.processor()
        except Exception:
            pass

    return result


def get_memory_info():
    """Get RAM and swap info - cross-platform."""
    result = {
        "total_gb": 0,
        "used_gb": 0,
        "available_gb": 0,
        "usage_pct": 0,
        "swap_total_gb": 0,
        "swap_used_gb": 0,
        "swap_usage_pct": 0
    }

    system = platform.system()

    if system == "Linux":
        try:
            with open('/proc/meminfo', 'r') as f:
                meminfo = {}
                for line in f:
                    parts = line.split()
                    key = parts[0].rstrip(':')
                    value = int(parts[1]) * 1024
                    meminfo[key] = value

            total = meminfo.get('MemTotal', 0)
            available = meminfo.get('MemAvailable', 0)
            used = total - available
            swap_total = meminfo.get('SwapTotal', 0)
            swap_free = meminfo.get('SwapFree', 0)
            swap_used = swap_total - swap_free

            result["total_gb"] = round(total / 1e9, 2)
            result["used_gb"] = round(used / 1e9, 2)
            result["available_gb"] = round(available / 1e9, 2)
            result["usage_pct"] = round(used / total * 100, 1) if total > 0 else 0
            result["swap_total_gb"] = round(swap_total / 1e9, 2)
            result["swap_used_gb"] = round(swap_used / 1e9, 2)
            result["swap_usage_pct"] = round(swap_used / swap_total * 100, 1) if swap_total > 0 else 0
        except Exception:
            pass

    elif system == "Darwin":  # macOS
        try:
            # Get total memory
            mem_bytes = int(subprocess.check_output(['sysctl', '-n', 'hw.memsize'], text=True).strip())
            result["total_gb"] = round(mem_bytes / 1e9, 2)

            # Use vm_stat for memory usage
            vm_output = subprocess.check_output(['vm_stat'], text=True)
            page_size = 4096  # Default page size on macOS

            for line in vm_output.split('\n'):
                if 'page size' in line.lower():
                    page_size = int(line.split()[-1].rstrip('.'))
                elif 'Pages free:' in line:
                    free_pages = int(line.split(':')[1].strip().rstrip('.'))
                    result["available_gb"] = round(free_pages * page_size / 1e9, 2)
                elif 'Pages active:' in line or 'Pages inactive:' in line or 'Pages wired down:' in line:
                    # Add up used memory
                    pass

            # Calculate usage based on total - available approximation
            if result["total_gb"] > 0:
                result["used_gb"] = round(result["total_gb"] - result["available_gb"], 2)
                result["usage_pct"] = round(result["used_gb"] / result["total_gb"] * 100, 1)

            # Swap info via sysctl
            try:
                swap_usage = subprocess.check_output(['sysctl', '-n', 'vm.swapusage'], text=True).strip()
                # Parse: "total = 0.00M  used = 0.00M  free = 0.00M (encrypted)"
                if 'used =' in swap_usage:
                    used_str = swap_usage.split('used =')[1].split()[0]
                    result["swap_used_gb"] = round(float(used_str.rstrip('M')) / 1024, 2)
            except Exception:
                pass

        except Exception:
            pass

    elif system == "Windows":
        try:
            import psutil
            vm = psutil.virtual_memory()
            result["total_gb"] = round(vm.total / (1024**3), 2)
            result["available_gb"] = round(vm.available / (1024**3), 2)
            result["used_gb"] = round(vm.used / (1024**3), 2)
            result["usage_pct"] = vm.percent

            swap = psutil.swap_memory()
            result["swap_total_gb"] = round(swap.total / (1024**3), 2)
            result["swap_used_gb"] = round(swap.used / (1024**3), 2)
            result["swap_usage_pct"] = swap.percent
        except ImportError:
            pass
        except Exception:
            pass

    return result


def get_nvidia_gpu_info():
    """Get NVIDIA GPU utilization via nvidia-smi."""
    result = {
        "available": False,
        "gpus": []
    }

    try:
        proc = subprocess.run(
            ['nvidia-smi', '--query-gpu=name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,power.draw',
             '--format=csv,noheader,nounits'],
            capture_output=True, text=True, timeout=5
        )
        if proc.returncode == 0:
            result["available"] = True
            for line in proc.stdout.strip().split('\n'):
                if not line.strip():
                    continue
                parts = [p.strip() for p in line.split(',')]
                if len(parts) >= 7:
                    result["gpus"].append({
                        "name": parts[0],
                        "gpu_util_pct": float(parts[1]),
                        "mem_util_pct": float(parts[2]),
                        "vram_used_mb": float(parts[3]),
                        "vram_total_mb": float(parts[4]),
                        "temp_c": float(parts[5]),
                        "power_w": float(parts[6])
                    })
    except FileNotFoundError:
        pass
    except Exception:
        pass

    return result


def get_igpu_info():
    """Get iGPU utilization (Intel/AMD) on Linux."""
    result = {
        "available": False,
        "type": "unknown",
        "util_pct": 0,
        "vram_used_mb": 0,
        "vram_total_mb": 0,
        "freq_mhz": 0
    }

    # Intel iGPU via i915 sysfs
    try:
        gt_freq_path = '/sys/class/drm/card0/gt_cur_freq_mhz'
        if os.path.exists(gt_freq_path):
            with open(gt_freq_path, 'r') as f:
                result["freq_mhz"] = int(f.read().strip())
            result["available"] = True
            result["type"] = "intel"

            # Try to get max freq for utilization estimate
            gt_max_path = '/sys/class/drm/card0/gt_max_freq_mhz'
            if os.path.exists(gt_max_path):
                with open(gt_max_path, 'r') as f:
                    max_freq = int(f.read().strip())
                if max_freq > 0:
                    result["util_pct"] = round(result["freq_mhz"] / max_freq * 100, 1)

            # i915 VRAM info
            for card_dir in Path('/sys/class/drm').glob('card*'):
                vram_path = card_dir / 'device' / 'mem_info_vram_used'
                vram_total_path = card_dir / 'device' / 'mem_info_vram_total'
                if vram_path.exists():
                    with open(vram_path, 'r') as f:
                        result["vram_used_mb"] = round(int(f.read().strip()) / 1024 / 1024)
                    with open(vram_total_path, 'r') as f:
                        result["vram_total_mb"] = round(int(f.read().strip()) / 1024 / 1024)
                    break
    except Exception:
        pass

    # AMD iGPU via amdgpu sysfs
    if not result["available"]:
        try:
            for card_dir in sorted(Path('/sys/class/drm').glob('card*')):
                gpu_busy = card_dir / 'device' / 'gpu_busy_percent'
                vram_used = card_dir / 'device' / 'mem_info_vram_used'
                vram_total = card_dir / 'device' / 'mem_info_vram_total'
                gt_freq = card_dir / 'device' / 'pp_dpm_sclk'

                if gpu_busy.exists():
                    with open(gpu_busy, 'r') as f:
                        result["util_pct"] = int(f.read().strip().replace('%', ''))
                    result["available"] = True
                    result["type"] = "amd"

                if vram_used.exists():
                    with open(vram_used, 'r') as f:
                        result["vram_used_mb"] = round(int(f.read().strip()) / 1024 / 1024)
                    with open(vram_total, 'r') as f:
                        result["vram_total_mb"] = round(int(f.read().strip()) / 1024 / 1024)
                    break
        except Exception:
            pass

    # macOS GPU via powermetrics
    if not result["available"] and sys.platform == 'darwin':
        try:
            proc = subprocess.run(
                ['powermetrics', '--samplers', 'gpu_power', '-i', '1000', '-n', '1'],
                capture_output=True, text=True, timeout=5
            )
            if proc.returncode == 0:
                result["available"] = True
                result["type"] = "apple"
                output = proc.stdout
                # Parse GPU active ratio
                for line in output.split('\n'):
                    if 'GPU active' in line:
                        pct = line.split('=')[1].strip().replace('%', '')
                        result["util_pct"] = float(pct)
                        break
        except Exception:
            pass

    return result


def get_process_info():
    """Get info about running model processes."""
    procs = []

    try:
        # Find llama-server and mlx_backend processes
        proc = subprocess.run(
            ['ps', 'aux'],
            capture_output=True, text=True, timeout=3
        )
        if proc.returncode == 0:
            for line in proc.stdout.split('\n'):
                if 'llama-server' in line or 'mlx_backend' in line:
                    parts = line.split()
                    if len(parts) >= 11:
                        procs.append({
                            "user": parts[0],
                            "pid": int(parts[1]),
                            "cpu_pct": float(parts[2]),
                            "mem_pct": float(parts[3]),
                            "rss_mb": round(int(parts[5]) / 1024, 1),
                            "command": ' '.join(parts[10:])
                        })
    except Exception:
        pass

    return procs


def get_full_snapshot():
    """Get a complete resource utilization snapshot."""
    return {
        "timestamp": time.time(),
        "cpu": get_cpu_info(),
        "memory": get_memory_info(),
        "nvidia_gpu": get_nvidia_gpu_info(),
        "igpu": get_igpu_info(),
        "model_processes": get_process_info()
    }


def watch_loop(interval=2, output_json=False):
    """Continuous monitoring loop."""
    try:
        while True:
            snapshot = get_full_snapshot()
            if output_json:
                print(json.dumps(snapshot))
            else:
                cpu = snapshot['cpu']
                mem = snapshot['memory']
                igpu = snapshot['igpu']
                nvidia = snapshot['nvidia_gpu']

                print(f"\033[H\033[2J", end="")  # Clear screen
                print("📊 Lumina Edge Resource Monitor")
                print("=" * 45)
                print(f"  CPU:  {cpu['usage_pct']}% | {cpu['freq_mhz']} MHz | {cpu['cores']} cores")
                print(f"  RAM:  {mem['used_gb']}/{mem['total_gb']} GB ({mem['usage_pct']}%)")
                if mem['swap_total_gb'] > 0:
                    print(f"  Swap: {mem['swap_used_gb']}/{mem['swap_total_gb']} GB ({mem['swap_usage_pct']}%)")
                else:
                    print(f"  Swap: none")

                if igpu['available']:
                    print(f"  iGPU: {igpu['type']} | {igpu['util_pct']}% | {igpu['freq_mhz']} MHz | VRAM {igpu['vram_used_mb']}/{igpu['vram_total_mb']} MB")

                if nvidia['available']:
                    for gpu in nvidia['gpus']:
                        print(f"  GPU:  {gpu['name']} | {gpu['gpu_util_pct']}% | VRAM {gpu['vram_used_mb']}/{gpu['vram_total_mb']} MB | {gpu['temp_c']}°C | {gpu['power_w']}W")

                for proc in snapshot['model_processes']:
                    print(f"  PID {proc['pid']}: CPU {proc['cpu_pct']}% | MEM {proc['mem_pct']}% ({proc['rss_mb']} MB) | {proc['command'][:40]}")

                print(f"\n  [Refresh: {interval}s | Ctrl+C to stop]")

            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Resource Monitor')
    parser.add_argument('command', choices=['snapshot', 'watch'], help='Single snapshot or continuous watch')
    parser.add_argument('--interval', type=int, default=2, help='Watch interval in seconds')
    parser.add_argument('--json', action='store_true', help='Output as JSON')

    args = parser.parse_args()

    if args.command == 'snapshot':
        snapshot = get_full_snapshot()
        print(json.dumps(snapshot, indent=2))
    elif args.command == 'watch':
        watch_loop(args.interval, args.json)
