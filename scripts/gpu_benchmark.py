#!/usr/bin/env python3
"""
CPU vs iGPU/GPU Benchmark Module
Loads the same model with different GPU layer counts and compares inference speed.
Helps determine the optimal GPU offload strategy for the current hardware.
"""

import os
import sys
import json
import time
import argparse
import subprocess
import tempfile
import signal
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional, Dict, List


def find_llama_server(bin_dir: str) -> Optional[str]:
    """Find llama-server binary in the given directory."""
    if sys.platform == 'win32':
        path = os.path.join(bin_dir, 'llama-server.exe')
    else:
        path = os.path.join(bin_dir, 'llama-server')
    return path if os.path.exists(path) else None


def start_server(bin_dir: str, model_path: str, port: int, gpu_layers: int,
                 ctx_size: int = 2048, threads: int = 4) -> Optional[subprocess.Popen]:
    """Start llama-server on a given port with specified GPU layer count."""
    server_path = find_llama_server(bin_dir)
    if not server_path:
        return None

    cmd = [
        server_path,
        '-m', model_path,
        '--host', '127.0.0.1',
        '--port', str(port),
        '--ctx-size', str(ctx_size),
        '--n-gpu-layers', str(gpu_layers),
        '--threads', str(threads),
        '--flash-attn',
        '--mlock',
        '--cache-type-k', 'q4_0',
        '--cache-type-v', 'q4_0'
    ]

    log_file = os.path.join(tempfile.gettempdir(), f"lumina_bench_{port}.log")
    try:
        lf = open(log_file, 'w')
        proc = subprocess.Popen(cmd, stdout=lf, stderr=subprocess.STDOUT, text=True)
        return (proc, lf)
    except Exception as e:
        print(f"Error starting server: {e}")
        return None


