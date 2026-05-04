@echo off
REM ==============================================================================
REM  LUMINA EDGE :: Unified Launcher (Windows)
REM  All-in-one entry point for chat, API, and multi-model modes
REM  Usage: lumina-launcher.bat --mode {api|core|router} --gpu {vulkan|nvidia} [--benchmark]
REM ==============================================================================

setlocal enabledelayedexpansion
chcp 65001 > nul 2>&1

REM ==================================================
REM PARSE ARGUMENTS
REM ==================================================
set "MODE="
set "GPU="
set "OPT_BENCHMARK=false"
set "OPT_JSON_OUTPUT=false"

:parse_args
if "%1"=="" goto parse_done
if "%1"=="--mode" (set "MODE=%2" & shift & shift & goto parse_args)
if "%1"=="--gpu" (set "GPU=%2" & shift & shift & goto parse_args)
if "%1"=="--benchmark" (set "OPT_BENCHMARK=true" & shift & goto parse_args)
if "%1"=="--json-output" (set "OPT_JSON_OUTPUT=true" & shift & goto parse_args)
if "%1"=="--help" goto show_help
if "%1"=="-h" goto show_help
echo Unknown option: %1
echo Use --help for usage information
exit /b 1

:parse_done
if "!MODE!"=="" (
    echo ERROR: --mode is required (api, core, or router)
    echo Use --help for usage information
    exit /b 1
)
if "!GPU!"=="" (
    echo ERROR: --gpu is required (vulkan or nvidia)
    echo Use --help for usage information
    exit /b 1
)

REM ==================================================
REM VALIDATE ARGUMENTS
REM ==================================================
if not "!MODE!"=="api" if not "!MODE!"=="core" if not "!MODE!"=="router" (
    echo ERROR: Invalid mode '!MODE!'. Must be api, core, or router
    exit /b 1
)
if not "!GPU!"=="vulkan" if not "!GPU!"=="nvidia" if not "!GPU!"=="mlx" (
    echo ERROR: Invalid GPU backend '!GPU!'. Must be vulkan, nvidia, or mlx
    exit /b 1
)

REM ==================================================
REM AUTO-DETECT PROJECT ROOT
REM ==================================================
setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "BIN=%ROOT%\bin"
set "MODELS=%ROOT%\models"
set "SCRIPTS=%ROOT%\scripts"

cd /d "%ROOT%" || (
    echo ERROR: Failed to change to root directory
    exit /b 1
)

REM ==================================================
REM LOAD CONFIG
REM ==================================================
REM Detect physical vs logical cores for optimal thread tuning
for /f "tokens=2 delims==" %%A in ('wmic cpu get NumberOfCores /value 2^>nul ^| find "="') do set "PHYSICAL_CORES=%%A"
for /f "tokens=2 delims==" %%A in ('wmic cpu get NumberOfLogicalProcessors /value 2^>nul ^| find "="') do set "LOGICAL_CORES=%%A"

REM Validate detected values
if "!PHYSICAL_CORES!"=="" set "PHYSICAL_CORES=4"
if "!LOGICAL_CORES!"=="" set "LOGICAL_CORES=4"
if !PHYSICAL_CORES! LSS 1 set "PHYSICAL_CORES=4"
if !LOGICAL_CORES! LSS 1 set "LOGICAL_CORES=4"

REM Use physical cores for main threads, logical for batch processing
set "THREADS=!PHYSICAL_CORES!"
set "THREADS_BATCH=!LOGICAL_CORES!"

REM Dynamic defaults based on system detection
REM Get system memory for dynamic sizing
for /f "tokens=2 delims==" %%A in ('wmic computersystem get TotalPhysicalMemory /value ^| find "="') do set "TOTAL_MEMORY_BYTES=%%A"
set /a "TOTAL_MEMORY_MB=!TOTAL_MEMORY_BYTES!/1048576"
set /a "TOTAL_MEMORY_GB=!TOTAL_MEMORY_MB!/1024"

REM Dynamic batch size based on available memory
if !TOTAL_MEMORY_GB! GEQ 16 (
    set "DEFAULT_BATCH_SIZE=1024"
) else if !TOTAL_MEMORY_GB! GEQ 8 (
    set "DEFAULT_BATCH_SIZE=512"
) else if !TOTAL_MEMORY_GB! GEQ 4 (
    set "DEFAULT_BATCH_SIZE=256"
) else (
    set "DEFAULT_BATCH_SIZE=128"
)

