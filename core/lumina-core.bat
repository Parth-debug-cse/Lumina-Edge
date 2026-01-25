@echo off
setlocal EnableDelayedExpansion
title LUMINA EDGE :: CORE CONTROLLER
color 0A

:: ==================================================
:: ABSOLUTE PROJECT PATHS
:: ==================================================
set ROOT=C:\Lumina-Edge
set BIN=%ROOT%\bin
set MODELS=%ROOT%\models
set SCRIPTS=%ROOT%\scripts

cd /d "%ROOT%"

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
    echo Install llama.cpp correctly and retry.
    echo.
    pause
    exit /b 1
)

:: ==================================================
:: LOCATE DEFAULT MODEL (named "one")
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
    exit /b 1
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
echo [OK] Model Loaded : %MODEL%
echo [OK] Backend      : Vulkan (Integrated GPU)
echo [OK] Mode         : Local Chat
echo.
timeout /t 1 >nul

:: ==================================================
:: MENU
:: ==================================================
:menu
cls
echo ==================================================
echo   LUMINA EDGE :: MAIN MENU
echo ==================================================
echo.
echo   1. Initialize Local LLM 
echo   2. Exit
echo.
echo ==================================================
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

cls
echo ==================================================
echo   STAGE 2 :: LLM INITIALIZATION
echo ==================================================
echo.
echo Press CTRL+C to exit chat.
echo ==================================================
echo.

"%BIN%\llama-cli.exe" ^
 -m "%MODEL%" ^
 -t 4 ^
 -c 3072 ^
 --color on ^
 -cnv ^
 --multiline-input ^
 -sys "You are a precise, efficient AI assistant."

:: ==================================================
:: EXIT CLEANUP
:: ==================================================
echo.
echo ==================================================
echo   SESSION ENDED
echo ==================================================
echo.
pause
exit
