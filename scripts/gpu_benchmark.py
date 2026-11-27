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
import csv
import html
import math
import statistics
import threading
from datetime import datetime, timezone
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
        "elapsed_s": elapsed,
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "tokens_per_sec": completion_tokens / elapsed if elapsed > 0 else 0,
        "ms_per_token": elapsed / completion_tokens * 1000 if completion_tokens > 0 else 0,
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


def _percentile(values: List[float], percentile: float) -> Optional[float]:
    """Calculate a linearly interpolated percentile without third-party packages."""
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def _confidence_interval_95(values: List[float]) -> Dict:
    """Return a two-sided 95% t interval for a sample mean."""
    if not values:
        return {"low": None, "high": None}
    mean = statistics.mean(values)
    if len(values) < 2:
        return {"low": round(mean, 3), "high": round(mean, 3)}
    critical_values = [
        0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
        2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
        2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045,
        2.042,
    ]
    degrees_of_freedom = len(values) - 1
    critical = critical_values[degrees_of_freedom] if degrees_of_freedom < len(critical_values) else 1.96
    margin = critical * statistics.stdev(values) / math.sqrt(len(values))
    return {"low": round(mean - margin, 3), "high": round(mean + margin, 3)}


def _process_memory_bytes(pid: int) -> Dict[str, Optional[int]]:
    """Read child RSS/virtual memory using psutil or Linux /proc when available."""
    try:
        import psutil
        memory = psutil.Process(pid).memory_info()
        return {"rss_bytes": int(memory.rss), "vms_bytes": int(memory.vms)}
    except Exception:
        pass
    status_path = Path(f"/proc/{pid}/status")
    try:
        values = {}
        for line in status_path.read_text().splitlines():
            if line.startswith(("VmRSS:", "VmSize:")):
                key, amount, unit = line.split()[:3]
                values[key] = int(amount) * (1024 if unit.lower() == "kb" else 1)
        return {"rss_bytes": values.get("VmRSS:"), "vms_bytes": values.get("VmSize:")}
    except Exception:
        return {"rss_bytes": None, "vms_bytes": None}


def _summarize_runs(valid: List[Dict]) -> Dict:
    latencies = [float(run["elapsed_s"]) for run in valid]
    throughputs = [float(run["tokens_per_sec"]) for run in valid]
    return {
        "avg_tokens_per_sec": round(statistics.mean(throughputs), 2),
        "median_tokens_per_sec": round(statistics.median(throughputs), 2),
        "throughput_ci95": _confidence_interval_95(throughputs),
        "avg_latency_s": round(statistics.mean(latencies), 3),
        "median_latency_s": round(statistics.median(latencies), 3),
        "latency_p50_s": round(_percentile(latencies, 0.50), 3),
        "latency_p95_s": round(_percentile(latencies, 0.95), 3),
        "latency_p99_s": round(_percentile(latencies, 0.99), 3),
        "avg_ms_per_token": round(statistics.mean(
            float(run["ms_per_token"]) for run in valid
        ), 2),
    }


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

        memory_stop = threading.Event()
        memory_samples = []

        def sample_memory():
            while not memory_stop.is_set():
                sample = _process_memory_bytes(proc.pid)
                if sample.get("rss_bytes") is not None:
                    memory_samples.append(sample)
                memory_stop.wait(0.1)

        memory_thread = threading.Thread(target=sample_memory, daemon=True)
        memory_thread.start()

        # Warmup: short run to prime device kernels and runtime caches.
        for _ in range(warmup_runs):
            run_inference(port, prompt, max_tokens=16)

        # Benchmark runs
        run_results = []
        for run in range(bench_runs):
            result = run_inference(port, prompt, max_tokens)
            if result.get('error'):
                print(f"    Run {run+1} error: {result['error']}")
            else:
                print(f"    Run {run+1}: {result['tokens_per_sec']:.2f} tok/s ({result['elapsed_s']:.3f}s)")
            run_results.append(result)

        memory_stop.set()
        memory_thread.join(timeout=1)
        peak_rss = max((sample["rss_bytes"] for sample in memory_samples), default=None)
        peak_vms = max((sample["vms_bytes"] for sample in memory_samples if sample["vms_bytes"] is not None), default=None)
        stop_server(proc)
        if lf is not None:
            lf.close()

        valid = [r for r in run_results if not r.get('error')]
        if valid:
            entry = {
                "gpu_layers": gpu_layers,
                "label": mode_label,
                **_summarize_runs(valid),
                "peak_rss_bytes": peak_rss,
                "peak_vms_bytes": peak_vms,
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
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "warmup_rounds": warmup_runs,
            "iterations": bench_runs,
            "best_config": best,
            "speedup_vs_cpu": round(best['avg_tokens_per_sec'] / cpu_result['avg_tokens_per_sec'], 2) if cpu_result and cpu_result['avg_tokens_per_sec'] else None,
            "recommended_gpu_layers": best['gpu_layers'],
            "results": results
        }
    else:
        summary = {
            "model": model_name,
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "warmup_rounds": warmup_runs,
            "iterations": bench_runs,
            "results": results,
            "error": "No valid benchmark results"
        }

    return summary