REM Dynamic context size based on available memory
if !TOTAL_MEMORY_GB! GEQ 32 (
    set "DEFAULT_CTX_SIZE=16384"
) else if !TOTAL_MEMORY_GB! GEQ 16 (
    set "DEFAULT_CTX_SIZE=8192"
) else if !TOTAL_MEMORY_GB! GEQ 8 (
    set "DEFAULT_CTX_SIZE=4096"
) else if !TOTAL_MEMORY_GB! GEQ 4 (
    set "DEFAULT_CTX_SIZE=2048"
) else (
    set "DEFAULT_CTX_SIZE=1024"
)

REM Dynamic thread count based on physical cores
if !PHYSICAL_CORES! GEQ 16 (
    set "DEFAULT_HTTP_THREADS=8"
    set "DEFAULT_PARALLEL_SLOTS=4"
) else if !PHYSICAL_CORES! GEQ 8 (
    set "DEFAULT_HTTP_THREADS=4"
    set "DEFAULT_PARALLEL_SLOTS=2"
) else (
    set "DEFAULT_HTTP_THREADS=2"
    set "DEFAULT_PARALLEL_SLOTS=1"
)

set "CTX_SIZE=!DEFAULT_CTX_SIZE!"
set "BATCH_SIZE=!DEFAULT_BATCH_SIZE!"
set "UBATCH_SIZE=!DEFAULT_BATCH_SIZE!"
set "TEMPERATURE=0.7"
set "GPU_LAYERS=0"
set "API_PORT=8080"
set "FLASH_ATTN=true"
set "KV_CACHE_QUANT=q8_0"
set "SPLIT_MODE_NVIDIA=layer"
set "SPLIT_MODE_VULKAN=row"
set "MLOCK=true"
set "HTTP_THREADS=!DEFAULT_HTTP_THREADS!"
set "CONT_BATCHING=true"
set "PARALLEL_SLOTS=!DEFAULT_PARALLEL_SLOTS!"

REM Run system optimizer for dynamic configuration
if exist "%SCRIPTS%\system_optimizer.py" (
    echo Running system optimizer for dynamic configuration...
    python "%SCRIPTS%\system_optimizer.py" >nul 2>&1
    if !errorlevel! equ 0 (
        echo ✓ System optimization completed
    ) else (
        echo ⚠ System optimizer failed, using fallback detection
    )
)

REM Try to load from config.json if python is available
if exist "%ROOT%\config.json" (
    for /f "delims=" %%A in ('python -c "import json; c=json.load(open('%ROOT%\config.json')); print(c.get('threads', !PHYSICAL_CORES!))" 2^>nul') do set "CONFIG_THREADS=%%A"
    for /f "delims=" %%A in ('python -c "import json; c=json.load(open('%ROOT%\config.json')); print(c.get('ctx_size', !DEFAULT_CTX_SIZE!))" 2^>nul') do set "CTX_SIZE=%%A"
    for /f "delims=" %%A in ('python -c "import json; c=json.load(open('%ROOT%\config.json')); print(c.get('batch_size', !DEFAULT_BATCH_SIZE!))" 2^>nul') do set "BATCH_SIZE=%%A"
    for /f "delims=" %%A in ('python -c "import json; c=json.load(open('%ROOT%\config.json')); print(c.get('ubatch_size', !DEFAULT_BATCH_SIZE!))" 2^>nul') do set "UBATCH_SIZE=%%A"
    for /f "delims=" %%A in ('python -c "import json; c=json.load(open('%ROOT%\config.json')); print(c.get('temperature', 0.7))" 2^>nul') do set "TEMPERATURE=%%A"
    for /f "delims=" %%A in ('python -c "import json; c=json.load(open('%ROOT%\config.json')); print(c.get('api_port', 8080))" 2^>nul') do set "API_PORT=%%A"
    for /f "delims=" %%A in ('python -c "import json; c=json.load(open('%ROOT%\config.json')); print(c.get('kv_cache_quant', 'q8_0'))" 2^>nul') do set "KV_CACHE_QUANT=%%A"
    for /f "delims=" %%A in ('python -c "import json; c=json.load(open('%ROOT%\config.json')); print(c.get('http_threads', 4))" 2^>nul') do set "HTTP_THREADS=%%A"
    for /f "delims=" %%A in ('python -c "import json; c=json.load(open('%ROOT%\config.json')); print(c.get('n_gpu_layers', 'auto'))" 2^>nul') do set "CONFIG_GPU_LAYERS=%%A"
)

REM Override GPU layers with config if not auto
if not "!CONFIG_GPU_LAYERS!"=="" if not "!CONFIG_GPU_LAYERS!"=="auto" set "GPU_LAYERS=!CONFIG_GPU_LAYERS!"

