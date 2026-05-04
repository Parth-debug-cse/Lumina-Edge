#!/bin/bash

# Quick test to bypass interactive input and test model selection
cd /home/parth/Documents/in_development/2026-Lumina-Edge-LLM-Inference-Framework

# Test the model selection logic directly
MODELS="./models"
model_choice="1"

model_count=0
declare -a model_paths=() model_names=()

shopt -s nullglob
for f in "$MODELS"/*.{gguf,safetensors,bin,pt}; do
    [[ -e "$f" ]] || continue
    ((model_count++)) || true
    model_paths+=("$f")
    fname="$(basename "$f")"
    model_names+=("$fname")
    echo "Model $model_count: $fname"
done
shopt -u nullglob

echo "Testing selection $model_choice..."
if [[ "$model_choice" =~ ^[0-9]+$ ]] && (( model_choice >= 1 && model_choice <= model_count )); then
    selected_file="${model_paths[$((model_choice - 1))]}"
    echo "SUCCESS: Selected $selected_file"
    
    # Test starting the server directly
    echo "Starting API server..."
    ./bin/llama-server -m "$selected_file" --port 8080 --host 127.0.0.1 --ctx-size 4096 --n-gpu-layers 15 --threads 2 --threads-batch 4 --batch-size 256 --ubatch-size 256 --flash-attn on --defrag-thold 0.1 --warmup --min-p 0.05 --top-k 20 --threads-http 2 --cont-batching --parallel 1 &
    SERVER_PID=$!
    echo "Server started with PID: $SERVER_PID"
    sleep 3
    echo "Testing API..."
    curl -s http://127.0.0.1:8080/v1/models | head -5
    kill $SERVER_PID
else
    echo "FAILED: Invalid selection"
fi
