# Lumina Edge — Demo & Testing Guide

## What is Lumina Edge

Lumina Edge is a local LLM inference framework designed for consumer hardware — laptops, desktops, and single-board computers — that runs powerful AI models without cloud dependency or per-token costs. It targets x86_64 systems with llama.cpp (Linux/Windows) and Apple Silicon with MLX (macOS), optimizing memory before inference to maximize available RAM. The framework exposes an OpenAI-compatible REST API, allowing any tool that works with OpenAI to connect to a local model instantly.

The project implements four distinct use cases: Agentic AI Coding connects a code-capable LLM to development tools like OpenCode, Aider, or Continue.dev via the API endpoint; Multi-Model Router load-balances across multiple llama-server or MLX instances with health checks and automatic failover; Vertical RAG (Legal/HR/NGO) ingests domain documents into a vector database and answers questions grounded in those documents with source citations; and Multi-Agent Pipeline chains multiple LLMs together sequentially, where each agent processes the output of the previous one.

This guide walks through each use case from zero to running output.

---

## Prerequisites

### If models are already downloaded

**Linux/macOS:**
```bash
ls ./models/
```

**Windows:**
```powershell
Get-ChildItem .\models\
```

Expected output shows .gguf files (Linux) or directories with safetensors (macOS):
```
LFM2.5-1.2B-Thinking-Q4_K_M.gguf  tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf
```

Verify llama-server binary exists:

Linux:
```bash
ls ./bin/llama-server
```

Windows:
```powershell
Get-ChildItem .\bin\llama-server.exe
```

Verify mlx_lm is installed (macOS):
```bash
python3 -m mlx_lm.server --help 2>&1 | head -5
```

Verify Python dependencies:

Linux/macOS:
```bash
pip3 install -r requirements.txt --quiet
```

Windows:
```powershell
pip install -r requirements.txt --quiet
```

Verify permissions (Linux/macOS):
```bash
chmod +x ./bin/llama-server
chmod +x ./start_api.sh
chmod +x ./start_lumina.sh
chmod +x scripts/ingest_docs.py
chmod +x scripts/query_docs.py
chmod +x scripts/mlx_backend.py
```

Windows does not require permission changes.

### If models are NOT yet downloaded

**Linux (GGUF models for llama.cpp):**

GGUF is a single-file quantized model format that bundles weights and tokenizer together, optimized for CPU/GPU inference with llama.cpp. Download using huggingface-cli:

```bash
pip3 install huggingface-hub
```

Give concrete recommended models for each use case:

- **UC1 Coding**: Qwen2.5-Coder-3B-Instruct-Q4_K_M — a code-optimized model that works well with coding assistants
- **UC2 Router**: Any 3B Q4_K_M model (same model on multiple ports for load balancing)
- **UC3 RAG**: Qwen2.5-3B-Instruct-Q4_K_M — good general-purpose model for answering questions
- **UC4 Pipeline**: Two different small models, e.g., TinyLlama-1.1B + Qwen2.5-1.5B

Example download command:
```bash
huggingface-cli download Qwen/Qwen2.5-Coder-3B-Instruct-GGUF --include "*Q4_K_M.gguf" --local-dir ./models/
```

**macOS (MLX models):**

macOS uses HuggingFace mlx-community models in safetensors format, downloaded automatically on first run. MLX is Apple's Metal framework for accelerated ML inference on Apple Silicon.

For automatic download (happens on first mlx_lm.server start), no manual step is needed — mlx_lm downloads and caches from HuggingFace. First run will be slow; subsequent runs use cache at ~/.cache/huggingface/.

To pre-download to avoid demo delays:
```bash
python3 -c "from mlx_lm import load; load('mlx-community/Qwen2.5-3B-Instruct-4bit')"
```

