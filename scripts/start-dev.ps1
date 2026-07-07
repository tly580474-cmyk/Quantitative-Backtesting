$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$serverRoot = Join-Path $root 'server'
$backendUrl = 'http://127.0.0.1:3001'
$frontendUrl = 'http://127.0.0.1:5558'

function Write-Step([string]$scope, [string]$message) {
    Write-Host "[$scope] $message"
}

function Test-NodeVersion {
    $versionText = (& node -p "process.versions.node").Trim()
    $parts = $versionText.Split('.') | ForEach-Object { [int]$_ }
    $supported = ($parts[0] -eq 20 -and $parts[1] -ge 19) -or
                 ($parts[0] -eq 22 -and $parts[1] -ge 12) -or
                 ($parts[0] -gt 22)
    if (-not $supported) {
        throw "Unsupported Node.js $versionText. Required: Node.js 20.19+ or 22.12+."
    }
    Write-Step 'OK' "Node.js $versionText"
}

function Install-Dependencies([string]$workingDirectory, [string]$label) {
    $lockMarker = Join-Path $workingDirectory 'node_modules\.package-lock.json'
    if (Test-Path -LiteralPath $lockMarker) {
        Write-Step 'OK' "$label dependencies found"
        return
    }

    Write-Step $label 'Installing dependencies...'
    Push-Location $workingDirectory
    try {
        & npm.cmd install
        if ($LASTEXITCODE -ne 0) {
            throw "$label dependency installation failed with exit code $LASTEXITCODE."
        }
    } finally {
        Pop-Location
    }
}

function Test-AkshareDependency {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        Write-Step 'WARN' 'Python was not found in PATH. Market sentiment AKShare source will be unavailable.'
        return
    }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & python -W ignore -c "import warnings; warnings.filterwarnings('ignore'); import akshare" >$null 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Step 'WARN' 'Python package akshare is missing. Run: python -m pip install akshare'
            return
        }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    Write-Step 'OK' 'AKShare dependency found'
}

function Stop-ProjectListener([int]$port, [string]$marker) {
    $connections = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Sort-Object OwningProcess -Unique)
    foreach ($connection in $connections) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)"
        $isProjectNode = $process.Name -eq 'node.exe' -and $process.CommandLine -like "*$marker*"
        if (-not $isProjectNode) {
            throw "Port $port is occupied by another application (PID $($connection.OwningProcess))."
        }
        Write-Step 'INFO' "Stopping old project process on port $port (PID $($process.ProcessId))"
        Stop-Process -Id $process.ProcessId -Force
    }
}

function Wait-Http([string]$url, [int]$timeoutSeconds, [string]$label) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 2
            if ($response.StatusCode -eq 200) {
                Write-Step 'OK' "$label is ready"
                return
            }
        } catch {
            # Service is still starting.
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "$label did not become ready within $timeoutSeconds seconds."
}

function Warm-MarketSentiment {
    Write-Step 'INFO' 'Warming market sentiment overview in background...'
    $warmCommand = "`$ErrorActionPreference = 'SilentlyContinue'; Invoke-WebRequest -UseBasicParsing '$backendUrl/api/market-data/market-sentiment' -TimeoutSec 180 | Out-Null"
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-Command', $warmCommand -WindowStyle Hidden | Out-Null
}

try {
    Write-Host '============================================================'
    Write-Host '  Quant Backtest - Development Launcher'
    Write-Host '============================================================'

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Node.js was not found in PATH.'
    }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'npm was not found in PATH.'
    }
    Test-NodeVersion
    Test-AkshareDependency

    Install-Dependencies $root 'FE'
    Install-Dependencies $serverRoot 'BE'

    if (-not (Test-Path -LiteralPath (Join-Path $serverRoot '.env'))) {
        Write-Step 'WARN' 'server\.env is missing. Copy server\.env.example to enable MySQL and AI.'
    }

    Write-Step 'INFO' 'Checking ports 3001 and 5558...'
    Stop-ProjectListener 3001 'server*src/app.ts'
    Stop-ProjectListener 5558 'node_modules*vite'
    Start-Sleep -Milliseconds 500

    Write-Step 'BE' "Starting watch server at $backendUrl"
    $backendCommand = "title Quant-Backend && cd /d `"$serverRoot`" && npm run dev"
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $backendCommand -WorkingDirectory $serverRoot
    Wait-Http "$backendUrl/api/market-data/research-agent/status" 35 'Backend'
    Warm-MarketSentiment

    Write-Step 'FE' "Starting Vite at $frontendUrl"
    $frontendCommand = "title Quant-Frontend && cd /d `"$root`" && npm run dev -- --host 127.0.0.1 --port 5558 --strictPort"
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $frontendCommand -WorkingDirectory $root
    Wait-Http "$frontendUrl/" 35 'Frontend'

    Write-Step 'INFO' "Opening $frontendUrl"
    Start-Process $frontendUrl
    Write-Step 'DONE' 'Keep the Quant-Backend and Quant-Frontend windows open.'
    exit 0
} catch {
    Write-Host "[ERR] $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '[INFO] Review the message above, then run start.bat again.'
    exit 1
}
