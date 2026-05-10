@echo off
REM ==============================================================================
REM Lumina Edge — Full Stack Launcher (Windows Batch)
REM Optimizes system → starts llama-server → starts API server → launches UI
REM ==============================================================================

setlocal enabledelayedexpansion

REM Get script directory and set paths
set "SCRIPT_DIR=%~dp0"
set "ROOT=%SCRIPT_DIR%"
set "SCRIPTS=%ROOT%scripts"
set "UI_DIR=%ROOT%ui"
set "API_PORT=%LUMINA_API_PORT%"
if "%API_PORT%"=="" set "API_PORT=8090"
set "MLX_PORT=%LUMINA_MLX_PORT%"
if "%MLX_PORT%"=="" set "MLX_PORT=8091"
set "UI_PORT=%LUMINA_UI_PORT%"
if "%UI_PORT%"=="" set "UI_PORT=5173"
set "OW_PORT=%LUMINA_OW_PORT%"
if "%OW_PORT%"=="" set "OW_PORT=8080"

set "MODEL_PATH=%~1"

set "RUNDIR=%ROOT%.lumina_run"
if not exist "%RUNDIR%" mkdir "%RUNDIR%"
set "PID_FILE=%RUNDIR%pids.txt"

REM Clear startup log
echo. > "%RUNDIR%\startup.log"

call :log "============================================================"
call :log "  Lumina Edge Launcher (Windows Batch)"
call :log "============================================================"
call :log "  Root:     %ROOT%"
call :log "  Platform: Windows %PROCESSOR_ARCHITECTURE%"
call :log "  Model:    %MODEL_PATH%"
call :log ""

call :stop_existing
call :optimize_system
call :check_model || exit /b 1
call :start_backend || exit /b 1
call :start_api_server || exit /b 1
call :start_ui || exit /b 1
call :setup_openwebui
call :print_summary

call :log "Startup complete. Press Ctrl+C to stop all services."
REM Keep the script running
:wait_loop
timeout /t 1 >nul
goto wait_loop

REM ==============================================================================
REM Functions
REM ==============================================================================

:log
echo [%date% %time%] [Lumina] %~1
echo [%date% %time%] [Lumina] %~1 >> "%RUNDIR%\startup.log"
goto :eof

:log_ok
call :log "✓ %~1"
goto :eof

:log_err
call :log "✗ %~1"
goto :eof

:stop_existing
call :log "Stopping any existing Lumina processes..."

