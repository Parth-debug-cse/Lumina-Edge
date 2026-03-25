#!/usr/bin/env bash
# ==============================================================================
# ⚡ LUMINA EDGE :: Unified Launcher
# All-in-one entry point for chat, API, and multi-model modes
# Usage: ./lumina-launcher.sh --mode {api|core|router} --gpu {vulkan|nvidia} [--benchmark]
# ==============================================================================

set -euo pipefail

# ===== ENHANCED COLOR PALETTE =====
PRIMARY='\033[38;5;33m'      # Bright blue
SUCCESS='\033[38;5;46m'      # Bright green
WARNING='\033[38;5;226m'     # Bright yellow
DANGER='\033[38;5;196m'      # Bright red
PURPLE='\033[38;5;135m'      # Purple
CYAN='\033[38;5;51m'         # Cyan
GRAY='\033[38;5;244m'        # Gray
TEXT='\033[38;5;252m'        # Light text
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Legacy compatibility
GREEN="$SUCCESS"
YELLOW="$WARNING"

# ==================================================
# PARSE ARGUMENTS
# ==================================================
MODE=""
GPU=""
OPT_BENCHMARK=false
OPT_JSON_OUTPUT=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)
            MODE="$2"; shift 2
            ;;
        --gpu)
            GPU="$2"; shift 2
            ;;
        --benchmark)
            OPT_BENCHMARK=true; shift
            ;;
        --json-output)
            OPT_JSON_OUTPUT=true; shift
            ;;
        --help|-h)
            echo "LUMINA EDGE :: Unified Launcher"
            echo ""
            echo "Usage: ./lumina-launcher.sh --mode {api|core|router} --gpu {vulkan|nvidia} [OPTIONS]"
            echo ""
            echo "Modes:"
            echo "  api       - OpenAI-compatible REST API (llama-server)"
            echo "  core      - Interactive chat mode (llama-cli)"
            echo "  router    - Multi-model load balancer (model-router.py)"
            echo ""
            echo "GPU Backends:"
            echo "  vulkan    - Cross-platform Vulkan (AMD, NVIDIA, Intel)"
            echo "  nvidia    - NVIDIA CUDA (requires nvidia-smi)"
            echo ""
            echo "Options:"
            echo "  --benchmark     - Run inline benchmark after startup"
            echo "  --json-output   - Output results as JSON"
            echo "  --help, -h      - Show this message"
            echo ""
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# ==================================================
# VALIDATE ARGUMENTS
# ==================================================
if [[ -z "$MODE" ]]; then
    echo -e "${DANGER}✗${NC} ERROR: --mode is required (api, core, or router)"
    echo "Use --help for usage information"
    exit 1
fi

if [[ -z "$GPU" ]]; then
    echo -e "${DANGER}✗${NC} ERROR: --gpu is required (vulkan or nvidia)"
    echo "Use --help for usage information"
    exit 1
fi

if [[ ! "$MODE" =~ ^(api|core|router)$ ]]; then
    echo -e "${DANGER}✗${NC} ERROR: Invalid mode '$MODE'. Must be api, core, or router"
    exit 1
fi

if [[ ! "$GPU" =~ ^(vulkan|nvidia)$ ]]; then
    echo -e "${DANGER}✗${NC} ERROR: Invalid GPU backend '$GPU'. Must be vulkan or nvidia"
    exit 1
fi

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
# UTILITY FUNCTIONS
# ==================================================
pause() {
    echo ""
    [[ -t 0 ]] && read -n1 -r -p "$(echo -e "${GRAY}Press any key to continue...${NC}")" || true
    echo ""
}

print_banner() {
    local title="$1"
    echo -e "${PRIMARY}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${PRIMARY}║${NC} ${BOLD}$title${NC}${PRIMARY}$(printf ' %.0s' {1..55} | cut -c1-$((56 - ${#title})))║${NC}"
    echo -e "${PRIMARY}╚════════════════════════════════════════════════════════╝${NC}"
}

divider() {
    echo -e "${GRAY}─────────────────────────────────────────────────────────${NC}"
}

section() {
    echo -e "\n${PURPLE}▸ ${BOLD}$1${NC}"
}

status() {
    echo -e "${CYAN}ℹ${NC} $1"
}

