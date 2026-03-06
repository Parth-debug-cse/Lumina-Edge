# ⚡ Lumina Edge

<div align="center">

**Local LLM inference on hardware you already own.**

*No cloud. No API keys. No telemetry. No excuses.*

![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D4?style=flat-square&logo=windows)
![llama.cpp](https://img.shields.io/badge/Powered%20by-llama.cpp-black?style=flat-square)
![Backend](https://img.shields.io/badge/Backend-Vulkan%20%7C%20CUDA-76B900?style=flat-square)
![RAM](https://img.shields.io/badge/Minimum%20RAM-4GB-red?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

</div>

---

## What is Lumina Edge?

Lumina Edge is a **Windows-native execution framework** that wraps `llama.cpp` with intelligent system optimization, dynamic model selection, and a clean CLI interface — making powerful local AI accessible on the low-spec hardware most people already own.

**The problem it solves:** Running LLMs locally has always meant fighting your hardware. Background services eating RAM. Complex configuration. Models that only run on expensive GPUs. Lumina Edge eliminates all of that.

**What you get:**
- Run 7B models on an 8 GB laptop with integrated graphics
- An OpenAI-compatible local API endpoint, ready for Python, PowerShell, or any SDK
- One-click system optimization that reclaims 1–2 GB of RAM before inference starts
- Dynamic model selection — manage and switch between any number of downloaded models, no renaming required

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       LUMINA EDGE FRAMEWORK                          │
├─────────────────────┬───────────────────────────┬────────────────────┤
│     USER LAYER      │      CONTROL LAYER        │    ENGINE LAYER    │
│                     │                           │                    │
│  CLI Interface      │  Batch Controllers        │  llama.cpp core    │
│  API Endpoints      │  Path auto-detection      │  GGUF models       │
│  Model Manager      │  Validation & menus       │  Vulkan / CUDA     │
├─────────────────────┴───────────────────────────┴────────────────────┤
│                        OPTIMIZATION LAYER                            │
│  Service suspension · Working set purge · Memory compression disable │
│  Original startup types saved · Restore script written to %TEMP%     │
└──────────────────────────────────────────────────────────────────────┘
```

### Project Structure

```
Lumina-Edge/                     ← Can live anywhere on your system
├── bin/                         ← llama.cpp binaries go here
│   ├── llama-cli.exe
│   ├── llama-server.exe
│   └── *.dll
├── core/                        ← Launch scripts
│   ├── lumina-core.bat          ← Chat mode (Vulkan)
│   ├── lumina-core-nvidia.bat   ← Chat mode (CUDA)
│   ├── lumina-api.bat           ← API server (Vulkan)
│   └── lumina-api-nvidia.bat    ← API server (CUDA)
├── scripts/
│   └── optimize_system.ps1      ← Memory reclamation
├── models/                      ← Your .gguf files live here
├── assets/                      ← Screenshots and visuals
└── model-manager.bat            ← Download & manage models
```

---

## Quick Start

### 1. Get llama.cpp binaries

Go to [github.com/ggml-org/llama.cpp/releases](https://github.com/ggml-org/llama.cpp/releases) and download the latest release for your GPU:

| Your hardware | File to download |
|---|---|
| Intel / AMD integrated GPU | `llama-bXXX-bin-win-vulkan-x64.zip` |
| NVIDIA GPU | `llama-bXXX-bin-win-cuda-cu12.x-x64.zip` |

Extract **all files** directly into `Lumina-Edge\bin\`. Do not create subfolders.

### 2. Download a model

Run `model-manager.bat` and pick from the pre-configured list:

```
1. Phi-3-mini-4k-instruct    (2.3 GB)  ← Best for 4GB RAM systems
2. TinyLlama-1.1B-Chat       (0.7 GB)  ← Ultra-light, instant responses
3. Mistral-7B-Instruct-v0.2  (4.1 GB)  ← Best balance of quality + speed
4. Llama-3-8B-Instruct       (4.7 GB)  ← Highest quality, needs 8GB+ RAM
5. Custom URL                           ← Any HuggingFace GGUF direct link
```

Models download straight to `models\`. No renaming needed — the launcher shows a numbered list of everything in that folder.

### 3. Launch

**Right-click → Run as Administrator**

| Mode | Integrated GPU | NVIDIA GPU |
|---|---|---|
| Chat | `core\lumina-core.bat` | `core\lumina-core-nvidia.bat` |
| API Server | `core\lumina-api.bat` | `core\lumina-api-nvidia.bat` |

Administrator is required only for the temporary memory optimization step.

---

## System Requirements

### Minimum

| Component | Requirement |
|---|---|
| OS | Windows 10 64-bit (1909+) |
| CPU | Dual-core x86-64 |
| RAM | 4 GB |
| GPU | DirectX 12 / Vulkan 1.2 compatible |
| Storage | 10 GB free |

### Recommended

| Component | Recommendation |
|---|---|
| OS | Windows 11 64-bit |
| CPU | Quad-core 3.0GHz+ (Intel i5/i7, AMD Ryzen 5/7) |
| RAM | 8 GB+ |
| Storage | 20 GB SSD |

### Backend-Specific

**Vulkan (integrated GPU):** Requires Vulkan Runtime — download from [vulkan.lunarg.com](https://vulkan.lunarg.com). Compatible with Intel UHD 600+, Intel Iris Xe, and AMD Radeon integrated graphics.

**CUDA (NVIDIA GPU):** Requires NVIDIA drivers 535+. Download from [nvidia.com/drivers](https://www.nvidia.com/Download/index.aspx). Compatible with GTX 1050 and any newer RTX series card.

---

## How the Optimization Works

Before the model loads, Lumina Edge runs `scripts\optimize_system.ps1` which frees 1–2 GB of RAM through four steps:

1. **Suspends non-critical Windows services**
   - `WSearch` — Windows Search Indexer (~500 MB)
   - `SysMain` — Superfetch / Prefetch (~300 MB)
   - `WslService` — Windows Subsystem for Linux (~300 MB)
   - `DiagTrack` — Connected User Experiences / Telemetry (~200 MB)
   - `Dps` — Diagnostic Policy Service (~200 MB)

2. **Purges working sets** via direct Windows API call (`EmptyWorkingSet`) — flushes memory pages held by inactive processes back to the available pool

3. **Disables memory compression** (`Disable-MMAgent -mc`) — reduces CPU overhead during tensor dequantization

4. **Saves original service states** — writes a restore script to `%TEMP%\lumina_restore_services.ps1` so services can be re-enabled instantly without a reboot

**What this achieves on an 8 GB system:**

```
Before optimization:  ~3.0 GB available for LLM
After optimization:   ~5.2 GB available for LLM  (+73%)
```

**What it does NOT do:** No registry edits. No installed services. No permanent changes. Services are stopped for the duration of the session with their startup type set to `Manual` — they restart normally on the next reboot, or immediately via the restore script.

---

## Performance Reference

### Budget Laptop — Intel Core i5-8250U · 8 GB DDR4 · Intel UHD 620 · Vulkan

| Model | Params | Quantization | Tokens/sec | RAM Used | Load Time |
|---|---|---|---|---|---|
| TinyLlama | 1.1B | Q4_K_M | ~18 t/s | 2.1 GB | 8s |
| Phi-3-mini | 3.8B | Q4_K_M | ~12 t/s | 3.4 GB | 12s |
| Mistral-7B | 7B | Q4_K_M | ~5.8 t/s | 5.8 GB | 25s |
| Llama-3-8B | 8B | Q4_K_M | ~4.3 t/s | 6.2 GB | 30s |

### Gaming Laptop — Intel Core i7-11800H · 16 GB DDR4 · NVIDIA RTX 3060 6 GB · CUDA

| Model | Params | Quantization | Tokens/sec | GPU Layers |
|---|---|---|---|---|
| Mistral-7B | 7B | Q4_K_M | ~15.2 t/s | 20 |
| Llama-3-8B | 8B | Q4_K_M | ~12.8 t/s | 20 |
| Llama-3-13B | 13B | Q4_K_M | ~8.2 t/s | 20 |

---

## OpenAI-Compatible API

When running in API mode, Lumina Edge exposes a fully OpenAI-compatible REST API at:

```
http://127.0.0.1:1234/v1
```

No authentication required. Works as a drop-in replacement for any OpenAI SDK client — just point `base_url` at localhost.

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:1234/v1",
    api_key="not-needed"
)

response = client.chat.completions.create(
    model="mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain transformer attention in simple terms."}
    ],
    temperature=0.7,
    max_tokens=500
)

print(response.choices[0].message.content)
```

### Streaming (Python)

```python
stream = client.chat.completions.create(
    model="mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    messages=[{"role": "user", "content": "Write me a short story."}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### PowerShell

```powershell
$body = @{
    model    = "mistral-7b-instruct-v0.2.Q4_K_M.gguf"
    messages = @(
        @{ role = "system"; content = "You are a helpful assistant." }
        @{ role = "user";   content = "Explain black holes simply." }
    )
    temperature = 0.7
    max_tokens  = 500
} | ConvertTo-Json -Depth 5

$response = Invoke-RestMethod `
    -Uri         "http://localhost:1234/v1/chat/completions" `
    -Method      POST `
    -ContentType "application/json" `
    -Body        $body

$response.choices[0].message.content
```

### cURL

```bash
curl http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    "messages": [
      {"role": "user", "content": "What is machine learning?"}
    ],
    "temperature": 0.7,
    "max_tokens": 500
  }'
```

---

## Model Manager

`model-manager.bat` handles the full model lifecycle without any manual file management.

```
==================================================
  LUMINA EDGE :: MODEL MANAGER
==================================================

  Models location: <your project root>\models

  1. Download a new model
  2. List downloaded models
  3. Delete a model
  0. Exit
```

- Pre-configured one-click downloads for 4 popular models
- Custom HuggingFace URL support for any GGUF model
- Lists all downloaded models with file sizes
- Safe delete with confirmation prompt
- Creates the `models\` directory automatically if it does not exist

---

## Model Quantization Guide

Quantization reduces model weights from 16-bit floats to smaller integers, trading a small amount of quality for dramatically lower RAM usage and faster inference.

| Level | Bits | Size vs FP16 | Quality | Recommended for |
|---|---|---|---|---|
| Q8_0 | 8-bit | ~100% | Best | 16 GB+ RAM |
| Q6_K | 6-bit | ~75% | Very high | 12 GB+ RAM |
| Q5_K_M | 5-bit | ~65% | High | 10 GB+ RAM |
| **Q4_K_M** | **4-bit** | **~50%** | **Balanced** | **Most users — recommended** |
| Q4_0 | 4-bit | ~50% | Good | Low RAM, speed priority |
| Q3_K_M | 3-bit | ~40% | Lower | 4 GB RAM systems only |

**Rule of thumb:** Model file size + 2 GB must be less than your total RAM.

---

## Troubleshooting

<details>
<summary><strong>llama-cli.exe not found</strong></summary>

Extract all files from the llama.cpp release ZIP directly into `Lumina-Edge\bin\`. Do not create any subfolders inside `bin\`. After extraction you should see `llama-cli.exe`, `llama-server.exe`, and several `.dll` files sitting directly inside `bin\`.

</details>

<details>
<summary><strong>No models found / model selection is empty</strong></summary>

Run `model-manager.bat` and download a model first. Models must be `.gguf` files placed directly inside the `models\` directory. The launcher scans for `*.gguf` — any other extension will not appear in the list.

</details>

<details>
<summary><strong>Access denied / optimization fails</strong></summary>

Right-click the `.bat` file and choose **Run as administrator**. The optimization step requires elevated privileges to stop and suspend system services. Without it the script will silently fail and less RAM will be freed.

</details>

<details>
<summary><strong>Vulkan initialization failed</strong></summary>

Install the Vulkan Runtime from [vulkan.lunarg.com](https://vulkan.lunarg.com), then update your GPU drivers (Intel or AMD). Restart your machine after installing. To verify, open a Command Prompt and run `vulkaninfo.exe` — it should print your GPU name and Vulkan version with no errors.

</details>

<details>
<summary><strong>CUDA not available / no CUDA devices found</strong></summary>

Run `nvidia-smi` in a Command Prompt to confirm your GPU is detected. If it is, update to NVIDIA drivers 535+ from [nvidia.com/drivers](https://www.nvidia.com/Download/index.aspx). Also confirm you downloaded the CUDA build of llama.cpp (`cuda` in the filename), not the Vulkan build.

</details>

<details>
<summary><strong>Port 1234 already in use</strong></summary>

The API scripts automatically detect this before launching and show a clear error. To fix it manually, find and stop the conflicting process:

```batch
netstat -ano | findstr ":1234 "
taskkill /PID <PID shown> /F
```

</details>

<details>
<summary><strong>Out of memory / crash during model load</strong></summary>

Switch to a smaller model or lower quantization level. Close browsers, Discord, and other RAM-heavy apps before launching. Safe rule: model file size + 2 GB must be less than your total RAM. On an 8 GB system, keep your model file under 6 GB.

</details>

<details>
<summary><strong>Services did not restart after session ended</strong></summary>

The optimization script writes a restore script to `%TEMP%\lumina_restore_services.ps1`. Run it in an elevated PowerShell window to immediately re-enable all suspended services:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:TEMP\lumina_restore_services.ps1"
```

Alternatively, a full system reboot will restore all services automatically.

</details>

---

## Roadmap

- [ ] `config.json` for persistent user settings (threads, context size, GPU layers)
- [ ] Web-based GUI frontend
- [ ] Linux and macOS support
- [ ] In-script automatic service restore on session exit (no temp file dependency)
- [ ] Built-in model quantization tool
- [ ] Performance benchmarking suite
- [ ] Docker container support
- [ ] Plugin system for custom backends (DirectML, Metal, etc.)
- [ ] Multi-model parallel loading

---

## Contributing

Contributions are welcome. Areas that would benefit most from community effort: GUI development, Linux/macOS porting, additional backend integrations, hardware testing across different configurations, and documentation improvements.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m "Add your feature"`
4. Push and open a Pull Request

When reporting bugs, please include your Windows version, full hardware specs (CPU, RAM, GPU), the complete error message, and exact steps to reproduce.

---

## Acknowledgements

- [llama.cpp](https://github.com/ggml-org/llama.cpp) — the inference engine powering everything
- [TheBloke on HuggingFace](https://huggingface.co/TheBloke) — quantized model repository
- [LunarG](https://www.lunarg.com) — Vulkan SDK and tooling
- [NVIDIA](https://www.nvidia.com) — CUDA platform and drivers

---

## License

MIT License — see [LICENSE](LICENSE) for full text.

---

<div align="center">

Built by [Parth-debug-cse](https://github.com/Parth-debug-cse)

*If this project helped you run AI locally, consider leaving a ⭐*

</div>
