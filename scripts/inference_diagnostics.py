#!/usr/bin/env python3
"""
Inference Diagnostics & Profiler
Diagnoses slow inference by measuring latency, throughput, and identifying bottlenecks.
"""

import os
import sys
import json
import time
import argparse
import platform
import subprocess
import urllib.request
import urllib.error
from pathlib import Path


def check_server_health(port=8000):
    """Check if a model server is responding."""
    try:
        req = urllib.request.Request(f"http://127.0.0.1:{port}/health", method='GET')
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


def profile_inference(port=8000, prompt="Hello, how are you?", max_tokens=64,
                      temperature=0.7, num_runs=3):
    """
    Run inference profiling: measure time-to-first-token, tokens/sec, total latency.
    """
    results = []
    
    for run in range(num_runs):
        payload = {
            "model": "local",
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False
        }
        
        data = json.dumps(payload).encode('utf-8')
        req = urllib.request.Request(
            f"http://127.0.0.1:{port}/v1/chat/completions",
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST'
        )
        
        start = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                result = json.loads(response.read().decode('utf-8'))
                end = time.perf_counter()
        except urllib.error.HTTPError as e:
            return {"error": f"HTTP {e.code}: {e.read().decode()}"}
        except Exception as e:
            return {"error": str(e)}
        
        total_time = end - start
        
        # Extract token info
        usage = result.get('usage', {})
        prompt_tokens = usage.get('prompt_tokens', 0)
        completion_tokens = usage.get('completion_tokens', 0)
        
        # Calculate metrics
        tokens_per_sec = completion_tokens / total_time if total_time > 0 else 0
        time_per_token = total_time / completion_tokens if completion_tokens > 0 else 0
        
        run_result = {
            "run": run + 1,
            "total_time_s": round(total_time, 3),
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "tokens_per_sec": round(tokens_per_sec, 2),
            "ms_per_token": round(time_per_token * 1000, 2),
        }
        results.append(run_result)
        print(f"  Run {run + 1}: {completion_tokens} tokens in {total_time:.3f}s = {tokens_per_sec:.1f} tok/s")
    
    # Aggregate
    avg_tps = sum(r['tokens_per_sec'] for r in results) / len(results)
    avg_latency = sum(r['total_time_s'] for r in results) / len(results)
    avg_mspt = sum(r['ms_per_token'] for r in results) / len(results)
    
    summary = {
        "port": port,
        "prompt": prompt[:80],
        "max_tokens": max_tokens,
        "num_runs": num_runs,
        "avg_tokens_per_sec": round(avg_tps, 2),
        "avg_total_latency_s": round(avg_latency, 3),
        "avg_ms_per_token": round(avg_mspt, 2),
        "runs": results
    }
    
    return summary


def _diagnose_linux():
    """Linux-specific system diagnostics."""
    findings = []

    # CPU info from /proc/cpuinfo
    try:
        with open('/proc/cpuinfo', 'r') as f:
            cpuinfo = f.read()
        model_name = None
        cores = 0
        for line in cpuinfo.split('\n'):
            if line.startswith('model name'):
                model_name = line.split(':')[1].strip()
            if line.startswith('processor'):
                cores += 1
        findings.append({"check": "cpu", "model": model_name, "cores": cores})
    except Exception as e:
        findings.append({"check": "cpu", "note": f"Could not read CPU info: {e}"})

    # Memory from /proc/meminfo
    try:
        with open('/proc/meminfo', 'r') as f:
            meminfo = f.read()
        mem_total = 0
        mem_available = 0
        swap_total = 0
        for line in meminfo.split('\n'):
            if line.startswith('MemTotal:'):
                mem_total = int(line.split()[1]) * 1024
            elif line.startswith('MemAvailable:'):
                mem_available = int(line.split()[1]) * 1024
            elif line.startswith('SwapTotal:'):
                swap_total = int(line.split()[1]) * 1024
        findings.append({
            "check": "memory",
            "total_gb": round(mem_total / 1e9, 2),
            "available_gb": round(mem_available / 1e9, 2),
            "swap_gb": round(swap_total / 1e9, 2),
            "usage_pct": round((1 - mem_available / mem_total) * 100, 1) if mem_total > 0 else 0
        })
    except Exception as e:
        findings.append({"check": "memory", "note": f"Could not read memory info: {e}"})

    # Swappiness
    try:
        with open('/proc/sys/vm/swappiness', 'r') as f:
            swappiness = int(f.read().strip())
        if swappiness > 10:
            findings.append({"check": "swappiness", "value": swappiness, "warning": "High swappiness can cause slow inference. Recommend <= 10."})
        else:
            findings.append({"check": "swappiness", "value": swappiness, "ok": True})
    except Exception:
        pass

    # Transparent huge pages
    try:
        with open('/sys/kernel/mm/transparent_hugepage/enabled', 'r') as f:
            thp = f.read().strip()
        findings.append({"check": "transparent_hugepages", "value": thp})
    except Exception:
        pass

    # Power profile
    try:
        result = subprocess.run(['powerprofilesctl', 'get'], capture_output=True, text=True, timeout=3)
        profile = result.stdout.strip()
        if profile != 'performance':
            findings.append({"check": "power_profile", "value": profile, "warning": "Not on 'performance' profile. This can throttle CPU/GPU."})
        else:
            findings.append({"check": "power_profile", "value": profile, "ok": True})
    except Exception:
        pass

    return findings