def wait_for_server(port: int, timeout: int = 60) -> bool:
    """Poll /health endpoint until server responds or timeout reached."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/health", method='GET')
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except urllib.error.URLError:
            pass
        time.sleep(1)
    return False


def run_inference(port: int, prompt: str = "Write a short poem about the sea.",
                  max_tokens: int = 64, temperature: float = 0.7) -> Dict:
    """Send one chat completion request and return timing data."""
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
            elapsed = time.perf_counter() - start
    except Exception as e:
        return {"error": str(e), "elapsed_s": 0}

    usage = result.get('usage', {})
    completion_tokens = usage.get('completion_tokens', 0)
    prompt_tokens = usage.get('prompt_tokens', 0)

    return {
        "elapsed_s": round(elapsed, 3),
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "tokens_per_sec": round(completion_tokens / elapsed, 2) if elapsed > 0 else 0,
        "ms_per_token": round(elapsed / completion_tokens * 1000, 2) if completion_tokens > 0 else 0,
        "error": None
    }


def stop_server(proc: subprocess.Popen):
    """Kill a subprocess with escalation: terminate, wait, then kill."""
    try:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)
    except Exception:
        pass


def benchmark_gpu_layers(bin_dir: str, model_path: str, base_port: int = 8100,
                         gpu_configs: List[int] = None, ctx_size: int = 2048,
                         threads: int = 4, max_tokens: int = 64,
                         warmup_runs: int = 1, bench_runs: int = 3,
                         prompt: str = "Write a short poem about the sea.") -> Dict:
    """
    Benchmark model with different GPU layer counts.
    Starts a new server for each config, runs warmup + benchmark queries.
    """
    if gpu_configs is None:
        gpu_configs = [0, 10, 20, 30, 50, 99]

    results = []
    model_name = Path(model_path).stem

    print(f"\n🏁 GPU Benchmark: {model_name}")
    print(f"   GPU layer configs: {gpu_configs}")
    print(f"   Context: {ctx_size}, Threads: {threads}, Max tokens: {max_tokens}")
    print(f"   Warmup runs: {warmup_runs}, Benchmark runs: {bench_runs}\n")

    for i, gpu_layers in enumerate(gpu_configs):
        port = base_port + i
        mode_label = "CPU-only" if gpu_layers == 0 else f"GPU-{gpu_layers}" if gpu_layers < 99 else "GPU-all"

        print(f"  ⏳ Testing {mode_label} (n_gpu_layers={gpu_layers}) on port {port}...")

        proc_and_lf = start_server(bin_dir, model_path, port, gpu_layers, ctx_size, threads)
        if not proc_and_lf:
            lf = None
            proc = None
        else:
            proc, lf = proc_and_lf
        if not proc:
            print(f"  ✗ Failed to start server for {mode_label}")
            results.append({"gpu_layers": gpu_layers, "label": mode_label, "error": "Failed to start server"})
            continue

        if not wait_for_server(port, timeout=60):
            print(f"  ✗ Server not ready for {mode_label}")
            stop_server(proc)
            if lf is not None:
                lf.close()
            results.append({"gpu_layers": gpu_layers, "label": mode_label, "error": "Server startup timeout"})
            continue

        # Warmup: short 16-token run to prime GPU/caches
        for _ in range(warmup_runs):
            run_inference(port, prompt, max_tokens=16)

        # Benchmark runs
        run_results = []
        for run in range(bench_runs):
            result = run_inference(port, prompt, max_tokens)
            if result.get('error'):
                print(f"    Run {run+1} error: {result['error']}")
            else:
                print(f"    Run {run+1}: {result['tokens_per_sec']} tok/s ({result['elapsed_s']}s)")
            run_results.append(result)

        stop_server(proc)
        if lf is not None:
            lf.close()

        valid = [r for r in run_results if not r.get('error')]
        if valid:
            avg_tps = sum(r['tokens_per_sec'] for r in valid) / len(valid)
            avg_latency = sum(r['elapsed_s'] for r in valid) / len(valid)
            avg_mspt = sum(r['ms_per_token'] for r in valid) / len(valid)
            entry = {
                "gpu_layers": gpu_layers,
                "label": mode_label,
                "avg_tokens_per_sec": round(avg_tps, 2),
                "avg_latency_s": round(avg_latency, 3),
                "avg_ms_per_token": round(avg_mspt, 2),
                "runs": valid
            }
        else:
            entry = {"gpu_layers": gpu_layers, "label": mode_label, "error": "All runs failed"}

        results.append(entry)
        print(f"  ✓ {mode_label}: {entry.get('avg_tokens_per_sec', 'N/A')} tok/s\n")

    # Generate summary with best config and speedup vs CPU
    valid_results = [r for r in results if 'avg_tokens_per_sec' in r]
    if valid_results:
        best = max(valid_results, key=lambda r: r['avg_tokens_per_sec'])
        cpu_result = next((r for r in results if r['gpu_layers'] == 0 and 'avg_tokens_per_sec' in r), None)

        summary = {
            "model": model_name,
            "best_config": best,
            "speedup_vs_cpu": round(best['avg_tokens_per_sec'] / cpu_result['avg_tokens_per_sec'], 2) if cpu_result else None,
            "recommended_gpu_layers": best['gpu_layers'],
            "results": results
        }
    else:
        summary = {"model": model_name, "results": results, "error": "No valid benchmark results"}

    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='CPU vs iGPU/GPU Benchmark')
    subparsers = parser.add_subparsers(dest='command')

    bench_parser = subparsers.add_parser('run', help='Run GPU benchmark')
    bench_parser.add_argument('--bin-dir', required=True, help='Path to bin directory with llama-server')
    bench_parser.add_argument('--model', required=True, help='Path to model file')
    bench_parser.add_argument('--gpu-layers', nargs='+', type=int, default=[0, 10, 20, 30, 50, 99],
                              help='GPU layer counts to test')
    bench_parser.add_argument('--base-port', type=int, default=8100, help='Base port for servers')
    bench_parser.add_argument('--ctx-size', type=int, default=2048, help='Context size')
    bench_parser.add_argument('--threads', type=int, default=4, help='CPU threads')
    bench_parser.add_argument('--max-tokens', type=int, default=64, help='Max tokens per run')
    bench_parser.add_argument('--warmup', type=int, default=1, help='Warmup runs')
    bench_parser.add_argument('--runs', type=int, default=3, help='Benchmark runs per config')

    quick_parser = subparsers.add_parser('quick', help='Quick CPU vs GPU comparison')
    quick_parser.add_argument('--bin-dir', required=True, help='Path to bin directory')
    quick_parser.add_argument('--model', required=True, help='Path to model file')
    quick_parser.add_argument('--ctx-size', type=int, default=2048)
    quick_parser.add_argument('--threads', type=int, default=4)

    args = parser.parse_args()

    if args.command == 'run':
        result = benchmark_gpu_layers(
            args.bin_dir, args.model, args.base_port,
            args.gpu_layers, args.ctx_size, args.threads,
            args.max_tokens, args.warmup, args.runs
        )
        print(json.dumps(result, indent=2))

    elif args.command == 'quick':
        result = benchmark_gpu_layers(
            args.bin_dir, args.model, base_port=8100,
            gpu_configs=[0, 99], ctx_size=args.ctx_size,
            threads=args.threads, max_tokens=64,
            warmup_runs=1, bench_runs=2
        )
        print(json.dumps(result, indent=2))

    else:
        parser.print_help()
