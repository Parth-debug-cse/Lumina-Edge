@echo off
setlocal EnableDelayedExpansion
title LUMINA EDGE :: LOCAL API SERVER (VULKAN)
color 0B

:: ==================================================
:: AUTO-DETECT PROJECT ROOT
:: ==================================================
set ROOT=%~dp0..
set BIN=%ROOT%\bin
set MODELS=%ROOT%\models
set SCRIPTS=%ROOT%\scripts
set PORT=1234

cd /d "%ROOT%"

:: ==================================================
:: VALIDATE REQUIRED DIRECTORIES
:: ==================================================
if not exist "%BIN%" (
    cls
    echo ==================================================
    echo ERROR :: bin directory not found
    echo ==================================================
    echo.
    echo Expected at: %BIN%
    echo.
    pause
    exit /b 1
)

if not exist "%MODELS%" (
    cls
    echo ==================================================
    echo ERROR :: models directory not found
    echo ==================================================
    echo.
    echo Expected at: %MODELS%
    echo.
    pause
    exit /b 1
)

if not exist "%SCRIPTS%" (
    cls
    echo ==================================================
    echo ERROR :: scripts directory not found
    echo ==================================================
    echo.
    echo Expected at: %SCRIPTS%
    echo.
    pause
    exit /b 1
)

:: ==================================================
:: LOCATE SERVER EXECUTABLE
:: ==================================================
if exist "%BIN%\llama-server.exe" (
    set SERVER_EXE=%BIN%\llama-server.exe
) else if exist "%BIN%\server.exe" (
    set SERVER_EXE=%BIN%\server.exe
) else (
    cls
    echo ==================================================
    echo ERROR :: llama-server executable not found
    echo ==================================================
    echo.
    echo Expected:
    echo   llama-server.exe OR server.exe
    echo.
    echo Location:
    echo   %BIN%
    echo.
    pause
    exit /b 1
)

:: ==================================================
:: MODEL SELECTION
:: ==================================================
:select_model
cls
echo ==================================================
echo   LUMINA EDGE :: SELECT A MODEL
echo ==================================================
echo.
echo Available models:
echo.

set MODEL_COUNT=0
for /f "usebackq delims=" %%F in (`dir /b /a:-d "%MODELS%\*.gguf" 2^>nul`) do (
    set /a MODEL_COUNT+=1
    set "MODEL_!MODEL_COUNT!=%MODELS%\%%F"
    set "MODEL_NAME_!MODEL_COUNT!=%%F"
    set "CUR_NAME=%%F"
    for %%G in ("%MODELS%\%%F") do set "CUR_SIZE=%%~zG"
    echo   !MODEL_COUNT!. !CUR_NAME!
    echo      Size: !CUR_SIZE! bytes
    echo.
)

if %MODEL_COUNT% EQU 0 (
    echo   No models found in:
    echo   %MODELS%
    echo.
    echo   Please download a model using model-manager.bat first.
    echo.
    pause
    exit /b 1
)

echo   D. Download a new model
echo   0. Exit
echo.
echo ==================================================
echo.
set "model_choice="
set /p model_choice="Select model (1-%MODEL_COUNT%): "

if /i "%model_choice%"=="D" (
    start "" /d "%ROOT%" "%ROOT%\model-manager.bat"
    goto select_model
)
if "%model_choice%"=="0" exit /b 0

set MODEL=
if defined MODEL_%model_choice% (
    set MODEL=!MODEL_%model_choice%!
    set SELECTED_NAME=!MODEL_NAME_%model_choice%!
)

if not defined MODEL (
    echo.
    echo   Invalid selection. Please try again.
    timeout /t 2 >nul
    goto select_model
)

:: ==================================================
:: MAIN MENU
:: ==================================================
:menu
cls
echo ==================================================
echo   LUMINA EDGE :: API SERVER MENU
echo ==================================================
echo.
echo   Current Model: %SELECTED_NAME%
echo   Backend      : Vulkan (Integrated GPU)
echo   Endpoint     : http://127.0.0.1:%PORT%/v1
echo.
echo   1. Start API Server
echo   2. Change Model
echo   3. Exit
echo.
echo ==================================================
echo.
set "choice="
set /p choice="lumina@edge> "
if "%choice%"=="1" goto port_check
if "%choice%"=="2" goto select_model
if "%choice%"=="3" exit /b 0
goto menu

:: ==================================================
:: PORT CONFLICT CHECK
:: ==================================================
:port_check
cls
echo ==================================================
echo   CHECKING PORT %PORT%
echo ==================================================
echo.

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo ==================================================
    echo   ERROR :: PORT %PORT% IS ALREADY IN USE
    echo ==================================================
    echo.
    echo Another process is already listening on port %PORT%.
    echo.
    echo To find and stop it, open a Command Prompt and run:
    echo   netstat -ano ^| findstr ":%PORT%"
    echo   taskkill /PID ^<PID^> /F
    echo.
    echo Or change the PORT variable at the top of this file.
    echo.
    pause
    goto menu
)

