<div align="center">

# Lumina Edge

### Run powerful AI models locally, on hardware you already own.

[![MLX](https://img.shields.io/badge/Apple_MLX-Native-000000?style=flat-square&logo=apple&logoColor=white)](https://github.com/Parth-debug-cse/Lumina-Edge)
[![Vulkan](https://img.shields.io/badge/Vulkan-Supported-AC162C?style=flat-square&logo=vulkan&logoColor=white)](https://github.com/Parth-debug-cse/Lumina-Edge)
[![CUDA](https://img.shields.io/badge/CUDA-535%2B-76B900?style=flat-square&logo=nvidia&logoColor=white)](https://github.com/Parth-debug-cse/Lumina-Edge)
[![Aider](https://img.shields.io/badge/Aider-Integrated-7C3AED?style=flat-square&logo=git&logoColor=white)](https://github.com/Aider-AI/aider)
<br/>

**[Quick Start](#quick-start) · [API](#openai-compatible-api) · [Features](#features) · [Benchmarks](#benchmarks) · [Roadmap](#roadmap)**

</div>

---

## The Problem with Local AI Today

You have a normal laptop. You want to run a local LLM — for privacy, offline access, zero API cost. The hardware is capable, the models exist, the tooling is the problem.

Lumina Edge is built for that user. It uses `llama.cpp` with OS-level memory reclamation that frees 1–2 GB before inference begins, exposing a fully operational local LLM through an OpenAI-compatible API — drop it into any existing codebase without touching a credit. On Apple Silicon it uses Apple's native **MLX framework** instead, giving unified memory access across CPU and GPU with zero overhead.

---

## Architecture

![Architecture diagram](assets/lumina_edge_architecture.svg)

---

## Quick Start

```bash
git clone https://github.com/Parth-debug-cse/Lumina-Edge.git
cd Lumina-Edge
```

| OS | Requirements |
|----|-------------|
| Windows | Node.js 16+, Python 3.8+, [Vulkan Runtime](https://vulkan.lunarg.com/) |
| Linux | Python 3.8+, cmake, build-essential, Vulkan drivers |
| macOS | Python 3.8+, Xcode CLI tools, Apple Silicon (M1–M4), Homebrew |

```bash
# Linux / Windows
pip install --break-system-packages -r requirements.txt

# macOS (Apple Silicon)
pip install --break-system-packages -r scripts/requirements-macos.txt
```

**Windows / Linux:** download the matching `llama.cpp` release from [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp/releases/latest) and extract directly into `bin/` (no subfolders).

| OS | GPU | File |
|----|-----|------|
| Windows | Intel/AMD | `llama-bXXX-bin-win-vulkan-x64.zip` |
| Windows | NVIDIA | `llama-bXXX-bin-win-cuda-cu12.x-x64.zip` |
| Linux | Intel/AMD | `llama-bXXX-bin-ubuntu-vulkan-x64.tar.gz` |
| Linux | NVIDIA | `llama-bXXX-bin-ubuntu-x64-cuda.tar.gz` |

```bash
chmod +x linux.sh mac.sh start_api.sh bin/llama-*
```

**macOS:** no separate binary download needed — `start_api.sh` and `mac.sh` both auto-detect Apple Silicon and use MLX instead of llama.cpp. Requires macOS 12.3+. MLX models use `.safetensors`, not GGUF (convert via the **Converter** tab in the UI, or load an MLX-native model directly from HuggingFace).

**Linux / macOS — full stack (backend + API gateway + UI), auto-loads a model from `config.json` or a flag:**

```bash
./start_api.sh
./start_api.sh --model models/your-model.gguf --gpu vulkan   # or nvidia / mlx (auto-picked on macOS)
```

**Linux / macOS / Windows — full stack, no model auto-loaded (pick one later in the UI):**

```bash
./linux.sh      # Linux
./mac.sh        # macOS
windows.bat     # Windows
```

All three start the backend (llama-server or MLX), the API gateway, and the Vite UI dev server, then open your browser automatically. Override ports with `LUMINA_API_PORT` / `LUMINA_UI_PORT` env vars (Linux also supports `LUMINA_NOSWAP=1` to disable swap for the session); the Linux/macOS scripts also take `--help` for options.

**Windows — backend only:**

```powershell
.\start_api.ps1 -Model "models\your-model.gguf"
```

`start_api.ps1` starts `llama-server.exe` directly on `127.0.0.1` — it does not launch the UI. Start that separately:

```powershell
cd ui
npm install
npm run dev
```

---

## Why Lumina Edge

| | LM Studio | Ollama | **Lumina Edge** |
|---|---|---|---|
| Baseline RAM | 400–700 MB | 200–400 MB | **~0 MB — no background process** |
| Background Services | Always running | Always running | **Launches on demand only** |
| Available RAM (8 GB) | ~3.0 GB | ~3.2 GB | **~5.2 GB (+73%)** |
| Pre-inference Flush | No | No | **Yes — 1–2 GB freed automatically** |
| Tokens/sec | Baseline | −5 to −12% | **+23% to +37%** |

*Measured on Intel Core i5-8250U · 8 GB DDR4 · Deepseek 7B Q4_K_M.*

---

## Supported Model Formats

| Format | Notes |
|--------|-------|
| MLX `.mlx` | Native, Mac only, fastest on Mac |
| GGUF `.gguf` | Native, recommended for Windows/Linux |
| SafeTensor `.safetensors` | Auto-converts to GGUF on Win/Lin; native on Mac |
| FP16 `.bin` / `.pt` | Auto-converts to GGUF |

Sharded HuggingFace models (`model-00001-of-00003.safetensors`) are auto-detected and reassembled into a single GGUF — no manual merging.

---

## Memory Optimization

![Memory optimization flowchart](assets/lumina_edge_optimization_flow.svg)

---

## Quantization Guide

Quantization works like image compression: smaller file, less RAM, barely noticeable quality loss at the right setting. Q4_K_M is the sweet spot.

![Quantization spectrum](assets/lumina_edge_quantization.svg)

---

## OpenAI-Compatible API

Lumina Edge exposes a REST endpoint at `http://127.0.0.1:8090/v1` that speaks the same protocol as OpenAI's API — point any existing OpenAI SDK integration at it by changing one line, the `base_url`. A secondary management-only port is available at `8081`. No auth required for local connections.

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8090/v1", api_key="not-needed")

response = client.chat.completions.create(
    model="mistral-7b-instruct-v0.2.Q4_K_M.gguf",
    messages=[{"role": "user", "content": "Explain POSIX compliance simply."}],
    temperature=0.3,
    max_tokens=600
)
print(response.choices[0].message.content)
```

Same call structure works for streaming, Node.js, PowerShell, and cURL — swap `base_url` and `model` to move between local and cloud inference with zero other code changes.

**Management endpoints** (port 8090 or 8081):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server health check |
| `/api/system-info` | GET | Platform, arch, Apple Silicon detection |
| `/api/system/resources` | GET | CPU, RAM, iGPU/GPU, VRAM, model processes |
| `/api/system/optimize` | POST | Run system memory optimization |
| `/api/config` / `/api/save-config` | GET/POST | Read or update configuration |
| `/api/models/list` | GET | List available models |
| `/api/models/convertible` | GET | List convertible model files |
| `/api/inference/profile` | POST | Profile inference speed (tok/s, latency) |
| `/api/inference/diagnose` | GET | System-level inference diagnostics |
| `/api/inference/report` | GET | Full diagnostics + profiling report |
| `/api/benchmark/gpu` / `/api/benchmark/quick` | POST | Full or quick CPU vs GPU benchmark |
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

Extract the llama.cpp release directly into `bin/` — binaries must sit at the top level, not in a subfolder. On Linux: `chmod +x bin/llama-*`
</details>

<details>
<summary><strong>No models appear in the selection list</strong></summary>

Use the **Model Manager** tab to download, or place a `.gguf` file directly in `models/`. Non-GGUF formats won't appear on Linux/Windows.
</details>

<details>
<summary><strong>Optimization fails / Access denied</strong></summary>

**Windows:** run the `.bat` as administrator. **Linux:** ensure your user has sudo access.
</details>

<details>
<summary><strong>Vulkan initialization failed</strong></summary>

Install the [Vulkan Runtime](https://vulkan.lunarg.com), update GPU drivers, verify with `vulkaninfo | grep "GPU id"`.
</details>

<details>
<summary><strong>CUDA not available</strong></summary>

Run `nvidia-smi` to confirm GPU detection, update drivers to 535+, confirm you downloaded the CUDA build (not Vulkan).
</details>

<details>
<summary><strong>Port 8090 already in use</strong></summary>

```bash
# Windows
netstat -ano | findstr ":8090" && taskkill /PID <PID> /F

# Linux
ss -tlnp | grep 8090 && sudo kill -9 <PID>
```
</details>

---

## Roadmap

**v1.1 — Developer Tooling** *(complete)* — persistent config, HuggingFace shard support, benchmark mode, structured JSON output for agent pipelines

**v1.2 — Interface Expansion** *(complete)* — React web UI (Vite dev server), model tagging/search, session history export

**v2.0 — Ecosystem** *(in progress)* — plugin architecture (DirectML/OpenCL/ROCm), dual-port API, graceful model unload, inference diagnostics, resource monitoring, KV cache quant comparison, Windows PowerShell launchers, and all four features below

**Next:** multi-GPU scheduling, model ensemble routing, Python SDK wrapper

---

## Features

### Lumina Aider — Agentic Coding

Connects [Aider](https://github.com/Aider-AI/aider) to Lumina Edge's local API — Aider reads your repo, edits files, runs tests, and iterates, with zero cloud API keys.

```bash
aider --openai-api-base http://localhost:8090/v1 \
      --openai-api-key lumina-edge \
      --model <your-loaded-model-name>
```

| Platform | Backend | Model format |
|----------|---------|--------------|
| macOS | MLX (`mlx_lm`) | safetensors / quantized MLX |
| Linux | llama.cpp + Vulkan | GGUF |
| Windows | llama.cpp | GGUF |

---

### Lumina Screen — Resume Screening

Offline HR/legal resume screening. Drop a job description and a folder of resumes — Lumina Screen embeds them, scores candidates by semantic similarity, and alerts you on a match. No cloud, no data leaving your machine.

```
lumina_screen/
├── jd.txt          ← active job description
├── resumes/        ← drop PDFs here
├── chroma_store/   ← persistent vector store
└── page_hit.txt    ← shortlisted matches with scores

Pipeline: PDF → pdfplumber → all-MiniLM-L6-v2 embeddings → ChromaDB cosine match → threshold filter → OS notification
```

Threshold guide: ~0.25 for <60 resumes, ~0.35 for 100–500, ~0.45 for 500+. Start low and tune up — a threshold set too high fails silently.

**Limitation:** scanned/image-only PDFs return empty text (no OCR). Already-processed resumes are tracked in `processed.json` and skipped on re-run.

---

### Lumina Agent — Autonomous IT Ops

A ~150-line raw Python agent — no LangChain, no AutoGen. Give it a plain-English goal and it plans and executes using a tool-call loop powered by your local model.

```
        ┌─────────────────────────────┐
        │                             │
        ▼                             │
   plain-English goal            append result
        │                          to history
        ▼                             │
   LLM picks a tool ──► execute ──────┘
        │
        │ (LLM calls report())
        ▼
   final answer delivered
```

**Tools:** `run_shell`, `read_file`, `write_file`, `http_get`, `report`.

**Security:** `run_shell` runs with the same privileges as the host process. Trusted local machines only — never expose the API port to untrusted networks while Agent is active.

---

### Lumina Scout — Model & Hardware Planning

Tells you which HuggingFace models will run on your hardware, how fast, and at what quantization — before you download anything. Detects GPU/RAM/platform, fetches live model data, and ranks candidates on fit, speed, size, popularity, and quant quality.

```
lumina_scout/
├── scout.py     ← public API
├── hardware.py  ← GPU/CPU/RAM detection
├── fetcher.py   ← HuggingFace client, 6h cache
├── ranker.py    ← scoring engine
└── cache/
```

**Scoring:** fit (40%) · speed (20%) · size (20%) · popularity (10%) · quant quality (10%). Auto-picks the highest-quality quant that fits your VRAM.

```python
from lumina_scout.scout import get_recommendations, get_plan

recs = get_recommendations(top=5, profile="coding")
plan = get_plan("llama 3 70b", quant="Q4_K_M", context_length=8192)

# Overrides
get_recommendations(cpu_only=True)                       # force CPU-only
get_recommendations(gpu_override="NVIDIA RTX 4090")       # simulate a GPU you don't have
get_recommendations(min_speed=15.0)                       # filter by min tok/s
```

Stack: `httpx` for API calls, `psutil` for hardware probing — no heavier dependencies.

---

## Benchmarks

![Benchmark chart](assets/lumina_edge_benchmarks.svg)

*Measured on Intel Core i5-8250U · 8 GB DDR4 · Deepseek 7B Q4_K_M.*

---

## Contributing

Fork the repo, pick something from the roadmap, open a PR.

```bash
git checkout -b feature/your-feature
git commit -m "Add: your feature description"
```

Bug reports should include OS, hardware specs, full error message, and reproduction steps.

---
