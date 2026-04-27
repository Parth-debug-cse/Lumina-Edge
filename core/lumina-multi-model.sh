#!/bin/bash
# ==============================================================================
# Lumina Edge :: Multi-Model Router (Linux/Vulkan && NVIDIA variants)
# Load multiple models in parallel and route requests via model-router
# ==============================================================================

set -e

# Detect GPU variant from script name
SCRIPT_NAME=$(basename "$0")
if [[ "$SCRIPT_NAME" == *"nvidia"* ]]; then
    GPU_VARIANT="nvidia"
    BASE_GPU_LAYERS=33
else
    GPU_VARIANT="vulkan"
    BASE_GPU_LAYERS=99
fi

# Color palette
PRIMARY='\033[0;36m'      # Cyan
SUCCESS='\033[0;32m'      # Green
WARNING='\033[0;33m'      # Yellow
DANGER='\033[0;31m'       # Red
PURPLE='\033[0;35m'       # Purple
CYAN='\033[0;36m'         # Cyan
GRAY='\033[0;90m'         # Dark Gray
TEXT='\033[0m'            # Reset

# Pure ASCII logo for consistent rendering
print_logo() {
    echo -e "${PRIMARY}"
    cat <<'EOF'
   _     _             _____  _           _ 
  | |   (_)           |  _  || |         | |
  | |__  _   _  __ _ | | | || |__   ___ | |
  | '_ \| | | |/ _` || | | || '_ \ / _ \| |
  | |_) | | | | (_| || |/ / | | | | (_) | |
  |_.__/|_| |_| \__, ||___/  |_| |_|\___/|_|
                  __/ |                        
                 |___/                         
EOF
    echo -e "${TEXT}"
}

progress_bar() {
    # Args: label [steps] [sleep_s]
    local label="${1:-Working...}"
    local steps="${2:-24}"
    local sleep_s="${3:-0.02}"
    local i
    echo -ne "${GRAY}${label}${TEXT} "
    for ((i=0; i<steps; i++)); do
        printf "${PRIMARY}█${TEXT}"
        sleep "${sleep_s}"
    done
    echo ""
}

run_with_spinner() {
    # Runs a command while showing an animated spinner.
    # Args: label cmd...
    local label="$1"; shift
    local tmp
    tmp="$(mktemp 2>/dev/null || echo "/tmp/lumina-ui.$RANDOM")"

    "$@" >"$tmp" 2>&1 &
    local pid=$!

    local spinners=( '|' '/' '-' '\\' )
    local spin_i=0
    while kill -0 "$pid" >/dev/null 2>&1; do
        printf "\r${GRAY}%s${TEXT} ${CYAN}%s${TEXT}" "$label" "${spinners[$((spin_i%4))]}"
        spin_i=$((spin_i+1))
        sleep 0.12
    done

    wait "$pid" >/dev/null 2>&1
    local rc=$?

    if [[ $rc -eq 0 ]]; then
        printf "\r${SUCCESS}✓${TEXT} %s\n" "$label"
    else
        printf "\r${DANGER}✗${TEXT} %s\n" "$label"
        echo -e "${GRAY}Last output:${TEXT}"
        tail -n 20 "$tmp" 2>/dev/null | sed 's/^/  /'
    fi

    rm -f "$tmp" >/dev/null 2>&1 || true
    return "$rc"
}

# Helper functions
print_banner() {
    print_logo
    echo "╔════════════════════════════════════════════════════════════════╗"
    echo "║          ⚡ LUMINA EDGE :: Multi-Model Router (${GPU_VARIANT^^})       ║"
    echo "║                  Parallel Model Loading & Routing               ║"
    echo "╚════════════════════════════════════════════════════════════════╝"
    echo -e "${TEXT}"
}

divider() {
    echo -e "${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━_${TEXT}"
}

section() {
    echo -e "\n${CYAN}  ▸ $1${TEXT}"
}

success_msg() {
    echo -e "${SUCCESS}  ✓ $1${TEXT}"
}

error_msg() {
    echo -e "${DANGER}  ✗ $1${TEXT}"
}

warn_msg() {
    echo -e "${WARNING}  ⚠ $1${TEXT}"
}

info_msg() {
    echo -e "${CYAN}  ℹ $1${TEXT}"
}

# ==============================================================================
# Auto-detect project root (same as single-model scripts)
# ==============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="$PROJECT_ROOT/bin"
MODELS="$PROJECT_ROOT/models"
SCRIPTS="$PROJECT_ROOT/scripts"
CONFIG="$PROJECT_ROOT/config.json"

# Get base API port from config
API_PORT=$(jq -r '.api_port // 1234' "$CONFIG" 2>/dev/null || echo "1234")
BASE_MODEL_PORT=8000  # Models start from 8000, 8001, 8002, etc.

# ==============================================================================
# Validate requirements
# ==============================================================================
print_banner

section "Validation & Setup"

