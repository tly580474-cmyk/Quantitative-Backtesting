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

:: Start backend. Reuse a current server, but replace a stale project server that
:: still owns port 3001 and does not expose the market-data routes.
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing 'http://localhost:3001/api/market-data/research-agent/status' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [BE] Backend already running with current routes
) else (
    powershell -NoProfile -Command "$c = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue; if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess); if ($p.Name -eq 'node.exe' -and $p.CommandLine -like '*server*src/app.ts*') { Stop-Process -Id $c.OwningProcess -Force; Start-Sleep -Milliseconds 500 } }" >nul 2>nul
    echo [BE] Starting backend (localhost:3001)...
    start "Quant-Backend" cmd /c "cd /d server && npx tsx src/app.ts"
)

:: Wait briefly for backend
echo [INFO] Waiting for backend...
ping -n 3 127.0.0.1 >nul

:: Start frontend
echo [FE] Starting frontend (localhost:5173)...
start "" http://localhost:5173
npx vite

pause
