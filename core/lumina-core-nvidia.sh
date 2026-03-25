#!/usr/bin/env bash
# ==============================================================================
# Lumina Edge :: Core Controller (NVIDIA CUDA) — Linux  v1.2
# Interactive chat mode using llama-cli with CUDA backend
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
# FLAG PARSING
# ==================================================
OPT_BENCHMARK=false
OPT_JSON_OUTPUT=false

for arg in "$@"; do
    case "$arg" in
        --benchmark)   OPT_BENCHMARK=true ;;
        --json-output) OPT_JSON_OUTPUT=true ;;
    esac
done

if [[ "$OPT_BENCHMARK" == false ]] && [[ ! -t 0 ]]; then
    echo "ERROR :: Non-interactive stdin detected. Run this script in a terminal."
    echo "         For headless use, pass --benchmark flag."
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
SESSIONS_DIR="$ROOT/sessions"

cd "$ROOT"

# ==================================================
# UTILITY FUNCTIONS
# ==================================================
pause() {
    echo ""
    [[ -t 0 ]] && read -n1 -r -p "Press any key to continue..." || true
    echo ""
}

human_size() {
    local bytes=${1:-0}
    if   [[ $bytes -ge 1073741824 ]]; then awk -v b="$bytes" 'BEGIN { printf "%.1f GB\n", b/1073741824 }'
    elif [[ $bytes -ge 1048576    ]]; then awk -v b="$bytes" 'BEGIN { printf "%.1f MB\n", b/1048576 }'
    elif [[ $bytes -ge 1024       ]]; then awk -v b="$bytes" 'BEGIN { printf "%.1f KB\n", b/1024 }'
    else echo "${bytes} bytes"; fi
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

# ==================================================
# MODEL FORMAT DETECTION & CONVERSION
# ==================================================
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
    
    # GGUF models are ready to use
    [[ "$format" == "GGUF" ]] && return 0
    
    # Check for converted version
    local gguf_version="${model_file%.*}.gguf"
    if [[ -f "$gguf_version" ]]; then
        return 0  # Converted version exists
    fi
    
    # Conversion needed - check if converter is available
    if [[ ! -f "$SCRIPTS/model-converter.py" ]]; then
        echo "⚠ Model is $format format but converter not available."
        return 1
    fi
    
    echo "ℹ Convert $format model to GGUF? This may take a few minutes."
    read -r -p "Convert now? (y/n): " -t 30 convert_choice || convert_choice="n"
    
    if [[ "${convert_choice,,}" == "y" ]]; then
        echo "Converting $model_file to GGUF..."
        if python3 "$SCRIPTS/model-converter.py" "$model_file" "$gguf_version" 2>&1 | tail -20; then
            return 0
        else
            echo "⚠ Conversion failed. You can try manually later."
            return 1
        fi
    fi
    return 1
}

# ==================================================
# CHECK FOR NVIDIA GPU
# ==================================================
if ! command -v nvidia-smi &>/dev/null; then
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  ERROR :: nvidia-smi NOT FOUND"
    echo "=================================================="
    echo ""
    echo "  This script requires an NVIDIA GPU with CUDA support."
    echo "  Install drivers: sudo apt install nvidia-driver-535"
    echo "  Or use the Vulkan version: lumina-core.sh"
    echo ""
    pause; exit 1
fi

if ! nvidia-smi &>/dev/null; then
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  ERROR :: NVIDIA GPU NOT DETECTED"
    echo "=================================================="
    echo ""
    echo "  Try: sudo modprobe nvidia"
    echo "  Or use the Vulkan version: lumina-core.sh"
    echo ""
    pause; exit 1
fi

# ==================================================
# VALIDATE DIRECTORIES & EXECUTABLES
# ==================================================
for _dir in BIN MODELS SCRIPTS; do
    _path="${!_dir}"
    if [[ ! -d "$_path" ]]; then
        echo "=================================================="
        echo "  ERROR :: ${_dir} directory not found at: $_path"
        echo "=================================================="
        pause; exit 1
    fi
done

if [[ -f "$BIN/llama-cli" ]]; then
    chmod +x "$BIN/llama-cli" 2>/dev/null || true
    CLI_EXE="$BIN/llama-cli"
else
    echo "ERROR :: llama-cli not found in $BIN"; pause; exit 1
fi

