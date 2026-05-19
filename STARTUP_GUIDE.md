# Lumina Edge — Startup & Usage Guide

> **Last updated:** 2026-05-18 · **Version:** v1.2 · **Based on actual repo contents**

---

## Section 1 — Prerequisites

Install these **before** cloning the repo:

| Requirement | Details |
|---|---|
| **Python** | 3.10+ (tested with 3.12). `python3 --version` must work. |
| **pip** | `python3 -m pip --version` must work. |
| **Node.js** | 18+ with `npm` (Vite dev server + Express API gateway). |
| **Git** | `git --version` must work. |
| **curl** | Used by startup scripts for health checks. |

### Platform-specific build tools

| Platform | Additional requirements |
|---|---|
| **macOS (Apple Silicon)** | Xcode Command Line Tools (`xcode-select --install`). Homebrew recommended. Docker or Colima if you want OpenWebUI. |
| **Linux** | `build-essential`, `cmake` (if compiling llama.cpp yourself). `sudo` access for system tuning (swapoff, sysctl, CPU governor). |
| **Windows** | Visual C++ build tools if compiling llama.cpp. PowerShell execution policy must allow running `.ps1` scripts. |

### Binary dependency

- **`bin/llama-server`** (Linux/Windows) or **`bin/llama-server.exe`** (Windows) — the llama.cpp inference binary. Download from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases/latest) and place in the `bin/` directory. The repo ships with a `.gitkeep` placeholder — you must download the binary yourself.

> ⚠️ CRITICAL: The pre-built llama.cpp binaries from GitHub releases ship with **shared libraries** (`libllama.so`, `libggml.so`, etc.) that are NOT in the system library path. You **must** copy all `lib*.so*` files from the release archive into `bin/` alongside `llama-server`, OR set `LD_LIBRARY_PATH` at runtime:
> ```bash
> LD_LIBRARY_PATH=./bin ./linux.sh
> ```
> The startup scripts do NOT set `LD_LIBRARY_PATH` automatically. If you see `error while loading shared libraries: libllama-common.so.0`, this is the fix.

- **macOS** does **not** need llama-server; it uses `mlx-lm` (Python) instead.

---

## Section 2 — First-Time Setup (run once)

### 1. Clone the repo

```bash
git clone <repo-url>
cd 2026-Lumina-Edge-LLM-Inference-Framework
```

### 2. Install Python dependencies

**All platforms — Lumina Screen (resume screening):**

```bash
pip install -r lumina_screen/requirements.txt
```

This installs: `pdfplumber`, `sentence-transformers`, `chromadb`, `numpy`, `torch`.

**macOS — MLX backend:**

```bash
pip install -r scripts/requirements-macos.txt
```

This installs: `mlx`, `mlx-lm`, `psutil`, `chromadb`, `sentence-transformers`, `tiktoken`, `PyMuPDF`, `python-docx`, `requests`, `huggingface-hub`, `fastapi`, `uvicorn`, `aiohttp`, `typer`, `rich`, `httpx`, `dbgpu[fuzz]`, `nvidia-ml-py`.

**Linux/Windows — Model converter (optional):**

```bash
pip install -r scripts/requirements-converter.txt
```

This installs: `torch`, `transformers`, `safetensors`, `numpy`, `requests`, `huggingface-hub`, `gguf`.

**Lumina Scout (all platforms):**

```bash
pip install -r lumina_scout/requirements.txt
```

This installs: `httpx>=0.27`, `psutil>=5.9`.

### 3. Install Node.js dependencies for the UI

```bash
cd ui && npm install && cd ..
```

### 4. Download the llama-server binary (Linux/Windows only)

Download the latest llama.cpp binary release from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases/latest). The pre-built archives include both the binary **and** required shared libraries.

**Linux example:**
```bash
# Download the release archive
curl -sL "https://github.com/ggml-org/llama.cpp/releases/latest/download/llama-b9204-bin-ubuntu-x64.tar.gz" -o /tmp/llama-bin.tar.gz

# Extract
tar xzf /tmp/llama-bin.tar.gz -C /tmp/

# Copy binary AND all shared libraries to bin/
cp /tmp/llama-b9204/llama-server bin/
cp /tmp/llama-b9204/lib*.so* bin/
chmod +x bin/llama-server
```