# Check directories
if [[ ! -d "$BIN" ]]; then
    error_msg "bin directory not found at $BIN"
    exit 1
fi

if [[ ! -d "$MODELS" ]]; then
    error_msg "models directory not found at $MODELS"
    exit 1
fi

if [[ ! -d "$SCRIPTS" ]]; then
    error_msg "scripts directory not found at $SCRIPTS"
    exit 1
fi

success_msg "Project structure validated"

# Check for llama-server
if [[ ! -f "$BIN/llama-server" ]]; then
    error_msg "llama-server executable not found in $BIN"
    exit 1
fi

success_msg "llama-server executable found"

# Check Python dependencies
if ! command -v python3 &>/dev/null; then
    error_msg "Python3 not found"
    exit 1
fi

if [[ ! -f "$SCRIPTS/model-router.py" ]]; then
    error_msg "model-router.py not found in scripts directory"
    exit 1
fi

success_msg "All dependencies found"

# ==============================================================================
# Scan for models
# ==============================================================================
divider
section "Model Discovery"

MODEL_ARRAY=()
MODEL_COUNT=0

# Scan for all supported formats
shopt -s nullglob
for model_file in "$MODELS"/*.{gguf,safetensors,bin,pt}; do
    if [[ -f "$model_file" ]]; then
        MODEL_ARRAY+=("$model_file")
        ((MODEL_COUNT++))
        
        # Detect format
        extension="${model_file##*.}"
        case "$extension" in
            gguf)
                FORMAT="GGUF"
                FORMAT_COLOR="$SUCCESS"
                ;;
            safetensors)
                FORMAT="SafeTensor"
                FORMAT_COLOR="$PURPLE"
                ;;
            bin|pt)
                FORMAT="FP16"
                FORMAT_COLOR="$WARNING"
                ;;
        esac
        
        echo -e "  [$MODEL_COUNT] ${FORMAT_COLOR}[$FORMAT]${TEXT} $(basename "$model_file")"
    fi
done
shopt -u nullglob

if [[ $MODEL_COUNT -eq 0 ]]; then
    error_msg "No models found in $MODELS"
    echo -e "  ${GRAY}Please add model files to the models directory${TEXT}"
    exit 1
fi

echo ""
success_msg "Found $MODEL_COUNT model(s)"

# ==============================================================================
# Model Selection for Parallel Loading
# ==============================================================================
divider
section "Multi-Model Selection"

echo -e "  ${CYAN}Pick models${TEXT}: enter numbers separated by commas (e.g. 1,3,4)."
echo -e "  ${CYAN}Or type${TEXT} 'all' ${CYAN}to load everything${TEXT}."
echo ""

declare -a SELECTED_MODELS=()
declare -a SELECTED_PORTS=()

add_selected_index() {
    local idx_1based="$1"
    local i=$((idx_1based - 1))
    local model="${MODEL_ARRAY[$i]}"
    SELECTED_MODELS+=("$model")
    local port=$((BASE_MODEL_PORT + ${#SELECTED_MODELS[@]} - 1))
    SELECTED_PORTS+=("$port")
    success_msg "Selected $(basename "$model") → port $port"
}

read -r -p "  Selection> " selection || true
selection="${selection//[[:space:]]/}"

if [[ -z "$selection" ]]; then
    error_msg "No selection provided"
    exit 1
fi

parse_selection() {
    local selection="$1"
    
    if [[ "${selection,,}" == "all" ]]; then
        for ((i = 1; i <= MODEL_COUNT; i++)); do
            add_selected_index "$i"
        done
    else
        declare -A seen=()
        IFS=',' read -ra tokens <<< "$selection"
        for tok in "${tokens[@]}"; do
            tok="${tok//[[:space:]]/}"
            if [[ "$tok" =~ ^([0-9]+)-([0-9]+)$ ]]; then
                local start="${BASH_REMATCH[1]}"
                local end="${BASH_REMATCH[2]}"
                if (( start > end )); then
                    local tmp="$start"; start="$end"; end="$tmp"
                fi
                for ((idx=start; idx<=end; idx++)); do
                    if (( idx < 1 || idx > MODEL_COUNT )); then continue; fi
                    if [[ -n "${seen[$idx]:-}" ]]; then continue; fi
                    seen["$idx"]=1
                    add_selected_index "$idx"
                done
            elif [[ "$tok" =~ ^[0-9]+$ ]]; then
                local idx="$tok"
                if (( idx < 1 || idx > MODEL_COUNT )); then
                    warn_msg "Ignoring out-of-range model number: $idx"
                    continue
                fi
                if [[ -n "${seen[$idx]:-}" ]]; then continue; fi
                seen["$idx"]=1
                add_selected_index "$idx"
            else
                warn_msg "Ignoring invalid token: $tok"
            fi
        done
    fi
}

parse_selection "$selection"

if [[ ${#SELECTED_MODELS[@]} -eq 0 ]]; then
    error_msg "No models selected"
    exit 1
fi

echo ""
success_msg "Ready to load ${#SELECTED_MODELS[@]} model(s) in parallel"

# ==============================================================================
# Simulate parallel loading (show what would happen)
# ==============================================================================
divider
section "Parallel Loading Plan"

for ((i = 0; i < ${#SELECTED_MODELS[@]}; i++)); do
    MODEL="${SELECTED_MODELS[$i]}"
    PORT="${SELECTED_PORTS[$i]}"
    GPU_LAYERS=$BASE_GPU_LAYERS
    
    echo -e "  Model $((i+1)): $(basename "$MODEL")"
    echo -e "    ${GRAY}Port: $PORT${TEXT}"
    echo -e "    ${GRAY}GPU Layers: $GPU_LAYERS${TEXT}"
    
    # Check if conversion needed
    if [[ "$MODEL" == *.safetensors ]] || [[ "$MODEL" == *.bin ]] || [[ "$MODEL" == *.pt ]]; then
        BASE=$(basename "$MODEL" .${MODEL##*.})
        GGUF_PATH="$MODELS/${BASE}.gguf"
        if [[ ! -f "$GGUF_PATH" ]]; then
            warn_msg "Conversion needed: $MODEL → $GGUF_PATH"
        fi
    fi
    echo ""
done

# ==============================================================================
# Router Configuration
# ==============================================================================
divider
section "Router Configuration"

echo -e "  ${CYAN}Select routing policy:${TEXT}"
echo "    [1] round-robin (default - balance by inference count)"
echo "    [2] load-balanced (same as round-robin)"
echo "    [3] first-available (use fastest ready model)"
echo ""
echo -n "  Choice (1-3): "
read -r routing_choice

case "$routing_choice" in
    2)
        ROUTING_POLICY="load-balanced"
        ;;
    3)
        ROUTING_POLICY="first-available"
        ;;
    *)
        ROUTING_POLICY="round-robin"
        ;;
esac

success_msg "Routing policy: $ROUTING_POLICY"

# ==============================================================================
# Export Configuration for Router
# ==============================================================================
divider
section "Exporting Router Configuration"

ROUTER_CONFIG="/tmp/lumina_router_config.json"

cat > "$ROUTER_CONFIG" << EOF
{
  "routing_policy": "$ROUTING_POLICY",
  "models": [$(printf '"%s",' "${SELECTED_MODELS[@]}" | sed 's/,$//')],
  "start_port": $BASE_MODEL_PORT,
  "api_port": $API_PORT,
  "gpu_variant": "$GPU_VARIANT"
}
EOF

success_msg "Router config exported to $ROUTER_CONFIG"

# ==============================================================================
# Instructions for Manual Parallel Loading
# ==============================================================================
divider
section "Manual Model Loading (Reference)"

echo -e "  ${GRAY}To load models in parallel, you can use:${TEXT}"
echo ""
echo -e "  ${CYAN}# Start multiple llama-server instances${TEXT}"
for ((i = 0; i < ${#SELECTED_MODELS[@]}; i++)); do
    MODEL="${SELECTED_MODELS[$i]}"
    PORT="${SELECTED_PORTS[$i]}"
    echo -e "  ${GRAY}\$BIN/llama-server -m $MODEL --port $PORT ...${TEXT}"
done

echo ""
echo -e "  ${CYAN}# Or use the model-router.py${TEXT}"
echo -e "  ${GRAY}python3 $SCRIPTS/model-router.py load $(printf '%s ' "${SELECTED_MODELS[@]}") \\${TEXT}"
echo -e "  ${GRAY}  --bin-path $BIN --scripts $SCRIPTS --models-dir $MODELS${TEXT}"

echo ""
success_msg "Models are ready for parallel loading"

# ==============================================================================
# Auto-start Option
# ==============================================================================
divider

echo -n "  Would you like to start the models now? (y/n): "
read -r start_choice

if [[ "$start_choice" =~ ^[Yy]$ ]]; then
    section "Starting Parallel Model Loading"
    
    # Start router in background
    echo ""
    info_msg "Launching model router..."
    
    cd "$PROJECT_ROOT"
    run_with_spinner "Model load & router startup" python3 "$SCRIPTS/model-router.py" load "${SELECTED_MODELS[@]}" \
        --bin-path "$BIN" \
        --scripts "$SCRIPTS" \
        --models-dir "$MODELS"
    
    success_msg "All models loaded successfully!"
    echo ""
    echo -e "  ${CYAN}API Endpoints:${TEXT}"
    for ((i = 0; i < ${#SELECTED_MODELS[@]}; i++)); do
        PORT="${SELECTED_PORTS[$i]}"
        echo -e "    http://127.0.0.1:$PORT/v1"
    done
    echo ""
    success_msg "Router is ready to dispatch requests"
else
    info_msg "Setup complete. Models ready for manual loading."
fi

divider
echo ""
