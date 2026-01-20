# 🌟 Lumina Edge
Lumina Edge is a lightweight execution framework designed to make **local Large Language Model (LLM) inference practical on low-RAM, consumer-grade hardware**.  
It reduces failure points and keeps the system approachable for users with limited hardware and experience.

The objective is simple:

> **Run local LLMs as efficiently and reliably as possible.**

---

## 🖼️ Lumina Edge in Action

Below is a real execution of Lumina Edge running a quantized LLM on constrained hardware  
(**8GB RAM · Intel UHD 620 · Vulkan backend**):

![Lumina Edge in Action](assets/screenshot.png)

---

## ⚙️ System Requirements

### Software
- **Administrator privileges**
#### Installing llama.cpp (Integrated GPU)
Paste these commands into Windows Terminal:
```powershell
cd C:\Lumina-Edge\bin
winget install llama.cpp
```

#### Installing llama.cpp (Nvidia GPU)
Paste these commands into Windows Terminal:
```powershell
cd C:\Lumina-Edge\bin
winget install llama.cpp --override "/DCMAKE_CUDA=ON"
```
> ⚠️ The core controller must be run **as Administrator** to allow temporary system optimization.

---
### Hardware

#### Integrated Graphics (Default)
- **RAM**
  - Minimum: 4GB  
  - Recommended: 8GB+
- **GPU**
  - Integrated GPU with **Vulkan 1.2+**
  - Intel UHD / Iris or AMD Radeon iGPU
- **Storage**
  - SSD strongly recommended

#### NVIDIA GPU (CUDA Variant)
- **RAM**
  - 8GB+ recommended
- **GPU**
  - NVIDIA GPU with CUDA support
- **Drivers**
  - Latest NVIDIA drivers installed
- **CUDA**
  - Automatically handled by llama.cpp CUDA builds

---

## 📂 Project Layout
```text
C:\Lumina-Edge
├─ bin\        → llama.cpp binaries
├─ core\       → main controller (lumina-core.bat)
├─ scripts\    → system optimization (PowerShell)
├─ models\     → GGUF model (named "one")
├─ assets\     → screenshots and visuals
```
> The framework assumes the project is located at: **`C:\Lumina-Edge\`**
---

## 🧠 System Optimization (Important)

Before initializing the model, Lumina Edge performs a **temporary system optimization step**.

### What this does
- Frees unused RAM
- Reduces background service pressure
- Prepares memory for inference workloads

### What this does NOT do
- ❌ No permanent system changes  
- ❌ No registry edits  
- ❌ No services installed or removed  

The optimization script is located at: `C:\Lumina-Edge\scripts`

## 🤖 Model Setup (Critical)
### Instructions:
1. Download any GGUF model  
2. Place it inside the `models` directory  
3. Rename the file to: `one.gguf`

The controller automatically detects and loads any file named one.*.

## 🚀 Running Lumina Edge
### Run from Desktop
Copy lumina-core.bat to the Desktop (Recommended), or Create a shortcut to it
The script uses absolute paths, so it will work correctly from any location.
#### Always run as Administrator.

## 📈 Reference Performance  
*(8GB RAM · Intel UHD 620 · Vulkan)*

| Model Size | Quantization | Tokens / Second |
|-----------|--------------|-----------------|
| 1B        | Q8_0         | ~15 t/s         |
| 1.5B      | Q6_K         | ~9 t/s          |
| 7B        | Q4_K_M       | ~3–4 t/s        |


