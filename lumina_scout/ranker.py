"""
lumina_scout/ranker.py
Scores and ranks ModelInfo objects against detected hardware.
"""

import os
import re
import math

try:
    from hardware import HardwareInfo, GPUInfo
    from fetcher import ModelInfo
except ImportError:
    from lumina_scout.hardware import HardwareInfo, GPUInfo
    from lumina_scout.fetcher import ModelInfo

SCOUT_ROOT = os.path.dirname(os.path.abspath(__file__))

OVERHEAD = 1.18

BYTES_PER_WEIGHT: dict = {
    "Q2_K":   0.375,
    "Q3_K_M": 0.44,
    "Q4_0":   0.50,
    "Q4_K_S": 0.52,
    "Q4_K_M": 0.55,
    "Q5_K_M": 0.69,
    "Q6_K":   0.80,
    "Q8_0":   1.00,
    "F16":    2.00,
    "BF16":   2.00,
}

QUANT_QUALITY: dict = {
    "Q2_K":   3.0,
    "Q3_K_M": 4.5,
    "Q4_0":   5.5,
    "Q4_K_S": 6.0,
    "Q4_K_M": 7.0,
    "Q5_K_M": 8.5,
    "Q6_K":   9.0,
    "Q8_0":   9.5,
    "F16":    10.0,
    "BF16":   10.0,
}

GPU_BANDWIDTH_TABLE: list = [
    ("H100",        3350.0), ("A100",        2000.0),
    ("RTX 4090",    1008.0), ("RTX 3090",     936.0),
    ("RTX 4080",     717.0), ("RTX 3080",     760.0),
    ("RTX 4070 Ti",  672.0), ("RTX 4070",     504.0),
    ("RTX 3070",     448.0), ("RTX 2080",     448.0),
    ("RTX 4060",     288.0),
    ("RX 7900 XTX",  960.0), ("RX 6900 XT",   512.0),
    ("RX 7800 XT",   576.0),
    ("M4 Ultra",     546.0), ("M4 Max",       410.0),
    ("M4 Pro",       273.0), ("M4",           120.0),
    ("M3 Ultra",     800.0), ("M3 Max",       300.0),
    ("M3 Pro",       150.0), ("M3",           100.0),
    ("M2 Ultra",     800.0), ("M2 Max",       400.0),
    ("M2 Pro",       200.0), ("M2",           100.0),
    ("M1 Ultra",     800.0), ("M1 Max",       400.0),
    ("M1 Pro",       200.0), ("M1",            68.0),
]
DEFAULT_BANDWIDTH = 200.0
CPU_BANDWIDTH     =  50.0


def _gpu_bandwidth(gpu) -> float:
    if gpu is None:
        return CPU_BANDWIDTH
    name = gpu.name
    for pattern, bw in GPU_BANDWIDTH_TABLE:
        if pattern.lower() in name.lower():
            return bw
    return DEFAULT_BANDWIDTH


def _estimate_params(model_id: str):
    match = re.search(
        r'[-_]?(\d+\.?\d*)\s*[bB](?:[-_\s.]|$)',
        model_id, re.IGNORECASE
    )
    if match:
        return float(match.group(1))
    for token in re.split(r'[-_/]', model_id):
        if token.isdigit():
            val = int(token)
            if 1 <= val <= 671:
                return float(val)
    return None


def _best_quant_for_vram(params_b: float, vram_gb: float) -> str:
    for q in ("Q5_K_M", "Q4_K_M", "Q3_K_M", "Q2_K"):
        bpw = BYTES_PER_WEIGHT[q]
        if params_b * bpw * OVERHEAD <= vram_gb:
            return q
    return "Q2_K"


def rank(models, hardware, top: int = 10, quant_filter=None, min_speed=None) -> list:
    vram_available = hardware.gpu.vram_gb if hardware.gpu else hardware.ram_gb * 0.6
    bw = _gpu_bandwidth(hardware.gpu)
    scored = []

    for m in models:
        params_b = _estimate_params(m.model_id)
        if params_b is None:
            continue

        quant = quant_filter if quant_filter else _best_quant_for_vram(params_b, vram_available)
        bpw = BYTES_PER_WEIGHT.get(quant, 0.55)
        vram_needed = params_b * bpw * OVERHEAD

        if vram_needed <= vram_available:
            fit_type = "full_gpu"
            fit_score = 40.0
        elif vram_needed <= vram_available * 2.5:
            fit_type = "partial_offload"
            fit_score = 40.0 * (vram_available / vram_needed)
        else:
            fit_type = "cpu_only"
            fit_score = 5.0

        denom = params_b * bpw
        tps = min(200.0, bw / denom) if denom > 0 else 0.0
        if min_speed is not None and tps < min_speed:
            continue

        speed_score = (tps / 200.0) * 20.0
        denom2 = bpw * OVERHEAD
        capped = min(params_b, vram_available / denom2) if denom2 > 0 else params_b
        size_score = min(20.0, math.log1p(capped) * 4.0)
        pop_score = min(10.0, math.log1p((m.downloads or 0) / 1000.0 + (m.likes or 0) * 5.0) * 1.5)
        q_score = (QUANT_QUALITY.get(quant, 5.0) / 10.0) * 10.0

        m.score = round(fit_score + speed_score + size_score + pop_score + q_score, 1)
        m.quant = quant
        m.vram_required_gb = round(vram_needed, 2)
        m.speed_tps = round(tps, 1)
        m.fit_type = fit_type
        scored.append(m)

    scored.sort(key=lambda x: x.score, reverse=True)
    return scored[:top]
