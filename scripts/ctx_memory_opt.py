#!/usr/bin/env python3
"""
Context Window & Memory Optimization
Estimates optimal context size based on available memory, and provides
KV cache and prompt caching recommendations.
"""

import os
import sys
import json
import platform
import argparse
import subprocess
from pathlib import Path


def estimate_model_memory(model_path, ctx_size=4096, kv_quant="q8_0", gpu_layers=99):
    """
    Estimate memory required for a model at a given context size.

    Approximations:
    - Model weights: file size on disk (roughly equals RAM usage for GGUF)
    - KV cache: 2 * n_layers * n_heads * head_dim * ctx_size * bytes_per_element
    - For GGUF Q4_K_M: ~4.5 bits/param for weights
    - KV cache quant: q8_0 = 1 byte/element, q4_0 = 0.5 bytes/element
    """
    model_path = Path(model_path)
    if not model_path.exists():
        return {"error": f"Model not found: {model_path}"}

    # Get file size as proxy for weight memory
    if model_path.is_dir():
        total_size = sum(f.stat().st_size for f in model_path.rglob('*') if f.is_file())
    else:
        total_size = model_path.stat().st_size

    weight_mem_gb = total_size / (1024 ** 3)

    # Try to read model metadata for KV cache estimation
    # Fallback to 7B-model defaults if config.json not found
    n_layers = 32
    n_kv_heads = 32
    head_dim = 128

    if model_path.is_dir():
        config_path = model_path / 'config.json'
    else:
        config_path = model_path.parent / 'config.json'

    if config_path.exists():
        try:
            with open(config_path, 'r') as f:
                config = json.load(f)
            n_layers = config.get('num_hidden_layers', config.get('n_layer', n_layers))
            n_kv_heads = config.get('num_key_value_heads', config.get('n_heads', n_kv_heads))
            hidden_size = config.get('hidden_size', 4096)
            head_dim = hidden_size // n_kv_heads
        except Exception:
            pass

    # KV cache memory per token
    kv_bytes_per_element = {"q8_0": 1, "q4_0": 0.5, "f16": 2, "q5_0": 0.625}.get(kv_quant, 1)
    # KV cache = 2 (K + V) * n_layers * n_kv_heads * head_dim * bytes_per_element
    kv_bytes_per_token = 2 * n_layers * n_kv_heads * head_dim * kv_bytes_per_element
    kv_mem_gb = (kv_bytes_per_token * ctx_size) / (1024 ** 3)

    # Context overhead (input processing, temp buffers) ~10-20% of KV cache
    overhead_gb = kv_mem_gb * 0.15

    # Total estimated memory = weights + KV cache + overhead
    total_estimated_gb = weight_mem_gb + kv_mem_gb + overhead_gb

    # Adjust for GPU offloading: GPU handles ~30% of memory when fully offloaded
    if gpu_layers > 0:
        gpu_ratio = min(1.0, gpu_layers / 80.0)
        total_estimated_gb *= (1.0 - gpu_ratio * 0.3)

    return {
        "model_path": str(model_path),
        "weight_memory_gb": round(weight_mem_gb, 3),
        "kv_cache_memory_gb": round(kv_mem_gb, 3),
        "overhead_gb": round(overhead_gb, 3),
        "total_estimated_gb": round(total_estimated_gb, 3),
        "ctx_size": ctx_size,
        "kv_quant": kv_quant,
        "n_layers": n_layers,
        "n_kv_heads": n_kv_heads,
        "head_dim": head_dim,
        "kv_bytes_per_token": kv_bytes_per_token
    }


