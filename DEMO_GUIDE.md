# Lumina Edge Demo Guide

Lumina Edge is a local LLM inference framework that runs models on consumer hardware using llama.cpp (Linux/Windows) or Apple's MLX (macOS). It exposes an OpenAI-compatible HTTP API, enabling any OpenAI-integrated tool to use a local model with zero code changes.

---

## Prerequisites

| OS | Requirements |
|---|---|
| **Windows** | Node.js 16+, Python 3.8+, Vulkan Runtime ([lunarg.com](https://vulkan.lunarg.com)) |
| **Linux** | Python 3.8+, cmake, build-essential, Vulkan drivers |
| **macOS** | Python 3.8+, Xcode CLI tools, Apple Silicon (M1–M4), Homebrew |

### Install Dependencies

**Linux / Windows:**
```bash
pip install --break-system-packages -r requirements.txt
```

**macOS:**
```bash
pip install --break-system-packages -r scripts/requirements-macos.txt
```

### Get llama.cpp Binaries

Download from [ggml-org/llama.cpp/releases](https://github.com/ggml-org/llama.cpp/releases/latest) and extract all files into `bin/`:

| OS | GPU | File |
|---|---|---|
| Windows | Intel/AMD | `llama-bXXX-bin-win-vulkan-x64.zip` |
| Windows | NVIDIA | `llama-bXXX-bin-win-cuda-cu12.x-x64.zip` |
| Linux | Intel/AMD | `llama-bXXX-bin-ubuntu-vulkan-x64.tar.gz` |
| Linux | NVIDIA | `llama-bXXX-bin-ubuntu-x64-cuda.tar.gz` |

macOS: Skip this step — MLX backend uses built-in Apple frameworks.

---

## Model Download

### Linux / Windows (GGUF)

Download a model to `models/`:
```bash
# Example: TinyLlama 1.1B Q4
huggingface-cli download TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --local-dir models/
```

Or manually download from HuggingFace and place in `models/`.

### macOS (MLX/Safetensors)

```bash
# MLX models use --model pointing to a directory
# Example: Llama 3.2 3B Instruct (4-bit)
python3 scripts/mlx_backend.py --mode api --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8090
```

The model downloads automatically on first run. Alternatively, download from HuggingFace and place in `models/`.

---

## Use Case 1: Agentic AI Coding

**What it demonstrates:** Lumina Edge exposes a local model as an OpenAI-compatible endpoint. Any coding tool built for OpenAI (Aider, OpenCode, Continue.dev) can point its `base_url` at Lumina Edge instead of OpenAI's servers.

**Expected behavior:** A coding assistant responds to prompts using a local model with no internet and no API key.

### Linux / macOS

```bash
./start_api.sh
```

Output:
```
Starting Lumina Edge API...
Model: models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf
GPU: vulkan
Port: 8090
llama-server -m models/... --port 8090 ...
```

When ready:
```
Lumina Edge API ready!
  Endpoint:  http://127.0.0.1:8090
  Docs:      http://127.0.0.1:8090/docs
```

### Windows

```powershell
.\start_api.ps1
```

Output:
```
Lumina Edge API Server (Windows)
  Model:       C:\path\to\model.gguf
  Port:        8090
  Ctx Size:    16384
  GPU Layers:  15
```

### Test the Endpoint

```bash
curl http://127.0.0.1:8090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
    "messages": [{"role": "user", "content": "Write a Python function to reverse a string."}],
    "max_tokens": 200
  }'
```

**Demo talking point:** "Any tool that works with OpenAI works with Lumina Edge — just change the URL."

---

## Use Case 2: Multi-Model Router

**What it demonstrates:** model-router.py starts multiple llama-server instances on separate ports and proxies requests in round-robin fashion. If one instance dies, traffic routes to healthy ones.

**Expected behavior:** Two model servers run, requests alternate between them in logs, then one is killed and requests continue through the other.

### Start the Router

```bash
python3 scripts/model-router.py load \
  models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf \
  models/second-model.gguf \
  --bin-path bin \
  --scripts scripts \
  --models-dir models
```

Output:
```
INFO: ✓ Registered model: tinyllama (ID: a1b2c3d4) on port 9001
INFO: ✓ Started health checks (interval: 10s)
INFO: ✓ Registered model: second-model (ID: e5f6g7h8) on port 9002
INFO: ✓ Model server ready on port 9001
INFO: ✓ Model server ready on port 9002
INFO: ✓ Loaded routing policy: round-robin
INFO: ✓ Loaded context size: 16384

🔄 Starting parallel model loading (2 models)...

📊 Multi-Model Router Status:
  Total Models: 2
  Ready Models: 2
  Routing Policy: round-robin

  Available Endpoints:
    - tinyllama: http://127.0.0.1:9001/v1 (inferences: 0)
    - second-model: http://127.0.0.1:9002/v1 (inferences: 0)
```

### Send Requests

```bash
# Route through proxy on port 9000
curl http://127.0.0.1:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "local", "messages": [{"role": "user", "content": "Hello"}]}'
```

### Kill One Instance and Retry

```bash
# Find and kill one llama-server process
pkill -f "llama-server.*9002"

# Request still succeeds via 9001
curl http://127.0.0.1:9000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "local", "messages": [{"role": "user", "content": "Are you still there?"}]}'
```

**Demo talking point:** "Zero-downtime model switching — kill a backend, requests keep flowing."

---

## Use Case 3: Vertical RAG (Legal / HR / NGO)

**What it demonstrates:** ingest_docs.py reads PDF/DOCX/TXT files, chunks them, generates embeddings, and stores them in a local vector database organized by domain. query_docs.py retrieves relevant chunks and sends them plus the question to the LLM, which answers with citations showing which source files it used.

**Expected behavior:** A question is answered with file-name citations proving the AI read YOUR documents.

### Ingest Documents

**Linux / macOS:**
```bash
python3 scripts/ingest_docs.py demo_docs/ --domain legal
```

**Windows:**
```powershell
python scripts\ingest_docs.py demo_docs\ --domain legal
```

Output:
```
Loading embedding model: all-MiniLM-L6-v2
  ✓ Model loaded successfully
Created new collection: legal_docs

Found 1 document(s) to ingest

📄 Processing: sample_nda.txt
  Extracted 1204 characters
  Created 3 chunks
  Generating embeddings...
  ✓ Ingested 3 chunks successfully

✓ Ingestion complete!
  Files processed: 1/1
  Duplicates skipped: 0
  Total chunks stored: 3
  Collection: legal_docs
```

Repeat for other domains:
```bash
python3 scripts/ingest_docs.py demo_docs/ --domain hr
python3 scripts/ingest_docs.py demo_docs/ --domain ngo
```

### Query Documents

**Linux / macOS:**
```bash
python3 scripts/query_docs.py "What is the confidentiality period in the NDA?" --domain legal
```

**Windows:**
```powershell
python scripts\query_docs.py "What is the confidentiality period in the NDA?" --domain legal
```

Output:
```
🔍 Query: "What is the confidentiality period in the NDA?"
📚 Retrieving top 5 relevant chunks from legal collection...

✓ Retrieved 2 chunks
⚙️ Querying LLM on port 8090...

======================================================================
📝 ANSWER:
======================================================================
The NDA specifies that the confidentiality obligations shall remain in effect for a period of three (3) years following the termination of this Agreement.
======================================================================

📚 Sources Referenced:
  📄 sample_nda.txt (chunk 1/2)
  📄 sample_nda.txt (chunk 2/2)
```

**Demo talking point:** "The answer cites exactly which file and chunk it used — no hallucination, no guesswork."

---

## Use Case 4: Multi-Agent Pipeline

**What it demonstrates:** pipeline/orchestrator.py starts two separate llama-server instances (agents), each assigned a role from config.json. A single user request flows through both agents in sequence — agent 1's output becomes agent 2's input. The demo uses dirty server logs: agent 1 (cleaner) normalizes inconsistent timestamps and removes duplicates, agent 2 (categorizer) assigns severity labels and groups entries by category.

**Expected behavior:** Raw messy log input goes in, structured categorized JSON output comes out. The /health endpoint shows both agents' activity timestamps proving both ran.

### Start the Pipeline

**Linux / macOS:**
```bash
./pipeline/start_pipeline.sh
```

**Windows:**
```powershell
.\pipeline\start_pipeline.ps1
```

Output:
```
Loading config from config.json...
Model found: models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf
Model found: models/LFM2.5-1.2B-Thinking-Q4_K_M.gguf

==========================================
Starting Agent 1 (Cleaner) on port 8001...
==========================================
Cleaner PID: 12345

==========================================
Starting Agent 2 (Categorizer) on port 8002...
==========================================
Categorizer PID: 12346

Waiting for agents to initialize...
Agent 1 (Cleaner) ready on port 8001
Agent 2 (Categorizer) ready on port 8002

==========================================
Starting Orchestrator on port 8000...
==========================================
Orchestrator PID: 12347

==========================================
PIPELINE READY
==========================================
Agent 1 (Cleaner):  http://localhost:8001
Agent 2 (Categorizer): http://localhost:8002
Orchestrator:     http://localhost:8000
```

### Send a Request

```bash
curl http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "lumina-pipeline",
    "messages": [
      {
        "role": "user",
        "content": "2024-01-15 10:30:22 ERROR 192.168.1.100 Connection refused to db-server\n2024-01-15 10:30:22 ERROR 192.168.1.100 Connection refused to db-server\n2024/01/15 10:31:05 WARN [EMAIL] Failed authentication attempt\n10:31:12 INFO heartbeat received"
      }
    ],
    "max_tokens": 500
  }'
```

Output (truncated):
```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "[{\"timestamp\": \"2024-01-15T10:30:22Z\", \"severity\": \"ERROR\", \"category\": \"db\", \"message\": \"Connection refused to db-server\"}, ...]"
      }
    }
  ]
}
```

### Check Pipeline Status

```bash
curl http://localhost:8000/health
```

Output:
```json
{"status": "healthy", "service": "orchestrator"}
```

**Demo talking point:** "Two specialized models in sequence — cleaner normalizes the mess, categorizer structures it. One request, two models, structured output."

---

## Quick Reference

| Command | Platform | Description |
|---|---|---|
| `./start_api.sh` | Linux / macOS | API-only launcher |
| `./start_lumina.sh` | Linux / macOS | Full stack (API + UI + OpenWebUI) |
| `.\start_api.ps1` | Windows | API-only launcher |
| `.\start_lumina.ps1` | Windows | Full stack |
| `./pipeline/start_pipeline.sh` | Linux / macOS | Multi-agent pipeline |
| `.\pipeline\start_pipeline.ps1` | Windows | Multi-agent pipeline |
| `python3 scripts/ingest_docs.py <dir> --domain <legal\|hr\|ngo>` | All | Ingest documents for RAG |
| `python3 scripts/query_docs.py "<question>" --domain <domain>` | All | Query RAG system |
| `python3 scripts/model-router.py load <model1> <model2> --bin-path bin --scripts scripts --models-dir models` | All | Multi-model router |

### Default Ports

| Service | Port |
|---|---|
| API (inference) | 8090 |
| API (management) | 8081 |
| UI (Vite) | 5173 |
| OpenWebUI | 8080 |
| MLX backend | 8091 |
| Pipeline cleaner | 8001 |
| Pipeline categorizer | 8002 |
| Pipeline orchestrator | 8000 |
| Router proxy | 9000 |
| Router instances | 9001, 9002 |

### Stop Services

**Linux / macOS:**
```bash
pkill -f 'llama-server' 2>/dev/null || true
pkill -f 'api-server.js' 2>/dev/null || true
pkill -f 'vite' 2>/dev/null || true
pkill -f 'orchestrator' 2>/dev/null || true
```

**Windows:**
```powershell
Get-Process -Name "llama-server" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force
```