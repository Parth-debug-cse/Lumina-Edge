@echo off
setlocal enabledelayedexpansion
title LUMINA EDGE : CORE CONTROLLER [VULKAN-V7]
color 0B

:: Navigate to project root to handle relative paths
cd /d "%~dp0.."

:: --- BOOT SEQUENCE ---
cls
echo [  OK  ] INITIALIZING LUMINA KERNEL...
timeout /t 1 >nul
echo [  OK  ] MAPPING DIRECTORIES: /bin, /models, /scripts...
timeout /t 1 >nul
echo [  OK  ] VULKAN RPC BACKEND DETECTED...
timeout /t 1 >nul
echo [  OK  ] LOADING MEMORY RECLAMATION PROTOCOLS...
timeout /t 1 >nul
echo.
echo SYSTEM READY.
timeout /t 1 >nul

:menu
cls
echo  ##########################################
echo  #          LUMINA : CORE CONTROL          #
echo  #        [ VULKAN STABLE / 8GB ]          #
echo  ##########################################
echo.
echo  1. [ T-MODE ] - Theoretical and Reasoning
echo  2. [ B-MODE ] - Technical / Code
echo  3. [ R-MODE ] - Data-Link (Read Data from notes.txt)
echo.
echo  4. [ PURGE  ] - RAM / Sector Clean
echo  5. [ EXIT   ] - Return to Terminal
echo.
echo  [SYSTEM] Status: STABLE ^| GPU: Intel UHD 620
echo.
set /p choice="core@lumina:~# "

if "%choice%"=="1" goto tmode
if "%choice%"=="2" goto bmode
if "%choice%"=="3" goto rmode
if "%choice%"=="4" goto purge
if "%choice%"=="5" exit
goto menu

:tmode
cls
".\bin\llama-cli.exe" -m ".\models\mistral-v0.3-7b.Q4_K_M.gguf" -t 4 -c 3072 --vram-budget 2048 --color on -cnv --multiline-input -sys "You are an expert academic tutor."
pause
goto menu

:bmode
cls
".\bin\llama-cli.exe" -m ".\models\qwen-2.5-1.5b.Q6_K.gguf" -t 4 -c 3072 --vram-budget 2048 --color on -cnv --multiline-input -sys "You are a senior software engineer."
pause
goto menu

:rmode
cls
if not exist ".\models\notes.txt" (echo [!] notes.txt missing in /models & pause & goto menu)
echo [!] R-MODE : DATA-LINK ACTIVE
echo [!] LOADING NOTES INTO VULKAN CACHE...
echo [!] READY: Type your question, then \ and hit ENTER.
echo.
".\bin\llama-cli.exe" -m ".\models\llama-3.2-1b.Q8_0.gguf" -t 4 -c 3072 --vram-budget 2048 --color on -cnv -r "User:" --multiline-input -f ".\models\notes.txt" -sys "You are a study assistant. Answer using ONLY the provided notes."
pause
goto menu

:purge
cls
echo [!] INITIALIZING KERNEL RECLAMATION...
powershell -ExecutionPolicy Bypass -File ".\scripts\optimize_system.ps1"
echo [!] READY.
pause
goto menu