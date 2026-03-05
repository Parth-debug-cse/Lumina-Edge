@echo off
setlocal EnableDelayedExpansion
title LUMINA EDGE :: CORE CONTROLLER (NVIDIA)
color 0C

:: ==================================================
:: AUTO-DETECT PROJECT ROOT
:: ==================================================
set ROOT=%~dp0..
set BIN=%ROOT%\bin
set MODELS=%ROOT%\models
set SCRIPTS=%ROOT%\scripts

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
    echo Please install llama.cpp CUDA binaries in the bin folder.
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
:: LOCATE llama-cli EXECUTABLE
:: ==================================================
if not exist "%BIN%\llama-cli.exe" (
    cls
    echo ==================================================
    echo   ERROR :: llama-cli.exe NOT FOUND
    echo ==================================================
    echo.
    echo Expected:
    echo   %BIN%\llama-cli.exe
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
set /p model_choice="Select model (1-%MODEL_COUNT%): "

if /i "%model_choice%"=="D" (
    start "" "%ROOT%\model-manager.bat"
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
:: BOOT SCREEN
:: ==================================================
cls
echo ==================================================
echo   LUMINA EDGE :: LOCAL LLM CONTROLLER
echo ==================================================
echo.
echo [OK] Project Root : %ROOT%
echo [OK] Model        : %SELECTED_NAME%
echo [OK] Backend      : NVIDIA CUDA
echo [OK] Mode         : Local Chat
echo.
timeout /t 1 >nul

:: ==================================================
:: MAIN MENU
:: ==================================================
:menu
cls
echo ==================================================
echo   LUMINA EDGE :: MAIN MENU
echo ==================================================
echo.
echo   Current Model: %SELECTED_NAME%
echo   Backend      : NVIDIA CUDA
echo.
echo   1. Initialize Local LLM (CUDA)
echo   2. Change Model
echo   3. Exit
echo.
echo ==================================================
echo.
set /p choice="lumina@edge> "
if "%choice%"=="1" goto init
if "%choice%"=="2" goto select_model
if "%choice%"=="3" exit /b 0
goto menu

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
echo   STAGE 2 :: LLM INITIALIZATION (CUDA)
echo ==================================================
echo.
echo   Model      : %SELECTED_NAME%
echo   Backend    : NVIDIA CUDA
echo   Context    : 4096 tokens
echo   Threads    : 4
echo   GPU Layers : 20
echo.
echo Press CTRL+C to exit chat.
echo ==================================================
echo.

"%BIN%\llama-cli.exe" ^
-m "%MODEL%" ^
-t 4 ^
-c 4096 ^
--n-gpu-layers 20 ^
--color on ^
-cnv ^
--multiline-input ^
-sys "You are a precise, efficient AI assistant."

:: ==================================================
:: POST-SESSION
:: ==================================================
echo.
echo ==================================================
echo   SESSION ENDED
echo ==================================================
echo.
set /p restart="Return to menu? (Y/N): "
if /i "%restart%"=="Y" goto menu
exit /b 0