def recommend_ctx_size(model_path, available_mem_gb, kv_quant="q8_0", gpu_layers=99, headroom_pct=15):
    """
    Recommend maximum context size that fits in available memory.
    Rounds down to nearest common size (512, 1024, 2048, 4096, etc.).
    """
    baseline = estimate_model_memory(model_path, 4096, kv_quant, gpu_layers)
    if "error" in baseline:
        return baseline

    weight_mem = baseline["weight_memory_gb"]
    kv_per_token = baseline["kv_bytes_per_token"]

    # Available memory for KV cache = total - weights - overhead - headroom
    headroom = available_mem_gb * (headroom_pct / 100)
    available_for_kv = available_mem_gb - weight_mem - headroom

    if available_for_kv <= 0:
        return {
            "error": "Not enough memory for this model even at minimum context",
            "weight_memory_gb": round(weight_mem, 3),
            "available_memory_gb": available_mem_gb,
            "deficit_gb": round(-available_for_kv, 3)
        }

    # Max ctx = available_for_kv in bytes / kv_bytes_per_token
    max_ctx = int(available_for_kv * (1024 ** 3) / kv_per_token)

    # Round down to the nearest common context size
    common_sizes = [512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072]
    recommended = common_sizes[0]
    for size in common_sizes:
        if size <= max_ctx:
            recommended = size
        else:
            break

    verify = estimate_model_memory(model_path, recommended, kv_quant, gpu_layers)

    return {
        "recommended_ctx_size": recommended,
        "max_possible_ctx": max_ctx,
        "available_memory_gb": available_mem_gb,
        "weight_memory_gb": round(weight_mem, 3),
        "kv_memory_at_recommended_gb": verify.get("kv_cache_memory_gb", 0),
        "total_at_recommended_gb": verify.get("total_estimated_gb", 0),
        "headroom_pct": headroom_pct,
        "kv_quant": kv_quant,
        "alternatives": []
    }


def get_system_memory():
    """Get available system memory in GB — cross-platform."""
    system = platform.system()

    try:
        if system == "Linux":
            with open('/proc/meminfo', 'r') as f:
                for line in f:
                    if line.startswith('MemAvailable:'):
                        return int(line.split()[1]) * 1024 / (1024 ** 3)

        elif system == "Darwin":
            # macOS: parse vm_stat output for free pages
            vm_output = subprocess.check_output(['vm_stat'], text=True)
            page_size = 4096
            free_pages = 0

            for line in vm_output.split('\n'):
                if 'page size' in line.lower():
                    page_size = int(line.split()[-1].rstrip('.'))
                elif 'Pages free:' in line:
                    free_pages = int(line.split(':')[1].strip().rstrip('.'))

            return free_pages * page_size / (1024 ** 3)

        elif system == "Windows":
            try:
                import psutil
                return psutil.virtual_memory().available / (1024 ** 3)
            except ImportError:
                pass

    except Exception:
        pass

    return 8.0  # safe fallback if detection fails


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Context Window & Memory Optimization')
    subparsers = parser.add_subparsers(dest='command')

    est_parser = subparsers.add_parser('estimate', help='Estimate memory for a model at given ctx size')
    est_parser.add_argument('model_path', help='Path to model file')
    est_parser.add_argument('--ctx-size', type=int, default=4096, help='Context size')
    est_parser.add_argument('--kv-quant', default='q8_0', choices=['q8_0', 'q4_0', 'f16', 'q5_0'], help='KV cache quantization')
    est_parser.add_argument('--gpu-layers', type=int, default=99, help='GPU layers')

    rec_parser = subparsers.add_parser('recommend', help='Recommend optimal ctx size')
    rec_parser.add_argument('model_path', help='Path to model file')
    rec_parser.add_argument('--available-mem', type=float, help='Available memory in GB (auto-detect if not specified)')
    rec_parser.add_argument('--kv-quant', default='q8_0', choices=['q8_0', 'q4_0', 'f16', 'q5_0'], help='KV cache quantization')
    rec_parser.add_argument('--headroom', type=float, default=15, help='Headroom percentage')

    cmp_parser = subparsers.add_parser('compare-kv', help='Compare KV cache quantizations')
    cmp_parser.add_argument('model_path', help='Path to model file')
    cmp_parser.add_argument('--ctx-size', type=int, default=4096, help='Context size')

    args = parser.parse_args()

    if args.command == 'estimate':
        result = estimate_model_memory(args.model_path, args.ctx_size, args.kv_quant, args.gpu_layers)
        print(json.dumps(result, indent=2))

    elif args.command == 'recommend':
        available = args.available_mem or get_system_memory()
        result = recommend_ctx_size(args.model_path, available, args.kv_quant, headroom_pct=args.headroom)
        print(json.dumps(result, indent=2))

    elif args.command == 'compare-kv':
        print(f"KV Cache Memory Comparison (ctx_size={args.ctx_size}):")
        for quant in ['f16', 'q8_0', 'q5_0', 'q4_0']:
            result = estimate_model_memory(args.model_path, args.ctx_size, quant)
            if 'error' not in result:
                print(f"  {quant}: KV={result['kv_cache_memory_gb']:.3f} GB | Total={result['total_estimated_gb']:.3f} GB")

    else:
        parser.print_help()