**Windows:** Download `llama-*.zip` and extract `llama-server.exe` + all `.dll` files into `bin\`.

> ⚠️ NOTE: You must copy **both** the binary and the `lib*.so*` (or `.dll` on Windows) shared libraries. The binary alone will fail with `error while loading shared libraries`.

### 5. One-time config files

**`config.json`** — already exists at repo root. Edit values as needed. Key fields:

| Key | Default | Purpose |
|---|---|---|
| `model` | `""` | Model filename or directory name in `models/` |
| `api_port` | `8090` | API gateway port |
| `backend_port` | `8091` | Backend (llama-server / MLX) port |
| `ui_port` | `5173` | Vite dev server port |
| `n_gpu_layers` | `99` | GPU offload layers (0 = CPU-only) |
| `startup.default_model` | `"test_model"` | Auto-load model at startup |
| `startup.auto_load_model` | `false` | Enable auto-load at startup |

**`lumina_screen/config.json`** — already exists. Controls the resume screening pipeline:

| Key | Default | Purpose |
|---|---|---|
| `resume_folder` | `"./resumes"` | Folder to watch for PDF resumes |
| `poll_interval_ms` | `300` | Polling interval for new files |
| `match_threshold` | `0.65` | Cosine similarity threshold for shortlisting |
| `chroma_store_path` | `"./chroma_store"` | ChromaDB persistent storage path |
| `jd_path` | `"./jd.txt"` | Job description file path |
| `page_hit_path` | `"./page_hit.txt"` | Output file for shortlisted candidates |

### 6. Download the first model

The server **can** start with zero models — the launchers handle this gracefully:

- **macOS (`mac.sh`)**: If no model is found, it logs `No model — use the Models tab to download one` and continues starting the API server + UI. You can download models from the UI's Models tab.
- **Linux (`linux.sh`)**: Exits with error if no model is found. You must have a `.gguf` file or MLX model directory in `models/` before running.
- **`start_lumina.sh`**: Same as above — exits if no model found on Linux, but continues on macOS.

**To download a model from the UI:**
1. Start the server (Section 3)
2. Open `http://localhost:5173` in your browser
3. Go to the **Models** tab
4. Click **Download** next to any catalog model (e.g., Phi-3-mini, TinyLlama, Mistral 7B, Llama 3 8B)
5. Or paste a HuggingFace repo URL in the "Custom Download" field

> ⚠️ NOTE: Model downloads happen in the background. The UI shows progress. GGUF files go directly to `models/`. MLX models are downloaded as directories with `config.json` + `.safetensors` files.

---

## Section 3 — Starting the Server

### macOS (Apple Silicon)

```bash
./mac.sh
```

Optional: `./mac.sh --model /path/to/model` to specify a model.

Environment variables you can set:
- `LUMINA_API_PORT` (default: 8090)
- `LUMINA_MLX_PORT` (default: 8091)
- `LUMINA_UI_PORT` (default: 5173)
- `LUMINA_OW_PORT` (default: 8080)

### Linux

```bash
LD_LIBRARY_PATH=./bin ./linux.sh
```

> ⚠️ NOTE: `LD_LIBRARY_PATH=./bin` is required because the pre-built llama.cpp binaries ship with shared libraries (`libllama.so`, `libggml.so`, etc.) that are not in the system library path. Without it, you'll get `error while loading shared libraries: libllama-common.so.0`.

Optional: `LD_LIBRARY_PATH=./bin ./linux.sh --model /path/to/model.gguf`

### Windows

```cmd
start_lumina.bat
```

Optional: `start_lumina.bat "C:\path\to\model.gguf"`

---

### Alternative: API-only (no UI)

If you only want the backend + API gateway without the Vite dev server:

**macOS/Linux:**
```bash
./start_api.sh
# or
./core/launch_api.sh
```

**Windows:**
```powershell
.\start_api.ps1
# or
.\core\launch_api.ps1
```

