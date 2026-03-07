@echo off
setlocal EnableDelayedExpansion
title LUMINA EDGE :: MODEL MANAGER
color 0E

:: ==================================================
:: AUTO-DETECT PROJECT ROOT
:: ==================================================
:: model-manager.bat lives in project root (same level as core/, models/, etc.)
:: So ROOT = the directory this file is in, with trailing slash stripped
set ROOT=%~dp0
if "%ROOT:~-1%"=="\" set ROOT=%ROOT:~0,-1%
set MODELS=%ROOT%\models

cd /d "%ROOT%"

:: Create models directory if it doesn't exist
if not exist "%MODELS%" (
    mkdir "%MODELS%"
    echo [OK] Created models directory: %MODELS%
    timeout /t 1 >nul
)

:: ==================================================
:: MAIN MENU
:: ==================================================
:main_menu
cls
echo ==================================================
echo   LUMINA EDGE :: MODEL MANAGER
echo ==================================================
echo.
echo   Models location: %MODELS%
echo.
echo   1. Download a new model
echo   2. List downloaded models
echo   3. Delete a model
echo   0. Exit
echo.
echo ==================================================
echo.
set "choice="
set /p choice="lumina@edge> "
if "%choice%"=="1" goto download_menu
if "%choice%"=="2" goto list_models
if "%choice%"=="3" goto delete_model
if "%choice%"=="0" exit /b 0
goto main_menu

:: ==================================================
:: DOWNLOAD MENU - PREDEFINED MODELS
:: ==================================================
:download_menu
cls
echo ==================================================
echo   DOWNLOAD A MODEL
echo ==================================================
echo.
echo   Available models (GGUF format):
echo.
echo   1. Phi-3-mini-4k-instruct  (2.3GB) - Fast, good for 4GB RAM
echo   2. TinyLlama-1.1B-Chat     (0.7GB) - Very small, very fast
echo   3. Mistral-7B-Instruct-v0.2 (4.1GB) - Balanced quality
echo   4. Llama-3-8B-Instruct      (4.7GB) - High quality
echo   5. Custom URL
echo   0. Back
echo.
echo ==================================================
echo.
set "choice="
set /p choice="Select model to download: "

if "%choice%"=="1" (
    set MODEL_URL=https://huggingface.co/microsoft/Phi-3-mini-4k-instruct-gguf/resolve/main/Phi-3-mini-4k-instruct-q4.gguf
    set MODEL_NAME=phi-3-mini-4k-instruct.Q4_K_M.gguf
    goto download
)
if "%choice%"=="2" (
    set MODEL_URL=https://huggingface.co/TheBloke/TinyLlama-1.1B-Chat-v1.0-GGUF/resolve/main/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf
    set MODEL_NAME=tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf
    goto download
)
if "%choice%"=="3" (
    set MODEL_URL=https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF/resolve/main/mistral-7b-instruct-v0.2.Q4_K_M.gguf
    set MODEL_NAME=mistral-7b-instruct-v0.2.Q4_K_M.gguf
    goto download
)
if "%choice%"=="4" (
    set MODEL_URL=https://huggingface.co/TheBloke/Llama-3-8B-Instruct-GGUF/resolve/main/llama-3-8b-instruct.Q4_K_M.gguf
    set MODEL_NAME=llama-3-8b-instruct.Q4_K_M.gguf
    goto download
)
if "%choice%"=="5" goto custom_download
if "%choice%"=="0" goto main_menu
goto download_menu

:: ==================================================
:: CUSTOM DOWNLOAD
:: ==================================================
:custom_download
cls
echo ==================================================
echo   CUSTOM MODEL DOWNLOAD
echo ==================================================
echo.
echo Enter the direct download URL for the GGUF file:
echo (Must be a direct link to a .gguf file on HuggingFace)
echo.
echo Example:
echo https://huggingface.co/TheBloke/model-name-GGUF/resolve/main/model.Q4_K_M.gguf
echo.
echo ==================================================
echo.
set "MODEL_URL="
set /p MODEL_URL="URL: "
if "%MODEL_URL%"=="" goto download_menu

