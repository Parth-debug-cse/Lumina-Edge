#!/usr/bin/env bash
# ==============================================================================
# ⚡ LUMINA EDGE :: Local API Server (Vulkan) — Linux  v1.2
# OpenAI-compatible REST API using llama-server with Vulkan backend
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
for arg in "$@"; do
    [[ "$arg" == "--benchmark" ]] && OPT_BENCHMARK=true
done

if [[ "$OPT_BENCHMARK" == false ]] && [[ ! -t 0 ]]; then
    echo "ERROR :: Non-interactive stdin detected. Run this in a terminal."
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

# Visual helpers
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
        success_msg "Converted version found"
        return 0
    fi
    
    # Conversion needed - check if converter is available
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
        echo -e "\n${CYAN}⏳ Converting...${NC}\n"
        if python3 "$SCRIPTS/model-converter.py" "$model_file" "$gguf_version" 2>&1 | tail -20; then
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
# VALIDATE DIRECTORIES & EXECUTABLES
# ==================================================
for _dir in BIN MODELS SCRIPTS; do
    _path="${!_dir}"
    if [[ ! -d "$_path" ]]; then
        echo "ERROR :: ${_dir} directory not found at: $_path"
        pause; exit 1
    fi
done

SERVER_EXE=""
for _name in llama-server server; do
    if [[ -f "$BIN/$_name" ]]; then
        chmod +x "$BIN/$_name" 2>/dev/null || true
        SERVER_EXE="$BIN/$_name"; break
    fi
done
[[ -z "$SERVER_EXE" ]] && echo "ERROR :: llama-server not found in $BIN" && pause && exit 1

BENCH_EXE=""
[[ -f "$BIN/llama-bench" ]] && chmod +x "$BIN/llama-bench" 2>/dev/null || true
[[ -f "$BIN/llama-bench" ]] && BENCH_EXE="$BIN/llama-bench"

# ==================================================
# MODEL SELECTION
# ==================================================
select_model() {
    while true; do
        clear 2>/dev/null || true
        echo -e "\n${BOLD}${PRIMARY}⚡ LUMINA EDGE${NC} ${GRAY}|${NC} ${TEXT}API Server${NC}"
        divider
        echo -e "${PURPLE}▸ ${BOLD}Select a Model${NC}\n"

        local model_count=0; declare -a model_paths=() model_names=() model_formats=()
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
            [[ "$format" != "GGUF" ]] && [[ ! -f "${f%.*}.gguf" ]] && status=" ${YELLOW}[needs conversion]${NC}"
            printf "  ${BOLD}%2d${NC}. %-35s ${GRAY}[${CYAN}${format}${GRAY}]${NC}${status}\n" "$model_count" "$fname"
            printf "      ${GRAY}•${NC} $(human_size "$fsize")\n"
        done
        shopt -u nullglob
        [[ $model_count -eq 0 ]] && echo -e "  ${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n" && warn_msg "No models found" && echo -e "  Run ${CYAN}model-manager.sh${NC} to download a model" && echo "" && pause && exit 1
        echo -e "\n  ${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "  ${PURPLE}D${NC}  Download a new model"
        echo -e "  ${PURPLE}0${NC}  Exit"
        echo -e "\n  ${GRAY}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
        read -r -p "$(echo -e "${CYAN}lumina@edge>${NC} ")" model_choice || true
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
        error_msg "Invalid selection"
        sleep 1
    done
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
    N_GPU_LAYERS="$(get_config n_gpu_layers '"auto"')"
    PORT="$(get_config api_port 1234)"

    GPU_LAYERS=20; VRAM_MB=""; PRINT_VRAM=0
    if [[ "$N_GPU_LAYERS" == "auto" ]]; then
        if command -v nvidia-smi &>/dev/null; then
            VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n1 | awk '{print $1}') || VRAM_MB=""
        fi
        if [[ -z "$VRAM_MB" ]] && [[ -f /sys/class/drm/card0/device/mem_info_vram_total ]]; then
            local vb; vb=$(cat /sys/class/drm/card0/device/mem_info_vram_total 2>/dev/null || echo "")
            [[ -n "$vb" ]] && VRAM_MB=$((vb / 1024 / 1024))
        fi
        if [[ -z "$VRAM_MB" ]] && command -v glxinfo &>/dev/null; then
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
# BENCHMARK
# ==================================================
run_benchmark() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo -e "  ${BOLD}LUMINA EDGE${NC} :: API BENCHMARK  [Vulkan]"
    echo "=================================================="
    echo ""
    echo -e "  ${CYAN}Model   :${NC} $SELECTED_NAME"
    echo ""

    if [[ -z "$BENCH_EXE" ]]; then
        echo -e "  ${YELLOW}[WARN] llama-bench not found. Skipping.${NC}"; pause; return
    fi

    echo "  Running benchmark..."; echo ""
    local ts; ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local raw_output
    raw_output=$("$BENCH_EXE" -m "$SELECTED_MODEL" --n-gpu-layers "$GPU_LAYERS" -o json 2>/dev/null) || raw_output=""

    local tps_pp=0 tps_tg=0
    if [[ -n "$raw_output" ]]; then
        tps_pp=$(echo "$raw_output" | python3 -c "
import json,sys; d=json.load(sys.stdin)
pp=[r.get('avg_ts',0) for r in d.get('results',[]) if r.get('test','').startswith('pp')]
print(f'{pp[0]:.2f}' if pp else '0')" 2>/dev/null || echo "0")
        tps_tg=$(echo "$raw_output" | python3 -c "
import json,sys; d=json.load(sys.stdin)
tg=[r.get('avg_ts',0) for r in d.get('results',[]) if r.get('test','').startswith('tg')]
print(f'{tg[0]:.2f}' if tg else '0')" 2>/dev/null || echo "0")
    fi
    local mem_mb; mem_mb=$(free -m 2>/dev/null | awk '/^Mem:/{print $3}' || echo "0")

    python3 - <<PYEOF
import json, os
rf = "$ROOT/benchmark_results.json"
entry = {"timestamp":"$ts","model":"$SELECTED_NAME","backend":"Vulkan","mode":"api",
"gpu_layers":$GPU_LAYERS,"ctx_size":$CTX_SIZE,"threads":$THREADS,
"prompt_processing_tps":$tps_pp,"token_generation_tps":$tps_tg,"ram_used_mb":$mem_mb}
results = []
if os.path.exists(rf):
    try:
        results = json.load(open(rf))
        if not isinstance(results,list): results=[results]
    except: results = []
results.append(entry)
json.dump(results, open(rf,'w'), indent=2)
print(json.dumps(entry,indent=2))
PYEOF

    echo ""
    echo -e "  ${CYAN}Prompt Processing :${NC} ${tps_pp} tokens/sec"
    echo -e "  ${CYAN}Token Generation  :${NC} ${tps_tg} tokens/sec"
    echo -e "  ${CYAN}RAM Used          :${NC} ${mem_mb} MB"
    echo ""
    echo -e "  ${GREEN}[OK] Results saved to: benchmark_results.json${NC}"; echo ""
    pause
}

# ==================================================
# PORT CHECK & SERVER INIT
# ==================================================
port_check() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  CHECKING PORT $PORT"
    echo "=================================================="
    echo ""
    local port_in_use=false
    if command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | grep -q ":${PORT} " && port_in_use=true
    elif command -v lsof &>/dev/null; then
        lsof -i ":$PORT" -sTCP:LISTEN &>/dev/null && port_in_use=true
    fi
    if $port_in_use; then
        echo "  ERROR :: PORT $PORT IS IN USE"
        echo "  Fix: sudo lsof -i :$PORT  then  kill <PID>"
        pause; return
    fi
    echo -e "${GREEN}[OK] Port $PORT is available.${NC}"; sleep 1
    init_server
}