def _diagnose_macos():
    """macOS-specific system diagnostics using sysctl."""
    findings = []

    # CPU info
    try:
        model_name = subprocess.check_output(['sysctl', '-n', 'machdep.cpu.brand_string'], text=True).strip()
        cores = int(subprocess.check_output(['sysctl', '-n', 'hw.physicalcpu'], text=True).strip())
        findings.append({"check": "cpu", "model": model_name, "cores": cores})
    except Exception as e:
        findings.append({"check": "cpu", "note": f"Could not read CPU info: {e}"})

    # Memory
    try:
        mem_bytes = int(subprocess.check_output(['sysctl', '-n', 'hw.memsize'], text=True).strip())
        mem_total_gb = mem_bytes / (1024**3)
        # Use psutil for available memory if available
        try:
            import psutil
            vm = psutil.virtual_memory()
            mem_available_gb = vm.available / (1024**3)
            usage_pct = vm.percent
        except ImportError:
            mem_available_gb = mem_total_gb * 0.5  # Rough estimate
            usage_pct = 50
        findings.append({
            "check": "memory",
            "total_gb": round(mem_total_gb, 2),
            "available_gb": round(mem_available_gb, 2),
            "usage_pct": usage_pct
        })
    except Exception as e:
        findings.append({"check": "memory", "note": f"Could not read memory info: {e}"})

    # Check for Apple Silicon
    try:
        arch = platform.machine().lower()
        if 'arm' in arch:
            findings.append({"check": "platform", "type": "apple_silicon", "note": "MLX backend available"})
        else:
            findings.append({"check": "platform", "type": "intel_mac", "note": "Using CPU backend"})
    except Exception:
        pass

    return findings


def _diagnose_windows():
    """Windows-specific system diagnostics using WMI/psutil."""
    findings = []

    # Try WMI first, fallback to psutil
    try:
        import wmi
        c = wmi.WMI()
        processor = c.Win32_Processor()[0]
        findings.append({"check": "cpu", "model": processor.Name, "cores": processor.NumberOfCores})
    except Exception:
        # Fallback to environment variable or basic info
        try:
            import psutil
            cores = psutil.cpu_count(logical=False)
            findings.append({"check": "cpu", "model": platform.processor(), "cores": cores})
        except ImportError:
            findings.append({"check": "cpu", "model": platform.processor(), "cores": os.cpu_count()})

    # Memory
    try:
        import psutil
        vm = psutil.virtual_memory()
        findings.append({
            "check": "memory",
            "total_gb": round(vm.total / (1024**3), 2),
            "available_gb": round(vm.available / (1024**3), 2),
            "usage_pct": vm.percent
        })
    except ImportError:
        findings.append({"check": "memory", "note": "Install psutil for memory info: pip install psutil"})

    # Power plan check (simplified)
    try:
        result = subprocess.run(['powercfg', '/getactivescheme'], capture_output=True, text=True, timeout=3)
        if 'high performance' in result.stdout.lower() or 'ultimate performance' in result.stdout.lower():
            findings.append({"check": "power_profile", "value": "high_performance", "ok": True})
        else:
            findings.append({"check": "power_profile", "value": "balanced", "warning": "Not on High Performance power plan. This can throttle CPU."})
    except Exception:
        pass

    return findings


