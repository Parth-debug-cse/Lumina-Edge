#!/bin/bash
# ==============================================================================
# start_api.sh — Quick-start wrapper. All settings are read from config.json.
# Edit config.json or use the UI Settings page to change behavior.
# Usage: ./start_api.sh [--model path] [--port port] [--gpu vulkan|nvidia|mlx]
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

# Auto-detect model: check startup.default_model, then first .gguf (Linux/Win) or .safetensors dir (macOS)
if [[ -z "$MODEL" ]]; then
    MODEL="$(get_config startup.default_model '')"
fi
if [[ -z "$MODEL" ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
        MODEL="$(find models -maxdepth 2 -name '*.safetensors' -o -name '*.mlx' 2>/dev/null | head -1 | xargs -I{} dirname {})"
    else
        MODEL="$(find models -maxdepth 1 -name '*.gguf' 2>/dev/null | head -1)"
    fi
fi

if [[ -z "$MODEL" ]]; then
    echo "ERROR: No model found."
    echo "  Place a model file in ./models/ and set 'model' in config.json, or:"
    echo "  ./start_api.sh --model models/your-model.gguf"
    echo ""
    echo "  For macOS: use an MLX model directory, e.g.:"
    echo "  ./start_api.sh --model models/Llama-3.2-3B/"
    exit 1
fi

echo "Model: $MODEL"

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
    FLASH_ATTN_FLAG="--flash-attn on"
else
    FLASH_ATTN_FLAG="--flash-attn off"
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

# KV cache quantization (llama.cpp only)
KV_QUANT_FLAGS="--cache-type-k q4 --cache-type-v q4"

CONT_BATCH_FLAGS=""
if [[ "$CONT_BATCHING" == "true" ]]; then
    CONT_BATCH_FLAGS="--cont-batching"
fi

echo "Starting Lumina Edge API..."
echo "Model: $MODEL"
echo "GPU: $GPU"
echo "Port: $PORT"

ROOT="$(pwd)"
RUNDIR="$ROOT/.lumina_run"
mkdir -p "$RUNDIR" 2>/dev/null
PID_FILE="$RUNDIR/pids.txt"
UI_PORT="${LUMINA_UI_PORT:-$(get_config ui_port 5173)}"
API_PORT_SECONDARY="${LUMINA_API_PORT_SECONDARY:-$(get_config api_port_secondary 8081)}"

cleanup() {
    if [[ -f "$PID_FILE" ]]; then
        while read pid cmd; do
            kill "$pid" 2>/dev/null || true
        done < "$PID_FILE"
        rm -f "$PID_FILE"
    fi
}
trap cleanup EXIT INT TERM

# -- 1. Start backend (MLX on macOS, llama-server on Linux) --
if [[ "$GPU" == "mlx" ]]; then
    echo "Backend: MLX (Apple Silicon)"
    SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)/scripts"
    BACKEND_LOG="$RUNDIR/mlx_backend.log"
    echo "  Starting MLX backend (log: $BACKEND_LOG)..."
    python3 "$SCRIPTS_DIR/mlx_backend.py" --mode api --model "$MODEL" --port "$PORT" >> "$BACKEND_LOG" 2>&1 &
    BACKEND_PID=$!
    echo "$BACKEND_PID mlx_backend" >> "$PID_FILE"
    echo "  PID: $BACKEND_PID"

    echo "  Waiting for MLX backend to be ready..."
    for i in $(seq 1 60); do
        health_response=$(curl -s --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null)
        if echo "$health_response" | grep -q '"status":"ok"'; then
            echo "  ✓ MLX backend ready on port $PORT"
            break
        fi
        if ! kill -0 $BACKEND_PID 2>/dev/null; then
            echo "  ✗ MLX backend exited unexpectedly"
            tail -20 "$BACKEND_LOG" 2>/dev/null
            exit 1
        fi
        sleep 1
    done
else
    echo "Context Size: $CTX_SIZE"
    echo "GPU Layers: $N_GPU_LAYERS"
    BACKEND_LOG="$RUNDIR/llama_server.log"
    echo ""
    echo "  Starting llama-server in background (log: $BACKEND_LOG)..."
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
        --jinja \
        $CONT_BATCH_FLAGS \
        $MLOCK_FLAG \
        $NO_MMAP_FLAG \
        $MOE_FLAGS \
        $KV_QUANT_FLAGS \
        >> "$BACKEND_LOG" 2>&1 &
    BACKEND_PID=$!
    echo "$BACKEND_PID llama_server" >> "$PID_FILE"
    echo "  PID: $BACKEND_PID"

    echo "  Waiting for llama-server to be ready..."
    for i in $(seq 1 30); do
        if curl -s --max-time 2 "http://127.0.0.1:$PORT/v1/models" 2>/dev/null | grep -q 'model'; then
            echo "  ✓ Backend ready on port $PORT"
            break
        fi
        if ! kill -0 $BACKEND_PID 2>/dev/null; then
            echo "  ✗ Backend process exited unexpectedly"
            tail -20 "$BACKEND_LOG" 2>/dev/null
            exit 1
        fi
        sleep 1
    done
fi

# -- 2. Start Node API gateway --
echo "  Starting Lumina Core API gateway..."
UI_DIR="$ROOT/ui"
API_LOG="$RUNDIR/api_server.log"
cd "$UI_DIR"

LUMINA_API_PORT="$PORT" \
LUMINA_MLX_PORT="$PORT" \
LUMINA_API_PORT_SECONDARY="$API_PORT_SECONDARY" \
node api-server.js >> "$API_LOG" 2>&1 &
API_PID=$!
echo "$API_PID api_server" >> "$PID_FILE"
echo "  API server PID: $API_PID"

echo "  Waiting for API server..."
for i in $(seq 1 30); do
    if curl -s --max-time 2 "http://127.0.0.1:$API_PORT_SECONDARY/api/health" 2>/dev/null | grep -q 'ok'; then
        echo "  ✓ API gateway ready"
        break
    fi
    if curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q 'ok'; then
        echo "  ✓ API gateway ready"
        break
    fi
    if ! kill -0 $API_PID 2>/dev/null; then
        echo "  ✗ API server exited unexpectedly"
        tail -20 "$API_LOG" 2>/dev/null
        exit 1
    fi
    sleep 1
done

# -- 3. Start Vite UI --
echo "  Starting Lumina Core UI..."
UI_LOG="$RUNDIR/vite.log"
npm run dev >> "$UI_LOG" 2>&1 &
UI_PID=$!
echo "$UI_PID vite" >> "$PID_FILE"
echo "  Vite PID: $UI_PID"

echo "  Waiting for Vite dev server..."
for i in $(seq 1 20); do
    if curl -s --max-time 2 "http://localhost:$UI_PORT/" 2>/dev/null | grep -q '<html'; then
        echo "  ✓ Lumina Core UI ready at http://localhost:$UI_PORT"
        break
    fi
    sleep 1
done

cd "$ROOT"

echo ""
echo "============================================================"
echo "  Lumina Edge — All systems ready"
echo "============================================================"
echo ""
echo "  Model:       $MODEL"
echo "  Backend:     http://127.0.0.1:$PORT"
echo "  Lumina Core: http://localhost:$UI_PORT"
echo ""
echo "  Logs:        $RUNDIR/"
echo "  PIDs:        $PID_FILE"
echo "============================================================"
echo ""
echo "Press Ctrl+C to stop all services."
wait
