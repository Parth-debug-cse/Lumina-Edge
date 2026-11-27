#!/bin/bash
# ==============================================================================
# launch_api.sh — Lumina Edge API Server Launcher for Linux/macOS
# Reads all settings from config.json
# ==============================================================================

# Note: we do NOT use 'set -e' here because arithmetic expressions like
# ((WAITED++)) evaluate to 0 on the first iteration, which bash treats as a
# failure and exits the script silently. Individual commands check exit codes
# explicitly instead.
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR" || exit 1

# Reads a config.json value with dot-notation support and fallback default
get_config() {
    local key="$1"
    local default="$2"
    if command -v python3 &>/dev/null && [[ -f "$ROOT_DIR/config.json" ]]; then
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
    if isinstance(v, bool):
        print(str(v).lower())
    else:
        print(v if v is not None else default)
except Exception:
    print(default)
" "$ROOT_DIR" "$key" "$default" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

detect_physical_cores() {
    local cores=""
    if [[ "$(uname -s)" == "Darwin" ]]; then
        cores=$(sysctl -n hw.physicalcpu 2>/dev/null)
    elif command -v lscpu &>/dev/null; then
        cores=$(lscpu -p=CORE,SOCKET 2>/dev/null | awk -F, '$1 !~ /^#/ { seen[$1 "," $2] = 1 } END { count = 0; for (core in seen) count++; print count }')
    fi
    if [[ ! "$cores" =~ ^[1-9][0-9]*$ ]]; then
        cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null)
    fi
    if [[ ! "$cores" =~ ^[1-9][0-9]*$ ]]; then
        cores=1
    fi
    echo "$cores"
}

resolve_thread_count() {
    local configured="$1"
    case "$configured" in
        auto|AUTO|Auto)
            detect_physical_cores
            ;;
        *)
            if [[ "$configured" =~ ^[1-9][0-9]*$ ]]; then
                echo "$configured"
            else
                echo "Invalid thread count '$configured'; using 1" >&2
                echo 1
            fi
            ;;
    esac
}

resolve_batch_size() {
    local configured="$1"
    case "$configured" in
        auto|AUTO|Auto)
            local detected
            detected=$(python3 -c '
import os, sys
available = 0
try:
    if sys.platform.startswith("linux"):
        with open("/proc/meminfo", encoding="ascii") as meminfo:
            for line in meminfo:
                if line.startswith("MemAvailable:"):
                    available = int(line.split()[1]) * 1024
                    break
    else:
        available = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_AVPHYS_PAGES")
    gib = available / (1024 ** 3)
    print(max(128, min(1024, int(gib // 2) * 128)) if available > 0 else 256)
except (OSError, ValueError, AttributeError):
    print(256)
' 2>/dev/null) || detected=256
            if [[ "$detected" =~ ^[1-9][0-9]*$ ]]; then
                echo "$detected"
            else
                echo 256
            fi
            ;;
        *)
            if [[ "$configured" =~ ^[1-9][0-9]*$ ]]; then
                echo "$configured"
            else
                echo "Invalid batch size '$configured'; using 256" >&2
                echo 256
            fi
            ;;
    esac
}

resolve_gpu_layer_count() {
    local configured="$1"
    case "$configured" in
        auto|AUTO|Auto)
            if [[ -x "$ROOT_DIR/bin/llama-server" ]] && \
                    "$ROOT_DIR/bin/llama-server" --list-devices 2>/dev/null | \
                    grep -Eiq '^[[:space:]]*([-*][[:space:]]*)?(CUDA|Vulkan|ROCm|HIP|SYCL|Metal|OpenCL)[[:alnum:]_-]*[[:space:]]*:'; then
                echo 99
            else
                echo "No supported llama.cpp GPU device detected; using CPU layers" >&2
                echo 0
            fi
            ;;
        *)
            if [[ "$configured" =~ ^(0|[1-9][0-9]*)$ ]]; then
                echo "$configured"
            else
                echo "Invalid GPU layer count '$configured'; using 0" >&2
                echo 0
            fi
            ;;
    esac
}

MODEL=""
PORT=""
GPU="vulkan"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --model) MODEL="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --gpu) GPU="$2"; shift 2 ;;
        *) echo "Usage: $0 [--model path] [--port port] [--gpu vulkan|cuda|mlx]"; exit 1 ;;
    esac
done

# Read config values with defaults
CONFIG_MODEL=$(get_config "model" "")
CONFIG_PORT=$(get_config "api_port" 8090)
CTX_SIZE=$(get_config "ctx_size" 16384)
N_GPU_LAYERS=$(resolve_gpu_layer_count "$(get_config "n_gpu_layers" 15)")
BATCH_SIZE=$(resolve_batch_size "$(get_config "batch_size" 256)")
UBATCH_SIZE=$(resolve_batch_size "$(get_config "ubatch_size" 256)")
if (( UBATCH_SIZE > BATCH_SIZE )); then
    UBATCH_SIZE="$BATCH_SIZE"