REM Kill by PID file
if exist "%PID_FILE%" (
    for /f "tokens=1,2" %%a in ('type "%PID_FILE%"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    del "%PID_FILE%" >nul 2>&1
)

REM Fallback: kill by process name
taskkill /F /IM "llama-server.exe" >nul 2>&1
taskkill /F /IM "node.exe" /FI "WINDOWTITLE eq api-server*" >nul 2>&1
taskkill /F /IM "vite.exe" >nul 2>&1

timeout /t 1 >nul
goto :eof

:get_config
set "key=%~1"
set "default=%~2"
set "config_file=%ROOT%config.json"
if exist "%config_file%" (
    REM Simple JSON parsing using findstr (limited but works for basic cases)
    findstr /C:"\"%key%\"" "%config_file%" >nul 2>&1
    if !errorlevel! equ 0 (
        for /f "tokens=2 delims=:," %%a in ('findstr /C:"\"%key%\"" "%config_file%"') do (
            set "value=%%a"
            set "value=!value:~1,-1!"
            if not "!value!"=="" (
                set "%~3=!value!"
                goto :eof
            )
        )
    )
)
set "%~3=%default%"
goto :eof

:auto_find_model
REM Try config.json first
call :get_config "startup.default_model" "" "config_model"
if not "!config_model!"=="" (
    if exist "!config_model!" (
        set "MODEL_PATH=!config_model!"
        goto :eof
    )
)

REM Auto-detect first model in models/ directory
set "models_dir=%ROOT%models"
if exist "%models_dir%" (
    REM Check for .gguf files first
    for %%f in ("%models_dir%\*.gguf") do (
        set "MODEL_PATH=%%f"
        goto :eof
    )
    
    REM Check for subdirectories
    for /d %%d in ("%models_dir%\*") do (
        set "MODEL_PATH=%%d"
        goto :eof
    )
)

set "MODEL_PATH="
goto :eof

:optimize_system
call :log "Optimizing system for inference..."
set "optimizer_script=%SCRIPTS%\windows_prelaunch.ps1"
if exist "%optimizer_script%" (
    call :log "  Running Windows system optimizer..."
    powershell -ExecutionPolicy Bypass -File "%optimizer_script%" >> "%RUNDIR%\optimizer.log" 2>&1
    call :log_ok "Windows optimization complete"
) else (
    call :log "  Skipping optimizer (not found: %optimizer_script%)"
)
goto :eof

:check_model
if "%MODEL_PATH%"=="" (
    call :log "  No model specified — auto-detecting..."
    call :auto_find_model
)

if "%MODEL_PATH%"=="" (
    call :log_err "No model found. Please place a model in ./models/ or set startup.default_model in config.json"
    exit /b 1
)

if not exist "%MODEL_PATH%" (
    call :log_err "Model not found: %MODEL_PATH%"
    exit /b 1
)

call :log "Model: %MODEL_PATH%"
goto :eof

:start_backend
call :log "Starting inference backend..."
set "LLAMA_SERVER=%ROOT%bin\llama-server.exe"
if not exist "%LLAMA_SERVER%" (
    call :log_err "llama-server.exe not found at %LLAMA_SERVER%"
    exit /b 1
)

call :get_config "ctx_size" "16384" "CTX_SIZE"
call :get_config "n_gpu_layers" "15" "N_GPU_LAYERS"
call :get_config "batch_size" "256" "BATCH_SIZE"
call :get_config "ubatch_size" "256" "UBATCH_SIZE"
call :get_config "temperature" "0.7" "TEMPERATURE"
call :get_config "top_p" "0.9" "TOP_P"
call :get_config "top_k" "40" "TOP_K"
call :get_config "repeat_penalty" "1.1" "REPEAT_PENALTY"
call :get_config "min_p" "0.05" "MIN_P"
call :get_config "http_threads" "2" "HTTP_THREADS"
call :get_config "flash_attn" "true" "FLASH_ATTN"
call :get_config "use_mlock" "true" "USE_MLOCK"
call :get_config "kv_quant" "q8_0" "KV_QUANT"
call :get_config "cont_batching" "true" "CONT_BATCHING"

set "BACKEND_LOG=%RUNDIR%\llama_server.log"
call :log "  llama-server → port %API_PORT%"

if "%FLASH_ATTN%"=="true" (
    set "FLASH_FLAG=--flash-attn"
) else (
    set "FLASH_FLAG="
)

if "%CONT_BATCHING%"=="true" (
    set "CB_FLAG=--cont-batching"
) else (
    set "CB_FLAG=--no-cont-batching"
)

start /B "" "%LLAMA_SERVER%" -m "%MODEL_PATH%" --port "%API_PORT%" --host 127.0.0.1 --ctx-size "%CTX_SIZE%" --n-gpu-layers "%N_GPU_LAYERS%" --batch-size "%BATCH_SIZE%" --ubatch-size "%UBATCH_SIZE%" --threads-http "%HTTP_THREADS%" --temperature "%TEMPERATURE%" --top-p "%TOP_P%" --top-k "%TOP_K%" --repeat-penalty "%REPEAT_PENALTY%" --min-p "%MIN_P%" --cache-type-k "%KV_QUANT%" --cache-type-v "%KV_QUANT%" %FLASH_FLAG% %CB_FLAG% > "%BACKEND_LOG%" 2>&1

REM Get PID of the started process (approximation)
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq llama-server.exe" /FO csv ^| find "llama-server.exe"') do (
    set "ll_pid=%%~a"
    set "ll_pid=!ll_pid:~1,-1!"
)
echo !ll_pid! llama_server >> "%PID_FILE%"
call :log "  llama-server PID: !ll_pid!"

call :log "  Waiting for llama-server to be ready..."
set /a "i=0"
:wait_backend
set /a "i+=1"
if !i! gtr 30 (
    call :log_err "llama-server failed to start. Check %BACKEND_LOG%"
    if exist "%BACKEND_LOG%" (
        powershell "Get-Content '%BACKEND_LOG%' | Select-Object -Last 20"
    )
    exit /b 1
)