def compare_baseline(summary: Dict, baseline_path: str) -> Dict:
    """Compare against a prior Lumina report or a JSON object with provider/throughput fields."""
    with open(baseline_path, "r", encoding="utf-8") as baseline_file:
        baseline = json.load(baseline_file)
    baseline_best = baseline.get("best_config", baseline)
    baseline_tps = baseline_best.get("avg_tokens_per_sec")
    current_best = summary.get("best_config", {})
    current_tps = current_best.get("avg_tokens_per_sec")
    if not isinstance(baseline_tps, (int, float)) or not isinstance(current_tps, (int, float)):
        raise ValueError("Baseline JSON must contain best_config.avg_tokens_per_sec or avg_tokens_per_sec")
    summary["baseline_comparison"] = {
        "baseline": Path(baseline_path).name,
        "baseline_provider": baseline.get("provider", baseline.get("model", "unspecified")),
        "baseline_tokens_per_sec": baseline_tps,
        "current_tokens_per_sec": current_tps,
        "throughput_change_percent": round((current_tps / baseline_tps - 1) * 100, 2) if baseline_tps else None,
    }
    return summary


def _timestamped_path(path: str, timestamp: bool) -> str:
    if not timestamp or path == "-":
        return path
    target = Path(path)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    return str(target.with_name(f"{target.stem}-{stamp}{target.suffix}"))


def write_csv_report(summary: Dict, output_path: str) -> None:
    columns = [
        "model", "gpu_layers", "label", "avg_tokens_per_sec", "median_tokens_per_sec",
        "throughput_ci95_low", "throughput_ci95_high", "avg_latency_s", "latency_p50_s",
        "latency_p95_s", "latency_p99_s", "peak_rss_bytes", "peak_vms_bytes", "error",
    ]
    with open(output_path, "w", newline="", encoding="utf-8") as output_file:
        writer = csv.DictWriter(output_file, fieldnames=columns)
        writer.writeheader()
        for result in summary.get("results", []):
            confidence = result.get("throughput_ci95", {})
            writer.writerow({
                "model": summary.get("model"),
                "gpu_layers": result.get("gpu_layers"),
                "label": result.get("label"),
                "avg_tokens_per_sec": result.get("avg_tokens_per_sec"),
                "median_tokens_per_sec": result.get("median_tokens_per_sec"),
                "throughput_ci95_low": confidence.get("low"),
                "throughput_ci95_high": confidence.get("high"),
                "avg_latency_s": result.get("avg_latency_s"),
                "latency_p50_s": result.get("latency_p50_s"),
                "latency_p95_s": result.get("latency_p95_s"),
                "latency_p99_s": result.get("latency_p99_s"),
                "peak_rss_bytes": result.get("peak_rss_bytes"),
                "peak_vms_bytes": result.get("peak_vms_bytes"),
                "error": result.get("error"),
            })