success_msg() {
    echo -e "${SUCCESS}✓${NC} $1"
}

warn_msg() {
    echo -e "${YELLOW}⚠${NC} $1"
}

error_msg() {
    echo -e "${DANGER}✗${NC} $1"
}

human_size() {
    local bytes=${1:-0}
    if   [[ $bytes -ge 1073741824 ]]; then awk -v b="$bytes" 'BEGIN { printf "%.1f GB\n", b/1073741824 }'
    elif [[ $bytes -ge 1048576    ]]; then awk -v b="$bytes" 'BEGIN { printf "%.1f MB\n", b/1048576 }'
    elif [[ $bytes -ge 1024       ]]; then awk -v b="$bytes" 'BEGIN { printf "%.1f KB\n", b/1024 }'
    else echo "${bytes} bytes"; fi
}

print_logo() {
    # Pure ASCII logo for consistent rendering
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
    echo -e "${NC}"
}

progress_bar() {
    # Args: label [steps] [sleep_s]
    local label="${1:-Working...}"
    local steps="${2:-24}"
    local sleep_s="${3:-0.02}"
    local i
    echo -ne "${GRAY}${label}${NC} "
    for ((i=0; i<steps; i++)); do
        printf "${PRIMARY}█${NC}"
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
        printf "\r${GRAY}%s${NC} ${CYAN}%s${NC}" "$label" "${spinners[$((spin_i%4))]}"
        spin_i=$((spin_i+1))
        sleep 0.12
    done

    wait "$pid" >/dev/null 2>&1
    local rc=$?

    if [[ $rc -eq 0 ]]; then
        printf "\r${SUCCESS}✓${NC} %s\n" "$label"
    else
        printf "\r${DANGER}✗${NC} %s\n" "$label"
        echo -e "${GRAY}Last output:${NC}"
        tail -n 20 "$tmp" 2>/dev/null | sed 's/^/  /'
    fi

    rm -f "$tmp" >/dev/null 2>&1 || true
    return "$rc"
}

get_config() {
    local key="$1" default="$2"
    if command -v python3 &>/dev/null && [[ -f "$ROOT/config.json" ]]; then
        python3 -c "
import json
try:
    v = json.load(open('$ROOT/config.json')).get('$key')
    print(v if v is not None else $default)
except Exception:
    print($default)
" 2>/dev/null || echo "$default"
    else
        echo "$default"
    fi
}

get_file_format() {
    local file="$1"
    local ext="${file##*.}"
    case "$ext" in
        gguf) echo "GGUF" ;;
        safetensors) echo "SafeTensor" ;;
        bin) echo "FP16" ;;
        pt) echo "FP16" ;;
        *) echo "Unknown" ;;
    esac
}

check_and_convert_model() {
    local model_file="$1"
    local format=$(get_file_format "$model_file")
    
    [[ "$format" == "GGUF" ]] && return 0
    
    local gguf_version="${model_file%.*}.gguf"
    if [[ -f "$gguf_version" ]]; then
        success_msg "Converted version found"
        return 0
    fi
    
    if [[ ! -f "$SCRIPTS/model-converter.py" ]]; then
        warn_msg "Model is $format format but converter not available"
        return 1
    fi
    
    clear 2>/dev/null || true
    echo -e "\n${BOLD}${PURPLE}⚙  Model Conversion${NC}"
    divider
    echo -e "  ${TEXT}This model is in ${BOLD}${format}${NC}${TEXT} format.${NC}"
    echo -e "  ${TEXT}Converting to GGUF may take several minutes...${NC}\n"
    echo -e "  ${GRAY}Benefits of GGUF:${NC}"
    echo -e "  ${GRAY}• Optimized for local inference${NC}"
    echo -e "  ${GRAY}• Faster loading and processing${NC}"
    echo -e "  ${GRAY}• Flexible quantization options${NC}\n"
    
    read -r -p "$(echo -e "${CYAN}Convert now? (y/n): ${NC}")" -t 30 convert_choice || convert_choice="n"
    
    if [[ "${convert_choice,,}" == "y" ]]; then
        if run_with_spinner "Converting model to GGUF" python3 "$SCRIPTS/model-converter.py" "$model_file" "$gguf_version"; then
            success_msg "Conversion complete!"
            sleep 2
            return 0
        else
            warn_msg "Conversion failed - you can try manually later"
            sleep 2
            return 1
        fi
    fi
    return 1
}