fi
FLASH_ATTN=$(get_config "flash_attn" "true")
MIN_P=$(get_config "min_p" 0.05)
TOP_K=$(get_config "top_k" 20)
TOP_P=$(get_config "top_p" 0.9)
REPEAT_PENALTY=$(get_config "repeat_penalty" 1.1)
HTTP_THREADS=$(get_config "http_threads" 2)
THREADS=$(resolve_thread_count "$(get_config "threads" 2)")
THREADS_BATCH=$(resolve_thread_count "$(get_config "threads_batch" 4)")
CONT_BATCHING=$(get_config "cont_batching" "true")

USE_MLOCK=$(get_config "use_mlock" "true")
NO_MMAP=$(get_config "no_mmap" "true")

KV_CACHE_TYPE_K=$(get_config "kv_cache_type_k" "q4_0")
KV_CACHE_TYPE_V=$(get_config "kv_cache_type_v" "q4_0")

FINAL_MODEL="${MODEL:-$CONFIG_MODEL}"
FINAL_PORT="${PORT:-$CONFIG_PORT}"

# Auto-detect macOS for MLX backend
IS_MAC=false
if [[ "$(uname -s)" == "Darwin" ]]; then
    IS_MAC=true
    GPU="mlx"
fi

echo "========================================"
echo "Lumina Edge API Server Launcher"
echo "========================================"

if [[ -z "$FINAL_MODEL" ]]; then
    echo "ERROR: No model specified. Add 'model' field to config.json or use --model parameter"
    exit 1
fi