Recommended mlx-community models:
- **UC1 Coding**: mlx-community/Qwen2.5-Coder-3B-Instruct-4bit
- **UC2 Router**: mlx-community/Llama-3.2-3B-Instruct-4bit (same model, multiple ports)
- **UC3 RAG**: mlx-community/Qwen2.5-3B-Instruct-4bit
- **UC4 Pipeline**: mlx-community/TinyLlama-1.1B-Chat-v1.0-4bit + mlx-community/Qwen2.5-1.5B-Instruct-4bit

**Windows (GGUF models for llama.cpp):**

Windows uses the same GGUF format as Linux. Download using huggingface-cli:

```powershell
pip install huggingface-hub
```

Example download command:
```powershell
huggingface-cli download Qwen/Qwen2.5-Coder-3B-Instruct-GGUF --include "*Q4_K_M.gguf" --local-dir .\models\
```

Same recommended models as Linux:
- **UC1 Coding**: Qwen2.5-Coder-3B-Instruct-Q4_K_M
- **UC2 Router**: Any 3B Q4_K_M model (same model on multiple ports)
- **UC3 RAG**: Qwen2.5-3B-Instruct-Q4_K_M
- **UC4 Pipeline**: Two different small models, e.g., TinyLlama-1.1B + Qwen2.5-1.5B

After this section the reader has everything installed. Now the use cases begin.

---

## Use Case 1 — Agentic AI Coding

### What this is

Lumina Edge runs a code-capable LLM locally and exposes it as an OpenAI-compatible endpoint. Any coding assistant that supports a custom API base — OpenCode, Aider, Kilo Code, Continue.dev — connects to it instantly. No cloud, no API key, no cost per token.

### Step-by-step

**Step 1 — Start the API server**

Linux:
```bash
./start_api.sh
```

macOS:
```bash
./start_api.sh --gpu mlx
```

Windows:
```powershell
.\start_api.ps1
```

What you will see:
```
Model: ./models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf
Starting Lumina Edge API...
GPU: vulkan
Port: 8090
Context Size: 16384
GPU Layers: 15
+ ./bin/llama-server -m ./models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --port 8090 --host 127.0.0.1 ...
```

Wait for the server to be ready — the terminal will show the model loading progress. On Linux, llama-server prints "HTTP server listening" when ready. On macOS, mlx_backend.py prints "[MLX Direct] Server ready on port 8090".

**Step 2 — Select a model**

The start_api.sh script auto-detects the model from:
1. The `startup.default_model` key in config.json
2. The `model` key in config.json
3. The first .gguf file in ./models/ (Linux) or first safetensors directory (macOS)

To use a specific model, pass it explicitly:
```bash
./start_api.sh --model ./models/your-model.gguf
```

**Step 3 — Connect your coding tool**

Show exact commands for each tool:

**OpenCode** (Linux/macOS):
```bash
opencode --api-base http://127.0.0.1:8090/v1
```

**Aider** (Linux/macOS):
```bash
aider --openai-api-base http://127.0.0.1:8090/v1 --openai-api-key none
```

**OpenCode** (Windows):
```powershell
opencode --api-base http://127.0.0.1:8090/v1
```

**Aider** (Windows):
```powershell
aider --openai-api-base http://127.0.0.1:8090/v1 --openai-api-key none
```

**Continue.dev** (VS Code extension):

In the Continue extension's config.json, add:
```json
{
  "models": [{
    "model": "local",
    "provider": "openai",
    "apiBase": "http://127.0.0.1:8090/v1"
  }]
}
```

**Kilo Code**:

Set base URL to: `http://127.0.0.1:8090/v1`

**Step 4 — Verify it works**

Quick sanity check without any coding tool:
```bash
curl http://127.0.0.1:8090/v1/models
```

Expected output:
```json
{
  "object": "list",
  "data": [{
    "id": "tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
    "object": "model",
    "created": 1715334000,
    "owned_by": "local"
  }]
}
```

Then test a completion:
```bash
curl http://127.0.0.1:8090/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf","messages":[{"role":"user","content":"Write a Python hello world"}],"max_tokens":100}'
```

Expected response includes a "choices" array with the generated text.

