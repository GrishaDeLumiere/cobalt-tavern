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
node server.js