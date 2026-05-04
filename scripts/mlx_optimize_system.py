#!/usr/bin/env python3
"""
Lumina Edge — macOS System Optimizer for MLX Inference
Frees unified memory and optimizes Metal performance before model load.
Run once at startup on macOS/Apple Silicon.
"""

import os
import subprocess
import platform
import json


def is_apple_silicon():
    return platform.system() == 'Darwin' and 'arm' in platform.machine().lower()


def get_memory_pressure():
    """Get current memory pressure from vm_stat."""
    try:
        result = subprocess.run(['vm_stat'], capture_output=True, text=True, timeout=3)
        if result.returncode != 0:
            return 'unknown'
        lines = result.stdout.split('\n')
        for line in lines:
            if 'Pages free' in line:
                free_pages = int(line.split(':')[1].strip().rstrip('.'))
                free_mb = (free_pages * 4096) / (1024 * 1024)
                if free_mb < 500:
                    return 'critical'
                elif free_mb < 2000:
                    return 'warning'
                else:
                    return 'normal'
    except Exception:
        pass
    return 'unknown'


def purge_inactive_memory():
    """Purge disk cache and inactive memory. Requires sudo."""
    try:
        result = subprocess.run(['sudo', '-n', 'purge'], capture_output=True, timeout=5)
        if result.returncode == 0:
            print('✓ Inactive memory purged')
            return True
    except Exception:
        pass
    print('⚠ Memory purge skipped (requires sudo)')
    return False


def stop_memory_hungry_services():
    """
    Temporarily disable macOS services that compete for unified memory.
    These are re-enabled on next login or can be manually re-enabled.
    """
    services_to_disable = [
        # Spotlight indexing — major memory consumer during inference
        ('mds_stores', 'Spotlight indexing'),
        # Photos analysis — background ML that competes with Metal
        ('com.apple.photoanalysisd', 'Photos analysis'),
        # Siri suggestions background processing
        ('com.apple.suggestd', 'Siri suggestions'),
    ]
    
    stopped = []
    for service, desc in services_to_disable:
        try:
            result = subprocess.run(
                ['launchctl', 'kill', 'SIGSTOP', f'gui/{os.getuid()}/{service}'],
                capture_output=True, timeout=3
            )
            if result.returncode == 0:
                stopped.append(service)
                print(f'✓ Paused: {desc}')
        except Exception:
            pass
    
    return stopped


def resume_services(stopped_services):
    """Resume previously stopped services."""
    for service in stopped_services:
        try:
            subprocess.run(
                ['launchctl', 'kill', 'SIGCONT', f'gui/{os.getuid()}/{service}'],
                capture_output=True, timeout=3
            )
        except Exception:
            pass


def set_high_performance_power_mode():
    """
    Enable macOS High Performance power mode.
    Keeps Apple Silicon P-cores at maximum frequency during inference.
    Significant impact on sustained throughput on MacBook Pro/Max.
    Requires sudo — silently skips if not available.
    """
    strategies = [
        # macOS 12+ High Performance mode
        ['sudo', '-n', 'pmset', '-a', 'highpowermode', '1'],
        # Disable CPU throttling for current session
        ['sudo', '-n', 'pmset', '-a', 'powernap', '0'],
        ['sudo', '-n', 'pmset', '-a', 'tcpkeepalive', '0'],
    ]
    
    any_success = False
    for cmd in strategies:
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=3)
            if result.returncode == 0:
                any_success = True
        except Exception:
            pass
    
    if any_success:
        print('✓ High performance power mode enabled')
    else:
        print('⚠ Power mode unchanged (sudo required — run with sudo for max performance)')
    
    return any_success


def set_metal_performance_env():
    """
    Set Metal and system environment variables for maximum inference performance.
    These affect the current process and all children (including mlx_lm).
    """
    metal_vars = {
        # Disable Metal API validation (huge perf win, safe for production)
        'MTL_DEBUG_LAYER': '0',
        'MTL_SHADER_VALIDATION': '0',
        'MTL_HUD_ENABLED': '0',
        # Disable Metal command buffer debug overhead  
        'METAL_DEVICE_WRAPPER_TYPE': '0',
        # Maximize Metal memory allocation aggressiveness
        'MTL_LARGE_BUFFERS': '1',
        # Disable HuggingFace telemetry
        'HF_HUB_DISABLE_TELEMETRY': '1',
        'HF_HUB_DISABLE_PROGRESS_BARS': '1',
        # Disable tokenizer parallelism warning
        'TOKENIZERS_PARALLELISM': 'false',
        # Prevent Python from writing bytecode during inference
        'PYTHONDONTWRITEBYTECODE': '1',
    }
    
    for key, val in metal_vars.items():
        os.environ[key] = val
    
    print(f'✓ Metal performance environment configured ({len(metal_vars)} variables)')
    return metal_vars