def write_html_report(summary: Dict, output_path: str) -> None:
    rows = []
    for result in summary.get("results", []):
        ci = result.get("throughput_ci95", {})
        values = [
            result.get("label", ""), result.get("gpu_layers", ""),
            result.get("avg_tokens_per_sec", ""),
            f"{ci.get('low', '')}–{ci.get('high', '')}",
            result.get("latency_p50_s", ""), result.get("latency_p95_s", ""),
            result.get("latency_p99_s", ""), result.get("peak_rss_bytes", ""),
            result.get("error", ""),
        ]
        rows.append("<tr>" + "".join(f"<td>{html.escape(str(value))}</td>" for value in values) + "</tr>")
    headers = ["Configuration", "GPU layers", "Mean tok/s", "95% CI tok/s", "p50 latency (s)", "p95 latency (s)", "p99 latency (s)", "Peak RSS (bytes)", "Error"]
    page = (
        "<!doctype html><html lang='en'><meta charset='utf-8'><title>Lumina benchmark</title>"
        "<style>body{font:14px system-ui;margin:2rem}table{border-collapse:collapse}"
        "th,td{border:1px solid #bbb;padding:.45rem;text-align:left}th{background:#eee}</style>"
        f"<h1>Lumina Edge benchmark: {html.escape(str(summary.get('model', 'unknown')))}</h1>"
        f"<p>Timestamp (UTC): {html.escape(str(summary.get('timestamp_utc', 'unknown')))}</p>"
        f"<table><thead><tr>{''.join(f'<th>{html.escape(item)}</th>' for item in headers)}</tr></thead>"
        f"<tbody>{''.join(rows)}</tbody></table></html>"
    )
    Path(output_path).write_text(page, encoding="utf-8")


def write_report_outputs(summary: Dict, args) -> None:
    timestamp = bool(args.output_timestamp)
    json_path = _timestamped_path(args.json_output, timestamp) if args.json_output else None
    if json_path and json_path != "-":
        Path(json_path).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"JSON report: {json_path}")
    if args.csv_output:
        csv_path = _timestamped_path(args.csv_output, timestamp)
        write_csv_report(summary, csv_path)
        print(f"CSV report: {csv_path}")
    if args.html_output:
        html_path = _timestamped_path(args.html_output, timestamp)
        write_html_report(summary, html_path)
        print(f"HTML report: {html_path}")
    if args.log_output:
        log_path = _timestamped_path(args.log_output, timestamp)
        Path(log_path).write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"Benchmark log: {log_path}")
    if not json_path or json_path == "-":
        print(json.dumps(summary, indent=2))


def _non_negative_int(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError('value must be zero or greater')
    return parsed


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError('value must be greater than zero')
    return parsed


def _add_output_arguments(parser) -> None:
    parser.add_argument('--warmup-rounds', '--warmup', dest='warmup_rounds', type=_non_negative_int, default=1, help='Warmup requests per GPU configuration')
    parser.add_argument('--iterations', '--runs', dest='iterations', type=_positive_int, default=3, help='Measured requests per GPU configuration')
    parser.add_argument('--output-timestamp', action='store_true', help='Append a UTC timestamp to report filenames')
    parser.add_argument('--json-output', nargs='?', const='benchmark.json', help='Write a JSON report (default filename: benchmark.json; use - for stdout)')
    parser.add_argument('--csv-output', nargs='?', const='benchmark.csv', help='Write a CSV report (default filename: benchmark.csv)')
    parser.add_argument('--html-output', nargs='?', const='benchmark.html', help='Write a self-contained HTML summary (default filename: benchmark.html)')
    parser.add_argument('--log-output', nargs='?', const='benchmark.log.json', help='Write the structured benchmark report as a log (default filename: benchmark.log.json)')
    parser.add_argument('--baseline-comparison', help='Compare against a JSON report or {"provider":..., "avg_tokens_per_sec":...} file')


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
    _add_output_arguments(bench_parser)

    quick_parser = subparsers.add_parser('quick', help='Quick CPU vs GPU comparison')
    quick_parser.add_argument('--bin-dir', required=True, help='Path to bin directory')
    quick_parser.add_argument('--model', required=True, help='Path to model file')
    quick_parser.add_argument('--ctx-size', type=int, default=2048)
    quick_parser.add_argument('--threads', type=int, default=4)
    _add_output_arguments(quick_parser)

    args = parser.parse_args()

    if args.command == 'run':
        result = benchmark_gpu_layers(
            args.bin_dir, args.model, args.base_port,
            args.gpu_layers, args.ctx_size, args.threads,
            args.max_tokens, args.warmup_rounds, args.iterations
        )
        if args.baseline_comparison:
            result = compare_baseline(result, args.baseline_comparison)
        write_report_outputs(result, args)

    elif args.command == 'quick':
        result = benchmark_gpu_layers(
            args.bin_dir, args.model, base_port=8100,
            gpu_configs=[0, 99], ctx_size=args.ctx_size,
            threads=args.threads, max_tokens=64,
            warmup_runs=args.warmup_rounds, bench_runs=args.iterations
        )
        if args.baseline_comparison:
            result = compare_baseline(result, args.baseline_comparison)
        write_report_outputs(result, args)

    else:
        parser.print_help()
