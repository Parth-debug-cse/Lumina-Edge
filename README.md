<div align="center">

# ⚡ Lumina Edge

### Run powerful AI models locally, on hardware you already own.

[![MLX](https://img.shields.io/badge/Apple_MLX-Native-000000?style=flat-square&logo=apple&logoColor=white)](https://github.com/Parth-debug-cse/Lumina-Edge)
[![Vulkan](https://img.shields.io/badge/Vulkan-Supported-AC162C?style=flat-square&logo=vulkan&logoColor=white)](https://github.com/Parth-debug-cse/Lumina-Edge)
[![CUDA](https://img.shields.io/badge/CUDA-535%2B-76B900?style=flat-square&logo=nvidia&logoColor=white)](https://github.com/Parth-debug-cse/Lumina-Edge)
<br/>

**[Quick Start](#-quick-start) · [API Docs](#-openai-compatible-api) · [Benchmarks](#-benchmarks) · [Roadmap](#-roadmap) · [Contributing](#-contributing)**

</div>

---

## The Problem with Local AI Today

You have a normal laptop. You want to run a local LLM — for privacy, offline access, zero API cost. The hardware is capable. The models exist. The tooling is the problem.

**Lumina Edge is built for that user.** It uses `llama.cpp` — the fastest open-source inference engine available — with OS-level memory reclamation that frees 1–2 GB before inference begins. The result is a fully operational local LLM with an OpenAI-compatible API endpoint, ready to drop into any existing codebase without touching a single credit.


## Architecture

![Architecture diagram](assets/lumina_edge_architecture.svg)

---

## Quick Start

### Step 1 — Get the llama.cpp binaries

Download the latest release from [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/releases/latest) and extract **all files directly** into `Lumina-Edge/bin/`. Do not create subfolders.

> **Mac users:** Skip this step entirely — see Step 1B below.

| OS | GPU | File to download |
|----|-----|-----------------|
| Windows | Intel / AMD (integrated) | `llama-bXXX-bin-win-vulkan-x64.zip` |
| Windows | NVIDIA | `llama-bXXX-bin-win-cuda-cu12.x-x64.zip` |
| Linux | Intel / AMD (integrated) | `llama-bXXX-bin-ubuntu-vulkan-x64.tar.gz` |
| Linux | NVIDIA | `llama-bXXX-bin-ubuntu-x64-cuda.tar.gz` |

> **Linux:** After extracting, make scripts executable:
> ```bash
> chmod +x core/*.sh
> ```

### Step 1B — Mac (Apple Silicon) Setup

Apple silicon chips use **Unified Memory**,Lumina Edge favors Apple's **MLX Framework**.

```bash
pip install -r scripts/requirements-macos.txt
```

### Step 2 — Launch the Desktop UI

```bash
cd ui
npm install
npm start
```

This opens the desktop app. From here you can download models, configure hardware backends, and chat — no terminal needed.

> Advanced users: script-based launching is available in `core/` if preferred.

---

## Why Lumina Edge

| | LM Studio | Ollama | **Lumina Edge** |
|---|---|---|---|
| Baseline RAM | **400–700 MB** (Electron GUI) | **200–400 MB** (persistent daemon) | **~0 MB** (no background process) |
| Background Services | ✅ Yes — always running | ✅ Yes — always running | ❌ No — launches only on demand |
| Available RAM (8 GB) | ~3.0 GB | ~3.2 GB | **~5.2 GB (+73%)** |
| Pre-inference Flush | ❌ No | ❌ No | **✅ Yes — 1–2 GB freed automatically** |
| Quantization Control | Limited | Limited | **Full — any GGUF, any Q-level** |
| Tokens/sec | Baseline | −5 to −12% vs baseline | **+37% to +23% respectively** |

*Tokens/sec measured on Intel Core i5-8250U · 8 GB DDR4 · Deepseek 7b Q4\_K\_M.*

---

## Supported Model Formats

| Format | Performance | Notes |
|--------|-------------|-------|
| MLX `.mlx` | Fastest on Mac | Native — Mac only |
| GGUF `.gguf` | Fastest on Win/Lin | Native — recommended for Windows/Linux |
| SafeTensor `.safetensors` | Equal | Auto-converts to GGUF on Win/Lin; Mac reads directly |
| FP16 `.bin` `.pt` | Equal | Auto-converts to GGUF |


### HuggingFace Sharded Models

> Think of sharded models like a large file split into multiple ZIP volumes for easier downloading — just pieces of the same puzzle.

Lumina Edge automatically detects all shards in a folder (e.g., `model-00001-of-00003.safetensors`) and reassembles them into a single optimized GGUF. No manual merging or configuration required.

---

## Memory Optimization

![Memory optimization flowchart](assets/lumina_edge_optimization_flow.svg)

---

## Quantization Guide

Think of quantization like image compression — a JPEG takes up less space than a RAW file with barely noticeable quality loss at the right setting. Quantization does the same to AI models: smaller file, less RAM, nearly identical output. Q4\_K\_M is the sweet spot.

![Quantization spectrum](assets/lumina_edge_quantization.svg)


---

## OpenAI-Compatible API

Lumina Edge's API mode solves a critical problem for developers: **you should not have to rewrite application code to switch between a cloud model and a local one.**

When you launch an API server, Lumina Edge exposes a REST endpoint at `http://127.0.0.1:8080/v1` that speaks the exact same protocol as OpenAI's API. A secondary management-only port is available at `http://127.0.0.1:8081`. Any application already integrated with the OpenAI Python SDK, Node.js SDK, or any HTTP client can be redirected to a local model by changing a single line — the `base_url`.

Three immediate benefits:

- **Development without cost.** Use a local model during development and testing. Swap to cloud for production with zero code changes.
- **Privacy-sensitive workloads.** Route confidential data — internal documents, medical records, proprietary codebases — through a local model that never touches the network.
- **Offline and air-gapped environments.** Deploy in environments without internet access. No conditional logic, no fallback paths — just a different `base_url`.

No authentication required for local connections. The endpoint accepts standard `chat/completions` requests with `model`, `messages`, `temperature`, `max_tokens`, and `stream` parameters.

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="not-needed"  # Required by SDK but unused locally
)

response = client.chat.completions.create(
    model="mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    messages=[
        {"role": "system", "content": "You are a senior systems engineer."},
        {"role": "user", "content": "Explain POSIX compliance simply."}
    ],
    temperature=0.3,
    max_tokens=600
)
print(response.choices[0].message.content)
```

Swap `base_url` and `model` to move between local and cloud inference. Everything else stays the same.

### Streaming

```python
stream = client.chat.completions.create(
    model="mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    messages=[{"role": "user", "content": "Write a shell script to monitor disk usage."}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### Node.js

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8080/v1",
  apiKey: "not-needed"
});

const response = await client.chat.completions.create({
  model: "mistral-7b-instruct-v0.2.Q4_K_M.gguf",
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Explain the difference between TCP and UDP." }
  ],
  temperature: 0.3,
  max_tokens: 500
});

console.log(response.choices[0].message.content);
```

### PowerShell

```powershell
$body = @{
    model    = "mistral-7b-instruct-v0.2.Q4_K_M.gguf"
    messages = @(
        @{ role = "system"; content = "You are a helpful assistant." }
        @{ role = "user";   content = "Explain what a race condition is." }
    )
    temperature = 0.3
    max_tokens  = 500
} | ConvertTo-Json -Depth 5

$r = Invoke-RestMethod -Uri "http://localhost:8080/v1/chat/completions" `
     -Method POST -ContentType "application/json" -Body $body

$r.choices[0].message.content
```

### cURL

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    "messages": [{"role": "user", "content": "What is a mutex?"}],
    "temperature": 0.3,
    "max_tokens": 400
  }'
```

---

## Multi-Model Parallel Loading & Routing

Load and run **multiple models in parallel**, with intelligent request routing between them. Useful for load balancing, A/B testing, or running specialized models per task type.

### Routing Policies

| Policy | Behavior | Best For |
|--------|----------|----------|
| **Round-Robin** | Distributes requests evenly across all models | Load balancing, testing consistency |
| **Load-Balanced** | Routes to model with lowest inference count | Optimal throughput with mixed model sizes |
| **First-Available** | Uses fastest ready model | Maximizing speed for simple queries |

### Programmatic Usage

```python
import requests
import subprocess

subprocess.Popen([
    'python', 'scripts/model-router.py', 'load',
    'models/mistral-7b.gguf',
    'models/tinyllama-1.1b.gguf',
    '--bin-path', 'bin',
    '--scripts', 'scripts',
    '--models-dir', 'models'
])

# Query Model 1
response = requests.post(
    'http://127.0.0.1:8000/v1/chat/completions',
    json={'model': 'local', 'messages': [{'role': 'user', 'content': 'Hello!'}], 'stream': False}
)

# Query Model 2
response2 = requests.post('http://127.0.0.1:8001/v1/chat/completions', json=...)
```

---

## Management API Reference

All endpoints available on **port 8080** (inference + management) and **port 8081** (management only).

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server health check |
| `/api/system-info` | GET | Platform, arch, Apple Silicon detection |
| `/api/system/resources` | GET | CPU, RAM, iGPU/GPU, VRAM, model processes |
| `/api/system/optimize` | POST | Run system memory optimization |
| `/api/config` | GET | Current configuration |
| `/api/save-config` | POST | Update configuration |
| `/api/models/list` | GET | List available models |
| `/api/models/convertible` | GET | List convertible model files |
| `/api/router/status` | GET | Router status + all loaded models |
| `/api/router/models` | GET | Loaded model details |
| `/api/router/routes` | GET | Ready model endpoints |
| `/api/router/load` | POST | Load a model into the router |
| `/api/router/unload/:id` | DELETE | Unload a model (SIGTERM→SIGKILL escalation) |
| `/api/router/unload-all` | DELETE | Unload all models |
| `/api/router/policy` | POST | Set routing policy |
| `/api/inference/profile` | POST | Profile inference speed (tok/s, latency) |
| `/api/inference/diagnose` | GET | System-level inference diagnostics |
| `/api/inference/report` | GET | Full diagnostics + profiling report |
| `/api/benchmark/gpu` | POST | Full CPU vs GPU benchmark |
| `/api/benchmark/quick` | POST | Quick CPU vs GPU comparison |
| `/api/memory/estimate` | POST | Estimate memory for model at given ctx_size |
| `/api/memory/recommend-ctx` | POST | Auto-recommend optimal context size |
| `/api/memory/compare-kv` | POST | Compare KV cache quantizations |
| `/api/download-model` | POST | Download model from HuggingFace |
| `/api/convert-model` | POST | Convert model format |
| `/api/quantize-model` | POST | Quantize model (macOS MLX) |

---

## Troubleshooting

<details>
<summary><strong>llama-cli / llama-server not found</strong></summary>

Extract the llama.cpp release archive directly into `Lumina-Edge/bin/`. The `.exe` (Windows) or ELF binaries (Linux) must sit at the top level of `bin/` alongside their `.dll` / `.so` files — not inside a subfolder.

On Linux, ensure executables have permission: `chmod +x bin/llama-*`
</details>

<details>
<summary><strong>No models appear in the selection list</strong></summary>

The launcher scans `models/*.gguf`. Run `model-manager.bat` / `./model-manager.sh` to download a model, or manually place any `.gguf` file in `models/`. Files in other formats (`.safetensors`, `.bin`) will not appear.
</details>

<details>
<summary><strong>Optimization fails / Access denied</strong></summary>

**Windows:** Right-click the `.bat` file and choose **Run as administrator**. Without elevated privileges the optimization step silently skips.

**Linux:** The scripts call `sudo` automatically. Ensure your user has sudo access.
</details>

<details>
<summary><strong>Vulkan initialization failed</strong></summary>

Install the Vulkan Runtime from [vulkan.lunarg.com](https://vulkan.lunarg.com), then update your GPU drivers. Verify with: `vulkaninfo | grep "GPU id"`. A missing or outdated runtime is the most common cause on Windows laptops.
</details>

<details>
<summary><strong>CUDA not available</strong></summary>

Run `nvidia-smi` to confirm your GPU is detected. If it is, update drivers to 535+ and confirm you downloaded the CUDA build of llama.cpp (`cuda` in the filename), not the Vulkan build.
</details>

<details>
<summary><strong>Port 8080 already in use</strong></summary>

The API server listens on port **8080** (primary, inference + management) and **8081** (secondary, management only). To resolve conflicts:

```bash
# Windows
netstat -ano | findstr ":8080"
taskkill /PID <PID> /F

# Linux
ss -tlnp | grep 8080
sudo kill -9 <PID>
```
</details>

<details>
<summary><strong>Out of memory / crash on model load</strong></summary>

Switch to a smaller model or lower quantization. Close RAM-heavy applications (browsers, Electron apps) before launching. Verify: model file size (GB) + 2 GB must be less than total RAM.
</details>

<details>
<summary><strong>Services did not restore after session</strong></summary>

Run the restore script manually:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File "$env:TEMP\lumina_restore_services.ps1"

# Linux
bash /tmp/lumina_restore_services.sh
```

A full system reboot also restores all services automatically.
</details>

---

## Roadmap

### v1.1 — Developer Tooling *(Completed)*
- [x] `config.json` for persistent hyperparameter settings (threads, context size, GPU layers, temperature)
- [x] Multi-model parallel loading and routing
- [x] HuggingFace multi-file shard support
- [x] `--benchmark` flag for automated tokens/sec and memory profiling
- [x] Structured JSON output mode for agent / tool-use pipelines

### v1.2 — Interface Expansion *(Completed)*
- [x] Electron / React desktop UI — chat and model management
- [x] Model tagging and search inside the model manager
- [x] Session history export (JSON / Markdown)

### v2.0 — Ecosystem *(In Progress)*
- [x] Plugin architecture for custom backends (DirectML, OpenCL, ROCm)
- [x] Dual-port API surface (8080 inference + 8081 management)
- [x] Model unload with SIGTERM→SIGKILL escalation (no more hanging)
- [x] Startup pipeline: system optimization + auto-load on launch
- [x] Inference diagnostics & profiling (tokens/sec, latency breakdown)
- [x] Resource monitoring (CPU, RAM, iGPU, VRAM, model processes)
- [x] Context window auto-sizing based on available memory
- [x] KV cache quantization comparison (f16, q8_0, q5_0, q4_0)
- [x] CPU vs iGPU benchmark module
- [x] PowerShell scripts for Windows (`.ps1` launchers)
- [ ] Advanced scheduling for multi-GPU setups
- [ ] Model ensemble routing (combine outputs from multiple models)
- [ ] Python SDK wrapper for programmatic lifecycle control

---

## Contributing

Fork the repo, pick something from the roadmap, and open a PR.

```bash
git checkout -b feature/your-feature
git commit -m "Add: your feature description"
# Open a Pull Request against main
```

When reporting bugs, include: OS version, full hardware specs (CPU, RAM, GPU), the complete error message, and exact reproduction steps.

---