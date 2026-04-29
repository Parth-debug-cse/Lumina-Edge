#!/bin/bash
# Test script to verify model loading works end-to-end

set -e

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "🧪 Testing Lumina Edge Model Loading"
echo "===================================="

# Check venv
if [ ! -d "venv" ]; then
    echo "❌ Virtual environment not found. Run setup first."
    exit 1
fi

source venv/bin/activate

# Test 1: Check MLX-LM
echo -e "\n📦 Test 1: Checking MLX-LM installation..."
python3 -c "import mlx_lm; print('✓ MLX-LM is installed')" || {
    echo "❌ MLX-LM not found"
    exit 1
}

# Test 2: Check model files
echo -e "\n📂 Test 2: Checking model files..."
MODEL_DIR="models/LFM2.5-1.2B-Instruct-MLX-4bit"
if [ ! -d "$MODEL_DIR" ]; then
    echo "❌ Model directory not found: $MODEL_DIR"
    exit 1
fi

if [ ! -f "$MODEL_DIR/config.json" ]; then
    echo "❌ config.json not found in model directory"
    exit 1
fi

if [ ! -f "$MODEL_DIR/model.safetensors" ]; then
    echo "❌ model.safetensors not found in model directory"
    exit 1
fi

echo "✓ Model files present"
echo "  - config.json: $(wc -c < "$MODEL_DIR/config.json") bytes"
echo "  - model.safetensors: $(du -h "$MODEL_DIR/model.safetensors" | cut -f1)"

# Test 3: Direct model loading
echo -e "\n🔄 Test 3: Loading model directly..."
python3 << 'PYEOF'
import mlx_lm
import os
model_path = os.path.abspath("models/LFM2.5-1.2B-Instruct-MLX-4bit")
try:
    print(f"Loading from: {model_path}")
    model, tokenizer = mlx_lm.load(model_path)
    print(f"✓ Model loaded successfully")
    print(f"  - Model type: {type(model).__name__}")
    print(f"  - Tokenizer: {type(tokenizer).__name__}")
except Exception as e:
    print(f"❌ Loading failed: {e}")
    exit(1)
PYEOF

# Test 4: Start MLX API server
echo -e "\n🚀 Test 4: Starting MLX API server..."
python3 scripts/mlx_backend.py --mode api --model models/LFM2.5-1.2B-Instruct-MLX-4bit --port 9997 &
SERVER_PID=$!
echo "Server PID: $SERVER_PID"

sleep 5

# Test 5: Check server is responding
echo -e "\n✅ Test 5: Checking API server response..."
if curl -s http://127.0.0.1:9997/v1/models | grep -q "data"; then
    echo "✓ API server is responding correctly"
else
    echo "❌ API server not responding"
    kill $SERVER_PID 2>/dev/null || true
    exit 1
fi

# Cleanup
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

echo -e "\n✅ All tests passed! Model loading works correctly."