# ==================================================
# VALIDATE SETUP
# ==================================================
if [[ $OPT_BENCHMARK == false ]] && [[ ! -t 0 ]]; then
    echo "ERROR :: Non-interactive stdin detected. Run this in a terminal."
    exit 1
fi

for _dir in BIN MODELS SCRIPTS; do
    _path="${!_dir}"
    if [[ ! -d "$_path" ]]; then
        error_msg "${_dir} directory not found at: $_path"
        pause; exit 1
    fi
done

# ==================================================
# GPU BACKEND VALIDATION
# ==================================================
if [[ "$GPU" == "nvidia" ]]; then
    if ! command -v nvidia-smi &>/dev/null; then
        error_msg "nvidia-smi NOT FOUND"
        echo "Install: sudo apt install nvidia-driver-535"
        echo "Or use: --gpu vulkan (Vulkan backend)"
        pause; exit 1
    fi
    if ! nvidia-smi &>/dev/null; then
        error_msg "NVIDIA GPU NOT DETECTED"
        echo "Try: sudo modprobe nvidia"
        pause; exit 1
    fi
fi

# ==================================================
# SELECT EXECUTABLE
# ==================================================
select_executable() {
    local exe_type="$1"
    local exe_path=""
    
    case "$exe_type" in
        server)
            for _name in llama-server server; do
                if [[ -f "$BIN/$_name" ]]; then
                    chmod +x "$BIN/$_name" 2>/dev/null || true
                    exe_path="$BIN/$_name"; break
                fi
            done
            [[ -z "$exe_path" ]] && error_msg "llama-server not found in $BIN" && pause && exit 1
            ;;
        cli)
            for _name in llama-cli cli; do
                if [[ -f "$BIN/$_name" ]]; then
                    chmod +x "$BIN/$_name" 2>/dev/null || true
                    exe_path="$BIN/$_name"; break
                fi
            done
            [[ -z "$exe_path" ]] && error_msg "llama-cli not found in $BIN" && pause && exit 1
            ;;
        bench)
            if [[ -f "$BIN/llama-bench" ]]; then
                chmod +x "$BIN/llama-bench" 2>/dev/null || true
                exe_path="$BIN/llama-bench"
            fi
            ;;
    esac
    
    echo "$exe_path"
}

# ==================================================
# LOAD CONFIG
# ==================================================
load_config() {
    THREADS="$(get_config threads 4)"
    CTX_SIZE="$(get_config ctx_size 4096)"
    BATCH_SIZE="$(get_config batch_size 512)"
    UBATCH_SIZE="$(get_config ubatch_size 256)"
    TEMPERATURE="$(get_config temperature 0.7)"
    N_GPU_LAYERS="$(get_config n_gpu_layers '"auto"')"
    
    if [[ "$MODE" == "api" ]]; then
        PORT="$(get_config api_port 1234)"
    else
        PORT="$(get_config cli_port 1234)"
    fi

    GPU_LAYERS=20; VRAM_MB=""; PRINT_VRAM=0
    if [[ "$N_GPU_LAYERS" == "auto" ]]; then
        if [[ "$GPU" == "nvidia" ]]; then
            VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n1 | awk '{print $1}') || VRAM_MB=""
        elif command -v glxinfo &>/dev/null; then
            VRAM_MB=$(glxinfo 2>/dev/null | grep -i "Video memory" | awk '{print $3}' | tr -dc '0-9')
        fi
        
        if [[ -n "$VRAM_MB" ]] && [[ "$VRAM_MB" =~ ^[0-9]+$ ]]; then
            if   (( VRAM_MB < 1024 )); then GPU_LAYERS=0
            elif (( VRAM_MB < 2048 )); then GPU_LAYERS=10
            elif (( VRAM_MB < 4096 )); then GPU_LAYERS=20
            elif (( VRAM_MB < 6144 )); then GPU_LAYERS=33
            elif (( VRAM_MB < 8192 )); then GPU_LAYERS=40
            else GPU_LAYERS=99; fi
            PRINT_VRAM=1
        fi
    else
        GPU_LAYERS="$N_GPU_LAYERS"
    fi
}