**Step 5 — Stop**

Linux/macOS: Press Ctrl+C in the terminal running start_api.sh. The server will clean up and exit.

Windows: Press Ctrl+C in the PowerShell window running start_api.ps1, or close the window. The server will clean up and exit.

### Demo talking point

"This is a full coding assistant running on your laptop with no internet connection and no API costs — I just selected the model and it was ready in under 30 seconds."

---

## Use Case 2 — Multi-Model Router

### What this is

Multi-Model Router load-balances across multiple LLM instances with round-robin and priority-based routing. Why this matters for edge: one powerful request doesn't block others, and if one instance fails, requests automatically route to healthy instances.

### Step-by-step

**Step 1 — Configure instances**

Edit the `multi_model.instances` section in config.json:

```json
{
  "multi_model": {
    "base_port": 9000,
    "instances": [
      {"host": "127.0.0.1", "port": 9001, "priority": 1, "weight": 1},
      {"host": "127.0.0.1", "port": 9002, "priority": 1, "weight": 1}
    ]
  }
}
```

Same model file, different ports = two workers. For Linux, use GGUF files. For macOS, specify the MLX model directory path for each instance.

**Step 2 — Start the router**

Linux:
```bash
python3 scripts/model-router.py load \
  --bin-path ./bin \
  --scripts ./scripts \
  --models-dir ./models \
  ./models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf \
  ./models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf
```

macOS:
```bash
python3 scripts/model-router.py load \
  --bin-path ./bin \
  --scripts ./scripts \
  --models-dir ./models \
  ./models/Qwen2.5-3B-Instruct/ \
  ./models/Qwen2.5-3B-Instruct/
```

Windows:
```powershell
python scripts\model-router.py load --bin-path .\bin --scripts .\scripts --models-dir .\models .\models\tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf .\models\tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf
```

Expected output:
```
🚀 Starting llama-server: ./bin/llama-server -m ./models/... --port 9001 ...
🚀 Starting llama-server: ./bin/llama-server -m ./models/... --port 9002 ...
✓ Model server ready on port 9001
✓ Model server ready on port 9002
📊 Multi-Model Router Status:
  Total Models: 2
  Ready Models: 2
  Routing Policy: round-robin
```

**Step 3 — Verify round-robin**

Run two requests back to back:
```bash
curl http://127.0.0.1:9001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"Say the number 1"}],"max_tokens":10}'
```

```bash
curl http://127.0.0.1:9002/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"local","messages":[{"role":"user","content":"Say the number 2"}],"max_tokens":10}'
```

The router logs show requests alternating between instances. Watch the terminal output — each request logs which model instance handled it.

**Step 4 — Verify health check failover**

Kill one backend to see failover in action:
```bash
# Linux
fuser -k 9001/tcp

# macOS
lsof -ti:9001 | xargs kill

# Windows
Get-Process -Id (Get-NetTCPConnection -LocalPort 9001 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force
```

Then send another request to port 9000 (the router proxy). It routes to the healthy instance on port 9002. The router logs show:
```
⚠ Model <id> unhealthy, marking idle
✓ Model <id> recovered, marking ready
```

**Step 5 — Stop**

Linux/macOS: Press Ctrl+C to stop the router. All model instances clean up.

Windows: Press Ctrl+C in the PowerShell window, or close the terminal. All model instances clean up.

### Demo talking point

"This router automatically distributes load across two local models — if one crashes, requests seamlessly fail over to the other in under 10 seconds."

---

## Use Case 3 — Vertical RAG (Legal / HR / NGO)

### What this is

Vertical RAG delivers domain-specific AI grounded in YOUR documents. Ingest PDF/DOCX/TXT files into a vector database, then ask questions — the AI answers with citations showing which documents it used. No hallucination, no training data reliance, just your data.

### Step-by-step

**Step 1 — Prepare documents**

Linux/macOS:
```bash
mkdir -p rag/documents/legal
mkdir -p rag/documents/hr
mkdir -p rag/documents/ngo
```

