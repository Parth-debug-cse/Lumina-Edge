#!/bin/bash
# ==============================================================================
# linux.sh — Lumina Edge Launcher for Linux (llama-server / Vulkan)
# Optimizes system → starts llama-server → starts API server → launches UI
# Fully replaces start_lumina.sh on Linux.
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
            echo "Lumina Edge Launcher (Linux)"
            echo ""
            echo "Usage: $0 [--model /path/to/model] [--help]"
            echo ""
            echo "Environment variables:"
            echo "  LUMINA_API_PORT   Backend/API port (default: 8090)"
            echo "  LUMINA_MLX_PORT   llama-server port (default: 8091)"
            echo "  LUMINA_UI_PORT    Vite dev server port (default: 5173)"
            echo "  LUMINA_NOSWAP=1   Disable swap during session (re-enabled on exit)"
            echo ""
            echo "Model auto-detection: looks for first .gguf or model dir in ./models/"
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

auto_find_model() {
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
    log_err "No model found. Place a .gguf file or model directory in ./models/ or set model in config.json"
    return 1
}

resolve_ports() {
    API_PORT="${LUMINA_API_PORT:-$(get_config api_port 8090)}"
    MLX_PORT="${LUMINA_MLX_PORT:-$(get_config backend_port 8091)}"
    UI_PORT="${LUMINA_UI_PORT:-$(get_config ui_port 5173)}"
    export LUMINA_API_PORT="$API_PORT"
    export LUMINA_MLX_PORT="$MLX_PORT"
}

stop_existing() {
    log "Stopping any existing Lumina processes..."
    if [[ -f "$PID_FILE" ]]; then
        while read pid cmd; do
            if [[ -n "$pid" ]]; then
                if [[ -d "/proc/$pid" ]]; then
                    kill "$pid" 2>/dev/null || true
                fi
            fi
        done < "$PID_FILE"
        > "$PID_FILE"
    fi
    pkill -f 'llama-server' 2>/dev/null || true
    pkill -f 'api-server.js' 2>/dev/null || true
    pkill -f 'vite' 2>/dev/null || true
    sleep 1
}

cleanup_components() {
    log "Shutting down started components..."
    stop_existing
    if [[ "${LUMINA_NOSWAP:-0}" == "1" ]]; then
        log "  Re-enabling swap..."
        sudo swapon -a 2>/dev/null || true
    fi
}

trap cleanup_components INT TERM EXIT

# ==============================================================================
# System optimisation (Linux)
# ==============================================================================

optimize_system() {
    log "Optimizing system for inference..."

    # -- Memory tuning ---------------------------------------------------------

    log "  Tuning kernel memory parameters..."

    # Drop page cache, dentries, and inodes
    sync && echo 3 | sudo tee /proc/sys/vm/drop_caches > /dev/null 2>&1 || true

    # Disable swap for session when requested
    if [[ "${LUMINA_NOSWAP:-0}" == "1" ]]; then
        log "  Disabling swap for inference session (re-enabled on exit)..."
        sudo swapoff -a 2>/dev/null || true
    fi

    # Kernel VM tunings for inference workloads
    sudo sysctl -w vm.swappiness=10 2>/dev/null || true
    sudo sysctl -w vm.vfs_cache_pressure=50 2>/dev/null || true
    sudo sysctl -w vm.dirty_ratio=40 2>/dev/null || true
    sudo sysctl -w vm.dirty_background_ratio=10 2>/dev/null || true

    log "  (mlock will be passed to llama-server if use_mlock=true in config)"

    # -- CPU / scheduler -------------------------------------------------------

    log "  Tuning CPU scheduler..."

    # Raise process priority for this shell and children
    renice -n -10 $$ 2>/dev/null || true

    # Pin process to all available cores
    taskset -p -c 0-$(($(nproc 2>/dev/null || echo 32) - 1)) $$ 2>/dev/null || true

    # Set CPU governor to performance
    for f in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
        echo performance | sudo tee "$f" > /dev/null 2>&1 || true
    done

    # -- GPU / Vulkan ----------------------------------------------------------

    log "  Configuring Vulkan / GPU environment..."

    # AMD RADV / ACO compiler tuning (only if AMD GPU detected)
    if lspci 2>/dev/null | grep -qi 'amd.*radeon\|amd.*gpu'; then
        export RADV_PERFTEST=aco,gpl
        export AMD_VULKAN_ICD=RADV
        if [[ -f /usr/share/vulkan/icd.d/radeon_icd.x86_64.json ]]; then
            export VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/radeon_icd.x86_64.json
        fi
        export DISABLE_LAYER_AMD_SWITCHABLE_GRAPHICS_1=1
    fi
    export VK_LAYER_PATH=""

    # -- Kill memory hogs ------------------------------------------------------

    log "  Killing known memory-heavy background processes..."

    for proc in tracker-miner tracker-store zeitgeist-datahub evolution-calendar-factory \
                evolution-source-registry update-notifier packagekitd apt-daily apt-daily-upgrade \
                snapd gvfs-udisks2-volume-monitor; do
        pkill -f "$proc" 2>/dev/null || true
    done

    # GNOME Tracker disable for session
    gsettings set org.freedesktop.Tracker3.Miner.Files enable-monitors false 2>/dev/null || true

    # Print free memory
    free -m | awk '/^Mem:/{printf "[Lumina]   RAM available: %d MB free, %d MB available\n",$4,$7}'

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
        log_err "No model found. Place a .gguf file or model directory in ./models/ or set model in config.json"
        return 1
    fi

    if [[ ! -d "$MODEL_PATH" && ! -f "$MODEL_PATH" ]]; then
        log_err "Model not found: $MODEL_PATH"
        return 1
    fi

    log "  Model: $MODEL_PATH"
}