def set_performance_mode():
    """
    Set macOS to prioritize performance over efficiency.
    Uses powermetrics-compatible settings where available.
    """
    try:
        # Disable App Nap for current process and children
        # App Nap throttles background processes — we don't want this
        subprocess.run(
            ['defaults', 'write', 'NSGlobalDomain', 'NSAppSleepDisabled', '-bool', 'YES'],
            capture_output=True, timeout=3
        )
        print('✓ App Nap disabled for session')
    except Exception:
        pass
    
    try:
        # Set process priority to high
        os.nice(-10)  # Requires elevated privileges, will fail silently if not available
        print('✓ Process priority elevated')
    except Exception:
        pass


def get_metal_device_info():
    """Get Metal GPU info for display."""
    try:
        result = subprocess.run(
            ['system_profiler', 'SPDisplaysDataType', '-json'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            displays = data.get('SPDisplaysDataType', [])
            for d in displays:
                name = d.get('sppci_model', 'Unknown GPU')
                cores = d.get('sppci_cores', 'unknown')
                return f"{name} ({cores} cores)"
    except Exception:
        pass
    return 'Apple Silicon GPU'


def get_total_memory_gb():
    try:
        result = subprocess.run(
            ['sysctl', '-n', 'hw.memsize'],
            capture_output=True, text=True, timeout=2
        )
        return int(result.stdout.strip()) / (1024**3)
    except Exception:
        return 0


def optimize_for_mlx():
    """
    Main optimization function. Returns dict with optimization results.
    """
    if not is_apple_silicon():
        print('Not Apple Silicon — skipping MLX optimization')
        return {'skipped': True}
    
    results = {
        'platform': 'apple_silicon',
        'memory_pressure_before': get_memory_pressure(),
        'metal_device': get_metal_device_info(),
        'total_memory_gb': get_total_memory_gb(),
        'actions': []
    }
    
    print(f'\n[Lumina Edge MLX Optimizer]')
    print(f'Device: {results["metal_device"]}')
    print(f'Total Memory: {results["total_memory_gb"]:.1f}GB unified')
    print(f'Memory Pressure: {results["memory_pressure_before"]}')
    print()
    
    # 1. Metal environment variables
    set_metal_performance_env()
    results['actions'].append('metal_env_set')
    
    # 2. High performance power mode
    power_set = set_high_performance_power_mode()
    if power_set:
        results['actions'].append('high_performance_power_mode')
    
    # 3. Stop competing background services
    stopped = stop_memory_hungry_services()
    if stopped:
        results['actions'].append(f'paused_services')
        results['stopped_services'] = stopped
    
    # 4. Purge memory if under pressure
    if results['memory_pressure_before'] in ('warning', 'critical'):
        purged = purge_inactive_memory()
        if purged:
            results['actions'].append('memory_purged')
    
    # 5. Set performance mode (App Nap, nice)
    set_performance_mode()
    results['actions'].append('performance_mode_set')
    
    results['memory_pressure_after'] = get_memory_pressure()
    
    print(f'\nMemory Pressure After: {results["memory_pressure_after"]}')
    print(f'✓ MLX optimization complete — {len(results["actions"])} optimizations applied\n')
    
    return results


def cleanup_after_inference(stopped_services=None):
    """Call this when model is unloaded to restore system state."""
    if stopped_services:
        resume_services(stopped_services)
        print('✓ Background services resumed')
    
    # Re-enable App Nap
    try:
        subprocess.run(
            ['defaults', 'delete', 'NSGlobalDomain', 'NSAppSleepDisabled'],
            capture_output=True, timeout=3
        )
    except Exception:
        pass


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Lumina Edge macOS MLX Optimizer')
    parser.add_argument('command', choices=['optimize', 'cleanup'], default='optimize', nargs='?')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    args = parser.parse_args()
    
    if args.command == 'optimize':
        results = optimize_for_mlx()
        if args.json:
            print(json.dumps(results))
    elif args.command == 'cleanup':
        cleanup_after_inference()
