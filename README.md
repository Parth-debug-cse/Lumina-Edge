# 🌟 Lumina Edge
> **Architecting High-Performance LLM Inference for Memory-Constrained Edge Systems.**

Lumina Edge is a specialized optimization framework designed to facilitate Large Language Model (LLM) execution on consumer-grade hardware. By focusing on **Consumer-Level Systems**, this project implements aggressive resource reclamation and hardware-level compute abstraction to enable stable, high-performance local AI.

---

## 📋 Prerequisites & Environment
Before deploying the Lumina Edge framework, ensure the host system meets the following requirements:

### Software Requirements
* **llama.cpp**: The core inference engine. (See the [Setup Guide](#-implementation-guide) below).
* **Vulkan SDK/Runtime**: Essential for offloading tensor operations to integrated graphics units (iGPU).
* **C++ Redistributables**: Required for the stable execution of the inference binaries.
* **PowerShell 5.1+**: Required for executing the system-level optimization scripts.

### Hardware Requirements
* **Memory**: Minimum 4GB Physical RAM (8GB recommended for 3B+ parameter models).
* **GPU**: Integrated Graphics (Intel UHD/Iris or AMD Radeon) with Vulkan 1.2+ support.
* **Storage**: High-speed SSD (Critical to minimize model loading latency and paging file bottlenecks).

---

## 🚀 Technical Architecture
The framework addresses the primary bottleneck of local inference through a three-tiered engineering approach:

### 1. Kernel-Level Resource Reclamation
This module targets **Non-Critical System Services** and **Telemetry Overhead**. By programmatically suspending high-impact background processes (e.g., redundant Microsoft background services and OEM Telemetry), we minimize the OS memory footprint, ensuring maximum heap availability.

### 2. Vulkan-Based Compute Abstraction
Lumina Edge utilizes the **Vulkan RPC Backend** to interface with iGPUs. By configuring a minimal **UMA Frame Buffer (32MB)** in the BIOS, we allow the driver to utilize Shared System Memory dynamically, preventing static VRAM allocation from starving the CPU.

### 3. Heuristic Context Management
The controller implements a dynamic scaling algorithm for the **Key-Value (KV) Cache**. It evaluates the available system commit charge in real-time to adjust the `--ctx-size` parameter, mitigating Out-Of-Memory (OOM) exceptions.

---

## 📂 Repository Structure
- **`/bin`**: Target directory for `llama.cpp` binaries.
- **`/core`**: Execution logic and automated batch controllers (`lumina-core.bat`).
- **`/docs`**: Technical specifications for **UMA** and **System Optimization**.
- **`/scripts`**: PowerShell automation for system state optimization.
- **`/models`**: Target directory for `.gguf` quantized model files.

---

## 🛡️ Implementation Guide

### 1. Hardware Pre-flight (BIOS)
Access your System BIOS (usually F2/Del at boot) and set the **Pre-allocated Video Memory (UMA)** to **32MB**. This ensures the OS manages the RAM pool rather than hardware-locking it.

### 2. Installing the Inference Engine (llama.cpp)
To install the latest Vulkan-optimized engine into the `/bin` folder:
1. Go to the [Official llama.cpp Releases](https://github.com/ggml-org/llama.cpp/releases).
2. Download the zip file named: `llama-bXXXX-bin-win-vulkan-x64.zip` (where XXXX is the latest version).
3. Extract the contents of the zip file directly into the **`/bin`** folder of this repository. 
   * *Note: Ensure `llama-cli.exe` is sitting inside `/bin`, not a sub-folder.*

### 3. System State Optimization
Run the optimization script as Administrator to reclaim system resources:
```powershell
# Navigate to scripts and run as Administrator
.\scripts\optimize_system.ps1
```

### 4.Initialization
Place your .gguf models in the /models directory, then launch the controller at: .\core\lumina-core.bat

## 📈 Performance Benchmarks (8GB RAM / Intel UHD 620)

| Architecture | Parameter Count | Quantization | Status | Tokens Per Second |
| :--- | :--- | :--- | :--- | :--- |
| **Llama-3.2** | 1B | Q8_0 | ⚡ Ultra-Fast | ~15 t/s |
| **Qwen-2.5** | 1.5B | Q6_K | 🟢 Balanced | ~9 t/s |
| **Mistral-v0.3** | 7B | Q4_K_M | 🟡 Optimized | ~3.8 t/s |
---