BENCH_EXE=""
[[ -f "$BIN/llama-bench" ]] && chmod +x "$BIN/llama-bench" 2>/dev/null || true
[[ -f "$BIN/llama-bench" ]] && BENCH_EXE="$BIN/llama-bench"

# ==================================================
# MODEL SELECTION
# ==================================================
select_model() {
    while true; do
        clear 2>/dev/null || true
        echo "=================================================="
        echo -e "  ${BOLD}LUMINA EDGE${NC} :: SELECT A MODEL  [CUDA]"
        echo "=================================================="
        echo ""
        local model_count=0
        declare -a model_paths=() model_names=() model_formats=()
        shopt -s nullglob
        
        # Scan for all supported model formats
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
            [[ "$format" != "GGUF" ]] && [[ ! -f "${f%.*}.gguf" ]] && status=" [needs conversion]"
            echo "  $model_count. $fname [$format]$status"
            echo "     Size: $(human_size "$fsize")"
            echo ""
        done
        shopt -u nullglob
        [[ $model_count -eq 0 ]] && echo "  No models found. Run model-manager.sh first." && pause && exit 1
        echo "  D. Download a new model"; echo "  0. Exit"; echo ""
        echo "=================================================="
        echo ""
        read -r -p "lumina@edge> " model_choice || true
        [[ "${model_choice^^}" == "D" ]] && [[ -x "$ROOT/model-manager.sh" ]] && "$ROOT/model-manager.sh" || true && continue
        [[ "$model_choice" == "0" ]] && exit 0
        if [[ "$model_choice" =~ ^[0-9]+$ ]] && (( model_choice >= 1 && model_choice <= model_count )); then
            local selected_file="${model_paths[$((model_choice - 1))]}"
            # Check if conversion is needed
            check_and_convert_model "$selected_file" || { sleep 2; continue; }
            # Use converted GGUF if original wasn't GGUF
            if [[ "${selected_file##*.}" != "gguf" ]] && [[ -f "${selected_file%.*}.gguf" ]]; then
                SELECTED_MODEL="${selected_file%.*}.gguf"
            else
                SELECTED_MODEL="$selected_file"
            fi
            SELECTED_NAME="${model_names[$((model_choice - 1))]}"
            return
        fi
        echo "  Invalid selection."; sleep 1
    done
}

# ==================================================
# CONFIG LOAD
# ==================================================
load_config() {
    THREADS="$(get_config threads 4)"
    CTX_SIZE="$(get_config ctx_size 4096)"
    BATCH_SIZE="$(get_config batch_size 512)"
    UBATCH_SIZE="$(get_config ubatch_size 256)"
    TEMPERATURE="$(get_config temperature 0.7)"
    TOP_P="$(get_config top_p 0.9)"
    REPEAT_PENALTY="$(get_config repeat_penalty 1.1)"
    N_GPU_LAYERS="$(get_config n_gpu_layers '"auto"')"
    JSON_OUTPUT="$(get_config json_output false)"
    SYS_PROMPT="$(get_config system_prompt '"You are a precise, efficient AI assistant."')"

    GPU_LAYERS=20
    VRAM_MB=""
    PRINT_VRAM=0

    if [[ "$N_GPU_LAYERS" == "auto" ]]; then
        VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n1 | awk '{print $1}') || VRAM_MB=""
        if [[ -n "$VRAM_MB" ]] && [[ "$VRAM_MB" =~ ^[0-9]+$ ]]; then
            if   (( VRAM_MB < 1024 )); then GPU_LAYERS=0
            elif (( VRAM_MB < 2048 )); then GPU_LAYERS=10
            elif (( VRAM_MB < 4096 )); then GPU_LAYERS=20
            elif (( VRAM_MB < 6144 )); then GPU_LAYERS=33
            elif (( VRAM_MB < 8192 )); then GPU_LAYERS=40
            elif (( VRAM_MB < 12288)); then GPU_LAYERS=60
            else GPU_LAYERS=99; fi
            PRINT_VRAM=1
        fi
    else
        GPU_LAYERS="$N_GPU_LAYERS"
    fi

    [[ "$OPT_JSON_OUTPUT" == true ]] && JSON_OUTPUT=true
}