REM Check if server is responding using curl
curl -s --max-time 2 "http://127.0.0.1:%API_PORT%/v1/models" | find "model" >nul 2>&1
if !errorlevel! equ 0 (
    call :log_ok "llama-server ready on port %API_PORT%"
    goto :eof
)

timeout /t 1 >nul
goto wait_backend

:start_api_server
call :log "Starting Lumina Core API gateway..."
set "API_LOG=%RUNDIR%\api_server.log"
cd /d "%UI_DIR%"

set "MLX_PORT=%MLX_PORT%"
set "LUMINA_API_PORT=%API_PORT%"
set "LUMINA_MLX_PORT=%MLX_PORT%"

start /B "" node api-server.js > "%API_LOG%" 2>&1

REM Get PID of the started process (approximation)
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq node.exe" /FO csv ^| find "node.exe"') do (
    set "api_pid=%%~a"
    set "api_pid=!api_pid:~1,-1!"
)
echo !api_pid! api_server >> "%PID_FILE%"
call :log "  API server PID: !api_pid!"

call :log "  Waiting for API server..."
set /a "i=0"
:wait_api
set /a "i+=1"
if !i! gtr 20 (
    call :log_err "API server failed to start. Check %API_LOG%"
    if exist "%API_LOG%" (
        powershell "Get-Content '%API_LOG%' | Select-Object -Last 20"
    )
    exit /b 1
)

REM Check secondary port first
curl -s --max-time 2 "http://127.0.0.1:8081/api/health" | find "ok" >nul 2>&1
if !errorlevel! equ 0 (
    call :log_ok "API gateway ready (primary: %API_PORT%, mgmt: 8081)"
    goto :eof
)

REM Also check primary port
curl -s --max-time 2 "http://127.0.0.1:%API_PORT%/api/health" | find "ok" >nul 2>&1
if !errorlevel! equ 0 (
    call :log_ok "API gateway already running (primary: %API_PORT%)"
    goto :eof
)

timeout /t 1 >nul
goto wait_api

:start_ui
call :log "Starting Lumina Core UI..."
set "UI_LOG=%RUNDIR%\vite.log"
cd /d "%UI_DIR%"

start /B "" npm run dev > "%UI_LOG%" 2>&1

REM Get PID of the started process (approximation)
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq node.exe" /FO csv ^| find "node.exe"') do (
    set "ui_pid=%%~a"
    set "ui_pid=!ui_pid:~1,-1!"
)
echo !ui_pid! vite >> "%PID_FILE%"
call :log "  Vite PID: !ui_pid!"

call :log "  Waiting for Vite dev server..."
set /a "i=0"
:wait_ui
set /a "i+=1"
if !i! gtr 20 (
    call :log_err "Vite dev server failed. Check %UI_LOG%"
    if exist "%UI_LOG%" (
        powershell "Get-Content '%UI_LOG%' | Select-Object -Last 10"
    )
    exit /b 1
)

curl -s --max-time 2 "http://localhost:%UI_PORT%/" | find "<html" >nul 2>&1
if !errorlevel! equ 0 (
    call :log_ok "Lumina Core UI ready at http://localhost:%UI_PORT%"
    goto :eof
)

timeout /t 1 >nul
goto wait_ui

:setup_openwebui
call :log "Checking OpenWebUI..."

REM Check Docker first
docker ps --format "{{.Names}}" 2>nul | find "open-webui" >nul 2>&1
if !errorlevel! equ 0 (
    call :log "  OpenWebUI detected via Docker (port %OW_PORT%)"
    curl -s --max-time 3 "http://127.0.0.1:%OW_PORT%/" | find "html" >nul 2>&1
    if !errorlevel! equ 0 (
        call :log_ok "OpenWebUI ready at http://127.0.0.1:%OW_PORT%"
        call :log "  Configure OpenWebUI to connect to Lumina:"
        call :log "    1. Open http://127.0.0.1:%OW_PORT% in your browser"
        call :log "    2. Sign up / log in, then go to Settings → Connections"
        call :log "    3. Set API URL to: http://host.docker.internal:%API_PORT%/v1"
        call :log "    4. API Key: any value (Lumina accepts all keys)"
        call :log ""
        goto :eof
    )
)

