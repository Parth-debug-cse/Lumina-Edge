#!/bin/bash
# ==============================================================================
# start-goose.sh — Single-command entry point for the full agentic workflow.
#  1. Starts Lumina Edge API server on port 8090
#  2. Waits for it to be ready
#  3. Launches Goose (connected to local LLM)
#
# Usage: ./start-goose.sh
#        ./start-goose.sh --model path/to/model
#        ./start-goose.sh --help
# ==============================================================================

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

# ----------------------------------------------------------------------
# Parse arguments
# ----------------------------------------------------------------------
MODEL_OVERRIDE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL_OVERRIDE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--model path/to/model]"
      echo ""
      echo "Starts Lumina Edge API + Goose agentic coding assistant."
      echo "  --model   Override model path (auto-detected if not set)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
log()  { echo "[start-goose] $*"; }
log_ok(){ echo "[start-goose] ✓ $*"; }
log_err(){ echo "[start-goose] ✗ $*" >&2; }

get_config() {
  local key="$1"
  local default="$2"
  if command -v python3 &>/dev/null && [[ -f "$ROOT/config.json" ]]; then
    python3 -c "
import json
try:
    cfg = json.load(open('$ROOT/config.json'))
    parts = '$key'.split('.')
    v = cfg
    for p in parts:
        v = v[p] if isinstance(v, dict) and p in v else None
    print(v if v is not None else $default)
except:
    print($default)
" 2>/dev/null || echo "$default"
  else
    echo "$default"
  fi
}

port_wait() {
  local port="$1"
  local max="$2"
  for i in $(seq 1 "$max"); do
    if curl -s --max-time 2 "http://127.0.0.1:$port/v1/models" 2>/dev/null | grep -q '"data"'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# ----------------------------------------------------------------------
# Detect platform
# ----------------------------------------------------------------------
OS="$(uname -s)"
if [[ "$OS" == "Darwin" ]]; then
  PLATFORM="macos"
elif [[ "$OS" == "Linux" ]]; then
  PLATFORM="linux"
else
  log_err "Unsupported OS: $OS"
  exit 1
fi

log "Platform: $PLATFORM"

# ----------------------------------------------------------------------
# Determine model path
# ----------------------------------------------------------------------
MODEL_PATH="$MODEL_OVERRIDE"
if [[ -z "$MODEL_PATH" ]]; then
  MODEL_PATH="$(get_config startup.default_model '')"
fi
if [[ -z "$MODEL_PATH" ]]; then
  if [[ "$PLATFORM" == "macos" ]]; then
    # macOS: find MLX model directory
    MODEL_PATH="$(find "$ROOT/models" -maxdepth 2 -name '*.safetensors' -o -name '*.mlx' 2>/dev/null | head -1 | xargs -I{} dirname {} 2>/dev/null || true)"
  else
    MODEL_PATH="$(find "$ROOT/models" -maxdepth 1 -name '*.gguf' 2>/dev/null | head -1 || true)"
  fi
fi

if [[ -z "$MODEL_PATH" ]]; then
  log_err "No model found. Place a model in ./models/ or specify with --model"
  log "  macOS: MLX model directory (with config.json + .safetensors)"
  log "  Linux: .gguf file"
  exit 1
fi

log "Model: $MODEL_PATH"

# ----------------------------------------------------------------------
# Start Lumina Edge API server
# ----------------------------------------------------------------------
log "Starting Lumina Edge API server on port 8090..."

if [[ "$PLATFORM" == "macos" ]]; then
  # macOS: MLX backend
  SCRIPTS="$ROOT/scripts"
  python3 "$SCRIPTS/mlx_backend.py" \
    --mode api \
    --model "$MODEL_PATH" \
    --port 8090 &
  LUMINA_PID=$!
  log "  MLX backend PID: $LUMINA_PID"
else
  # Linux: llama-server
  LLAMA_SERVER="$ROOT/bin/llama-server"
  if [[ ! -x "$LLAMA_SERVER" ]]; then
    log_err "llama-server not found at $LLAMA_SERVER"
    exit 1
  fi

  CTX_SIZE=$(get_config ctx_size 16384)
  N_GPU_LAYERS=$(get_config n_gpu_layers 99)
  "$LLAMA_SERVER" \
    -m "$MODEL_PATH" \
    --port 8090 \
    --host 127.0.0.1 \
    --ctx-size "$CTX_SIZE" \
    --n-gpu-layers "$N_GPU_LAYERS" &
  LUMINA_PID=$!
  log "  llama-server PID: $LUMINA_PID"
fi

# ----------------------------------------------------------------------
# Wait for server to be ready
# ----------------------------------------------------------------------
log "Waiting for server to be ready..."
if port_wait 8090 60; then
  log_ok "Lumina Edge API ready at http://127.0.0.1:8090/v1"
else
  log_err "Lumina Edge API failed to start within 60 seconds"
  kill "$LUMINA_PID" 2>/dev/null || true
  exit 1
fi

# ----------------------------------------------------------------------
# All set — print instructions for Goose Desktop
# ----------------------------------------------------------------------
log ""
log "============================================================"
log "  Lumina Edge API is ready for Goose"
log "============================================================"
log ""
log_ok "Lumina Edge API ready at http://localhost:8090/v1"
log "Open Goose Desktop and select: Lumina Edge → Qwen3-4B-Instruct-2507-4bit"
log "Press Ctrl+C to stop the API server."
log ""

# Trap Ctrl+C for clean shutdown
cleanup() {
  log ""
  log "Shutting down..."
  kill "$LUMINA_PID" 2>/dev/null || true
  log_ok "Done"
  exit 0
}
trap cleanup SIGINT SIGTERM

# Wait for the Lumina server process
wait $LUMINA_PID