REM Dynamic GPU layer detection for auto mode
if "!CONFIG_GPU_LAYERS!"=="auto" (
    set "VRAM_MB=0"
    if "!GPU!"=="nvidia" (
        for /f "tokens=1" %%A in ('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2^>nul') do set "VRAM_MB=%%A"
    ) else if "!GPU!"=="vulkan" (
        REM Conservative estimate for iGPU shared memory
        set "VRAM_MB=2048"
    )
    
    REM MAXIMUM GPU OFFLOADING - always use all layers when GPU is available
    if !VRAM_MB! GTR 0 (
        set "GPU_LAYERS=99"
        echo   Detected VRAM: !VRAM_MB! MB -^> Maximum GPU layers: !GPU_LAYERS!
    ) else (
        echo   VRAM detection failed, using maximum GPU layers: !GPU_LAYERS!
    )
)

REM ==================================================
REM FIND EXECUTABLES
REM ==================================================
if "!MODE!"=="api" (
    if exist "%BIN%\llama-server.exe" (
        set "SERVER_EXE=%BIN%\llama-server.exe"
    ) else if exist "%BIN%\server.exe" (
        set "SERVER_EXE=%BIN%\server.exe"
    ) else (
        echo ERROR: llama-server not found in %BIN%
        exit /b 1
    )
)

if "!MODE!"=="core" (
    if exist "%BIN%\llama-cli.exe" (
        set "CLI_EXE=%BIN%\llama-cli.exe"
    ) else if exist "%BIN%\cli.exe" (
        set "CLI_EXE=%BIN%\cli.exe"
    ) else (
        echo ERROR: llama-cli not found in %BIN%
        exit /b 1
    )
)

REM ==================================================
REM VALIDATE DIRECTORIES
REM ==================================================
if not exist "%BIN%" (
    echo ERROR: bin directory not found at: %BIN%
    exit /b 1
)
if not exist "%MODELS%" (
    mkdir "%MODELS%"
    echo Created models directory: %MODELS%
)
if not exist "%SCRIPTS%" (
    echo ERROR: scripts directory not found at: %SCRIPTS%
    exit /b 1
)

REM ==================================================
REM UI HELPERS (Banners / Sections / Progress)
REM ==================================================
:ui_logo
echo    ____     ____     _____     ____ 
echo   / __ \   / __ \   / ___/   / __ \
echo  / /_/ /  / /_/ /  / /__    / / / /
echo  \____/   \____/   \___/   /_/ /_/
exit /b 0

:ui_banner
REM Args: title
set "UI_TITLE=%~1"
cls
call :ui_logo
echo.
echo ======================================================================
echo   LUMINA EDGE :: !UI_TITLE! (!GPU!)
echo ======================================================================
echo.
exit /b 0

:ui_section
REM Args: section title
set "UI_SEC=%~1"
echo   >> !UI_SEC!
echo.
exit /b 0

:ui_ok
color 0A
echo   [OK] %*
color 0B
exit /b 0

:ui_warn
color 0E
echo   [WARN] %*
color 0B
exit /b 0

:ui_err
color 0C
echo   [ERR] %*
color 0B
exit /b 0

:sleepMs
REM Args: ms
set /a _MS=%~1
if %_MS% LSS 1 set _MS=1
ping -n 1 -w %_MS% 127.0.0.1 >nul 2>&1
exit /b 0

:ui_progress
REM Args: label steps sleepMsPerStep
set "UI_P_LABEL=%~1"
set /a UI_P_STEPS=%~2
if %UI_P_STEPS% LSS 1 set UI_P_STEPS=20

echo.
<nul set /p ="  !UI_P_LABEL! "
for /l %%i in (1,1,%UI_P_STEPS%) do (
    <nul set /p ="#"
)
echo.
exit /b 0

REM ==================================================
REM LAUNCH BASED ON MODE
REM ==================================================
if "!MODE!"=="api" goto launch_api
if "!MODE!"=="core" goto launch_core
if "!MODE!"=="router" goto launch_router
echo Invalid mode: !MODE!
exit /b 1

:launch_api
call :ui_banner "API SERVER"
call :ui_section "Startup"
echo   Info: Starting API server with !GPU! backend
echo   Port: http://localhost:!API_PORT!
echo   Physical Cores: !PHYSICAL_CORES! (threads: !THREADS!)
echo   Logical Cores:  !LOGICAL_CORES! (batch threads: !THREADS_BATCH!)
echo.

REM Select a model first
call :select_model
if !errorlevel! neq 0 exit /b 1

