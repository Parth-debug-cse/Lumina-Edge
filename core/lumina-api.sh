#!/usr/bin/env bash
# ==============================================================================
# Lumina Edge :: Local API Server (Vulkan) — Linux
# OpenAI-compatible REST API using llama-server with Vulkan backend
# ==============================================================================

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Auto-detect project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$ROOT/bin"; MODELS="$ROOT/models"; SCRIPTS="$ROOT/scripts"
PORT=1234

cd "$ROOT"

pause() { echo ""; read -n1 -r -p "Press any key to continue..." || true; echo ""; }

human_size() {
    local bytes=${1:-0}
    if [[ $bytes -ge 1073741824 ]]; then awk -v b="$bytes" 'BEGIN { printf "%.1f GB\n", b / 1073741824 }'
    elif [[ $bytes -ge 1048576 ]]; then awk -v b="$bytes" 'BEGIN { printf "%.1f MB\n", b / 1048576 }'
    elif [[ $bytes -ge 1024 ]]; then awk -v b="$bytes" 'BEGIN { printf "%.1f KB\n", b / 1024 }'
    else echo "$bytes bytes"; fi
}

# Validate directories
for dir_name in BIN MODELS SCRIPTS; do
    dir_val="${!dir_name}"
    if [[ ! -d "$dir_val" ]]; then
        echo "ERROR :: ${dir_name,,} directory not found at: $dir_val"; pause; exit 1
    fi
done

# Locate server executable
SERVER_EXE=""
for name in llama-server server; do
    if [[ -f "$BIN/$name" ]]; then
        chmod +x "$BIN/$name" 2>/dev/null || true
        SERVER_EXE="$BIN/$name"; break
    fi
done
if [[ -z "$SERVER_EXE" ]]; then
    echo "ERROR :: llama-server not found in $BIN"; pause; exit 1
fi

# Model selection
select_model() {
    while true; do
        clear 2>/dev/null || true
        echo "=================================================="; echo "  LUMINA EDGE :: SELECT A MODEL"
        echo "=================================================="; echo ""; echo "Available models:"; echo ""
        local model_count=0; declare -a model_paths=(); declare -a model_names=()
        shopt -s nullglob
        for f in "$MODELS"/*.gguf; do
            ((model_count++)) || true; model_paths+=("$f")
            local fname; fname="$(basename "$f")"
            model_names+=("$fname")
            local fsize; fsize=$(stat --format="%s" "$f" 2>/dev/null || echo "0")
            echo "  $model_count. $fname"; echo "     Size: $(human_size "$fsize")"; echo ""
        done; shopt -u nullglob
        if [[ $model_count -eq 0 ]]; then
            echo "  No models found. Download a model using model-manager.sh first."; pause; exit 1
        fi
        echo "  D. Download a new model"; echo "  0. Exit"; echo ""
        echo "=================================================="; echo ""
        read -r -p "Select model (1-$model_count): " model_choice || true
        if [[ "${model_choice^^}" == "D" ]]; then
            if [[ -x "$ROOT/model-manager.sh" ]]; then "$ROOT/model-manager.sh" || true; else echo "model-manager.sh not found."; pause; fi; continue
        fi
        if [[ "$model_choice" == "0" ]]; then exit 0; fi
        if [[ "$model_choice" =~ ^[0-9]+$ ]] && [[ "$model_choice" -ge 1 ]] && [[ "$model_choice" -le $model_count ]]; then
            SELECTED_MODEL="${model_paths[$((model_choice - 1))]}"; SELECTED_NAME="${model_names[$((model_choice - 1))]}"; return
        fi
        echo "  Invalid selection."; sleep 2
    done
}

main_menu() {
    while true; do
        clear 2>/dev/null || true
        echo "=================================================="; echo "  LUMINA EDGE :: API SERVER MENU"
        echo "=================================================="; echo ""
        echo "  Current Model: $SELECTED_NAME"; echo "  Backend      : Vulkan (Integrated GPU)"
        echo "  Endpoint     : http://127.0.0.1:$PORT/v1"; echo ""
        echo "  1. Start API Server"; echo "  2. Change Model"; echo "  3. Exit"
        echo ""; echo "=================================================="; echo ""
        read -r -p "lumina@edge> " choice || true
        case "$choice" in 1) port_check ;; 2) select_model ;; 3) exit 0 ;; esac
    done
}

port_check() {
    clear 2>/dev/null || true; echo "=================================================="; echo "  CHECKING PORT $PORT"
    echo "=================================================="; echo ""
    local port_in_use=false
    if command -v ss &>/dev/null; then
        if ss -tlnp 2>/dev/null | grep -q ":${PORT} "; then port_in_use=true; fi
    elif command -v lsof &>/dev/null; then
        if lsof -i ":$PORT" -sTCP:LISTEN &>/dev/null; then port_in_use=true; fi
    fi
    if $port_in_use; then
        echo "  ERROR :: PORT $PORT IS ALREADY IN USE"; echo ""
        echo "  To fix: sudo lsof -i :$PORT  then  kill <PID>"; pause; return
    fi
    echo -e "${GREEN}[OK] Port $PORT is available.${NC}"; sleep 1; init_server
}

init_server() {
    clear 2>/dev/null || true; echo "=================================================="; echo "  STAGE 1 :: MEMORY RECLAMATION"
    echo "=================================================="; echo ""
    if [[ -x "$SCRIPTS/optimize_system.sh" ]]; then
        if [[ $EUID -eq 0 ]]; then bash "$SCRIPTS/optimize_system.sh" || true
        else
            echo -e "${YELLOW}[NOTE] Running optimizer with sudo...${NC}"
            sudo bash "$SCRIPTS/optimize_system.sh" || echo -e "${YELLOW}[WARN] Optimization skipped.${NC}"
        fi
    fi
    echo ""; echo -e "${GREEN}[OK] Memory optimization complete.${NC}"; sleep 1

    clear 2>/dev/null || true; echo "=================================================="; echo "  STAGE 2 :: STARTING API SERVER"
    echo "=================================================="; echo ""
    echo "  OpenAI-compatible endpoint: http://127.0.0.1:$PORT/v1"; echo ""
    echo "  Model   : $SELECTED_NAME"; echo "  Backend : Vulkan (Integrated GPU)"
    echo "  Context : 3072 tokens"; echo "  Threads : 4"; echo ""
    echo "Press Ctrl+C to stop the server."; echo "=================================================="; echo ""

    trap 'echo ""; echo "=================================================="; echo "  SERVER STOPPED"; echo "=================================================="; echo ""' SIGINT
    "$SERVER_EXE" -m "$SELECTED_MODEL" --host 127.0.0.1 --port "$PORT" \
        --ctx-size 3072 --threads 4 --parallel 1 --verbose || true
    trap - SIGINT

    echo "If unexpected: port in use, model incompatible, or Vulkan missing"
    echo "  Install Vulkan: sudo apt install mesa-vulkan-drivers"; echo ""
    read -r -p "Return to menu? (Y/N): " restart || true
    if [[ "${restart^^}" != "Y" ]]; then exit 0; fi
}

select_model
main_menu