:: Extract filename from URL
for %%F in ("%MODEL_URL%") do set MODEL_NAME=%%~nxF

echo.
echo Model will be saved as: %MODEL_NAME%
echo.
set "confirm="
set /p confirm="Continue? (Y/N): "
if /i "%confirm%" NEQ "Y" goto download_menu

goto download

:: ==================================================
:: DOWNLOAD PROCESS
:: ==================================================
:download
cls
echo ==================================================
echo   DOWNLOADING MODEL
echo ==================================================
echo.
echo   Model : %MODEL_NAME%
echo   URL   : %MODEL_URL%
echo.
echo This may take several minutes depending on your internet speed...
echo.
echo ==================================================
echo.

:: Check if model already exists
if exist "%MODELS%\%MODEL_NAME%" (
    echo [WARNING] Model already exists: %MODEL_NAME%
    echo.
    set "overwrite="
    set /p overwrite="Overwrite? (Y/N): "
    if /i "!overwrite!" NEQ "Y" goto main_menu
)

:: Download using PowerShell with progress
powershell -Command "& { $ProgressPreference = 'Continue'; Invoke-WebRequest -Uri '%MODEL_URL%' -OutFile '%MODELS%\%MODEL_NAME%' -UseBasicParsing }"

:: Check if download was successful
if exist "%MODELS%\%MODEL_NAME%" (
    cls
    echo ==================================================
    echo   DOWNLOAD COMPLETE
    echo ==================================================
    echo.
    echo   Model saved to:
    echo   %MODELS%\%MODEL_NAME%
    echo.
    for %%F in ("%MODELS%\%MODEL_NAME%") do echo   File size: %%~zF bytes
    echo.
    pause
) else (
    cls
    echo ==================================================
    echo   DOWNLOAD FAILED
    echo ==================================================
    echo.
    echo Possible reasons:
    echo   - Invalid URL
    echo   - No internet connection
    echo   - Insufficient disk space
    echo   - HuggingFace rate limit (try again later)
    echo.
    pause
)

goto main_menu

:: ==================================================
:: LIST DOWNLOADED MODELS
:: ==================================================
:list_models
cls
echo ==================================================
echo   DOWNLOADED MODELS
echo ==================================================
echo.
echo   Location: %MODELS%
echo.

set count=0
for %%F in ("%MODELS%\*.gguf") do (
    set /a count+=1
    echo   !count!. %%~nxF
    for %%G in ("%%F") do echo      Size: %%~zG bytes
    echo.
)

if %count% EQU 0 (
    echo   No models found. Download a model first.
    echo.
)

echo   Total models: %count%
echo.
pause
goto main_menu

:: ==================================================
:: DELETE MODEL
:: ==================================================
:delete_model
cls
echo ==================================================
echo   DELETE A MODEL
echo ==================================================
echo.
echo   Select a model to delete:
echo.

set count=0
for %%F in ("%MODELS%\*.gguf") do (
    set /a count+=1
    set model!count!=%%~nxF
    echo   !count!. %%~nxF
)

if %count% EQU 0 (
    echo   No models found.
    echo.
    pause
    goto main_menu
)

echo.
echo   0. Cancel
echo.
set "choice="
set /p choice="Enter number: "

if "%choice%"=="0" goto main_menu

:: Validate selection is in range
set TARGET_MODEL=
if defined model%choice% (
    set TARGET_MODEL=!model%choice%!
)

if not defined TARGET_MODEL (
    echo.
    echo   Invalid selection.
    pause
    goto delete_model
)

echo.
echo   Deleting: %TARGET_MODEL%
echo.
set "confirm="
set /p confirm="Are you sure? (Y/N): "
if /i "%confirm%" NEQ "Y" goto main_menu

del "%MODELS%\%TARGET_MODEL%"

if exist "%MODELS%\%TARGET_MODEL%" (
    echo.
    echo   [ERROR] Failed to delete model.
) else (
    echo.
    echo   [OK] Model deleted successfully.
)

echo.
pause
goto main_menu