# ==================================================
# BENCHMARK MODE
# ==================================================
run_benchmark() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo -e "  ${BOLD}LUMINA EDGE${NC} :: BENCHMARK MODE  [CUDA]"
    echo "=================================================="
    echo ""
    echo -e "  ${CYAN}Model   :${NC} $SELECTED_NAME"
    echo -e "  ${CYAN}VRAM    :${NC} ${VRAM_MB:-unknown} MB"
    echo ""

    if [[ -z "$BENCH_EXE" ]]; then
        echo -e "  ${YELLOW}[WARN] llama-bench not found. Skipping hardware benchmark.${NC}"
        pause; return
    fi

    echo "  Running CUDA benchmark..."
    local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local raw_output
    raw_output=$("$BENCH_EXE" -m "$SELECTED_MODEL" --n-gpu-layers "$GPU_LAYERS" -o json 2>/dev/null) || raw_output=""

    local tps_pp=0 tps_tg=0
    if [[ -n "$raw_output" ]]; then
        tps_pp=$(echo "$raw_output" | python3 -c "
import json,sys
data=json.load(sys.stdin)
results=data.get('results',[])
pp=[r.get('avg_ts',0) for r in results if r.get('test','').startswith('pp')]
print(f'{pp[0]:.2f}' if pp else '0')
" 2>/dev/null || echo "0")
        tps_tg=$(echo "$raw_output" | python3 -c "
import json,sys
data=json.load(sys.stdin)
results=data.get('results',[])
tg=[r.get('avg_ts',0) for r in results if r.get('test','').startswith('tg')]
print(f'{tg[0]:.2f}' if tg else '0')
" 2>/dev/null || echo "0")
    fi

    local mem_used_mb=0
    mem_used_mb=$(free -m 2>/dev/null | awk '/^Mem:/{print $3}' || echo "0")
    local gpu_mem_used=0
    gpu_mem_used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -n1 | awk '{print $1}') || gpu_mem_used=0

    python3 - <<PYEOF
import json, os
result_file = "$ROOT/benchmark_results.json"
entry = {
    "timestamp": "$ts",
    "model": "$SELECTED_NAME",
    "backend": "NVIDIA CUDA",
    "gpu_layers": $GPU_LAYERS,
    "ctx_size": $CTX_SIZE,
    "threads": $THREADS,
    "prompt_processing_tps": $tps_pp,
    "token_generation_tps": $tps_tg,
    "ram_used_mb": $mem_used_mb,
    "vram_total_mb": "${VRAM_MB:-0}",
    "vram_used_mb": $gpu_mem_used
}
results = []
if os.path.exists(result_file):
    try:
        results = json.load(open(result_file))
        if not isinstance(results, list): results = [results]
    except Exception:
        results = []
results.append(entry)
with open(result_file, 'w') as f:
    json.dump(results, f, indent=2)
print(json.dumps(entry, indent=2))
PYEOF

    echo ""
    echo "=================================================="
    echo -e "  ${GREEN}BENCHMARK RESULTS  [CUDA]${NC}"
    echo "=================================================="
    echo ""
    echo -e "  ${CYAN}Prompt Processing :${NC} ${tps_pp} tokens/sec"
    echo -e "  ${CYAN}Token Generation  :${NC} ${tps_tg} tokens/sec"
    echo -e "  ${CYAN}RAM Used          :${NC} ${mem_used_mb} MB"
    echo -e "  ${CYAN}VRAM Used         :${NC} ${gpu_mem_used} / ${VRAM_MB:-?} MB"
    echo ""
    echo -e "  ${GREEN}[OK] Results saved to: benchmark_results.json${NC}"
    echo ""
    pause
}

