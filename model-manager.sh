#!/usr/bin/env bash
# ==============================================================================
# Lumina Edge :: Model Manager (Linux)
# Download, list, and delete GGUF models
# ==============================================================================

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# This script is interactive; avoid infinite loops on EOF
if [[ ! -t 0 ]]; then
    echo -e "${RED}[ERROR] Non-interactive stdin detected. Run this script in a terminal.${NC}"
    exit 1
fi

# ==================================================
# AUTO-DETECT PROJECT ROOT
# ==================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR"
MODELS="$ROOT/models"

cd "$ROOT"

# Create models directory if it doesn't exist
if [[ ! -d "$MODELS" ]]; then
    mkdir -p "$MODELS"
    echo -e "${GREEN}[OK] Created models directory: $MODELS${NC}"
    sleep 1
fi

# ==================================================
# UTILITY: Detect download tool
# ==================================================
DOWNLOAD_TOOL=""
if command -v wget &>/dev/null; then
    DOWNLOAD_TOOL="wget"
elif command -v curl &>/dev/null; then
    DOWNLOAD_TOOL="curl"
else
    echo -e "${RED}[ERROR] Neither wget nor curl found. Please install one:${NC}"
    echo "  sudo apt install wget"
    echo "  sudo apt install curl"
    exit 1
fi

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
# UTILITY: Download a file
# ==================================================
download_file() {
    local url="${1:-}"
    local dest="${2:-}"

    if [[ -z "$url" || -z "$dest" ]]; then return 1; fi

    if [[ "$DOWNLOAD_TOOL" == "wget" ]]; then
        wget --timeout=60 --show-progress -O "$dest" "$url" 2>&1
        local exit_code=$?
        if [[ $exit_code -ne 0 ]]; then
            echo -e "${RED}[ERROR] wget failed with exit code: $exit_code${NC}"
            return 1
        fi
    else
        curl -L --max-time 1800 --connect-timeout 60 --progress-bar -o "$dest" "$url"
        local exit_code=$?
        if [[ $exit_code -ne 0 ]]; then
            echo -e "${RED}[ERROR] curl failed with exit code: $exit_code${NC}"
            return 1
        fi
    fi
    
    # Verify the file was actually downloaded
    if [[ ! -f "$dest" ]]; then
        echo -e "${RED}[ERROR] Download file not created: $dest${NC}"
        return 1
    fi
    
    if [[ ! -s "$dest" ]]; then
        echo -e "${RED}[ERROR] Downloaded file is empty: $dest${NC}"
        return 1
    fi
    
    return 0
}

# ==================================================
# UTILITY: Press any key
# ==================================================
pause() {
    echo ""
    if [[ -t 0 ]]; then
        read -n1 -r -p "Press any key to continue..." || true
    else
        return 0
    fi
    echo ""
}

# ==================================================
# VERSION CHECK (fetch once)
# ==================================================
BUILD_DIFF=0
if [[ -x "$ROOT/bin/llama-cli" ]]; then
    LOCAL_BUILD=$("$ROOT/bin/llama-cli" --version 2>/dev/null | grep -o 'b[0-9]*' | head -1 | tr -d 'b' || echo "")
    if [[ -n "$LOCAL_BUILD" ]]; then
        if [[ "$DOWNLOAD_TOOL" == "curl" ]]; then
            LATEST_BUILD=$(curl -s "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" | grep '"tag_name"' | head -1 | grep -o 'b[0-9]*' | tr -d 'b' || echo "")
        else
            LATEST_BUILD=$(wget -qO- "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" | grep '"tag_name"' | head -1 | grep -o 'b[0-9]*' | tr -d 'b' || echo "")
        fi

        if [[ -n "$LATEST_BUILD" ]] && [[ "$LATEST_BUILD" =~ ^[0-9]+$ ]] && [[ "$LOCAL_BUILD" =~ ^[0-9]+$ ]]; then
            BUILD_DIFF=$(( LATEST_BUILD - LOCAL_BUILD ))
        fi
    fi
