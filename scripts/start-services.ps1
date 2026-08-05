# Quant Backtest autostart launcher.
# Starts backend (3001) + frontend (5558) + admin (5559) in hidden windows.
# Frontend/admin use `vite preview` (serves pre-built dist) — no runtime dep
# optimization, so the page is usable the moment HTTP is up. If dist is missing
# or stale, it is (re)built before preview starts.
# Designed to be invoked by the scheduled task registered via register-autostart.ps1.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $root 'server'
$logRoot = Join-Path $root 'logs'
$distDir = Join-Path $root 'dist'
$adminDistDir = Join-Path $root 'admin\dist'
# Rebuild if dist is older than this (hours). 0 = never auto-rebuild (assume fresh).
$staleHours = 0

# Match the dev launcher defaults so frontend talks to the local backend.
$env:VITE_DATA_SOURCE = 'api'
$env:VITE_API_URL = 'http://127.0.0.1:3001'

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

function Write-Step([string]$scope, [string]$msg) {
    Write-Host "[$scope] $msg"
}

function Get-ProjectProcessOnPort([int]$port, [string]$marker) {
    $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Sort-Object OwningProcess -Unique)
    foreach ($c in $connections) {
        try {
            $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
            if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -like "*$marker*") {
                return $p
            }
        } catch {}
    }
    return $null
}

# Returns $true when the port is already in use (by our project OR by a foreign
# process); in both cases we skip launching.
function Test-PortOccupied([int]$port, [string]$marker, [string]$label) {
    $ours = Get-ProjectProcessOnPort $port $marker
    if ($ours) {
        Write-Step 'SKIP' "$label already running on port $port (PID $($ours.ProcessId))."
        return $true
    }
    $foreign = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($foreign) {
        try {
            $fp = Get-CimInstance Win32_Process -Filter "ProcessId=$($foreign.OwningProcess)" -ErrorAction SilentlyContinue
            $name = if ($fp) { $fp.Name } else { 'unknown' }
            Write-Step 'WARN' "Port $port held by foreign process $name (PID $($foreign.OwningProcess)). $label NOT launched."
        } catch {
            Write-Step 'WARN' "Port $port held by PID $($foreign.OwningProcess). $label NOT launched."
        }
        return $true
    }
    return $false
}

function Start-HiddenCommand([string]$workDir, [string]$command, [string]$logFile) {
    $logPath = Join-Path $logRoot $logFile
    if (Test-Path $logPath) { Clear-Content $logPath -ErrorAction SilentlyContinue }
    $wrapped = "cd /d `"$workDir`" && $command >> `"$logPath`" 2>&1"
    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/d', '/c', $wrapped `
        -WorkingDirectory $workDir `
        -WindowStyle Hidden | Out-Null
}

function Test-Http([string]$url) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Wait-Http([string]$url, [int]$timeoutSec, [string]$label) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        if (Test-Http $url) {
            Write-Step 'OK' "$label ready"
            return $true
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Step 'WARN' "$label not ready within ${timeoutSec}s"
    return $false
}

# Returns $true if $dir exists and (when $staleHours > 0) is fresher than the threshold.
function Test-DistReady([string]$dir) {
    if (-not (Test-Path $dir)) { return $false }
    if ($staleHours -le 0) { return $true }
    $index = Join-Path $dir 'index.html'
    if (-not (Test-Path $index)) { return $false }
    return ((Get-Date) - (Get-Item $index).LastWriteTime).TotalHours -lt $staleHours
}

# Build frontend or admin bundle synchronously. Logs go to the corresponding log file.
function Invoke-Build([string]$workDir, [string]$npmScript, [string]$logFile) {
    $logPath = Join-Path $logRoot $logFile
    if (Test-Path $logPath) { Clear-Content $logPath -ErrorAction SilentlyContinue }
    Push-Location $workDir
    try {
        & npm.cmd run $npmScript *>> $logPath
        if ($LASTEXITCODE -ne 0) {
            Write-Step 'BUILD' "$npmScript failed (exit $LASTEXITCODE). See logs\$logFile."
            return $false
        }
        return $true
    } finally {
        Pop-Location
    }
}

# ---------- Backend (3001) ----------
# 通过 backend-supervisor.ps1 启动，启用 /api/admin/restart 快捷重启能力
if (-not (Test-PortOccupied 3001 'server*src/app.ts' 'Backend')) {
    $supervisor = Join-Path $root 'scripts\backend-supervisor.ps1'
    Start-HiddenCommand $serverRoot "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$supervisor`"" 'backend.log'
    Write-Step 'BE' 'Backend launched (supervised, restart-capable via admin console)'
}

# ---------- Frontend (5558) ----------
$frontendStarted = $false
if (-not (Test-PortOccupied 5558 'node_modules*vite' 'Frontend')) {
    if (-not (Test-DistReady $distDir)) {
        Write-Step 'FE' 'dist missing or stale — building frontend bundle...'
        if (Invoke-Build $root 'build' 'frontend.log') {
            Write-Step 'FE' 'Frontend bundle built'
        }
    }
    Start-HiddenCommand $root 'npm.cmd run preview -- --host 127.0.0.1 --port 5558 --strictPort' 'frontend.log'
    Write-Step 'FE' 'Frontend launched (vite preview)'
    $frontendStarted = $true
}

# ---------- Admin (5559) ----------
$adminStarted = $false
if (-not (Test-PortOccupied 5559 'admin*vite.config.ts' 'Admin')) {
    if (-not (Test-DistReady $adminDistDir)) {
        Write-Step 'ADMIN' 'admin/dist missing or stale — building admin bundle...'
        if (Invoke-Build $root 'admin:build' 'admin.log') {
            Write-Step 'ADMIN' 'Admin bundle built'
        }
    }
    Start-HiddenCommand $root 'npm.cmd run admin:preview' 'admin.log'
    Write-Step 'ADMIN' 'Admin console launched (vite preview)'
    $adminStarted = $true
}

# ---------- Wait for HTTP readiness ----------
if ($frontendStarted) { Wait-Http 'http://127.0.0.1:5558/' 30 'Frontend' }
if ($adminStarted)    { Wait-Http 'http://127.0.0.1:5559/' 30 'Admin console' }

Write-Host ''
Write-Step 'DONE' 'Startup complete. Services running in background.'
Write-Host '      Logs: logs\backend.log, logs\frontend.log, logs\admin.log'
Write-Host '      Endpoints:'
Write-Host '        Backend  http://127.0.0.1:3001/api/health'
Write-Host '        Frontend http://127.0.0.1:5558/'
Write-Host '        Admin    http://127.0.0.1:5559/'
Write-Host ''
Write-Host '      NOTE: frontend/admin run in PREVIEW mode (pre-built dist).'
Write-Host '            After code changes, rebuild with:'
Write-Host '              npm run build        (frontend)'
Write-Host '              npm run admin:build  (admin)'
Write-Host '            Then restart services via this script or Start-ScheduledTask.'
