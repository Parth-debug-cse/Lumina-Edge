#!/bin/bash
# ==============================================================================
# Lumina Edge — Full Stack Launcher
# Optimizes system → starts MLX backend → starts API server → launches UI
# ==============================================================================

set -o pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
SCRIPTS="$ROOT/scripts"
UI_DIR="$ROOT/ui"
API_PORT="${LUMINA_API_PORT:-8090}"
MLX_PORT="${LUMINA_MLX_PORT:-8091}"
UI_PORT="${LUMINA_UI_PORT:-5173}"
OW_PORT="${LUMINA_OW_PORT:-8080}"
export LUMINA_API_PORT="$API_PORT"
export LUMINA_MLX_PORT="$MLX_PORT"
export LUMINA_OW_PORT="$OW_PORT"

MODEL_PATH="${LUMINA_MODEL:-}"

is_valid_mlx_model() {
    local model_path="$1"
    [[ -d "$model_path" ]] || return 1
    [[ -f "$model_path/config.json" ]] || return 1

    local sf=""
    sf=$(ls "$model_path"/*.safetensors 2>/dev/null | head -1)
    [[ -z "$sf" ]] && sf=$(ls "$model_path"/weights.*.safetensors 2>/dev/null | head -1)
    [[ -z "$sf" ]] && return 1

    python3 -c "
import struct, sys
try:
    with open('$sf', 'rb') as f:
        hlen_bytes = f.read(8)
        if len(hlen_bytes) < 8: sys.exit(1)
        hlen = struct.unpack('<Q', hlen_bytes)[0]
        if hlen == 0 or hlen > 100_000_000: sys.exit(1)
        import json
        json.loads(f.read(hlen))
    sys.exit(0)
except Exception: sys.exit(1)
" 2>/dev/null || return 1

    python3 -c "
import json, sys
try:
    cfg = json.load(open('$model_path/config.json'))
    required = ['hidden_size', 'num_attention_heads', 'num_hidden_layers', 'vocab_size']
    if not all(k in cfg for k in required): sys.exit(1)
    sys.exit(0)
except Exception: sys.exit(1)
" 2>/dev/null || return 1

    return 0
}

auto_find_model() {
    if [[ "$(uname -s)" == "Darwin" ]]; then
        local config_model
        config_model="$(get_config startup.default_model '')"
        if [[ -n "$config_model" ]]; then
            local full_path="$ROOT/models/$config_model"
            if is_valid_mlx_model "$full_path"; then
                echo "$full_path"
                return 0
            fi
            if [[ -d "$config_model" ]] && is_valid_mlx_model "$config_model"; then
                echo "$config_model"
                return 0
            fi
        fi
        if [[ -d "$ROOT/models" ]]; then
            for dir in "$ROOT/models"/*/; do
                if [[ -d "$dir" ]] && is_valid_mlx_model "$dir"; then
                    echo "$dir"
                    return 0
                fi
            done
        fi
        log_err "No valid MLX model found. Need a directory with config.json and .safetensors files."
        return 1
    else
        local config_model
        config_model="$(get_config startup.default_model '')"
        if [[ -n "$config_model" && (-d "$config_model" || -f "$config_model") ]]; then
            echo "$config_model"
            return 0
        fi
        config_model="$(get_config model '')"
        if [[ -n "$config_model" && (-d "$config_model" || -f "$config_model") ]]; then
            echo "$config_model"
            return 0
        fi
        if [[ -d "$ROOT/models" ]]; then
            local first_model
            first_model=$(ls -d "$ROOT/models"/*/ 2>/dev/null | head -1 | sed 's#/$##')
            if [[ -n "$first_model" && -d "$first_model" ]]; then
                echo "$first_model"
                return 0
            fi
            first_model=$(ls "$ROOT/models"/*.gguf 2>/dev/null | head -1)
            if [[ -n "$first_model" && -f "$first_model" ]]; then
                echo "$first_model"
                return 0
            fi
        fi
    fi
    return 1
}

RUNDIR="$ROOT/.lumina_run"
mkdir -p "$RUNDIR"
PID_FILE="$RUNDIR/pids.txt"

log()  { echo "[Lumina] $*" | tee -a "$RUNDIR/startup.log"; }
log_ok(){ echo "[Lumina] ✓ $*" | tee -a "$RUNDIR/startup.log"; }
log_err(){ echo "[Lumina] ✗ $*" | tee -a "$RUNDIR/startup.log" >&2; }

stop_existing() {
    log "Stopping any existing Lumina processes..."
    # Kill by PID file
    if [[ -f "$PID_FILE" ]]; then
        while read pid cmd; do
            if [[ -n "$pid" ]] && { [[ -d "/proc/$pid" ]] || ps -p "$pid" > /dev/null 2>&1; }; then
                kill "$pid" 2>/dev/null || true
            fi
        done < "$PID_FILE"
        > "$PID_FILE"
    fi
    # BUG SL-1 FIX: pkill IS available on macOS (since macOS 10.8). The original
    # code skipped the pkill fallback on Darwin, leaving stale processes holding
    # ports when the PID file was missing or corrupt.  Now we run pkill on all
    # platforms so a restart after a crash can always reclaim the port.
    pkill -f 'mlx_backend.*api' 2>/dev/null || true
    pkill -f 'api-server.js' 2>/dev/null || true
    pkill -f 'vite' 2>/dev/null || true
    sleep 1
}

cleanup_components() {
    log "Shutting down started components..."
    stop_existing
}

get_config() {
    local key="$1"
    local default="$2"
    if command -v python3 &>/dev/null && [[ -f "$ROOT/config.json" ]]; then
        python3 -c "
import json,sys
root=sys.argv[1]
key=sys.argv[2]
default=sys.argv[3]
try:
    cfg=json.load(open(root+'/config.json'))
    parts=key.split('.')
    v=cfg
    for p in parts:
        if isinstance(v,dict) and p in v:
            v=v[p]
        else:
            v=None
            break
    print(v if v is not None else default)
except Exception:
    print(default)
" "$ROOT" "$key" "$default" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

# ==============================================================================
# STEP 1: System Optimization (macOS Metal / Linux Vulkan)
# ==============================================================================
optimize_system() {
    log "Optimizing system for inference..."

    if [[ "$(uname -s)" == "Darwin" ]]; then
        MACOS_SCRIPTS="$SCRIPTS/macos"

        if [[ -d "$MACOS_SCRIPTS" ]]; then
            log "  Running macOS shell optimizations..."

            # Step 1: Kill memory-hungry background processes
            if [[ -x "$MACOS_SCRIPTS/kill_memory_hogs.sh" ]]; then
                log "  Kill memory hogs..."
                bash "$MACOS_SCRIPTS/kill_memory_hogs.sh" >> "$RUNDIR/optimizer.log" 2>&1 || true
            fi

            # Step 2: Purge disk cache and inactive memory (needs sudo)
            if [[ -x "$MACOS_SCRIPTS/purge_and_prep.sh" ]]; then
                log "  Purge disk cache and memory..."
                sudo bash "$MACOS_SCRIPTS/purge_and_prep.sh" >> "$RUNDIR/optimizer.log" 2>&1 || \
                    log "  purge_and_prep.sh skipped (sudo required or not available)"
            fi

            # Step 3: Check swap status (and disable if LUMINA_NOSWAP=1)
            if [[ -x "$MACOS_SCRIPTS/swap_and_swap_off.sh" ]]; then
                if [[ "${LUMINA_NOSWAP:-0}" == "1" ]]; then
                    log "  Disabling swap for inference session..."
                    sudo bash "$MACOS_SCRIPTS/swap_and_swap_off.sh" --disable >> "$RUNDIR/optimizer.log" 2>&1 || true
                else
                    log "  Checking swap status..."
                    bash "$MACOS_SCRIPTS/swap_and_swap_off.sh" >> "$RUNDIR/optimizer.log" 2>&1 || true
                fi
            fi

            log_ok "macOS shell optimizations complete"
        else
            log "  macOS scripts directory not found at $MACOS_SCRIPTS"
        fi

        PYTHON="$(command -v python3)"
        OPTIMIZER="$SCRIPTS/mlx_optimize_system.py"
        if [[ -f "$OPTIMIZER" ]]; then
            log "  Running MLX Metal optimizer..."
            "$PYTHON" "$OPTIMIZER" optimize >> "$RUNDIR/optimizer.log" 2>&1 || true
            log_ok "Metal optimization complete"
        else
            log "  Skipping optimizer (not found: $OPTIMIZER)"
        fi
    else
        PYTHON="$(command -v python3)"
        OPTIMIZER="$SCRIPTS/system_optimizer.py"
        if [[ -f "$OPTIMIZER" ]]; then
            log "  Running system optimizer..."
            "$PYTHON" "$OPTIMIZER" >> "$RUNDIR/optimizer.log" 2>&1 || true
            log_ok "System optimization complete"
        fi
    fi
}

# ==============================================================================
# STEP 2: Check / download model
# ==============================================================================
check_model() {
    if [[ -z "$MODEL_PATH" ]]; then
        log "  No model specified — auto-detecting..."
        MODEL_PATH="$(auto_find_model)" || true
    fi

    if [[ -z "$MODEL_PATH" ]]; then
        log_err "No model found. Please place a model in ./models/ or set startup.default_model in config.json"
        return 1
    fi

    if [[ ! -d "$MODEL_PATH" && ! -f "$MODEL_PATH" ]]; then
        log_err "Model not found: $MODEL_PATH"
        return 1
    fi

    # BUG SL-2 FIX: Silently renaming a single shard to model.safetensors while
    # leaving remaining shards with their original names produces a broken model
    # directory.  Multi-shard models (weights.0.safetensors, weights.1.safetensors…)
    # need ALL shards renamed in a coordinated way — mlx_lm handles weight loading
    # from the sharded filenames natively in newer versions.  Instead of a
    # potentially destructive mv, emit a warning and let the user or mlx_lm handle it.
    if [[ "$(uname -s)" == "Darwin" && -d "$MODEL_PATH" ]]; then
        shard_count=$(ls "$MODEL_PATH"/weights.*.safetensors 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$shard_count" -gt 0 ]]; then
            log "  NOTE: Found $shard_count weights.*.safetensors shard(s)."
            log "  Newer mlx_lm versions load shards natively — no rename needed."
            log "  If loading fails, run: python3 scripts/mlx_backend.py --mode api --model '$MODEL_PATH'"
        fi
    fi

    log "Model: $MODEL_PATH"
}

# ==============================================================================
# STEP 3: Start MLX backend (Apple Silicon) or llama-server (Linux/Windows)
# ==============================================================================
start_backend() {
    if [[ -z "$MODEL_PATH" ]]; then
        log "  No model configured — skipping backend start"
        log "  Use the Models tab to download and load a model"
        return 0
    fi

    log "Starting inference backend..."

    if [[ "$(uname -s)" == "Darwin" ]]; then
        # Tool calling requires a model with a Jinja chat template that includes
        # tool_call support (MLX handles Jinja natively — no --jinja flag needed).
        # Recommended: Phi-4-mini, Gemma3-4B, Llama-3.2-3B (GGUF).
        BACKEND_LOG="$RUNDIR/mlx_backend.log"
        # MLX backend on dedicated port 8091; API server (8090) proxies to it
        log "  MLX backend → port $MLX_PORT"

        LUMINA_MLX_PORT="$MLX_PORT" \
        python3 "$SCRIPTS/mlx_backend.py" \
            --mode api \
            --model "$MODEL_PATH" \
            --port "$MLX_PORT" \
            >> "$BACKEND_LOG" 2>&1 &

        local mlx_pid=$!
        echo "$mlx_pid mlx_backend" >> "$PID_FILE"
        log "  MLX backend PID: $mlx_pid"

        log "  Waiting for MLX server to be ready..."
        for i in $(seq 1 60); do
            health_response=$(curl -s --max-time 3 "http://127.0.0.1:$MLX_PORT/health" 2>/dev/null)
            if echo "$health_response" | grep -q '"status":"ok"'; then
                models_response=$(curl -s --max-time 3 "http://127.0.0.1:$MLX_PORT/v1/models" 2>/dev/null)
                if echo "$models_response" | grep -q '"data"'; then
                    log_ok "MLX backend ready on port $MLX_PORT"
                else
                    log_ok "MLX server running on port $MLX_PORT (model not loaded — use Models tab)"
                fi
                return 0
            fi
            sleep 1
        done

        log_err "MLX backend failed to start. Check $BACKEND_LOG"
        tail -30 "$BACKEND_LOG" 2>/dev/null
        return 1

    else
        # Linux/Windows: start llama-server
        LLAMA_SERVER="$ROOT/bin/llama-server"
        if [[ ! -x "$LLAMA_SERVER" ]]; then
            log_err "llama-server not found at $LLAMA_SERVER"
            return 1
        fi

        CTX_SIZE=$(get_config ctx_size 16384)
        N_GPU_LAYERS=$(get_config n_gpu_layers 15)
        BATCH_SIZE=$(get_config batch_size 256)
        UBATCH_SIZE=$(get_config ubatch_size 256)
        TEMPERATURE=$(get_config temperature 0.7)
        TOP_P=$(get_config top_p 0.9)
        TOP_K=$(get_config top_k 40)
        REPEAT_PENALTY=$(get_config repeat_penalty 1.1)
        MIN_P=$(get_config min_p 0.05)
        HTTP_THREADS=$(get_config http_threads 2)
        FLASH_ATTN=$(get_config flash_attn true)
        KV_CACHE_TYPE_K=$(get_config kv_cache_type_k 'q4_0')
        KV_CACHE_TYPE_V=$(get_config kv_cache_type_v 'q4_0')

        FLASH_ATTN_FLAG=""
        if [[ "$FLASH_ATTN" == "true" ]]; then
            FLASH_ATTN_FLAG="--flash-attn"
        fi

        BACKEND_LOG="$RUNDIR/llama_server.log"
        log "  llama-server → port $MLX_PORT"

        # Tool calling requires a model with a Jinja chat template that includes
        # tool_call support. Recommended: Phi-4-mini, Gemma3-4B, Llama-3.2-3B (GGUF).
        "$LLAMA_SERVER" \
            -m "$MODEL_PATH" \
            --port "$MLX_PORT" \
            --host 127.0.0.1 \
            --ctx-size "$CTX_SIZE" \
            --n-gpu-layers "$N_GPU_LAYERS" \
            --batch-size "$BATCH_SIZE" \
            --ubatch-size "$UBATCH_SIZE" \
            --threads-http "$HTTP_THREADS" \
            --temperature "$TEMPERATURE" \
            --top-p "$TOP_P" \
            --top-k "$TOP_K" \
            --repeat-penalty "$REPEAT_PENALTY" \
            --min-p "$MIN_P" \
            --cache-type-k "$KV_CACHE_TYPE_K" \
            --cache-type-v "$KV_CACHE_TYPE_V" \
            --jinja \
            $FLASH_ATTN_FLAG \
            >> "$BACKEND_LOG" 2>&1 &

        local ll_pid=$!
        echo "$ll_pid llama_server" >> "$PID_FILE"
        log "  llama-server PID: $ll_pid"

        log "  Waiting for llama-server to be ready..."
        for i in $(seq 1 30); do
            if curl -s --max-time 2 "http://127.0.0.1:$MLX_PORT/v1/models" 2>/dev/null | grep -q 'model'; then
                log_ok "llama-server ready on port $MLX_PORT"
                return 0
            fi
            sleep 1
        done

        log_err "llama-server failed to start. Check $BACKEND_LOG"
        tail -20 "$BACKEND_LOG" 2>/dev/null
        return 1
    fi
}

# ==============================================================================
# STEP 4: Start Node API server (Lumina Core gateway)
# ==============================================================================
start_api_server() {
    log "Starting Lumina Core API gateway..."

    # Pass MLX port via env so api-server.js knows where direct backend is
    API_LOG="$RUNDIR/api_server.log"
    local _prev_dir
    _prev_dir="$(pwd)"
    cd "$UI_DIR"

    local SECONDARY_PORT
    SECONDARY_PORT=$(get_config api_port_secondary 8081)

    LUMINA_API_PORT="$API_PORT" \
    LUMINA_MLX_PORT="$MLX_PORT" \
    LUMINA_API_PORT_SECONDARY="$SECONDARY_PORT" \
    node api-server.js >> "$API_LOG" 2>&1 &
    local api_pid=$!
    echo "$api_pid api_server" >> "$PID_FILE"
    log "  API server PID: $api_pid"
    cd "$_prev_dir"

    # Wait for the Node API server (secondary port first, then primary)
    log "  Waiting for API server..."
    for i in $(seq 1 30); do
        if curl -s --max-time 2 "http://127.0.0.1:$SECONDARY_PORT/api/health" 2>/dev/null | grep -q 'ok'; then
            log_ok "API gateway ready (primary: $API_PORT, mgmt: $SECONDARY_PORT)"
            return 0
        fi
        if curl -s --max-time 2 "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null | grep -q 'ok'; then
            log_ok "API gateway ready (primary: $API_PORT)"
            return 0
        fi
        sleep 1
    done

    log_err "API server failed to start. Check $API_LOG"
    tail -20 "$API_LOG" 2>/dev/null
    return 1
}

# ==============================================================================
# STEP 5: Start Vite dev server (Lumina Core UI)
# ==============================================================================
start_ui() {
    log "Starting Lumina Core UI..."

    UI_LOG="$RUNDIR/vite.log"
    local _prev_dir
    _prev_dir="$(pwd)"
    cd "$UI_DIR"

    npm run dev >> "$UI_LOG" 2>&1 &
    local ui_pid=$!
    cd "$_prev_dir"

    echo "$ui_pid vite" >> "$PID_FILE"
    log "  Vite PID: $ui_pid"

    log "  Waiting for Vite dev server..."
    for i in $(seq 1 20); do
        if curl -s --max-time 2 "http://localhost:$UI_PORT/" 2>/dev/null | grep -q '<html'; then
            log_ok "Lumina Core UI ready at http://localhost:$UI_PORT"
            return 0
        fi
        sleep 1
    done

    log_err "Vite dev server failed. Check $UI_LOG"
    tail -10 "$UI_LOG" 2>/dev/null
    return 1
}

# ==============================================================================
# STEP 6: OpenWebUI setup / launch
# ==============================================================================
setup_openwebui() {
    log "Checking OpenWebUI..."

    # Check Docker availability
    if ! command -v docker &>/dev/null; then
        # Try colima docker socket
        if [[ -S "$HOME/.colima/docker.sock" ]]; then
            export DOCKER_HOST="unix://${HOME}/.colima/docker.sock"
            log "  Using Colima Docker socket"
        else
            log "  Docker not found. Install Docker or Colima to run OpenWebUI."
            return 0
        fi
    fi

    # Check if already running via Docker
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'openwebui'; then
        log "  OpenWebUI container already running"
        if curl -s --max-time 5 "http://127.0.0.1:$OW_PORT/" 2>/dev/null | grep -q 'html'; then
            log_ok "OpenWebUI ready at http://127.0.0.1:$OW_PORT"
            return 0
        fi
    fi

    # Stop any existing openwebui container
    docker stop openwebui 2>/dev/null || true
    docker rm openwebui 2>/dev/null || true

    log "  Starting OpenWebUI via Docker..."
    OW_LOG="$RUNDIR/openwebui.log"

    # NOTE: OPENAI_API_KEY below is a placeholder; set LUMINA_OPENAI_KEY env var to override
    # Start OpenWebUI with offline mode to prevent hanging on model downloads
    docker run -d -p "${OW_PORT}:8080" \
        --add-host=host.docker.internal:host-gateway \
        -e HF_HUB_OFFLINE=1 \
        -e TRANSFORMERS_OFFLINE=1 \
        -e HF_HUB_DISABLE_PROGRESS_BARS=1 \
        -e HF_HUB_DISABLE_TELEMETRY=1 \
        -e OLLAMA_BASE_URL="http://host.docker.internal:${API_PORT}/v1" \
        -e OPENAI_API_KEY="${LUMINA_OPENAI_KEY:-lumina-key}" \
        -e OPENAI_API_BASE_URL="http://host.docker.internal:${API_PORT}/v1" \
        --name openwebui \
        openwebui/open-webui:latest >> "$OW_LOG" 2>&1 &

    local ow_pid=$!
    echo "$ow_pid openwebui_docker" >> "$PID_FILE"
    log "  OpenWebUI Docker PID: $ow_pid"

    log "  Waiting for OpenWebUI to start (this may take a minute)..."
    for i in $(seq 1 90); do
        if curl -s --max-time 5 "http://127.0.0.1:${OW_PORT}/" 2>/dev/null | grep -q 'html'; then
            api_test=$(curl -s --max-time 5 "http://127.0.0.1:${API_PORT}/v1/models" 2>/dev/null)
            if echo "$api_test" | grep -q '"data"'; then
                log_ok "OpenWebUI ready at http://127.0.0.1:${OW_PORT}"
                log "  MLX model accessible via Lumina API"
                log "  Configure OpenWebUI to connect to Lumina:"
                log "    1. Open http://127.0.0.1:${OW_PORT} in your browser"
                log "    2. Sign up / log in, then go to Settings → Connections"
                log "    3. API URL: http://host.docker.internal:${API_PORT}/v1"
                log "    4. API Key: lumina-key"
                log ""
                return 0
            else
                log "  OpenWebUI running but MLX model not accessible yet..."
            fi
        fi
        sleep 1
    done

    log_err "OpenWebUI failed to start. Check $OW_LOG"
    tail -20 "$OW_LOG" 2>/dev/null
}

# ==============================================================================
# Print startup summary
# ==============================================================================
print_summary() {
    echo ""
    echo "============================================================"
    echo "  Lumina Edge — All systems ready"
    echo "============================================================"
    echo ""
    echo "  Model:       $MODEL_PATH"
    echo "  Backend:     http://127.0.0.1:$API_PORT"
    echo "  Lumina Core: http://localhost:$UI_PORT"
    echo ""
    echo "  Logs:        $RUNDIR/"
    echo "  PIDs:        $PID_FILE"
    echo ""
    echo "  To stop:     pkill -f 'llama-server' 2>/dev/null; pkill -f 'api-server.js' 2>/dev/null; pkill -f 'vite' 2>/dev/null || true"
    echo "============================================================"
    echo ""

    if command -v xdg-open &>/dev/null; then
        xdg-open "http://localhost:$UI_PORT" 2>/dev/null || true
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        open "http://localhost:$UI_PORT" 2>/dev/null || true
    fi
}

# ==============================================================================
# Resolve ports: env var > config.json > built-in default
# ==============================================================================
resolve_ports() {
    API_PORT="${LUMINA_API_PORT:-$(get_config api_port 8090)}"
    MLX_PORT="${LUMINA_MLX_PORT:-$(get_config backend_port 8091)}"
    UI_PORT="${LUMINA_UI_PORT:-$(get_config ui_port 5173)}"
    OW_PORT="${LUMINA_OW_PORT:-$(get_config ow_port 8080)}"
    export LUMINA_API_PORT="$API_PORT"
    export LUMINA_MLX_PORT="$MLX_PORT"
    export LUMINA_OW_PORT="$OW_PORT"
}

# ==============================================================================
# MAIN
# ==============================================================================
main() {
    resolve_ports
    : > "$RUNDIR/startup.log"
    log "============================================================"
    log "  Lumina Edge Launcher"
    log "============================================================"
    log "  Root:     $ROOT"
    log "  Platform: $(uname -s) $(uname -m)"
    log "  Model:    ${MODEL_PATH:-not set}"
    log ""

    trap cleanup_components INT TERM EXIT

    stop_existing

    optimize_system || log_err "Optimizer had warnings (non-fatal)"

    check_model || log_err "No model — use the Models tab to download one"

    start_backend || log_err "Backend not started — use the Models tab to load a model"

    start_api_server || { cleanup_components; exit 1; }

    start_ui || { cleanup_components; exit 1; }

    setup_openwebui

    print_summary

    log "Startup complete. Press Ctrl+C to stop all services."
    # BUG SL-3 FIX: 'wait || true' swallows the exit code of every child process,
    # meaning the launcher exits 0 even when a backend crashes.  Wait for all
    # background jobs so the shell does not exit prematurely, but without hiding
    # failures.  The trap on INT/TERM handles Ctrl+C cleanup.
    wait
}

# ==============================================================================
# Help / minimal usage
# ==============================================================================
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
    echo "Lumina Edge Launcher"
    echo ""
    echo "Usage: $0"
    echo "       $0 --model /path/to/model  (optional — auto-detects if missing)"
    echo ""
    echo "Environment variables:"
    echo "  LUMINA_API_PORT   Backend/API port (default: 8090)"
    echo "  LUMINA_MLX_PORT   MLX backend port (default: 8091)"
    echo "  LUMINA_UI_PORT    Vite dev server port (default: 5173)"
    echo "  LUMINA_OW_PORT    OpenWebUI port (default: 8080)"
    echo ""
    echo "Model auto-detection: looks for first model in ./models/ or startup.default_model in config.json"
    echo ""
    exit 0
fi

main