---

### What a successful startup looks like

```
[Lumina] ============================================================
[Lumina]   Lumina Edge Launcher
[Lumina] ============================================================
[Lumina]   Root:     /path/to/repo
[Lumina]   Platform: Darwin arm64
[Lumina]   Model:    /path/to/models/your-model
[Lumina]
[Lumina] Stopping any existing Lumina processes...
[Lumina] Optimizing system for inference...
[Lumina]   ...
[Lumina] ✓ System optimisation complete
[Lumina] Installing Lumina Scout dependencies...
[Lumina] ✓ Lumina Scout dependencies installed
[Lumina]   Model: /path/to/models/your-model
[Lumina] Starting inference backend...
[Lumina]   MLX backend PID: 12345
[Lumina]   Waiting for MLX server to be ready...
[Lumina] ✓ MLX backend ready on port 8091
[Lumina] Starting Lumina Core API gateway...
[Lumina]   API server PID: 12346
[Lumina] ✓ API gateway ready (primary: 8090, mgmt: 8081)
[Lumina] Starting Lumina Core UI...
[Lumina]   Vite PID: 12347
[Lumina] ✓ Lumina Core UI ready at http://localhost:5173

============================================================
  Lumina Edge — All systems ready
============================================================

  Model:       /path/to/models/your-model
  Backend:     http://127.0.0.1:8091
  API:         http://127.0.0.1:8090
  Lumina UI:   http://localhost:5173

  Logs:        .lumina_run/
  PIDs:        .lumina_run/pids.txt

============================================================

Startup complete. Press Ctrl+C to stop all services.
```

### Browser URL

Open **http://localhost:5173** in your browser.

---

## Section 4 — Using the UI

The UI has 10 navigation panels in the left sidebar:

### 1. Chat

**What it does:** Chat with your loaded model through an OpenAI-compatible interface.

**How to use:**
1. Ensure a model is loaded (check sidebar status dot is green)
2. Type a message in the chat input
3. Press Enter or click Send
4. Response streams in real-time

**Success looks like:** Model response appears in the chat window. Sidebar shows "Model Loaded" with the model name.

### 2. Models

**What it does:** Browse local models, download new ones from HuggingFace, manage tags, and convert model formats.

**How to use:**
1. **Local tab** — See all models in `models/`. Add/remove tags for organization.
2. **Download tab** — Click Download next to a catalog model (Phi-3-mini, TinyLlama, Mistral 7B, Llama 3 8B), or paste a HuggingFace URL for custom downloads.
3. **Custom tab** — Enter a HuggingFace repo ID to download an entire model repository.
4. **Converter tab** — Convert between model formats (SafeTensors → GGUF, etc.).

**Success looks like:** Downloaded model appears in the Local tab. Status shows download progress.

### 3. Diagnostics

**What it does:** System resource monitoring, GPU benchmarks, memory optimization, and profiling tools.

**How to use:**
1. Click the Diagnostics nav item
2. View system info, run benchmarks, check memory usage

**Success looks like:** System metrics display with real-time data.

### 4. Router (Multi-Model)

**What it does:** Load, unload, and route between multiple models simultaneously.

**How to use:**
1. Click Router nav item
2. Load models from the `models/` directory
3. Routes requests between loaded models based on routing policy

**Success looks like:** Models show as "ready" with their assigned ports.

### 5. Screen (Lumina Screen)

**What it does:** Resume screening pipeline — watches a folder for PDF resumes, parses them, embeds them, and matches against a job description.

**How to use:** See Section 5 for full walkthrough.

### 6. Agent (Lumina Agent)

**What it does:** Autonomous IT operations agent that executes shell commands, reads/writes files, and makes HTTP requests to complete tasks.

**How to use:** See Section 6 for full walkthrough.

### 7. Scout (Lumina Scout)

**What it does:** Hardware-aware model finder — scans your hardware, recommends models that fit your VRAM/RAM, and plans GPU compatibility.

**How to use:** See Section 7 for full walkthrough.

### 8. History

**What it does:** Browse and export past chat conversations.