# ==================================================
# BOOT SCREEN
# ==================================================
boot_screen() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo -e "  ${BOLD}LUMINA EDGE${NC} :: LOCAL LLM CONTROLLER  v1.2  [CUDA]"
    echo "=================================================="
    echo ""
    echo -e "  ${GREEN}[OK]${NC} Root    : $ROOT"
    echo -e "  ${GREEN}[OK]${NC} Model   : $SELECTED_NAME"
    echo -e "  ${GREEN}[OK]${NC} Backend : NVIDIA CUDA"
    echo -e "  ${GREEN}[OK]${NC} Context : ${CTX_SIZE} tokens"
    echo -e "  ${GREEN}[OK]${NC} Threads : ${THREADS}"
    [[ $PRINT_VRAM -eq 1 ]] && echo -e "  ${GREEN}[OK]${NC} VRAM   : ${VRAM_MB} MB → ${GPU_LAYERS} GPU layers"
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
        echo -e "  ${BOLD}LUMINA EDGE${NC} :: MAIN MENU  [CUDA]"
        echo "=================================================="
        echo ""
        echo -e "  Model   : ${CYAN}$SELECTED_NAME${NC}"
        echo -e "  Backend : NVIDIA CUDA  |  Ctx: ${CTX_SIZE}  |  Threads: ${THREADS}"
        [[ $PRINT_VRAM -eq 1 ]] && echo -e "  VRAM    : ${VRAM_MB} MB  |  GPU Layers: ${GPU_LAYERS}"
        echo ""
        echo "  1. Start Chat"
        echo "  2. Start Chat (JSON output mode)"
        echo "  3. Run Benchmark"
        echo "  4. Change Model"
        echo "  5. Exit"
        echo ""
        echo "=================================================="
        echo ""
        read -r -p "lumina@edge> " choice || true
        case "$choice" in
            1) OPT_JSON_OUTPUT=false; init_llm ;;
            2) OPT_JSON_OUTPUT=true;  init_llm ;;
            3) run_benchmark ;;
            4) select_model; load_config; boot_screen ;;
            5) exit 0 ;;
        esac
    done
}

# ==================================================
# LLM INITIALIZATION
# ==================================================
init_llm() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  STAGE 1 :: MEMORY RECLAMATION"
    echo "=================================================="
    echo ""
    if [[ -x "$SCRIPTS/optimize_system.sh" ]]; then
        if [[ $EUID -eq 0 ]]; then bash "$SCRIPTS/optimize_system.sh" || true
        else
            echo -e "${YELLOW}[NOTE] Running optimizer with sudo...${NC}"
            sudo bash "$SCRIPTS/optimize_system.sh" 2>/dev/null || echo -e "${YELLOW}[WARN] Optimization skipped.${NC}"
        fi
    fi
    echo ""
    echo -e "${GREEN}[OK] Memory optimization complete.${NC}"; sleep 1

    clear 2>/dev/null || true
    echo "=================================================="
    echo "  STAGE 2 :: LLM INITIALIZATION  [CUDA]"
    echo "=================================================="
    echo ""
    echo "  Model       : $SELECTED_NAME"
    echo "  Backend     : NVIDIA CUDA"
    echo "  Context     : $CTX_SIZE tokens"
    echo "  Threads     : $THREADS"
    echo "  Temperature : $TEMPERATURE"
    echo "  Top-P       : $TOP_P"
    echo "  GPU Layers  : $GPU_LAYERS"
    [[ "$JSON_OUTPUT" == "true" ]] && echo -e "  ${CYAN}[JSON OUTPUT MODE ACTIVE]${NC}"
    echo ""
    echo "  Press CTRL+C to exit chat."
    echo "=================================================="
    echo ""

    local extra_flags=()
    [[ "$JSON_OUTPUT" == "true" ]] && extra_flags+=("--json-schema" '{"type":"object","properties":{"response":{"type":"string"}},"required":["response"]}')

    mkdir -p "$SESSIONS_DIR"

    trap 'echo ""; echo "  SESSION INTERRUPTED"; echo ""' SIGINT
    "$CLI_EXE" \
        -m "$SELECTED_MODEL" \
        -t "$THREADS" \
        -c "$CTX_SIZE" \
        --batch-size "$BATCH_SIZE" \
        --ubatch-size "$UBATCH_SIZE" \
        --n-gpu-layers "$GPU_LAYERS" \
        --temp "$TEMPERATURE" \
        --top-p "$TOP_P" \
        --repeat-penalty "$REPEAT_PENALTY" \
        --flash-attn \
        --mlock \
        --color auto \
        -cnv \
        --multiline-input \
        -sys "$SYS_PROMPT" \
        "${extra_flags[@]}" || true
    trap - SIGINT

    echo ""
    echo "=================================================="
    echo "  SESSION ENDED"
    echo "=================================================="
    echo ""
    if [[ -t 0 ]]; then
        read -r -p "Return to menu? (Y/N): " restart || true
        [[ "${restart^^}" != "Y" ]] && exit 0
    fi
}

# ==================================================
# ENTRY POINT
# ==================================================
select_model
load_config

if [[ "$OPT_BENCHMARK" == true ]]; then
    boot_screen
    run_benchmark
    exit 0
fi

boot_screen
main_menu