REM Check local installation
where openwebui >nul 2>&1
if !errorlevel! equ 0 (
    set "openwebui_found=1"
) else if exist "C:\Program Files\OpenWebUI\OpenWebUI.exe" (
    set "openwebui_found=1"
) else if exist "%USERPROFILE%\open-webui" (
    set "openwebui_found=1"
) else (
    set "openwebui_found=0"
)

if !openwebui_found! equ 0 (
    call :log "  OpenWebUI not detected (not installed locally or via Docker)"
    call :log "  Install via Docker: docker run -d -p %OW_PORT%:8080 --add-host=host.docker.internal:host-gateway openwebui/openwebui:latest"
    goto :eof
)

REM Start local OpenWebUI
set "OW_LOG=%RUNDIR%\openwebui.log"
if exist "%USERPROFILE%\open-webui" (
    cd /d "%USERPROFILE%\open-webui"
    
    if not defined LUMINA_API_KEY set "LUMINA_API_KEY=lumina-openai-key"
    set "LUMINA_API_URL=http://127.0.0.1:%API_PORT%/v1"
    if not defined LUMINA_TITLE set "LUMINA_TITLE=Lumina Edge"
    
    set "OLLAMA_BASE_URL=%LUMINA_API_URL%"
    set "OPENAI_API_BASE_URL=%LUMINA_API_URL%"
    set "OPENAI_API_KEY=%LUMINA_API_KEY%"
    set "WEBUI_NAME=%LUMINA_TITLE%"
    
    start /B "" python -m uvicorn openwebui.main:app --host 127.0.0.1 --port "%OW_PORT%" --root-path "/" > "%OW_LOG%" 2>&1
    
    REM Get PID of the started process (approximation)
    for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq python.exe" /FO csv ^| find "python.exe"') do (
        set "ow_pid=%%~a"
        set "ow_pid=!ow_pid:~1,-1!"
    )
    echo !ow_pid! openwebui >> "%PID_FILE%"
    call :log "  OpenWebUI PID: !ow_pid!"
    
    call :log "  Waiting for OpenWebUI..."
    set /a "i=0"
    :wait_openwebui
    set /a "i+=1"
    if !i! gtr 30 (
        call :log_err "OpenWebUI failed to start. Check %OW_LOG%"
        if exist "%OW_LOG%" (
            powershell "Get-Content '%OW_LOG%' | Select-Object -Last 10"
        )
        goto :eof
    )
    
    curl -s --max-time 3 "http://127.0.0.1:%OW_PORT%/" | find "html" >nul 2>&1
    if !errorlevel! equ 0 (
        call :log_ok "OpenWebUI ready at http://127.0.0.1:%OW_PORT%"
        call :log "  Configure: Settings → Connections → API Base URL → %LUMINA_API_URL%"
        goto :eof
    )
    
    timeout /t 1 >nul
    goto wait_openwebui
)
goto :eof

:print_summary
echo.
echo ============================================================
echo   Lumina Edge — All systems ready
echo ============================================================
echo.
echo   Model:       %MODEL_PATH%
echo   Backend:     http://127.0.0.1:%API_PORT%
echo   Lumina Core: http://localhost:%UI_PORT%
echo.
echo   Logs:        %RUNDIR%
echo   PIDs:        %PID_FILE%
echo.
echo   To stop:     taskkill /F /PID ^<PID^>
echo ============================================================
echo.

REM Open browser automatically
start "" "http://localhost:%UI_PORT%" >nul 2>&1
goto :eof

:show_help
echo Lumina Edge Launcher (Windows Batch)
echo.
echo Usage: start_lumina.bat
echo        start_lumina.bat "C:\path\to\model"  (optional — auto-detects if missing)
echo.
echo Environment variables:
echo   LUMINA_API_PORT   Backend/API port (default: 8090)
echo   LUMINA_MLX_PORT   MLX backend port (default: 8091)
echo   LUMINA_UI_PORT    Vite dev server port (default: 5173)
echo   LUMINA_OW_PORT    OpenWebUI port (default: 8080)
echo.
echo Model auto-detection: looks for first model in ./models/ or startup.default_model in config.json
echo.
goto :eof

if "%1"=="--help" goto show_help
if "%1"=="-h" goto show_help