Windows:
```powershell
New-Item -ItemType Directory -Force -Path rag\documents\legal, rag\documents\hr, rag\documents\ngo
```

Place PDF/DOCX/TXT files into the relevant folder. For demo: put sample documents in each folder:
- `rag/documents/legal/sample_nda.txt` — copy from demo_docs/
- `rag/documents/hr/employee_handbook_excerpt.txt` — copy from demo_docs/
- `rag/documents/ngo/grant_report_q1.txt` — copy from demo_docs/

**Step 2 — Ingest documents**

Linux/macOS:
```bash
python3 scripts/ingest_docs.py rag/documents/legal --domain legal
python3 scripts/ingest_docs.py rag/documents/hr --domain hr
python3 scripts/ingest_docs.py rag/documents/ngo --domain ngo
```

Windows:
```powershell
python scripts\ingest_docs.py rag\documents\legal --domain legal
python scripts\ingest_docs.py rag\documents\hr --domain hr
python scripts\ingest_docs.py rag\documents\ngo --domain ngo
```

Expected output:
```
Found 1 document(s) to ingest
📄 Processing: sample_nda.txt
  Extracted 1204 characters
  Created 3 chunks
  Generating embeddings...
  ✓ Ingested 3 chunks successfully
✓ Ingestion complete!
  Files processed: 1/1
  Total chunks stored: 3
  Collection: legal_docs
```

Note: This only needs to be run once per document set. Re-running is safe — deduplication handles it.

**Step 3 — Start the RAG API**

The RAG system queries the main LLM API. Ensure the API server is running:

Linux/macOS:
```bash
./start_api.sh
```

Windows:
```powershell
.\start_api.ps1
```

Then query documents using the query script:

**Legal query:**

Linux/macOS:
```bash
python3 scripts/query_docs.py "What are the termination clauses?" --domain legal
```

Windows:
```powershell
python scripts\query_docs.py "What are the termination clauses?" --domain legal
```

**HR query:**

Linux/macOS:
```bash
python3 scripts/query_docs.py "What is the leave policy?" --domain hr
```

Windows:
```powershell
python scripts\query_docs.py "What is the leave policy?" --domain hr
```

**NGO query:**

Linux/macOS:
```bash
python3 scripts/query_docs.py "What are the funding guidelines?" --domain ngo
```

Windows:
```powershell
python scripts\query_docs.py "What are the funding guidelines?" --domain ngo
```

Expected response:
```
🔍 Query: "What are the termination clauses?"
📚 Retrieving top 5 relevant chunks from legal collection...
✓ Retrieved 2 chunks
⚙️ Querying LLM on port 8090...

======================================================================
📝 ANSWER:
======================================================================
[Answer from the AI based on retrieved documents]
======================================================================

📚 Sources Referenced:
  📄 sample_nda.txt (chunk 1/3)
  📄 sample_nda.txt (chunk 2/3)
```

**Step 4 — Verify domain isolation**

Prove that Legal queries don't bleed into HR results:

Linux/macOS:
```bash
python3 scripts/query_docs.py "What are the termination clauses?" --domain hr
```

Windows:
```powershell
python scripts\query_docs.py "What are the termination clauses?" --domain hr
```

Expected: "No relevant documents found above similarity threshold." or a very low-confidence response that clearly didn't come from Legal documents.

**Step 5 — Stop**

Linux/macOS: Press Ctrl+C to stop the API server.

Windows: Press Ctrl+C in the PowerShell window, or close the terminal.

### Demo talking point

"This AI answers questions from YOUR documents with source citations — see those file names? That's proof it's using your data, not hallucinating."

---

## Use Case 4 — Multi-Agent Pipeline

### What this is

Multi-Agent Pipeline chains multiple LLMs together sequentially. One request flows through all agents, each transforming the output. Real example: a cleaner agent first normalizes dirty log data, then a categorizer agent assigns severity labels and categorizes entries.

### Step-by-step

**Step 1 — Configure agents in config.json**

