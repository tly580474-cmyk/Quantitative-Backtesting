@echo off
title Quant Backtest

cd /d "%~dp0"

:: Check frontend dependencies
if not exist "node_modules\" (
    echo [FE] Installing dependencies...
    call npm install --legacy-peer-deps
    if %ERRORLEVEL% NEQ 0 (
        echo [ERR] Frontend dependency install failed
        pause
        exit /b 1
    )
)

:: Check backend dependencies
if not exist "server\node_modules\" (
    echo [BE] Installing dependencies...
    cd server
    call npm install --legacy-peer-deps
    cd ..
    if %ERRORLEVEL% NEQ 0 (
        echo [ERR] Backend dependency install failed
        pause
        exit /b 1
    )
)

:: Check backend .env
if not exist "server\.env" (
    echo [WARN] server\.env not found, copy from server\.env.example if MySQL/AI needed
    echo [INFO] App works with browser-only storage without backend config
)

:: Start backend
echo [BE] Starting backend (localhost:3001)...
start "Quant-Backend" cmd /c "cd /d server && npx tsx src/app.ts"

:: Wait briefly for backend
echo [INFO] Waiting for backend...
ping -n 3 127.0.0.1 >nul

:: Start frontend
echo [FE] Starting frontend (localhost:5173)...
start "" http://localhost:5173
npx vite

pause
