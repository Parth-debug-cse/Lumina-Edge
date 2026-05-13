#!/bin/bash
# ==============================================================================
# install-goose.sh — Install Goose (by Block/AAIF) and configure it for
#                    Lumina Edge's local OpenAI-compatible API on port 8090.
#
# Usage: ./install-goose.sh
# ==============================================================================

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"

# ──────────────────────────────────────────────────────────────────────────────
# Step 1: Detect platform
# ──────────────────────────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin)
    PLATFORM="macos"
    ;;
  Linux)
    PLATFORM="linux"
    ;;
  *)
    echo "[install-goose] Unsupported OS: $OS"
    echo "  This script supports macOS and Linux only."
    echo "  For Windows, use install-goose.ps1"
    exit 1
    ;;
esac

echo "[install-goose] Platform: $PLATFORM ($ARCH)"

# ──────────────────────────────────────────────────────────────────────────────
# Step 2: Check for existing Goose installation
# ──────────────────────────────────────────────────────────────────────────────
if command -v goose &>/dev/null; then
  echo "[install-goose] Goose already installed at $(which goose)"
  GOOSE_EXISTING=true
else
  GOOSE_EXISTING=false
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 3: Install Goose if not present
# ──────────────────────────────────────────────────────────────────────────────
if [ "$GOOSE_EXISTING" = false ]; then
  echo "[install-goose] Installing Goose..."

  if [ "$PLATFORM" = "macos" ]; then
    # macOS: download binary from GitHub
    # NOTE: 'brew install goose' installs a database migration tool, NOT the AI agent.
    # Always download the AI Goose binary directly.
    echo "[install-goose] Downloading Goose binary from GitHub..."
      # Determine macOS arch
      if [ "$ARCH" = "arm64" ]; then
        BREW_ARCH="aarch64"
      else
        BREW_ARCH="x86_64"
      fi
      # Try to get latest release from GitHub
      LATEST_URL="https://github.com/block/goose/releases/latest/download/goose-$BREW_ARCH-apple-darwin.tar.gz"
      echo "[install-goose] Downloading: $LATEST_URL"
      curl -fsSL "$LATEST_URL" -o /tmp/goose.tar.gz
      sudo tar -xzf /tmp/goose.tar.gz -C /usr/local/bin goose 2>/dev/null || \
      tar -xzf /tmp/goose.tar.gz -C ~/.local/bin goose 2>/dev/null || {
        echo "[install-goose] Extracting to current directory..."
        tar -xzf /tmp/goose.tar.gz
        mkdir -p ~/.local/bin
        cp goose ~/.local/bin/goose
        export PATH="$HOME/.local/bin:$PATH"
      }
      rm -f /tmp/goose.tar.gz
    fi
  else
    # Linux: download binary
    if [ "$ARCH" = "x86_64" ] || [ "$ARCH" = "amd64" ]; then
      LINUX_ARCH="x86_64"
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
      LINUX_ARCH="aarch64"
    else
      LINUX_ARCH="x86_64"
    fi
    LATEST_URL="https://github.com/block/goose/releases/latest/download/goose-$LINUX_ARCH-unknown-linux-gnu.tar.gz"
    echo "[install-goose] Downloading: $LATEST_URL"
    curl -fsSL "$LATEST_URL" -o /tmp/goose.tar.gz
    mkdir -p ~/.local/bin
    tar -xzf /tmp/goose.tar.gz -C ~/.local/bin goose 2>/dev/null || {
      echo "[install-goose] Extracting full archive..."
      tar -xzf /tmp/goose.tar.gz -C ~/.local/bin
    }
    export PATH="$HOME/.local/bin:$PATH"
    rm -f /tmp/goose.tar.gz
  fi

  if command -v goose &>/dev/null; then
    echo "[install-goose] Goose installed successfully!"
  else
    echo "[install-goose] WARNING: goose binary not found in PATH after install."
    echo "  You may need to add ~/.local/bin to your PATH, or restart your shell."
  fi
fi