Edit the `agents` section in config.json:

```json
{
  "agents": {
    "cleaner": {
      "name": "cleaner",
      "port": 8001,
      "model_path": "./models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
      "description": "Cleans and normalizes raw log data"
    },
    "categorizer": {
      "name": "categorizer",
      "port": 8002,
      "model_path": "./models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf",
      "description": "Assigns severity and category to log entries"
    }
  },
  "api": {
    "host": "0.0.0.0",
    "port": 8000
  }
}
```

Linux/macOS: model_path points to GGUF files.
macOS: model_path points to MLX model directories (e.g., mlx-community/Llama-3.2-3B-Instruct-4bit).
Windows: model_path points to GGUF files (e.g., .\models\tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf).

**Step 2 — Prepare a sample log file for the demo**

Create a realistic dirty log file:

Linux/macOS:
```bash
cat > /tmp/demo_logs.txt << 'EOF'
2024-01-15 08:23:11.442 [ERROR] usr=john.doe@company.com db_conn failed: timeout after 30s retrying...
2024-01-15 08:23:11.443 [ERROR] usr=john.doe@company.com db_conn failed: timeout after 30s retrying...
2024-01-15 08:23:12.001 [INFO] heartbeat ok
2024-1-15 8:23:15 WARN network latency spike 450ms on eth0
2024-01-15 08:24:00.000 [CRITICAL] auth service unreachable - 127.0.0.1:8443 connection refused
null null null [DEBUG] gc sweep complete 14ms
2024-01-15 08:24:01 INFO heartbeat ok
2024-01-15 08:24:05 ERROR payment gateway timeout usr=jane.smith@company.com amount=4999
EOF
```

Windows:
```powershell
@"
2024-01-15 08:23:11.442 [ERROR] usr=john.doe@company.com db_conn failed: timeout after 30s retrying...
2024-01-15 08:23:11.443 [ERROR] usr=john.doe@company.com db_conn failed: timeout after 30s retrying...
2024-01-15 08:23:12.001 [INFO] heartbeat ok
2024-1-15 8:23:15 WARN network latency spike 450ms on eth0
2024-01-15 08:24:00.000 [CRITICAL] auth service unreachable - 127.0.0.1:8443 connection refused
null null null [DEBUG] gc sweep complete 14ms
2024-01-15 08:24:01 INFO heartbeat ok
2024-01-15 08:24:05 ERROR payment gateway timeout usr=jane.smith@company.com amount=4999
"@ | Out-File -FilePath $env:TEMP\demo_logs.txt -Encoding UTF8
```

This log is intentionally dirty: duplicate lines, inconsistent timestamp formats, PII (email addresses), mixed severity formats. Perfect for showing what the cleaner agent does.

**Step 3 — Start the pipeline**

Linux/macOS:
```bash
python3 pipeline_api.py
```

Windows:
```powershell
python pipeline_api.py
```

Expected output:
```
INFO:     Started server process [12345]
INFO:     Application startup complete.
[Lumina Pipeline] INFO: Created orchestrator with 2 agents
```

Note: macOS waits 5 seconds for MLX model load. The terminal shows "Application startup complete." when ready.

**Step 4 — Run the pipeline on the sample logs**

Linux/macOS:
```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"lumina-pipeline\",\"messages\":[{\"role\":\"user\",\"content\":$(cat /tmp/demo_logs.txt | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))\")}]}"
```

Windows (PowerShell):
```powershell
$content = Get-Content -Raw $env:TEMP\demo_logs.txt
$body = @{
    model = "lumina-pipeline"
    messages = @(
        @{role = "user"; content = $content}
    )
} | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://127.0.0.1:8000/v1/chat/completions" -Method Post -ContentType "application/json" -Body $body
```

