# ⚡ Lumina Edge

<div align="center">

**Local LLM execution framework engineered for hardware you already own.**

*No cloud. No API keys. No telemetry. Maximum resource extraction.*

![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D4?style=flat-square&logo=windows)
![Linux](https://img.shields.io/badge/Linux-Ubuntu%2FDebian-E95420?style=flat-square&logo=linux)
![Backend](https://img.shields.io/badge/Backend-Vulkan%20%7C%20CUDA-76B900?style=flat-square)
![Core](https://img.shields.io/badge/Powered%20by-llama.cpp-black?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

</div>

---

## What is Lumina Edge?

Lumina Edge is a **cross-platform execution framework** (Windows `.bat` & Linux `.sh`) that wraps the high-performance `llama.cpp` inference engine. It intelligently optimizes system state, manages downloaded models dynamically, and exposes a clean CLI or API interface.

By abstracting away configuration complexities and aggressively reclaiming host OS memory, Lumina Edge makes powerful, private AI accessible on consumer-grade hardware—even low-spec laptops with integrated graphics.

**Core Capabilities:**
- **Aggressive Memory Reclamation:** Kernel-level state pausing (Linux `systemctl`/`/proc` and Windows Win32 APIs) reclaims 1–2 GB of RAM *before* inference starts.
- **Universal Backend Support:** Drops natively into Vulkan (Intel/AMD iGPU) or CUDA (NVIDIA) compute environments.
- **Dynamic Model Manager:** Abstracted downloading and dynamic UI list generation for local `.gguf` quantization files.
- **OpenAI-Compatible Endpoint:** Instantly spins up a local REST API endpoint for Python/Node.js/PowerShell SDK parity.

---

## System Architecture

```text
┌───────────────────────────────────────────────────────────────────────┐
│                       LUMINA EDGE FRAMEWORK                           │
├─────────────────────┬───────────────────────────┬─────────────────────┤
│     USER LAYER      │      CONTROL LAYER        │    ENGINE LAYER     │
│                     │                           │                     │
│  CLI Chat UI        │  Cross-Platform Scripts   │  llama.cpp Core     │
│  REST API Endpoint  │  Path & OS Auto-detect    │  GGUF Quantization  │
│  Model Manager      │  GPU Fallback Logic       │  Vulkan / CUDA      │
├─────────────────────┴───────────────────────────┴─────────────────────┤
│                    OS OPTIMIZATION LAYER (HOST)                       │
│  Windows: Win32 EmptyWorkingSet · Service Suspension · MMAgent        │
│  Linux: sync/drop_caches · THP Disabled · systemctl Pause · swappiness│
└───────────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```text
Lumina-Edge/                     ← Portable deployment
├── bin/                         ← llama.cpp binaries
│   ├── llama-cli (.exe)
│   └── llama-server (.exe)
├── core/                        ← Execution Controllers
│   ├── lumina-core.bat / .sh          ← CLI Chat (Vulkan iGPU)
│   ├── lumina-core-nvidia.bat / .sh   ← CLI Chat (CUDA)
│   ├── lumina-api.bat / .sh           ← API Server (Vulkan iGPU)
│   └── lumina-api-nvidia.bat / .sh    ← API Server (CUDA)
├── scripts/
│   ├── optimize_system.ps1      ← Windows Memory Optimizer
│   └── optimize_system.sh       ← Linux Memory Optimizer
├── models/                      ← Local .gguf storage
└── model-manager.bat / .sh      ← Model lifecycle CLI
```

---

## Quick Start

### 1. Engine Installation

Download the latest corresponding `llama.cpp` release binaries from [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/releases/latest) and extract all files strictly directly into the `Lumina-Edge/bin/` directory.

| OS | Backend Target | Filename Pattern |
|----|---------------|------------------|
| **Windows** | Vulkan (Intel/AMD) | `llama-bXXX-bin-win-vulkan-x64.zip` |
| **Windows** | CUDA (NVIDIA) | `llama-bXXX-bin-win-cuda-cu12.x-x64.zip` |
| **Linux (Ubuntu)**| Vulkan (Intel/AMD) | `llama-bXXX-bin-ubuntu-vulkan-x64.tar.gz` |
| **Linux (Ubuntu)**| CUDA (NVIDIA) | `llama-bXXX-bin-ubuntu-x64-cuda.tar.gz` |

*(Note for Linux: Ensure scripts are executable: `chmod +x model-manager.sh && chmod +x core/*.sh scripts/*.sh`)*

### 2. Procure a Quantized Model

Launch the interactive model manager to download pre-configured, highly-optimized quantized models straight from HuggingFace.

- **Windows:** Double-click `model-manager.bat`
- **Linux:** Run `./model-manager.sh`

*(Downloads are directly streamed into the `models/` directory. The UI dynamically detects any file sizes and updates lists automatically without strict file renaming requirements).*

### 3. Execution

Launch via the specific backend script your hardware requires. 

| Interface | Windows (Run as Admin) | Linux (Executes `sudo`) |
|---|---|---|
| **Chat (Vulkan)** | `core\lumina-core.bat` | `./core/lumina-core.sh` |
| **Chat (CUDA)** | `core\lumina-core-nvidia.bat` | `./core/lumina-core-nvidia.sh` |
| **API Server (Vulkan)** | `core\lumina-api.bat` | `./core/lumina-api.sh` |
| **API Server (CUDA)** | `core\lumina-api-nvidia.bat` | `./core/lumina-api-nvidia.sh` |

> [!NOTE]  
> Administrative/`sudo` privileges are requested strictly for the temporary memory optimization step. Inference runs purely locally without network telemetry.

---

## Hardware & Environment Specifications

### Core Requirements
| Component | Minimum Execution | Optimal Performance |
|---|---|---|
| **Windows** | Windows 10 x64 (1909+) | Windows 11 x64 |
| **Linux** | Ubuntu 20.04 / Debian 11 | Ubuntu 24.04 LTS |
| **Memory** | 4 GB | 8 GB+ |
| **Processor**| Dual-core x86-64 | Quad-core (i5/Ryzen 5) |
| **Storage** | 10 GB Free Space | 20 GB+ NVMe SSD |

### Graphics / Neural Accelerators
- **Vulkan Backend (Intel/AMD):** Compatible with Intel UHD 600+, Intel Iris Xe, and AMD Radeon integrated graphics. 
  - **Linux dependency:** `sudo apt install mesa-vulkan-drivers`
  - **Windows dependency:** Vulkan Runtime (LunarG).
- **CUDA Backend (NVIDIA):** Compatible with GTX 1050 or any newer RTX series constraint to VRAM. 
  - Requires NVIDIA display drivers `535+`.

---

## Deep Dive: How System Optimization Works

Consumer OS configurations historically hold massive amounts of RAM captive for caching and background indexing. Lumina Edge intercepts system state prior to LLM initialization to surgically reclaim 1–2 GB of contiguous memory space, ensuring stable tensor loading.

### Windows Runtime (`optimize_system.ps1`)
1. **API Purge:** Directly invokes the `EmptyWorkingSet` Win32 capability to forcefully release memory pages held by inactive processes back to the available memory pool.
2. **Daemon Suspension:** Safely halts heavy Windows daemons (`WSearch`, `SysMain`, `WslService`, `DiagTrack`) caching up to ~1.3 GB.
3. **Memory Agent Tuning:** Bypasses `MMAgent` memory compression (`-mc`), drastically dropping CPU overhead during quant weight decoding.

### Linux Kernel (`optimize_system.sh`)
1. **Page Cache Overrides:** Issues `sync` and flushes OS dentries and inodes via `echo 3 > /proc/sys/vm/drop_caches`. 
2. **Memory Compaction:** Re-assembles defragmented memory blocks (`/proc/sys/vm/compact_memory`).
3. **Daemon Suspension:** Pauses `systemd` user daemons (e.g., `snapd`, `packagekit`, `tracker-miner-fs`).
4. **THP Bypass:** Dynamically disables Transparent Huge Pages (`/sys/kernel/mm/transparent_hugepage/enabled = madvise`) preventing allocation stalls.
5. **Swappiness:** Redirection of `/proc/sys/vm/swappiness` to prioritize volatile RAM vs disk paging.

> **Safety Design Rating:** Both OS scripts automatically generate a stateless teardown restore file (e.g., `/tmp/lumina_restore_services.sh`) guaranteeing environment integrity upon application exit or system reboot.

---

## Developer API (OpenAI Compatible)

The API mode executes a robust, lock-free HTTP REST interface compliant with OpenAI methodologies on `http://127.0.0.1:1234/v1`. 

### Python Integration

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:1234/v1",
    api_key="lumina-local-deploy" # Placeholder, bypasses auth locally
)

response = client.chat.completions.create(
    model="mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    messages=[
        {"role": "system", "content": "You are a senior systems engineer."},
        {"role": "user", "content": "Explain POSIX compliance simply."}
    ],
    temperature=0.3,
    max_tokens=600,
    stream=True # Streaming support handled out-of-the-box
)

for chunk in response:
    if chunk.choices[0].delta.content:
         print(chunk.choices[0].delta.content, end="")
```

---

## Quantization Architecture Map

Lumina Edge defaults to utilizing **Q4_K_M** quantizations for a mathematically balanced memory-to-quality ratio. 

| Metric | Bits | Scaling Factor vs FP16 | Aesthetic / Perplexity Risk | Target Hardware |
|---|---|---|---|---|
| Q8_0 | 8-bit | ~100% | Negligible | 16 GB+ RAM / Server |
| Q6_K | 6-bit | ~75% | Very Low | 12 GB+ RAM |
| Q5_K_M | 5-bit | ~65% | Low | 10 GB+ RAM |
| **Q4_K_M** | **4-bit** | **~50%** | **Acceptable (Recommended)** | **Standard Deployments** |
| Q3_K_M | 3-bit | ~40% | Noticeable Hallucination | Legacy Devices |

---

## Troubleshooting Map

<details>
<summary><strong>Missing or Unrecognized llama-cli / llama-server Executables</strong></summary>

Verify the extracted `llama.cpp` archive is not trapped in an unnecessary subfolder. The physical `<project>/bin/` directory must contain the binary files immediately alongside the `.dll` or `.so` extensions. Ensure Linux users grant `$ chmod +x` execution permission.
</details>

<details>
<summary><strong>Model Listing is Empty</strong></summary>

The interface parses `<project>/models/*.gguf` dynamically using regex-style detection frameworks. Check that the Huggingface repository provides standardized `.gguf` architecture outputs, not raw Tensor / Safetensor formats.
</details>

<details>
<summary><strong>Out of Memory (OOM) Allocation Crashes</strong></summary>

Even with Lumina Edge memory optimizations, verify the selected `.gguf` weight format conforms to your system capacity. **Calculated Rule of Thumb:** Quant file size in GB + 2 GB overhead must be entirely less than Total System RAM.
</details>

<details>
<summary><strong>HTTP Port 1234 Contention (API Only)</strong></summary>

API Controller scripts dynamically scan `netstat -ano` (Windows) or `ss -tlnp` (Linux) to check port locks before initializing. 
If an existing zombie process crashed into the port:
- **Windows:** `taskkill /PID <PID_ID> /F`
- **Linux:** `sudo kill -9 <PID_ID>`
</details>

---

## Roadmap

- [x] Full Linux (Ubuntu/Debian) native kernel optimization port
- [ ] `config.json` serialization for hyperparameter state manipulation 
- [ ] Experimental Electron / React.js Web UI wrapper
- [ ] Implementation of `macOS / Darwin` logic bridging optimization protocols
- [ ] Support for direct HuggingFace multi-file sharding configurations.

---

## Technical Acknowledgements

- **[llama.cpp (Georgi Gerganov)](https://github.com/ggml-org/llama.cpp)** — The fundamental C/C++ inference backbone architecture.
- **[HuggingFace / TheBloke](https://huggingface.co/TheBloke)** — Foundational automated GGUF quantization datasets.
- **[NVIDIA CUDA Toolkit](https://developer.nvidia.com/cuda-toolkit)** — Neural weight acceleration pathways.

---

## License

MIT License — see [LICENSE](LICENSE) for full structural text.

<div align="center">

Engineered & Maintained by [Parth-debug-cse](https://github.com/Parth-debug-cse)

</div>