# ──────────────────────────────────────────────────────────────────────────────
# Step 4: Create Goose config directory and write config.yaml
# ──────────────────────────────────────────────────────────────────────────────
GOOSE_CONFIG_DIR="$HOME/.config/goose"
mkdir -p "$GOOSE_CONFIG_DIR"
mkdir -p "$GOOSE_CONFIG_DIR/custom_providers"

CONFIG_PATH="$GOOSE_CONFIG_DIR/config.yaml"

# Backup existing config if present
if [ -f "$CONFIG_PATH" ]; then
  cp "$CONFIG_PATH" "${CONFIG_PATH}.bak.$(date +%Y%m%d%H%M%S)"
  echo "[install-goose] Backed up existing config to ${CONFIG_PATH}.bak.*"
fi

echo "[install-goose] Writing Goose config to $CONFIG_PATH"

# Write the config file (heredoc)
# The model is left empty so Goose auto-detects from GET /v1/models
cat > "$CONFIG_PATH" << 'GOOSECFG'
# ==============================================================================
# Goose Configuration — Lumina Edge Integration
# Connects Goose to the local Lumina Edge API at http://localhost:8090/v1
# ==============================================================================

# Provider: OpenAI-compatible (Lumina Edge)
GOOSE_PROVIDER: "openai"
GOOSE_MODEL: ""
GOOSE_MODE: "auto"
GOOSE_MAX_TURNS: 1000

# Lumina Edge API endpoint — no auth required
OPENAI_API_KEY: "lumina-edge"
OPENAI_HOST: "http://localhost:8090"
OPENAI_BASE_PATH: "/v1"

# Extensions: enable the developer builtin for shell + file system access
extensions:
  developer:
    bundled: true
    enabled: true
    name: developer
    timeout: 300
    type: builtin
GOOSECFG

echo "[install-goose] Config written."

# ──────────────────────────────────────────────────────────────────────────────
# Step 5: Create custom provider JSON (fallback / GUI support)
# ──────────────────────────────────────────────────────────────────────────────
CUSTOM_PROVIDER_PATH="$GOOSE_CONFIG_DIR/custom_providers/lumina.json"

cat > "$CUSTOM_PROVIDER_PATH" << 'PROVIDERJSON'
{
  "name": "lumina_edge",
  "engine": "openai",
  "display_name": "Lumina Edge",
  "description": "Local LLM via Lumina Edge on port 8090",
  "base_url": "http://localhost:8090/v1",
  "models": [],
  "requires_auth": false,
  "supports_streaming": true
}
PROVIDERJSON

echo "[install-goose] Custom provider written to $CUSTOM_PROVIDER_PATH"

# ──────────────────────────────────────────────────────────────────────────────
# Step 6: Verify connection to Lumina Edge API
# ──────────────────────────────────────────────────────────────────────────────
echo ""
echo "[install-goose] Checking if Lumina Edge API is running on port 8090..."
if curl -s --max-time 5 "http://localhost:8090/v1/models" 2>/dev/null | grep -q '"data"'; then
  echo "[install-goose] ✅ Lumina Edge API is running!"
  MODELS=$(curl -s --max-time 5 "http://localhost:8090/v1/models" 2>/dev/null)
  echo "[install-goose] Available models:"
  echo "$MODELS" | python3 -m json.tool 2>/dev/null || echo "$MODELS"
  echo ""
  echo "[install-goose] You can now run Goose:"
  echo "  goose session start"
  echo ""
  echo "  Or use the single-command launcher:"
  echo "  ./start-goose.sh"
else
  echo "[install-goose] ⚠️  Lumina Edge API is not running on port 8090."
  echo "  Start it first with:"
  echo "    ./start_api.sh"
  echo ""
  echo "  Then verify with:"
  echo "    curl http://localhost:8090/v1/models"
  echo ""
  echo "  Or use the combined launcher that starts both:"
  echo "    ./start-goose.sh"
fi

echo ""
echo "[install-goose] ✅ Installation complete!"
echo "  Config: $CONFIG_PATH"
echo ""
echo "  To verify your Goose configuration:"
echo "    goose info -v"
