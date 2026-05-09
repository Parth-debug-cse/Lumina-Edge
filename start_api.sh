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
# IMPORTANT: On macOS use --gpu mlx and specify an MLX model directory
# On Linux/Windows use a GGUF file, e.g., models/your-model.gguf
MODEL=""
GPU="vulkan"

if [[ "$(uname -s)" == "Darwin" ]]; then
    GPU="mlx"
fi

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
PORT="${OVERRIDE_PORT:-$(get_config api_port 8090)}"
CTX_SIZE=$(get_config ctx_size 16384)
N_GPU_LAYERS=$(get_config n_gpu_layers 15)
BATCH_SIZE=$(get_config batch_size 256)
UBATCH_SIZE=$(get_config ubatch_size 256)
FLASH_ATTN=$(get_config flash_attn true)
MIN_P=$(get_config min_p 0.05)
TOP_K=$(get_config top_k 20)
TOP_P=$(get_config top_p 0.9)
REPEAT_PENALTY=$(get_config repeat_penalty 1.1)
HTTP_THREADS=$(get_config http_threads 2)
CONT_BATCHING=$(get_config cont_batching true)
KV_CACHE_QUANT=$(get_config kv_cache_quant 'f16')
USE_MLOCK=$(get_config use_mlock true)
NO_MMAP=$(get_config no_mmap 'true')
MOE_MODEL=$(get_config moe_model 'false')
MOE_OVERRIDE=$(get_config moe_override_tensor '""')
KV_QUANT=$(get_config kv_quant 'turbo')

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

# MoE offloading flags (llama.cpp only)
MOE_FLAGS=""
if [[ "$MOE_MODEL" == "true" ]]; then
    if [[ -n "$MOE_OVERRIDE" && "$MOE_OVERRIDE" != "" ]]; then
        MOE_FLAGS="-ot $MOE_OVERRIDE"
    else
        MOE_FLAGS="--cpu-moe"
    fi
fi

# no-mmap flag (llama.cpp only)
NO_MMAP_FLAG=""
if [[ "$NO_MMAP" == "true" ]]; then
    NO_MMAP_FLAG="--no-mmap"
fi

# KV cache quantization with TurboQuant (llama.cpp only)
# TurboQuant requires -fa as a hard dependency
KV_QUANT_FLAGS=""
if [[ "$KV_QUANT" == "turbo" ]]; then
    KV_QUANT_FLAGS="--flash-attn --cache-type-k turbo4 --cache-type-v turbo3"
elif [[ "$KV_QUANT" == "q8_0" ]]; then
    KV_QUANT_FLAGS="--cache-type-k q8_0 --cache-type-v q8_0"
elif [[ "$KV_QUANT" == "q4_0" ]]; then
    KV_QUANT_FLAGS="--cache-type-k q4_0 --cache-type-v q4_0"
fi

CONT_BATCH_FLAGS=""
if [[ "$CONT_BATCHING" == "true" ]]; then
    CONT_BATCH_FLAGS="--cont-batching"
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
    --batch-size "$BATCH_SIZE" \
    --ubatch-size "$UBATCH_SIZE" \
    $FLASH_ATTN_FLAG \
    --min-p "$MIN_P" \
    --top-k "$TOP_K" \
    --top-p "$TOP_P" \
    --repeat-penalty "$REPEAT_PENALTY" \
    --threads-http "$HTTP_THREADS" \
    $CONT_BATCH_FLAGS \
    $MLOCK_FLAG \
    $NO_MMAP_FLAG \
    $MOE_FLAGS \
    $KV_QUANT_FLAGS
