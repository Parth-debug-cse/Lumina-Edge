@echo off
setlocal EnableDelayedExpansion
title LUMINA EDGE :: LOCAL API SERVER (NVIDIA)
color 0C

:: ==================================================
:: ABSOLUTE PATHS
:: ==================================================
set ROOT=C:\Lumina-Edge
set BIN=%ROOT%\bin
set MODELS=%ROOT%\models
set SCRIPTS=%ROOT%\scripts
set PORT=1234

cd /d "%ROOT%"

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
:: LOCATE MODEL (one.*)
:: ==================================================
set MODEL=

for %%F in ("%MODELS%\one.*") do (
    set MODEL=%%F
)

if not defined MODEL (
    cls
    echo ==================================================
    echo ERROR :: MODEL NOT FOUND
    echo ==================================================
    echo.
    echo Expected:
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
echo   STAGE 2 :: STARTING API SERVER
echo ==================================================
echo.
echo OpenAI-compatible endpoint:
echo   http://127.0.0.1:%PORT%/v1
echo.
echo Model   : %MODEL%
echo Backend : NVIDIA CUDA
echo.
echo Press Ctrl+C to stop the server.
echo ==================================================
echo.

:: ==================================================
:: START SERVER (BLOCKING)
:: ==================================================
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
echo SERVER STOPPED
echo ==================================================
echo.
echo If this was unexpected, possible causes:
echo - Port %PORT% already in use
echo - Insufficient GPU memory
echo - CUDA drivers missing or outdated
echo - Model incompatible
echo.
pause
exit /b