fi

# ==================================================
# MAIN MENU
# ==================================================
main_menu() {
    while true; do
        clear 2>/dev/null || true
        echo "=================================================="
        echo "  LUMINA EDGE :: MODEL MANAGER"
        echo "=================================================="
        echo ""
        echo "  Models location: $MODELS"
        echo ""

        if [[ $BUILD_DIFF -gt 30 ]]; then
            echo -e "${YELLOW}[!] Your llama.cpp binaries may be outdated (local: b${LOCAL_BUILD}, latest: b${LATEST_BUILD}).${NC}"
            echo -e "${YELLOW}    Re-download from: github.com/ggml-org/llama.cpp/releases${NC}"
            echo ""
        fi
        echo "  1. Download a new model"
        echo "  2. List downloaded models"
        echo "  3. Delete a model"
        echo "  0. Exit"
        echo ""
        echo "=================================================="
        echo ""
        read -r -p "lumina@edge> " choice || true

        case "$choice" in
            1) download_menu ;;
            2) list_models ;;
            3) delete_model ;;
            0) exit 0 ;;
            *) ;;
        esac
    done
}

# ==================================================
# DOWNLOAD MENU - PREDEFINED MODELS
# ==================================================
download_menu() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  DOWNLOAD A MODEL"
    echo "=================================================="
    echo ""
    echo "  Available models (GGUF format):"
    echo ""
    echo "  1. Phi-3-mini-4k-instruct  (2.3GB) - Fast, good for 4GB RAM"
    echo "  2. TinyLlama-1.1B-Chat     (0.7GB) - Very small, very fast"
    echo "  3. Mistral-7B-Instruct-v0.2 (4.1GB) - Balanced quality"
    echo "  4. Llama-3-8B-Instruct      (4.7GB) - High quality"
    echo "  5. Mistral-7B-Instruct IQ4_XS  (4.0GB) - Better quality than Q4_K_M, same size"
    echo "  6. Llama-3-8B-Instruct IQ4_XS  (4.6GB) - Better quality than Q4_K_M, same size"
    echo "  7. Custom URL"
    echo "  0. Back"
    echo ""
    echo "=================================================="
    echo ""
    read -r -p "Select model to download: " choice || true

    case "$choice" in
        1)
            MODEL_URL="https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf"
            MODEL_NAME="phi-3-mini-4k-instruct.Q4_K_M.gguf"
            do_download
            ;;
        2)
            MODEL_URL="https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"
            MODEL_NAME="tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf"
            do_download
            ;;
        3)
            MODEL_URL="https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf"
            MODEL_NAME="mistral-7b-instruct-v0.2.Q4_K_M.gguf"
            do_download
            ;;
        4)
            MODEL_URL="https://huggingface.co/TheBloke/Llama-3-8B-Instruct-GGUF/resolve/main/llama-3-8b-instruct.Q4_K_M.gguf"
            MODEL_NAME="llama-3-8b-instruct.Q4_K_M.gguf"
            do_download
            ;;
        5)
            MODEL_URL="https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF/resolve/main/Mistral-7B-Instruct-v0.3-IQ4_XS.gguf"
            MODEL_NAME="Mistral-7B-Instruct-v0.3-IQ4_XS.gguf"
            do_download
            ;;
        6)
            MODEL_URL="https://huggingface.co/bartowski/Meta-Llama-3-8B-Instruct-GGUF/resolve/main/Meta-Llama-3-8B-Instruct-IQ4_XS.gguf"
            MODEL_NAME="Meta-Llama-3-8B-Instruct-IQ4_XS.gguf"
            do_download
            ;;
        7)
            custom_download
            ;;
        0) return ;;
        *) download_menu ;;
    esac
}