init_server() {
    clear 2>/dev/null || true
    echo "=================================================="
    echo "  STAGE 1 :: MEMORY RECLAMATION"
    echo "=================================================="
    echo ""
    if [[ -x "$SCRIPTS/optimize_system.sh" ]]; then
        if [[ $EUID -eq 0 ]]; then bash "$SCRIPTS/optimize_system.sh" || true
        else
            echo -e "${YELLOW}[NOTE] Running optimizer with sudo...${NC}"
            sudo bash "$SCRIPTS/optimize_system.sh" 2>/dev/null || echo -e "${YELLOW}[WARN] Skipped.${NC}"
        fi
    fi
    echo ""; echo -e "${GREEN}[OK] Memory optimization complete.${NC}"; sleep 1

    clear 2>/dev/null || true
    echo "=================================================="
    echo -e "  ${BOLD}LUMINA EDGE${NC} :: API SERVER  [Vulkan]"
    echo "=================================================="
    echo ""
    echo -e "  Endpoint : ${CYAN}http://127.0.0.1:${PORT}/v1${NC}"
    echo "  Model    : $SELECTED_NAME"
    echo "  Context  : $CTX_SIZE tokens"
    echo "  Threads  : $THREADS"
    echo "  Temp     : $TEMPERATURE"
    [[ $PRINT_VRAM -eq 1 ]] && echo "  GPU Layers: $GPU_LAYERS ($VRAM_MB MB VRAM)"
    echo ""
    echo "  Press Ctrl+C to stop the server."
    echo "=================================================="
    echo ""

    trap 'echo ""; echo "  SERVER STOPPED"; echo ""' SIGINT
    "$SERVER_EXE" \
        -m "$SELECTED_MODEL" \
        --host 127.0.0.1 \
        --port "$PORT" \
        --ctx-size "$CTX_SIZE" \
        --batch-size "$BATCH_SIZE" \
        --ubatch-size "$UBATCH_SIZE" \
        --n-gpu-layers "$GPU_LAYERS" \
        --threads "$THREADS" \
        --temp "$TEMPERATURE" \
        --flash-attn \
        --mlock \
        --parallel 1 || true
    trap - SIGINT

    echo ""
    if [[ -t 0 ]]; then
        read -r -p "Return to menu? (Y/N): " restart || true
        [[ "${restart^^}" != "Y" ]] && exit 0
    fi
}

main_menu() {
    while true; do
        clear 2>/dev/null || true
        echo "=================================================="
        echo -e "  ${BOLD}LUMINA EDGE${NC} :: API SERVER MENU  [Vulkan]"
        echo "=================================================="
        echo ""
        echo -e "  Model    : ${CYAN}$SELECTED_NAME${NC}"
        echo "  Endpoint : http://127.0.0.1:${PORT}/v1"
        echo ""
        echo "  1. Start API Server"
        echo "  2. Run Benchmark"
        echo "  3. Change Model"
        echo "  4. Exit"
        echo ""
        echo "=================================================="
        echo ""
        read -r -p "lumina@edge> " choice || true
        case "$choice" in
            1) port_check ;;
            2) run_benchmark ;;
            3) select_model; load_config ;;
            4) exit 0 ;;
        esac
    done
}

# ==================================================
# ENTRY POINT
# ==================================================
select_model
load_config

if [[ "$OPT_BENCHMARK" == true ]]; then
    echo "=================================================="
    echo -e "  ${BOLD}LUMINA EDGE${NC} :: API SERVER  [Vulkan]"
    echo "=================================================="
    run_benchmark; exit 0
fi

main_menu
