@echo off
chcp 65001 > nul
title Cobalt Engine Core
color 0A
echo ===================================================
echo.
echo       [ C O B A L T   C O R E   E N G I N E ]
echo.
echo ===================================================
echo.
echo [SYSTEM] Verifying core modules...
cd core
call npm install --no-save --no-audit --no-fund --loglevel=error --no-progress
echo.
echo [SYSTEM] Initializing core (Aegis Shield: ON)...
start /b "" node server.js
cd ..
echo [SYSTEM] Warming up servers...
timeout /t 2 /nobreak >nul
echo [SYSTEM] Launching terminal in browser...
start http://127.0.0.1:8000/
echo.
echo ===================================================
echo [!] SYSTEM IS ACTIVE AND RUNNING NORMALLY.
echo [!] Do not close this window. (Minimize to tray)
echo ===================================================
pause >nul