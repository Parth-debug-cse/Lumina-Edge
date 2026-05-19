"""
lumina_scout/hardware.py
Detects GPU, CPU, and RAM for the current machine.
Supports macOS (Apple Silicon), Windows (NVIDIA/AMD), Linux (NVIDIA/AMD).
Uses only stdlib + psutil + platform-specific subprocess calls.
"""

import os
import platform
import subprocess
import json
from dataclasses import dataclass

SCOUT_ROOT = os.path.dirname(os.path.abspath(__file__))


@dataclass
class GPUInfo:
    name: str
    vram_gb: float
    gpu_type: str


@dataclass
class HardwareInfo:
    gpu: "GPUInfo | None"
    ram_gb: float
    cpu_name: str
    cpu_cores: int
    platform_name: str
    backend: str


def detect() -> HardwareInfo:
    try:
        plat = _detect_platform()
        cpu_name, cpu_cores = _detect_cpu()
        ram_gb = _detect_ram()
        gpu = _detect_gpu(plat)
        backend = _infer_backend(plat, gpu)
        return HardwareInfo(
            gpu=gpu,
            ram_gb=ram_gb,
            cpu_name=cpu_name,
            cpu_cores=cpu_cores,
            platform_name=plat,
            backend=backend,
        )
    except Exception:
        return HardwareInfo(
            gpu=None,
            ram_gb=0.0,
            cpu_name="Unknown",
            cpu_cores=1,
            platform_name="Linux",
            backend="cpu",
        )


def _detect_platform() -> str:
    s = platform.system()
    if s == "Darwin":
        return "macOS"
    if s == "Windows":
        return "Windows"
    return "Linux"


def _detect_cpu() -> tuple:
    try:
        import psutil
        cores = psutil.cpu_count(logical=False)
    except Exception:
        cores = None
    if cores is None:
        cores = os.cpu_count()
    if cores is None or cores < 1:
        cores = 1

    name = platform.processor() or ""

    if platform.system() == "Darwin" and not name.strip():
        try:
            out = subprocess.check_output(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                stderr=subprocess.DEVNULL, text=True, timeout=5
            ).strip()
            if out:
                name = out
        except Exception:
            pass

    if not name.strip():
        name = "Unknown CPU"

    return name, cores


def _detect_ram() -> float:
    try:
        import psutil
        return round(psutil.virtual_memory().total / (1024 ** 3), 1)
    except Exception:
        return 0.0


def _detect_gpu(plat: str):
    if plat == "macOS":
        result = _detect_apple_silicon()
        if result is not None:
            return result
        return _detect_nvidia_smi()
    if plat == "Windows":
        result = _detect_nvidia_smi()
        if result is not None:
            return result
        return _detect_amd_windows()
    result = _detect_nvidia_smi()
    if result is not None:
        return result
    return _detect_amd_linux()


def _detect_apple_silicon():
    try:
        out = subprocess.check_output(
            ["system_profiler", "SPHardwareDataType", "-json"],
            stderr=subprocess.DEVNULL, text=True, timeout=5
        )
        data = json.loads(out)
        hw_list = data.get("SPHardwareDataType", [])
        if not hw_list:
            return None
        hw = hw_list[0]
        chip = hw.get("chip_type", "") or hw.get("cpu_type", "")

        mem_str = hw.get("physical_memory", "")
        vram_gb = 0.0
        if mem_str:
            parts = mem_str.split()
            if parts:
                try:
                    vram_gb = float(parts[0])
                except (ValueError, IndexError):
                    pass

        if chip and any(marker in chip for marker in ("Apple", "M1", "M2", "M3", "M4")):
            return GPUInfo(name=chip, vram_gb=vram_gb, gpu_type="apple")
    except Exception:
        pass

    try:
        chip = subprocess.check_output(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            stderr=subprocess.DEVNULL, text=True, timeout=3
        ).strip()
        if "Apple" in chip:
            try:
                import psutil
                ram = round(psutil.virtual_memory().total / (1024 ** 3), 1)
            except Exception:
                ram = 0.0
            return GPUInfo(name=chip, vram_gb=ram, gpu_type="apple")
    except Exception:
        pass

    return None


def _detect_nvidia_smi():
    try:
        out = subprocess.check_output(
            ["nvidia-smi",
             "--query-gpu=name,memory.total",
             "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL, text=True, timeout=5
        ).strip()
        if not out:
            return None
        first_line = out.splitlines()[0]
        parts = first_line.split(",")
        if len(parts) < 2:
            return None
        name = parts[0].strip()
        vram_mb = float(parts[1].strip())
        return GPUInfo(name=name, vram_gb=round(vram_mb / 1024, 1), gpu_type="nvidia")
    except Exception:
        return None


def _detect_amd_windows():
    try:
        out = subprocess.check_output(
            ["wmic", "path", "win32_VideoController",
             "get", "Name,AdapterRAM", "/format:csv"],
            stderr=subprocess.DEVNULL, text=True, timeout=5
        )
        for line in out.splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 3:
                ram_str = parts[1]
                name = parts[2]
                if "AMD" in name or "Radeon" in name:
                    try:
                        vram_gb = round(int(ram_str) / (1024 ** 3), 1)
                    except (ValueError, TypeError):
                        vram_gb = 0.0
                    return GPUInfo(name=name, vram_gb=vram_gb, gpu_type="amd")
    except Exception:
        pass
    return None


def _detect_amd_linux():
    try:
        out = subprocess.check_output(
            ["rocm-smi", "--showmeminfo", "vram", "--json"],
            stderr=subprocess.DEVNULL, text=True, timeout=5
        )
        data = json.loads(out)
        for card, info in data.items():
            vram_str = info.get("VRAM Total Memory (B)", "0")
            vram_bytes = int(vram_str)
            return GPUInfo(
                name=f"AMD GPU ({card})",
                vram_gb=round(vram_bytes / (1024 ** 3), 1),
                gpu_type="amd",
            )
    except Exception:
        pass

    try:
        drm = "/sys/class/drm"
        if not os.path.isdir(drm):
            return None
        for entry in os.listdir(drm):
            vram_path = os.path.join(drm, entry, "device", "mem_info_vram_total")
            name_path = os.path.join(drm, entry, "device", "uevent")
            if os.path.exists(vram_path):
                with open(vram_path) as f:
                    vram_bytes = int(f.read().strip())
                name = "AMD GPU"
                if os.path.exists(name_path):
                    with open(name_path) as f:
                        for line in f:
                            if "PCI_ID" in line:
                                name = f"AMD GPU ({line.split('=')[1].strip()})"
                                break
                return GPUInfo(
                    name=name,
                    vram_gb=round(vram_bytes / (1024 ** 3), 1),
                    gpu_type="amd",
                )
    except Exception:
        pass

    return None


def _infer_backend(plat: str, gpu) -> str:
    if plat == "macOS" and gpu is not None and gpu.gpu_type == "apple":
        return "mlx"
    if gpu is not None and gpu.gpu_type in ("nvidia", "amd"):
        return "llama.cpp"
    return "cpu"
