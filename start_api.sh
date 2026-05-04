#!/bin/bash

# Quick API starter - bypass interactive selection
cd "$(dirname "$0")"

# Default model selection
MODEL="models/Qwen3.5-Coder-4b-Instruct-IQ4_XS.gguf"
PORT="8080"
GPU="vulkan"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --model)
            MODEL="$2"; shift 2
            ;;
        --port)
            PORT="$2"; shift 2
            ;;
        --gpu)
            GPU="$2"; shift 2
            ;;
        *)
            echo "Usage: $0 [--model path] [--port port] [--gpu vulkan|nvidia]"
            exit 1
            ;;
    esac
done

echo "Starting Lumina Edge API..."
echo "Model: $MODEL"
echo "GPU: $GPU"
echo "Port: $PORT"

# Start the server directly with 16K context
./bin/llama-server -m "$MODEL" --port "$PORT" --host 127.0.0.1 --ctx-size 16384 --n-gpu-layers 15 --threads 2 --threads-batch 4 --batch-size 256 --ubatch-size 256 --flash-attn on --defrag-thold 0.1 --warmup --min-p 0.05 --top-k 20 --threads-http 2 --cont-batching --parallel 1
