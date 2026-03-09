@echo off
setlocal EnableDelayedExpansion
title LUMINA EDGE :: LOCAL API SERVER (NVIDIA)
color 0C

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
:: CHECK FOR NVIDIA GPU
:: ==================================================
nvidia-smi >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    cls
    echo ==================================================
    echo ERROR :: NVIDIA GPU NOT DETECTED
    echo ==================================================
    echo.
    echo This script requires an NVIDIA GPU with CUDA support.
    echo Please ensure you have:
    echo - NVIDIA GPU installed
    echo - NVIDIA drivers installed
    echo - CUDA toolkit installed
    echo.
    echo Or use the non-NVIDIA version: lumina-api.bat
    echo.
    pause
    exit /b 1
)

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
    echo Install llama.cpp CUDA build and retry.
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
for %%F in ("%MODELS%\*.gguf") do (
    set /a MODEL_COUNT+=1
    set MODEL_!MODEL_COUNT!=%%F
    set MODEL_NAME_!MODEL_COUNT!=%%~nxF
    for %%G in ("%%F") do set MODEL_SIZE_!MODEL_COUNT!=%%~zG
    echo   !MODEL_COUNT!. %%~nxF
    echo      Size: %%~zG bytes
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
echo   Backend      : NVIDIA CUDA
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

powershell -ExecutionPolicy Bypass -File "%SCRIPTS%\optimize_system.ps1"

echo.
echo [OK] Memory optimization complete.
timeout /t 1 >nul

cls
echo ==================================================
echo   STAGE 2 :: STARTING API SERVER
echo ==================================================
echo.
echo   OpenAI-compatible endpoint:
echo   http://127.0.0.1:%PORT%/v1
echo.
echo   Model      : %SELECTED_NAME%
echo   Backend    : NVIDIA CUDA
echo   Context    : 4096 tokens
echo   Threads    : 4
echo   GPU Layers : 20
echo.
echo Press Ctrl+C to stop the server.
echo ==================================================
echo.

"%SERVER_EXE%" ^
-m "%MODEL%" ^
--host 127.0.0.1 ^
--port %PORT% ^
--ctx-size 4096 ^
--threads 4 ^
--n-gpu-layers 20 ^
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
echo   - Insufficient GPU memory
echo   - CUDA drivers missing or outdated
echo   - Model incompatible
echo.
set "restart="
set /p restart="Return to menu? (Y/N): "
if /i "%restart%"=="Y" goto menu
exit /b 0
