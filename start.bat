@echo off
setlocal
title Quant Backtest Launcher

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dev.ps1"
set "RESULT=%ERRORLEVEL%"

if not "%RESULT%"=="0" (
    echo.
    echo [ERR] Launcher failed with exit code %RESULT%.
    pause
)

exit /b %RESULT%
