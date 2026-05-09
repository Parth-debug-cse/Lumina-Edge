#!/bin/bash
# ==============================================================================
# Lumina Edge — Full Stack Launcher
# Optimizes system → starts MLX backend → starts API server → launches UI
# ==============================================================================

set -e

cd "$(dirname "$0")"
ROOT="$(pwd)"
SCRIPTS="$ROOT/scripts"
UI_DIR="$ROOT/ui"
API_PORT="${LUMINA_API_PORT:-8090}"
MLX_PORT="${LUMINA_MLX_PORT:-8091}"
UI_PORT="${LUMINA_UI_PORT:-5173}"
OW_PORT="${LUMINA_OW_PORT:-8080}"

MODEL_PATH="${LUMINA_MODEL:-}"

auto_find_model() {
    # Try config.json first
    local config_model
    config_model="$(get_config startup.default_model '')"
    if [[ -n "$config_model" && -d "$config_model" || -f "$config_model" ]]; then
        echo "$config_model"
        return 0
    fi

    # Auto-detect first model in models/ directory
    if [[ -d "$ROOT/models" ]]; then
        local first_model
        first_model=$(ls -d "$ROOT/models"/*/ 2>/dev/null | head -1 | sed 's#/$##')
        if [[ -n "$first_model" && -d "$first_model" ]]; then
            echo "$first_model"
            return 0
        fi
        # Check for single .gguf file
        first_model=$(ls "$ROOT/models"/*.gguf 2>/dev/null | head -1)
        if [[ -n "$first_model" && -f "$first_model" ]]; then
            echo "$first_model"
            return 0
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
            if [[ -n "$pid" && -d "/proc/$pid" || $(ps -p "$pid" 2>/dev/null) ]]; then
                kill "$pid" 2>/dev/null || true
            fi
        done < "$PID_FILE"
        > "$PID_FILE"
    fi
    # Fallback: kill by pattern
    pkill -f 'mlx_backend.*api' 2>/dev/null || true
    pkill -f 'api-server.js' 2>/dev/null || true
    pkill -f 'vite' 2>/dev/null || true
    sleep 1
}

get_config() {
    local key="$1"
    local default="$2"
    if command -v python3 &>/dev/null && [[ -f "$ROOT/config.json" ]]; then
        python3 -c "
import json
try:
    v = json.load(open('$ROOT/config.json')).get('$key')
    print(v if v is not None else $default)
except:
    print($default)
" 2>/dev/null || echo "$default"
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

    # Rename weights.*.safetensors to model.safetensors if needed (mlx_lm requirement)
    if [[ "$(uname -s)" == "Darwin" && -d "$MODEL_PATH" ]]; then
        if ls "$MODEL_PATH"/weights.*.safetensors 2>/dev/null; then
            for f in "$MODEL_PATH"/weights.*.safetensors; do
                name=$(basename "$f")
                newname="model.safetensors"
                if [[ "$name" != "model.safetensors" ]]; then
                    mv "$f" "$MODEL_PATH/$newname"
                    log "  Renamed $name → $newname for mlx_lm compatibility"
                    break
                fi
            done
        fi
    fi

    log "Model: $MODEL_PATH"
}

# ==============================================================================
# STEP 3: Start MLX backend (Apple Silicon) or llama-server (Linux/Windows)
# ==============================================================================
start_backend() {
    log "Starting inference backend..."

    if [[ "$(uname -s)" == "Darwin" ]]; then
        BACKEND_LOG="$RUNDIR/mlx_backend.log"
        # MLX backend on dedicated port 8091; API server (8090) proxies to it
        log "  MLX backend → port $MLX_PORT"

        LUMINA_MLX_PORT="$MLX_PORT" \
        LUMINA_API_PORT="$MLX_PORT" \
        python3 "$SCRIPTS/mlx_backend.py" \
            --mode api \
            --model "$MODEL_PATH" \
            --port "$MLX_PORT" \
            >> "$BACKEND_LOG" 2>&1 &

        local mlx_pid=$!
        echo "$mlx_pid mlx_backend" >> "$PID_FILE"
        log "  MLX backend PID: $mlx_pid"

        log "  Waiting for MLX server to be ready..."
        for i in $(seq 1 30); do
            if curl -s --max-time 2 "http://127.0.0.1:$MLX_PORT/health" 2>/dev/null | grep -q 'ok'; then
                log_ok "MLX backend ready on port $MLX_PORT"
                return 0
            fi
            sleep 1
        done

        log_err "MLX backend failed to start. Check $BACKEND_LOG"
        tail -20 "$BACKEND_LOG" 2>/dev/null
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

        BACKEND_LOG="$RUNDIR/llama_server.log"
        log "  llama-server → port $API_PORT"

        "$LLAMA_SERVER" \
            -m "$MODEL_PATH" \
            --port "$API_PORT" \
            --host 127.0.0.1 \
            --ctx-size "$CTX_SIZE" \
            --n-gpu-layers "$N_GPU_LAYERS" \
            --batch-size "$BATCH_SIZE" \
            --ubatch-size "$UBATCH_SIZE" \
            --flash-attn \
            >> "$BACKEND_LOG" 2>&1 &

        local ll_pid=$!
        echo "$ll_pid llama_server" >> "$PID_FILE"
        log "  llama-server PID: $ll_pid"

        log "  Waiting for llama-server to be ready..."
        for i in $(seq 1 30); do
            if curl -s --max-time 2 "http://127.0.0.1:$API_PORT/v1/models" 2>/dev/null | grep -q 'model'; then
                log_ok "llama-server ready on port $API_PORT"
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
    cd "$UI_DIR"

    MLX_PORT="${LUMINA_MLX_PORT:-8091}" \
    LUMINA_API_PORT="$API_PORT" \
    LUMINA_MLX_PORT="$MLX_PORT" \
    node api-server.js >> "$API_LOG" 2>&1 &
    local api_pid=$!
    echo "$api_pid api_server" >> "$PID_FILE"
    log "  API server PID: $api_pid"

    # Wait for the Node API server (secondary port 8081 first, then primary)
    log "  Waiting for API server..."
    for i in $(seq 1 20); do
        # Check secondary port (always starts first)
        if curl -s --max-time 2 "http://127.0.0.1:8081/api/health" 2>/dev/null | grep -q 'ok'; then
            log_ok "API gateway ready (primary: $API_PORT, mgmt: 8081)"
            return 0
        fi
        # Also accept if primary port is serving (already running from before)
        if curl -s --max-time 2 "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null | grep -q 'ok'; then
            log_ok "API gateway already running (primary: $API_PORT)"
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
    cd "$UI_DIR"

    npm run dev >> "$UI_LOG" 2>&1 &
    local ui_pid=$!
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

    # Check Docker first
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'open-webui'; then
        log "  OpenWebUI detected via Docker (port $OW_PORT)"
        if curl -s --max-time 3 "http://127.0.0.1:$OW_PORT/" 2>/dev/null | grep -q 'html'; then
            log_ok "OpenWebUI ready at http://127.0.0.1:$OW_PORT"
            log "  Configure OpenWebUI to connect to Lumina:"
            log "    1. Open http://127.0.0.1:$OW_PORT in your browser"
            log "    2. Sign up / log in, then go to Settings → Connections"
            log "    3. Set API URL to: http://host.docker.internal:$API_PORT/v1"
            log "    4. API Key: any value (Lumina accepts all keys)"
            log ""
            return 0
        fi
    fi

    # Check local installation
    if command -v openwebui &>/dev/null; then
        log "  OpenWebUI CLI found"
    elif [[ -d "/Applications/OpenWebUI.app" ]]; then
        log "  OpenWebUI app found at /Applications/OpenWebUI.app"
    elif [[ -d "$HOME/open-webui" ]]; then
        log "  OpenWebUI found at $HOME/open-webui"
    else
        log "  OpenWebUI not detected (not installed locally or via Docker)"
        log "  Install via Docker: docker run -d -p $OW_PORT:8080 --add-host=host.docker.internal:host-gateway openwebui/openwebui:latest"
        return 0
    fi

    # Start local OpenWebUI (existing logic)
    OW_LOG="$RUNDIR/openwebui.log"
    if [[ -d "$HOME/open-webui" ]]; then
        cd "$HOME/open-webui"
        LUMINA_API_KEY="${LUMINA_API_KEY:-lumina-openai-key}"
        LUMINA_API_URL="http://127.0.0.1:$API_PORT/v1"
        LUMINA_TITLE="${LUMINA_TITLE:-Lumina Edge}"

        OLLAMA_BASE_URL="$LUMINA_API_URL" \
        OPENAI_API_BASE_URL="$LUMINA_API_URL" \
        OPENAI_API_KEY="$LUMINA_API_KEY" \
        WEBUI_NAME="$LUMINA_TITLE" \
        python -m uvicorn openwebui.main:app \
            --host 127.0.0.1 \
            --port "$OW_PORT" \
            --root-path "/" \
            >> "$OW_LOG" 2>&1 &

        local ow_pid=$!
        echo "$ow_pid openwebui" >> "$PID_FILE"
        log "  OpenWebUI PID: $ow_pid"

        log "  Waiting for OpenWebUI..."
        for i in $(seq 1 30); do
            if curl -s --max-time 3 "http://127.0.0.1:$OW_PORT/" 2>/dev/null | grep -q 'html'; then
                log_ok "OpenWebUI ready at http://127.0.0.1:$OW_PORT"
                log "  Configure: Settings → Connections → API Base URL → $LUMINA_API_URL"
                return 0
            fi
            sleep 1
        done

        log_err "OpenWebUI failed to start. Check $OW_LOG"
        tail -10 "$OW_LOG" 2>/dev/null
    fi
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
    echo "  To stop:     kill \$(cat $PID_FILE)"
    echo "============================================================"
    echo ""

    if [[ "$(uname -s)" == "Darwin" ]]; then
        open "http://localhost:$UI_PORT" 2>/dev/null || true
    fi
}

# ==============================================================================
# MAIN
# ==============================================================================
main() {
    echo "" > "$RUNDIR/startup.log"
    log "============================================================"
    log "  Lumina Edge Launcher"
    log "============================================================"
    log "  Root:     $ROOT"
    log "  Platform: $(uname -s) $(uname -m)"
    log "  Model:    ${MODEL_PATH:-not set}"
    log ""

    stop_existing

    optimize_system || log_err "Optimizer had warnings (non-fatal)"

    check_model || exit 1

    start_backend || exit 1

    start_api_server || exit 1

    start_ui || exit 1

    setup_openwebui

    print_summary

    log "Startup complete. Press Ctrl+C to stop all services."
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