#!/bin/bash
# ==============================================================================
# mac.sh — Lumina Edge Launcher for macOS (Apple Silicon / MLX)
# Optimizes system → starts MLX backend → starts API server → launches UI
# Fully replaces start_lumina.sh on macOS.
# ==============================================================================

cd "$(dirname "$0")" || { echo "[Lumina] ✗ Failed to cd to script directory"; exit 1; }
ROOT="$(pwd)"
SCRIPTS="$ROOT/scripts"
UI_DIR="$ROOT/ui"
MODEL_PATH="${LUMINA_MODEL:-}"

# Parse CLI args
while [[ $# -gt 0 ]]; do
    case "${1:-}" in
        --model)
            MODEL_PATH="$2"
            shift 2
            ;;
        --help|-h)
            echo "Lumina Edge Launcher (macOS)"
            echo ""
            echo "Usage: $0 [--model /path/to/model] [--help]"
            echo ""
            echo "Environment variables:"
            echo "  LUMINA_API_PORT   Backend/API port (default: 8090)"
            echo "  LUMINA_MLX_PORT   MLX backend port (default: 8091)"
            echo "  LUMINA_UI_PORT    Vite dev server port (default: 5173)"
            echo "  LUMINA_OW_PORT    OpenWebUI port (default: 8080)"
            echo ""
            echo "Model auto-detection: looks for first MLX model in ./models/ or startup.default_model in config.json"
            echo ""
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--model /path/to/model] [--help]"
            exit 1
            ;;
    esac
done

RUNDIR="$ROOT/.lumina_run"
mkdir -p "$RUNDIR"
PID_FILE="$RUNDIR/pids.txt"

# ==============================================================================
# Helper functions
# ==============================================================================

log()    { echo "[Lumina] $*" | tee -a "$RUNDIR/startup.log"; }
log_ok() { echo "[Lumina] ✓ $*" | tee -a "$RUNDIR/startup.log"; }
log_err(){ echo "[Lumina] ✗ $*" | tee -a "$RUNDIR/startup.log" >&2; }

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

