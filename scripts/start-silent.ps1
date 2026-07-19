$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $root 'server'
$backendUrl = 'http://127.0.0.1:3001'
$frontendUrl = 'http://127.0.0.1:5558'
$adminUrl = 'http://127.0.0.1:5559'

# Ensure log directory exists
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Stop-ProjectListener([int]$port, [string]$marker) {
    $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Sort-Object OwningProcess -Unique)
    foreach ($connection in $connections) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
        $isProjectNode = $process.Name -eq 'node.exe' -and $process.CommandLine -like "*$marker*"
        if (-not $isProjectNode) {
            throw "Port $port is occupied by another application (PID $($connection.OwningProcess))."
        }
        Stop-Process -Id $process.ProcessId -Force
    }
}

function Wait-Http([string]$url, [int]$timeoutSeconds, [string]$label) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                return
            }
        } catch {}
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "$label did not become ready within $timeoutSeconds seconds."
}

try {
    Stop-ProjectListener 3001 'server*src/app.ts'
    Stop-ProjectListener 5558 'node_modules*vite'
    Stop-ProjectListener 5559 'admin*vite.config.ts'
    Start-Sleep -Milliseconds 500

    # Backend
    $backendLog = Join-Path $logDir 'backend.log'
    $backendSupervisor = Join-Path $root 'scripts\backend-supervisor.ps1'
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $backendSupervisor `
        -WorkingDirectory $serverRoot `
        -WindowStyle Hidden | Out-Null
    Wait-Http "$backendUrl/api/market-data/research-agent/status" 35 'Backend'

    # Frontend
    $frontendLog = Join-Path $logDir 'frontend.log'
    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/c', "cd /d `"$root`" && npm run dev -- --host 127.0.0.1 --port 5558 --strictPort >> `"$frontendLog`" 2>&1" `
        -WorkingDirectory $root `
        -WindowStyle Hidden
    Wait-Http "$frontendUrl/" 35 'Frontend'

    # Independent operations admin console
    $adminLog = Join-Path $logDir 'admin.log'
    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/c', "cd /d `"$root`" && npm run admin:dev >> `"$adminLog`" 2>&1" `
        -WorkingDirectory $root `
        -WindowStyle Hidden
    Wait-Http "$adminUrl/" 35 'Admin console'
} catch {
    exit 1
}
