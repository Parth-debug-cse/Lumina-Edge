@echo off
setlocal EnableDelayedExpansion
title LUMINA EDGE :: MULTI-MODEL ROUTER
color 0B
cls

:: ====================================
:: HEADER BANNER
:: ====================================
call :ui_banner "Multi-Model Router"

:: ==================================================
:: AUTO-DETECT PROJECT ROOT
:: ==================================================
set ROOT=%~dp0..
set BIN=%ROOT%\bin
set MODELS=%ROOT%\models
set SCRIPTS=%ROOT%\scripts
set CONFIG=%ROOT%\config.json
set BASE_MODEL_PORT=8000

:: Get API port from config
for /f "tokens=*" %%A in ('powershell -Command "try { (Get-Content '%CONFIG%' | ConvertFrom-Json).api_port } catch { Write-Output '1234' }"') do set API_PORT=%%A

if "%API_PORT%"=="" set API_PORT=1234

cd /d "%ROOT%"

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
echo   LUMINA EDGE :: !UI_TITLE!
echo ======================================================================
echo.
exit /b 0

:ui_section
REM Args: section title
set "UI_SEC=%~1"
echo   >> !UI_SEC!
echo.
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
set /a UI_P_SLEEP=%~3
if %UI_P_SLEEP% LSS 1 set UI_P_SLEEP=18
echo.
<nul set /p ="  !UI_P_LABEL! "
for /l %%i in (1,1,%UI_P_STEPS%) do (
    <nul set /p ="#"
    call :sleepMs %UI_P_SLEEP%
)
echo.
exit /b 0

:: ==================================================
:: VALIDATE REQUIREMENTS
:: ==================================================
echo.
echo  ▸ Validation ^& Setup
echo.

if not exist "%BIN%" (
    color 0C
    echo   ✗ bin directory not found at %BIN%
    color 0B
    pause
    exit /b 1
)

if not exist "%MODELS%" (
    color 0C
    echo   ✗ models directory not found at %MODELS%
    color 0B
    pause
    exit /b 1
)

if not exist "%SCRIPTS%" (
    color 0C
    echo   ✗ scripts directory not found at %SCRIPTS%
    color 0B
    pause
    exit /b 1
)

if not exist "%BIN%\llama-server.exe" (
    color 0C
    echo   ✗ llama-server.exe not found
    color 0B
    pause
    exit /b 1
)

if not exist "%SCRIPTS%\model-router.py" (
    color 0C
    echo   ✗ model-router.py not found
    color 0B
    pause
    exit /b 1
)

color 0B
echo   ✓ Project structure validated
echo   ✓ llama-server executable found
echo   ✓ All dependencies found
echo.

:: ==================================================
:: SCAN FOR MODELS
:: ==================================================
echo  ▸ Model Discovery
echo.

set MODEL_COUNT=0
setlocal EnableDelayedExpansion

for %%E in (gguf safetensors bin pt) do (
    for /f "usebackq delims=" %%F in (`dir /b /a:-d "%MODELS%\*.%%E" 2^>nul`) do (
        set /a MODEL_COUNT+=1
        set "MODEL_!MODEL_COUNT!=%MODELS%\%%F"
        set "MODEL_NAME_!MODEL_COUNT!=%%F"
        
        set "EXT=%%E"
        if "!EXT!"=="gguf" (
            echo   [!MODEL_COUNT!] [GGUF] %%F
        ) else if "!EXT!"=="safetensors" (
            echo   [!MODEL_COUNT!] [SafeTensor] %%F
        ) else (
            echo   [!MODEL_COUNT!] [FP16] %%F
        )
    )
)

endlocal & setlocal EnableDelayedExpansion

if %MODEL_COUNT% EQU 0 (
    color 0C
    echo.
    echo   ✗ No models found in %MODELS%
    color 0B
    pause
    exit /b 1
)

echo.
echo   ✓ Found %MODEL_COUNT% model(s)
echo.

:: ==================================================
:: MULTI-MODEL SELECTION
:: ==================================================
echo  ▸ Multi-Model Selection
echo.

set SELECTED_COUNT=0

echo   Enter model numbers separated by commas (e.g. 1,3,4) or type all.
echo.
set /p "SELECTION=Selection> "

