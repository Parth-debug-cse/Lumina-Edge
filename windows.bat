@echo off
:: ==============================================================================
:: windows.bat — Lumina Edge Launcher for Windows (llama-server)
:: Starts API server + UI only. Models are loaded on demand via the UI.
:: NO model is autoloaded at startup — use the Models tab to load one.
:: ==============================================================================

setlocal EnableDelayedExpansion

:: Move to script directory (repo root)
cd /d "%~dp0"
set ROOT=%CD%
set UI_DIR=%ROOT%\ui
set RUNDIR=%ROOT%\.lumina_run

if not exist "%RUNDIR%" mkdir "%RUNDIR%"

:: Ports (override with env vars before running if needed)
if not defined LUMINA_API_PORT set LUMINA_API_PORT=8090
if not defined LUMINA_UI_PORT  set LUMINA_UI_PORT=5173

echo [Lumina] ============================================================
echo [Lumina]   Lumina Edge Launcher (Windows)
echo [Lumina] ============================================================
echo [Lumina]   Root: %ROOT%
echo [Lumina]   API port: %LUMINA_API_PORT%
echo [Lumina]   UI port:  %LUMINA_UI_PORT%
echo [Lumina]

:: ============================================================================
:: Kill any existing Lumina processes
:: ============================================================================

echo [Lumina] Stopping any existing Lumina processes...
taskkill /f /im node.exe 2>nul
:: Give processes a moment to die
timeout /t 2 /nobreak >nul

:: ============================================================================
:: Check dependencies
:: ============================================================================

where node >nul 2>&1
if errorlevel 1 (
    echo [Lumina] ERROR: node.exe not found. Install Node.js from https://nodejs.org
    pause
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [Lumina] ERROR: npm not found. Install Node.js from https://nodejs.org
    pause
    exit /b 1
)

:: ============================================================================
:: Install UI dependencies if needed
:: ============================================================================

if not exist "%UI_DIR%\node_modules" (
    echo [Lumina] Installing UI dependencies...
    cd /d "%UI_DIR%"
    call npm install
    if errorlevel 1 (
        echo [Lumina] ERROR: npm install failed
        pause
        exit /b 1
    )
    cd /d "%ROOT%"
)

:: ============================================================================
:: Start API gateway
:: ============================================================================

echo [Lumina] Starting Lumina Core API gateway...
cd /d "%UI_DIR%"

set API_LOG=%RUNDIR%\api_server.log
start /b "" node api-server.js > "%API_LOG%" 2>&1

cd /d "%ROOT%"
echo [Lumina]   API server started

:: Wait for API server to be ready (poll up to 30s)
set API_READY=0
for /l %%i in (1,1,30) do (
    if !API_READY!==0 (
        curl -s --max-time 2 "http://127.0.0.1:%LUMINA_API_PORT%/api/health" 2>nul | find "ok" >nul
        if not errorlevel 1 (
            set API_READY=1
            echo [Lumina] ^✓ API gateway ready on port %LUMINA_API_PORT%
        ) else (
            timeout /t 1 /nobreak >nul
        )
    )
)

if %API_READY%==0 (
    echo [Lumina] ERROR: API server failed to start. Check %API_LOG%
    type "%API_LOG%"
    pause
    exit /b 1
)

:: ============================================================================
:: Start Vite UI
:: ============================================================================

echo [Lumina] Starting Lumina Core UI...
cd /d "%UI_DIR%"

set UI_LOG=%RUNDIR%\vite.log
start /b "" npm run dev > "%UI_LOG%" 2>&1

cd /d "%ROOT%"
echo [Lumina]   Vite dev server started

:: Wait for Vite to be ready (poll up to 20s)
set UI_READY=0
for /l %%i in (1,1,20) do (
    if !UI_READY!==0 (
        curl -s --max-time 2 "http://localhost:%LUMINA_UI_PORT%/" 2>nul | find "html" >nul
        if not errorlevel 1 (
            set UI_READY=1
            echo [Lumina] ^✓ Lumina UI ready at http://localhost:%LUMINA_UI_PORT%
        ) else (
            timeout /t 1 /nobreak >nul
        )
    )
)

if %UI_READY%==0 (
    echo [Lumina] WARNING: Vite may still be starting. Check http://localhost:%LUMINA_UI_PORT%
)

:: ============================================================================
:: Open browser and print summary
:: ============================================================================

echo.
echo ============================================================
echo   Lumina Edge -- Ready
echo ============================================================
echo.
echo   API:       http://127.0.0.1:%LUMINA_API_PORT%
echo   Lumina UI: http://localhost:%LUMINA_UI_PORT%
echo.
echo   No model loaded. Use the Models tab to load one.
echo.
echo   Logs: %RUNDIR%\
echo ============================================================
echo.

start "" "http://localhost:%LUMINA_UI_PORT%"

echo [Lumina] Startup complete. Close this window to stop all services.
echo [Lumina] (Note: node processes will continue until manually stopped)
echo.
pause