# ==============================================================================
# Start llama-server backend
# ==============================================================================

start_backend() {
    log "Starting llama-server backend..."

    LLAMA_SERVER="$ROOT/bin/llama-server"
    if [[ ! -x "$LLAMA_SERVER" ]]; then
        log_err "llama-server not found at $LLAMA_SERVER"
        return 1
    fi

    # Read all config values
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
    CONT_BATCHING=$(get_config cont_batching true)
    USE_MLOCK=$(get_config use_mlock true)
    NO_MMAP=$(get_config no_mmap true)
    MOE_MODEL=$(get_config moe_model 'false')
    MOE_OVERRIDE=$(get_config moe_override_tensor '')

    # Build flag strings
    FLASH_ATTN_FLAG=""
    if [[ "$FLASH_ATTN" == "true" ]]; then
        FLASH_ATTN_FLAG="--flash-attn"
    fi

    CONT_BATCH_FLAG=""
    if [[ "$CONT_BATCHING" == "true" ]]; then
        CONT_BATCH_FLAG="--cont-batching"
    fi

    MLOCK_FLAG=""
    if [[ "$USE_MLOCK" == "true" ]]; then
        MLOCK_FLAG="--mlock"
    fi

    NO_MMAP_FLAG=""
    if [[ "$NO_MMAP" == "true" ]]; then
        NO_MMAP_FLAG="--no-mmap"
    fi

    MOE_FLAGS=""
    if [[ "$MOE_MODEL" == "true" ]]; then
        if [[ -n "$MOE_OVERRIDE" ]]; then
            MOE_FLAGS="-ot $MOE_OVERRIDE"
        else
            MOE_FLAGS="--cpu-moe"
        fi
    fi

    BACKEND_LOG="$RUNDIR/llama_server.log"
    log "  llama-server → port $MLX_PORT"

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
        $CONT_BATCH_FLAG \
        $MLOCK_FLAG \
        $NO_MMAP_FLAG \
        $MOE_FLAGS \
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
            mlx_models=$(curl -s --max-time 3 "http://127.0.0.1:$MLX_PORT/v1/models" 2>/dev/null)
            if echo "$mlx_models" | grep -q '"data"'; then
                log_ok "API gateway ready (primary: $API_PORT, mgmt: $SECONDARY_PORT, MLX connected)"
                return 0
            fi
        fi
        if curl -s --max-time 2 "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null | grep -q 'ok'; then
            mlx_models=$(curl -s --max-time 3 "http://127.0.0.1:$MLX_PORT/v1/models" 2>/dev/null)
            if echo "$mlx_models" | grep -q '"data"'; then
                log_ok "API gateway ready (primary: $API_PORT, MLX connected)"
                return 0
            fi
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
    echo "  Lumina Edge — All systems ready"
    echo "============================================================"
    echo ""
    echo "  Model:       $MODEL_PATH"
    echo "  Backend:     http://127.0.0.1:$MLX_PORT"
    echo "  API:         http://127.0.0.1:$API_PORT"
    echo "  Lumina UI:   http://localhost:$UI_PORT"
    echo ""
    echo "  Logs:        $RUNDIR/"
    echo "  PIDs:        $PID_FILE"
    echo ""
    echo "============================================================"
    echo ""

    xdg-open "http://localhost:$UI_PORT" 2>/dev/null || true
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

    check_model || { cleanup_components; exit 1; }

    start_backend || { cleanup_components; exit 1; }

    start_api_server || { cleanup_components; exit 1; }

    start_ui || { cleanup_components; exit 1; }

    print_summary

    log "Startup complete. Press Ctrl+C to stop all services."
    wait
}

main
