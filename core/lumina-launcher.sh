#!/usr/bin/env bash
# ==============================================================================
# ⚡ LUMINA EDGE :: Unified Launcher
# All-in-one entry point for chat, API, and multi-model modes
# Usage: ./lumina-launcher.sh --mode {api|core|router} --gpu {vulkan|nvidia} [--benchmark]
# ==============================================================================

set -euo pipefail

# ===== COLOR PALETTE =====
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

# Old compatibility
GREEN="$SUCCESS"
YELLOW="$WARNING"

# ==================================================
# UTILITY FUNCTIONS (defined before use)
# ==================================================
warn_msg() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# ==================================================
# PARSE ARGUMENTS
# ==================================================
MODE=""
GPU=""
PRESELECTED_MODEL=""
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
        --model)
            PRESELECTED_MODEL="$2"; shift 2
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
            echo "  mlx       - Apple Silicon MLX (macOS only)"
            echo ""
            echo "Options:"
            echo "  --model <path>  - Non-interactive model selection (path to .gguf)"
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
    if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
        GPU="mlx"
        warn_msg "Auto-detected Apple Silicon: using 'mlx' backend"
    else
        echo -e "${DANGER}✗${NC} ERROR: --gpu is required (vulkan, nvidia, or mlx)"
        echo "Use --help for usage information"
        exit 1
    fi
fi

if [[ ! "$MODE" =~ ^(api|core|router)$ ]]; then
    echo -e "${DANGER}✗${NC} ERROR: Invalid mode '$MODE'. Must be api, core, or router"
    exit 1
fi

if [[ ! "$GPU" =~ ^(vulkan|nvidia|mlx)$ ]]; then
    echo -e "${DANGER}✗${NC} ERROR: Invalid GPU backend '$GPU'. Must be vulkan, nvidia, or mlx"
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

get_file_size() {
    local file="$1"
    if [[ "$(uname -s)" == "Darwin" ]]; then
        stat -f %z "$file" 2>/dev/null || echo "0"
    else
        stat --format=%s "$file" 2>/dev/null || echo "0"
    fi
}

print_logo() {
    echo -e "${PRIMARY}Lumina Edge${NC}"
}