# ==================================================
# SELECT MODEL
# ==================================================
select_model() {
    while true; do
        clear 2>/dev/null || true
        print_logo
        echo -e "\n${BOLD}${PRIMARY}LUMINA EDGE${NC} ${GRAY}|${NC} ${TEXT}$MODE ($GPU)${NC}"
        divider
        echo -e "${PURPLE}▸ ${BOLD}Select a Model${NC}"
        echo -e "  ${GRAY}Tip:${NC} Press ${CYAN}D${NC} to download more models, or ${CYAN}0${NC} to exit."
        echo ""

        local model_count=0; declare -a model_paths=() model_names=() model_formats=()
        shopt -s nullglob

        echo -e "  ${GRAY}#  Name${NC}                                   ${GRAY}[Format]${NC} ${GRAY}Status${NC}"
        
        for f in "$MODELS"/*.{gguf,safetensors,bin,pt}; do
            [[ -e "$f" ]] || continue
            ((model_count++)) || true
            model_paths+=("$f")
            local fname; fname="$(basename "$f")"
            model_names+=("$fname")
            local format; format=$(get_file_format "$f")
            model_formats+=("$format")
            local fsize; fsize=$(stat --format="%s" "$f" 2>/dev/null || echo "0")
            local status=""
            [[ "$format" != "GGUF" ]] && [[ ! -f "${f%.*}.gguf" ]] && status=" ${YELLOW}[needs conversion]${NC}"
            printf "  ${BOLD}%2d${NC}. %-35s ${GRAY}[${CYAN}${format}${GRAY}]${NC}${status}\n" "$model_count" "$fname"
            printf "      ${GRAY}•${NC} $(human_size "$fsize")\n"
        done
        shopt -u nullglob
        
        if [[ $model_count -eq 0 ]]; then
            echo -e "  ${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
            warn_msg "No models found"
            echo -e "  Run ${CYAN}./core/lumina-model-manager.py${NC} to download a model"
            echo ""
            pause
            exit 1
        fi
        
        echo -e "\n  ${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "  ${PURPLE}D${NC}  Download a new model"
        echo -e "  ${PURPLE}0${NC}  Exit"
        echo -e "\n  ${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
        read -r -p "$(echo -e "${CYAN}lumina@edge>${NC} ")" model_choice || true
        [[ "${model_choice^^}" == "D" ]] && [[ -f "$ROOT/core/lumina-model-manager.py" ]] && python3 "$ROOT/core/lumina-model-manager.py" || true && continue
        [[ "$model_choice" == "0" ]] && exit 0
        
        if [[ "$model_choice" =~ ^[0-9]+$ ]] && (( model_choice >= 1 && model_choice <= model_count )); then
            local selected_file="${model_paths[$((model_choice - 1))]}"
            check_and_convert_model "$selected_file" || { sleep 2; continue; }
            if [[ "${selected_file##*.}" != "gguf" ]] && [[ -f "${selected_file%.*}.gguf" ]]; then
                SELECTED_MODEL="${selected_file%.*}.gguf"
            else
                SELECTED_MODEL="$selected_file"
            fi
            SELECTED_NAME="${model_names[$((model_choice - 1))]}"
            return
        fi
        error_msg "Invalid selection"
        sleep 1
    done
}

# ==================================================
# LAUNCH HANDLERS
# ==================================================
launch_api() {
    SERVER_EXE=$(select_executable "server")
    
    clear 2>/dev/null || true
    print_logo
    print_banner "⚡ LUMINA EDGE :: API SERVER ($GPU)"
    divider
    
    progress_bar "Booting API UI" 18 0.02
    load_config
    select_model
    
    clear 2>/dev/null || true
    print_banner "⚡ LUMINA EDGE :: API SERVER ($GPU)"
    divider
    echo -e "${SUCCESS}✓${NC} Model      : $SELECTED_NAME"
    echo -e "${CYAN}ℹ${NC} Threads    : $THREADS"
    echo -e "${CYAN}ℹ${NC} Context    : $CTX_SIZE tokens"
    echo -e "${CYAN}ℹ${NC} Thread Batch : $THREADS"
    echo -e "${CYAN}ℹ${NC} GPU Layers : $GPU_LAYERS"
    if [[ $PRINT_VRAM -eq 1 ]]; then
        echo -e "${CYAN}ℹ${NC} VRAM       : ${VRAM_MB} MB"
    fi
    if [[ "$GPU" == "nvidia" ]]; then
        echo -e "${CYAN}ℹ${NC} Backend    : NVIDIA CUDA"
    else
        echo -e "${CYAN}ℹ${NC} Backend    : Vulkan"
    fi
    echo -e "${CYAN}ℹ${NC} API Port   : http://localhost:$PORT"
    
    divider
    echo ""
    status "Starting llama-server..."
    echo ""
    progress_bar "Preflight checks" 14 0.02
    
    if [[ "$OPT_BENCHMARK" == true ]]; then
        BENCH_EXE=$(select_executable "bench")
        if [[ -n "$BENCH_EXE" ]]; then
            status "Running benchmark before server..."
            echo ""
            "$BENCH_EXE" -m "$SELECTED_MODEL" --n-gpu-layers "$GPU_LAYERS" -o json 2>/dev/null || true
            echo ""
            divider
            echo ""
        fi
    fi
    
    # Build command with environment variables based on GPU backend
    local cmd=("$SERVER_EXE" -m "$SELECTED_MODEL" -t "$THREADS" -c "$CTX_SIZE" -b "$BATCH_SIZE" -ub "$UBATCH_SIZE" --n-gpu-layers "$GPU_LAYERS" -p "$PORT")
    
    "${cmd[@]}"
}

launch_core() {
    CLI_EXE=$(select_executable "cli")
    
    clear 2>/dev/null || true
    print_logo
    print_banner "⚡ LUMINA EDGE :: CORE ($GPU)"
    divider
    
    progress_bar "Booting CORE UI" 18 0.02
    load_config
    select_model
    
    clear 2>/dev/null || true
    print_banner "⚡ LUMINA EDGE :: CORE ($GPU)"
    divider
    echo -e "${SUCCESS}✓${NC} Model      : $SELECTED_NAME"
    echo -e "${CYAN}ℹ${NC} Threads    : $THREADS"
    echo -e "${CYAN}ℹ${NC} Context    : $CTX_SIZE tokens"
    echo -e "${CYAN}ℹ${NC} GPU Layers : $GPU_LAYERS"
    if [[ $PRINT_VRAM -eq 1 ]]; then
        echo -e "${CYAN}ℹ${NC} VRAM       : ${VRAM_MB} MB"
    fi
    if [[ "$GPU" == "nvidia" ]]; then
        echo -e "${CYAN}ℹ${NC} Backend    : NVIDIA CUDA"
    else
        echo -e "${CYAN}ℹ${NC} Backend    : Vulkan"
    fi
    
    divider
    echo ""
    status "Starting llama-cli (interactive mode)..."
    echo ""
    progress_bar "Warming prompt engine" 12 0.02
    
    # Build command
    local cmd=("$CLI_EXE" -m "$SELECTED_MODEL" -t "$THREADS" -c "$CTX_SIZE" -n 128 --n-gpu-layers "$GPU_LAYERS")
    
    "${cmd[@]}"
}

launch_router() {
    if [[ ! -f "$SCRIPTS/model-router.py" ]]; then
        error_msg "model-router.py not found in $SCRIPTS"
        pause
        exit 1
    fi
    
    clear 2>/dev/null || true
    print_logo
    print_banner "⚡ LUMINA EDGE :: MULTI-MODEL ROUTER"
    divider
    
    progress_bar "Loading router config" 18 0.02
    load_config
    
    echo -e "${CYAN}ℹ${NC} Multi-model mode: $GPU backend"
    echo -e "${CYAN}ℹ${NC} Config: $ROOT/config.json"
    divider
    echo ""
    
    python3 "$SCRIPTS/model-router.py" --gpu "$GPU"
}

# ==================================================
# MAIN EXECUTION
# ==================================================
case "$MODE" in
    api)
        launch_api
        ;;
    core)
        launch_core
        ;;
    router)
        launch_router
        ;;
esac