is_valid_mlx_model() {
    local model_path="$1"
    [[ -d "$model_path" ]] || return 1
    [[ -f "$model_path/config.json" ]] || return 1

    local sf=""
    sf=$(ls "$model_path"/*.safetensors 2>/dev/null | head -1)
    [[ -z "$sf" ]] && sf=$(ls "$model_path"/weights.*.safetensors 2>/dev/null | head -1)
    [[ -z "$sf" ]] && return 1

    # Validate safetensors has a real header (not a zeroed placeholder)
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

    # Validate config.json has required MLX model fields
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
}

resolve_ports() {
    API_PORT="${LUMINA_API_PORT:-$(get_config api_port 8090)}"
    MLX_PORT="${LUMINA_MLX_PORT:-$(get_config backend_port 8091)}"
    UI_PORT="${LUMINA_UI_PORT:-$(get_config ui_port 5173)}"
    OW_PORT="${LUMINA_OW_PORT:-$(get_config ow_port 8080)}"
    export LUMINA_API_PORT="$API_PORT"
    export LUMINA_MLX_PORT="$MLX_PORT"
    export LUMINA_OW_PORT="$OW_PORT"
}

stop_existing() {
    log "Stopping any existing Lumina processes..."
    if [[ -f "$PID_FILE" ]]; then
        while read pid cmd; do
            if [[ -n "$pid" ]] && ps -p "$pid" 2>/dev/null > /dev/null; then
                kill "$pid" 2>/dev/null || true
            fi
        done < "$PID_FILE"
        > "$PID_FILE"
    fi
    pkill -f 'mlx_backend.*api' 2>/dev/null || true
    pkill -f 'api-server.js' 2>/dev/null || true
    pkill -f 'vite' 2>/dev/null || true
    pkill -f 'openwebui' 2>/dev/null || true
    sleep 1
}

cleanup_components() {
    log "Shutting down started components..."
    stop_existing
}

trap cleanup_components INT TERM EXIT

# ==============================================================================
# System optimisation (macOS / Apple Silicon)
# ==============================================================================

optimize_system() {
    log "Optimizing system for MLX inference..."
    MACOS_SCRIPTS="$SCRIPTS/macos"

    # -- External macOS scripts ------------------------------------------------

    if [[ -d "$MACOS_SCRIPTS" ]]; then

        if [[ -x "$MACOS_SCRIPTS/kill_memory_hogs.sh" ]]; then
            log "  Killing memory hogs..."
            bash "$MACOS_SCRIPTS/kill_memory_hogs.sh" >> "$RUNDIR/optimizer.log" 2>&1 || true
        fi

        if [[ -x "$MACOS_SCRIPTS/purge_and_prep.sh" ]]; then
            log "  Purging disk cache and memory..."
            sudo bash "$MACOS_SCRIPTS/purge_and_prep.sh" >> "$RUNDIR/optimizer.log" 2>&1 || \
                log "  purge_and_prep.sh skipped (sudo required or not available)"
        fi

        if [[ -x "$MACOS_SCRIPTS/swap_and_swap_off.sh" ]]; then
            if [[ "${LUMINA_NOSWAP:-0}" == "1" ]]; then
                log "  Disabling swap for inference session..."
                sudo bash "$MACOS_SCRIPTS/swap_and_swap_off.sh" --disable >> "$RUNDIR/optimizer.log" 2>&1 || true
            else
                log "  Checking swap status..."
                bash "$MACOS_SCRIPTS/swap_and_swap_off.sh" >> "$RUNDIR/optimizer.log" 2>&1 || true
            fi
        fi
    fi

    # -- MLX Python optimizer --------------------------------------------------

    PYTHON="$(command -v python3)"
    OPTIMIZER="$SCRIPTS/mlx_optimize_system.py"
    if [[ -f "$OPTIMIZER" ]]; then
        log "  Running MLX Metal optimizer..."
        "$PYTHON" "$OPTIMIZER" optimize >> "$RUNDIR/optimizer.log" 2>&1 || true
    fi

    # -- Inline kernel + GPU + scheduler tunings -------------------------------

    log "  Applying macOS kernel tuning..."

    # Disable Sudden Motion Sensor (spinning-drive protection, safe on SSD)
    sudo pmset -a sms 0 2>/dev/null || true

    # Aggressive VM compressor mode (4 = most aggressive)
    sudo sysctl -w vm.compressor_mode=4 2>/dev/null || true

    # Disable App Nap for developer processes
    defaults write com.apple.dt.Xcode NSAppSleepDisabled -bool YES 2>/dev/null || true

    # Advise kernel to favour background-process memory reclaim
    sudo sysctl -w kern.memorystatus_vm_pressure_level=0 2>/dev/null || true

    # Bump scheduling priority for this shell and children
    renice -n -10 $$ 2>/dev/null || true

    # Global App Nap disable
    defaults write NSGlobalDomain NSAppSleepDisabled -bool YES 2>/dev/null || true

    # Metal / GPU performance env vars
    export MTL_HUD_ENABLED=0
    export PYTORCH_ENABLE_MPS_FALLBACK=0
    export MLX_USE_DEFAULT_STREAM=1
    export MLX_METAL_FAST_MATH=1

    # Print thermal state (user can see if throttling before launch)
    pmset -g therm 2>/dev/null | grep -i 'cpu\|thermal' || true

    # Print available RAM (free pages + inactive pages)
    vm_stat | awk '/Pages free/{f=$3+0}/Pages inactive/{i=$3+0}END{printf "[Lumina]   RAM available to MLX: %.0f MB\n",(f+i)*16384/1048576}'

    log_ok "System optimisation complete"
}

# ==============================================================================
# Model check
# ==============================================================================

check_model() {
    if [[ -z "$MODEL_PATH" ]]; then
        log "  No model specified — auto-detecting..."
        MODEL_PATH="$(auto_find_model)" || true
    fi

    if [[ -z "$MODEL_PATH" ]]; then
        log_err "No model found. Please place an MLX model directory in ./models/ or set startup.default_model in config.json"
        return 1
    fi

    if [[ ! -d "$MODEL_PATH" ]]; then
        log_err "Model not found: $MODEL_PATH"
        return 1
    fi

    # Rename weights.*.safetensors → model.safetensors (mlx_lm requirement)
    if ls "$MODEL_PATH"/weights.*.safetensors 2>/dev/null 1>&2; then
        shopt -s nullglob
        for f in "$MODEL_PATH"/weights.*.safetensors; do
            name=$(basename "$f")
            newname="model.safetensors"
            mv "$f" "$MODEL_PATH/$newname" 2>/dev/null || true
            log "  Renamed $name → $newname for mlx_lm compatibility"
        done
        shopt -u nullglob
    fi

    log "  Model: $MODEL_PATH"
}

# ==============================================================================
# Start MLX backend
# ==============================================================================

start_backend() {
    if [[ -z "$MODEL_PATH" ]]; then
        log "  No model configured — skipping MLX backend start"
        log "  Use the Models tab to download and load a model"
        return 0
    fi

    log "Starting MLX inference backend..."

    BACKEND_LOG="$RUNDIR/mlx_backend.log"

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
        if echo "$health_response" | grep -q '"status".*"ok"'; then
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
}

# ==============================================================================
# Start Node API gateway
# ==============================================================================

start_api_server() {
    log "Starting Lumina Core API gateway..."

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
# Start Vite UI
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
# OpenWebUI (macOS Docker / Colima)
# ==============================================================================

setup_openwebui() {
    log "Checking OpenWebUI..."

    if ! command -v docker &>/dev/null; then
        if [[ -S "$HOME/.colima/docker.sock" ]]; then
            export DOCKER_HOST="unix://${HOME}/.colima/docker.sock"
            log "  Using Colima Docker socket"
        else
            log "  Docker not found. Install Docker or Colima to run OpenWebUI."
            return 0
        fi
    fi

    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'openwebui'; then
        log "  OpenWebUI container already running"
        if curl -s --max-time 5 "http://127.0.0.1:$OW_PORT/" 2>/dev/null | grep -q 'html'; then
            log_ok "OpenWebUI ready at http://127.0.0.1:$OW_PORT"
            return 0
        fi
    fi

    docker stop openwebui 2>/dev/null || true
    docker rm openwebui 2>/dev/null || true

    log "  Starting OpenWebUI via Docker..."
    OW_LOG="$RUNDIR/openwebui.log"

    local ow_docker_port=$OW_PORT

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
    echo "  Backend:     http://127.0.0.1:$MLX_PORT"
    echo "  API:         http://127.0.0.1:$API_PORT"
    echo "  Lumina UI:   http://localhost:$UI_PORT"
    echo "  OpenWebUI:   http://127.0.0.1:$OW_PORT"
    echo ""
    echo "  Logs:        $RUNDIR/"
    echo "  PIDs:        $PID_FILE"
    echo ""
    echo "============================================================"
    echo ""

    open "http://localhost:$UI_PORT" 2>/dev/null || true
}

# ==============================================================================
# Main
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

    stop_existing

    optimize_system || log_err "Optimizer had warnings (non-fatal)"

    check_model || log_err "No model — use the Models tab to download one"

    start_backend || log_err "Backend not started — use the Models tab to load a model"

    start_api_server || { cleanup_components; exit 1; }

    start_ui || { cleanup_components; exit 1; }

    setup_openwebui

    print_summary

    log "Startup complete. Press Ctrl+C to stop all services."
    wait || true
}

main
