#!/bin/bash
# ==============================================================================
# start_api.sh — Quick-start wrapper. All settings are read from config.json.
# Edit config.json or use the UI Settings page to change behavior.
# ==============================================================================

cd "$(dirname "$0")"

# Helper to read from config.json with fallback
get_config() {
    local key="$1"
    local default="$2"
    if command -v python3 &>/dev/null && [[ -f "config.json" ]]; then
        python3 -c "
import json
try:
    v = json.load(open('config.json')).get('$key')
    print(v if v is not None else $default)
except Exception:
    print($default)
" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

# Default model selection (can be overridden by --model)
MODEL="models/Qwen3.5-Coder-4b-Instruct-IQ4_XS.gguf"
GPU="vulkan"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)
            MODEL="$2"; shift 2
            ;;
        --port)
            OVERRIDE_PORT="$2"; shift 2
            ;;
        --gpu)
            GPU="$2"; shift 2
            ;;
        *)
            echo "Usage: $0 [--model path] [--port port] [--gpu vulkan|nvidia|mlx]"
            exit 1
            ;;
    esac
done

# Read all settings from config.json with defaults
PORT="${OVERRIDE_PORT:-$(get_config api_port 1234)}"
CTX_SIZE=$(get_config ctx_size 16384)
N_GPU_LAYERS=$(get_config n_gpu_layers 15)
THREADS=$(get_config threads 2)
THREADS_BATCH=$(get_config threads_batch 4)
BATCH_SIZE=$(get_config batch_size 256)
UBATCH_SIZE=$(get_config ubatch_size 256)
FLASH_ATTN=$(get_config flash_attn true)
DEFRAG_THOLD=$(get_config defrag_thold 0.1)
MIN_P=$(get_config min_p 0.05)
TOP_K=$(get_config top_k 20)
TOP_P=$(get_config top_p 0.9)
REPEAT_PENALTY=$(get_config repeat_penalty 1.1)
HTTP_THREADS=$(get_config http_threads 2)
CONT_BATCHING=$(get_config cont_batching true)
PARALLEL_SLOTS=$(get_config parallel_slots 1)
KV_CACHE_QUANT=$(get_config kv_cache_quant 'f16')
USE_MLOCK=$(get_config use_mlock true)

# Convert boolean to on/off for flash-attn
if [[ "$FLASH_ATTN" == "true" ]]; then
    FLASH_ATTN_FLAG="--flash-attn"
else
    FLASH_ATTN_FLAG=""
fi

# Convert boolean flags
MLOCK_FLAG=""
if [[ "$USE_MLOCK" == "true" ]]; then
    MLOCK_FLAG="--mlock"
fi

CONT_BATCH_FLAGS=""
if [[ "$CONT_BATCHING" == "true" ]]; then
    CONT_BATCH_FLAGS="--cont-batching --parallel $PARALLEL_SLOTS"
fi

echo "Starting Lumina Edge API..."
echo "Model: $MODEL"
echo "GPU: $GPU"
echo "Port: $PORT"

# Handle MLX backend (macOS/Apple Silicon)
if [[ "$GPU" == "mlx" ]]; then
    echo "Backend: MLX (Apple Silicon)"
    echo "MLX Max Tokens: $(get_config mlx_max_tokens 2048)"
    SCRIPTS="$(cd "$(dirname "$0")" && pwd)/scripts"
    set -x
    python3 "$SCRIPTS/mlx_backend.py" --mode api --model "$MODEL" --port "$PORT"
    exit $?
fi

echo "Context Size: $CTX_SIZE"
echo "GPU Layers: $N_GPU_LAYERS"

# Build and execute command
set -x
./bin/llama-server -m "$MODEL" \
    --port "$PORT" \
    --host 127.0.0.1 \
    --ctx-size "$CTX_SIZE" \
    --n-gpu-layers "$N_GPU_LAYERS" \
    --threads "$THREADS" \
    --threads-batch "$THREADS_BATCH" \
    --batch-size "$BATCH_SIZE" \
    --ubatch-size "$UBATCH_SIZE" \
    $FLASH_ATTN_FLAG \
    --defrag-thold "$DEFRAG_THOLD" \
    --warmup \
    --min-p "$MIN_P" \
    --top-k "$TOP_K" \
    --top-p "$TOP_P" \
    --repeat-penalty "$REPEAT_PENALTY" \
    --threads-http "$HTTP_THREADS" \
    $CONT_BATCH_FLAGS \
    $MLOCK_FLAG \
    --cache-type-k "$KV_CACHE_QUANT" \
    --cache-type-v "$KV_CACHE_QUANT"