# ==================================================
# CUSTOM DOWNLOAD
# ==================================================
custom_download() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  CUSTOM MODEL DOWNLOAD"
    echo "=================================================="
    echo ""
    echo "Enter the direct download URL for the GGUF file:"
    echo "(Must be a direct link to a .gguf file on HuggingFace)"
    echo ""
    echo "Example:"
    echo "https://huggingface.co/TheBloke/model-name-GGUF/resolve/main/model.Q4_K_M.gguf"
    echo ""
    echo "=================================================="
    echo ""
    read -r -p "URL: " MODEL_URL || true

    if [[ -z "$MODEL_URL" ]]; then
        return
    fi

    # Validate URL format
    if [[ ! "$MODEL_URL" =~ ^https?:// ]]; then
        echo ""
        echo -e "${RED}[ERROR] Invalid URL format. URL must start with http:// or https://${NC}"
        pause
        return
    fi

    # Extract filename from URL
    MODEL_NAME="$(basename "$MODEL_URL")"

    # Validate filename ends with .gguf
    if [[ ! "$MODEL_NAME" =~ \.gguf$ ]]; then
        echo ""
        echo -e "${YELLOW}[WARNING] Filename does not end with .gguf. Continue anyway?${NC}"
        read -r -p "Continue? (Y/N): " confirm_gguf || true
        if [[ "${confirm_gguf^^}" != "Y" ]]; then
            return
        fi
    fi

    echo ""
    echo "Model will be saved as: $MODEL_NAME"
    echo ""
    read -r -p "Continue? (Y/N): " confirm || true
    if [[ "${confirm^^}" != "Y" ]]; then
        return
    fi

    do_download
}

# ==================================================
# DOWNLOAD PROCESS
# ==================================================
do_download() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  DOWNLOADING MODEL"
    echo "=================================================="
    echo ""
    echo "  Model : $MODEL_NAME"
    echo "  URL   : $MODEL_URL"
    echo "  Tool  : $DOWNLOAD_TOOL"
    echo ""
    echo "This may take several minutes depending on your internet speed..."
    echo ""
    echo "=================================================="
    echo ""

    # Check if model already exists
    if [[ -f "$MODELS/$MODEL_NAME" ]]; then
        echo -e "${YELLOW}[WARNING] Model already exists: $MODEL_NAME${NC}"
        echo ""
        read -r -p "Overwrite? (Y/N): " overwrite || true
        if [[ "${overwrite^^}" != "Y" ]]; then
            return
        fi
        rm -f "$MODELS/$MODEL_NAME"
    fi

    # Get expected file size from headers (if available)
    local expected_size=0
    if [[ "$DOWNLOAD_TOOL" == "curl" ]]; then
        expected_size=$(curl -sI "$MODEL_URL" 2>/dev/null | grep -i "content-length" | awk '{print $2}' | tr -d '\r') || expected_size="0"
    else
        expected_size=$(wget --spider -S "$MODEL_URL" 2>&1 | grep -i "content-length" | awk '{print $2}' | tr -d '\r') || expected_size="0"
    fi
    
    if [[ -n "$expected_size" && "$expected_size" =~ ^[0-9]+$ && "$expected_size" -gt 0 ]]; then
        echo "Expected file size: $(human_size "$expected_size")"
        echo ""
    fi

    # Download with timeout (30 minutes max)
    if download_file "$MODEL_URL" "$MODELS/$MODEL_NAME"; then
        # Verify final file size
        local final_size
        final_size=$(stat --format="%s" "$MODELS/$MODEL_NAME" 2>/dev/null || stat -f "%z" "$MODELS/$MODEL_NAME" 2>/dev/null || echo "0")
        
        # Check if file size is suspiciously small (likely an error page or incomplete download)
        if [[ "$final_size" -lt 1000 ]]; then
            echo -e "${RED}[ERROR] Downloaded file is suspiciously small ($final_size bytes).${NC}"
            echo "This may be an error page or incomplete download."
            download_failed
            return
        fi
        
        # If we knew expected size, verify it matches (within 1% tolerance)
        if [[ -n "$expected_size" && "$expected_size" =~ ^[0-9]+$ && "$expected_size" -gt 0 ]]; then
            local size_diff
            size_diff=$(awk -v f="$final_size" -v e="$expected_size" 'BEGIN { diff = (f - e) / e; if (diff < 0) diff = -diff; print diff }')
            if (( $(awk -v d="$size_diff" 'BEGIN { print (d > 0.01) }') )); then
                echo -e "${YELLOW}[WARNING] File size mismatch! Expected: $(human_size "$expected_size"), Got: $(human_size "$final_size")${NC}"
                echo "Download may be incomplete."
            fi
        fi
        
        clear 2>/dev/null || true
        echo "=================================================="
        echo "  DOWNLOAD COMPLETE"
        echo "=================================================="
        echo ""
        echo "  Model saved to:"
        echo "  $MODELS/$MODEL_NAME"
        echo ""
        echo "  File size: $(human_size "$final_size") ($final_size bytes)"
        echo ""
        pause
    else
        download_failed
    fi
}