def diagnose_system():
    """Check system-level factors that affect inference speed."""
    findings = []

    # Platform-specific diagnostics
    system = platform.system()
    if system == "Linux":
        findings.extend(_diagnose_linux())
    elif system == "Darwin":
        findings.extend(_diagnose_macos())
    elif system == "Windows":
        findings.extend(_diagnose_windows())
    else:
        findings.append({"check": "platform", "note": f"Unsupported platform: {system}"})

    # Cross-platform GPU checks
    for cmd_name, cmd in [('nvidia', 'nvidia-smi'), ('vulkan', 'vulkaninfo')]:
        try:
            result = subprocess.run([cmd], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                findings.append({"check": f"{cmd_name}_gpu", "available": True})
            else:
                findings.append({"check": f"{cmd_name}_gpu", "available": False})
        except FileNotFoundError:
            findings.append({"check": f"{cmd_name}_gpu", "available": False})
        except Exception:
            pass

    return findings


def generate_recommendations(diag_results, profile_results):
    """Generate actionable recommendations based on diagnostics."""
    recs = []
    
    # System-level
    for d in diag_results:
        if d.get('check') == 'swappiness' and d.get('warning'):
            recs.append({"priority": "high", "action": "Reduce swappiness", "command": "sudo sysctl -w vm.swappiness=1", "reason": d['warning']})
        if d.get('check') == 'power_profile' and d.get('warning'):
            recs.append({"priority": "high", "action": "Set performance power profile", "command": "powerprofilesctl set performance", "reason": d['warning']})
        if d.get('check') == 'memory' and d.get('usage_pct', 0) > 85:
            recs.append({"priority": "medium", "action": "Free memory before inference", "command": "Run optimize_system.py", "reason": f"Memory usage at {d['usage_pct']}%"})
    
    # Inference-level
    if profile_results and not profile_results.get('error'):
        avg_tps = profile_results.get('avg_tokens_per_sec', 0)
        if avg_tps < 5:
            recs.append({"priority": "high", "action": "Reduce context size", "config_key": "ctx_size", "reason": f"Very low throughput ({avg_tps} tok/s). Try smaller ctx_size (e.g. 2048)."})
            recs.append({"priority": "high", "action": "Use smaller quantization", "reason": "Q4_K_M or Q4_0 quantizations are faster. Consider re-quantizing."})
        if avg_tps < 15:
            recs.append({"priority": "medium", "action": "Enable flash attention", "config_key": "flash_attn", "reason": "Flash attention can speed up long-context inference."})
            recs.append({"priority": "medium", "action": "Increase batch size", "config_key": "batch_size", "reason": "Larger batch sizes (e.g. 512 or 1024) improve prompt processing speed."})
            recs.append({"priority": "medium", "action": "Enable continuous batching", "config_key": "cont_batching", "reason": "Allows parallel request handling."})
    
    return recs


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Inference Diagnostics & Profiler')
    subparsers = parser.add_subparsers(dest='command')
    
    # Profile command
    profile_parser = subparsers.add_parser('profile', help='Profile inference speed')
    profile_parser.add_argument('--port', type=int, default=8000, help='Model server port')
    profile_parser.add_argument('--prompt', default="Write a short poem about the sea.", help='Test prompt')
    profile_parser.add_argument('--max-tokens', type=int, default=64, help='Max tokens to generate')
    profile_parser.add_argument('--runs', type=int, default=3, help='Number of profiling runs')
    
    # Diagnose command
    diag_parser = subparsers.add_parser('diagnose', help='Diagnose system-level issues')
    
    # Full report
    report_parser = subparsers.add_parser('report', help='Full diagnostics + profiling report')
    report_parser.add_argument('--port', type=int, default=8000, help='Model server port')
    report_parser.add_argument('--max-tokens', type=int, default=64, help='Max tokens for profiling')
    report_parser.add_argument('--runs', type=int, default=3, help='Number of profiling runs')
    
    args = parser.parse_args()
    
    if args.command == 'profile':
        if not check_server_health(args.port):
            print(f"Error: No model server responding on port {args.port}")
            sys.exit(1)
        
        print(f"\n🔬 Profiling inference on port {args.port}...")
        print(f"   Prompt: {args.prompt[:60]}...")
        print(f"   Max tokens: {args.max_tokens}, Runs: {args.runs}\n")
        
        result = profile_inference(args.port, args.prompt, args.max_tokens, runs=args.runs)
        print(f"\n📊 Results:")
        print(json.dumps(result, indent=2))
    
    elif args.command == 'diagnose':
        print("\n🔍 Running system diagnostics...\n")
        results = diagnose_system()
        for r in results:
            status = "⚠" if r.get('warning') else "✓" if r.get('ok') else "ℹ"
            print(f"  {status} {r['check']}: {json.dumps({k: v for k, v in r.items() if k != 'check'})}")
        print()
    
    elif args.command == 'report':
        print("\n📋 Full Inference Diagnostics Report\n")
        print("=" * 50)
        
        # System diagnostics
        print("\n🔍 System Diagnostics:")
        diag = diagnose_system()
        for r in diag:
            status = "⚠" if r.get('warning') else "✓" if r.get('ok') else "ℹ"
            print(f"  {status} {r['check']}: {json.dumps({k: v for k, v in r.items() if k != 'check'})}")
        
        # Inference profiling
        if check_server_health(args.port):
            print(f"\n🔬 Inference Profiling (port {args.port}):")
            profile = profile_inference(args.port, max_tokens=args.max_tokens, num_runs=args.runs)
            if not profile.get('error'):
                print(f"  Avg: {profile['avg_tokens_per_sec']} tok/s, {profile['avg_ms_per_token']} ms/token")
            else:
                print(f"  Error: {profile['error']}")
                profile = None
        else:
            print(f"\n⚠ No model server on port {args.port}, skipping profiling")
            profile = None
        
        # Recommendations
        print(f"\n💡 Recommendations:")
        recs = generate_recommendations(diag, profile)
        if recs:
            for i, rec in enumerate(recs, 1):
                print(f"  {i}. [{rec['priority'].upper()}] {rec['action']}")
                if 'command' in rec:
                    print(f"     Command: {rec['command']}")
                if 'config_key' in rec:
                    print(f"     Config key: {rec['config_key']}")
                print(f"     Reason: {rec['reason']}")
        else:
            print("  No issues detected. System looks good!")
        
        print("\n" + "=" * 50)
    
    else:
        parser.print_help()