progress_bar() {
    # Args: label [steps] [sleep_s]
    local label="${1:-Working...}"
    local steps="${2:-24}"
    local sleep_s="${3:-0.001}"
    local i
    echo -ne "${GRAY}${label}${NC} "
    for ((i=0; i<steps; i++)); do
        printf "${PRIMARY}█${NC}"
        [[ "$sleep_s" != "0" ]] && sleep "${sleep_s}"
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
# SYSTEM OPTIMIZER INTEGRATION
# ==================================================
run_system_optimizer() {
    local optimizer_script="$SCRIPTS/system_optimizer.py"
    
    if [[ -f "$optimizer_script" ]] && command -v python3 &>/dev/null; then
        status "Running system optimizer for dynamic configuration..."
        if python3 "$optimizer_script" >/dev/null 2>&1; then
            success_msg "System optimization completed"
        else
            warn_msg "System optimizer failed, using fallback detection"
        fi
    fi
}

# ==================================================
# LOAD CONFIG
# ==================================================
load_config() {
    # Run system optimizer first
    run_system_optimizer
    # Detect physical vs logical cores for optimal thread tuning - fully dynamic
    if [[ "$(uname -s)" == "Darwin" ]]; then
        # macOS - use sysctl for accurate detection
        PHYSICAL_CORES=$(sysctl -n hw.physicalcpu 2>/dev/null)
        LOGICAL_CORES=$(sysctl -n hw.logicalcpu 2>/dev/null)
        
        # Fallback: try alternative detection methods
        if [[ -z "$PHYSICAL_CORES" ]] || [[ "$PHYSICAL_CORES" -lt 1 ]]; then
            PHYSICAL_CORES=$(sysctl -n hw.ncpu 2>/dev/null)
        fi
        if [[ -z "$LOGICAL_CORES" ]] || [[ "$LOGICAL_CORES" -lt 1 ]]; then
            LOGICAL_CORES=$PHYSICAL_CORES
        fi
    else
        # Linux - comprehensive detection
        # Try multiple methods for physical cores
        PHYSICAL_CORES=$(lscpu 2>/dev/null | grep "^Core(s) per socket:" | awk '{print $4}')
        if [[ -z "$PHYSICAL_CORES" ]] || [[ "$PHYSICAL_CORES" -lt 1 ]]; then
            PHYSICAL_CORES=$(lscpu 2>/dev/null | grep "^CPU(s):" | awk '{print $2}')
        fi
        if [[ -z "$PHYSICAL_CORES" ]] || [[ "$PHYSICAL_CORES" -lt 1 ]]; then
            PHYSICAL_CORES=$(grep "^processor" /proc/cpuinfo | wc -l)
        fi
        
        # Logical cores detection
        LOGICAL_CORES=$(nproc --all 2>/dev/null)
        if [[ -z "$LOGICAL_CORES" ]] || [[ "$LOGICAL_CORES" -lt 1 ]]; then
            LOGICAL_CORES=$(lscpu 2>/dev/null | grep "^CPU(s):" | awk '{print $2}')
        fi
        if [[ -z "$LOGICAL_CORES" ]] || [[ "$LOGICAL_CORES" -lt 1 ]]; then
            LOGICAL_CORES=$(grep "^processor" /proc/cpuinfo | wc -l)
        fi
        
        # Detect if hyperthreading is enabled to calculate physical cores
        SIBLINGS=$(lscpu 2>/dev/null | grep "^Thread(s) per core:" | awk '{print $4}')
        if [[ -n "$SIBLINGS" ]] && [[ "$SIBLINGS" -gt 1 ]] && [[ -n "$LOGICAL_CORES" ]]; then
            PHYSICAL_CORES=$((LOGICAL_CORES / SIBLINGS))
        fi
    fi
    
    # Final validation - use minimum safe values only as last resort
    if [[ ! "$PHYSICAL_CORES" =~ ^[0-9]+$ ]] || [[ "$PHYSICAL_CORES" -lt 1 ]]; then
        PHYSICAL_CORES=1
    fi
    if [[ ! "$LOGICAL_CORES" =~ ^[0-9]+$ ]] || [[ "$LOGICAL_CORES" -lt 1 ]]; then
        LOGICAL_CORES=$PHYSICAL_CORES
    fi
    
    # Ensure logical cores >= physical cores
    if [[ $LOGICAL_CORES -lt $PHYSICAL_CORES ]]; then
        LOGICAL_CORES=$PHYSICAL_CORES
    fi
    
    # Use physical cores for main threads, logical for batch processing
    THREADS="$PHYSICAL_CORES"
    THREADS_BATCH="$LOGICAL_CORES"

    # Calculate CPU affinity mask for physical cores only (avoid SMT/hyperthreading)
    # This pins threads to physical cores for better cache locality and less context switching
    calculate_cpu_affinity() {
        local physical_cores=$1
        local mask=0

        # On Linux, we can detect which cores are physical vs SMT
        if [[ -f /sys/devices/system/cpu/cpu0/topology/thread_siblings_list ]]; then
            local used_cores=""
            for ((i=0; i<$(nproc); i++)); do
                # Check if this is a "master" core (first in sibling list)
                local siblings_file="/sys/devices/system/cpu/cpu${i}/topology/thread_siblings_list"
                if [[ -f "$siblings_file" ]]; then
                    local siblings=$(cat "$siblings_file" 2>/dev/null | cut -d',' -f1 | cut -d'-' -f1)
                    # Only use if this core is the first in its sibling group (physical core)
                    if [[ "$siblings" == "$i" ]] && [[ ! "$used_cores" =~ "$i" ]]; then
                        mask=$((mask | (1 << i)))
                        used_cores="$used_cores $i"
                        # Stop when we have enough physical cores
                        if [[ $(echo "$used_cores" | wc -w) -ge $physical_cores ]]; then
                            break
                        fi
                    fi
                fi
            done
        else
            # Fallback: just use first N cores
            for ((i=0; i<physical_cores; i++)); do
                mask=$((mask | (1 << i)))
            done
        fi

        # Convert to hexadecimal
        printf "%x" "$mask"
    }

    # Store CPU affinity mask for later use
    CPU_AFFINITY_MASK=$(calculate_cpu_affinity "$PHYSICAL_CORES")

    # Dynamic batch size based on available memory and cores - AUTO-TUNING
    # Formula: accounts for GPU layers, available RAM, and CPU cores
    calculate_dynamic_batch_size() {
        local total_mem_gb=$1
        local gpu_layers=$2
        local physical_cores=$3
        local gpu_type="$4"

        # Base batch size from memory
        local base_batch=128
        if [[ $total_mem_gb -ge 32 ]]; then
            base_batch=2048
        elif [[ $total_mem_gb -ge 16 ]]; then
            base_batch=1024
        elif [[ $total_mem_gb -ge 8 ]]; then
            base_batch=512
        elif [[ $total_mem_gb -ge 4 ]]; then
            base_batch=256
        fi

        # Adjust for GPU offloading - more GPU layers = can use larger batches
        # because GPU memory is faster and more efficient
        local gpu_multiplier=100
        if [[ $gpu_layers -ge 99 ]]; then
            gpu_multiplier=150  # 1.5x for full GPU offloading
        elif [[ $gpu_layers -ge 50 ]]; then
            gpu_multiplier=130  # 1.3x for partial offloading
        elif [[ $gpu_layers -gt 0 ]]; then
            gpu_multiplier=115  # 1.15x for minimal offloading
        fi

        # Adjust for CPU cores (more cores can handle larger batches)
        local core_multiplier=100
        if [[ $physical_cores -ge 16 ]]; then
            core_multiplier=150
        elif [[ $physical_cores -ge 8 ]]; then
            core_multiplier=125
        elif [[ $physical_cores -ge 4 ]]; then
            core_multiplier=110
        fi

        # Calculate final batch size
        local final_batch=$((base_batch * gpu_multiplier * core_multiplier / 10000))

        # Cap at reasonable limits
        if [[ $final_batch -gt 4096 ]]; then
            final_batch=4096
        elif [[ $final_batch -lt 64 ]]; then
            final_batch=64
        fi

        echo "$final_batch"
    }

    # Calculate available system memory
    TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "1048576")  # 1GB fallback
    TOTAL_MEM_GB=$((TOTAL_MEM_KB / 1024 / 1024))
    AVAILABLE_MEM_KB=$(grep MemAvailable /proc/meminfo 2>/dev/null | awk '{print $2}' || echo "$TOTAL_MEM_KB")
    AVAILABLE_MEM_GB=$((AVAILABLE_MEM_KB / 1024 / 1024))

    # Use available memory (not total) for safer batch sizing
    EFFECTIVE_MEM_GB=$(( (TOTAL_MEM_GB + AVAILABLE_MEM_GB) / 2 ))

    # Detect GPU type and layers for batch calculation
    DETECTED_GPU_TYPE="cpu"
    ESTIMATED_GPU_LAYERS=0
    if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
        DETECTED_GPU_TYPE="nvidia"
        ESTIMATED_GPU_LAYERS=99
    elif [[ -d /sys/class/kfd/kfd ]] || lspci 2>/dev/null | grep -qi "amd.*vga"; then
        DETECTED_GPU_TYPE="amd"
        ESTIMATED_GPU_LAYERS=99
    elif lspci 2>/dev/null | grep -qi "intel.*vga\|intel.*graphics"; then
        DETECTED_GPU_TYPE="intel"
        ESTIMATED_GPU_LAYERS=99
    fi

    # Calculate dynamic batch size
    DEFAULT_BATCH_SIZE=$(calculate_dynamic_batch_size "$EFFECTIVE_MEM_GB" "$ESTIMATED_GPU_LAYERS" "$PHYSICAL_CORES" "$DETECTED_GPU_TYPE")
    status "Auto-tuned batch size: $DEFAULT_BATCH_SIZE (mem:${EFFECTIVE_MEM_GB}GB, gpu:$DETECTED_GPU_TYPE, cores:$PHYSICAL_CORES)"

    # Dynamic context size with MINIMUM 4096 tokens and resizable logic
    # Formula: base on memory but never go below 4096 (good balance for most use cases)
    calculate_dynamic_ctx_size() {
        local total_mem_gb=$1
        local available_mem_gb=$2
        local gpu_layers=$3

        # Base context size from available memory (conservative)
        local ctx_size=4096  # MINIMUM 4096 tokens

        if [[ $available_mem_gb -ge 24 ]]; then
            ctx_size=32768
        elif [[ $available_mem_gb -ge 16 ]]; then
            ctx_size=16384
        elif [[ $available_mem_gb -ge 10 ]]; then
            ctx_size=8192
        elif [[ $available_mem_gb -ge 6 ]]; then
            ctx_size=4096
        fi

        # If GPU offloading is high, we can use larger contexts
        # because GPU memory is faster for KV cache
        if [[ $gpu_layers -ge 99 ]] && [[ $total_mem_gb -ge 8 ]]; then
            # Boost context size for full GPU offloading
            if [[ $ctx_size -lt 8192 ]]; then
                ctx_size=8192
            fi
        fi

        # Ensure minimum 4096
        if [[ $ctx_size -lt 4096 ]]; then
            ctx_size=4096
        fi

        echo "$ctx_size"
    }

    # Calculate dynamic context size
    DEFAULT_CTX_SIZE=$(calculate_dynamic_ctx_size "$TOTAL_MEM_GB" "$AVAILABLE_MEM_GB" "$ESTIMATED_GPU_LAYERS")
    status "Dynamic context size: $DEFAULT_CTX_SIZE tokens (min:4096, resizable)"
    
    CTX_SIZE="$(get_config ctx_size $DEFAULT_CTX_SIZE)"
    BATCH_SIZE="$(get_config batch_size $DEFAULT_BATCH_SIZE)"
    UBATCH_SIZE="$(get_config ubatch_size $DEFAULT_BATCH_SIZE)"
    TEMPERATURE="$(get_config temperature 0.7)"
    TOP_P="$(get_config top_p 0.9)"
    REPEAT_PENALTY="$(get_config repeat_penalty 1.1)"
    N_GPU_LAYERS="$(get_config n_gpu_layers '"auto"')"
    FLASH_ATTN="$(get_config flash_attn 'true')"
    KV_CACHE_QUANT="$(get_config kv_cache_quant '"f16"')"
    SPLIT_MODE="$(get_config split_mode '"row"')"
    DEFRAG_THOLD="$(get_config defrag_thold 0.1)"
    USE_MLOCK="$(get_config use_mlock 'true')"
    NUMA_MODE="$(get_config numa_mode 'false')"
    MIN_P="$(get_config min_p 0.05)"
    TOP_K="$(get_config top_k 40)"
    # Dynamic thread counts based on physical cores
    if [[ $PHYSICAL_CORES -ge 16 ]]; then
        DEFAULT_HTTP_THREADS=8
        DEFAULT_PARALLEL_SLOTS=4
    elif [[ $PHYSICAL_CORES -ge 8 ]]; then
        DEFAULT_HTTP_THREADS=4
        DEFAULT_PARALLEL_SLOTS=2
    else
        DEFAULT_HTTP_THREADS=2
        DEFAULT_PARALLEL_SLOTS=1
    fi
    
    HTTP_THREADS="$(get_config http_threads $DEFAULT_HTTP_THREADS)"
    CONT_BATCHING="$(get_config cont_batching 'true')"
    PARALLEL_SLOTS="$(get_config parallel_slots $DEFAULT_PARALLEL_SLOTS)"
    
    if [[ "$MODE" == "api" ]]; then
        PORT="$(get_config api_port 1235)"
    else
        PORT="$(get_config cli_port 1235)"
    fi

    GPU_LAYERS=0; VRAM_MB=""; PRINT_VRAM=0
    if [[ "$N_GPU_LAYERS" == "auto" ]]; then
        # MAXIMUM GPU OFFLOADING - always use all layers when GPU is available
        # Modern drivers handle memory management efficiently
        if [[ "$GPU" == "nvidia" ]]; then
            # NVIDIA GPU detection
            VRAM_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n1 | awk '{print $1}')
            if [[ -z "$VRAM_MB" ]]; then
                VRAM_MB=$(nvidia-smi -q -d MEMORY | grep -i "total" | grep -E "[0-9]+" | awk '{print $3}' | head -1)
            fi
            GPU_LAYERS=99  # Maximum CUDA offloading
            PRINT_VRAM=1
            status "NVIDIA GPU detected: Maximum offloading enabled (99 layers)"
        elif [[ "$GPU" == "vulkan" ]]; then
            # Vulkan GPU detection - iGPU or dedicated
            if command -v vulkaninfo &>/dev/null; then
                VRAM_MB=$(vulkaninfo 2>/dev/null | grep -i "deviceSize" | head -1 | grep -E "[0-9]+" | awk '{print $3}' | tr -dc '0-9')
            fi
            if [[ -z "$VRAM_MB" ]] && command -v glxinfo &>/dev/null; then
                VRAM_MB=$(glxinfo 2>/dev/null | grep -i "Video memory" | awk '{print $3}' | tr -dc '0-9')
            fi
            if [[ -z "$VRAM_MB" ]]; then
                # iGPU - use system memory
                TOTAL_MEM_KB=$(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}')
                if [[ -n "$TOTAL_MEM_KB" ]]; then
                    VRAM_MB=$((TOTAL_MEM_KB / 1024 / 4))
                fi
            fi
            
            # Conservative GPU layer calculation for Vulkan stability
            if [[ -n "$VRAM_MB" ]] && [[ $VRAM_MB -gt 0 ]]; then
                # Reserve 256MB for Vulkan driver overhead and reduce layers for stability
                AVAILABLE_VRAM_MB=$((VRAM_MB - 256))
                if [[ $AVAILABLE_VRAM_MB -ge 4096 ]]; then
                    GPU_LAYERS=99  # High-end GPU
                elif [[ $AVAILABLE_VRAM_MB -ge 2048 ]]; then
                    GPU_LAYERS=50  # Mid-range GPU
                elif [[ $AVAILABLE_VRAM_MB -ge 1024 ]]; then
                    GPU_LAYERS=25  # Low-end GPU
                else
                    GPU_LAYERS=10  # Very low VRAM
                fi
            else
                GPU_LAYERS=25  # Conservative fallback for iGPU
            fi
            PRINT_VRAM=1
            status "Vulkan GPU detected: ${GPU_LAYERS} layers (VRAM: ${VRAM_MB}MB, reserved: 256MB)"
        elif [[ "$GPU" == "mlx" ]]; then
            # Apple Silicon - always full Metal offloading
            GPU_LAYERS=99
            status "Apple Silicon detected: Full Metal offloading enabled (99 layers)"
        else
            # Unknown GPU backend - try maximum anyway
            GPU_LAYERS=99
            status "GPU backend detected: Maximum offloading enabled (99 layers)"
        fi
    else
        # Use user-specified value
        GPU_LAYERS="$N_GPU_LAYERS"
    fi
}

