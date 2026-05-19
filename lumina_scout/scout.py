"""
lumina_scout/scout.py
Lumina Scout public API — called by Lumina Edge UI routes.
"""

import os
import re

SCOUT_ROOT = os.path.dirname(os.path.abspath(__file__))

try:
    from hardware import detect as _detect_hardware
    from fetcher import fetch as _fetch_models
    from ranker import rank as _rank_models, BYTES_PER_WEIGHT, OVERHEAD, _gpu_bandwidth, _estimate_params, _best_quant_for_vram, GPU_BANDWIDTH_TABLE
except ImportError:
    from lumina_scout.hardware import detect as _detect_hardware
    from lumina_scout.fetcher import fetch as _fetch_models
    from lumina_scout.ranker import rank as _rank_models, BYTES_PER_WEIGHT, OVERHEAD, _gpu_bandwidth, _estimate_params, _best_quant_for_vram, GPU_BANDWIDTH_TABLE


def get_hardware_info() -> dict:
    hw = _detect_hardware()
    return {
        "gpu_name":  hw.gpu.name     if hw.gpu else "CPU Only",
        "vram_gb":   hw.gpu.vram_gb  if hw.gpu else 0.0,
        "gpu_type":  hw.gpu.gpu_type if hw.gpu else "cpu",
        "ram_gb":    hw.ram_gb,
        "cpu_name":  hw.cpu_name,
        "cpu_cores": hw.cpu_cores,
        "platform":  hw.platform_name,
        "backend":   hw.backend,
    }


def get_recommendations(
    top: int = 10,
    profile: str = "general",
    quant: str = None,
    min_speed: float = None,
    gpu_override: str = None,
    cpu_only: bool = False,
    refresh: bool = False,
) -> list:
    top = int(top)
    hw = _detect_hardware()

    if cpu_only:
        hw.gpu = None

    if gpu_override:
        try:
            from hardware import GPUInfo
        except ImportError:
            from lumina_scout.hardware import GPUInfo
        hw.gpu = GPUInfo(name=gpu_override, vram_gb=hw.ram_gb * 0.6, gpu_type="nvidia")

    models = _fetch_models(profile=profile, refresh=refresh)
    ranked = _rank_models(
        models=models,
        hardware=hw,
        top=top,
        quant_filter=quant,
        min_speed=min_speed,
    )
    result = []
    for i, m in enumerate(ranked, 1):
        result.append({
            "rank":             i,
            "model_id":         m.model_id,
            "score":            m.score,
            "fit_type":         m.fit_type,
            "vram_required_gb": m.vram_required_gb,
            "speed_tps":        m.speed_tps,
            "quant":            m.quant or "N/A",
            "downloads":        m.downloads,
            "likes":            m.likes,
            "benchmark_source": "",
        })
    return result


def get_plan(model_query: str, quant: str = None, context_length: int = 4096) -> dict:
    m = re.search(r'(\d+\.?\d*)\s*[bB]', model_query, re.IGNORECASE)
    if not m:
        return {
            "error": f"Could not parse parameter count from: '{model_query}'. Try e.g. 'llama 3 70b'."
        }

    params_b = float(m.group(1))

    vram_by_quant = {}
    for q, bpw in sorted(BYTES_PER_WEIGHT.items(), key=lambda x: x[1]):
        vram_by_quant[q] = round(params_b * bpw * OVERHEAD, 2)

    target_quant = quant if quant in BYTES_PER_WEIGHT else "Q4_K_M"
    recommended = round(params_b * BYTES_PER_WEIGHT[target_quant] * OVERHEAD, 2)

    min_full_gpu = None
    for q in ("Q4_K_M", "Q3_K_M", "Q2_K"):
        v = vram_by_quant.get(q)
        if v is not None:
            min_full_gpu = v
            break

    hw = _detect_hardware()
    gpu_list = [
        ("NVIDIA RTX 4090",    24.0, 1008.0),
        ("NVIDIA RTX 4080",    16.0,  717.0),
        ("NVIDIA RTX 4070",    12.0,  504.0),
        ("NVIDIA RTX 3090",    24.0,  936.0),
        ("NVIDIA RTX 3080",    10.0,  760.0),
        ("NVIDIA RTX 3070",     8.0,  448.0),
        ("NVIDIA RTX 3060",    12.0,  360.0),
        ("AMD RX 7900 XTX",    24.0,  960.0),
        ("AMD RX 7800 XT",     16.0,  576.0),
        ("AMD RX 6900 XT",     16.0,  512.0),
        ("Apple M4 Max",      128.0,  410.0),
        ("Apple M4 Pro",       64.0,  273.0),
        ("Apple M4",           32.0,  120.0),
        ("Apple M3 Max",      128.0,  300.0),
        ("Apple M3 Pro",       36.0,  150.0),
        ("Apple M3",           24.0,  100.0),
    ]

    if hw.gpu is not None and hw.gpu.name != "CPU Only":
        existing_names = [g[0] for g in gpu_list]
        if hw.gpu.name not in existing_names:
            bw = _gpu_bandwidth(hw.gpu)
            gpu_list.insert(0, (hw.gpu.name, hw.gpu.vram_gb, bw))

    bpw_target = BYTES_PER_WEIGHT.get(target_quant, 0.55)
    model_vram = params_b * bpw_target * OVERHEAD

    kv_cache_gb = round(params_b * context_length * 0.00003 * bpw_target, 2)

    gpu_compatibility = []
    for name, vram_gb, bw in gpu_list:
        if model_vram <= vram_gb:
            fit = "full_gpu"
        elif model_vram <= vram_gb * 2.5:
            fit = "partial_offload"
        else:
            fit = "cpu_only"

        est_tps = round(min(200.0, bw / (params_b * bpw_target)), 1) if fit != "cpu_only" else None

        gpu_compatibility.append({
            "name": name,
            "vram_gb": vram_gb,
            "fit_type": fit,
            "estimated_tok_per_sec": est_tps,
        })

    fit_order = {"full_gpu": 0, "partial_offload": 1, "cpu_only": 2}
    gpu_compatibility.sort(key=lambda g: (fit_order.get(g["fit_type"], 3), -g["vram_gb"]))

    return {
        "model": {
            "id": model_query,
            "params_billions": params_b,
        },
        "params_billions": params_b,
        "min_full_gpu": min_full_gpu,
        "vram_by_quant": vram_by_quant,
        "quant_breakdown": vram_by_quant,
        "kv_cache_estimate_gb": kv_cache_gb,
        "context_length": context_length,
        "recommended_vram_gb": recommended,
        "target_quant": target_quant,
        "gpu_compatibility": gpu_compatibility,
    }