REM Check llama.cpp version freshness
if not "!GPU!"=="mlx" (
    echo   Checking llama.cpp version...
    "!SERVER_EXE!" --version 2>nul | findstr /C:"version" >nul && (
        "!SERVER_EXE!" --version 2>nul | findstr /C:"version"
    ) || echo   Version check skipped
)

call :ui_progress "Launching engine" 26 18

if "!OPT_BENCHMARK!"=="true" (
    if exist "%BIN%\llama-bench.exe" (
        call :ui_section "Benchmark"
        "%BIN%\llama-bench.exe" -m "!SELECTED_MODEL!" --n-gpu-layers !GPU_LAYERS! -o json 2>nul
        echo.
    )
)

REM Power optimizations
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c >nul 2>&1
powercfg -setacvalueindex scheme_current sub_processor CPMINCORES 100 >nul 2>&1
powercfg -setactive scheme_current >nul 2>&1

REM Create cache directory
if not exist "%ROOT%\cache" mkdir "%ROOT%\cache"

REM Set CPU affinity based on thread count
set "AFFINITY=0xF"
if !THREADS! gtr 4 set "AFFINITY=0xFF"
if !THREADS! gtr 8 set "AFFINITY=0xFFFF"

REM Build server command with optimized flags
set "SERVER_CMD=!SERVER_EXE! -m "!SELECTED_MODEL!" -t !THREADS! -tb !THREADS_BATCH! -c !CTX_SIZE! -b !BATCH_SIZE! -ub !UBATCH_SIZE! --n-gpu-layers !GPU_LAYERS! --temp !TEMPERATURE! --top-p 1.0 --repeat-penalty 1.0 --flash-attn --defrag-thold 0.1 --warmup --ctx-shift --min-p 0.05 --top-k 20 --threads-http !HTTP_THREADS! -p !API_PORT! --cache-type-k !KV_CACHE_QUANT! --cache-type-v !KV_CACHE_QUANT! --slot-save-path cache\ --prompt-cache cache\system_prompt.bin"

if "!CONT_BATCHING!"=="true" (
    set "SERVER_CMD=!SERVER_CMD! --cont-batching --parallel !PARALLEL_SLOTS!"
)

if "!MLOCK!"=="true" (
    set "SERVER_CMD=!SERVER_CMD! --mlock"
)

if "!GPU!"=="mlx" (
    python "%SCRIPTS%\mlx_backend.py" --mode api --model "!SELECTED_MODEL!" --port !API_PORT!
    goto end
) else if "!GPU!"=="nvidia" (
    set "SERVER_CMD=!SERVER_CMD! --split-mode layer"
) else if "!GPU!"=="vulkan" (
    set "SERVER_CMD=!SERVER_CMD! --split-mode row --no-kv-offload"
)

start "" /HIGH /AFFINITY !AFFINITY! cmd /c !SERVER_CMD!
goto end

:launch_core
call :ui_banner "CORE"
call :ui_section "Interactive Chat"
echo   Info: Starting interactive chat with !GPU! backend
echo   Physical Cores: !PHYSICAL_CORES! (threads: !THREADS!)
echo   Logical Cores:  !LOGICAL_CORES! (batch threads: !THREADS_BATCH!)
echo.

REM Select a model first
call :select_model
if !errorlevel! neq 0 exit /b 1

call :ui_progress "Booting prompt engine" 14 18

if "!OPT_BENCHMARK!"=="true" (
    if exist "%BIN%\llama-bench.exe" (
        call :ui_section "Benchmark"
        "%BIN%\llama-bench.exe" -m "!SELECTED_MODEL!" --n-gpu-layers !GPU_LAYERS! -o json 2>nul
        echo.
    )
)

REM Power optimizations
powercfg /setactive 8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c >nul 2>&1
powercfg -setacvalueindex scheme_current sub_processor CPMINCORES 100 >nul 2>&1
powercfg -setactive scheme_current >nul 2>&1

REM Set CPU affinity based on thread count
set "AFFINITY=0xF"
if !THREADS! gtr 4 set "AFFINITY=0xFF"
if !THREADS! gtr 8 set "AFFINITY=0xFFFF"

REM Build CLI command with optimized flags
set "CLI_CMD=!CLI_EXE! -m "!SELECTED_MODEL!" -t !THREADS! -tb !THREADS_BATCH! -c !CTX_SIZE! -b !BATCH_SIZE! -ub !UBATCH_SIZE! -n 128 --n-gpu-layers !GPU_LAYERS! --temp !TEMPERATURE! --top-p 1.0 --repeat-penalty 1.0 --flash-attn --defrag-thold 0.1 --warmup --ctx-shift --min-p 0.05 --top-k 20 --cache-type-k !KV_CACHE_QUANT! --cache-type-v !KV_CACHE_QUANT!"

