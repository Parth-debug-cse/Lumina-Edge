#!/bin/bash
# ==============================================================================
# mac.sh — Lumina Edge Launcher for macOS (Apple Silicon / MLX)
# Starts API server + UI only. Models are loaded on demand via the UI.
# NO model is autoloaded at startup — use the Models tab to load one.
# ==============================================================================

cd "$(dirname "$0")" || { echo "[Lumina] ✗ Failed to cd to script directory"; exit 1; }
ROOT="$(pwd)"
SCRIPTS="$ROOT/scripts"
UI_DIR="$ROOT/ui"

# Parse CLI args
while [[ $# -gt 0 ]]; do
    case "${1:-}" in
        --help|-h)
            echo "Lumina Edge Launcher (macOS)"
            echo ""
            echo "Usage: $0 [--help]"
            echo ""
            echo "Environment variables:"
            echo "  LUMINA_API_PORT   API gateway port (default: 8090)"
            echo "  LUMINA_UI_PORT    Vite dev server port (default: 5173)"
            echo ""
            echo "Models are loaded on demand via the UI Models tab."
            echo "No model is autoloaded at startup."
            echo ""
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--help]"
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

# Reads a key from config.json with a fallback default
# Supports dot-notation keys like "startup.default_model"
get_config() {
    local key="$1"
    local default="$2"
    if command -v python3 &>/dev/null && [[ -f "$ROOT/config.json" ]]; then
        python3 -c "
import json,sys
root=sys.argv[1]; key=sys.argv[2]; default=sys.argv[3]
try:
    cfg=json.load(open(root+'/config.json'))
    parts=key.split('.')
    v=cfg
    for p in parts:
        if isinstance(v,dict) and p in v: v=v[p]
        else: v=None; break
    print(v if v is not None else default)
except Exception: print(default)
" "$ROOT" "$key" "$default" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

resolve_ports() {
    API_PORT="${LUMINA_API_PORT:-$(get_config api_port 8090)}"
    UI_PORT="${LUMINA_UI_PORT:-$(get_config ui_port 5173)}"
    export LUMINA_API_PORT="$API_PORT"
}

# Kills all tracked Lumina processes + any orphan MLX/node/vite processes
# Uses ps -p instead of /proc (macOS doesn't have /proc)
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

    if [[ -d "$MACOS_SCRIPTS" ]]; then
        if [[ -x "$MACOS_SCRIPTS/kill_memory_hogs.sh" ]]; then
            log "  Killing memory hogs..."
            bash "$MACOS_SCRIPTS/kill_memory_hogs.sh" >> "$RUNDIR/optimizer.log" 2>&1 || true
        fi
        if [[ -x "$MACOS_SCRIPTS/purge_and_prep.sh" ]]; then
            log "  Purging disk cache and memory..."
            # sudo purge drops filesystem caches — needs admin, may fail without passwordless sudo
            sudo bash "$MACOS_SCRIPTS/purge_and_prep.sh" >> "$RUNDIR/optimizer.log" 2>&1 || \
                log "  purge_and_prep.sh skipped (sudo required or not available)"
        fi
    fi

    PYTHON="$(command -v python3)"
    OPTIMIZER="$SCRIPTS/mlx_optimize_system.py"
    if [[ -f "$OPTIMIZER" ]]; then
        log "  Running MLX Metal optimizer..."
        "$PYTHON" "$OPTIMIZER" optimize >> "$RUNDIR/optimizer.log" 2>&1 || true
    fi

    # macOS-specific: disable sudden motion sensor (not a real SMS, it's a Mac Pro thing)
    sudo pmset -a sms 0 2>/dev/null || true
    # Force memory compressor into mode 4 (aggressive decompression when under memory pressure)
    sudo sysctl -w vm.compressor_mode=4 2>/dev/null || true
    renice -n -10 $$ 2>/dev/null || true
    # Prevent App Nap from throttling background processes
    defaults write NSGlobalDomain NSAppSleepDisabled -bool YES 2>/dev/null || true

    # MLX/Metal env vars for best GPU throughput
    export MTL_HUD_ENABLED=0
    export PYTORCH_ENABLE_MPS_FALLBACK=0
    export MLX_USE_DEFAULT_STREAM=1
    export MLX_METAL_FAST_MATH=1

    vm_stat | awk '/Pages free/{f=$3+0}/Pages inactive/{i=$3+0}END{printf "[Lumina]   RAM available to MLX: %.0f MB\n",(f+i)*16384/1048576}'

    log_ok "System optimisation complete"
}

# ==============================================================================
# Install Scout dependencies
# ==============================================================================

install_scout_deps() {
    SCOUT_REQS="$ROOT/lumina_scout/requirements.txt"
    if [[ -f "$SCOUT_REQS" ]]; then
        log "Installing Lumina Scout dependencies..."
        python3 -m pip install -q -r "$SCOUT_REQS" 2>/dev/null || \
            log "  Scout deps install had warnings (non-fatal)"
        log_ok "Lumina Scout dependencies installed"
    fi
}

# ==============================================================================
# Start Node API gateway (no model — models loaded on demand via UI)
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
# Print startup summary
# ==============================================================================

print_summary() {
    echo ""
    echo "============================================================"
    echo "  Lumina Edge — Ready"
    echo "============================================================"
    echo ""
    echo "  API:         http://127.0.0.1:$API_PORT"
    echo "  Lumina UI:   http://localhost:$UI_PORT"
    echo ""
    echo "  ⚡ No model loaded. Use the Models tab to load one."
    echo ""
    echo "  Logs:        $RUNDIR/"
    echo "============================================================"
    echo ""

    # macOS uses `open` instead of xdg-open
    open "http://localhost:$UI_PORT" 2>/dev/null || true
}

# ==============================================================================
# Main
# ==============================================================================

main() {
    resolve_ports
    : > "$RUNDIR/startup.log"
    log "============================================================"
    log "  Lumina Edge Launcher (macOS)"
    log "============================================================"
    log "  Root:     $ROOT"
    log "  Platform: $(uname -s) $(uname -m)"
    log ""

    stop_existing
    optimize_system || log_err "Optimizer had warnings (non-fatal)"
    install_scout_deps
    start_api_server || { cleanup_components; exit 1; }
    start_ui || { cleanup_components; exit 1; }
    print_summary

    log "Startup complete. Press Ctrl+C to stop all services."
    wait || true
}

main