# ==================================================
# SELECT MODEL
# ==================================================
select_model() {
    # Check if a model was pre-selected via --model flag
    if [[ -n "$PRESELECTED_MODEL" ]]; then
        if [[ ! -f "$PRESELECTED_MODEL" ]]; then
            error_msg "Model file not found: $PRESELECTED_MODEL"
            exit 1
        fi
        SELECTED_MODEL="$PRESELECTED_MODEL"
        SELECTED_NAME="$(basename "$PRESELECTED_MODEL")"
        
        # Skip conversion check if already .gguf
        if [[ "${PRESELECTED_MODEL##*.}" != "gguf" ]] && [[ "$GPU" != "mlx" ]]; then
            check_and_convert_model "$SELECTED_MODEL" || exit 1
            # Update SELECTED_MODEL to point to converted version if it exists
            if [[ -f "${PRESELECTED_MODEL%.*}.gguf" ]]; then
                SELECTED_MODEL="${PRESELECTED_MODEL%.*}.gguf"
            fi
        fi
        status "Model pre-selected: $SELECTED_NAME"
        return
    fi
    
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
            fname="$(basename "$f")"
            model_names+=("$fname")
            format=$(get_file_format "$f")
            model_formats+=("$format")
            fsize=$(get_file_size "$f")
            status=""
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
        echo -e "${CYAN}lumina@edge>${NC} " >&2
read -r model_choice || true
        [[ "${model_choice^^}" == "D" ]] && [[ -f "$ROOT/core/lumina-model-manager.py" ]] && python3 "$ROOT/core/lumina-model-manager.py" || true && continue
        [[ "$model_choice" == "0" ]] && exit 0
        
        if [[ "$model_choice" =~ ^[0-9]+$ ]] && (( model_choice >= 1 && model_choice <= model_count )); then
            selected_file="${model_paths[$((model_choice - 1))]}"
            if [[ "$GPU" != "mlx" ]]; then
                check_and_convert_model "$selected_file" || { sleep 2; continue; }
            fi
            if [[ "$GPU" != "mlx" ]] && [[ "${selected_file##*.}" != "gguf" ]] && [[ -f "${selected_file%.*}.gguf" ]]; then
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
# CPU OPTIMIZATION (extracted, reusable)
# ==================================================
apply_cpu_optimizations() {
    # Pre-launch optimizations (Linux only)
    if [[ "$(uname -s)" != "Linux" ]]; then
        return
    fi
    
    # CPU Frequency Governor Integration
    if command -v cpupower &>/dev/null; then
        if sudo cpupower frequency-set -g performance 2>/dev/null; then
            success_msg "CPU governor set to performance mode"
        else
            warn_msg "Could not set CPU governor (requires sudo or cpupower not available)"
        fi
    else
        warn_msg "cpupower not available for CPU governor control"
    fi
    
    # Additional CPU optimizations
    if [[ -w /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor ]]; then
        echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor > /dev/null 2>&1 || true
    fi
    
    # Disable CPU idle states for maximum performance
    if [[ -w /sys/devices/system/cpu/cpuidle/low_power_idle_cpu_residency_us ]]; then
        echo 0 | sudo tee /sys/devices/system/cpu/cpuidle/low_power_idle_cpu_residency_us > /dev/null 2>&1 || true
    fi
    
    echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled > /dev/null 2>&1 || true
}

# ==================================================
# LAUNCH HANDLERS
# ==================================================
launch_api() {
    # Load configuration first
    load_config
    
    # Direct API launcher - bypass interactive selection
    print_logo
    print_banner "⚡ LUMINA EDGE :: API SERVER ($GPU)"
    divider
    
    echo -e "${WARNING}⚠${NC} Interactive API mode disabled for stability"
    echo -e "${CYAN}ℹ${NC} Use: ./start_api.sh --model <path> --port <port> --gpu <backend>"
    echo ""
    echo -e "${GRAY}Available models:${NC}"
    
    # Show available models
    model_count=0
    for f in "$MODELS"/*.{gguf,safetensors,bin,pt}; do
        [[ -e "$f" ]] || continue
        ((model_count++)) || true
        fname="$(basename "$f")"
        echo -e "  ${model_count}. ${CYAN}$fname${NC}"
    done
    
    echo ""
    echo -e "${CYAN}Quick start examples:${NC}"
    echo -e "  ./start_api.sh --model models/LFM2.5-1.2B-Thinking-Q4_K_M.gguf"
    echo -e "  ./start_api.sh --model models/phi-4-mini-iq4_xs.gguf --port 8081"
    echo -e "  ./start_api.sh --model models/Qwen3.5-Coder-4b-Instruct-IQ4_XS.gguf"
    
    divider
    echo ""
    
    # Auto-start with default model if requested
    if [[ -n "$PRESELECTED_MODEL" ]]; then
        echo -e "${SUCCESS}✓${NC} Starting API with pre-selected model: $PRESELECTED_MODEL"
        exec ./start_api.sh --model "$PRESELECTED_MODEL" --port "$PORT" --gpu "$GPU"
    fi
    
    return 0
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
    echo -e "${CYAN}ℹ${NC} Physical Cores : $PHYSICAL_CORES (threads: $THREADS)"
    echo -e "${CYAN}ℹ${NC} Logical Cores  : $LOGICAL_CORES (batch threads: $THREADS_BATCH)"
    echo -e "${CYAN}ℹ${NC} Context    : $CTX_SIZE tokens"
    echo -e "${CYAN}ℹ${NC} GPU Layers : $GPU_LAYERS"
    if [[ $PRINT_VRAM -eq 1 ]]; then
        echo -e "${CYAN}ℹ${NC} VRAM       : ${VRAM_MB} MB"
    fi
    if [[ "$GPU" == "nvidia" ]]; then
        echo -e "${CYAN}ℹ${NC} Backend    : NVIDIA CUDA"
    elif [[ "$GPU" == "mlx" ]]; then
        echo -e "${CYAN}ℹ${NC} Backend    : Apple MLX"
    else
        echo -e "${CYAN}ℹ${NC} Backend    : Vulkan"
    fi
    
    divider
    echo ""
    
    if [[ "$GPU" == "mlx" ]]; then
        status "Starting MLX interactive mode..."
        echo ""
        # Load API port from config
        local mlx_port
        mlx_port=$(python3 -c "import json; c=json.load(open('config.json')); print(c.get('api_port', 1234))" 2>/dev/null || echo "1234")
        local mlx_cmd=("python3" "$SCRIPTS/mlx_backend.py" "--mode" "core" "--model" "$SELECTED_MODEL" "--port" "$mlx_port")
        if [[ "$OPT_BENCHMARK" == true ]]; then
            mlx_cmd+=("--benchmark")
        fi
        if [[ "$OPT_JSON_OUTPUT" == true ]]; then
            mlx_cmd+=("--json-output")
        fi
        "${mlx_cmd[@]}"
        return
    fi
    
    status "Starting llama-cli (interactive mode)..."
    echo ""
    progress_bar "Warming prompt engine" 12 0.02
    
    if [[ "$OPT_BENCHMARK" == true ]]; then
        BENCH_EXE=$(select_executable "bench")
        if [[ -n "$BENCH_EXE" ]]; then
            status "Running benchmark before core..."
            echo ""
            "$BENCH_EXE" -m "$SELECTED_MODEL" --n-gpu-layers "$GPU_LAYERS" -o json 2>/dev/null || true
            echo ""
            divider
            echo ""
        fi
    fi
    
    # Apply CPU optimizations
    apply_cpu_optimizations
    
    # Initialize performance monitoring
    MONITOR_SCRIPT="$SCRIPTS/performance_monitor.py"
    MONITOR_LOG="$ROOT/cache/performance_$(date +%Y%m%d_%H%M%S).log"
    MONITOR_PID=""
    
    if [[ -f "$MONITOR_SCRIPT" ]] && command -v python3 &>/dev/null; then
        status "Starting performance monitor..."
        python3 "$MONITOR_SCRIPT" --log-file "$MONITOR_LOG" --update-interval 2.0 &
        MONITOR_PID=$!
        echo -e "${CYAN}ℹ${NC} Performance monitor PID: $MONITOR_PID"
        echo -e "${CYAN}ℹ${NC} Log file: $MONITOR_LOG"
    fi
    
    # Build command
    local cmd=("$CLI_EXE" -m "$SELECTED_MODEL" -t "$THREADS" -tb "$THREADS_BATCH" -c "$CTX_SIZE" -b "$BATCH_SIZE" -ub "$UBATCH_SIZE" -n 128 --n-gpu-layers "$GPU_LAYERS" --temp "$TEMPERATURE" --top-p "$TOP_P" --repeat-penalty "$REPEAT_PENALTY" --flash-attn --defrag-thold "$DEFRAG_THOLD" --warmup --ctx-shift --min-p "$MIN_P" --top-k "$TOP_K")
    
    # Add mlock if enabled
    if [[ "$USE_MLOCK" == "true" ]]; then
        cmd+=(--mlock)
    fi
    
    # Add KV cache quantization
    cmd+=(--cache-type-k "$KV_CACHE_QUANT" --cache-type-v "$KV_CACHE_QUANT")
    
    # GPU-specific split-mode flags
    if [[ "$GPU" == "nvidia" ]]; then
        cmd+=(--split-mode layer)
    elif [[ "$GPU" == "vulkan" ]]; then
        cmd+=(--split-mode row --no-kv-offload)
        # Add device selection for Vulkan
        cmd+=(--device vulkan0)
    fi
    
    # NUMA for Linux (skip MLX)
    if [[ "$GPU" != "mlx" ]] && [[ "$NUMA_MODE" != "none" ]]; then
        cmd+=(--numa "$NUMA_MODE")
    fi
    
    if [[ "$OPT_JSON_OUTPUT" == true ]]; then
        cmd+=("--format" "json")
    fi
    
    # Cleanup function for performance monitor
    cleanup_monitor() {
        if [[ -n "$MONITOR_PID" ]] && kill -0 "$MONITOR_PID" 2>/dev/null; then
            kill "$MONITOR_PID" 2>/dev/null || true
            wait "$MONITOR_PID" 2>/dev/null || true
            echo -e "\n${SUCCESS}✓${NC} Performance monitor stopped"
        fi
    }
    
    # Set up cleanup trap
    trap cleanup_monitor EXIT INT TERM
    
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