if "!MLOCK!"=="true" (
    set "CLI_CMD=!CLI_CMD! --mlock"
)

if "!GPU!"=="mlx" (
    python "%SCRIPTS%\mlx_backend.py" --mode core --model "!SELECTED_MODEL!"
    goto end
) else if "!GPU!"=="nvidia" (
    set "CLI_CMD=!CLI_CMD! --split-mode layer"
) else if "!GPU!"=="vulkan" (
    set "CLI_CMD=!CLI_CMD! --split-mode row --no-kv-offload"
)

if "!OPT_JSON_OUTPUT!"=="true" (
    set "CLI_CMD=!CLI_CMD! --format json"
)

start "" /HIGH /AFFINITY !AFFINITY! cmd /c !CLI_CMD!
goto end

:launch_router
if not exist "%SCRIPTS%\model-router.py" (
    echo ERROR: model-router.py not found in %SCRIPTS%
    exit /b 1
)

call :ui_banner "MULTI-MODEL ROUTER"
call :ui_section "Startup"
echo   Info: Starting multi-model router with !GPU! backend
echo.

call :ui_progress "Initializing router" 20 18
python3 "%SCRIPTS%\model-router.py" --gpu !GPU!
goto end

REM ==================================================
REM SELECT MODEL SUBROUTINE
REM ==================================================
:select_model
setlocal enabledelayedexpansion
:select_model_menu
set "model_count=0"
set "SELECTED_MODEL="

REM Scan for models
for %%F in ("%MODELS%\*.gguf" "%MODELS%\*.safetensors" "%MODELS%\*.bin" "%MODELS%\*.pt") do (
    if exist "%%F" (
        set /a model_count+=1
        set "model_!model_count!=%%F"
        set "model_name_!model_count!=%%~nF"
    )
)

cls
call :ui_logo
echo.
call :ui_section "Select a Model"

if !model_count! equ 0 (
    call :ui_err "No models found in %MODELS%"
    echo   Please download a model first.
    pause
    exit /b 1
)

echo.
for /l %%i in (1,1,!model_count!) do (
    echo   [%%i] !model_name_%%i!
)
echo.
echo   [D] Download a new model
echo   [0] Exit
echo.

set /p "model_choice=Choice> "

if /i "!model_choice!"=="0" exit /b 1
if /i "!model_choice!"=="D" (
    if exist "%ROOT%\core\lumina-model-manager.py" (
        call :ui_progress "Launching model manager" 14 18
        python "%ROOT%\core\lumina-model-manager.py"
        goto :select_model_menu
    ) else (
        call :ui_warn "Model manager not found."
        echo.
        pause
        goto :select_model_menu
    )
)

if "!model_choice!"=="" (
    call :ui_err "Invalid selection. Try again."
    pause
    goto :select_model_menu
)

REM Validate numeric range
set /a _CHOICE=!model_choice! 2>nul
if %_CHOICE% LSS 1 (
    call :ui_err "Invalid selection: !model_choice!"
    echo.
    pause
    goto :select_model_menu
)
if %_CHOICE% GTR !model_count! (
    call :ui_err "Invalid selection: !model_choice!"
    echo.
    pause
    goto :select_model_menu
)

if not defined model_!_CHOICE! (
    call :ui_err "Invalid selection: !model_choice!"
    echo.
    pause
    goto :select_model_menu
)

REM Use for /f to correctly dereference dynamic variable
for /f "delims=" %%V in ("!model_%_CHOICE%!") do set "SELECTED_MODEL=%%V"
endlocal & set "SELECTED_MODEL=%SELECTED_MODEL%"
exit /b 0

:show_help
echo LUMINA EDGE :: Unified Launcher
echo.
echo Usage: lumina-launcher.bat --mode {api,core,router} --gpu {vulkan,nvidia} [OPTIONS]
echo.
echo Modes:
echo   api       - OpenAI-compatible REST API (llama-server)
echo   core      - Interactive chat mode (llama-cli)
echo   router    - Multi-model load balancer (model-router.py)
echo.
echo GPU Backends:
echo   vulkan    - Cross-platform Vulkan (AMD, NVIDIA, Intel)
echo   nvidia    - NVIDIA CUDA (requires NVIDIA GPU)
echo.
echo Options:
echo   --benchmark     - Run inline benchmark after startup
echo   --json-output   - Output results as JSON
echo   --help, -h      - Show this message
echo.
exit /b 0

:end
endlocal
