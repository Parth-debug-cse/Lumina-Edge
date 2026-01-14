@echo off
setlocal enabledelayedexpansion
title LUMINA EDGE  CORE CONTROLLER v1.0
color 0B

 1. Initial Resource Reclamation
echo [SYSTEM] Initiating pre-flight memory purge...
powershell -ExecutionPolicy Bypass -File ..scriptsoptimize_system.ps1

menu
cls
echo ============================================================
echo   LUMINA EDGE LOW-LATENCY INFERENCE FRAMEWORK
echo ============================================================
echo   [PROFILE SELECTION]
echo   1. LIGHTWEIGHT  (Llama-3.2 1B  - Optimized for Speed)
echo   2. BALANCED     (Qwen-2.5 1.5B - Optimized for Logic)
echo   3. ANALYTICAL   (Mistral 7B    - Deep Analysis Mode)
echo   4. RECLAIM      (Manual Resource Reclamation)
echo   5. EXIT
echo ============================================================
echo.
set p choice=Select Hardware-Optimized Profile [1-5] 

if %choice%==1 set model=Llama-3.2-1B-Instruct-Q8_0.gguf & set ctx=4096 & goto launch
if %choice%==2 set model=Qwen2.5-1.5B-Instruct-Q6_K.gguf & set ctx=3072 & goto launch
if %choice%==3 set model=Mistral-7B-v0.3-Q4_K_M.gguf & set ctx=2048 & goto launch
if %choice%==4 goto reclaim
if %choice%==5 exit
goto menu

launch
cls
echo [ENGINE] Initializing llama.cpp backend via Vulkan...
echo [INFO] Target Model %model%
echo [INFO] Allocated Context %ctx% tokens
echo.

..binllama-cli.exe ^
  -m ..models%model% ^
  --vulkan ^
  -c %ctx% ^
  -t 4 ^
  -b 128 ^
  --color ^
  -cnv ^
  --multiline-input ^
  -sys You are Lumina, a high-efficiency AI assistant running on edge hardware. Provide concise, technically accurate responses.

pause
goto menu

reclaim
echo [SYSTEM] Re-executing kernel-level resource reclamation...
powershell -ExecutionPolicy Bypass -File ..scriptsoptimize_system.ps1
echo [SUCCESS] Standby list cleared.
pause
goto menu