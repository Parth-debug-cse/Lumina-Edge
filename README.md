<div align="center">

# ⚡ Lumina Edge

### Run powerful AI models locally, on hardware you already own.

[![MLX](https://img.shields.io/badge/Apple_MLX-Native-000000?style=flat-square&logo=apple&logoColor=white)](https://github.com/Parth-debug-cse/Lumina-Edge)
[![Vulkan](https://img.shields.io/badge/Vulkan-Supported-AC162C?style=flat-square&logo=vulkan&logoColor=white)](https://github.com/Parth-debug-cse/Lumina-Edge)
[![CUDA](https://img.shields.io/badge/CUDA-535%2B-76B900?style=flat-square&logo=nvidia&logoColor=white)](https://github.com/Parth-debug-cse/Lumina-Edge)
[![Aider](https://img.shields.io/badge/Aider-Integrated-7C3AED?style=flat-square&logo=git&logoColor=white)](https://github.com/Aider-AI/aider)
<br/>

**[Quick Start](#-quick-start) · [API Docs](#-openai-compatible-api) · [Lumina Aider](#use-case-1---agentic-coding-with-lumina-aider) · [Lumina Screen](#use-case-2---hr--legal-resume-screening-with-lumina-screen) · [Lumina Agent](#use-case-3---autonomous-it-ops-with-lumina-agent) · [Lumina Scout](#use-case-4---model-discovery--hardware-planning-with-lumina-scout) · [Benchmarks](#-benchmarks) · [Roadmap](#-roadmap) · [Contributing](#contributing)**

</div>

---

## The Problem with Local AI Today

You have a normal laptop. You want to run a local LLM — for privacy, offline access, zero API cost. The hardware is capable. The models exist. The tooling is the problem.

**Lumina Edge is built for that user.** It uses `llama.cpp` — the fastest open-source inference engine available — with OS-level memory reclamation that frees 1–2 GB before inference begins. The result is a fully operational local LLM with an OpenAI-compatible API endpoint, ready to drop into any existing codebase without touching a single credit.

On Apple Silicon, Lumina Edge uses Apple's native **MLX framework** instead of llama.cpp, giving you unified memory access across CPU and GPU with zero overhead.

---

## Architecture

![Architecture diagram](assets/lumina_edge_architecture.svg)

---

## Quick Start

### Step 0 — Clone the Repository

```bash
git clone https://github.com/Parth-debug-cse/Lumina-Edge.git
cd Lumina-Edge
```

### Prerequisites

| OS | Requirements |
|----|-------------|
| Windows | Node.js 16+, Python 3.8+, [Vulkan Runtime](https://vulkan.lunarg.com/) (for Intel/AMD Vulkan build) |
| Linux | Python 3.8+, cmake, build-essential, [Vulkan drivers](#linux--vulkan-setup) |
| macOS | Python 3.8+, Xcode CLI tools (`xcode-select --install`), Apple Silicon (M1–M4), Homebrew |

**Install Python dependencies:**
```bash
# Linux / Windows
pip install --break-system-packages -r requirements.txt

# macOS (Apple Silicon)
pip install --break-system-packages -r scripts/requirements-macos.txt
```

### Step 1 — Get the llama.cpp binaries

Download the latest release from [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/releases/latest) and extract **all files directly** into `Lumina-Edge/bin/`. Do not create subfolders.

> **Mac users:** Skip this step entirely — see Step 1B below.

| OS | GPU | File to download |
|----|-----|-----------------|
| Windows | Intel / AMD (integrated) | `llama-bXXX-bin-win-vulkan-x64.zip` |
| Windows | NVIDIA | `llama-bXXX-bin-win-cuda-cu12.x-x64.zip` |
| Linux | Intel / AMD (integrated) | `llama-bXXX-bin-ubuntu-vulkan-x64.tar.gz` |
| Linux | NVIDIA | `llama-bXXX-bin-ubuntu-x64-cuda.tar.gz` |

> **Linux / macOS:** After extracting, make scripts and binaries executable:
> ```bash
> chmod +x start_lumina.sh start_api.sh scripts/linux_prelaunch.sh bin/llama-*
> ```

### Step 1B — Mac (Apple Silicon) Setup

Apple silicon chips use **Unified Memory**, so Lumina Edge uses Apple's **MLX Framework** instead of llama.cpp.

**⚠️ Requirements:**
- **Apple Silicon (M1/M2/M3/M4)** — Intel Macs are not supported
- **macOS 12.3 (Monterey)** or later

```bash
pip install --break-system-packages -r scripts/requirements-macos.txt
```

MLX models use **safetensors** format, not GGUF. Use MLX-native models from HuggingFace:

```bash
# Launch with an MLX-native model from HuggingFace
python3 scripts/mlx_backend.py --mode api --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8090
```

**Note:** Downloaded a GGUF model? Use the **Converter** tab in the UI to convert to MLX format before loading.

### Step 2 — Launch Lumina Edge

**Universal Launcher (Recommended):**

```bash
# macOS / Linux
./start_lumina.sh

# Windows PowerShell
.\start_lumina.ps1

# Windows Batch
start_lumina.bat
```

**API-Only Launcher:**
```bash
# Linux / macOS
./start_api.sh
# With custom model:
./start_api.sh --model models/your-model.gguf

# Windows PowerShell
.\start_api.ps1 -Model "models\your-model.gguf"
```

The launcher automatically:
- Optimizes system memory for inference (frees 1–2 GB)
- Starts the appropriate backend (MLX for Mac, llama-server for Windows/Linux)
- Launches the API gateway and web UI
- Opens your browser to the interface

> **Manual UI Launch:** If you prefer to start only the web interface:
> ```bash
> cd ui
> npm install
> npm start
> ```

> **Windows Users:** See [WINDOWS.md](WINDOWS.md) for detailed Windows setup instructions and troubleshooting. `<TODO>` WINDOWS.md not yet created.

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

When you launch an API server, Lumina Edge exposes a REST endpoint at `http://127.0.0.1:8090/v1` that speaks the exact same protocol as OpenAI's API. A secondary management-only port is available at `http://127.0.0.1:8081`. Any application already integrated with the OpenAI Python SDK, Node.js SDK, or any HTTP client can be redirected to a local model by changing a single line — the `base_url`.

Three immediate benefits:

- **Development without cost.** Use a local model during development and testing. Swap to cloud for production with zero code changes.
- **Privacy-sensitive workloads.** Route confidential data — internal documents, medical records, proprietary codebases — through a local model that never touches the network.
- **Offline and air-gapped environments.** Deploy in environments without internet access. No conditional logic, no fallback paths — just a different `base_url`.

No authentication required for local connections. The endpoint accepts standard `chat/completions` requests with `model`, `messages`, `temperature`, `max_tokens`, and `stream` parameters.

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8090/v1",
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
  baseURL: "http://localhost:8090/v1",
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

$r = Invoke-RestMethod -Uri "http://localhost:8090/v1/chat/completions" `
     -Method POST -ContentType "application/json" -Body $body

$r.choices[0].message.content
```

### cURL

```bash
curl http://localhost:8090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    "messages": [{"role": "user", "content": "What is a mutex?"}],
    "temperature": 0.3,
    "max_tokens": 400
  }'
```

---

## Management API Reference

All endpoints available on **port 8090** (inference + management) and **port 8081** (management only).

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

The launcher scans `models/*.gguf` (Linux/Windows) or model directories (macOS). Run the web UI, go to the **Model Manager** tab and click **Download**, or use the API directly:

```bash
curl -X POST http://localhost:8090/api/download-model \
  -H "Content-Type: application/json" \
  -d '{"url": "https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf", "filename": "mistral-7b-instruct-v0.2.Q4_K_M.gguf"}'
```

Manually place any `.gguf` file in `models/` (Linux/Windows) or a full HuggingFace model directory in `models/` (macOS). Files in other formats (`.safetensors`, `.bin`) will not appear for Linux/Windows.
</details>

<details>
<summary><strong>Optimization fails / Access denied</strong></summary>

**Windows:** Right-click the `.bat` file and choose **Run as administrator**. Without elevated privileges the optimization step silently skips.

**Linux:** The scripts call `sudo` automatically. Ensure your user has sudo access.
</details>

<details>
<summary><strong>Vulkan initialization failed</strong></summary>

Install the Vulkan Runtime from [vulkan.lunarg.com](https://vulkan.lunarg.com), then update your GPU drivers. Verify with: `vulkaninfo | grep "GPU id"`. A missing or outdated runtime is the most common cause on Windows laptops.

#### Linux — Vulkan Setup (Intel / AMD)

```bash
# Intel integrated graphics
sudo apt install mesa-vulkan-drivers vulkan-utils

# AMD GPU (RADV driver)
sudo apt install mesa-vulkan-drivers vulkan-utils
export RADV_PERFTEST=gpu    # optional: enables AMD-specific optimizations

# Verify installation
vulkaninfo | grep "GPU id"
```
</details>

<details>
<summary><strong>CUDA not available</strong></summary>

Run `nvidia-smi` to confirm your GPU is detected. If it is, update drivers to 535+ and confirm you downloaded the CUDA build of llama.cpp (`cuda` in the filename), not the Vulkan build.
</details>

<details>
<summary><strong>Port 8090 already in use</strong></summary>

The API server listens on port **8090** (primary, inference + management) and **8081** (secondary, management only). To resolve conflicts:

```bash
# Windows
netstat -ano | findstr ":8090"
taskkill /PID <PID> /F

# Linux
ss -tlnp | grep 8090
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
- [x] HuggingFace multi-file shard support
- [x] `--benchmark` flag for automated tokens/sec and memory profiling
- [x] Structured JSON output mode for agent / tool-use pipelines

### v1.2 — Interface Expansion *(Completed)*
- [x] Electron / React desktop UI — chat and model management
- [x] Model tagging and search inside the model manager
- [x] Session history export (JSON / Markdown)

### v2.0 — Ecosystem *(In Progress)*
- [x] Plugin architecture for custom backends (DirectML, OpenCL, ROCm)
- [x] Dual-port API surface (8090 inference + 8081 management)
- [x] Model unload with SIGTERM→SIGKILL escalation (no more hanging)
- [x] Startup pipeline: system optimization + auto-load on launch
- [x] Inference diagnostics & profiling (tokens/sec, latency breakdown)
- [x] Resource monitoring (CPU, RAM, iGPU, VRAM, model processes)
- [x] Context window auto-sizing based on available memory
- [x] KV cache quantization comparison (f16, q8_0, q5_0, q4_0)
- [x] CPU vs iGPU benchmark module
- [x] PowerShell scripts for Windows (`.ps1` launchers)
- [x] **Lumina Aider** — agentic coding via Aider pointed at Lumina Edge's local API (USE CASE 1)
- [x] **Lumina Screen** — HR/Legal RAG resume screening pipeline with ChromaDB + embeddings (USE CASE 2)
- [x] **Lumina Agent** — local autonomous IT ops agent with tool loop and plain-English goal input (USE CASE 3)
- [x] **Lumina Scout** — hardware-aware model discovery, ranking, and VRAM/quant planning from HuggingFace (USE CASE 4)
- [ ] Advanced scheduling for multi-GPU setups
- [ ] Model ensemble routing (combine outputs from multiple models)
- [ ] Python SDK wrapper for programmatic lifecycle control

---

## USE CASE 1 - Agentic Coding with Lumina Aider

**Lumina Aider** connects [Aider](https://github.com/Aider-AI/aider) — a terminal-based AI coding assistant — to Lumina Edge's local OpenAI-compatible API. Aider reads your codebase, edits files, runs tests, and iterates on your behalf. Lumina Aider replaces the need for cloud API keys entirely: Aider talks to `http://localhost:8090/v1` instead of OpenAI.

### Architecture

```
┌────────────────────────────────────────────────────┐
│  Aider (agentic coding layer)                      │
│  - Reads full repo context                         │
│  - Edits files directly                            │
│  - Runs shell commands & tests                     │
│  - Observes output and self-corrects               │
└───────────────────┬────────────────────────────────┘
                    │  OpenAI-compatible API call
          ┌─────────▼─────────┐
          │  localhost:8090    │
          │  (Lumina Edge API) │
          ├────────────────────┤
          │  macOS: MLX        │
          │  Linux: llama.cpp  │
          │  Win:   llama.cpp  │
          └────────────────────┘
```

### Prerequisites

- Lumina Edge installed and running with at least one model loaded
- Aider installed: `pip install aider-chat`

### Usage

Point Aider at Lumina Edge's local API with a single flag:

```bash
# macOS / Linux
aider --openai-api-base http://localhost:8090/v1 \
      --openai-api-key lumina-edge \
      --model <your-loaded-model-name>

# Windows PowerShell
aider --openai-api-base http://localhost:8090/v1 `
      --openai-api-key lumina-edge `
      --model <your-loaded-model-name>
```

Or set environment variables to make it permanent:

```bash
export OPENAI_API_BASE="http://localhost:8090/v1"
export OPENAI_API_KEY="lumina-edge"
aider --model <your-loaded-model-name>
```

Aider will read your repo, accept plain-English instructions, and edit files directly — all powered by your local model, with no data leaving your machine.

### Platform Rules

| Platform | Backend | Notes |
|----------|---------|-------|
| macOS | MLX (`mlx_lm`) | Use MLX-format model; safetensors or quantized MLX |
| Linux | llama.cpp + Vulkan | Use GGUF model |
| Windows | llama.cpp | Use GGUF model |

---

## USE CASE 2 - HR / Legal Resume Screening with Lumina Screen

**Lumina Screen** is a privacy-first, offline resume screening pipeline built into the Lumina Edge UI. Drop a job description and a folder of resumes (PDF) — Lumina Screen embeds them, scores candidates against the JD using semantic similarity, and alerts you when a strong match is found. No cloud, no vendor, no data leaving your machine.

### Architecture

```
lumina_screen/
├── jd.txt                  ← Active job description (watched by pipeline)
├── resumes/                ← Drop PDFs here; pipeline picks them up automatically
├── chroma_store/           ← Persistent ChromaDB vector store (auto-created)
└── page_hit.txt            ← Log of shortlisted candidates with match scores

Pipeline:
  PDF → pdfplumber (text extraction)
      → all-MiniLM-L6-v2 (sentence-transformer embeddings)
      → ChromaDB (cosine similarity matching vs JD embedding)
      → threshold filter (≥ configured score)
      → OS popup notification + page_hit.txt log entry
```

### Stack

| Component | Library | Notes |
|-----------|---------|-------|
| PDF parsing | `pdfplumber` | No OCR / tesseract required — text-layer PDFs only |
| Embeddings | `sentence-transformers` (`all-MiniLM-L6-v2`) | Runs fully locally |
| Vector store | `ChromaDB` | Persistent on disk; survives restarts |
| Matching | Cosine similarity | No LLM in the matching path — fast, deterministic |
| Notifications | OS-native popups | macOS, Windows, Linux all supported |
| Polling interval | 250–400 ms | Watches the resumes folder for new drops |
| LLM (optional) | 1B param non-reasoning model | Used for candidate summary generation only |

### Setup

Lumina Screen lives in `lumina_screen/` at the repo root and is accessible from the Lumina Edge UI under the **Lumina Screen** section. No separate install is required — just ensure the Lumina Screen dependencies are installed:

```bash
# Linux / Windows
pip install --break-system-packages pdfplumber torch sentence-transformers

# macOS
pip install --break-system-packages -r scripts/requirements-macos.txt
# (pdfplumber, torch, sentence-transformers are included)
```

### Usage

1. **Set your job description** — paste it into `lumina_screen/jd.txt` (or use the UI editor)
2. **Drop resumes** — copy PDFs into `lumina_screen/resumes/`
3. **Start the pipeline** — click **Start Screening** in the Lumina Screen UI section
4. **Get notified** — OS popup fires when a candidate exceeds the similarity threshold; `page_hit.txt` logs every match with score

### Threshold Tuning

The similarity threshold controls how strict matching is. It is configurable in the UI.

| Dataset size | Recommended starting threshold |
|-------------|-------------------------------|
| Small (< 60 resumes) | ~0.25 |
| Medium (100–500) | ~0.35 |
| Large (500+) | ~0.45 |

Start lower and tune up. A threshold set too high will produce zero matches silently — if nothing fires, lower the threshold before debugging elsewhere.

### Known Limitations

- **Image-based PDFs** (scanned documents without a text layer) return empty text from `pdfplumber`. Lumina Screen does not include OCR. Validate that your PDFs are text-layer PDFs before troubleshooting match logic.
- **Deduplication** — the pipeline tracks already-processed resumes in `processed.json`. If you re-run on the same folder without resetting this file, previously seen resumes will be skipped silently.

---

## USE CASE 3 - Autonomous IT Ops with Lumina Agent

**Lumina Agent** is a local autonomous agent for IT operations tasks. Give it a plain-English goal — "find all services consuming more than 500 MB RAM and write a summary report" — and it will plan and execute the steps itself, using a loop of tool calls powered by your local Lumina Edge model. No cloud, no frameworks, no orchestration overhead.

Built as a ~150-line raw Python agent, Lumina Agent demonstrates that meaningful autonomous capability does not require LangChain, AutoGen, or any heavyweight framework.

### Architecture

```
User: plain-English goal
        │
        ▼
┌──────────────────────────────────────────┐
│  Lumina Agent loop                       │
│                                          │
│  1. Send goal + history to local LLM     │
│  2. LLM responds with tool call          │
│  3. Execute tool, capture output         │
│  4. Append result to history             │
│  5. Repeat until LLM calls report()     │
└──────────────────────────────────────────┘
        │
        ▼
  Final report delivered to user
```

### Available Tools

| Tool | Description |
|------|-------------|
| `run_shell` | Execute any shell command and capture stdout/stderr |
| `read_file` | Read a file from disk |
| `write_file` | Write content to a file |
| `http_get` | Make an HTTP GET request and return the response body |
| `report` | Deliver the final answer / report to the user — terminates the loop |

### Setup

Lumina Agent lives in `lumina_agent/` at the repo root and is accessible from the Lumina Edge UI under the **Lumina Agent** section.

```bash
# No extra dependencies — uses only the Python standard library
# plus the Lumina Edge API already running on port 8090
```

### Usage

1. **Start Lumina Edge** with a model loaded (any capable model; 7B+ recommended for reliable tool use)
2. **Open the Lumina Agent section** in the UI
3. **Enter a plain-English goal**, for example:
   - `List all running processes sorted by memory usage and save the top 10 to a file`
   - `Check disk usage on all mounted volumes and alert me if any is above 80%`
   - `Fetch the latest releases from the llama.cpp GitHub API and summarize what changed`
4. **Click Run** — the agent loop starts, tool calls execute, and the final report appears when the LLM calls `report()`

### Platform Rules

| Platform | Shell available | Notes |
|----------|----------------|-------|
| macOS | `/bin/bash` | Full tool support |
| Linux | `/bin/bash` | Full tool support |
| Windows | `cmd.exe` / PowerShell | `run_shell` uses `cmd.exe` by default |

### Security Note

`run_shell` executes commands with the same privileges as the process running Lumina Agent. Use on trusted local machines only. Do not expose the Lumina Edge API port to untrusted networks when Lumina Agent is active.

---

## Benchmarks

![Benchmark chart](assets/lumina_edge_benchmarks.svg)

*Tokens/sec measured on Intel Core i5-8250U · 8 GB DDR4 · Deepseek 7b Q4\_K\_M.*

---

## USE CASE 4 - Model Discovery & Hardware Planning with Lumina Scout

**Lumina Scout** tells you exactly which models from HuggingFace will run on your hardware, how fast they'll be, and what quantization to use — before you download anything. It detects your GPU, RAM, and platform automatically, fetches live model data from the HuggingFace Hub, and ranks candidates using a weighted scoring model that accounts for fit, estimated throughput, parameter count, popularity, and quantization quality.

Accessible from the **Lumina Scout** section in the Lumina Edge UI.

### Architecture

```
lumina_scout/
├── scout.py        ← Public API consumed by Lumina Edge UI routes
├── hardware.py     ← Platform-aware GPU/CPU/RAM detection
├── fetcher.py      ← HuggingFace Hub API client with 6-hour cache + stale fallback
├── ranker.py       ← Scoring engine: fit × speed × size × popularity × quant quality
├── cache/          ← Auto-created; stores per-profile JSON cache files
└── requirements.txt
```

### Three Core Features

#### 1. Model Recommendations

Fetches the top models from HuggingFace for a chosen profile, scores each against your hardware, and returns a ranked list with per-model VRAM requirements, estimated tokens/sec, recommended quantization, and fit type.

**Profiles:**

| Profile | What it fetches |
|---------|----------------|
| `general` | Broad text-generation + GGUF models |
| `coding` | Code and coder-specific models |
| `math` | Math-focused text-generation models |
| `vision` | Image-to-text / multimodal models |

**Fit types:**

| Fit Type | Meaning |
|----------|---------|
| `full_gpu` | Model fits entirely in VRAM — fastest |
| `partial_offload` | Model partially offloaded to CPU RAM — still usable |
| `cpu_only` | Too large for VRAM; runs on CPU — slow |

#### 2. Hardware Detection

Lumina Scout auto-detects your machine before ranking. It probes platform-specific sources in priority order and returns the best available result.

| Platform | GPU Detection Method |
|----------|---------------------|
| macOS | `system_profiler SPHardwareDataType` → `sysctl` fallback |
| Windows | `nvidia-smi` → `wmic` (AMD) |
| Linux | `nvidia-smi` → `rocm-smi` → `/sys/class/drm` sysfs |

On Apple Silicon, total unified memory is used as VRAM (since the GPU and CPU share the same pool). Backend is inferred automatically: `mlx` for Apple Silicon, `llama.cpp` for discrete GPU, `cpu` for CPU-only.

#### 3. Model Planner (`get_plan`)

Given a model name like `"llama 3 70b"`, Scout generates a full compatibility and planning report without fetching anything from HuggingFace:

- **VRAM required** at every supported quantization (Q2\_K through F16)
- **KV cache estimate** for your chosen context length
- **GPU compatibility table** — a ranked list of reference GPUs (NVIDIA, AMD, Apple) showing fit type and estimated tokens/sec for each
- Your actual GPU is inserted at the top of the table if it isn't already in the reference list

### Scoring Model

Each candidate model receives a score out of 100:

| Component | Weight | Logic |
|-----------|--------|-------|
| Fit score | 40% | Full GPU = 40pts; partial offload = scaled by VRAM ratio; CPU-only = 5pts |
| Speed score | 20% | `bandwidth_GBs / (params_B × bytes_per_weight)`, capped at 200 tps → scaled to 20pts |
| Size score | 20% | Log-scaled reward for fitting more parameters within available VRAM |
| Popularity | 10% | Log-scaled downloads + likes from HuggingFace |
| Quant quality | 10% | Higher bitrate quants score higher (Q2\_K = 3/10 → F16/BF16 = 10/10) |

**Quantization auto-selection:** Scout picks the highest-quality quant that fits your VRAM (trying Q5\_K\_M → Q4\_K\_M → Q3\_K\_M → Q2\_K). You can override this with an explicit `quant` filter.

### Stack

| Component | Library | Notes |
|-----------|---------|-------|
| HF API client | `httpx` | Raw HTTP only — no HuggingFace SDK |
| Hardware probing | `psutil` + subprocess | stdlib subprocess for GPU; psutil for RAM/CPU |
| Cache | JSON files in `cache/` | 6-hour TTL; stale fallback if API is unreachable |

Dependencies are minimal by design: `httpx>=0.27` and `psutil>=5.9` only.

### Setup

```bash
# Linux / Windows
pip install --break-system-packages httpx psutil

# macOS
pip install --break-system-packages -r scripts/requirements-macos.txt
# (httpx and psutil are included)
```

No model download required. Lumina Scout works immediately after install.

### UI Usage

1. Open the **Lumina Scout** section in the Lumina Edge UI
2. Your hardware is detected and displayed automatically (GPU, VRAM, RAM, inferred backend)
3. **Recommendations tab** — pick a profile, set how many results you want, optionally filter by quant or minimum speed, and click **Find Models**
4. **Planner tab** — type a model name (e.g. `mistral 7b`, `llama 3 70b`), set context length, and get the full compatibility table and per-quant VRAM breakdown
5. Click any recommended model's **Download** button to hand it off directly to Lumina Edge's model downloader

### API Usage (direct)

Scout's public API (`scout.py`) can also be called directly from Python or wired into other tooling:

```python
from lumina_scout.scout import get_hardware_info, get_recommendations, get_plan

# Detect hardware
hw = get_hardware_info()
# {'gpu_name': 'Apple M3 Pro', 'vram_gb': 36.0, 'backend': 'mlx', ...}

# Get top 5 coding models for this machine
recs = get_recommendations(top=5, profile="coding")
for r in recs:
    print(f"#{r['rank']} {r['model_id']}  score={r['score']}  "
          f"quant={r['quant']}  ~{r['speed_tps']} tps  fit={r['fit_type']}")

# Plan a specific model
plan = get_plan("llama 3 70b", quant="Q4_K_M", context_length=8192)
print(f"VRAM needed: {plan['recommended_vram_gb']} GB")
print(f"KV cache: {plan['kv_cache_estimate_gb']} GB")
for gpu in plan['gpu_compatibility'][:5]:
    print(f"  {gpu['name']}: {gpu['fit_type']}  ~{gpu['estimated_tok_per_sec']} tps")
```

**Optional overrides:**

```python
# Force CPU-only mode (useful for machines without a discrete GPU)
get_recommendations(cpu_only=True)

# Simulate a hypothetical GPU ("what if I had an RTX 4090?")
get_recommendations(gpu_override="NVIDIA RTX 4090")

# Force a cache refresh (bypass the 6-hour TTL)
get_recommendations(refresh=True)

# Filter: only models that can do at least 15 tokens/sec on your hardware
get_recommendations(min_speed=15.0)
```

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
