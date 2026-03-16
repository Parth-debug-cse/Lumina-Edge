#!/usr/bin/env bash
# ==============================================================================
# Lumina Edge :: Core Controller (Vulkan) — Linux
# Interactive chat mode using llama-cli with Vulkan backend
# ==============================================================================

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ==================================================
# AUTO-DETECT PROJECT ROOT
# ==================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$ROOT/bin"
MODELS="$ROOT/models"
SCRIPTS="$ROOT/scripts"

cd "$ROOT"

# ==================================================
# UTILITY: Press any key
# ==================================================
pause() {
    echo ""
    read -n1 -r -p "Press any key to continue..." || true
    echo ""
}

# ==================================================
# UTILITY: Human-readable file size
# ==================================================
human_size() {
    local bytes=${1:-0}
    if [[ $bytes -ge 1073741824 ]]; then
        awk -v b="$bytes" 'BEGIN { printf "%.1f GB\n", b / 1073741824 }'
    elif [[ $bytes -ge 1048576 ]]; then
        awk -v b="$bytes" 'BEGIN { printf "%.1f MB\n", b / 1048576 }'
    elif [[ $bytes -ge 1024 ]]; then
        awk -v b="$bytes" 'BEGIN { printf "%.1f KB\n", b / 1024 }'
    else
        echo "$bytes bytes"
    fi
}

# ==================================================
# VALIDATE REQUIRED DIRECTORIES
# ==================================================
if [[ ! -d "$BIN" ]]; then
    clear 2>/dev/null || true
    echo "=================================================="
    echo "ERROR :: bin directory not found"
    echo "=================================================="
    echo ""
    echo "Expected at: $BIN"
    echo ""
    echo "Please install llama.cpp binaries in the bin folder."
    echo ""
    echo "Download from:"
    echo "  https://github.com/ggml-org/llama.cpp/releases"
    echo ""
    echo "Look for: llama-bXXX-bin-ubuntu-x64.zip (Vulkan)"
    echo ""
    pause
    exit 1
fi

if [[ ! -d "$MODELS" ]]; then
    clear 2>/dev/null || true
    echo "=================================================="
    echo "ERROR :: models directory not found"
    echo "=================================================="
    echo ""
    echo "Expected at: $MODELS"
    echo ""
    echo "Please create the models folder and add your GGUF files."
    echo "Or run model-manager.sh to download a model."
    echo ""
    pause
    exit 1
fi

if [[ ! -d "$SCRIPTS" ]]; then
    clear 2>/dev/null || true
    echo "=================================================="
    echo "ERROR :: scripts directory not found"
    echo "=================================================="
    echo ""
    echo "Expected at: $SCRIPTS"
    echo ""
    pause
    exit 1
fi

# ==================================================
# LOCATE llama-cli EXECUTABLE
# ==================================================
if [[ -x "$BIN/llama-cli" ]]; then
    CLI_EXE="$BIN/llama-cli"
elif [[ -f "$BIN/llama-cli" ]]; then
    chmod +x "$BIN/llama-cli"
    CLI_EXE="$BIN/llama-cli"
else
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  ERROR :: llama-cli NOT FOUND"
    echo "=================================================="
    echo ""
    echo "Expected:"
    echo "  $BIN/llama-cli"
    echo ""
    echo "Install llama.cpp correctly and retry."
    echo "Download Linux binaries from:"
    echo "  https://github.com/ggml-org/llama.cpp/releases"
    echo ""
    pause
    exit 1
fi

