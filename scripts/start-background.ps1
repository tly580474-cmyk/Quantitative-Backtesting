$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $root 'server'
$logRoot = Join-Path $root 'logs'
$backendUrl = 'http://127.0.0.1:3001/api/health'
$frontendUrl = 'http://127.0.0.1:5432/'
$env:VITE_DATA_SOURCE = 'api'
$env:VITE_API_URL = 'http://127.0.0.1:3001'

New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

function Test-HttpReady([string]$url) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Assert-PortAvailable([int]$port, [string]$label) {
    $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $listener) {
        return
    }
    if ($label -eq 'backend' -and (Test-HttpReady $backendUrl)) {
        return
    }
    if ($label -eq 'frontend' -and (Test-HttpReady $frontendUrl)) {
        return
    }
    throw "Port $port is already occupied by another process."
}

function Start-HiddenCommand(
    [string]$workingDirectory,
    [string]$command,
    [string]$logFile
) {
    $logPath = Join-Path $logRoot $logFile
    $wrapped = "cd /d `"$workingDirectory`" && $command >> `"$logPath`" 2>&1"
    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/d', '/c', $wrapped `
        -WorkingDirectory $workingDirectory `
        -WindowStyle Hidden | Out-Null
}

Assert-PortAvailable 3001 'backend'
Assert-PortAvailable 5432 'frontend'

if (-not (Test-HttpReady $backendUrl)) {
    Start-HiddenCommand $serverRoot 'npm.cmd run start' 'backend.log'
}

Push-Location $root
try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend build failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

if (-not (Test-HttpReady $frontendUrl)) {
    Start-HiddenCommand $root 'npm.cmd run preview -- --host 127.0.0.1 --port 5432 --strictPort' 'frontend.log'
}

$deadline = (Get-Date).AddSeconds(60)
do {
    if ((Test-HttpReady $backendUrl) -and (Test-HttpReady $frontendUrl)) {
        exit 0
    }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

throw 'Project services did not become healthy within 60 seconds. Check logs\backend.log and logs\frontend.log.'
