@echo off
setlocal EnableDelayedExpansion
title LUMINA EDGE :: CORE CONTROLLER (NVIDIA)
color 0B

:: ==================================================
:: LUMINA EDGE - ABSOLUTE PROJECT ROOT
:: ==================================================
set ROOT=C:\Lumina-Edge
set BIN=%ROOT%\bin
set MODELS=%ROOT%\models
set SCRIPTS=%ROOT%\scripts

cd /d "%ROOT%"

:: ==================================================
:: LOCATE DEFAULT MODEL (NAMED "one")
:: ==================================================
set MODEL=

for %%F in ("%MODELS%\one.*") do (
    set MODEL=%%F
)

if not defined MODEL (
    cls
    echo ==================================================
    echo   ERROR :: DEFAULT MODEL NOT FOUND
    echo ==================================================
    echo.
    echo Expected a model named:
    echo   one.gguf
    echo.
    echo Location:
    echo   %MODELS%
    echo.
    echo Rename your model to "one.gguf" and retry.
    echo.
    pause
    exit
)

:: ==================================================
:: BOOT SEQUENCE
:: ==================================================
cls
echo ==================================================
echo   LUMINA EDGE :: LOCAL LLM CONTROLLER (CUDA)
echo ==================================================
echo.
echo [OK] Project Root     : %ROOT%
echo [OK] Model Loaded     : %MODEL%
echo [OK] CUDA Backend     : READY
echo [OK] GPU Acceleration: ENABLED
echo [OK] Memory Manager  : STANDBY
echo.
timeout /t 1 >nul

:: ==================================================
:: MENU
:: ==================================================
:menu
echo --------------------------------------------------
echo   1. Initialize Local LLM (RAM Clean + Launch)
echo   2. Exit
echo --------------------------------------------------
echo.
set /p choice="lumina@edge> "

if "%choice%"=="1" goto init
if "%choice%"=="2" exit
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

echo.
echo ==================================================
echo   STAGE 2 :: LLM INITIALIZATION (CUDA)
echo ==================================================
echo.

"%BIN%\llama-cli.exe" ^
 -m "%MODEL%" ^
 -t 8 ^
 -c 4096 ^
 --n-gpu-layers 99 ^
 --color on ^
 -cnv ^
 --multiline-input ^
 -sys "You are a precise, efficient AI assistant."

echo.
echo [OK] LLM session ended.
echo [INFO] Exiting controller.
timeout /t 1 >nul
exit