# Avoid double-prefixing models/ if already present in path
if [[ "$FINAL_MODEL" == models/* || "$FINAL_MODEL" == ./* || "$FINAL_MODEL" == /* || "$FINAL_MODEL" == ..* ]]; then
    MODEL_PATH="$FINAL_MODEL"
else
    MODEL_PATH="models/$FINAL_MODEL"
fi
if [[ ! -f "$MODEL_PATH" && ! -d "$MODEL_PATH" ]]; then
    echo "ERROR: Model file not found: $MODEL_PATH"
    echo ""
    echo "Please download a model and place it in the models/ directory."
    echo "Example models:"
    echo "  - mistral-7b-instruct-v0.2.Q4_K_M.gguf"
    echo "  - llama-2-7b-chat.Q4_K_M.gguf"
    echo "  - phi-3-mini-4k-instruct.Q4_K_M.gguf"
    echo ""
    echo "Download from: https://huggingface.co/TheBloke"
    exit 1
fi

echo "Model: $FINAL_MODEL"
echo "Port: $FINAL_PORT"
echo "GPU Backend: $GPU"
echo "Context Size: $CTX_SIZE"
echo "GPU Layers: $N_GPU_LAYERS"
echo "Inference threads: $THREADS (batch: $THREADS_BATCH)"

# Check if port is already in use (ss preferred, netstat fallback)
if command -v ss &>/dev/null; then
    if ss -tlnp 2>/dev/null | grep -q ":$FINAL_PORT "; then
        echo "WARNING: Port $FINAL_PORT is already in use!"
        echo "Run: ss -tlnp | grep ':$FINAL_PORT' to see which process is using it"
    fi
elif command -v netstat &>/dev/null; then
    if netstat -tlnp 2>/dev/null | grep -q ":$FINAL_PORT "; then
        echo "WARNING: Port $FINAL_PORT is already in use!"
    fi
fi

mkdir -p logs
LOG_FILE="logs/api_server.log"

# Build llama-server arguments
ARGS=(
    "-m" "$MODEL_PATH"
    "--port" "$FINAL_PORT"
    "--host" "127.0.0.1"
    "--ctx-size" "$CTX_SIZE"
    "--n-gpu-layers" "$N_GPU_LAYERS"
    "--batch-size" "$BATCH_SIZE"
    "--ubatch-size" "$UBATCH_SIZE"
    "--min-p" "$MIN_P"
    "--top-k" "$TOP_K"
    "--top-p" "$TOP_P"
    "--repeat-penalty" "$REPEAT_PENALTY"
    "--threads" "$THREADS"
    "--threads-batch" "$THREADS_BATCH"
    "--threads-http" "$HTTP_THREADS"
)

# Conditionally add boolean flags
if [[ "$N_GPU_LAYERS" == "0" ]]; then
    FLASH_ATTN=false
fi
if [[ "$FLASH_ATTN" == "true" ]]; then
    ARGS+=("--flash-attn" "on")
else
    ARGS+=("--flash-attn" "off")
fi
if [[ "$USE_MLOCK" == "true" ]]; then
    ARGS+=("--mlock")
fi
if [[ "$NO_MMAP" == "true" ]]; then
    ARGS+=("--no-mmap")
fi
if [[ "$CONT_BATCHING" == "true" ]]; then
    ARGS+=("--cont-batching")
fi

ARGS+=("--cache-type-k" "$KV_CACHE_TYPE_K" "--cache-type-v" "$KV_CACHE_TYPE_V")

# macOS path: use MLX backend instead of llama-server
if [[ "$IS_MAC" == "true" ]]; then
    echo ""
    echo "Starting MLX backend (macOS)..."
    echo "Log file: $LOG_FILE"
    mkdir -p "$(dirname "$LOG_FILE")"

    python3 scripts/mlx_backend.py --mode api --model "$MODEL_PATH" --port "$FINAL_PORT" >> "$LOG_FILE" 2>&1 &
    MLX_PID=$!
    echo "MLX backend PID: $MLX_PID"

    # BUG SH-2 FIX: Register a trap so the MLX backend is killed on script exit to avoid orphaned processes
    trap 'kill $MLX_PID 2>/dev/null || true' EXIT INT TERM

    MAX_WAIT=30
    WAITED=0
    READY=false
    while [[ $WAITED -lt $MAX_WAIT ]]; do
        sleep 1
        # BUG SH-1 FIX: Use WAITED=$((WAITED + 1)) instead of ((WAITED++))
        # ((WAITED++)) returns 0 on first iteration — causes set -o pipefail to exit
        WAITED=$((WAITED + 1))
        if ! kill -0 $MLX_PID 2>/dev/null; then
            echo "ERROR: MLX backend exited unexpectedly!"
            echo "Check log: $LOG_FILE"
            exit 1
        fi
        if curl -s "http://127.0.0.1:$FINAL_PORT/health" >/dev/null 2>&1; then
            READY=true
            break
        fi
        if [[ $((WAITED % 5)) -eq 0 ]]; then
            echo "  ... waiting ($WAITED/$MAX_WAIT seconds)"
        fi
    done

    if [[ "$READY" == "true" ]]; then
        echo ""
        echo "✓ MLX backend ready on port $FINAL_PORT"
        echo "  Health: http://127.0.0.1:$FINAL_PORT/health"
        echo ""
        echo "Press Ctrl+C to stop the server"
        wait $MLX_PID
    else
        echo "ERROR: MLX backend failed to start within $MAX_WAIT seconds."
        echo "Check log: $LOG_FILE"
        kill $MLX_PID 2>/dev/null
        exit 1
    fi
else
    # Linux path: use llama-server binary
    BINARY_PATH="bin/llama-server"
    if [[ ! -x "$BINARY_PATH" ]]; then
        echo "ERROR: llama-server not found or not executable at $BINARY_PATH"
        echo "Please ensure llama.cpp binaries are in bin/ directory."
        exit 1
    fi

    echo ""
    echo "Starting llama-server..."
    echo "Binary: $BINARY_PATH"
    echo "Log file: $LOG_FILE"
    echo ""
    echo "Command: $BINARY_PATH ${ARGS[*]}"
    echo "========================================"
    echo ""

    "$BINARY_PATH" "${ARGS[@]}" >> "$LOG_FILE" 2>&1 &
    SERVER_PID=$!

    echo "Server started with PID: $SERVER_PID"
    echo "Waiting for server to initialize..."

    MAX_WAIT=30
    WAITED=0
    READY=false

    while [[ $WAITED -lt $MAX_WAIT ]]; do
        sleep 1
        WAITED=$((WAITED + 1))

        if ! kill -0 $SERVER_PID 2>/dev/null; then
            echo "ERROR: Server process exited unexpectedly!"
            echo "Check log: $LOG_FILE"
            exit 1
        fi

        if curl -s "http://127.0.0.1:$FINAL_PORT/health" >/dev/null 2>&1; then
            READY=true
            break
        fi

        if [[ $((WAITED % 5)) -eq 0 ]]; then
            echo "  ... waiting ($WAITED/$MAX_WAIT seconds)"
        fi
    done

    if [[ "$READY" == "true" ]]; then
        echo ""
        echo "✓ Server is ready!"
        echo "  API URL: http://127.0.0.1:$FINAL_PORT"
        echo "  Health: http://127.0.0.1:$FINAL_PORT/health"
        echo ""
        echo "To test the server, run:"
        echo "  python3 scripts/check_server.py"
        echo ""
        echo "Press Ctrl+C to stop the server"

        wait $SERVER_PID
    else
        echo "ERROR: Server failed to start within $MAX_WAIT seconds."
        echo "Check log: $LOG_FILE"
        kill $SERVER_PID 2>/dev/null
        exit 1
    fi
fi
