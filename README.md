# 🌟 Lumina Edge
> **Architecting High-Performance LLM Inference for Memory-Constrained Edge Systems.**

Lumina Edge is a specialized optimization framework designed to facilitate Large Language Model (LLM) execution on consumer-grade hardware. By focusing on **Consumer-Level Systems**, this project implements aggressive resource reclamation and hardware-level compute abstraction to enable stable, high-performance local AI.

---

## 🖼️ Framework in Action
Below is a demonstration of the Lumina Edge framework managing high-parameter model inference on constrained hardware (8GB RAM / Intel UHD 620):

![Lumina Edge in Action](assets/screenshot.png)

---

## 📋 Prerequisites & Environment
Before deploying the Lumina Edge framework, ensure the host system meets the following requirements:

### Software Requirements
* **llama.cpp**: The core inference engine.
* **Vulkan SDK/Runtime**: Essential for offloading tensor operations to integrated graphics units (iGPU).
* **C++ Redistributables**: Required for stable execution of inference binaries.
* **PowerShell 5.1+**: Required for executing system-level optimization scripts.
* Run the .bat file in admin mode for cleaning up the background processes allowing the model to run efficiently

### Hardware Requirements
* **Memory**: Minimum 4GB Physical RAM (8GB recommended for 3B+ parameter models).
* **GPU**: Integrated Graphics (Intel UHD/Iris or AMD Radeon) with Vulkan 1.2+ support.
* **Storage**: High-speed SSD (Critical to minimize model loading latency).

---

## 🚀 Technical Architecture
The framework utilizes a **Tri-Model Execution Logic** within the `lumina-core.bat` controller, mapping specific LLM architectures to specialized task modes:

### 📡 Multi-Mode Model Mapping
| Mode | Model Profile | Target Architecture | Primary Use Case |
| :--- | :--- | :--- | :--- |
| **[T-MODE]** | **Mistral 7B** | `mistral-v0.3-7b.Q4_K_M.gguf` | Advanced Theory & Stress Testing |
| **[B-MODE]** | **Qwen 1.5B** | `qwen-2.5-1.5b.Q6_K.gguf` | Technical Tasks & Coding |
| **[R-MODE]** | **Llama 1B** | `llama-3.2-1b.Q8_0.gguf` | Data-Link (RAG) with `notes.txt` |

### Optimization Pillars
1. **Kernel-Level Reclamation**: Programmatically suspends non-critical OS services to maximize heap availability.
2. **Vulkan Abstraction**: Uses a minimal **UMA Frame Buffer (32MB)** to allow dynamic shared memory scaling via the iGPU driver.
3. **Heuristic Context Management**: Dynamically scales KV Cache based on real-time system commit charge.

---

## 📂 Repository Structure
- **`/bin`**: Target directory for `llama.cpp` binaries.
- **`/core`**: Execution logic and automated batch controllers (`lumina-core.bat`).
- **`/docs`**: Technical specifications for UMA and System Optimization.
- **`/scripts`**: PowerShell automation for system state optimization.
- **`/models`**: Target directory for `.gguf` quantized model files and `notes.txt`.

---

## 🛡️ Implementation Guide

### 1. Hardware Pre-flight (BIOS)
Access your System BIOS and set the **Pre-allocated Video Memory (UMA)** to **32MB**. This ensures the OS manages the RAM pool rather than hardware-locking it.

### 2. Installing the Inference Engine
1. Download the latest **Vulkan-win-x64** binaries from the official `llama.cpp` releases.
2. Extract the contents directly into the **`/bin`** folder.

### 3. Model Setup & Naming (CRITICAL)
To ensure the Core Controller links correctly, download and rename your models as follows:
* **Mistral 7B** ➔ `mistral-v0.3-7b.Q4_K_M.gguf`
* **Qwen 1.5B** ➔ `qwen-2.5-1.5b.Q6_K.gguf`
* **Llama 1B** ➔ `llama-3.2-1b.Q8_0.gguf`
* *Place all files in the **`/models`** directory.*

### 4. Initialization
```powershell
# 1. Run System Optimization (As Administrator)
.\scripts\optimize_system.ps1

# 2. Launch Core Framework
.\core\lumina-core.bat
```
## 📈 Performance Benchmarks (8GB RAM / Intel UHD 620)

| Architecture | Parameter Count | Quantization | Tokens Per Second |
| :--- | :--- | :--- | :--- |
| **Llama-3.2** | 1B | Q8_0 | ~15 t/s |
| **Qwen-2.5** | 1.5B | Q6_K | ~9 t/s |
| **Mistral-v0.3** | 7B | Q4_K_M | ~3.8 t/s |