**How to use:** Click History nav item. Sessions are stored locally. Export as JSON or Markdown.

### 9. API

**What it does:** OpenAI-compatible API endpoint documentation.

**How to use:** Click API nav item. Shows available endpoints for integration with tools like Continue or Cline.

### 10. Settings

**What it does:** Configure hyperparameters (temperature, top_p, top_k, repeat_penalty), context size, GPU layers, and server options.

**How to use:**
1. Click Settings nav item
2. Adjust sliders and inputs
3. Changes are saved to `config.json`

---

## Section 5 — Lumina Screen: Full Pipeline Walkthrough

### 1. Prepare `jd.txt`

**Where:** `lumina_screen/jd.txt`

**Format:** Plain text. Paste the full job description.

**Example:**
```
Senior Software Engineer
Required skills: Python, Django, PostgreSQL, REST APIs, Docker
Experience: 5+ years in backend development
Nice to have: AWS, CI/CD, microservices architecture
```

**From the UI:** You can also paste/edit the JD directly in the Screen panel's "Job Description" textarea and click "Save Config". The pipeline auto-detects JD file changes at runtime and re-embeds without restarting.

### 2. Prepare the resume folder

**Default location:** `lumina_screen/resumes/` (relative to the `lumina_screen/` directory)

**Supported file types:** `.pdf` only (the watcher filters for `.pdf` files)

**How to structure:** Drop PDF files directly into the folder. Subdirectories are not scanned.

> ⚠️ NOTE: The resume folder path must be within your home directory (security restriction). Absolute paths outside `$HOME` are rejected.

### 3. Start the pipeline from the UI

1. Navigate to the **Screen** panel
2. Set the **Resume Folder Path** (default: `./resumes`)
3. Paste your **Job Description** in the text area
4. Adjust the **Similarity Threshold** slider (default: 65%)
5. Choose a **Poll Interval** (250ms, 300ms, or 400ms)
6. Click **Save Config**
7. Click **▶ Start Lumina Screen**

The status badge turns green (● Running).

### 4. What happens automatically

Once started, the pipeline runs in this loop:

1. **Startup scan** — Processes all existing PDFs in the resume folder that haven't been evaluated yet (not in `processed.json`)
2. **Polling** — Every `poll_interval_ms` (default 300ms), checks the resume folder for new `.pdf` files
3. **Dedup** — Computes SHA-256 hash of each file. If already in `processed.json`, skips it
4. **PDF parsing** — Uses `pdfplumber` to extract text, name, email, and phone
5. **Embedding** — Chunks the text (200 words, 50 word overlap), embeds with `all-MiniLM-L6-v2`, stores in ChromaDB
6. **Matching** — Computes cosine similarity between resume embedding and JD embedding
7. **Scoring** — If score >= threshold, the candidate is shortlisted
8. **Notification** — OS-native desktop notification fires (macOS: `osascript`, Linux: `notify-send`, Windows: PowerShell popup)
9. **Logging** — Shortlisted candidate appended to `page_hit.txt`

### 5. How to know it's working

- **UI status badge** shows ● Running (green)
- **Diagnostic log lines** appear in the API server terminal:
  ```
  [LuminaScreen] DIAG: resume.pdf | Score: 0.7234 | Threshold: 0.6500 | Status: PASS
  [LuminaScreen] SHORTLISTED: John Doe (0.7234)
  ```
- **Shortlisted candidates** appear in the Live Results panel (auto-refreshes every 2s)
- **OS notification** pops up on desktop for each shortlisted candidate

### 6. Shortlist output

**File:** `lumina_screen/page_hit.txt`

**Format:**
```
[2026-05-18 14:32:01] | John Doe | resume.pdf | 0.7234 | john@example.com | +1-555-1234
```

Fields: `[TIMESTAMP] | NAME | FILENAME | SCORE | EMAIL | PHONE`

**OS notification:** Fires automatically for each shortlisted candidate. Silent failures are ignored (non-critical).

### 7. Resetting the pipeline

To re-evaluate all existing resumes:

**From the UI:**
1. Go to Screen panel
2. Click **🔄 Re-scan Existing**
3. This clears `processed.json`
4. Stop and restart the pipeline

