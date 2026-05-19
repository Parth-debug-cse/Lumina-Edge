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
cd "$ROOT_DIR"

# Helper function to read from config.json
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
    print(v if v is not None else default)
except Exception:
    print(default)
" "$ROOT_DIR" "$key" "$default" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

# Parse arguments
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

# Read configuration from config.json
CONFIG_MODEL=$(get_config "model" "")
CONFIG_PORT=$(get_config "api_port" 8090)
CTX_SIZE=$(get_config "ctx_size" 16384)
N_GPU_LAYERS=$(get_config "n_gpu_layers" 15)
BATCH_SIZE=$(get_config "batch_size" 256)
UBATCH_SIZE=$(get_config "ubatch_size" 256)
FLASH_ATTN=$(get_config "flash_attn" "true")
MIN_P=$(get_config "min_p" 0.05)
TOP_K=$(get_config "top_k" 20)
TOP_P=$(get_config "top_p" 0.9)
REPEAT_PENALTY=$(get_config "repeat_penalty" 1.1)
HTTP_THREADS=$(get_config "http_threads" 2)
CONT_BATCHING=$(get_config "cont_batching" "true")
KV_CACHE_QUANT=$(get_config "kv_cache_quant" "q4_0")
USE_MLOCK=$(get_config "use_mlock" "true")
NO_MMAP=$(get_config "no_mmap" "true")
KV_QUANT=$(get_config "kv_quant" "q4_0")
KV_CACHE_TYPE_K=$(get_config "kv_cache_type_k" "q4_0")
KV_CACHE_TYPE_V=$(get_config "kv_cache_type_v" "q4_0")

# Use command-line parameters or fall back to config
FINAL_MODEL="${MODEL:-$CONFIG_MODEL}"
FINAL_PORT="${PORT:-$CONFIG_PORT}"

# Determine if macOS (for MLX)
IS_MAC=false
if [[ "$(uname -s)" == "Darwin" ]]; then
    IS_MAC=true
    GPU="mlx"
fi

echo "========================================"
echo "Lumina Edge API Server Launcher"
echo "========================================"

# Validate model
if [[ -z "$FINAL_MODEL" ]]; then
    echo "ERROR: No model specified. Add 'model' field to config.json or use --model parameter"
    exit 1
fi

# Avoid double-prefix: if FINAL_MODEL already starts with models/ use it as-is
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

# Check if port is already in use
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

# Ensure logs directory exists
mkdir -p logs
LOG_FILE="logs/api_server.log"

# Build llama-server command arguments
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
    "--threads-http" "$HTTP_THREADS"
)

# Add boolean flags
if [[ "$FLASH_ATTN" == "true" ]]; then
    ARGS+=("--flash-attn")
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

# Add KV quantization flags from config (default q4_0)
ARGS+=("--cache-type-k" "$KV_CACHE_TYPE_K" "--cache-type-v" "$KV_CACHE_TYPE_V")

# Find llama-server binary
if [[ "$IS_MAC" == "true" ]]; then
    # On macOS, use MLX backend instead
    echo ""
    echo "Starting MLX backend (macOS)..."
    echo "Log file: $LOG_FILE"
    mkdir -p "$(dirname "$LOG_FILE")"

    python3 scripts/mlx_backend.py --mode api --model "$MODEL_PATH" --port "$FINAL_PORT" >> "$LOG_FILE" 2>&1 &
    MLX_PID=$!
    echo "MLX backend PID: $MLX_PID"

    MAX_WAIT=30
    WAITED=0
    READY=false
    # BUG SH-2 FIX: Register a trap so the MLX backend is killed on script exit
    # (including on error) and does not become an orphaned process.
    trap 'kill $MLX_PID 2>/dev/null || true' EXIT INT TERM
    while [[ $WAITED -lt $MAX_WAIT ]]; do
        sleep 1
        # BUG SH-1 FIX: Use WAITED=$((WAITED + 1)) instead of ((WAITED++)).
        # With set -o pipefail, bash exits when ((WAITED++)) evaluates to 0
        # (first iteration), causing the poll loop to exit after 1 second.
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

    # Start the server
    "$BINARY_PATH" "${ARGS[@]}" >> "$LOG_FILE" 2>&1 &
    SERVER_PID=$!

    echo "Server started with PID: $SERVER_PID"
    echo "Waiting for server to initialize..."

    # Wait for server to be ready
    MAX_WAIT=30
    WAITED=0
    READY=false

    while [[ $WAITED -lt $MAX_WAIT ]]; do
        sleep 1
        # BUG SH-1 FIX: Use WAITED=$((WAITED + 1)) instead of ((WAITED++)).
        # With set -o pipefail, bash exits when ((WAITED++)) evaluates to 0
        # (first iteration), causing the poll loop to exit after 1 second.
        WAITED=$((WAITED + 1))

        # Check if process is still running
        if ! kill -0 $SERVER_PID 2>/dev/null; then
            echo "ERROR: Server process exited unexpectedly!"
            echo "Check log: $LOG_FILE"
            exit 1
        fi

        # Try to connect to health endpoint
        if curl -s "http://127.0.0.1:$FINAL_PORT/health" >/dev/null 2>&1; then
            READY=true
            break
        fi

        # Show progress
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

        # Wait for user to press Ctrl+C
        wait $SERVER_PID
    else
        echo "ERROR: Server failed to start within $MAX_WAIT seconds."
        echo "Check log: $LOG_FILE"
        kill $SERVER_PID 2>/dev/null
        exit 1
    fi
fi