Expected: the categorizer's JSON output — cleaned logs organized by severity and category. Example:
```json
{
  "id": "chatcmpl-...",
  "choices": [{
    "message": {
      "content": "Cleaned logs:\n- 2024-01-15 08:23:11 [ERROR] Database connection timeout (john.doe@company.com)\n- 2024-01-15 08:23:12 [INFO] Heartbeat OK\n...\nCategorized:\n- CRITICAL: auth service unreachable\n- ERROR: payment gateway timeout\n..."
    }
  }]
}
```

This is the money shot of the demo.

**Step 5 — Check pipeline status**

Linux/macOS:
```bash
curl http://127.0.0.1:8000/api/v1/pipeline/status
```

Windows:
```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/v1/pipeline/status"
```

Expected output:
```json
{
  "pipeline": {"default_mode": "sequential", "max_parallel": 2},
  "agents": {
    "cleaner": {"port": 8001, "model_path": "..."},
    "categorizer": {"port": 8002, "model_path": "..."}
  },
  "status": {
    "cleaner": {"status": "idle", "port": 8001, "last_activity": 1234567890.0},
    "categorizer": {"status": "idle", "port": 8002, "last_activity": 1234567895.0}
  },
  "is_running": true
}
```

**Step 6 — Show agent latency breakdown**

Point to the latency fields in the status response. Each agent's contribution to total response time is tracked via last_activity timestamps. The difference between consecutive agent timestamps shows individual latency.

**Step 7 — Stop**

Linux/macOS: Press Ctrl+C in the terminal running pipeline_api.py. Clean shutdown message appears.

Windows: Press Ctrl+C in the PowerShell window, or close the terminal. Clean shutdown message appears.

### Demo talking point

"Two local models working in sequence — the first cleans the dirty data, the second categorizes it — running entirely on this machine with zero cloud dependency."

---

## Troubleshooting

### Port already in use

Linux:
```bash
fuser -k 8090/tcp
```

macOS:
```bash
lsof -ti:8090 | xargs kill
```

Windows:
```powershell
Get-Process -Id (Get-NetTCPConnection -LocalPort 8090 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force
```

Then restart the relevant component.

### Model not loading / server not starting

Check the log:

Linux:
```bash
tail -50 .lumina_run/llama_server.log
```

macOS:
```bash
tail -50 .lumina_run/mlx_backend.log
```

Windows:
```powershell
Get-Content .lumina_run\llama_server.log -Tail 50
```

Common causes: wrong model path, not enough RAM, wrong binary permissions.

### mlx_lm model downloading on first run (macOS)

This is normal. The model downloads to ~/.cache/huggingface/. Progress is shown in the terminal. Can take 2-10 minutes on first run.

To pre-download before the demo:
```bash
python3 -c "from mlx_lm import load; load('mlx-community/MODEL-NAME')"
```

### curl returns connection refused

The server is not ready yet. Wait a few seconds and retry.
Check if the process is running:

Linux:
```bash
ps aux | grep llama-server
```

macOS:
```bash
ps aux | grep mlx_backend
```

Windows:
```powershell
Get-Process | Where-Object { $_.ProcessName -like "*llama-server*" }
```

### RAG returns empty results

Documents may not be ingested. Re-run the ingestion step:

Linux/macOS:
```bash
python3 scripts/ingest_docs.py rag/documents/legal --domain legal
```

Windows:
```powershell
python scripts\ingest_docs.py rag\documents\legal --domain legal
```

Check similarity threshold in config.json — it may be too high (lower the `retrieval_threshold` from 0.3 to 0.5 or 0.7).

### OpenWebUI shows blank response

The API response schema is wrong. Check pipeline_api.py returns all required OpenAI fields. Restart the API after any code changes:

Linux/macOS:
```bash
# Stop with Ctrl+C, then restart
python3 pipeline_api.py
```

Windows:
```powershell
# Stop with Ctrl+C, then restart
python pipeline_api.py
```

---

## Quick Reference — All Commands

### UC1 — Coder (Agentic AI Coding)

**Linux/macOS:**
```bash
./start_api.sh                                    # start API server
curl http://127.0.0.1:8090/v1/models              # verify ready
Ctrl+C                                           # stop
```