**From the terminal:**
```bash
rm lumina_screen/processed.json
```

To also clear the ChromaDB embeddings (full reset):
```bash
rm -rf lumina_screen/chroma_store
rm lumina_screen/processed.json
```

Then restart the pipeline. The embedding model (`all-MiniLM-L6-v2`) will be re-downloaded on first run if the local cache at `lumina_screen/models/all-MiniLM-L6-v2/` doesn't exist.

### 8. Common failures and fixes

| Symptom | Cause | Fix |
|---|---|---|
| **`jd.txt` not found** | File missing at `lumina_screen/jd.txt` or wrong path in config | Create the file: `echo "Your job description here" > lumina_screen/jd.txt` |
| **All PDFs return empty text** | Image-based/scanned PDFs (pdfplumber can't extract text from images) | OCR the PDFs first, or use text-based PDFs only |
| **Zero matches despite correct setup** | Threshold too high, or all resumes already in `processed.json` | Lower the threshold slider. Click "Re-scan Existing" to clear dedup state |
| **`chroma_store` path wrong** | Config has wrong `chroma_store_path` | Edit `lumina_screen/config.json` and set `"chroma_store_path": "./chroma_store"` |
| **Pipeline won't start from UI** | `lumina_screen/main.py` not found or Python deps missing | Run `pip install -r lumina_screen/requirements.txt` from repo root |
| **Resume folder path rejected** | Path is outside home directory | Use a path within `$HOME`, e.g., `~/resumes` or `./resumes` |
| **Pipeline crashes on startup** | Malformed `config.json` in `lumina_screen/` | Fix JSON syntax. The pipeline gives a clear error on invalid JSON |

---

## Section 6 — Lumina Agent: Full Walkthrough

### 1. What it does

Lumina Agent is an autonomous IT operations agent that runs entirely on your local machine. You give it a goal in plain English, and it reasons step-by-step, calling tools to gather information and complete the task. No cloud, no external services — everything stays on your device. It connects to the Lumina Edge backend (port 8091) for LLM inference.

### 2. How to give it a goal from the UI

1. Navigate to the **Agent** panel
2. Type a goal in the text area (or click an example goal)
3. Click **▶ Run Agent**
4. The agent starts executing — you'll see each step appear in the Agent Log

### 3. What the agent loop looks like

Each step displays:
- **Step number** and **tool name** (e.g., "Step 1 — run_shell")
- **Thought** — the agent's reasoning (italic, with 💭)
- **Args** — the arguments passed to the tool (JSON)
- **Result** — the tool's output (truncated to 300-500 chars in UI)

The log auto-scrolls as new steps appear. Polling happens every 1.5 seconds.

### 4. The 5 tools

| Tool | What it does | When the agent uses it |
|---|---|---|
| **`run_shell(command)`** | Execute a shell command. Returns STDOUT, STDERR, and return code. 15-second timeout. Destructive commands (`rm -rf /`, `shutdown`, `mkfs`, `dd`, fork bombs) are blocked. | Gathering system info, checking processes, finding files, running diagnostics |
| **`read_file(path)`** | Read a file from the filesystem. Max 8KB. Path is resolved to absolute. | Reading config files, log files, scripts |
| **`write_file(path, content)`** | Write content to a file. Creates parent directories. **Restricted to the project directory** for security. | Creating reports, saving configs, writing scripts |
| **`http_get(url)`** | HTTP GET request. Max 4KB response. SSRF protection blocks localhost, private IPs, and cloud metadata endpoints. | Fetching web data, checking API endpoints |
| **`report(summary)`** | Call when the task is complete. Returns the summary to the user. | Final step — always ends with this |

### 5. How to know it finished

- The agent log shows a final step with tool = `report`
- A **"Task Complete"** card appears with a green checkmark
- The summary text is displayed in full
- The Run button becomes enabled again
- Status changes from "Running..." to final state

If the agent fails:
- An **Error** card appears with a red alert icon
- Error message explains what went wrong (e.g., "LLM call timed out", "Cannot connect to Lumina Edge API")

### 6. What it cannot do

- **Cannot interact with GUI applications** — only CLI commands
- **Cannot run interactive commands** (no `vim`, `nano`, `top` — they'll timeout after 15s)
- **Cannot execute destructive commands** — `rm -rf /`, `shutdown`, `reboot`, `mkfs`, `dd`, fork bombs are blocked
- **Cannot write outside the project directory** — `write_file` is restricted
- **Cannot access localhost/private IPs** — `http_get` has SSRF protection
- **Cannot run for more than 10 iterations** — `MAX_ITERATIONS = 10` in config
- **Requires the backend server to be running** on port 8091 — if the server is down, the agent fails immediately
- **Uses a hardcoded model name** (`gemma3:2b`) — if your loaded model has a different name, the agent may fail to get responses

### 7. Example goals that work well

- `"Check disk space and find the 3 largest directories in home"`
- `"Find all running processes using more than 100MB of RAM"`
- `"Check if port 8090 is open and what process is using it"`
- `"List all Python files in the project and count their lines"`
- `"Check system memory usage and report free/used/total"`

---

## Section 7 — Lumina Scout: Full Walkthrough

### 1. Hardware scan

**Click sequence:**
1. Navigate to the **Scout** panel
2. Click **Scan Hardware** button

**What each field means:**

| Field | Meaning |
|---|---|
| **GPU** | Detected GPU name (or "CPU Only" if none) |
| **VRAM** | GPU video RAM in GB |
| **RAM** | System RAM in GB |
| **CPU** | CPU name/model |
| **Backend** | Detected inference backend (mlx, vulkan, cuda, cpu) |
| **Platform** | OS platform (Darwin, Linux, Windows) |

> ⚠️ NOTE: Hardware detection uses `psutil` for CPU/RAM and platform-specific GPU detection. On some systems, GPU detection may return limited info.

### 2. Model recommendations

**How to use each input:**

| Input | Purpose | Example |
|---|---|---|
| **Results** | Number of recommendations to return (1-50) | `10` |
| **Profile** | Model category filter | `general`, `coding`, `vision`, `math` |
| **Quant** | Filter by quantization type (optional) | `Q4_K_M`, `Q5_K_M` |
| **Min Speed** | Minimum tokens/second required (optional) | `20` |
| **Force Refresh** | Re-fetch model data from HuggingFace | Check the box |

**Click:** **Recommend**

**Table columns:**

| Column | Meaning |
|---|---|
| **#** | Rank (1 = best fit) |
| **Model ID** | HuggingFace model identifier |
| **Score** | Fit score (higher = better match for your hardware) |
| **Fit** | `Full GPU` (fits in VRAM), `Partial` (partial offload needed), or `Too small`/`CPU only` |
| **VRAM (GB)** | Estimated VRAM required |
| **Speed (tok/s)** | Estimated tokens per second |
| **Quant** | Quantization level |
| **Benchmark** | Benchmark source (may be empty) |

> ⚠️ NOTE: Scout fetches model data from HuggingFace. If HuggingFace is unreachable, the recommendation will fail with an error. The "Force Refresh" checkbox re-fetches data instead of using cached results.

### 3. VRAM planner

**How to use:**
1. Enter a **Model Name** (must contain a parameter count like `llama 3 70b` or `mistral 7b`)
2. Optionally specify a **Quant** (e.g., `Q4_K_M`)
3. Set **Context Length** (default: 4096)
4. Click **Plan**

**Example inputs:**
- `llama 3 70b` → Shows VRAM for all quant levels
- `mistral 7b` → Shows VRAM for all quant levels
- `gemma 2b` → Shows VRAM for all quant levels

**How to read the quant breakdown table:**

| Element | Meaning |
|---|---|
| **VRAM by Quantization** | Badges showing estimated VRAM for each quant level (e.g., `Q2_K: 2.5 GB`, `Q4_K_M: 4.2 GB`) |
| **Min GPU** | Minimum VRAM needed to run the model fully on GPU (green badge) |
| **KV Cache Estimate** | Estimated KV cache size in GB for the given context length |
| **GPU Compatibility table** | Lists known GPUs with their VRAM, fit type, and estimated speed |

**Fit types in the GPU compatibility table:**
- `Full GPU` — Model fits entirely in VRAM
- `Partial` — Model needs partial CPU offload
- `CPU only` — Model is too large for the GPU

### 4. How to use Scout output to pick a model

1. **Scan Hardware** to know your VRAM/RAM limits
2. **Recommend** to find models ranked by fit for your hardware
3. Look at the **VRAM (GB)** column — pick models where VRAM required < your available VRAM
4. Use **Plan** on a specific model to see all quantization options
5. Go to the **Models** tab in the UI
6. Download the model (catalog models have direct download links, or paste a HuggingFace URL)
7. The model downloads to `models/` and becomes available for inference

---

## Section 8 — Troubleshooting

### Server won't start

| Symptom | Cause | Fix |
|---|---|---|
| `llama-server not found` | Binary not in `bin/` | Download from [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases/latest) and place in `bin/` |
| `error while loading shared libraries: libllama-common.so.0` | Shared libraries not in `bin/` or `LD_LIBRARY_PATH` not set | Copy all `lib*.so*` from the release archive into `bin/`, OR run `LD_LIBRARY_PATH=./bin ./linux.sh` |
| `No model found` | No model in `models/` and `config.json` has empty `model` field | Download a model from the UI Models tab, or place a `.gguf` file in `models/` |
| `Port 8090 is already in use` | Another process is using the API port | Run `lsof -i :8090` (macOS/Linux) or `netstat -ano \| findstr :8090` (Windows), kill the process, then restart |
| `Port 8091 is already in use` | Another backend instance is running | Kill existing processes: `pkill -f 'llama-server'` or `pkill -f 'mlx_backend'` |
| `Port 5173 is already in use` | Another Vite dev server is running | Kill it: `pkill -f 'vite'` |
| `npm: command not found` | Node.js not installed | Install Node.js 18+ from https://nodejs.org |
| `python3: command not found` | Python not installed or not on PATH | Install Python 3.10+ and ensure `python3` is on PATH |

### Model not appearing in UI after download

| Symptom | Cause | Fix |
|---|---|---|
| Model downloaded but not in Models list | Stale in-memory model list | Click the **↺ Refresh** button in the sidebar footer |
| Model shows but can't load | Backend not running or wrong port | Check that the backend is running on port 8091. Verify `config.json` `backend_port` matches |
| MLX model fails to load | Missing `config.json` or `.safetensors` in model directory | Ensure the model directory has both `config.json` (with `hidden_size`, `num_attention_heads`, `num_hidden_layers`, `vocab_size`) and at least one `.safetensors` file |

### Lumina Screen pipeline appears running but produces no output

| Symptom | Cause | Fix |
|---|---|---|
| No shortlisted candidates | All PDFs already in `processed.json` (dedup blocking) | Click **🔄 Re-scan Existing** in the UI, or `rm lumina_screen/processed.json` |
| No shortlisted candidates | Match threshold too high | Lower the threshold slider in the UI (try 0.40) |
| No shortlisted candidates | PDFs are image-based (no text extracted) | Use text-based PDFs or OCR them first |
| Pipeline crashes immediately | `jd.txt` missing | Create `lumina_screen/jd.txt` with job description content |
| Pipeline crashes immediately | `chroma_store` path invalid | Check `lumina_screen/config.json` — ensure `chroma_store_path` is valid |
| Pipeline crashes immediately | `sentence-transformers` not installed | Run `pip install -r lumina_screen/requirements.txt` |
| Pipeline runs but skips all files | Resume folder path wrong in config | Check `lumina_screen/config.json` — `resume_folder` should be `"./resumes"` or an absolute path within `$HOME` |

### Lumina Agent not responding

| Symptom | Cause | Fix |
|---|---|---|
| "Cannot connect to Lumina Edge API" | Backend server not running on port 8091 | Start the server with `./mac.sh`, `./linux.sh`, or `start_lumina.bat` |
| "LLM call timed out" | Model not loaded or too slow | Ensure a model is loaded. Check backend logs in `.lumina_run/mlx_backend.log` or `.lumina_run/llama_server.log` |
| "Model failed to produce valid JSON 3 times" | Model doesn't support tool-calling format | Use a model with a Jinja chat template that supports tool calls (Phi-4-mini, Gemma3-4B, Llama-3.2-3B) |
| Agent stops after 10 steps | Reached `MAX_ITERATIONS` limit | This is by design. Make the goal simpler or more specific |

### Lumina Scout /recommend returns empty list

| Symptom | Cause | Fix |
|---|---|---|
| Empty recommendations | HuggingFace unreachable | Check internet connection. Try "Force Refresh" checkbox |
| Empty recommendations | No models match the profile + hardware constraints | Try a different profile (`general` is broadest), or lower `min_speed` |
| Hardware scan shows "CPU Only" | GPU not detected | This is expected on some systems. Scout will still recommend CPU-compatible models |

### Port already in use

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE` on port 8090 | Previous Lumina instance didn't shut down cleanly | Kill stale processes: `pkill -f 'api-server.js'` and `pkill -f 'node'` in the UI directory |
| `EADDRINUSE` on port 8091 | Backend still running | `pkill -f 'llama-server'` or `pkill -f 'mlx_backend'` |
| `EADDRINUSE` on port 5173 | Vite dev server still running | `pkill -f 'vite'` |

### Dependency missing at runtime

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: pdfplumber` | Lumina Screen deps not installed | `pip install -r lumina_screen/requirements.txt` |
| `ModuleNotFoundError: sentence_transformers` | Embedding model deps not installed | `pip install -r lumina_screen/requirements.txt` |
| `ModuleNotFoundError: chromadb` | Vector DB deps not installed | `pip install -r lumina_screen/requirements.txt` |
| `ModuleNotFoundError: mlx` | MLX backend deps not installed (macOS) | `pip install -r scripts/requirements-macos.txt` |
| `ModuleNotFoundError: httpx` | Scout deps not installed | `pip install -r lumina_scout/requirements.txt` |

---

## Section 9 — Quick Reference Cheat Sheet

```
┌─────────────────────────────────────────────────────────────────┐
│                    LUMINA EDGE QUICK REFERENCE                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  START SERVER:                                                  │
│    macOS:    ./mac.sh                                           │
│    Linux:    LD_LIBRARY_PATH=./bin ./linux.sh                   │
│    Windows:  start_lumina.bat                                   │
│    API only: LD_LIBRARY_PATH=./bin ./start_api.sh               │
│              (or LD_LIBRARY_PATH=./bin ./core/launch_api.sh)    │
│                                                                 │
│  SERVER URL:  http://localhost:5173                             │
│  API URL:     http://127.0.0.1:8090                             │
│  BACKEND:     http://127.0.0.1:8091                             │
│  MANAGEMENT:  http://127.0.0.1:8081                             │
│                                                                 │
│  RESET SCREEN PIPELINE:                                         │
│    rm lumina_screen/processed.json                              │
│    rm -rf lumina_screen/chroma_store   (full reset)             │
│    Or: Click "Re-scan Existing" in UI Screen panel              │
│                                                                 │
│  jd.txt LOCATION:    lumina_screen/jd.txt                       │
│  page_hit.txt:       lumina_screen/page_hit.txt                 │
│  processed.json:     lumina_screen/processed.json               │
│  chroma_store:       lumina_screen/chroma_store/                │
│  models:             models/                                    │
│                                                                 │
│  LOGS:             .lumina_run/                                 │
│    startup.log       .lumina_run/startup.log                    │
│    MLX backend       .lumina_run/mlx_backend.log                │
│    llama-server      .lumina_run/llama_server.log               │
│    API server        .lumina_run/api_server.log                 │
│    Vite UI           .lumina_run/vite.log                       │
│                                                                 │
│  STOP ALL:          Ctrl+C in the terminal that started server   │
│                     Or: pkill -f 'llama-server' &&              │
│                         pkill -f 'api-server.js' &&             │
│                         pkill -f 'vite'                         │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```
