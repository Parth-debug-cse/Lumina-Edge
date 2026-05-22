#!/bin/bash
# ==============================================================================
# M1 Mac Hackathon Demo Setup — Lumina Edge + OpenClaw + Llama 3.2 1B
# Run this on your M1 Mac before the demo. One-shot setup.
# ==============================================================================
set -e

echo "============================================================"
echo "  Lumina Edge + OpenClaw — M1 Mac Demo Setup"
echo "============================================================"
echo ""

# 1. Install dependencies
echo "[1/5] Installing dependencies..."
if ! command -v brew &>/dev/null; then
    echo "  Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

if ! command -v llama-server &>/dev/null; then
    echo "  Installing llama.cpp (with Metal support)..."
    brew install llama.cpp
fi

if ! command -v openclaw &>/dev/null; then
    echo "  Installing OpenClaw..."
    npm install -g openclaw@latest
fi
echo "  ✓ Dependencies ready"

# 2. Download model
echo "[2/5] Downloading Llama 3.2 1B Instruct..."
MODEL="models/Llama-3.2-1B-Instruct-Q4_K_M.gguf"
mkdir -p models
if [ ! -f "$MODEL" ]; then
    if command -v hf &>/dev/null; then
        # Use huggingface-cli if available (faster, parallel downloads)
        hf download bartowski/Llama-3.2-1B-Instruct-GGUF Llama-3.2-1B-Instruct-Q4_K_M.gguf --local-dir ./models
    else
        pip install -q huggingface-hub
        python3 -c "
from huggingface_hub import hf_hub_download
hf_hub_download('bartowski/Llama-3.2-1B-Instruct-GGUF', 'Llama-3.2-1B-Instruct-Q4_K_M.gguf', local_dir='./models')
"
    fi
    echo "  ✓ Model downloaded"
else
    echo "  ✓ Model already exists"
fi

# 3. Configure OpenClaw
echo "[3/5] Configuring OpenClaw..."
mkdir -p ~/.openclaw
cat > ~/.openclaw/openclaw.json << 'ENDCONFIG'
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "auth": { "mode": "none" },
    "controlUi": { "enabled": true },
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true },
        "responses": { "enabled": true }
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "lumina/Llama-3.2-1B-Instruct-Q4_K_M.gguf" },
      "models": {
        "lumina/Llama-3.2-1B-Instruct-Q4_K_M.gguf": { "alias": "Llama 3.2 1B" }
      },
      "timeoutSeconds": 600
    }
  },
  "models": {
    "mode": "merge",
    "providers": {
      "lumina": {
        "baseUrl": "http://127.0.0.1:8090/v1",
        "apiKey": "lumina-local",
        "api": "openai-completions",
        "timeoutSeconds": 600,
        "models": [{
          "id": "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
          "name": "Llama 3.2 1B Instruct (Lumina Edge)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 32768,
          "maxTokens": 8192
        }]
      }
    }
  }
}
ENDCONFIG
echo "  ✓ OpenClaw configured"

# 4. Start llama-server with full Metal GPU acceleration
echo "[4/5] Starting llama-server with Metal acceleration..."
pkill -f "llama-server" 2>/dev/null || true
sleep 1
nohup llama-server \
  -m "$MODEL" \
  --port 8090 --host 127.0.0.1 \
  --ctx-size 32768 --cont-batching \
  --batch-size 512 --ubatch-size 512 \
  -ngl 99 \  # Offload ALL layers to GPU (Metal on M1)
  > /tmp/llama_server.log 2>&1 &
echo "  Waiting for server..."
for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:8090/v1/models 2>/dev/null | grep -q "Llama-3.2-1B"; then
        echo "  ✓ llama-server ready (Metal GPU accelerated)"
        break
    fi
    sleep 1
done

# 5. Start OpenClaw gateway
echo "[5/5] Starting OpenClaw Gateway..."
pkill -f "openclaw gateway" 2>/dev/null || true
sleep 1
rm -rf ~/.openclaw/agents/main/sessions/ 2>/dev/null
nohup openclaw gateway > /tmp/openclaw_gateway.log 2>&1 &
sleep 10
echo "  ✓ OpenClaw Gateway ready"

echo ""
echo "============================================================"
echo "  DEMO READY — Test these endpoints:"
echo "============================================================"
echo ""
echo "  1. Direct API (fast, zero overhead):"
echo "     curl http://127.0.0.1:8090/v1/chat/completions \\"
echo "       -H 'Content-Type: application/json' \\"
echo "       -d '{\"model\":\"Llama-3.2-1B-Instruct-Q4_K_M.gguf\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello!\"}],\"max_tokens\":50}'"
echo ""
echo "  2. OpenClaw Gateway Agent:"
echo "     openclaw agent --agent main --message \"say hello in one word\" --timeout 300"
echo ""
echo "  3. OpenAI-compatible (any client):"
echo "     Endpoint: http://127.0.0.1:18789/v1/chat/completions"
echo "     Model: openclaw"
echo ""
echo "  4. Direct (no agent overhead):"
echo "     Endpoint: http://127.0.0.1:8090/v1/chat/completions"
echo "     Model: Llama-3.2-1B-Instruct-Q4_K_M.gguf"
echo ""
echo "============================================================"