if /i "%SELECTION%"=="all" (
    for /L %%i in (1,1,%MODEL_COUNT%) do (
        set "MODEL=!MODEL_%%i!"
        set "NAME=!MODEL_NAME_%%i!"
        set /a SELECTED_COUNT+=1
        set "SELECTED_!SELECTED_COUNT!=!MODEL!"
        set "SELECTED_NAME_!SELECTED_COUNT!=!NAME!"
        set /a PORT=!BASE_MODEL_PORT!+!SELECTED_COUNT!-1
        set "SELECTED_PORT_!SELECTED_COUNT!=!PORT!"
        echo     [OK] !NAME! for port !PORT!
        echo.
    )
) else (
    set "SELECTION=%SELECTION:,= %"
    for %%T in (%SELECTION%) do (
        if not "%%T"=="" (
            if %%T GEQ 1 if %%T LEQ %MODEL_COUNT% (
                if not defined SEEN_%%T (
                    set "SEEN_%%T=1"
                    set "MODEL=!MODEL_%%T!"
                    set "NAME=!MODEL_NAME_%%T!"
                    set /a SELECTED_COUNT+=1
                    set "SELECTED_!SELECTED_COUNT!=!MODEL!"
                    set "SELECTED_NAME_!SELECTED_COUNT!=!NAME!"
                    set /a PORT=!BASE_MODEL_PORT!+!SELECTED_COUNT!-1
                    set "SELECTED_PORT_!SELECTED_COUNT!=!PORT!"
                    echo     [OK] !NAME! for port !PORT!
                    echo.
                )
            )
        )
    )
)

endlocal & setlocal EnableDelayedExpansion

if %SELECTED_COUNT% EQU 0 (
    echo   ✗ No models selected
    pause
    exit /b 1
)

echo   ✓ Ready to load %SELECTED_COUNT% model(s)
echo.

:: ==================================================
:: ROUTER CONFIGURATION
:: ==================================================
echo  ▸ Router Configuration
echo.
echo   Select routing policy:
echo     [1] round-robin (default)
echo     [2] load-balanced
echo     [3] first-available
echo.
set /p ROUTING_CHOICE=" Choice (1-3): "

if "%ROUTING_CHOICE%"=="2" (
    set ROUTING_POLICY=load-balanced
) else if "%ROUTING_CHOICE%"=="3" (
    set ROUTING_POLICY=first-available
) else (
    set ROUTING_POLICY=round-robin
)

echo.
echo   ✓ Routing policy: %ROUTING_POLICY%
echo.

:: ==================================================
:: PARALLEL LOADING PLAN
:: ==================================================
echo  ▸ Parallel Loading Plan
echo.

for /L %%i in (1,1,%SELECTED_COUNT%) do (
    set "MODEL=!SELECTED_%%i!"
    set "NAME=!SELECTED_NAME_%%i!"
    set "PORT=!SELECTED_PORT_%%i!"
    
    echo   Model %%i: !NAME!
    echo     Port: !PORT!
    echo     GPU Layers: auto
    echo.
)

:: ==================================================
:: START MODELS
:: ==================================================
set /p START_CHOICE="Would you like to start the models now? (y/n): "

if /i "%START_CHOICE%"=="y" (
    echo.
    echo  ▸ Starting Parallel Model Loading
    echo.
    
    call :ui_progress "Launching model router" 26 18
    echo.
    
    python "%SCRIPTS%\model-router.py" load!SELECTED_1! ^
        --bin-path "%BIN%" --scripts "%SCRIPTS%" --models-dir "%MODELS%"
    
    if %ERRORLEVEL% EQU 0 (
        echo.
        echo   ✓ All models loaded successfully!
        echo.
        echo   API Endpoints:
        for /L %%i in (1,1,%SELECTED_COUNT%) do (
            set "PORT=!SELECTED_PORT_%%i!"
            echo     http://127.0.0.1:!PORT!/v1
        )
        echo.
        echo   ✓ Router is ready to dispatch requests
    ) else (
        color 0C
        echo   ✗ Failed to load models
        color 0B
    )
) else (
    echo.
    echo   ℹ Setup complete. Models ready for manual loading.
)

echo.
echo  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.
pause