**Windows:**
```powershell
.\start_api.ps1                                   # start API server
Invoke-RestMethod http://127.0.0.1:8090/v1/models  # verify ready
Ctrl+C                                           # stop
```

### UC2 — Router (Multi-Model)

**Linux/macOS:**
```bash
python3 scripts/model-router.py load --bin-path ./bin --scripts ./scripts --models-dir ./models ./models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf ./models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf  # start router
curl http://127.0.0.1:9001/v1/models              # verify instance 1
fuser -k 9001/tcp (Linux) / lsof -ti:9001 | xargs kill (macOS)  # simulate failover
Ctrl+C                                           # stop
```

**Windows:**
```powershell
python scripts\model-router.py load --bin-path .\bin --scripts .\scripts --models-dir .\models .\models\tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf .\models\tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf  # start router
Invoke-RestMethod http://127.0.0.1:9001/v1/models  # verify instance 1
Get-Process -Id (Get-NetTCPConnection -LocalPort 9001 -ErrorAction SilentlyContinue).OwningProcess -ErrorAction SilentlyContinue | Stop-Process -Force  # simulate failover
Ctrl+C                                           # stop
```

### UC3 — RAG (Vertical RAG)

**Linux/macOS:**
```bash
mkdir -p rag/documents/legal rag/documents/hr rag/documents/ngo
python3 scripts/ingest_docs.py rag/documents/legal --domain legal    # ingest legal docs
python3 scripts/ingest_docs.py rag/documents/hr --domain hr           # ingest HR docs
python3 scripts/ingest_docs.py rag/documents/ngo --domain ngo         # ingest NGO docs
./start_api.sh                                   # start LLM API (required for RAG)
python3 scripts/query_docs.py "Your question" --domain legal          # query legal
python3 scripts/query_docs.py "Your question" --domain hr             # query HR
Ctrl+C                                           # stop
```

**Windows:**
```powershell
New-Item -ItemType Directory -Force -Path rag\documents\legal, rag\documents\hr, rag\documents\ngo
python scripts\ingest_docs.py rag\documents\legal --domain legal     # ingest legal docs
python scripts\ingest_docs.py rag\documents\hr --domain hr            # ingest HR docs
python scripts\ingest_docs.py rag\documents\ngo --domain ngo          # ingest NGO docs
.\start_api.ps1                                  # start LLM API (required for RAG)
python scripts\query_docs.py "Your question" --domain legal          # query legal
python scripts\query_docs.py "Your question" --domain hr              # query HR
Ctrl+C                                           # stop
```

### UC4 — Pipeline (Multi-Agent)

**Linux/macOS:**
```bash
python3 pipeline_api.py                          # start pipeline API
cat > /tmp/demo_logs.txt << 'EOF'
...dirty log data...
EOF
curl http://127.0.0.1:8000/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"lumina-pipeline\",\"messages\":[{\"role\":\"user\",\"content\":$(cat /tmp/demo_logs.txt | python3 -c \"import sys,json; print(json.dumps(sys.stdin.read()))\")}]}"  # run pipeline
curl http://127.0.0.1:8000/api/v1/pipeline/status  # check status
Ctrl+C                                           # stop
```

**Windows:**
```powershell
python pipeline_api.py                          # start pipeline API
@"
...dirty log data...
"@ | Out-File -FilePath $env:TEMP\demo_logs.txt -Encoding UTF8
$content = Get-Content -Raw $env:TEMP\demo_logs.txt
$body = @{model="lumina-pipeline";messages=@{role="user";content=$content}} | ConvertTo-Json -Compress
Invoke-RestMethod -Uri "http://127.0.0.1:8000/v1/chat/completions" -Method Post -ContentType "application/json" -Body $body  # run pipeline
Invoke-RestMethod http://127.0.0.1:8000/api/v1/pipeline/status  # check status
Ctrl+C                                           # stop
```

---

DEMO_GUIDE.md written. Review it before your demo.