# ==================================================
# MODEL SELECTION
# ==================================================
select_model() {
    while true; do
        clear 2>/dev/null || true
        echo "=================================================="
        echo "  LUMINA EDGE :: SELECT A MODEL"
        echo "=================================================="
        echo ""
        echo "Available models:"
        echo ""

        local model_count=0
        declare -a model_paths=()
        declare -a model_names=()
        shopt -s nullglob
        for f in "$MODELS"/*.gguf; do
            ((model_count++)) || true
            model_paths+=("$f")
            local fname
            fname="$(basename "$f")"
            model_names+=("$fname")
            local fsize
            fsize=$(stat --format="%s" "$f" 2>/dev/null || stat -f "%z" "$f" 2>/dev/null || echo "0")
            echo "  $model_count. $fname"
            echo "     Size: $(human_size "$fsize")"
            echo ""
        done
        shopt -u nullglob

        if [[ $model_count -eq 0 ]]; then
            echo "  No models found in:"
            echo "  $MODELS"
            echo ""
            echo "  Please download a model using model-manager.sh first."
            echo ""
            pause
            exit 1
        fi

        echo "  D. Download a new model"
        echo "  0. Exit"
        echo ""
        echo "=================================================="
        echo ""
        read -r -p "Select model (1-$model_count): " model_choice || true

        if [[ "${model_choice^^}" == "D" ]]; then
            if [[ -x "$ROOT/model-manager.sh" ]]; then
                "$ROOT/model-manager.sh" || true
            else
                echo ""
                echo -e "${YELLOW}  model-manager.sh not found or not executable.${NC}"
                pause
            fi
            continue
        fi

        if [[ "$model_choice" == "0" ]]; then
            exit 0
        fi

        # Validate numeric input is in range
        if [[ "$model_choice" =~ ^[0-9]+$ ]] && [[ "$model_choice" -ge 1 ]] && [[ "$model_choice" -le $model_count ]]; then
            SELECTED_MODEL="${model_paths[$((model_choice - 1))]}"
            SELECTED_NAME="${model_names[$((model_choice - 1))]}"
            return
        fi

        echo ""
        echo "  Invalid selection. Please try again."
        sleep 2
    done
}

# ==================================================
# BOOT SCREEN
# ==================================================
boot_screen() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  LUMINA EDGE :: LOCAL LLM CONTROLLER"
    echo "=================================================="
    echo ""
    echo -e "${GREEN}[OK]${NC} Project Root : $ROOT"
    echo -e "${GREEN}[OK]${NC} Model        : $SELECTED_NAME"
    echo -e "${GREEN}[OK]${NC} Backend      : Vulkan (Integrated GPU)"
    echo -e "${GREEN}[OK]${NC} Mode         : Local Chat"
    echo ""
    sleep 1
}

# ==================================================
# MAIN MENU
# ==================================================
main_menu() {
    while true; do
        clear 2>/dev/null || true
        echo "=================================================="
        echo "  LUMINA EDGE :: MAIN MENU"
        echo "=================================================="
        echo ""
        echo "  Current Model: $SELECTED_NAME"
        echo "  Backend      : Vulkan (Integrated GPU)"
        echo ""
        echo "  1. Initialize Local LLM"
        echo "  2. Change Model"
        echo "  3. Exit"
        echo ""
        echo "=================================================="
        echo ""
        read -r -p "lumina@edge> " choice || true

        case "$choice" in
            1) init_llm ;;
            2) select_model; boot_screen ;;
            3) exit 0 ;;
            *) ;;
        esac
    done
}

# ==================================================
# INITIALIZATION PIPELINE
# ==================================================
init_llm() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  STAGE 1 :: MEMORY RECLAMATION"
    echo "=================================================="
    echo ""

    if [[ -x "$SCRIPTS/optimize_system.sh" ]]; then
        if [[ $EUID -eq 0 ]]; then
            bash "$SCRIPTS/optimize_system.sh" || true
        else
            echo -e "${YELLOW}[NOTE] Running optimizer with sudo for full memory reclamation...${NC}"
            echo -e "${GRAY}       Enter your password if prompted, or press Ctrl+C to skip.${NC}"
            echo ""
            sudo bash "$SCRIPTS/optimize_system.sh" || {
                echo -e "${YELLOW}[WARN] Optimization skipped or partially completed.${NC}"
            }
        fi
    else
        echo -e "${YELLOW}[WARN] optimize_system.sh not found or not executable. Skipping.${NC}"
    fi

    echo ""
    echo -e "${GREEN}[OK] Memory optimization complete.${NC}"
    sleep 1

    clear 2>/dev/null || true
    echo "=================================================="
    echo "  STAGE 2 :: LLM INITIALIZATION"
    echo "=================================================="
    echo ""
    echo "  Model   : $SELECTED_NAME"
    echo "  Backend : Vulkan (Integrated GPU)"
    echo "  Context : 3072 tokens"
    echo "  Threads : 4"
    echo ""
    echo "Press CTRL+C to exit chat."
    echo "=================================================="
    echo ""

    trap 'echo ""; echo "  SESSION INTERRUPTED"' SIGINT
    "$CLI_EXE" \
        -m "$SELECTED_MODEL" \
        -t 4 \
        -c 3072 \
        --color auto \
        -cnv \
        --multiline-input \
        -sys "You are a precise, efficient AI assistant." || true
    trap - SIGINT

    # ==================================================
    # POST-SESSION
    # ==================================================
    echo ""
    echo "=================================================="
    echo "  SESSION ENDED"
    echo "=================================================="
    echo ""
    read -r -p "Return to menu? (Y/N): " restart || true
    if [[ "${restart^^}" != "Y" ]]; then
        exit 0
    fi
}

# ==================================================
# RUN
# ==================================================
select_model
boot_screen
main_menu
