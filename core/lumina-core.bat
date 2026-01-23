@echo off
setlocal EnableDelayedExpansion
title LUMINA EDGE :: LOCAL API SERVER (iGPU / VULKAN)
color 0B

:: ==================================================
:: ABSOLUTE PATHS
:: ==================================================
set ROOT=C:\Lumina-Edge
set BIN=%ROOT%\bin
set MODELS=%ROOT%\models
set PORT=1234

cd /d "%ROOT%"

:: ==================================================
:: LOCATE SERVER EXECUTABLE
:: ==================================================
set SERVER_EXE=

if exist "%BIN%\llama-server.exe" set SERVER_EXE=%BIN%\llama-server.exe
if exist "%BIN%\server.exe" set SERVER_EXE=%BIN%\server.exe

if not defined SERVER_EXE (
    echo ==================================================
    echo ERROR :: llama.cpp SERVER EXECUTABLE NOT FOUND
    echo ==================================================
    echo.
    echo Expected one of:
    echo   llama-server.exe
    echo   server.exe
    echo.
    echo Location:
    echo   %BIN%
    echo.
    pause
    exit /b 1
)

:: ==================================================
:: LOCATE MODEL (one.*)
:: ==================================================
set MODEL=

for %%F in ("%MODELS%\one.*") do (
    set MODEL=%%F
)

if not defined MODEL (
    echo ==================================================
    echo ERROR :: MODEL NOT FOUND
    echo ==================================================
    echo.
    echo Expected a model named:
    echo   one.gguf
    echo.
    echo Location:
    echo   %MODELS%
    echo.
    pause
    exit /b 1
)

:: ==================================================
:: BOOT INFO
:: ==================================================
cls
echo ==================================================
echo   LUMINA EDGE :: LOCAL API SERVER
echo ==================================================
echo.
echo [OK] Executable : %SERVER_EXE%
echo [OK] Model      : %MODEL%
echo [OK] Port       : %PORT%
echo [OK] Backend    : Vulkan (Integrated GPU)
echo.
echo API Endpoint:
echo   http://localhost:%PORT%/v1
echo.
echo Press CTRL+C to stop the server.
echo ==================================================
timeout /t 1 >nul

:: ==================================================
:: START SERVER (BLOCKING)
:: ==================================================
"%SERVER_EXE%" ^
 -m "%MODEL%" ^
 --host 127.0.0.1 ^
 --port %PORT% ^
 --ctx-size 3072 ^
 --threads 4 ^
 --vram-budget 2048 ^
 --parallel 1 ^
 --verbose

:: ==================================================
:: ERROR FALLBACK
:: ==================================================
echo.
echo ==================================================
echo SERVER STOPPED OR FAILED
echo ==================================================
echo.
echo Possible causes:
echo - Port %PORT% already in use
echo - Vulkan runtime missing or outdated
echo - Insufficient shared memory
echo - Incompatible model
echo.
pause
exit /b