download_failed() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  DOWNLOAD FAILED"
    echo "=================================================="
    echo ""
    echo "Possible reasons:"
    echo "  - Invalid URL"
    echo "  - No internet connection"
    echo "  - Insufficient disk space"
    echo "  - HuggingFace rate limit (try again later)"
    echo ""
    # Remove partial download
    rm -f "$MODELS/$MODEL_NAME" 2>/dev/null
    pause
}

# ==================================================
# LIST DOWNLOADED MODELS
# ==================================================
list_models() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  DOWNLOADED MODELS"
    echo "=================================================="
    echo ""
    echo "  Location: $MODELS"
    echo ""

    local count=0
    shopt -s nullglob
    for f in "$MODELS"/*.gguf; do
        ((count++)) || true
        local fname
        fname="$(basename "$f")"
        local fsize
        fsize=$(stat --format="%s" "$f" 2>/dev/null || stat -f "%z" "$f" 2>/dev/null || echo "0")
        echo "  $count. $fname"
        echo "     Size: $(human_size "$fsize") ($fsize bytes)"
        echo ""
    done
    shopt -u nullglob

    if [[ $count -eq 0 ]]; then
        echo "  No models found. Download a model first."
        echo ""
    fi

    echo "  Total models: $count"
    echo ""
    pause
}

# ==================================================
# DELETE MODEL
# ==================================================
delete_model() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  DELETE A MODEL"
    echo "=================================================="
    echo ""
    echo "  Select a model to delete:"
    echo ""

    local count=0
    declare -a model_files=()
    shopt -s nullglob
    for f in "$MODELS"/*.gguf; do
        ((count++)) || true
        model_files+=("$f")
        local fname
        fname="$(basename "$f")"
        echo "  $count. $fname"
    done
    shopt -u nullglob

    if [[ $count -eq 0 ]]; then
        echo "  No models found."
        echo ""
        pause
        return
    fi

    echo ""
    echo "  0. Cancel"
    echo ""
    read -r -p "Enter number: " choice || true

    if [[ "$choice" == "0" ]] || [[ -z "$choice" ]]; then
        return
    fi

    # Validate selection is in range
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [[ "$choice" -lt 1 ]] || [[ "$choice" -gt $count ]]; then
        echo ""
        echo "  Invalid selection."
        pause
        return
    fi

    local target_file="${model_files[$((choice - 1))]}"
    local target_name
    target_name="$(basename "$target_file")"

    echo ""
    echo "  Deleting: $target_name"
    echo ""
    read -r -p "Are you sure? (Y/N): " confirm || true
    if [[ "${confirm^^}" != "Y" ]]; then
        return
    fi

    if rm "$target_file" 2>/dev/null; then
        echo ""
        echo -e "  ${GREEN}[OK] Model deleted successfully.${NC}"
    else
        echo ""
        echo -e "  ${RED}[ERROR] Failed to delete model.${NC}"
    fi

    echo ""
    pause
}

# ==================================================
# RUN
# ==================================================
main_menu
