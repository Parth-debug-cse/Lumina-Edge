# Lumina Edge — Complete Run & Test Guide (macOS)

## What `mac.sh` Does (Full Pipeline)

```
mac.sh
  ├── 1. resolve_ports        → Reads ports from env vars or config.json
  ├── 2. stop_existing        → Kills any leftover processes
  ├── 3. optimize_system      → MLX Metal tuning, App Nap disable, memory prep
  ├── 4. check_model          → Auto-detects MLX model or uses --model flag
  ├── 5. start_backend        → Launches mlx_backend.py on MLX_PORT (8091)
  ├── 6. start_api_server     → Launches api-server.js on API_PORT (8090)
  ├── 7. start_ui             → Launches Vite dev server on UI_PORT (5173)
  ├── 8. setup_openwebui      → Starts OpenWebUI Docker container on OW_PORT (8080)
  └── 9. print_summary        → Opens browser, shows all URLs
```

---

## Step-by-Step Commands

### Step 1: Verify Prerequisites

```bash
python3 --version   # Need 3.10+
node --version      # Need 18+
npm --version       # Need 9+
```

### Step 2: Run Smoke Tests (Structural Validation)

```bash
cd /path/to/2026-Lumina-Edge-LLM-Inference-Framework
python3 test_smoke.py
```

Expected: `Ran 21 tests in ~0.02s — OK`

### Step 3: Install Node Dependencies

```bash
cd ui && npm install && cd ..
```

### Step 4: Run the Full Launcher

```bash
# Auto-detects model in ./models/
bash mac.sh

# Or specify a model explicitly
bash mac.sh --model models/TinyLlama-1.1B-Chat-v1.0-4bit
```

### Step 5: Watch the Startup Log

You should see this sequence:

```
[Lumina] ============================================================
[Lumina]   Lumina Edge Launcher
[Lumina] ============================================================
[Lumina]   Root:     /path/to/project
[Lumina]   Platform: Darwin arm64
[Lumina]   Model:    not set
[Lumina]
[Lumina] Stopping any existing Lumina processes...
[Lumina] Optimizing system for MLX inference...
[Lumina]   Running MLX Metal optimizer...
[Lumina]   Applying macOS kernel tuning...
[Lumina] ✓ System optimisation complete
[Lumina]   No model specified — auto-detecting...
[Lumina]   Renamed weights.00.safetensors → model.safetensors for mlx_lm compatibility
[Lumina]   Model: /path/to/models/TinyLlama-1.1B-Chat-v1.0-4bit
[Lumina] Starting MLX inference backend...
[Lumina]   MLX backend PID: 12345
[Lumina]   Waiting for MLX server to be ready...
[Lumina] ✓ MLX backend ready on port 8091
[Lumina] Starting Lumina Core API gateway...
[Lumina]   API server PID: 12346
[Lumina]   Waiting for API server...
[Lumina] ✓ API gateway ready (primary: 8090, mgmt: 8081)
[Lumina] Starting Lumina Core UI...
[Lumina]   Vite PID: 12347
[Lumina]   Waiting for Vite dev server...
[Lumina] ✓ Lumina Core UI ready at http://localhost:5173
[Lumina] Checking OpenWebUI...
[Lumina]   Docker not found. Install Docker or Colima to run OpenWebUI.
[Lumina]
[Lumina] ============================================================
[Lumina]   Lumina Edge — All systems ready
[Lumina] ============================================================
[Lumina]
[Lumina]   Model:       /path/to/models/TinyLlama-1.1B-Chat-v1.0-4bit
[Lumina]   Backend:     http://127.0.0.1:8091
[Lumina]   API:         http://127.0.0.1:8090
[Lumina]   Lumina UI:   http://localhost:5173
[Lumina]   OpenWebUI:   http://127.0.0.1:8080
[Lumina]
[Lumina]   Logs:        /path/to/.lumina_run/
[Lumina]   PIDs:        /path/to/.lumina_run/pids.txt
[Lumina]
[Lumina] ============================================================
[Lumina]
[Lumina] Startup complete. Press Ctrl+C to stop all services.
```

### Step 6: Test All Endpoints (in a new terminal)

```bash
# Health checks
curl -s http://127.0.0.1:8091/health | python3 -m json.tool        # MLX backend
curl -s http://127.0.0.1:8090/api/health | python3 -m json.tool    # API gateway
curl -s http://127.0.0.1:8081/api/health | python3 -m json.tool    # Management port

# System info
curl -s http://127.0.0.1:8090/api/system-info | python3 -m json.tool

# MLX model loaded
curl -s http://127.0.0.1:8091/v1/models | python3 -m json.tool

# API proxy to MLX
curl -s http://127.0.0.1:8090/v1/models | python3 -m json.tool

# Config
curl -s http://127.0.0.1:8090/api/config | python3 -m json.tool

# Router status
curl -s http://127.0.0.1:8090/api/router/status | python3 -m json.tool
```

### Step 7: Test Inference (Chat Completion)

```bash
curl -s http://127.0.0.1:8091/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "local",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "max_tokens": 50,
    "temperature": 0.7
  }' | python3 -m json.tool
```

### Step 8: Open the UI

Browser → **http://localhost:5173**

The UI should show:
- Chat interface
- Models tab (shows TinyLlama model)
- System info panel
- Settings panel

### Step 9: Stop Everything

Press **Ctrl+C** in the terminal running `mac.sh`.

Or from another terminal:
```bash
pkill -f "mlx_backend.*api"
pkill -f "api-server.js"
pkill -f "vite"
```

---

## Troubleshooting

### Port already in use
```bash
lsof -i :8090 -i :8091 -i :5173
kill $(lsof -t -i:8090) 2>/dev/null
kill $(lsof -t -i:8091) 2>/dev/null
kill $(lsof -t -i:5173) 2>/dev/null
```

### MLX backend won't start
```bash
cat .lumina_run/mlx_backend.log | tail -50
```

### API server won't start
```bash
cat .lumina_run/api_server.log | tail -50
```

### UI won't start
```bash
cat .lumina_run/vite.log | tail -20
```

### Model not auto-detected
```bash
# Check if model directory is valid
ls models/TinyLlama-1.1B-Chat-v1.0-4bit/config.json
ls models/TinyLlama-1.1B-Chat-v1.0-4bit/*.safetensors

# Or specify explicitly
bash mac.sh --model models/TinyLlama-1.1B-Chat-v1.0-4bit
```