echo [OK] Port %PORT% is available.
timeout /t 1 >nul
goto init

:: ==================================================
:: INITIALIZATION PIPELINE
:: ==================================================
:init
cls
echo ==================================================
echo   STAGE 1 :: MEMORY RECLAMATION
echo ==================================================
echo.

if exist "%SCRIPTS%\optimize_system.ps1" (
    powershell -ExecutionPolicy Bypass -File "%SCRIPTS%\optimize_system.ps1"
    if !ERRORLEVEL! NEQ 0 (
        echo [WARN] Optimization step failed or was skipped.
    )
) else (
    echo [WARN] %SCRIPTS%\optimize_system.ps1 not found. Skipping optimization.
)

echo.
echo [OK] Memory optimization complete.
timeout /t 1 >nul

:: ==================================================
:: CONFIG PARSING & VRAM DETECTION
:: ==================================================
FOR /F "usebackq delims=" %%i IN (`powershell -NoProfile -Command "try { $c = (Get-Content config.json -Raw | ConvertFrom-Json); if ($null -ne $c.ctx_size) { $c.ctx_size } else { 2048 } } catch { 2048 }"`) DO SET CTX_SIZE=%%i
FOR /F "usebackq delims=" %%i IN (`powershell -NoProfile -Command "try { $c = (Get-Content config.json -Raw | ConvertFrom-Json); if ($null -ne $c.batch_size) { $c.batch_size } else { 512 } } catch { 512 }"`) DO SET BATCH_SIZE=%%i
FOR /F "usebackq delims=" %%i IN (`powershell -NoProfile -Command "try { $c = (Get-Content config.json -Raw | ConvertFrom-Json); if ($null -ne $c.ubatch_size) { $c.ubatch_size } else { 256 } } catch { 256 }"`) DO SET UBATCH_SIZE=%%i
FOR /F "usebackq delims=" %%i IN (`powershell -NoProfile -Command "try { $c = (Get-Content config.json -Raw | ConvertFrom-Json); if ($null -ne $c.n_gpu_layers) { $c.n_gpu_layers } else { 'auto' } } catch { 'auto' }"`) DO SET N_GPU_LAYERS=%%i

set GPU_LAYERS=20
set PRINT_VRAM=0
if /i "!N_GPU_LAYERS!"=="auto" (
    FOR /F "delims=" %%V IN ('powershell -NoProfile -Command "try { [math]::Floor((Get-WmiObject Win32_VideoController | Sort-Object AdapterRAM -Descending | Select-Object -First 1).AdapterRAM / 1048576) } catch { -1 }"') DO SET VRAM_MB=%%V
    if !VRAM_MB! GTR -1 (
        if !VRAM_MB! LSS 1024 set GPU_LAYERS=0
        if !VRAM_MB! GEQ 1024 if !VRAM_MB! LSS 2048 set GPU_LAYERS=10
        if !VRAM_MB! GEQ 2048 if !VRAM_MB! LSS 4096 set GPU_LAYERS=20
        if !VRAM_MB! GEQ 4096 if !VRAM_MB! LSS 6144 set GPU_LAYERS=33
        if !VRAM_MB! GEQ 6144 set GPU_LAYERS=40
        set PRINT_VRAM=1
    )
) else (
    set GPU_LAYERS=!N_GPU_LAYERS!
)

cls
echo ==================================================
echo   STAGE 2 :: STARTING API SERVER
echo ==================================================
echo.
echo   OpenAI-compatible endpoint:
echo   http://127.0.0.1:%PORT%/v1
echo.
echo   Model   : %SELECTED_NAME%
echo   Backend : Vulkan (Integrated GPU)
echo   Context : !CTX_SIZE! tokens
echo   Threads : 4
echo.
if !PRINT_VRAM! EQU 1 (
    echo [Lumina] VRAM detected: !VRAM_MB! MB -^> offloading !GPU_LAYERS! layers to GPU
    echo.
)
echo Press Ctrl+C to stop the server.
echo ==================================================
echo.

"%SERVER_EXE%" ^
-m "%MODEL%" ^
--host 127.0.0.1 ^
--port %PORT% ^
--ctx-size !CTX_SIZE! ^
--batch-size !BATCH_SIZE! ^
--ubatch-size !UBATCH_SIZE! ^
--n-gpu-layers !GPU_LAYERS! ^
--flash-attn ^
--mlock ^
--threads 4 ^
--parallel 1 ^
--verbose

:: ==================================================
:: ERROR / EXIT HANDLING
:: ==================================================
echo.
echo ==================================================
echo   SERVER STOPPED
echo ==================================================
echo.
echo If this was unexpected, possible causes:
echo   - Port %PORT% already in use
echo   - Model incompatible
echo   - Vulkan runtime missing
echo.
set "restart="
set /p restart="Return to menu? (Y/N): "
if /i "%restart%"=="Y" goto menu
exit /b 0
